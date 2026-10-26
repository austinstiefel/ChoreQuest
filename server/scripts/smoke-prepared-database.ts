/** Exercise ONLY the private exercise.db created by verify-legacy-preparation.py. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/auth/passwords.js";
import { requireDeletionSchema } from "../src/db/accountSchema.js";
import { requireSqliteFile } from "../src/db/sqliteFile.js";
import { sqliteTimestamp } from "../src/db/legacySqlite.js";
import { createPrismaAdminRepository } from "../src/routes/admin.js";

function check(condition: unknown, description: string): asserts condition {
	if (!condition) throw new Error(`Prepared-copy smoke check failed: ${description}`);
}
const workspace = resolve(process.argv[2] ?? "");
const report = JSON.parse(await readFile(resolve(workspace, "report.json"), "utf8"));
const exercise = resolve(workspace, "exercise.db");
check(resolve(report.workspace) === workspace && resolve(report.files.exercise) === exercise
	&& resolve(report.files.prepared) !== exercise && resolve(report.source) !== exercise, "private exercise-copy manifest");
const preparedDigest = createHash("sha256").update(await readFile(report.files.prepared)).digest("hex");
const url = `file:${exercise.replaceAll("\\", "/")}?connection_limit=1`;
requireSqliteFile(url);
const prisma = new PrismaClient({ datasources: { db: { url } } });
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const password = "Phase3DisposablePassword42";
const prefix = `dryrun-${randomUUID().slice(0, 16)}`;
const checks: Record<string, boolean> = {};
let child: ReturnType<typeof spawn> | undefined;
let exited: Promise<unknown> | undefined;
try {
	await requireDeletionSchema(prisma);
	checks.startup_schema_guards = true;
	const repository = createPrismaAdminRepository(prisma);
	const originalUsers = await repository.listUsers();
	check(originalUsers.length === report.verification.row_counts.users, "existing account loading");
	const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
	const credentialsBefore = fingerprint(originalUsers.map((u) => [u.id, u.password_hash, u.pin_hash, u.role, u.is_active]));
	checks.existing_accounts_loaded = true;
	const administrator = await repository.createUser({ username: `${prefix}-admin`, displayName: "Dry Run", role: "admin", passwordHash: await hashPassword(password) });
	const socket = createServer();
	await new Promise<void>((done) => socket.listen(0, "127.0.0.1", done));
	const address = socket.address();
	check(address !== null && typeof address !== "string", "temporary port selection");
	const port = address.port;
	await new Promise<void>((done) => socket.close(() => done()));
	child = spawn(process.execPath, [resolve(root, "dist/server.js")], { cwd: root,
		env: { ...process.env, DATABASE_URL: url, SECRET_KEY: "phase3-disposable-smoke-signing-secret", PORT: String(port), HOST: "127.0.0.1",
			COOKIE_SECURE: "false", CORS_ORIGINS: "", ACCESS_TOKEN_EXPIRE_MINUTES: "15", REFRESH_TOKEN_EXPIRE_DAYS: "30",
			DOTENV_CONFIG_PATH: resolve(workspace, "nonexistent-test-only.env") },
		stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	exited = new Promise((done) => { child!.once("exit", done); child!.once("error", done); });
	// Never echo server output: it could contain private database diagnostics.
	child.stdout?.resume(); child.stderr?.resume();
	const base = `http://127.0.0.1:${port}`;
	let healthy = false;
	for (let attempt = 0; attempt < 80 && child.exitCode === null; attempt++) {
		try { healthy = (await fetch(`${base}/api/health`)).ok; } catch { /* starting */ }
		if (healthy) break;
		await delay(100);
	}
	check(healthy, "production entrypoint health");
	checks.production_startup = true;
	async function api(path: string, status = 200, method = "GET", body?: unknown, token?: string, cookie?: string) {
		const response = await fetch(`${base}${path}`, { method, headers: {
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
			...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}),
		}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		check(response.status === status, `${method} ${path.replace(/\d+/g, ":id")} status`);
		return { body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
	}
	const login = await api("/api/auth/login", 200, "POST", { username: administrator.username, password });
	const adminToken = login.body.access_token as string;
	await api("/api/auth/me", 200, "GET", undefined, adminToken);
	await api("/api/admin/users", 401);
	const kid = (await api("/api/admin/users", 200, "POST", { username: `${prefix}-kid`, display_name: "Dry Kid", password }, adminToken)).body;
	const kidLogin = await api("/api/auth/login", 200, "POST", { username: kid.username, password });
	const kidToken = kidLogin.body.access_token as string;
	for (const path of ["users", "api-keys", "invite-codes", "audit-log"]) await api(`/api/admin/${path}`, 403, "GET", undefined, kidToken);
	await api(`/api/admin/users/${kid.id}`, 200, "PUT", { role: "admin" }, adminToken);
	await api("/api/admin/users", 200, "GET", undefined, kidToken);
	checks.database_role_authorization = true;
	const rotated = await api("/api/auth/refresh", 200, "POST", undefined, undefined, kidLogin.cookie);
	await api("/api/auth/refresh", 401, "POST", undefined, undefined, kidLogin.cookie);
	await api("/api/auth/logout", 200, "POST", undefined, undefined, rotated.cookie);
	await api("/api/auth/refresh", 401, "POST", undefined, undefined, rotated.cookie);
	checks.refresh_rotation_replay_logout = true;
	await api(`/api/admin/users/${kid.id}/reset-password`, 200, "POST", { new_password: `${password}Reset` }, adminToken);
	await api("/api/auth/login", 200, "POST", { username: kid.username, password: `${password}Reset` });
	await api("/api/auth/set-pin", 200, "POST", { pin: "123456" }, kidToken);
	await api("/api/auth/pin-login", 200, "POST", { username: kid.username, pin: "123456" });
	checks.isolated_account_authentication = true;
	const victim = (await api("/api/admin/users", 200, "POST", { username: `${prefix}-victim`, display_name: "Dry Victim", role: "admin", password }, adminToken)).body;
	const victimLogin = await api("/api/auth/login", 200, "POST", { username: victim.username, password });
	const victimToken = victimLogin.body.access_token as string;
	const key = (await api("/api/admin/api-keys", 200, "POST", { name: "Disposable dry-run key", scopes: [] }, victimToken)).body;
	const invite = (await api("/api/admin/invite-codes", 200, "POST", { role: "kid" }, victimToken)).body;
	await api("/api/admin/audit-log", 200, "GET", undefined, adminToken);
	const now = sqliteTimestamp();
	const announcementTitle = `${prefix}-announcement`;
	await prisma.$executeRaw`INSERT INTO announcements (title,message,is_pinned,created_by,created_at) VALUES (${announcementTitle},'Disposable',0,${victim.id},${now})`;
	await prisma.$executeRaw`INSERT INTO shoutouts (from_user_id,to_user_id,message,emoji,created_at) VALUES (${victim.id},${administrator.id},'Disposable','star',${now})`;
	await prisma.$executeRaw`INSERT INTO notifications (user_id,type,title,message,is_read,created_at) VALUES (${victim.id},'test','Dry run','Disposable',0,${now})`;
	await api(`/api/admin/users/${administrator.id}`, 400, "DELETE", undefined, adminToken);
	await api(`/api/admin/users/${victim.id}`, 200, "DELETE", undefined, adminToken);
	await api("/api/auth/me", 401, "GET", undefined, victimToken);
	await api("/api/admin/users", 401, "GET", undefined, victimToken);
	await api("/api/auth/refresh", 401, "POST", undefined, undefined, victimLogin.cookie);
	check(await prisma.notifications.count({ where: { user_id: victim.id } }) === 0, "owned notification cleanup");
	const announcements = await prisma.$queryRaw<Array<{ created_by: number | null }>>`SELECT created_by FROM announcements WHERE title=${announcementTitle}`;
	check(announcements.length === 1 && announcements[0].created_by === null, "family announcement preservation");
	check(await prisma.api_keys.count({ where: { id: key.id, created_by: null } }) === 1, "family API key preservation");
	check(await prisma.invite_codes.count({ where: { id: invite.id, created_by: null } }) === 1, "family invite preservation");
	check(await prisma.shoutouts.count({ where: { from_user_id: null, to_user_id: administrator.id } }) === 1, "historical shoutout preservation");
	const replacement = (await api("/api/admin/users", 200, "POST", { username: `${prefix}-replacement`, display_name: "Replacement", role: "admin", password }, adminToken)).body;
	check(replacement.id > victim.id, "durable identity non-reuse");
	await api("/api/admin/users", 401, "GET", undefined, victimToken);
	checks.permanent_deletion_family_history_and_identity = true;
	await api(`/api/admin/api-keys/${key.id}`, 200, "DELETE", undefined, adminToken);
	await api(`/api/admin/invite-codes/${invite.id}`, 200, "DELETE", undefined, adminToken);
	await api(`/api/admin/users/${kid.id}`, 200, "DELETE", undefined, adminToken);
	await api(`/api/admin/users/${replacement.id}`, 200, "DELETE", undefined, adminToken);
	const originalIds = new Set(originalUsers.map((user) => user.id));
	const remaining = (await repository.listUsers()).filter((user) => originalIds.has(user.id));
	check(fingerprint(remaining.map((u) => [u.id, u.password_hash, u.pin_hash, u.role, u.is_active])) === credentialsBefore, "original account credentials/roles unchanged in exercise copy");
	check((await prisma.$queryRaw<unknown[]>`PRAGMA foreign_key_check`).length === 0, "post-operation foreign-key integrity");
	checks.original_accounts_unchanged = true;
	checks.foreign_keys_clean = true;
	check(createHash("sha256").update(await readFile(report.files.prepared)).digest("hex") === preparedDigest, "prepared reference remains untouched");
	checks.prepared_reference_unchanged = true;
	await writeFile(resolve(workspace, "smoke-report.json"), JSON.stringify({ checks, credential_source: "isolated disposable accounts only" }, null, 2), { flag: "wx", mode: 0o600 });
	console.log(JSON.stringify({ checks, credential_source: "isolated disposable accounts only" }, null, 2));
} finally {
	if (child && child.exitCode === null) child.kill("SIGTERM");
	if (exited) await Promise.race([exited, delay(5000)]);
	if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	await prisma.$disconnect();
}
