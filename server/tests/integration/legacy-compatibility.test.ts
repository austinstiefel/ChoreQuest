import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { newUserData } from "../../src/auth/accounts.js";
import { hashPassword, hashPin } from "../../src/auth/passwords.js";
import { bootstrapInitialAdmin, loadBootstrapConfig } from "../../src/auth/bootstrap.js";
import { createAccessToken } from "../../src/auth/tokens.js";
import { requireDeletionSchema, requireSafeUserIds } from "../../src/db/accountSchema.js";
import { sqliteTimestamp } from "../../src/db/legacySqlite.js";
import { createAuthRouter, createPrismaAuthRepository } from "../../src/routes/auth.js";
import { createAdminRouter, createPrismaAdminRepository } from "../../src/routes/admin.js";
import { disposableDatabase } from "../helpers/sqlite.js";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const python = resolve(root, "../.venv/Scripts/python.exe");
const upgrade = resolve(root, "scripts/prepare-legacy-auth-db.py");
const config = { secretKey: "legacy-review-test-only-secret", accessTokenExpireMinutes: 15,
	refreshTokenExpireDays: 30, cookieSecure: false, corsOrigins: [] };
const password = "PythonFixturePassword42";
const hash = "$2b$12$ErDH5SaN3etIrCH966/o3uvc2baZ7zUjafKNTu8LJgfitNGPlYaOG";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function database(legacy = false) {
	const db = await disposableDatabase(legacy);
	cleanup.push(() => db.dispose());
	return db;
}
function connect(path: string) {
	const prisma = new PrismaClient({ datasources: { db: { url: `file:${path.replaceAll("\\", "/")}?connection_limit=1` } } });
	cleanup.push(() => prisma.$disconnect());
	return prisma;
}
function appFor(prisma: PrismaClient) {
	const auth = createPrismaAuthRepository(prisma);
	return createApp(createAuthRouter({ config, repository: auth }), config,
		createAdminRouter({ config, auth, repository: createPrismaAdminRepository(prisma) }));
}
function seed(prisma: PrismaClient, username: string, role = "kid") {
	return prisma.users.create({ data: newUserData({ username, displayName: username, passwordHash: hash, role }) });
}
async function row(prisma: PrismaClient, table: string, overrides: Record<string, string | number | null>) {
	const columns = await prisma.$queryRaw<Array<{ name: string; type: string; notnull: bigint; pk: bigint }>>(Prisma.sql`PRAGMA table_info(${Prisma.raw(table)})`);
	const values: Record<string, string | number | null> = {};
	for (const c of columns) if (!c.pk && c.notnull) values[c.name] = /INT|REAL|BOOL|FLOAT/i.test(c.type) ? 0 : /DATE/i.test(c.type) ? "2030-01-01 00:00:00.000000" : /json/i.test(c.type) ? "[]" : `fixture-${c.name}`;
	Object.assign(values, overrides);
	await prisma.$executeRaw(Prisma.sql`INSERT INTO ${Prisma.raw(table)} (${Prisma.join(Object.keys(values).map(Prisma.raw))}) VALUES (${Prisma.join(Object.values(values))})`);
	const [inserted] = await prisma.$queryRaw<Array<{ id: bigint }>>`SELECT last_insert_rowid() AS id`;
	return Number(inserted.id);
}
async function prepare(db: Awaited<ReturnType<typeof database>>, name = "upgraded.db") {
	await db.prisma.$disconnect();
	const output = resolve(db.directory, name);
	const sourceBefore = await readFile(db.databasePath);
	await execute(python, ["-B", upgrade, "--source", db.databasePath, "--output", output]);
	expect(await readFile(db.databasePath)).toEqual(sourceBefore);
	return { prisma: connect(output), output };
}

it("rejects unsafe legacy creation/deletion before changing rows, with an actionable error", async () => {
	const db = await database(true);
	const admin = await seed(db.prisma, "Admin", "admin");
	const victim = await seed(db.prisma, "Victim");
	const key = await row(db.prisma, "api_keys", { created_by: victim.id });
	await expect(requireSafeUserIds(db.prisma)).rejects.toThrow("Account schema upgrade required");
	const app = appFor(db.prisma);
	const authorization = `Bearer ${await createAccessToken(admin.id, "admin", config)}`;
	const rejected = await request(app).delete(`/api/admin/users/${victim.id}`).set("Authorization", authorization).expect(503);
	expect(rejected.body.detail).toContain("server/prisma/README.md");
	await request(app).post("/api/admin/users").set("Authorization", authorization)
		.send({ username: "Replacement", display_name: "Replacement", password }).expect(503);
	expect(await db.prisma.users.count()).toBe(2);
	expect(await db.prisma.api_keys.findUnique({ where: { id: key }, select: { created_by: true } })).toEqual({ created_by: victim.id });
});

