import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { newUserData } from "../../src/auth/accounts.js";
import { bootstrapInitialAdmin, loadBootstrapConfig } from "../../src/auth/bootstrap.js";
import { requireDeletionSchema } from "../../src/db/accountSchema.js";
import { requireSqliteFile, sqliteFilePath } from "../../src/db/sqliteFile.js";
import { createAuthRouter, createPrismaAuthRepository } from "../../src/routes/auth.js";
import { disposableDatabase } from "../helpers/sqlite.js";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const python = resolve(root, "../.venv/Scripts/python.exe");
const cli = resolve(dirname(createRequire(import.meta.url).resolve("prisma/package.json")), "build/index.js");
const dispose: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (dispose.length) await dispose.pop()!(); });
async function fixture(legacy = false) {
	const db = await disposableDatabase(legacy);
	dispose.push(() => db.dispose());
	return db;
}
function connect(path: string) {
	const client = new PrismaClient({ datasources: { db: { url: url(path) } } });
	dispose.push(() => client.$disconnect());
	return client;
}
const url = (path: string) => `file:${path.replaceAll("\\", "/")}`;
async function schemaCopy(directory: string) {
	const folder = resolve(directory, "prisma");
	await mkdir(folder);
	await cp(resolve(root, "prisma/schema.prisma"), resolve(folder, "schema.prisma"));
	await cp(resolve(root, "prisma/migrations"), resolve(folder, "migrations"), { recursive: true });
	return resolve(folder, "schema.prisma");
}
async function prismaCommand(directory: string, path: string, schema: string, args: string[]) {
	return execute(process.execPath, [cli, ...args, "--schema", schema], {
		cwd: directory, env: { ...process.env, DATABASE_URL: url(path) }, windowsHide: true,
	});
}
async function audit(source: string) {
	const result = await execute(python, ["-B", resolve(root, "scripts/verify-legacy-preparation.py"), "--source", source]);
	const report = JSON.parse(result.stdout);
	const path = resolve(report.workspace);
	expect(dirname(path).toLowerCase()).toBe(resolve(tmpdir()).toLowerCase());
	expect(basename(path)).toMatch(/^chorequest-legacy-dry-run-/);
	dispose.push(() => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
	return { ...report, manifest: JSON.parse(await readFile(resolve(path, "report.json"), "utf8")) };
}

it("initializes only a new absolute SQLite file and refuses overwrites, relative paths and missing parents", async () => {
	const db = await fixture();
	const empty = resolve(db.directory, "fresh.db");
	const script = resolve(root, "scripts/initialize-sqlite.mjs");
	await execute(process.execPath, [script, empty]);
	expect((await stat(empty)).size).toBe(0);
	for (const invalid of [empty, "relative.db", resolve(db.directory, "missing-parent/fresh.db")]) {
		await expect(execute(process.execPath, [script, invalid], { cwd: db.directory })).rejects.toThrow();
	}
	expect((await stat(empty)).size).toBe(0);
});

it("validates provisioned paths without creating files or exposing URL contents", async () => {
	const db = await fixture();
	expect(requireSqliteFile(url(db.databasePath))).toBe(db.databasePath);
	expect(sqliteFilePath("file:../../data/example.db?connection_limit=1")).toBe(resolve(root, "../data/example.db"));
	const missing = resolve(db.directory, "missing.db");
	for (const bad of [undefined, url(missing), "https://test-only-private-url.invalid", "file::memory:"]) {
		expect(() => requireSqliteFile(bad)).toThrow("SQLite database is missing, invalid or uninitialized");
	}
	await expect(stat(missing)).rejects.toThrow();
	const plain = resolve(db.directory, "not-sqlite.db");
	await writeFile(plain, "test-only-file-not-a-database");
	expect(() => requireSqliteFile(url(plain))).toThrow("SQLite database is missing");
});

it("applies fresh migrations idempotently and bootstraps first-run authentication", async () => {
	const db = await fixture();
	const fresh = resolve(db.directory, "fresh.db");
	const schema = await schemaCopy(db.directory);
	await execute(process.execPath, [resolve(root, "scripts/initialize-sqlite.mjs"), fresh]);
	await prismaCommand(db.directory, fresh, schema, ["migrate", "deploy"]);
	await prismaCommand(db.directory, fresh, schema, ["migrate", "deploy"]);
	const client = connect(fresh);
	await requireDeletionSchema(client);
	expect(await client.$queryRaw`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations'`).toHaveLength(28);
	expect(await client.$queryRaw`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL`).toEqual([{ migration_name: "00000000000000_baseline" }]);
	expect(await bootstrapInitialAdmin(client, loadBootstrapConfig({}))).toBe(true);
	const config = { secretKey: "fresh-test-fixture-secret-only", accessTokenExpireMinutes: 15, refreshTokenExpireDays: 30, cookieSecure: false, corsOrigins: [] };
	const app = createApp(createAuthRouter({ config, repository: createPrismaAuthRepository(client) }), config);
	await request(app).get("/api/auth/setup-status").expect(200, { setup_required: true, admin_username: "Admin", password_setup_required: true });
	await request(app).post("/api/auth/setup-password").send({ password: "FreshFixturePassword", confirm_password: "FreshFixturePassword" }).expect(200);
	expect(await client.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
}, 30000);

it("canonicalizes legacy schema before baselining and deploys without replaying table creation", async () => {
	const db = await fixture(true);
	await db.prisma.users.create({ data: newUserData({ username: "FixtureAdmin", displayName: "Fixture", passwordHash: "unusable-test-only", role: "admin" }) });
	await db.prisma.$disconnect();
	const result = await audit(db.databasePath);
	expect(result.verification.all_rows_verified).toBe(true);
	expect(result.verification.unique_constraints_preserved).toBe(true);
	expect(result.verification.named_schema_objects_preserved).toBe(true);
	const path = result.manifest.files.baseline as string;
	const schema = await schemaCopy(result.workspace);
	await execute(process.execPath, [cli, "migrate", "diff", "--from-url", url(path), "--to-schema-datamodel", schema, "--exit-code"], { cwd: result.workspace });
	await prismaCommand(result.workspace, path, schema, ["migrate", "resolve", "--applied", "00000000000000_baseline"]);
	await prismaCommand(result.workspace, path, schema, ["migrate", "status"]);
	await prismaCommand(result.workspace, path, schema, ["migrate", "deploy"]);
	const client = connect(path);
	expect(await client.users.count()).toBe(1);
	const checksum = createHash("sha256").update(await readFile(resolve(root, "prisma/migrations/00000000000000_baseline/migration.sql"))).digest("hex");
	expect(await client.$queryRaw`SELECT checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL`).toEqual([{ checksum }]);
	await requireDeletionSchema(client);
	expect(await client.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
}, 30000);

it("snapshots committed WAL data without changing the source main file or WAL", async () => {
	const db = await fixture(true);
	await db.prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL");
	await db.prisma.$queryRawUnsafe("PRAGMA wal_autocheckpoint=0");
	await db.prisma.users.create({ data: newUserData({ username: "WALFixture", displayName: "Fixture", passwordHash: "unusable-test-only", role: "admin" }) });
	expect((await stat(`${db.databasePath}-wal`)).size).toBeGreaterThan(0);
	const result = await audit(db.databasePath);
	expect(result.verification.row_counts.users).toBe(1);
	expect(result.source_preservation.main_and_wal_unchanged).toBe(true);
	const client = connect(result.manifest.files.prepared);
	expect(await client.users.count()).toBe(1);
});

it("refuses custom table constraints instead of silently dropping them during alignment", async () => {
	const db = await fixture(true);
	await db.prisma.$executeRawUnsafe("ALTER TABLE users ADD COLUMN fixture INTEGER CHECK(fixture >= 0)");
	await db.prisma.$disconnect();
	const before = await readFile(db.databasePath);
	const output = resolve(db.directory, "must-not-remain.db");
	await expect(execute(python, ["-B", resolve(root, "scripts/prepare-legacy-auth-db.py"), "--source", db.databasePath, "--output", output])).rejects.toThrow();
	expect(await readFile(db.databasePath)).toEqual(before);
	await expect(stat(output)).rejects.toThrow();
});

it("does not mistake partial uniqueness for a required full-table unique constraint", async () => {
	const db = await fixture();
	await db.prisma.$executeRawUnsafe("DROP INDEX users_username_key");
	await db.prisma.$executeRawUnsafe("CREATE UNIQUE INDEX fixture_partial_username ON users(username) WHERE is_active=1");
	await db.prisma.$disconnect();
	const output = resolve(db.directory, "unsupported.db");
	await expect(execute(python, ["-B", resolve(root, "scripts/prepare-legacy-auth-db.py"), "--source", db.databasePath, "--output", output])).rejects.toThrow();
	await expect(stat(output)).rejects.toThrow();
});

it("fails startup on an invalid database path without implicitly creating a database or logging secrets", async () => {
	const db = await fixture();
	const missing = resolve(db.directory, "wrong-location.db");
	const secret = "startup-error-test-secret-only";
	let stderr = "";
	try {
		await execute(process.execPath, ["--import", "tsx", resolve(root, "src/server.ts")], { cwd: root,
			env: { ...process.env, DATABASE_URL: url(missing), SECRET_KEY: secret, DOTENV_CONFIG_PATH: resolve(db.directory, "absent.env") } });
		throw new Error("Startup unexpectedly succeeded");
	} catch (error) { stderr = (error as { stderr: string }).stderr; }
	expect(stderr).toContain("SQLite database is missing, invalid or uninitialized");
	expect(stderr).not.toContain(secret);
	await expect(stat(missing)).rejects.toThrow();
});
