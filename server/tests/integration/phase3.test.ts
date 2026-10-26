import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { bootstrapInitialAdmin, loadBootstrapConfig } from "../../src/auth/bootstrap.js";
import { newUserData } from "../../src/auth/accounts.js";
import { verifyPassword } from "../../src/auth/passwords.js";
import { createAccessToken, createRefreshToken } from "../../src/auth/tokens.js";
import type { AuthConfig } from "../../src/config/auth.js";
import { createPrismaAuthRepository, createAuthRouter } from "../../src/routes/auth.js";
import { createAdminRouter, createPrismaAdminRepository } from "../../src/routes/admin.js";
import { disposableDatabase } from "../helpers/sqlite.js";

const config: AuthConfig = { secretKey: "phase3-integration-fixture-secret", accessTokenExpireMinutes: 15,
	refreshTokenExpireDays: 30, cookieSecure: false, corsOrigins: ["https://frontend.example.test"] };
const PASSWORD = "PythonFixturePassword42";
const HASH = "$2b$12$ErDH5SaN3etIrCH966/o3uvc2baZ7zUjafKNTu8LJgfitNGPlYaOG";
function appFor(prisma: PrismaClient, secure = false) {
	const auth = createPrismaAuthRepository(prisma);
	const settings = { ...config, cookieSecure: secure };
	return createApp(createAuthRouter({ config: settings, repository: auth }), settings,
		createAdminRouter({ config: settings, auth, repository: createPrismaAdminRepository(prisma) }));
}
function cookie(response: { headers: Record<string, unknown> }): string {
	const values = response.headers["set-cookie"] as string[];
	const result = values?.find((value) => value.startsWith("refresh_token="));
	if (result === undefined) throw new Error("Expected refresh cookie");
	return result.split(";")[0];
}

