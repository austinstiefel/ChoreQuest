import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DailyScheduler, generateDaily, maintainDaily, resetHour, dailySlot } from "../../src/runtime/scheduler.js";
import { getState, RUNTIME_PREFIX } from "../../src/runtime/state.js";
import { Store, write, type Row } from "../../src/business/store.js";
import { newUserData } from "../../src/auth/accounts.js";
import { disposableDatabase } from "../helpers/sqlite.js";
let db: Awaited<ReturnType<typeof disposableDatabase>>, store: Store, admin: number, kid: number, other: number, category: number;
const execute = promisify(execFile), root = fileURLToPath(new URL("../../", import.meta.url));
beforeEach(async () => {
	db = await disposableDatabase();
	store = await Store.open(db.prisma);
	const users = [];
	for (const [username, role] of [["Admin", "admin"], ["Kid", "kid"], ["Other", "kid"]])
		users.push(await db.prisma.users.create({ data: newUserData({ username, displayName: username, role, passwordHash: "fixture" }) }));
	[admin, kid, other] = users.map(u => u.id);
	category = Number((await store.insert("chore_categories", { name: "Fixture", icon: "star", colour: "#123456", is_default: false })).id);
});
afterEach(async () => { vi.restoreAllMocks(); await db.dispose(); });
async function chore(extra: Row = {}) {
	const c = await store.insert("chores", { title: "Daily fixture", description: null, points: 10, difficulty: "easy", icon: null, category_id: category, recurrence: "daily", custom_days: null, requires_photo: false, is_active: true, created_by: admin, created_at: "2026-03-02 00:00:00.123456", ...extra });
	for (const user_id of [kid, other])
		await store.insert("chore_assignment_rules", { chore_id: c.id, user_id, recurrence: c.recurrence, custom_days: c.custom_days, requires_photo: false, is_active: true });
	return c;
}
async function worker(instant: string, tz = "America/Chicago", hour = 0) {
	const result = await execute(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../helpers/scheduler-worker.ts", import.meta.url)), `file:${db.databasePath.replaceAll("\\", "/")}?connection_limit=1`, instant, String(hour)], { cwd: root, windowsHide: true, timeout: 20000, env: { ...process.env, TZ: tz } });
	return JSON.parse(result.stdout);
}
it.each(["-1", "24", "1.5", "not-an-hour", ""])("rejects invalid UTC reset-hour configuration (%s)", value => expect(() => resetHour({ DAILY_RESET_HOUR: value })).toThrow("DAILY_RESET_HOUR"));
it("preserves the Python UTC trigger default and exact-hour boundary", () => {
	expect(resetHour({})).toBe(0);
	expect(resetHour({ DAILY_RESET_HOUR: "23" })).toBe(23);
	expect(dailySlot(new Date("2030-01-02T04:59:59Z"), 5)).toBe("2030-01-01T05:00:00.000Z");
	expect(dailySlot(new Date("2030-01-02T05:00:00Z"), 5)).toBe("2030-01-02T05:00:00.000Z");
});
it("generates once per persisted slot and preserves completed assignments/history on rerun", async () => {
	await chore();
	const scheduler = new DailyScheduler(db.prisma, 0), now = new Date("2030-01-02T12:00:00Z");
	expect(await scheduler.run(now)).toBe(true);
	const rows = await store.rows("chore_assignments");
	expect(rows).toHaveLength(2);
	await store.update("chore_assignments", Number(rows[0].id), { status: "verified", verified_by: admin });
	expect(await scheduler.run(now)).toBe(false);
	expect(await db.prisma.chore_assignments.count()).toBe(2);
	expect((await store.one("chore_assignments", Number(rows[0].id), "Assignment")).status).toBe("verified");
	expect(await db.prisma.point_transactions.count()).toBe(0);
	expect(await db.prisma.user_achievements.count()).toBe(0);
});
it("coordinates concurrent daily runs on independent connections", async () => {
	await chore();
	const second = new PrismaClient({ datasources: { db: { url: `file:${db.databasePath.replaceAll("\\", "/")}?connection_limit=1` } } });
	try {
		const results = await Promise.all([new DailyScheduler(db.prisma, 0).run(), new DailyScheduler(second, 0).run()]);
		expect(results.sort()).toEqual([false, true]);
		expect(await db.prisma.chore_assignments.count()).toBe(2);
	}
	finally {
		await second.$disconnect();
	}
});
it("coordinates independent Node processes and persists restart recovery without historical backfill", async () => {
	await chore();
	const results = await Promise.all([worker("2030-01-02T12:00:00Z"), worker("2030-01-02T12:00:00Z")]);
	expect(results.map(r => r.ran).sort()).toEqual([false, true]);
	expect((await worker("2030-01-02T12:00:01Z")).ran).toBe(false);
	expect((await worker("2030-01-07T12:00:00Z")).ran).toBe(true);
	expect((await store.rows("chore_assignments")).map(a => a.date).sort()).toEqual(["2030-01-02", "2030-01-02", "2030-01-07", "2030-01-07"]);
	expect(await db.prisma.$queryRaw `PRAGMA foreign_key_check`).toEqual([]);
}, 30000);
it("preserves local dates and UTC execution slots across DST changes and east-of-UTC boundaries", async () => {
	await chore();
	const before = await worker("2026-03-08T07:59:59Z"), after = await worker("2026-03-08T08:00:00Z");
	expect(before).toMatchObject({ ran: true, today: "2026-03-08", offset: 360 });
	expect(after).toMatchObject({ ran: false, today: "2026-03-08", offset: 300 });
	expect(before.slot).toBe(after.slot);
	const tokyo = await worker("2026-11-01T15:00:00Z", "Asia/Tokyo");
	expect(tokyo).toMatchObject({ ran: true, today: "2026-11-02", slot: "2026-11-01T00:00:00.000Z" });
}, 30000);
it("reconciles a new local date on restart even if the current UTC execution slot already ran", async () => {
	await chore();
	const before = await worker("2026-11-02T05:59:59Z"), after = await worker("2026-11-02T06:00:00Z");
	expect(before).toMatchObject({ ran: true, today: "2026-11-01" });
	expect(after).toMatchObject({ ran: true, today: "2026-11-02" });
	expect(before.slot).toBe(after.slot);
	expect((await worker("2026-11-02T06:01:00Z")).ran).toBe(false);
	expect(await db.prisma.chore_assignments.count()).toBe(4);
}, 30000);
it("advances rotations once on an occurrence day but not on inactive/vacation days", async () => {
	const c = await chore({ recurrence: "custom", custom_days: [0] }), rotation = await store.insert("chore_rotations", { chore_id: c.id, kid_ids: [kid, other], cadence: "daily", current_index: 0, last_rotated: "2026-03-02 00:00:00.000000" });
	await write(db.prisma, store, tx => generateDaily(tx, "2026-03-08", new Date("2026-03-08T12:00:00Z")));
	expect((await store.one("chore_rotations", Number(rotation.id), "Rotation")).current_index).toBe(0);
	await write(db.prisma, store, tx => generateDaily(tx, "2026-03-09", new Date("2026-03-09T12:00:00Z")));
	expect((await store.one("chore_rotations", Number(rotation.id), "Rotation")).current_index).toBe(1);
	expect((await store.rows("chore_assignments"))[0].user_id).toBe(other);
	await write(db.prisma, store, tx => generateDaily(tx, "2026-03-09", new Date("2026-03-09T12:00:00Z")));
	expect(await db.prisma.chore_assignments.count()).toBe(1);
	await store.insert("vacation_periods", { start_date: "2026-03-16", end_date: "2026-03-16", created_by: admin, is_active: true });
	await write(db.prisma, store, tx => generateDaily(tx, "2026-03-16", new Date("2026-03-16T12:00:00Z")));
	expect((await store.one("chore_rotations", Number(rotation.id), "Rotation")).current_index).toBe(1);
});
it("honors exclusions and legacy recurrence fallback without resurrecting removed slots", async () => {
	const c = await chore();
	await db.prisma.chore_assignment_rules.deleteMany();
	await store.insert("chore_assignments", { chore_id: c.id, user_id: kid, date: "2026-03-01", status: "verified", completed_at: null, verified_at: null, verified_by: admin, photo_proof_path: null, feedback: null });
	await store.insert("chore_exclusions", { chore_id: c.id, user_id: kid, date: "2026-03-02" });
	await write(db.prisma, store, tx => generateDaily(tx, "2026-03-02", new Date("2026-03-02T12:00:00Z")));
	expect(await db.prisma.chore_assignments.count()).toBe(1);
	await write(db.prisma, store, tx => generateDaily(tx, "2026-03-03", new Date("2026-03-03T12:00:00Z")));
	expect(await db.prisma.chore_assignments.count()).toBe(2);
});
it("resets stale active-child streaks without consuming freezes and respects inclusive vacation gaps", async () => {
	await store.update("users", kid, { current_streak: 8, longest_streak: 8, last_streak_date: "2026-03-06", streak_freezes_used: 1, streak_freeze_month: 123 });
	await store.update("users", other, { current_streak: 4, last_streak_date: "2026-03-08" });
	await store.insert("vacation_periods", { start_date: "2026-03-07", end_date: "2026-03-08", created_by: admin, is_active: true });
	await write(db.prisma, store, tx => maintainDaily(tx, "2026-03-09", new Date("2026-03-09T12:00:00Z")));
	expect((await store.one("users", kid, "User")).current_streak).toBe(8);
	await write(db.prisma, store, tx => maintainDaily(tx, "2026-03-10", new Date("2026-03-10T12:00:00Z")));
	expect(await store.one("users", kid, "User")).toMatchObject({ current_streak: 0, longest_streak: 8, streak_freezes_used: 1, streak_freeze_month: 123 });
});
it("removes only expired refresh credentials and preserves Python microsecond formats", async () => {
	for (const [hash, expires] of [["expired", "2026-03-09 11:59:59.999999"], ["equal", "2026-03-09 12:00:00.000000"], ["future", "2026-03-09 12:00:00.000001"]])
		await db.prisma.$executeRaw `INSERT INTO refresh_tokens (user_id,token_hash,is_revoked,expires_at,created_at) VALUES (${kid},${hash},0,${expires},'2026-03-01 00:00:00.123456')`;
	await write(db.prisma, store, tx => maintainDaily(tx, "2026-03-09", new Date("2026-03-09T12:00:00Z")));
	expect((await db.prisma.refresh_tokens.findMany({ select: { token_hash: true } })).map(t => t.token_hash).sort()).toEqual(["equal", "future"]);
	expect(await db.prisma.$queryRaw `SELECT CAST(created_at AS TEXT) AS stamp FROM refresh_tokens WHERE token_hash='future'`).toEqual([{ stamp: "2026-03-01 00:00:00.123456" }]);
});
it("rolls back all maintenance and its checkpoint on failure, then safely retries", async () => {
	await chore();
	const failing = new DailyScheduler(db.prisma, 0, async (tx, today, now) => { await maintainDaily(tx, today, now); await tx.update("users", kid, { points_balance: 999 }); throw new Error("injected"); });
	await expect(failing.run()).rejects.toThrow("injected");
	expect(await db.prisma.chore_assignments.count()).toBe(0);
	expect((await store.one("users", kid, "User")).points_balance).toBe(0);
	expect(await getState(db.prisma, `${RUNTIME_PREFIX}daily`)).toBeNull();
	expect(await new DailyScheduler(db.prisma, 0).run()).toBe(true);
	expect(await db.prisma.chore_assignments.count()).toBe(2);
});
it("cancels future polling while awaiting in-flight maintenance during shutdown", async () => {
	let release!: () => void;
	const operation = vi.fn(async () => new Promise<void>(resolve => { release = resolve; }));
	const scheduler = new DailyScheduler(db.prisma, 0, operation);
	scheduler.start(10);
	await vi.waitFor(() => expect(release).toBeDefined());
	let stopped = false;
	const stop = scheduler.stop().then(() => { stopped = true; });
	expect(stopped).toBe(false);
	release();
	await stop;
	expect(operation).toHaveBeenCalledOnce();
});