it("checks creator nullability even when IDs are already safe", async () => {
	const db = await database();
	await db.prisma.$executeRawUnsafe(`DROP TABLE announcements`);
	await db.prisma.$executeRawUnsafe(`CREATE TABLE announcements (id INTEGER PRIMARY KEY, title TEXT, message TEXT, icon TEXT, is_pinned BOOLEAN, created_by INTEGER NOT NULL REFERENCES users(id), created_at DATETIME)`);
	const admin = await seed(db.prisma, "Admin", "admin");
	const victim = await seed(db.prisma, "Victim");
	const note = await row(db.prisma, "notifications", { user_id: victim.id });
	await expect(createPrismaAdminRepository(db.prisma).deleteUser(victim.id, admin.id)).rejects.toThrow("schema upgrade required");
	expect(await db.prisma.notifications.count({ where: { id: note } })).toBe(1);
	expect(await db.prisma.users.count()).toBe(2);
});

it("upgrades actual legacy definitions without FK disabling, preserves parent/child data and schema objects, then safely deletes", async () => {
	const db = await database(true);
	const admin = await seed(db.prisma, "Admin", "admin");
	const victim = await seed(db.prisma, "Victim");
	const category = await row(db.prisma, "chore_categories", {});
	const chore = await row(db.prisma, "chores", { created_by: victim.id, category_id: category });
	const reward = await row(db.prisma, "rewards", { created_by: victim.id });
	await row(db.prisma, "chore_assignments", { chore_id: chore, user_id: admin.id, verified_by: victim.id });
	await row(db.prisma, "chore_exclusions", { chore_id: chore, user_id: admin.id });
	await row(db.prisma, "chore_assignment_rules", { chore_id: chore, user_id: admin.id });
	await row(db.prisma, "chore_rotations", { chore_id: chore, kid_ids: JSON.stringify([victim.id, admin.id]) });
	await row(db.prisma, "reward_redemptions", { reward_id: reward, user_id: admin.id, approved_by: victim.id, fulfilled_by: victim.id });
	await row(db.prisma, "wishlist_items", { user_id: admin.id, converted_to_reward_id: reward });
	for (const table of ["seasonal_events", "api_keys", "invite_codes", "announcements", "vacation_periods"]) await row(db.prisma, table, { created_by: victim.id });
	await row(db.prisma, "shoutouts", { from_user_id: victim.id, to_user_id: admin.id });
	await db.prisma.$executeRawUnsafe("CREATE INDEX fixture_creator_index ON api_keys(created_by)");
	await db.prisma.$executeRawUnsafe("CREATE VIEW fixture_accounts AS SELECT id, username FROM users");
	await db.prisma.$executeRawUnsafe("CREATE TRIGGER fixture_reject_title BEFORE UPDATE ON announcements WHEN NEW.title = 'reject' BEGIN SELECT RAISE(ABORT, 'fixture title constraint'); END");
	const { prisma, output } = await prepare(db);
	await requireDeletionSchema(prisma);
	expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
	for (const table of ["chores", "rewards", "chore_assignments", "chore_exclusions", "chore_assignment_rules", "chore_rotations", "reward_redemptions", "wishlist_items", "shoutouts"]) {
		const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`SELECT COUNT(*) AS count FROM ${Prisma.raw(table)}`);
		expect(rows[0].count).toBe(1n);
	}
	expect(await prisma.$queryRaw`SELECT name FROM sqlite_master WHERE name IN ('fixture_creator_index', 'fixture_accounts', 'fixture_reject_title')`).toHaveLength(3);
	expect(await prisma.$queryRaw`SELECT DISTINCT typeof(created_at) AS storage FROM users`).toEqual([{ storage: "text" }]);
	await expect(prisma.$executeRaw`UPDATE announcements SET title = 'reject'`).rejects.toThrow();
	await prisma.$executeRawUnsafe("CREATE TRIGGER fail_account_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'fixture deletion rollback'); END");
	await expect(createPrismaAdminRepository(prisma).deleteUser(victim.id, admin.id)).rejects.toThrow();
	expect(await prisma.users.count()).toBe(2);
	expect(await prisma.$queryRaw`SELECT created_by FROM chores`).toEqual([{ created_by: victim.id }]);
	await prisma.$executeRawUnsafe("DROP TRIGGER fail_account_delete");
	await createPrismaAdminRepository(prisma).deleteUser(victim.id, admin.id);
	for (const table of ["chores", "rewards", "seasonal_events", "api_keys", "invite_codes", "announcements", "vacation_periods"]) {
		expect(await prisma.$queryRaw(Prisma.sql`SELECT created_by FROM ${Prisma.raw(table)}`)).toEqual([{ created_by: null }]);
	}
	expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
	await prisma.$disconnect();
	// A second preparation is logically idempotent and keeps sequence history.
	const second = resolve(db.directory, "second.db");
	await execute(python, ["-B", upgrade, "--source", output, "--output", second]);
	await requireDeletionSchema(connect(second));
	await expect(execute(python, ["-B", upgrade, "--source", output, "--output", second])).rejects.toThrow();
});

