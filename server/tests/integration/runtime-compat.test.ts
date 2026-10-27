import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaClient, Prisma } from "@prisma/client";
import { afterEach, expect, it } from "vitest";
import { Store, write } from "../../src/business/store.js";
import { newUserData } from "../../src/auth/accounts.js";
import { maintainDaily } from "../../src/runtime/scheduler.js";
import { initializeVapid } from "../../src/runtime/vapid.js";
import { PushService, type PushSender } from "../../src/runtime/push.js";
import { notify } from "../../src/business/gamification.js";
import { requireDeletionSchema } from "../../src/db/accountSchema.js";
import { disposableDatabase } from "../helpers/sqlite.js";
const run = promisify(execFile), root = fileURLToPath(new URL("../../../", import.meta.url)), python = resolve(root, ".venv/Scripts/python.exe");
const disposers: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (disposers.length)
	await disposers.pop()!(); });
async function fixture() {
	const db = await disposableDatabase();
	disposers.push(() => db.dispose());
	const store = await Store.open(db.prisma);
	for (const [username, role] of [["Admin", "admin"], ["Kid", "kid"], ["Other", "kid"]]) {
		const user = await db.prisma.users.create({ data: newUserData({ username, displayName: username, role, passwordHash: "fixture" }) });
		// Fixture-only Prisma create writes epoch dates. Production insertAccount
		// writes Python-readable text; make this cross-language fixture match it.
		await store.update("users", user.id, { created_at: "2026-03-01 00:00:00.123456" });
	}
	const category = await store.insert("chore_categories", { name: "Compatibility", icon: "star", colour: "#123456", is_default: false });
	const c = await store.insert("chores", { title: "Python comparison", description: null, points: 10, difficulty: "easy", category_id: category.id, recurrence: "daily", custom_days: null, requires_photo: false, is_active: true, created_by: 1, created_at: "2026-03-02 00:00:00.123456" });
	for (const user_id of [2, 3])
		await store.insert("chore_assignment_rules", { chore_id: c.id, user_id, recurrence: "daily", custom_days: null, requires_photo: false, is_active: true });
	await store.insert("chore_rotations", { chore_id: c.id, kid_ids: [2, 3], cadence: "daily", current_index: 0, last_rotated: "2026-03-08 12:00:00.000000" });
	for (const [id, last_streak_date] of [[2, "2026-03-06"], [3, "2026-03-04"]] as const)
		await store.update("users", id, { current_streak: 8, last_streak_date, streak_freezes_used: 1 });
	await store.insert("vacation_periods", { start_date: "2026-03-07", end_date: "2026-03-08", is_active: true, created_by: 1 });
	return { ...db, store };
}
it("matches actual Python daily rotation/generation and stale-streak maintenance on identical disposable fixtures", async () => {
	const node = await fixture(), reference = await fixture();
	await write(node.prisma, node.store, tx => maintainDaily(tx, "2026-03-09", new Date("2026-03-09T12:00:00Z")));
	const script = [
		"import asyncio,datetime,sys",
		"assert 'chorequest-auth-' in sys.argv[1]",
		"from backend.database import async_session",
		"import backend.services.assignment_generator as generator",
		"from backend.main import reset_stale_streaks",
		"class FixedDateTime(datetime.datetime):",
		" @classmethod",
		" def now(cls,tz=None): return cls(2026,3,9,12,tzinfo=datetime.timezone.utc)",
		"generator.datetime=FixedDateTime",
		"async def main():",
		" async with async_session() as db:",
		"  await generator.generate_daily_assignments(db,datetime.date(2026,3,9))",
		"  await reset_stale_streaks(db,datetime.date(2026,3,9))",
		"  await db.commit()",
		"asyncio.run(main())",
		"print('Actual Python maintenance passed')",
	].join("\n");
	const output = await run(python, ["-B", "-c", script, reference.databasePath], { cwd: reference.directory, windowsHide: true, timeout: 20000, env: { ...process.env, PYTHONPATH: root, SECRET_KEY: "python-maintenance-fixture-only", DATABASE_URL: `sqlite+aiosqlite:///${reference.databasePath.replaceAll("\\", "/")}`, TZ: "UTC" } });
	expect(output.stdout).toContain("Actual Python maintenance passed");
	for (const table of ["chore_assignments", "chore_rotations", "users"] as const) {
		const fields = table === "chore_assignments" ? ["chore_id", "user_id", "date", "status"] : table === "chore_rotations" ? ["chore_id", "current_index", "last_rotated"] : ["id", "points_balance", "total_points_earned", "current_streak", "last_streak_date", "streak_freezes_used"];
		const projection = (rows: Record<string, unknown>[]) => rows.map(row => Object.fromEntries(fields.map(key => [key, row[key]])));
		expect(projection(await node.store.rows(table))).toEqual(projection(await reference.store.rows(table)));
	}
	expect(await node.prisma.$queryRaw `PRAGMA foreign_key_check`).toEqual([]);
}, 30000);
it("supports VAPID, durable push and scheduled state on a prepared legacy copy while leaving the source intact", async () => {
	const source = await disposableDatabase(true);
	disposers.push(() => source.dispose());
	await source.prisma.users.create({ data: newUserData({ username: "LegacyAdmin", displayName: "Legacy", role: "admin", passwordHash: "fixture" }) });
	await source.prisma.$disconnect();
	const before = await readFile(source.databasePath), output = resolve(source.directory, "prepared-runtime.db");
	await run(python, ["-B", resolve(root, "server/scripts/prepare-legacy-auth-db.py"), "--source", source.databasePath, "--output", output], { windowsHide: true, timeout: 20000 });
	expect(await readFile(source.databasePath)).toEqual(before);
	const prisma = new PrismaClient({ datasources: { db: { url: `file:${output.replaceAll("\\", "/")}?connection_limit=1` } } });
	disposers.push(() => prisma.$disconnect());
	await requireDeletionSchema(prisma);
	const store = await Store.open(prisma), keys = await initializeVapid(prisma, { subject: "mailto:fixture@example.com" });
	let delivered = 0;
	const sender: PushSender = async () => { delivered++; };
	const push = new PushService(prisma, keys, { subject: "mailto:fixture@example.com" }, sender);
	disposers.push(() => push.stop());
	await store.insert("push_subscriptions", { user_id: 1, endpoint: "https://fcm.googleapis.com/legacy-fixture", p256dh: "fixture", auth: "fixture" });
	await write(prisma, store, async (tx) => { await notify(tx, 1, "bonus_points", "Synthetic legacy notification", "Synthetic body"); await push.prepare(tx); });
	await push.processBatch();
	expect(delivered).toBe(1);
	expect((await store.one("users", 1, "User")).password_hash).toBe("fixture");
	expect(await prisma.$queryRaw `PRAGMA foreign_key_check`).toEqual([]);
	const tables = await prisma.$queryRaw<Array<{
		name: string;
	}>> `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'_prisma_migrations'`;
	expect(tables).toHaveLength(28);
	expect(await readFile(source.databasePath)).toEqual(before);
}, 30000);
