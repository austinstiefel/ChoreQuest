import { Prisma } from "@prisma/client";
import { BusinessError, day, monday, addDays, weekday, type Row } from "./store.js";
import { notify } from "./gamification.js";
import { assignmentProjection, generateWeek, rotationView } from "./scheduling.js";
import { cadence, ids, int, optional } from "./validation.js";
import type { BusinessRouter } from "./router.js";
export function registerCalendar(api: BusinessRouter) {
	api.add({ method: "get", path: "/api/calendar", role: "authenticated", writes: true, async run({ store, query }) {
			const q = query({ week_start: optional({ type: "date" }) }), start = String(q.week_start ?? monday(day())), end = addDays(start, 6);
			if (weekday(start) !== 0)
				throw new BusinessError(400, "week_start must be a Monday");
			await generateWeek(store, start);
			const days: Record<string, Row[]> = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [addDays(start, i), []]));
			const chores = new Map((await store.rows("chores", Prisma.sql `WHERE is_active = 1`)).map(c => [c.id, c]));
			const users = new Map((await store.rows("users")).map(u => [u.id, u]));
			const categories = new Map((await store.rows("chore_categories")).map(c => [c.id, c]));
			const rules = await store.rows("chore_assignment_rules", Prisma.sql `WHERE is_active = 1`);
			for (const a of await store.rows("chore_assignments", Prisma.sql `ORDER BY date, id`)) {
				if (!days[String(a.date)] || !chores.has(a.chore_id))
					continue;
				const chore = chores.get(a.chore_id)!;
				const view: Row & {
					chore: Row;
					user: Row;
				} = assignmentProjection(a, chore, categories.get(chore.category_id)!, users.get(a.user_id)!), rule = rules.find(r => r.chore_id === a.chore_id && r.user_id === a.user_id), photo = rule?.requires_photo ?? chore.requires_photo;
				delete view.feedback;
				const user = view.user;
				delete user.streak_freezes_used;
				delete user.streak_freeze_month;
				days[String(a.date)].push({ ...view, requires_photo: photo, chore: { ...view.chore, requires_photo: photo } });
			}
			return { week_start: start, week_end: end, days };
		} });
	api.add({ method: "post", path: "/api/calendar/trade", role: "authenticated", rules: { assignment_id: int(), target_user_id: int() }, async run({ store, user, body }) {
			const a = await store.one("chore_assignments", Number(body.assignment_id), "Assignment");
			if (a.user_id !== user.id)
				throw new BusinessError(403, "You can only trade your own assignments");
			if (a.status !== "pending")
				throw new BusinessError(400, "Can only trade pending assignments");
			const target = (await store.rows("users", Prisma.sql `WHERE id = ${body.target_user_id} AND role = 'kid' AND is_active = 1`))[0];
			if (!target)
				throw new BusinessError(404, "Target user not found or not a kid");
			if (target.id === user.id)
				throw new BusinessError(400, "Cannot trade with yourself");
			const c = await store.one("chores", Number(a.chore_id), "Chore"), n = await notify(store, Number(target.id), "trade_proposed", "Chore Trade Proposed", `${user.display_name} wants to trade '${c.title}' with you.`, "trade", Number(a.id));
			return { message: "Trade proposed", notification_id: n.id };
		} });
	for (const action of ["accept", "deny"])
		api.add({ method: "post", path: `/api/calendar/trade/:notification_id/${action}`, role: "authenticated", async run({ store, user, id }) {
				const n = (await store.rows("notifications", Prisma.sql `WHERE id = ${id("notification_id")} AND user_id = ${user.id} AND type = 'trade_proposed' AND reference_type = 'trade'`))[0];
				if (!n)
					throw new BusinessError(404, "Trade notification not found");
				const a = await store.one("chore_assignments", Number(n.reference_id), "Assignment"), c = await store.one("chores", Number(a.chore_id), "Chore");
				if (a.status !== "pending")
					throw new BusinessError(400, "Assignment is no longer pending");
				if (action === "accept") {
					const conflict = (await store.rows("chore_assignments", Prisma.sql `WHERE chore_id = ${a.chore_id} AND user_id = ${user.id}`)).some(r => r.date === a.date);
					if (conflict)
						throw new BusinessError(409, "You already have this chore assigned on that date");
					await store.update("chore_assignments", Number(a.id), { user_id: user.id });
					// Resolve competing proposals for this slot so a stale recipient cannot
					// take it again from the new owner. is_read alone is not a decision.
					await store.db.$executeRaw `UPDATE notifications SET reference_type = 'trade_resolved', is_read = 1 WHERE reference_type = 'trade' AND type = 'trade_proposed' AND reference_id = ${a.id}`;
				}
				await store.update("notifications", Number(n.id), { is_read: true, reference_type: "trade_resolved" });
				await notify(store, Number(a.user_id), action === "accept" ? "trade_accepted" : "trade_denied", action === "accept" ? "Trade Accepted" : "Trade Denied", `${user.display_name} ${action === "accept" ? "accepted" : "denied"} your trade for '${c.title}'.`, "trade", Number(a.id));
				return { message: action === "accept" ? "Trade accepted" : "Trade denied", assignment_id: a.id };
			} });
	api.add({ method: "delete", path: "/api/calendar/assignments/:assignment_id", role: "parent", status: 204, async run({ store, id, query }) {
			const a = await store.one("chore_assignments", id("assignment_id"), "Assignment"), c = await store.one("chores", Number(a.chore_id), "Chore"), q = query({ all_future: { type: "bool", default: false } });
			if (a.status !== "pending")
				throw new BusinessError(400, "Only pending assignments can be removed");
			const rows = q.all_future ? (await store.rows("chore_assignments", Prisma.sql `WHERE chore_id = ${a.chore_id} AND user_id = ${a.user_id} AND status = 'pending'`)).filter(r => String(r.date) >= String(a.date)) : [a];
			for (const row of rows) {
				if (c.recurrence !== "once") {
					const exists = (await store.rows("chore_exclusions", Prisma.sql `WHERE chore_id = ${a.chore_id} AND user_id = ${a.user_id}`)).some(e => e.date === row.date);
					if (!exists)
						await store.insert("chore_exclusions", { chore_id: a.chore_id, user_id: a.user_id, date: row.date });
				}
				await store.remove("chore_assignments", Number(row.id));
			}
		} });
	api.add({ method: "get", path: "/api/rotations", role: "parent", async run({ store }) { return (await store.rows("chore_rotations", Prisma.sql `ORDER BY id`)).map(rotationView); } });
	api.add({ method: "post", path: "/api/rotations", role: "parent", status: 201, rules: { chore_id: int(), kid_ids: ids, cadence }, async run({ store, body }) {
			if (!(body.kid_ids as unknown[]).length)
				throw new BusinessError(400, "kid_ids must not be empty");
			await store.one("chores", Number(body.chore_id), "Chore");
			for (const uid of body.kid_ids as number[])
				await store.one("users", uid, "User");
			if ((await store.rows("chore_rotations", Prisma.sql `WHERE chore_id = ${body.chore_id}`)).length)
				throw new BusinessError(409, "A rotation already exists for this chore");
			return rotationView(await store.insert("chore_rotations", { ...body, current_index: 0, last_rotated: null }));
		} });
	api.add({ method: "put", path: "/api/rotations/:rotation_id", role: "parent", rules: { kid_ids: optional(ids), cadence: optional(cadence) }, async run({ store, body, id }) {
			const r = await store.one("chore_rotations", id("rotation_id"), "Rotation"), values = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null));
			if (values.kid_ids) {
				const list = values.kid_ids as number[];
				if (!list.length)
					throw new BusinessError(400, "kid_ids must not be empty");
				for (const uid of list)
					await store.one("users", uid, "User");
				if (Number(r.current_index) >= list.length)
					values.current_index = 0;
			}
			await store.update("chore_rotations", Number(r.id), values);
			return rotationView({ ...r, ...values });
		} });
	api.add({ method: "delete", path: "/api/rotations/:rotation_id", role: "parent", async run({ store, id }) { const r = await store.one("chore_rotations", id("rotation_id"), "Rotation"); await store.remove("chore_rotations", Number(r.id)); return { detail: "Rotation deleted" }; } });
	api.add({ method: "post", path: "/api/rotations/:rotation_id/advance", role: "parent", async run({ store, id }) {
			const r = await store.one("chore_rotations", id("rotation_id"), "Rotation"), list = r.kid_ids as number[];
			if (!list.length)
				throw new BusinessError(400, "Rotation has no kids to advance through");
			const values = { current_index: (Number(r.current_index) + 1) % list.length, last_rotated: new Date().toISOString() };
			await store.update("chore_rotations", Number(r.id), values);
			return rotationView({ ...r, ...values });
		} });
}