it.each([false, true])("never reuses a deleted highest ID or accepts its JWT as a new admin after reconnect (legacy=%s)", async (legacy) => {
	const db = await database(legacy);
	await seed(db.prisma, "Admin", "admin");
	await seed(db.prisma, "DeletedHighest");
	const { prisma, output } = await prepare(db);
	const auth = createPrismaAuthRepository(prisma);
	const deleted = (await auth.findUserByUsername("DeletedHighest"))!;
	const token = await createAccessToken(deleted.id, "kid", config);
	await createPrismaAdminRepository(prisma).deleteUser(deleted.id, 1);
	await prisma.$disconnect();
	const otherConnection = connect(output);
	const replacement = await createPrismaAdminRepository(otherConnection).createUser({ username: "ReplacementAdmin", displayName: "New Admin", passwordHash: hash, role: "admin" });
	expect(replacement.id).toBeGreaterThan(deleted.id);
	await request(appFor(otherConnection)).get("/api/admin/users").set("Authorization", `Bearer ${token}`).expect(401);
	await request(appFor(otherConnection)).get("/api/auth/me").set("Authorization", `Bearer ${token}`).expect(401);
	// An unmodified Python/SQLite-style INSERT must also honor the durable sequence.
	await createPrismaAdminRepository(otherConnection).deleteUser(replacement.id, 1);
	const next = await seed(otherConnection, "PythonStyleInsert", "admin");
	expect(next.id).toBeGreaterThan(replacement.id);
});

it("rolls back/cleans a failed upgrade without touching its source", async () => {
	const db = await database(true);
	await seed(db.prisma, "Admin", "admin");
	// Unsupported column-level PK modifier: the tool must fail closed, not guess.
	await db.prisma.$executeRawUnsafe("CREATE TABLE unsupported (id INTEGER PRIMARY KEY CHECK(id > 0)) WITHOUT ROWID");
	await db.prisma.$disconnect();
	const before = await readFile(db.databasePath);
	const output = resolve(db.directory, "failed.db");
	await expect(execute(python, ["-B", upgrade, "--source", db.databasePath, "--output", output])).rejects.toThrow();
	expect(await readFile(db.databasePath)).toEqual(before);
	await expect(readFile(output)).rejects.toThrow();
});

it("preserves the sequence high-water mark even when all original users have been deleted", async () => {
	const db = await database();
	const deleted = await seed(db.prisma, "DeletedAdmin", "admin");
	await db.prisma.users.delete({ where: { id: deleted.id } }); // Fixture an empty prior installation.
	const { prisma } = await prepare(db);
	await bootstrapInitialAdmin(prisma, loadBootstrapConfig({}));
	const replacement = (await createPrismaAuthRepository(prisma).findFirstActiveAdmin())!;
	expect(replacement.id).toBeGreaterThan(deleted.id);
});

it("serializes final-admin demotion and deletion across independent connections", async () => {
	const db = await database();
	const first = await seed(db.prisma, "FirstAdmin", "admin");
	const second = await seed(db.prisma, "SecondAdmin", "admin");
	const other = connect(db.databasePath);
	const results = await Promise.allSettled([
		createPrismaAdminRepository(db.prisma).updateUser(first.id, { role: "kid" }),
		createPrismaAdminRepository(other).deleteUser(second.id, first.id),
	]);
	expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
	const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
	expect(rejected.reason.message).toMatch(/only administrator|final administrator/);
	expect(await db.prisma.users.count({ where: { role: "admin" } })).toBe(1);
});

