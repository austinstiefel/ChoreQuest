import { Prisma } from "@prisma/client";
import { BusinessError, day, addDays, monday, object, pick, userView, type Row, type Store } from "./store.js";
import { effectiveStreak, rank, petLevel, petXp } from "./gamification.js";
import { generateWeek } from "./scheduling.js";
import { int } from "./validation.js";
import type { BusinessRouter } from "./router.js";
import { pythonRound } from "./round.js";
const done = (a: Row) => ["completed", "verified"].includes(String(a.status));
const round = (n: number, p = 2) => pythonRound(n, p);
const achievementView = (a: Row) => ({ ...pick(a, "id key title description icon points_reward criteria tier group_key sort_order"), unlocked: false, unlocked_at: null });
const escapeXml = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
async function reportData(store: Store) {
	const [users, assignments, chores, vacations, unlocks, transactions] = await Promise.all([store.rows("users"), store.rows("chore_assignments"), store.rows("chores"), store.rows("vacation_periods"), store.rows("user_achievements"), store.rows("point_transactions")]);
	return { users, assignments, chores, vacations, unlocks, transactions };
}
function completion(assignments: Row[], uid: number, from: string) {
	const rows = assignments.filter(a => a.user_id === uid && String(a.date) >= from);
	const completed = rows.filter(done).length;
	return { total: rows.length, completed, rate: rows.length ? round(completed / rows.length * 100, 1) : 0 };
}
export function registerReports(api: BusinessRouter) {
	api.add({ method: "get", path: "/api/stats/kids", role: "authenticated", async run({ store }) { return (await store.rows("users", Prisma.sql `WHERE role = 'kid' AND is_active = 1`)).map(u => ({ id: u.id, display_name: u.display_name || u.username })); } });
	api.add({ method: "get", path: "/api/stats/me", role: "authenticated", async run({ store, user }) {
			const data = await reportData(store), account = data.users.find(u => u.id === user.id)!, config = object(account.avatar_config), interactions = object(config.pet_interactions), today = day();
			const pet = config.pet && config.pet !== "none" ? { ...petLevel(petXp(config)), type: config.pet } : null;
			return { ...pick(account, "points_balance total_points_earned longest_streak"), current_streak: effectiveStreak(account, data.vacations), achievements_count: data.unlocks.filter(u => u.user_id === user.id).length, completion_rate: completion(data.assignments, user.id, addDays(today, -30)).rate, rank: rank(Number(account.total_points_earned ?? 0)), pet, interactions_remaining: interactions.date === today ? Math.max(0, 3 - Number(interactions.count ?? 0)) : 3, streak_freeze_available: account.streak_freeze_month !== Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) };
		} });
	for (const detail of [false, true])
		api.add({ method: "get", path: detail ? "/api/stats/family/:kid_id" : "/api/stats/family", role: "parent", writes: true, async run({ store, id }) {
				const today = day();
				await generateWeek(store, monday(today));
				const data = await reportData(store), categories = await store.rows("chore_categories");
				const kids = data.users.filter(u => u.role === "kid" && u.is_active && (!detail || u.id === id("kid_id")));
				if (detail && !kids.length)
					throw new BusinessError(404, "Kid not found");
				const result = kids.map(k => {
					const assignments = data.assignments.filter(a => a.user_id === k.id && a.date === today && data.chores.some(c => c.id === a.chore_id && c.is_active));
					const kid = { ...pick(k, "id display_name avatar_config points_balance"), current_streak: effectiveStreak(k, data.vacations) };
					if (!detail)
						return { ...kid, today_completed: assignments.filter(done).length, today_total: assignments.length };
					return { kid, assignments: assignments.sort((a, b) => String(a.status).localeCompare(String(b.status)) || String(data.chores.find(c => c.id === a.chore_id)?.title).localeCompare(String(data.chores.find(c => c.id === b.chore_id)?.title))).map(a => {
							const c = data.chores.find(c => c.id === a.chore_id)!;
							return { ...pick(a, "id chore_id status completed_at verified_at photo_proof_path"), chore: { ...pick(c, "id title description points difficulty requires_photo recurrence"), category: categories.find(cat => cat.id === c.category_id)?.name ?? null } };
						}) };
				});
				return detail ? result[0] : result;
			} });
	api.add({ method: "get", path: "/api/stats/party", role: "authenticated", async run({ store }) {
			const data = await reportData(store), users = data.users.filter(u => u.is_active).sort((a, b) => String(a.role).localeCompare(String(b.role)) || String(a.display_name).localeCompare(String(b.display_name))), kids = users.filter(u => u.role === "kid"), today = day(), cutoff = addDays(today, -2);
			const name = new Map(users.map(u => [u.id, u.display_name || u.username]));
			const activity: Row[] = data.transactions.filter(t => Number(t.amount) > 0 && ["chore_complete", "achievement", "event_multiplier"].includes(String(t.type)) && String(t.created_at) >= cutoff).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 20).map(t => ({ type: "xp", user_id: t.user_id, user_name: name.get(t.user_id) ?? "Unknown", description: t.description, xp: t.amount, timestamp: t.created_at }));
			for (const n of (await store.rows("notifications", Prisma.sql `WHERE type = 'avatar_item_drop'`)).filter(n => String(n.created_at) >= cutoff).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 10))
				activity.push({ type: "avatar_drop", user_id: n.user_id, user_name: name.get(n.user_id) ?? "Unknown", description: n.message, timestamp: n.created_at });
			let family_streak = 0;
			if (kids.length)
				for (let i = 0; i < 60; i++) {
					if (!kids.every(k => data.assignments.some(a => a.user_id === k.id && a.date === addDays(today, -i) && done(a))))
						break;
					family_streak++;
				}
			return { members: users.map(u => {
					const config = object(u.avatar_config), assignments = data.assignments.filter(a => a.user_id === u.id && a.date === today && data.chores.some(c => c.id === a.chore_id && c.is_active));
					return { ...pick(u, "id role avatar_config total_points_earned"), display_name: u.display_name || u.username, current_streak: effectiveStreak(u, data.vacations), rank: rank(Number(u.total_points_earned ?? 0)), pet: config.pet && config.pet !== "none" ? petLevel(petXp(config)) : null, ...(u.role === "kid" ? { points_balance: u.points_balance, today_completed: assignments.filter(done).length, today_total: assignments.length } : {}) };
				}), activity: activity.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))).slice(0, 20), family_streak, family_total_xp: kids.reduce((n, k) => n + Number(k.total_points_earned), 0) };
		} });
	api.add({ method: "get", path: "/api/stats/leaderboard", role: "authenticated", async run({ store }) {
			const data = await reportData(store), start = monday(day()), end = addDays(start, 6), weekly = new Map<unknown, number>();
			for (const t of data.transactions)
				if (Number(t.amount) > 0 && String(t.created_at).slice(0, 10) >= start && String(t.created_at).slice(0, 10) <= end)
					weekly.set(t.user_id, (weekly.get(t.user_id) ?? 0) + Number(t.amount));
			const kids = data.users.filter(u => u.role === "kid" && u.is_active).sort((a, b) => (weekly.get(b.id) ?? 0) - (weekly.get(a.id) ?? 0));
			return kids.map((k, i) => ({ rank: i + 1, ...pick(k, "id display_name avatar_config"), weekly_xp: weekly.get(k.id) ?? 0, total_xp: k.total_points_earned ?? 0, quests_completed: data.assignments.filter(a => a.user_id === k.id && String(a.date) >= start && String(a.date) <= end && done(a)).length, current_streak: effectiveStreak(k, data.vacations) }));
		} });
	api.add({ method: "get", path: "/api/stats/achievements/all", role: "authenticated", async run({ store, user }) {
			const unlocks = new Map((await store.rows("user_achievements", Prisma.sql `WHERE user_id = ${user.id}`)).map(a => [a.achievement_id, a.unlocked_at]));
			return (await store.rows("achievements", Prisma.sql `ORDER BY sort_order`)).map(a => ({ ...achievementView(a), unlocked: unlocks.has(a.id), unlocked_at: unlocks.get(a.id) ?? null }));
		} });
	api.add({ method: "put", path: "/api/stats/achievements/:achievement_id", role: "parent", rules: { points_reward: int(0) }, async run({ store, id, body }) {
			const a = await store.one("achievements", id("achievement_id"), "Achievement");
			await store.update("achievements", Number(a.id), body);
			return { ...achievementView({ ...a, ...body }), tier: null, group_key: null };
		} });
	api.add({ method: "get", path: "/api/stats/achievements/:achievement_id/badge", role: "authenticated", contentType: "image/svg+xml", async run({ store, user, id }) {
			const a = await store.one("achievements", id("achievement_id"), "Achievement"), unlock = (await store.rows("user_achievements", Prisma.sql `WHERE user_id = ${user.id} AND achievement_id = ${a.id}`))[0];
			if (!unlock)
				throw new BusinessError(403, "Achievement not yet unlocked");
			const colors: Record<string, string[]> = { bronze: ["#cd7f32", "#8b5e23"], silver: ["#c0c0c0", "#808080"], gold: ["#ffd700", "#b8860b"] }, tier = String(a.tier ?? "bronze"), [fg, border] = colors[tier] ?? colors.bronze;
			const date = new Date(String(unlock.unlocked_at)).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
			return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200"><defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#1a1a2e"/><stop offset="100%" stop-color="#16213e"/></linearGradient></defs><rect width="400" height="200" rx="16" fill="url(#bg)" stroke="${border}" stroke-width="3"/><circle cx="70" cy="100" r="40" fill="none" stroke="${fg}" stroke-width="3"/><text x="70" y="108" text-anchor="middle" font-size="28" fill="${fg}">★</text><text x="140" y="70" font-family="sans-serif" font-size="11" fill="${fg}" font-weight="bold" letter-spacing="2">${escapeXml(tier.toUpperCase())}</text><text x="140" y="100" font-family="sans-serif" font-size="20" fill="#ecf0f1" font-weight="bold">${escapeXml(a.title)}</text><text x="140" y="125" font-family="sans-serif" font-size="12" fill="#95a5a6">${escapeXml(a.description)}</text><text x="140" y="155" font-family="sans-serif" font-size="11" fill="#7f8c8d">+${a.points_reward} XP</text><text x="140" y="175" font-family="sans-serif" font-size="10" fill="#5d6d7e">${escapeXml(user.display_name)} · ${date}</text><text x="370" y="185" text-anchor="end" font-family="sans-serif" font-size="9" fill="#34495e">ChoreQuest</text></svg>`;
		} });
	for (const history of [false, true])
		api.add({ method: "get", path: history ? "/api/stats/history/:user_id" : "/api/stats/:user_id", role: history ? "authenticated" : "parent", async run({ store, user, id }) {
				const uid = id("user_id");
				if (history && user.role === "kid" && uid !== user.id)
					throw new BusinessError(403, "Kids can only view their own history");
				const target = await store.one("users", uid, "User"), assignments = await store.rows("chore_assignments", Prisma.sql `WHERE user_id = ${uid}`), seven = completion(assignments, uid, addDays(day(), -7)), thirty = completion(assignments, uid, addDays(day(), -30));
				return { ...(history ? { user_id: uid } : { user: userView(target), achievements_count: (await store.rows("user_achievements", Prisma.sql `WHERE user_id = ${uid}`)).length, completion_rate_30d: thirty.rate }), last_7_days: pick(seven, "completed total"), last_30_days: pick(thirty, "completed total") };
			} });
	api.add({ method: "get", path: "/api/progress", role: "authenticated", async run({ store, user }) {
			const data = await reportData(store), uids = new Set(user.role === "kid" ? [user.id] : data.users.filter(u => u.role === "kid" && u.is_active).map(u => Number(u.id)));
			if (!uids.size)
				return { days: [], summary: {} };
			const days = Array.from({ length: 30 }, (_, i) => {
				const date = addDays(day(), i - 29), assignments = data.assignments.filter(a => uids.has(Number(a.user_id)) && a.date === date), completed = assignments.filter(done).length;
				return { date, xp: data.transactions.filter(t => uids.has(Number(t.user_id)) && Number(t.amount) > 0 && String(t.created_at).slice(0, 10) === date).reduce((n, t) => n + Number(t.amount), 0), completed, total: assignments.length, rate: assignments.length ? round(completed / assignments.length) : 0 };
			});
			const xp = days.reduce((n, d) => n + d.xp, 0), completed = days.reduce((n, d) => n + d.completed, 0), total = days.reduce((n, d) => n + d.total, 0);
			return { days, summary: { total_xp: xp, total_completed: completed, total_assigned: total, avg_daily_xp: round(xp / 30, 1), completion_rate: total ? round(completed / total) : 0 } };
		} });
}
