import { Prisma } from "@prisma/client";
import { BusinessError, day, addDays, daysBetween, object, type Row, type Store } from "./store.js";
import { pythonRound } from "./round.js";
export async function notify(store: Store, userId: number, type: string, title: string, message: string, reference_type: string | null = null, reference_id: number | null = null) {
	return store.insert("notifications", { user_id: userId, type, title, message, reference_type, reference_id, is_read: false });
}
export async function points(store: Store, userId: number, amount: number, type: string, description: string, reference_id: number | null = null, created_by: number | null = null) {
	if (!Number.isSafeInteger(amount))
		throw new BusinessError(400, "Point amount exceeds the supported integer range");
	return store.insert("point_transactions", { user_id: userId, amount, type, description, reference_id, created_by });
}
const petTiers = [[0, "Hatchling"], [50, "Youngling"], [150, "Companion"], [350, "Loyal"], [700, "Brave"], [1200, "Mighty"], [2000, "Majestic"], [3500, "Legendary"]] as const;
const rankTiers = [[0, "Apprentice"], [100, "Scout"], [500, "Adventurer"], [1500, "Knight"], [3000, "Champion"], [6000, "Hero"], [10000, "Legend"], [20000, "Mythic"]] as const;
const rounded = (n: number, places = 3) => pythonRound(n, places);
export function petLevel(xp: number) {
	let i = 0;
	while (i + 1 < petTiers.length && xp >= petTiers[i + 1][0])
		i++;
	const [threshold, name] = petTiers[i], next = petTiers[i + 1];
	return { level: i + 1, name, xp, xp_threshold: threshold, next_threshold: next?.[0] ?? null, progress: next ? rounded((xp - threshold) / (next[0] - threshold)) : 1 };
}
export function rank(xp: number) {
	let i = 0;
	while (i + 1 < rankTiers.length && xp >= rankTiers[i + 1][0])
		i++;
	const [threshold, title] = rankTiers[i], next = rankTiers[i + 1];
	return { title, key: title.toLowerCase(), xp_threshold: threshold, next_title: next?.[1] ?? null, next_threshold: next?.[0] ?? null, progress: next ? rounded((xp - threshold) / (next[0] - threshold)) : 1 };
}
export function petXp(config: Row): number { return Number(object(config.pet_xp_map)[String(config.pet)] ?? config.pet_xp ?? 0); }
export function setPetXp(config: Row, xp: number): Row {
	const pet = String(config.pet ?? "none");
	const map = { ...object(config.pet_xp_map) };
	if (!config.pet_xp_map && Number(config.pet_xp) > 0 && pet !== "none")
		map[pet] = config.pet_xp;
	if (pet !== "none") {
		map[pet] = xp;
		config.pet_xp = xp;
	}
	config.pet_xp_map = map;
	return config;
}
export async function awardPet(store: Store, user: Row, amount: number): Promise<Row | null> {
	const config = { ...object(user.avatar_config) };
	if (!config.pet || config.pet === "none" || amount <= 0)
		return null;
	const old = petLevel(petXp(config)), next = petLevel(petXp(config) + amount);
	setPetXp(config, next.xp);
	user.avatar_config = config;
	await store.update("users", Number(user.id), { avatar_config: config });
	return next.level > old.level ? { old_level: old.level, new_level: next.level, name: next.name, pet: config.pet } : null;
}
export async function award(store: Store, user: Row, amount: number): Promise<Row | null> {
	if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(Number(user.points_balance) + amount) || !Number.isSafeInteger(Number(user.total_points_earned) + Math.max(0, amount)))
		throw new BusinessError(400, "Point amount exceeds the supported integer range");
	user.points_balance = Number(user.points_balance) + amount;
	user.total_points_earned = Number(user.total_points_earned) + Math.max(0, amount);
	await store.update("users", Number(user.id), { points_balance: user.points_balance, total_points_earned: user.total_points_earned });
	return awardPet(store, user, amount);
}
export const vacationOn = (vacations: Row[], date: string) => vacations.some(v => v.is_active && String(v.start_date) <= date && String(v.end_date) >= date);
export function effectiveStreak(user: Row, vacations: Row[], today = day()): number {
	if (Number(user.current_streak) <= 0 || !user.last_streak_date)
		return 0;
	const last = String(user.last_streak_date);
	for (let d = addDays(last, 1); d < today; d = addDays(d, 1))
		if (!vacationOn(vacations, d))
			return 0;
	return Number(user.current_streak);
}
export async function advanceStreak(store: Store, user: Row, today = day()) {
	if (user.last_streak_date === today)
		return;
	const vacations = await store.rows("vacation_periods");
	const last = user.last_streak_date ? String(user.last_streak_date) : null;
	const gap = last ? daysBetween(last, today) : 0;
	let keep = gap === 1;
	if (gap > 1 && last) {
		keep = true;
		for (let d = addDays(last, 1); d < today; d = addDays(d, 1))
			if (!vacationOn(vacations, d)) {
				keep = false;
				break;
			}
		const month = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7));
		if (!keep && Number(user.current_streak) > 0 && user.streak_freeze_month !== month) {
			keep = true;
			user.streak_freezes_used = Number(user.streak_freezes_used ?? 0) + 1;
			user.streak_freeze_month = month;
		}
	}
	user.current_streak = keep ? Number(user.current_streak) + 1 : 1;
	user.longest_streak = Math.max(Number(user.longest_streak), Number(user.current_streak));
	user.last_streak_date = today;
	await store.update("users", Number(user.id), { current_streak: user.current_streak, longest_streak: user.longest_streak, last_streak_date: today, streak_freezes_used: user.streak_freezes_used, streak_freeze_month: user.streak_freeze_month });
	if ([7, 30, 100].includes(Number(user.current_streak)))
		await notify(store, Number(user.id), "streak_milestone", `${user.current_streak}-Day Streak!`, `You've completed quests ${user.current_streak} days in a row! Keep it up!`, "streak");
}
/** Evaluate the same criteria in catalogue order, including awards earned
 * earlier in this pass. Caller owns the single encompassing transaction. */