it("serializes admin creation/deletion, refresh replay and stale password changes across independent connections", async () => {
	const db = await database();
	const admin = await seed(db.prisma, "Admin", "admin");
	const victim = await seed(db.prisma, "Highest");
	const other = connect(db.databasePath);
	const oldToken = await createAccessToken(victim.id, "kid", config);
	const [, replacement] = await Promise.all([
		createPrismaAdminRepository(db.prisma).deleteUser(victim.id, admin.id),
		createPrismaAdminRepository(other).createUser({ username: "NewAdmin", displayName: "New Admin", passwordHash: hash, role: "admin" }),
	]);
	expect(replacement.id).toBeGreaterThan(victim.id);
	await request(appFor(other)).get("/api/admin/users").set("Authorization", `Bearer ${oldToken}`).expect(401);
	const login = await request(appFor(db.prisma)).post("/api/auth/login").send({ username: "Admin", password }).expect(200);
	const cookie = login.headers["set-cookie"][0].split(";")[0];
	const rotations = await Promise.all([db.prisma, other].map((prisma) => request(appFor(prisma)).post("/api/auth/refresh").set("Cookie", cookie)));
	expect(rotations.map((response) => response.status).sort()).toEqual([200, 401]);
	const changes = await Promise.all([db.prisma, other].map((prisma, index) => request(appFor(prisma)).post("/api/auth/change-password")
		.set("Authorization", `Bearer ${login.body.access_token}`).send({ current_password: password, new_password: `NewPassword${index}` })));
	expect(changes.map((response) => response.status).sort()).toEqual([200, 400]);
	expect(await db.prisma.refresh_tokens.count({ where: { user_id: admin.id, is_revoked: false } })).toBe(0);
});

it("bootstraps once across independent Node processes and preserves credentials on restart", async () => {
	const db = await database();
	await db.prisma.$disconnect();
	const url = `file:${db.databasePath.replaceAll("\\", "/")}?connection_limit=1`;
	const worker = resolve(root, "tests/helpers/bootstrap-worker.ts");
	const runs = await Promise.all([1, 2].map(() => execute(process.execPath, ["--import", "tsx", worker, url], { cwd: root })));
	expect(runs.map((run) => run.stdout.trim()).sort()).toEqual(["false", "true"]);
	const prisma = connect(db.databasePath);
	const original = (await createPrismaAuthRepository(prisma).findFirstActiveAdmin())!;
	expect(await bootstrapInitialAdmin(prisma, loadBootstrapConfig({ INITIAL_ADMIN_PASSWORD: "ChangedPassword" }))).toBe(false);
	expect((await createPrismaAuthRepository(prisma).findFirstActiveAdmin())?.password_hash).toBe(original.password_hash);
	expect(await prisma.users.count()).toBe(1);
}, 20000);

it.each(["password", "reset", "pin", "disable", "delete"])("rejects a paused login after a concurrent %s operation, without issuing a new session", async (operation) => {
	const db = await database();
	const admin = await seed(db.prisma, "Admin", "admin");
	const user = await seed(db.prisma, "Child");
	const auth = createPrismaAuthRepository(db.prisma);
	if (operation === "pin") await auth.setPin({ userId: user.id, pinHash: await hashPin("123456") });
	let reached!: () => void;
	let release!: () => void;
	const paused = new Promise<void>((resolve) => { reached = resolve; });
	const resume = new Promise<void>((resolve) => { release = resolve; });
	const heldAuth = { ...auth,
		async recordPasswordLogin(input: Parameters<typeof auth.recordPasswordLogin>[0]) {
			await auth.recordPasswordLogin(input); reached(); await resume;
		},
		async recordPinLogin(input: Parameters<typeof auth.recordPinLogin>[0]) {
			await auth.recordPinLogin(input); reached(); await resume;
		},
	};
	const app = createApp(createAuthRouter({ config, repository: heldAuth }), config);
	const pending = request(app).post(operation === "pin" ? "/api/auth/pin-login" : "/api/auth/login")
		.send(operation === "pin" ? { username: "Child", pin: "123456" } : { username: "Child", password }).then((response) => response);
	await paused;
	const other = connect(db.databasePath);
	try {
		if (operation === "password") {
			expect(await createPrismaAuthRepository(other).changePassword({ userId: user.id, expectedPasswordHash: hash,
				passwordHash: await hashPassword("ReplacementPassword42"), ipAddress: null })).toBe(true);
		} else if (operation === "reset") {
			await createPrismaAdminRepository(other).resetPassword(user.id, await hashPassword("ReplacementPassword42"));
		} else if (operation === "pin") {
			await createPrismaAuthRepository(other).setPin({ userId: user.id, pinHash: await hashPin("654321") });
		} else if (operation === "disable") {
			await createPrismaAdminRepository(other).updateUser(user.id, { isActive: false });
		} else {
			await createPrismaAdminRepository(other).deleteUser(user.id, admin.id);
		}
	} finally { release(); }
	const response = await pending;
	expect(response.status).toBe(401);
	expect(response.body.detail).toBe(operation === "pin" ? "Invalid username or PIN" : "Invalid username or password");
	expect(response.headers["set-cookie"]).toBeUndefined();
	expect(await other.refresh_tokens.count({ where: { user_id: user.id } })).toBe(0);
});

