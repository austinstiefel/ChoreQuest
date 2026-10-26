import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { resolve } from "node:path";
import { createApp } from "../../src/app.js";
import { createBusinessRouter } from "../../src/business/index.js";
import { UploadStorage } from "../../src/business/uploads.js";
import { Store, day, addDays, monday } from "../../src/business/store.js";
import { effectiveStreak } from "../../src/business/gamification.js";
import { occurs } from "../../src/business/scheduling.js";
import { newUserData } from "../../src/auth/accounts.js";
import { createAccessToken } from "../../src/auth/tokens.js";

// A separate process makes TZ and native local-date behavior deterministic,
// without changing the test runner, real clock or the developer's environment.
const [url, instant, directory] = process.argv.slice(2);
if (!url?.includes("chorequest-auth-") || !instant || !directory) throw new Error("Disposable clock fixture arguments required");
const originalDate = Date, fixed = new originalDate(instant).getTime();
globalThis.Date = new Proxy(originalDate, {
	construct(target, args) { return Reflect.construct(target, args.length ? args : [fixed]); },
	get(target, key) { return key === "now" ? () => fixed : Reflect.get(target, key); },
});
const config = { secretKey: "business-clock-test-fixture-only", accessTokenExpireMinutes: 15, refreshTokenExpireDays: 30, cookieSecure: false, corsOrigins: [] };
const prisma = new PrismaClient({ datasources: { db: { url } } });
try {
	const store = await Store.open(prisma);
	if (!await prisma.users.count()) {
		for (const role of ["admin", "kid"]) await prisma.users.create({ data: newUserData({ username: role, displayName: role, role, passwordHash: "test-only" }) });
		const category = await store.insert("chore_categories", { name: "Clock", icon: "clock", colour: "#123456", is_default: false });
		const chore = await store.insert("chores", { title: "Clock chore", description: null, points: 10, difficulty: "easy", icon: null, category_id: category.id, recurrence: "daily", custom_days: null, requires_photo: false, is_active: true, created_by: 1, created_at: "2026-03-02 00:30:00.123456" });
		await store.insert("chore_assignment_rules", { chore_id: chore.id, user_id: 2, recurrence: "daily", custom_days: null, requires_photo: false, is_active: true });
		await store.insert("rewards", { title: "Microsecond history", description: null, point_cost: 2, icon: null, category: null, stock: null, auto_approve_threshold: null, is_active: true, created_by: 1, created_at: "2000-01-02 03:04:05.123456" });
		await store.insert("point_transactions", { user_id: 2, amount: 4, type: "bonus", description: "UTC reporting boundary", reference_id: null, created_by: 1 });
	}
	const api = await createBusinessRouter(prisma, config, new UploadStorage(resolve(directory, "uploads"))), app = createApp(undefined, config, undefined, api.router);
	const admin = `Bearer ${await createAccessToken(1, "admin", config)}`, kid = `Bearer ${await createAccessToken(2, "kid", config)}`;
	async function http(method: "get" | "post" | "put" | "delete", path: string, auth = kid, body?: object, status = 200) {
		const response = await request(app)[method](path).set("Authorization", auth).send(body);
		if (response.status !== status) throw new Error(`Clock fixture failed: ${method} ${path} (${response.status})`);
		return response.body;
	}
	const today = day(), yesterday = addDays(today, -1), offset = new Date().getTimezoneOffset();
	const leaderboard = await http("get", "/api/stats/leaderboard");
	const calendar = await http("get", "/api/calendar");
	const vacation = await http("post", "/api/vacation", admin, { start_date: today, end_date: today }, 201);
	await http("delete", `/api/vacation/${vacation.id}`, admin, undefined, 204);
	const stale = { current_streak: 5, last_streak_date: addDays(today, -2) };
	const staleStreak = effectiveStreak(stale, []), vacationStreak = effectiveStreak(stale, [{ start_date: yesterday, end_date: yesterday, is_active: true }]);
	for (const a of await store.rows("chore_assignments")) if (a.date === today && a.status === "pending") await store.update("chore_assignments", Number(a.id), { status: "completed", completed_at: new Date() });
	const available = await http("get", "/api/spin/availability");
	if (available.can_spin) await http("post", "/api/spin/spin");
	const base = new Date().toISOString().replace(/\.\d{3}Z$/, ".000000Z");
	const nextMicrosecond = base.replace(".000000Z", ".000001Z");
	const end = new Date(fixed + 1000).toISOString();
	// Both representations describe the same instant; neither ordering may
	// accidentally create a zero-duration event based on lexical precision.
	for (const [start_date, end_date] of [[base, new Date().toISOString()], [new Date().toISOString(), base]]) await http("post", "/api/events", admin, { title: "Equal instants", multiplier: 2, start_date, end_date }, 400);
	const future = await http("post", "/api/events", admin, { title: "Future microsecond", multiplier: 5, start_date: nextMicrosecond, end_date: end }, 201);
	const current = await store.insert("seasonal_events", { title: "Inclusive current boundary", description: null, multiplier: 2, start_date: new Date(fixed - 1000), end_date: base, is_active: true, created_by: 1 });
	const events = await http("get", "/api/events");
	const assignment = (await store.rows("chore_assignments")).find(a => a.date === today && a.status === "completed");
	let awarded: number | null = null;
	if (assignment) {
		// Expire events from earlier fixture instants so only this boundary
		// pair participates, without changing the clock or starting any jobs.
		for (const e of await store.rows("seasonal_events")) if (e.id !== current.id && e.id !== future.id) await store.update("seasonal_events", Number(e.id), { is_active: false });
		await http("post", "/api/chores/1/verify", admin);
		awarded = (await store.rows("point_transactions")).filter(t => t.reference_id === assignment.id && ["chore_complete", "event_multiplier"].includes(String(t.type))).reduce((n, t) => n + Number(t.amount), 0);
	}
	const reward = await http("get", "/api/rewards/1");
	await http("put", "/api/rewards/1", admin, { description: "Non-date edit" });
	const [raw] = await prisma.$queryRaw<Array<{ created_at: string }>>`SELECT CAST(created_at AS TEXT) AS created_at FROM rewards WHERE id = 1`;
	console.log(JSON.stringify({ today, utcDay: day(new Date()), offset, week: calendar.week_start, weekEnd: calendar.week_end, tomorrow: addDays(today, 1), vacationDate: vacation.start_date, staleStreak, vacationStreak, weeklyXp: leaderboard[0].weekly_xp, spinAvailable: available.can_spin, spinDates: (await store.rows("spin_results")).map(s => s.spin_date), recurrence: { weekly: occurs("weekly", today, "2026-03-02T00:30:00.123456Z", null), fortnightly: occurs("fortnightly", today, "2026-03-02T00:30:00.123456Z", null) }, futureActive: future.is_active, currentActive: events.find((e: { id: number }) => e.id === current.id).is_active, awarded, microsecondResponse: reward.created_at, microsecondStorage: raw.created_at, foreignKeys: await prisma.$queryRaw`PRAGMA foreign_key_check` }));
} finally {
	await prisma.$disconnect();
}
