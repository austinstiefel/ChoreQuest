import { Prisma } from "@prisma/client";
import { addDays, day, weekday, daysBetween, pick, userView, type Row, type Store } from "./store.js";
import { vacationOn } from "./gamification.js";
export const choreFields = "id title description points difficulty icon category_id recurrence custom_days requires_photo is_active created_by created_at";
export const ruleFields = "id chore_id user_id recurrence custom_days requires_photo is_active";
export const rotationView = (r: Row) => pick(r, "id chore_id kid_ids cadence current_index last_rotated created_at");
export const choreProjection = (chore: Row, category: Row) => ({ ...pick(chore, choreFields), category: pick(category, "id name icon colour is_default") });
export const assignmentProjection = (row: Row, chore: Row, category: Row, user: Row) => ({ ...pick(row, "id chore_id user_id date status completed_at verified_at verified_by photo_proof_path feedback"), chore: choreProjection(chore, category), user: userView(user) });
export function occurs(recurrence: string, date: string, created: string, custom: unknown): boolean {
	const wd = weekday(created.slice(0, 10));
	switch (recurrence) {
		case "once":
		case "daily": return true;
		case "weekly": return weekday(date) === wd;
		case "fortnightly": return weekday(date) === wd && Math.floor(daysBetween(created.slice(0, 10), date) / 7) % 2 === 0;
		case "custom": return Array.isArray(custom) && custom.includes(weekday(date));
		default: return false;
	}
}
export function rotationKid(rotation: Row, date: string, reference: string, weekdays: number[] | null): number {
	const ids = rotation.kid_ids as number[];
	let offset = 0;
	if (rotation.cadence === "daily") {
		if (!weekdays)
			offset = daysBetween(reference, date);
		else {
			const forward = date >= reference, start = forward ? reference : date, end = forward ? date : reference;
			const span = daysBetween(start, end), weeks = Math.floor(span / 7);
			offset = weeks * new Set(weekdays).size;
			for (let i = 1; i <= span % 7; i++)
				if (weekdays.includes(weekday(addDays(start, i))))
					offset++;
			if (!forward)
				offset = -offset;
		}
	}
	return Number(ids[((Number(rotation.current_index) + offset) % ids.length + ids.length) % ids.length]);
}
export function activeWeekdays(rules: Row[], chore: Row): number[] | null {
	const days = new Set<number>();
	for (const r of rules) {
		if (r.recurrence === "daily")
			return null;
		if (r.recurrence === "custom" && Array.isArray(r.custom_days))
			r.custom_days.forEach(d => days.add(Number(d)));
		if (["weekly", "fortnightly"].includes(String(r.recurrence)))
			days.add(weekday(String(chore.created_at).slice(0, 10)));
	}
	return days.size ? [...days].sort() : null;
}
export async function createAssignment(store: Store, chore: number, user: number, date: string): Promise<Row> {
	const existing = (await store.rows("chore_assignments", Prisma.sql `WHERE chore_id = ${chore} AND user_id = ${user}`)).find(a => a.date === date);
	return existing ?? store.insert("chore_assignments", { chore_id: chore, user_id: user, date, status: "pending", completed_at: null, verified_at: null, verified_by: null, photo_proof_path: null, feedback: null });
}
/** Batch-load schedules; week projection never advances persisted rotations. */
export async function generateWeek(store: Store, start: string) {
	const [chores, rules, rotations, exclusions, assignments, vacations] = await Promise.all([
		store.rows("chores", Prisma.sql `WHERE is_active = 1`), store.rows("chore_assignment_rules", Prisma.sql `WHERE is_active = 1`), store.rows("chore_rotations"), store.rows("chore_exclusions"), store.rows("chore_assignments"), store.rows("vacation_periods"),
	]);
	const slots = new Set(assignments.map(a => `${a.chore_id}:${a.user_id}:${a.date}`));
	const excluded = new Set(exclusions.map(a => `${a.chore_id}:${a.user_id}:${a.date}`));
	for (const chore of chores) {
		const own = rules.filter(r => r.chore_id === chore.id), rotation = rotations.find(r => r.chore_id === chore.id);
		const legacyIds = rotation && Array.isArray(rotation.kid_ids) && rotation.kid_ids.length ? rotation.kid_ids : [...new Set(assignments.filter(a => a.chore_id === chore.id).map(a => a.user_id))];
		const sources: Row[] = own.length ? own : legacyIds.map(uid => ({ ...chore, user_id: uid }));
		for (let i = 0; i < 7; i++) {
			const date = addDays(start, i);
			if (vacationOn(vacations, date))
				continue;
			for (const rule of sources) {
				if (rule.recurrence === "once" || !occurs(String(rule.recurrence), date, String(chore.created_at), rule.custom_days))
					continue;
				if (own.length && rotation && Array.isArray(rotation.kid_ids) && rotation.kid_ids.length) {
					const expected = rotationKid(rotation, date, String(rotation.last_rotated ?? day()).slice(0, 10), activeWeekdays(own, chore));
					if (Number(rule.user_id) !== expected) {
						for (const a of assignments.filter(a => a.chore_id === chore.id && a.user_id === rule.user_id && a.date === date && a.status === "pending"))
							await store.remove("chore_assignments", Number(a.id));
						continue;
					}
				}
				const key = `${chore.id}:${rule.user_id}:${date}`;
				if (slots.has(key) || excluded.has(key))
					continue;
				await createAssignment(store, Number(chore.id), Number(rule.user_id), date);
				slots.add(key);
			}
		}
	}
}
export async function choreView(store: Store, chore: Row): Promise<Row> {
	return choreProjection(chore, await store.one("chore_categories", Number(chore.category_id), "Category"));
}
export async function assignmentView(store: Store, row: Row): Promise<Row & {
	chore: Row;
	user: Row;
}> {
	return { ...pick(row, "id chore_id user_id date status completed_at verified_at verified_by photo_proof_path feedback"), chore: await choreView(store, await store.one("chores", Number(row.chore_id), "Chore")), user: userView(await store.one("users", Number(row.user_id), "User")) };
}
