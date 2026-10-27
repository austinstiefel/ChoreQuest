import { Prisma } from "@prisma/client";
import { BusinessError, day, monday, addDays, pick, object, type Row, type Store } from "./store.js";
import { achievements, advanceStreak, award, notify, points, questDrop, petXp, setPetXp } from "./gamification.js";
import { activeWeekdays, assignmentView, assignmentProjection, choreView, choreProjection, createAssignment, occurs, rotationKid, rotationView, ruleFields } from "./scheduling.js";
import { cadence, difficulty, ids, int, optional, recurrence, str, type Rules } from "./validation.js";
import type { BusinessRouter } from "./router.js";
import type { UploadStorage } from "./uploads.js";
import { eventInRange } from "./time.js";
async function activeChore(store: Store, id: number) {
	const r = await store.one("chores", id, "Chore");
	if (!r.is_active)
		throw new BusinessError(404, "Chore not found");
	return r;
}
async function assignedNotice(store: Store, chore: Row, uid: number) { await notify(store, uid, "chore_assigned", "New Quest Assigned!", `You've been given a new quest: '${chore.title}' (+${chore.points} XP)`, "chore", Number(chore.id)); }
export function registerChores(api: BusinessRouter, uploads: UploadStorage) {
	const categoryFields: Rules = { name: str(50), icon: str(50), colour: str(7) };
	const fields: Rules = { title: str(200), description: optional(str()), points: int(0), difficulty, icon: optional(str()), category_id: int(), recurrence, custom_days: optional(ids), requires_photo: { type: "bool", default: false }, assigned_user_ids: { ...ids, default: [] } };
	api.add({ method: "get", path: "/api/chores/categories", role: "authenticated", async run({ store }) { return (await store.rows("chore_categories")).map(c => pick(c, "id name icon colour is_default")); } });
	api.add({ method: "post", path: "/api/chores/categories", role: "parent", status: 201, rules: categoryFields, async run({ store, body }) { return pick(await store.insert("chore_categories", { ...body, is_default: false }), "id name icon colour is_default"); } });
	api.add({ method: "put", path: "/api/chores/categories/:category_id", role: "parent", rules: categoryFields, async run({ store, body, id }) { const r = await store.one("chore_categories", id("category_id"), "Category"); await store.update("chore_categories", Number(r.id), body); return pick({ ...r, ...body }, "id name icon colour is_default"); } });
	api.add({ method: "delete", path: "/api/chores/categories/:category_id", role: "parent", status: 204, async run({ store, id }) {
			const r = await store.one("chore_categories", id("category_id"), "Category");
			if (r.is_default)
				throw new BusinessError(400, "Cannot delete a default category");
			if ((await store.rows("chores", Prisma.sql `WHERE category_id = ${r.id} LIMIT 1`)).length)
				throw new BusinessError(400, "Cannot delete a category used by a chore");
			await store.remove("chore_categories", Number(r.id));
		} });
	api.add({ method: "get", path: "/api/chores/templates", role: "authenticated", async run({ store }) { return store.rows("quest_templates"); } });
	api.add({ method: "get", path: "/api/chores", role: "authenticated", async run({ store, user, query }) {
			const q = query({ view: optional(str()) }), chores = await store.rows("chores", Prisma.sql `WHERE is_active = 1`), rules = await store.rows("chore_assignment_rules", Prisma.sql `WHERE is_active = 1`);
			const assigned = new Set((await store.rows("chore_assignments", Prisma.sql `WHERE user_id = ${user.id}`)).map(a => a.chore_id));
			const categories = new Map((await store.rows("chore_categories")).map(c => [c.id, c]));
			const results = [];
			for (const c of chores) {
				const own = rules.filter(r => r.chore_id === c.id);
				if (user.role === "kid" && !assigned.has(c.id))
					continue;
				if (user.role !== "kid" && q.view === "active" && !own.length)
					continue;
				const view: Row = choreProjection(c, categories.get(c.category_id)!);
				if (user.role !== "kid")
					view.assignment_count = own.length;
				else {
					const rule = own.find(r => r.user_id === user.id);
					if (rule)
						view.requires_photo = rule.requires_photo;
				}
				results.push(view);
			}
			return results;
		} });
	api.add({ method: "post", path: "/api/chores", role: "parent", status: 201, rules: fields, async run({ store, user, body }) {
			await store.one("chore_categories", Number(body.category_id), "Category");
			const { assigned_user_ids, ...values } = body;
			const c = await store.insert("chores", { description: null, icon: null, custom_days: null, ...values, is_active: true, created_by: user.id });
			for (const uid of [...new Set(assigned_user_ids as number[])]) {
				await store.one("users", uid, "User");
				await createAssignment(store, Number(c.id), uid, day());
				await assignedNotice(store, c, uid);
			}
			return choreView(store, c);
		} });
	api.add({ method: "post", path: "/api/chores/cleanup-all-stale", role: "parent", async run({ store }) {
			const pending = await store.db.$executeRaw `DELETE FROM chore_assignments WHERE status = 'pending'`, exclusions = await store.db.$executeRaw `DELETE FROM chore_exclusions`;
			return { message: `Cleaned up ${pending} pending assignments and ${exclusions} exclusions`, pending_removed: pending, exclusions_removed: exclusions };
		} });
	api.add({ method: "get", path: "/api/chores/:chore_id", role: "authenticated", async run({ store, id, user }) {
		const chore = await activeChore(store, id("chore_id"));
		const today=day(),scope=Prisma.sql`chore_id=${chore.id} ${user.role === "kid" ? Prisma.sql`AND user_id=${user.id}` : Prisma.empty}`;
		const date=Prisma.sql`CASE WHEN typeof(date) IN ('integer','real') THEN date(date/1000.0,'unixepoch') ELSE substr(date,1,10) END`;
		// Future calendar projections must not push today's actionable records
		// out of a history limit. Include ALL today's children, plus bounded past
		// history; preserve private ownership for kid callers and legacy dates.
		const rows=[...await store.rows("chore_assignments",Prisma.sql`WHERE ${scope} AND ${date}=${today} ORDER BY id DESC`),...await store.rows("chore_assignments",Prisma.sql`WHERE ${scope} AND ${date}<${today} ORDER BY ${date} DESC,id DESC LIMIT 50`)];
		const userIds=[...new Set(rows.map(a=>a.user_id))];
		const users=new Map((await store.rows("users",Prisma.sql`WHERE id IN (${Prisma.join(userIds.length?userIds:[-1])})`)).map(u=>[u.id,u]));
		const category=await store.one("chore_categories",Number(chore.category_id),"Category");
		const rule=user.role==="kid"?(await store.rows("chore_assignment_rules",Prisma.sql`WHERE chore_id=${chore.id} AND user_id=${user.id} AND is_active=1`))[0]:undefined;
		return { ...choreProjection(chore,category), ...(rule?{requires_photo:rule.requires_photo}:{}), server_today: today, assignments: rows.map(row=>assignmentProjection(row,chore,category,users.get(row.user_id)!)) };
	} });
	api.add({ method: "put", path: "/api/chores/:chore_id", role: "parent", rules: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, optional({ ...v, max:undefined, default: undefined })])), async run({ store, body, id }) {
			const c = await activeChore(store, id("chore_id")), { assigned_user_ids, ...values } = body;
			for (const key of ["title", "points", "difficulty", "category_id", "recurrence", "requires_photo"])
				if (values[key] === null)
					throw new BusinessError(400, `${key} cannot be null`);
			if (values.category_id !== undefined)
				await store.one("chore_categories", Number(values.category_id), "Category");
			if (values.points !== undefined && Number(values.points) <= 0)
				throw new BusinessError(400, "points must be positive");
			await store.update("chores", Number(c.id), values);
			if (Array.isArray(assigned_user_ids)) {
				for (const uid of new Set(assigned_user_ids as number[])) {
					await store.one("users", uid, "User");
					const old = await store.rows("chore_assignments", Prisma.sql `WHERE chore_id = ${c.id} AND user_id = ${uid}`);
					if (!old.some(a => a.date === day())) {
						await createAssignment(store, Number(c.id), uid, day());
						await assignedNotice(store, { ...c, ...values }, uid);
					}
				}
				for (const a of await store.rows("chore_assignments", Prisma.sql `WHERE chore_id = ${c.id} AND status = 'pending'`))
					if (a.date === day() && !assigned_user_ids.includes(a.user_id))
						await store.remove("chore_assignments", Number(a.id));
			}
			return choreView(store, { ...c, ...values });
		} });
	api.add({ method: "delete", path: "/api/chores/:chore_id", role: "parent", status: 204, async run({ store, id }) { const c = await activeChore(store, id("chore_id")); await store.update("chores", Number(c.id), { is_active: false }); } });
	api.add({ method: "get", path: "/api/chores/:chore_id/rules", role: "parent", async run({ store, id }) {
			const users = new Map((await store.rows("users")).map(u => [u.id, u]));
			return (await store.rows("chore_assignment_rules", Prisma.sql `WHERE chore_id = ${id("chore_id")}`)).map(r => ({ ...pick(r, ruleFields), user: users.get(r.user_id) ? pick(users.get(r.user_id)!, "id username display_name role points_balance total_points_earned current_streak longest_streak streak_freezes_used streak_freeze_month avatar_config is_active created_at") : null }));
		} });
	api.add({ method: "get", path: "/api/chores/:chore_id/rotation", role: "parent", async run({ store, id }) { const r = (await store.rows("chore_rotations", Prisma.sql `WHERE chore_id = ${id("chore_id")}`))[0]; return r ? rotationView(r) : null; } });
	const ruleItem: Rules = { user_id: int(), recurrence, custom_days: optional(ids), requires_photo: { type: "bool", default: false } };
	api.add({ method: "post", path: "/api/chores/:chore_id/assign", role: "parent", status: 201, rules: { assignments: { type: "list", item: { type: "dict", fields: ruleItem } }, rotation: optional({ type: "dict", fields: { enabled: { type: "bool", default: false }, cadence: { ...cadence, default: "weekly" } } }) }, async run({ store, body, id }) {
			const c = await activeChore(store, id("chore_id")), items = body.assignments as Row[], userIds = items.map(i => Number(i.user_id)), today = day();
			if (new Set(userIds).size !== userIds.length)
				throw new BusinessError(400, "Duplicate assignment user");
			for (const uid of userIds)
				await store.one("users", uid, "User");
			const old = await store.rows("chore_assignment_rules", Prisma.sql `WHERE chore_id = ${c.id}`);
			for (const r of old)
				if (!userIds.includes(Number(r.user_id))) {
					await store.update("chore_assignment_rules", Number(r.id), { is_active: false });
					for (const a of await store.rows("chore_assignments", Prisma.sql `WHERE chore_id = ${c.id} AND user_id = ${r.user_id} AND status = 'pending'`))
						if (String(a.date) >= today)
							await store.remove("chore_assignments", Number(a.id));
				}
			const rotation = object(body.rotation), oldRotation = (await store.rows("chore_rotations", Prisma.sql `WHERE chore_id = ${c.id}`))[0];
			let rot: Row | undefined;
			if (rotation.enabled && items.length >= 2) {
				const values = { kid_ids: userIds, cadence: rotation.cadence, current_index: 0, last_rotated: new Date() };
				if (oldRotation) {
					await store.update("chore_rotations", Number(oldRotation.id), values);
					rot = { ...oldRotation, ...values, last_rotated: new Date().toISOString() };
				}
				else
					rot = await store.insert("chore_rotations", { chore_id: c.id, ...values });
				for (const a of await store.rows("chore_assignments", Prisma.sql `WHERE chore_id = ${c.id} AND status = 'pending'`))
					if (String(a.date) >= today && Number(a.user_id) !== rotationKid(rot, String(a.date), today, activeWeekdays(items, c)))
						await store.remove("chore_assignments", Number(a.id));
				for (const e of await store.rows("chore_exclusions", Prisma.sql `WHERE chore_id = ${c.id}`))
					if (String(e.date) >= today)
						await store.remove("chore_exclusions", Number(e.id));
			}
			else if (oldRotation)
				await store.remove("chore_rotations", Number(oldRotation.id));
			for (const item of items) {
				const existing = old.find(r => r.user_id === item.user_id), values = { custom_days: null, ...item, is_active: true };
				if (existing)
					await store.update("chore_assignment_rules", Number(existing.id), values);
				else
					await store.insert("chore_assignment_rules", { chore_id: c.id, ...values });
				if (occurs(String(item.recurrence), today, String(c.created_at), item.custom_days) && (!rot || item.user_id === userIds[0])) {
					// Preserve completed/verified history instead of reopening an already
					// rewarded slot, which allowed double XP in the reference endpoint.
					await createAssignment(store, Number(c.id), Number(item.user_id), today);
				}
				await assignedNotice(store, c, Number(item.user_id));
			}
			await store.update("chores", Number(c.id), { recurrence: items[0]?.recurrence ?? "once", custom_days: items[0]?.custom_days ?? null });
			return { message: items.length ? `Quest assigned to ${items.length} hero(es)` : "All heroes unassigned from this quest" };
		} });
	api.add({ method: "put", path: "/api/chores/rules/:rule_id", role: "parent", rules: { recurrence: optional(recurrence), custom_days: optional(ids), requires_photo: optional({ type: "bool" }), is_active: optional({ type: "bool" }) }, async run({ store, body, id }) {
			const r = await store.one("chore_assignment_rules", id("rule_id"), "Assignment rule");
			for (const k of ["recurrence", "requires_photo", "is_active"])
				if (body[k] === null)
					throw new BusinessError(400, `${k} cannot be null`);
			await store.update("chore_assignment_rules", Number(r.id), body);
			return { ...pick({ ...r, ...body }, ruleFields), user: pick(await store.one("users", Number(r.user_id), "User"), "id username display_name role points_balance total_points_earned current_streak longest_streak streak_freezes_used streak_freeze_month avatar_config is_active created_at") };
		} });
	api.add({ method: "delete", path: "/api/chores/rules/:rule_id", role: "parent", status: 204, async run({ store, id }) { const r = await store.one("chore_assignment_rules", id("rule_id"), "Assignment rule"); await store.update("chore_assignment_rules", Number(r.id), { is_active: false }); } });
	api.add({ method: "get", path: "/api/chores/:chore_id/debug", role: "parent", async run({ store, id }) {
			const c = await store.one("chores", id("chore_id"), "Chore"), start = monday(day()), end = addDays(start, 6), rot = (await store.rows("chore_rotations", Prisma.sql `WHERE chore_id = ${c.id}`))[0];
			return { chore: pick(c, "id title is_active recurrence"), rotation: rot ? { ...pick(rot, "id kid_ids cadence current_index last_rotated"), kid_ids_types: (rot.kid_ids as number[]).map(() => "int") } : null, rules: (await store.rows("chore_assignment_rules", Prisma.sql `WHERE chore_id = ${c.id}`)).map(r => pick(r, "id user_id recurrence is_active")), assignments_this_week: (await store.rows("chore_assignments", Prisma.sql `WHERE chore_id = ${c.id}`)).filter(a => String(a.date) >= start && String(a.date) <= end).sort((a, b) => String(a.date).localeCompare(String(b.date))).map(a => pick(a, "id user_id date status")), exclusions_this_week: (await store.rows("chore_exclusions", Prisma.sql `WHERE chore_id = ${c.id}`)).filter(a => String(a.date) >= start && String(a.date) <= end).map(a => pick(a, "chore_id user_id date")), server_today: day(), week_start: start };
		} });
	for (const action of ["complete", "verify", "uncomplete", "skip"] as const)
		for (const targeted of action === "complete" ? [false] : [false,true])
		api.add({ method: "post", path: targeted ? `/api/chores/assignments/:assignment_id/${action}` : `/api/chores/:chore_id/${action}`, role: action === "complete" ? "authenticated" : "parent", multipart: action === "complete", async run({ store, user, id, query, file, onRollback }) {
				const selected = targeted ? id("assignment_id") : query({assignment_id:optional(int(0))}).assignment_id;
				const assignment = targeted ? await store.one("chore_assignments",Number(selected),"Assignment") : null;
				const cid = assignment ? Number(assignment.chore_id) : id("chore_id"), rows = (await store.rows("chore_assignments", Prisma.sql `WHERE chore_id = ${cid}`)).filter(a => a.date === day() && (selected == null || a.id === Number(selected)) && (action !== "complete" || a.user_id === user.id));
				const allowed = action === "complete" || action === "skip" ? ["pending"] : action === "verify" ? ["completed"] : ["completed", "verified"];
				const candidates = rows.filter(a => allowed.includes(String(a.status)));
				if (!candidates.length)
					throw new BusinessError(404, action === "complete" ? "No pending assignment found for this chore today" : action === "verify" ? "No completed assignment found to verify for this chore today" : action === "skip" ? "No pending assignment found to skip for this chore today" : "No completed assignment found to undo for this chore today");
				// The legacy path has no target-user parameter. Fail explicitly rather
				// than approve an arbitrary child when several are eligible.
				if (candidates.length > 1)
					throw new BusinessError(409, "Multiple assignments match this chore; select an unambiguous assignment");
				const a = candidates[0], c = await store.one("chores", cid, "Chore"), target = await store.one("users", Number(a.user_id), "User");
				if (action === "complete") {
					const rule = (await store.rows("chore_assignment_rules", Prisma.sql `WHERE chore_id = ${cid} AND user_id = ${user.id} AND is_active = 1`))[0];
					if ((rule?.requires_photo ?? c.requires_photo) && (!file || file.size === 0))
						throw new BusinessError(400, "Photo proof is required for this quest. Please attach a photo.");
					let photo: string | undefined;
					if (file && file.size > 0) {
						photo = await uploads.save(file);
						const name = photo;
					onRollback(() => uploads.discard(name));
					}
					await store.update("chore_assignments", Number(a.id), { status: "completed", completed_at: new Date(), ...(photo ? { photo_proof_path: photo } : {}) });
					for (const p of await store.rows("users", Prisma.sql `WHERE role IN ('parent','admin') AND is_active = 1`))
						await notify(store, Number(p.id), "chore_completed", "Quest Awaiting Approval", `${target.display_name} completed '${c.title}' - tap to approve (+${c.points} XP)`, "chore_assignment", Number(a.id));
				}
				else if (action === "skip")
					await store.update("chore_assignments", Number(a.id), { status: "skipped" });
				else if (action === "verify") {
					const now = new Date();
					const events = (await store.rows("seasonal_events", Prisma.sql `WHERE is_active = 1`)).filter(e => eventInRange(e, now));
					const multiplier = events.reduce((m, e) => m * Number(e.multiplier), 1), base = Number(c.points), bonus = Math.max(0, Math.trunc(base * multiplier) - base);
					if(!Number.isSafeInteger(base)||base<=0)throw new BusinessError(400,"Chore points are invalid; update the chore before verification");
					await store.update("chore_assignments", Number(a.id), { status: "verified", verified_at: new Date(), verified_by: user.id });
					await points(store, Number(target.id), base, "chore_complete", `Completed: ${c.title}`, Number(a.id));
					if (bonus > 0)
						await points(store, Number(target.id), bonus, "event_multiplier", `Event bonus (${events.map(e => e.title).join(", ")}): ${c.title}`, Number(a.id));
					const levelup = await award(store, target, base + bonus);
					if (levelup)
						await notify(store, Number(target.id), "pet_levelup", "Pet Leveled Up!", `Your pet reached level ${levelup.new_level} — ${levelup.name}!`, "pet");
					await advanceStreak(store, target);
					await achievements(store, target);
					if (c.recurrence === "once")
						for (const r of await store.rows("chore_assignment_rules", Prisma.sql `WHERE chore_id = ${cid} AND user_id = ${target.id} AND is_active = 1`))
							await store.update("chore_assignment_rules", Number(r.id), { is_active: false });
					await notify(store, Number(target.id), "chore_verified", "Quest Approved!", `'${c.title}' was approved! You earned ${base + bonus} XP!`, "chore_assignment", Number(a.id));
					await questDrop(store, Number(target.id), String(c.difficulty));
				}
				else {
					const txs = await store.rows("point_transactions", Prisma.sql `WHERE user_id = ${target.id} AND reference_id = ${a.id} AND type IN ('chore_complete','event_multiplier')`), total = txs.reduce((n, t) => n + Number(t.amount), 0);
					const config = object(target.avatar_config);
					if (total > 0 && config.pet && config.pet !== "none")
						await store.update("users", Number(target.id), { avatar_config: setPetXp(config, Math.max(0, petXp(config) - total)) });
					await store.update("users", Number(target.id), { points_balance: Math.max(0, Number(target.points_balance) - total) });
					for (const tx of txs)
						await store.remove("point_transactions", Number(tx.id));
					await store.update("chore_assignments", Number(a.id), { status: "pending", completed_at: null, verified_at: null, verified_by: null });
				}
				return assignmentView(store, await store.one("chore_assignments", Number(a.id), "Assignment"));
			} });
	api.add({ method: "post", path: "/api/chores/assignments/:assignment_id/feedback", role: "parent", rules: { feedback: str(500) }, async run({ store, user, id, body }) {
			const a = await store.one("chore_assignments", id("assignment_id"), "Assignment"), c = await store.one("chores", Number(a.chore_id), "Chore");
			await store.update("chore_assignments", Number(a.id), { feedback: body.feedback });
			await notify(store, Number(a.user_id), "quest_feedback", "Quest Feedback", `${user.display_name} left feedback on "${c.title}": ${body.feedback}`, "chore_assignment", Number(a.id));
			return assignmentView(store, { ...a, feedback: body.feedback });
		} });
}