it("writes Python-readable UTC timestamps across the account/credential lifecycle and reads mixed history", async () => {
	const db = await database();
	await bootstrapInitialAdmin(db.prisma, loadBootstrapConfig({}));
	const app = appFor(db.prisma);
	const setup = await request(app).post("/api/auth/setup-password").send({ password, confirm_password: password }).expect(200);
	const authorization = `Bearer ${setup.body.access_token}`;
	const user = await request(app).post("/api/admin/users").set("Authorization", authorization)
		.send({ username: "Child", display_name: "Child", password }).expect(200);
	await request(app).put(`/api/admin/users/${user.body.id}`).set("Authorization", authorization).send({ role: "parent" }).expect(200);
	await request(app).post(`/api/admin/users/${user.body.id}/reset-password`).set("Authorization", authorization).send({ new_password: password }).expect(200);
	await request(app).put("/api/auth/me").set("Authorization", authorization).send({ display_name: "Owner" }).expect(200);
	await request(app).post("/api/auth/set-pin").set("Authorization", authorization).send({ pin: "123456" }).expect(200);
	await request(app).post("/api/auth/pin-login").send({ username: "Admin", pin: "123456" }).expect(200);
	const login = await request(app).post("/api/auth/login").send({ username: "Admin", password }).expect(200);
	await request(app).post("/api/auth/refresh").set("Cookie", login.headers["set-cookie"][0].split(";")[0]).expect(200);
	await request(app).post("/api/auth/change-password").set("Authorization", authorization)
		.send({ current_password: password, new_password: "NewPassword42" }).expect(200);
	await request(app).post("/api/admin/api-keys").set("Authorization", authorization).send({ name: "Test" }).expect(200);
	await request(app).post("/api/admin/invite-codes").set("Authorization", authorization)
		.send({ role: "kid", expires_at: "2035-01-02T03:04:05+02:00" }).expect(200);
	for (const expires_at of ["0000-01-01", 253402300800000, "9999-12-31T23:59:59-23:00"]) {
		await request(app).post("/api/admin/invite-codes").set("Authorization", authorization).send({ role: "kid", expires_at }).expect(422);
	}
	expect(sqliteTimestamp(new Date("2035-01-02T03:04:05+02:00"))).toBe("2035-01-02 01:04:05.000000");
	await db.prisma.$disconnect();
	// Actual SQLAlchemy DateTime conversion, with the repository's existing venv.
	const pythonCheck = `import sqlite3, sys\nfrom sqlalchemy import create_engine, MetaData, Table, Column, DateTime, select\np=sys.argv[1]\nc=sqlite3.connect(p)\nchecks={'users':['created_at','updated_at'],'app_settings':['updated_at'],'refresh_tokens':['created_at','expires_at'],'api_keys':['created_at','last_used_at'],'invite_codes':['created_at','expires_at'],'audit_logs':['created_at']}\ne=create_engine('sqlite:///'+p.replace('\\\\','/'))\nfor name, columns in checks.items():\n t=Table(name,MetaData(),*[Column(col,DateTime) for col in columns])\n with e.connect() as db:\n  rows=db.execute(select(t)).all()\n  assert rows, name\n for col in columns:\n  for (value,) in c.execute('SELECT '+col+' FROM '+name):\n   assert value is None or isinstance(value,str), (name,col)\nprint('SQLAlchemy UTC timestamp reads passed')\n`;
	const result = await execute(python, ["-B", "-c", pythonCheck, db.databasePath]);
	expect(result.stdout).toContain("SQLAlchemy UTC timestamp reads passed");
	const prisma = connect(db.databasePath);
	// Preserve read support for older Prisma milliseconds and Python microseconds.
	await prisma.$executeRaw`INSERT INTO audit_logs (user_id, action, details, ip_address, created_at)
    VALUES (1, 'old_prisma', '{}', NULL, ${new Date("1999-01-01")})`;
	await prisma.$executeRaw`INSERT INTO audit_logs (user_id, action, details, ip_address, created_at)
    VALUES (1, 'old_python', '{}', NULL, '2000-01-01 00:00:00.123456')`;
	const logs = await createPrismaAdminRepository(prisma).auditLog({ limit: 100, offset: 0 });
	expect(logs.slice(-2).map((log) => log.action)).toEqual(["old_python", "old_prisma"]);
	expect(logs.at(-2)?.created_at.toISOString()).toBe("2000-01-01T00:00:00.123Z");
}, 20000);
