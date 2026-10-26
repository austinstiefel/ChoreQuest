import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { disposableDatabase } from "../helpers/sqlite.js";
import { compareTimestamps, eventInRange } from "../../src/business/time.js";

const execute = promisify(execFile), server = fileURLToPath(new URL("../../", import.meta.url));
const databases: Awaited<ReturnType<typeof disposableDatabase>>[] = [];
afterEach(async () => { while (databases.length) await databases.pop()!.dispose(); });
async function database() { const db = await disposableDatabase(); databases.push(db); return db; }
async function snapshot(db: Awaited<ReturnType<typeof disposableDatabase>>, instant: string, tz: string) {
	const { stdout } = await execute(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../helpers/business-clock-worker.ts", import.meta.url)), `file:${db.databasePath.replaceAll("\\", "/")}?connection_limit=1`, instant, db.directory], { cwd: server, windowsHide: true, env: { ...process.env, TZ: tz }, timeout: 20000 });
	const result = JSON.parse(stdout);
	expect(result).toMatchObject({ vacationDate: result.today, staleStreak: 0, vacationStreak: 5, futureActive: false, currentActive: true, microsecondResponse: "2000-01-02T03:04:05.123456", microsecondStorage: "2000-01-02 03:04:05.123456", foreignKeys: [] });
	if (result.awarded !== null) expect(result.awarded).toBe(20);
	return result;
}
it("uses Python's local daily/Monday boundaries while reporting transaction dates in UTC", async () => {
	const db = await database();
	const sunday = await snapshot(db, "2026-11-02T05:59:59.000Z", "America/Chicago");
	expect(sunday).toMatchObject({ today: "2026-11-01", utcDay: "2026-11-02", offset: 360, week: "2026-10-26", weekEnd: "2026-11-01", weeklyXp: 0, spinAvailable: true, spinDates: ["2026-11-01"], recurrence: { weekly: false, fortnightly: false } });
	const monday = await snapshot(db, "2026-11-02T06:00:00.000Z", "America/Chicago");
	expect(monday).toMatchObject({ today: "2026-11-02", week: "2026-11-02", spinAvailable: true, spinDates: ["2026-11-01", "2026-11-02"], recurrence: { weekly: true, fortnightly: false } });
	expect(monday.weeklyXp).toBeGreaterThan(0); // UTC-Monday transactions now belong to the local current week
}, 30000);
it("does not reset spins, vacations or date arithmetic at a daylight-saving clock jump", async () => {
	const db = await database();
	const before = await snapshot(db, "2026-03-08T07:59:59.000Z", "America/Chicago");
	const after = await snapshot(db, "2026-03-08T08:00:00.000Z", "America/Chicago");
	expect(before).toMatchObject({ today: "2026-03-08", tomorrow: "2026-03-09", offset: 360, week: "2026-03-02", spinAvailable: true });
	expect(after).toMatchObject({ today: "2026-03-08", tomorrow: "2026-03-09", offset: 300, week: "2026-03-02", spinAvailable: false, spinDates: ["2026-03-08"] });
}, 30000);
it("handles a timezone ahead of UTC without moving date-only values to the previous UTC day", async () => {
	const result = await snapshot(await database(), "2026-11-01T15:00:00.000Z", "Asia/Tokyo");
	expect(result).toMatchObject({ today: "2026-11-02", utcDay: "2026-11-01", offset: -540, week: "2026-11-02", vacationDate: "2026-11-02", spinDates: ["2026-11-02"] });
}, 20000);
it("compares legacy and normalized timestamps with Python's microsecond and offset semantics", () => {
	expect(compareTimestamps("2030-01-01 00:00:00.123456", "2030-01-01T02:00:00.123456+02:00")).toBe(0);
	expect(compareTimestamps("2030-01-01T00:00:00.123456Z", "2030-01-01T00:00:00.123457Z")).toBe(-1);
	expect(compareTimestamps("2030-01-01T00:00:00.123Z", "2030-01-01T00:00:00.123000Z")).toBe(0);
	const now = new Date("2030-01-01T00:00:00.123Z");
	expect(eventInRange({ is_active: true, start_date: "2030-01-01 00:00:00.123001", end_date: "2030-01-02 00:00:00" }, now)).toBe(false);
});
