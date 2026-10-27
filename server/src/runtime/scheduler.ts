import { Prisma, type PrismaClient } from "@prisma/client";
import { Store, write, day, daysBetween, type Row } from "../business/store.js";
import { createAssignment, occurs } from "../business/scheduling.js";
import { effectiveStreak, vacationOn } from "../business/gamification.js";
import { compareTimestamps } from "../business/time.js";
import { putState, getState, RUNTIME_PREFIX } from "./state.js";
export function resetHour(env: NodeJS.ProcessEnv = process.env): number {
	const value = env.DAILY_RESET_HOUR ?? "0";
	if (!/^\d+$/.test(value) || Number(value) > 23)
		throw new Error("DAILY_RESET_HOUR must be an integer from 0 through 23 (UTC)");
	return Number(value);
}
export function dailySlot(now: Date, hour: number): string {
	const target = new Date(now);
	target.setUTCHours(hour, 0, 0, 0);
	if (target > now)
		target.setUTCDate(target.getUTCDate() - 1);
	return target.toISOString();
}
export function localDay(now: Date): string {
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
/** Python generate_daily_assignments: UTC-calendar cadence advancement once on
 * an occurrence day, per-kid rules with legacy fallback, no backfilled rewards.
 * Preserve explicit exclusions rather than resurrecting removed assignments. */
export async function generateDaily(store: Store, today: string, now: Date): Promise<void> {
	const vacations = await store.rows("vacation_periods");
	if (vacationOn(vacations, today))
		return;
	const [chores, rules, rotations, assignments, exclusions] = await Promise.all([
		store.rows("chores", Prisma.sql `WHERE is_active=1`), store.rows("chore_assignment_rules", Prisma.sql `WHERE is_active=1`), store.rows("chore_rotations"), store.rows("chore_assignments"), store.rows("chore_exclusions"),
	]);
	for (const chore of chores) {
		const own = rules.filter(r => r.chore_id === chore.id), rotation = rotations.find(r => r.chore_id === chore.id);
		let active = own.filter(r => r.recurrence !== "once" && occurs(String(r.recurrence), today, String(chore.created_at), r.custom_days));
		if (!own.length && chore.recurrence !== "once" && occurs(String(chore.recurrence), today, String(chore.created_at), chore.custom_days)) {
			const users = rotation && Array.isArray(rotation.kid_ids) && rotation.kid_ids.length ? rotation.kid_ids : [...new Set(assignments.filter(a => a.chore_id === chore.id).map(a => a.user_id))];
			active = users.map(user_id => ({ user_id }));
		}
		if (!active.length)
			continue;
		if (rotation) {
			const ids = rotation.kid_ids as number[];
			if (!ids.length)
				throw new Error("Invalid empty daily rotation");
			const thresholds: Record<string, number> = { daily: 1, weekly: 7, fortnightly: 14, monthly: 30 };
			if (!rotation.last_rotated || daysBetween(String(rotation.last_rotated).slice(0, 10), day(now)) >= (thresholds[String(rotation.cadence)] ?? 7)) {
				rotation.current_index = (Number(rotation.current_index) + 1) % ids.length;
				await store.update("chore_rotations", Number(rotation.id), { current_index: rotation.current_index, last_rotated: now });
			}
			active = active.filter(r => Number(r.user_id) === Number(ids[Number(rotation.current_index)]));
		}
		for (const rule of active) {
			if (exclusions.some(e => e.chore_id === chore.id && e.user_id === rule.user_id && e.date === today))
				continue;
			await createAssignment(store, Number(chore.id), Number(rule.user_id), today);
		}
	}
}
export async function maintainDaily(store: Store, today: string, now: Date): Promise<void> {
	await generateDaily(store, today, now);
	const vacations = await store.rows("vacation_periods");
	for (const kid of await store.rows("users", Prisma.sql `WHERE role='kid' AND is_active=1 AND current_streak>0`))
		if (effectiveStreak(kid, vacations, today) === 0)
			await store.update("users", Number(kid.id), { current_streak: 0 });
	const tokens = await store.db.$queryRaw<Array<{
		id: number;
		expires_at: string;
	}>> `SELECT id,CAST(expires_at AS TEXT) AS expires_at FROM refresh_tokens`;
	for (const token of tokens)
		if (compareTimestamps(token.expires_at, now) < 0)
			await store.db.$executeRaw `DELETE FROM refresh_tokens WHERE id=${token.id}`;
}
export class DailyScheduler {
	private readonly key = `${RUNTIME_PREFIX}daily`;
	private timer?: NodeJS.Timeout;
	private pending?: Promise<boolean>;
	private stopping = false;
	constructor(private readonly prisma: PrismaClient, readonly hour: number, private readonly operation = maintainDaily) {
		if (!Number.isInteger(hour) || hour < 0 || hour > 23)
			throw new Error("Invalid UTC daily reset hour");
	}
	/** The SQLite writer reservation and checkpoint are one transaction: separate
	 * Node processes cannot both execute a slot. Rollback also rolls back the
	 * checkpoint, so failed runs retry. Restart reconciles TODAY once, not a
	 * guessed historical calendar/award replay that Python never performed. */
	async run(now = new Date(), reconcile = false): Promise<boolean> {
		const store = await Store.open(this.prisma), slot = dailySlot(now, this.hour);
		return write(this.prisma, store, async (tx) => {
			const today = localDay(now), previous = await getState<{
				slot: string;
				today?: string;
			}>(tx.db, this.key);
			if (previous && (previous.slot > slot || previous.slot === slot && (!reconcile || previous.today !== undefined && previous.today >= today)))
				return false;
			await this.operation(tx, today, now);
			await putState(tx.db, this.key, { slot, today });
			return true;
		});
	}
	start(intervalMs = 30000): void {
		const tick = () => { if (this.stopping || this.pending)
			return; this.pending = this.run().catch(() => { console.warn("Daily maintenance failed; transaction rolled back and will retry"); return false; }).finally(() => { this.pending = undefined; }); };
		tick();
		this.timer = setInterval(tick, intervalMs);
		this.timer.unref();
	}
	async stop(): Promise<void> { this.stopping = true; clearInterval(this.timer); await this.pending; }
}