describe("Phase 3 bootstrap on disposable SQLite", () => {
	let db: Awaited<ReturnType<typeof disposableDatabase>>;
	beforeEach(async () => { db = await disposableDatabase(); });
	afterEach(async () => { await db.dispose(); });

	it("bootstraps Admin/Administrator with an unknown password and exposes first-run setup", async () => {
		expect(await bootstrapInitialAdmin(db.prisma, loadBootstrapConfig({}))).toBe(true);
		const admin = (await createPrismaAuthRepository(db.prisma).findFirstActiveAdmin())!;
		expect(admin).toMatchObject({ username: "Admin", display_name: "Administrator", role: "admin", is_active: true,
			points_balance: 0, streak_freezes_used: 0, pin_hash: null });
		await expect(verifyPassword("", admin.password_hash)).resolves.toBe(false);
		expect(await createPrismaAuthRepository(db.prisma).findFirstActiveAdmin()).toMatchObject({ id: admin.id });
		await request(appFor(db.prisma)).get("/api/auth/setup-status").expect(200, {
			setup_required: true, admin_username: "Admin", password_setup_required: true,
		});
	});

	it("supports configured credentials and preserves every credential and setting on restart", async () => {
		const settings = loadBootstrapConfig({ INITIAL_ADMIN_USERNAME: " Owner ", INITIAL_ADMIN_DISPLAY_NAME: " Family Owner ", INITIAL_ADMIN_PASSWORD: PASSWORD });
		await bootstrapInitialAdmin(db.prisma, settings);
		const admin = (await createPrismaAuthRepository(db.prisma).findFirstActiveAdmin())!;
		expect(admin).toMatchObject({ username: "Owner", display_name: "Family Owner", role: "admin" });
		const app = appFor(db.prisma);
		await request(app).get("/api/auth/setup-status").expect(200, {
			setup_required: true, admin_username: "Owner", password_setup_required: false,
		});
		await request(app).post("/api/auth/login").send({ username: "Owner", password: PASSWORD }).expect(200);
		expect(await bootstrapInitialAdmin(db.prisma, { ...settings, password: "DifferentPassword" })).toBe(false);
		expect((await createPrismaAuthRepository(db.prisma).findFirstActiveAdmin())?.password_hash).toBe(admin.password_hash);
		expect(await db.prisma.users.count()).toBe(1);
		expect(await createPrismaAuthRepository(db.prisma).findSetting("initial_setup_complete")).toBe("true");
	});

	it("does not bootstrap an existing database containing only a non-admin user", async () => {
		await db.prisma.users.create({ data: newUserData({ username: "kid", displayName: "Kid", passwordHash: HASH, role: "kid" }) });
		expect(await bootstrapInitialAdmin(db.prisma, loadBootstrapConfig({}))).toBe(false);
		expect(await db.prisma.app_settings.count()).toBe(0);
		expect(await db.prisma.users.count()).toBe(1);
	});

	it("serializes concurrent bootstrap attempts and rolls back incomplete initialization", async () => {
		await db.prisma.$executeRawUnsafe(`CREATE TRIGGER fail_bootstrap BEFORE INSERT ON app_settings
      BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
		await expect(bootstrapInitialAdmin(db.prisma, loadBootstrapConfig({}))).rejects.toThrow();
		expect(await db.prisma.users.count()).toBe(0);
		expect(await db.prisma.app_settings.count()).toBe(0);
		await db.prisma.$executeRawUnsafe("DROP TRIGGER fail_bootstrap");
		const results = await Promise.all([
			bootstrapInitialAdmin(db.prisma, loadBootstrapConfig({})), bootstrapInitialAdmin(db.prisma, loadBootstrapConfig({})),
		]);
		expect(results.sort()).toEqual([false, true]);
		expect(await db.prisma.users.count()).toBe(1);
	});

	it("validates bootstrap settings without exposing password contents", async () => {
		expect(loadBootstrapConfig({ INITIAL_ADMIN_USERNAME: "  ", INITIAL_ADMIN_DISPLAY_NAME: "  " })).toMatchObject({ username: "Admin", displayName: "Administrator" });
		for (const settings of [
			{ username: "x", displayName: "Admin", password: "" },
			{ username: "Admin", displayName: "x".repeat(31), password: "" },
			{ username: "Admin", displayName: "Admin", password: "short" },
		]) {
			await expect(bootstrapInitialAdmin(db.prisma, settings)).rejects.not.toThrow("short");
		}
		expect(await db.prisma.users.count()).toBe(0);
	});
});

describe("Phase 3 complete HTTP lifecycle and authorization", () => {
	let db: Awaited<ReturnType<typeof disposableDatabase>>;
	let adminId: number;
	let adminToken: string;
	beforeEach(async () => {
		db = await disposableDatabase();
		const admin = await db.prisma.users.create({ data: newUserData({ username: "Admin", displayName: "Admin", passwordHash: HASH, role: "admin" }) });
		adminId = admin.id; adminToken = await createAccessToken(adminId, "admin", config);
	});
	afterEach(async () => { vi.restoreAllMocks(); await db.dispose(); });
	const auth = (token: string) => `Bearer ${token}`;

	it("completes setup, account creation, password/PIN login, refresh, password change/reset, disable and logout", async () => {
		await db.prisma.users.deleteMany();
		await bootstrapInitialAdmin(db.prisma, loadBootstrapConfig({}));
		const app = appFor(db.prisma);
		const setup = await request(app).post("/api/auth/setup-password")
			.send({ password: PASSWORD, confirm_password: PASSWORD }).expect(200);
		const admin = await request(app).post("/api/auth/login").send({ username: "Admin", password: PASSWORD }).expect(200);
		expect(setup.body.user.role).toBe("admin");
		const created = await request(app).post("/api/admin/users").set("Authorization", auth(admin.body.access_token))
			.send({ username: "Child", password: PASSWORD, display_name: "Child" }).expect(200);
		expect(created.body).toMatchObject({ role: "kid", points_balance: 0, is_active: true, avatar_config: null });
		expect(created.body).not.toHaveProperty("password_hash");
		const login = await request(app).post("/api/auth/login").send({ username: "Child", password: PASSWORD }).expect(200);
		const access = auth(login.body.access_token);
		await request(app).get("/api/auth/me").set("Authorization", access).expect(200);
		await request(app).put("/api/auth/me").set("Authorization", access).send({ display_name: "New Kid", avatar_config: { hat: "blue" } }).expect(200);
		await request(app).post("/api/auth/set-pin").set("Authorization", access).send({ pin: "012345" }).expect(200);
		const pinLogin = await request(app).post("/api/auth/pin-login").send({ username: "Child", pin: "012345" }).expect(200);
		const refreshed = await request(app).post("/api/auth/refresh").set("Cookie", cookie(pinLogin)).expect(200);
		await request(app).post("/api/auth/change-password").set("Authorization", access)
			.send({ current_password: PASSWORD, new_password: "NewPassword42" }).expect(200);
		await request(app).post("/api/auth/refresh").set("Cookie", cookie(refreshed)).expect(401, { detail: "Refresh token already used" });
		const newLogin = await request(app).post("/api/auth/login").send({ username: "Child", password: "NewPassword42" }).expect(200);
		await request(app).post(`/api/admin/users/${created.body.id}/reset-password`).set("Authorization", auth(admin.body.access_token))
			.send({ new_password: "AdminReset42" }).expect(200, { detail: "Password reset for Child" });
		// Python admin resets intentionally preserve existing refresh sessions.
		const afterReset = await request(app).post("/api/auth/refresh").set("Cookie", cookie(newLogin)).expect(200);
		await request(app).post("/api/auth/login").send({ username: "Child", password: "AdminReset42" }).expect(200);
		await request(app).put(`/api/admin/users/${created.body.id}`).set("Authorization", auth(admin.body.access_token)).send({ is_active: false }).expect(200);
		await request(app).get("/api/auth/me").set("Authorization", access).expect(401);
		await request(app).post("/api/auth/refresh").set("Cookie", cookie(afterReset)).expect(401, { detail: "User not found or inactive" });
		await request(app).post("/api/auth/login").send({ username: "Child", password: "AdminReset42" }).expect(403);
		await request(app).post("/api/auth/logout").set("Cookie", cookie(afterReset)).expect(200, { detail: "Logged out" });
		const audits = await request(app).get("/api/admin/audit-log").set("Authorization", auth(admin.body.access_token)).expect(200);
		expect(audits.body.map((row: { action: string }) => row.action)).toEqual(expect.arrayContaining(["initial_password_setup", "login", "password_change"]));
		expect(JSON.stringify(audits.body)).not.toContain(PASSWORD);
		expect(JSON.stringify(audits.body)).not.toContain("012345");
	});

	it("restricts every admin operation and uses database roles after token issuance", async () => {
		const app = appFor(db.prisma);
		const routes = [["get", "/users"], ["post", "/users"], ["put", "/users/999"], ["delete", "/users/999"],
			["post", "/users/999/reset-password"], ["get", "/api-keys"], ["post", "/api-keys"], ["delete", "/api-keys/999"],
			["get", "/invite-codes"], ["post", "/invite-codes"], ["delete", "/invite-codes/999"], ["get", "/audit-log"]] as const;
		for (const [method, path] of routes) {
			await request(app)[method](`/api/admin${path}`).expect(401);
		}
		for (const role of ["kid", "parent"]) {
			await db.prisma.users.update({ where: { id: adminId }, data: { role } });
			for (const [method, path] of routes) {
				await request(app)[method](`/api/admin${path}`).set("Authorization", auth(adminToken))
					.expect(403, { detail: "Admin role required" });
			}
		}
		await db.prisma.users.update({ where: { id: adminId }, data: { role: "admin" } });
		await request(app).get("/api/admin/users").set("Authorization", auth(await createAccessToken(adminId, "kid", config))).expect(200);
	});

	it("creates users once, applies explicit defaults, validates bodies, and rejects uniqueness races", async () => {
		const app = appFor(db.prisma);
		const body = { username: "new-user", password: PASSWORD, display_name: "New User" };
		const results = await Promise.all([1, 2].map(() => request(app).post("/api/admin/users").set("Authorization", auth(adminToken)).send(body)));
		expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
		expect(results.find((result) => result.status === 409)?.body).toEqual({ detail: "Username already taken" });
		const stored = await db.prisma.users.findUniqueOrThrow({ where: { username: body.username }, select: { password_hash: true } });
		await expect(verifyPassword(PASSWORD, stored.password_hash)).resolves.toBe(true);
		for (const invalid of [{ ...body, role: "owner" }, { ...body, password: "short" }, { ...body, role: null }, { ...body, username: "x" }, { ...body, display_name: "" }]) {
			await request(app).post("/api/admin/users").set("Authorization", auth(adminToken)).send(invalid).expect(422);
		}
		await request(app).post("/api/admin/users/999/reset-password").set("Authorization", auth(adminToken)).send({ new_password: PASSWORD }).expect(404);
		await request(app).put("/api/admin/users/999").set("Authorization", auth(adminToken)).send({ role: "kid" }).expect(404);
	});

	it("updates roles/status, preserves null fields, reactivates users, and ignores protected fields", async () => {
		const app = appFor(db.prisma);
		const child = await db.prisma.users.create({ data: newUserData({ username: "Child", displayName: "Child", passwordHash: HASH, role: "kid" }) });
		const childToken = await createAccessToken(child.id, "admin", config);
		await request(app).put(`/api/admin/users/${child.id}`).set("Authorization", auth(adminToken))
			.send({ role: "parent", is_active: "false", username: "hijack", password_hash: "unsafe", points_balance: 999 }).expect(200);
		expect(await createPrismaAuthRepository(db.prisma).findUserByUsername("Child")).toMatchObject({ role: "parent", is_active: false, username: "Child", password_hash: HASH, points_balance: 0 });
		await request(app).get("/api/auth/me").set("Authorization", auth(childToken)).expect(401);
		await request(app).put(`/api/admin/users/${child.id}`).set("Authorization", auth(adminToken))
			.send({ role: null, is_active: true }).expect(200);
		await request(app).get("/api/auth/me").set("Authorization", auth(childToken)).expect(200);
		await request(app).put(`/api/admin/users/${child.id}`).set("Authorization", auth(adminToken)).send({ role: "admin" }).expect(200);
		await request(app).get("/api/admin/users").set("Authorization", auth(await createAccessToken(child.id, "kid", config))).expect(200);
		await request(app).put(`/api/admin/users/${child.id}`).set("Authorization", auth(adminToken)).send({ role: "bad" }).expect(422);
	});

	it("rejects expired, incorrectly signed, refresh, disabled and deleted admin credentials", async () => {
		const app = appFor(db.prisma);
		for (const token of [
			await createRefreshToken(adminId, config),
			await createAccessToken(adminId, "admin", { ...config, secretKey: "another-test-fixture-secret" }),
			await createAccessToken(adminId, "admin", { ...config, accessTokenExpireMinutes: -1 }),
		]) await request(app).get("/api/admin/users").set("Authorization", auth(token)).expect(401);
		await db.prisma.users.update({ where: { id: adminId }, data: { is_active: false } });
		await request(app).get("/api/admin/users").set("Authorization", auth(adminToken)).expect(401);
		await db.prisma.users.delete({ where: { id: adminId } });
		await request(app).get("/api/admin/users").set("Authorization", auth(adminToken)).expect(401);
	});

	it("protects self deletion and the last admin, including an inactive admin and concurrent demotions", async () => {
		const app = appFor(db.prisma);
		await request(app).delete(`/api/admin/users/${adminId}`).set("Authorization", auth(adminToken))
			.expect(400, { detail: "Administrators cannot delete their own account" });
		await request(app).put(`/api/admin/users/${adminId}`).set("Authorization", auth(adminToken)).send({ role: "kid" })
			.expect(400, { detail: "Cannot change the role of the only administrator" });
		await request(app).put(`/api/admin/users/${adminId}`).set("Authorization", auth(adminToken)).send({ is_active: false })
			.expect(400, { detail: "Cannot deactivate the only administrator" });
		const repo = createPrismaAdminRepository(db.prisma);
		await db.prisma.users.update({ where: { id: adminId }, data: { is_active: false } });
		await expect(repo.updateUser(adminId, { role: "parent" })).rejects.toThrow("only administrator");
		await expect(repo.deleteUser(adminId, 999)).rejects.toThrow("final administrator");
		await db.prisma.users.update({ where: { id: adminId }, data: { is_active: true } });
		const other = await db.prisma.users.create({ data: newUserData({ username: "OtherAdmin", displayName: "Other", passwordHash: HASH, role: "admin" }) });
		const demotions = await Promise.allSettled([repo.updateUser(adminId, { role: "kid" }), repo.updateUser(other.id, { role: "kid" })]);
		expect(demotions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(await db.prisma.users.count({ where: { role: "admin" } })).toBe(1);
	});

	it("round-trips API keys, invite codes, and filtered audit access without exposing key hashes", async () => {
		const app = appFor(db.prisma);
		const key = await request(app).post("/api/admin/api-keys").set("Authorization", auth(adminToken))
			.send({ name: "Automation", scopes: ["chores:read"] }).expect(200);
		expect(key.body.key).toMatch(/^[a-f0-9]{64}$/);
		const stored = await db.prisma.api_keys.findUniqueOrThrow({ where: { id: key.body.id }, select: { key_hash: true } });
		expect(stored.key_hash).toBe(createHash("sha256").update(key.body.key).digest("hex"));
		const list = await request(app).get("/api/admin/api-keys").set("Authorization", auth(adminToken)).expect(200);
		expect(list.body[0]).toMatchObject({ scopes: ["chores:read"], is_active: true });
		expect(list.body[0]).not.toHaveProperty("key"); expect(list.body[0]).not.toHaveProperty("key_hash");
		await request(app).delete(`/api/admin/api-keys/${key.body.id}`).set("Authorization", auth(adminToken)).expect(200);
		expect((await db.prisma.api_keys.findUniqueOrThrow({ where: { id: key.body.id }, select: { is_active: true } })).is_active).toBe(false);
		const invite = await request(app).post("/api/admin/invite-codes").set("Authorization", auth(adminToken)).send({ role: "kid" }).expect(200);
		expect(invite.body).toMatchObject({ max_uses: 1, times_used: 0, expires_at: null });
		expect(invite.body.code).toMatch(/^[ACDEFGHJKMNPQRTUVWXY34679]{8}$/);
		expect(invite.body).not.toHaveProperty("created_by");
		await request(app).get("/api/admin/invite-codes").set("Authorization", auth(adminToken)).expect(200);
		await request(app).delete(`/api/admin/invite-codes/${invite.body.id}`).set("Authorization", auth(adminToken)).expect(200);
		await request(app).get("/api/admin/audit-log?limit=201").set("Authorization", auth(adminToken)).expect(422);
		await request(app).get("/api/admin/audit-log?limit=1&offset=0&action=login&user_id=999").set("Authorization", auth(adminToken)).expect(200, []);
		for (const [path, body] of [["api-keys", { name: "x", scopes: [1] }], ["invite-codes", { role: "invalid" }], ["invite-codes", { role: "kid", max_uses: null }]] as const) {
			await request(app).post(`/api/admin/${path}`).set("Authorization", auth(adminToken)).send(body).expect(422);
		}
		await request(app).delete("/api/admin/api-keys/999").set("Authorization", auth(adminToken)).expect(404, { detail: "API key not found" });
		await request(app).delete("/api/admin/invite-codes/999").set("Authorization", auth(adminToken)).expect(404, { detail: "Invite code not found" });
	});

	it("validates invite expirations, nullable updates and API-key defaults using the Python contracts", async () => {
		const app = appFor(db.prisma);
		const key = await request(app).post("/api/admin/api-keys").set("Authorization", auth(adminToken))
			.send({ name: "Default Scopes" }).expect(200);
		expect(key.body.scopes).toEqual([]);
		const dated = await request(app).post("/api/admin/invite-codes").set("Authorization", auth(adminToken))
			.send({ role: "parent", max_uses: "3", expires_at: "2030-06-01T12:30:00+02:00" }).expect(200);
		expect(dated.body).toMatchObject({ max_uses: 3, expires_at: "2030-06-01T10:30:00.000Z" });
		for (const expires_at of ["2030-02-31", "not-a-date", false, {}]) {
			await request(app).post("/api/admin/invite-codes").set("Authorization", auth(adminToken))
				.send({ role: "kid", expires_at }).expect(422);
		}
		await request(app).put(`/api/admin/users/${adminId}`).set("Authorization", auth(adminToken))
			.send({ role: null, is_active: null }).expect(200);
		await request(app).delete("/api/admin/api-keys/not-an-integer").set("Authorization", auth(adminToken)).expect(422);
		const audit = await request(app).get("/api/admin/audit-log?limit=0").set("Authorization", auth(adminToken)).expect(422);
		expect(audit.body.detail[0]).toMatchObject({ loc: ["query", "limit"], type: "greater_than_equal", ctx: { ge: 1 } });
	});

	it("orders admin history correctly when Python text timestamps coexist with new Prisma records", async () => {
		const prisma = db.prisma;
		await prisma.$executeRaw`UPDATE users SET created_at = ${"2000-01-01 00:00:00.000000"},
      updated_at = ${"2000-01-01 00:00:00.000000"}, last_streak_date = ${"2000-01-01"}
      WHERE id = ${adminId}`;
		await prisma.$executeRaw`INSERT INTO audit_logs (user_id, action, details, ip_address, created_at)
      VALUES (${adminId}, ${"old_python_event"}, ${"{}"}, NULL, ${"2000-01-01 00:00:00.000000"})`;
		await prisma.$executeRaw`INSERT INTO api_keys (name, key_hash, key_prefix, scopes, created_by, is_active, created_at)
      VALUES (${"Old Python Key"}, ${"fixture-hash"}, ${"fixture"}, ${"[]"}, ${adminId}, ${true}, ${"2000-01-01 00:00:00.000000"})`;
		await prisma.$executeRaw`INSERT INTO invite_codes (code, role, max_uses, times_used, created_by, created_at)
      VALUES (${"PYTHON12"}, ${"kid"}, ${1}, ${0}, ${adminId}, ${"2000-01-01 00:00:00.000000"})`;
		const app = appFor(prisma);
		await request(app).post("/api/auth/login").send({ username: "Admin", password: PASSWORD }).expect(200);
		const profile = await request(app).get("/api/auth/me").set("Authorization", auth(adminToken)).expect(200);
		expect(profile.body.created_at).toBe("2000-01-01T00:00:00.000Z");
		await request(app).post("/api/auth/set-pin").set("Authorization", auth(adminToken)).send({ pin: "012345" }).expect(200);
		await request(app).post("/api/admin/api-keys").set("Authorization", auth(adminToken)).send({ name: "New Key" }).expect(200);
		await request(app).post("/api/admin/invite-codes").set("Authorization", auth(adminToken)).send({ role: "parent" }).expect(200);
		expect(await createPrismaAdminRepository(prisma).auditLog({ limit: 50, offset: 0 })).toHaveLength(2);
		const logs = await request(app).get("/api/admin/audit-log").set("Authorization", auth(adminToken)).expect(200);
		expect(logs.body.map((row: { action: string }) => row.action)).toEqual(["login", "old_python_event"]);
		const keys = await request(app).get("/api/admin/api-keys").set("Authorization", auth(adminToken)).expect(200);
		expect(keys.body.map((row: { name: string }) => row.name)).toEqual(["New Key", "Old Python Key"]);
		const invites = await request(app).get("/api/admin/invite-codes").set("Authorization", auth(adminToken)).expect(200);
		expect(invites.body.map((row: { role: string }) => row.role)).toEqual(["parent", "kid"]);
	});

	it("rejects mismatched refresh ownership, concurrent replay, and stale concurrent password changes", async () => {
		const app = appFor(db.prisma);
		const repo = createPrismaAuthRepository(db.prisma);
		const other = await db.prisma.users.create({ data: newUserData({ username: "Other", displayName: "Other", passwordHash: HASH, role: "kid" }) });
		const mismatch = await createRefreshToken(other.id, config);
		await repo.storeRefreshToken({ userId: adminId, tokenHash: createHash("sha256").update(mismatch).digest("hex"), expiresAt: new Date("2040-01-01") });
		await request(app).post("/api/auth/refresh").set("Cookie", `refresh_token=${mismatch}`).expect(401, { detail: "Invalid or expired refresh token" });
		const login = await request(app).post("/api/auth/login").send({ username: "Admin", password: PASSWORD }).expect(200);
		const refreshes = await Promise.all([1, 2].map(() => request(app).post("/api/auth/refresh").set("Cookie", cookie(login))));
		expect(refreshes.map((response) => response.status).sort()).toEqual([200, 401]);
		const changes = await Promise.all(["ConcurrentNewPassword1", "ConcurrentNewPassword2"].map((new_password) =>
			request(app).post("/api/auth/change-password").set("Authorization", auth(adminToken))
				.send({ current_password: PASSWORD, new_password })));
		expect(changes.map((response) => response.status).sort()).toEqual([200, 400]);
		expect(await db.prisma.audit_logs.count({ where: { action: "password_change", user_id: adminId } })).toBe(1);
	});

	it("rolls back refresh revocation if replacement persistence fails", async () => {
		const repo = createPrismaAuthRepository(db.prisma);
		const token = await createRefreshToken(adminId, config);
		const oldHash = createHash("sha256").update(token).digest("hex");
		await repo.storeRefreshToken({ userId: adminId, tokenHash: oldHash, expiresAt: new Date("2040-01-01") });
		await db.prisma.$executeRawUnsafe("CREATE TRIGGER fail_refresh BEFORE INSERT ON refresh_tokens BEGIN SELECT RAISE(ABORT, 'fixture rotation failure'); END");
		await expect(repo.rotateRefreshToken({ tokenHash: oldHash, userId: adminId,
			replacementTokenHash: createHash("sha256").update("fixture-replacement").digest("hex"),
			replacementExpiresAt: new Date("2040-01-01"),
		})).rejects.toThrow();
		expect(await db.prisma.refresh_tokens.findFirst({ where: { token_hash: oldHash }, select: { is_revoked: true } })).toMatchObject({ is_revoked: false });
		expect(await db.prisma.refresh_tokens.count()).toBe(1);
	});

	it("handles malformed requests and corrupt PIN hashes without logging credentials", async () => {
		const app = appFor(db.prisma);
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await request(app).post("/api/auth/login").set("Content-Type", "application/json")
			.send('{"password":"DoNotLogThisPassword",').expect(422);
		await request(app).post("/api/auth/login").send({ username: 123, password: null }).expect(422);
		await db.prisma.users.update({ where: { id: adminId }, data: { pin_hash: "invalid hash" } });
		await request(app).post("/api/auth/pin-login").send({ username: "Admin", pin: "123456" }).expect(401);
		expect(JSON.stringify(log.mock.calls)).not.toContain("DoNotLogThisPassword");
	});

	it("preserves Secure cookie creation/clearing and credentialed CORS", async () => {
		const app = appFor(db.prisma, true);
		const login = await request(app).post("/api/auth/login").set("Origin", config.corsOrigins[0])
			.send({ username: "Admin", password: PASSWORD }).expect(200);
		expect(login.headers["access-control-allow-origin"]).toBe(config.corsOrigins[0]);
		expect(login.headers["access-control-allow-credentials"]).toBe("true");
		expect((login.headers["set-cookie"] as unknown as string[])[0]).toMatch(/; Secure$/);
		expect((login.headers["set-cookie"] as unknown as string[])[0]).not.toContain("Expires");
		expect(login.body).not.toHaveProperty("refresh_token");
		const logout = await request(app).post("/api/auth/logout").set("Cookie", cookie(login)).expect(200);
		expect((logout.headers["set-cookie"] as unknown as string[])[0]).toContain("Max-Age=0");
		expect((logout.headers["set-cookie"] as unknown as string[])[0]).toMatch(/; Secure$/);
	});
});