export async function achievements(store: Store, user: Row, today = day()) {
	const all = await store.rows("achievements");
	const owned = new Set((await store.rows("user_achievements", Prisma.sql `WHERE user_id = ${user.id}`)).map(a => a.achievement_id));
	const assignments = await store.rows("chore_assignments", Prisma.sql `WHERE user_id = ${user.id}`);
	const completed = assignments.filter(a => ["completed", "verified"].includes(String(a.status)));
	const daily = assignments.filter(a => a.date === today && a.status !== "skipped");
	const redemptions = await store.rows("reward_redemptions", Prisma.sql `WHERE user_id = ${user.id} AND status = 'approved'`);
	for (const a of all) {
		if (owned.has(a.id))
			continue;
		const c = object(a.criteria);
		const checks: Record<string, () => boolean> = {
			total_completions: () => completed.length >= Number(c.count),
			consecutive_days_all_complete: () => Number(user.current_streak) >= Number(c.days),
			total_points_earned: () => Number(user.total_points_earned) >= Number(c.amount),
			completion_before_time: () => completed.some(a => a.completed_at && new Date(String(a.completed_at)).getUTCHours() < Number(c.hour)),
			streak_reached: () => Number(user.current_streak) >= Number(c.days),
			total_redemptions: () => redemptions.length >= Number(c.count),
			all_daily_before_time: () => daily.length > 0 && daily.every(a => a.status !== "pending" && (!a.completed_at || new Date(String(a.completed_at)).getUTCHours() < Number(c.hour))),
			all_daily_completed: () => daily.length > 0 && daily.every(a => ["completed", "verified"].includes(String(a.status))),
			pet_level_reached: () => Boolean(object(user.avatar_config).pet && object(user.avatar_config).pet !== "none" && petLevel(petXp(object(user.avatar_config))).level >= Number(c.level)),
		};
		if (!checks[String(c.type)]?.())
			continue;
		await store.insert("user_achievements", { user_id: user.id, achievement_id: a.id, unlocked_at: new Date() });
		if (Number(a.points_reward) > 0) {
			await award(store, user, Number(a.points_reward));
			await points(store, Number(user.id), Number(a.points_reward), "achievement", `Achievement unlocked: ${a.title}`, Number(a.id));
		}
		await notify(store, Number(user.id), "achievement_unlocked", "Achievement Unlocked!", `You earned '${a.title}' — +${a.points_reward} XP!`, "achievement", Number(a.id));
	}
}
export async function questDrop(store: Store, userId: number, difficulty: string, random: () => number = Math.random) {
	const rates: Record<string, number> = { easy: .05, medium: .1, hard: .15, expert: .2 };
	if (random() > (rates[difficulty] ?? .1))
		return;
	const owned = new Set((await store.rows("user_avatar_items", Prisma.sql `WHERE user_id = ${userId}`)).map(i => i.avatar_item_id));
	const candidates = (await store.rows("avatar_items", Prisma.sql `WHERE unlock_method = 'quest_drop'`)).filter(i => !owned.has(i.id));
	if (!candidates.length)
		return;
	const item = candidates[Math.floor(random() * candidates.length)];
	await store.insert("user_avatar_items", { user_id: userId, avatar_item_id: item.id, acquired_via: "drop" });
	await notify(store, userId, "avatar_item_drop", "Quest Drop!", `You found a ${item.rarity} item: ${item.display_name}!`, "avatar_item", Number(item.id));
}
