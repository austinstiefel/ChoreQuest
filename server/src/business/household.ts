import { Prisma } from "@prisma/client";
import { BusinessError, day, pick, userView, object, type Row, type Store } from "./store.js";
import { achievements, award, notify, points } from "./gamification.js";
import { newReward, rewardView } from "./rewards.js";
import { int, str, optional, type Rules } from "./validation.js";
import type { BusinessRouter } from "./router.js";
import { sqliteTimestamp, createdAtOrder } from "../db/legacySqlite.js";
import { compareTimestamps, eventInRange } from "./time.js";
const privateSettings = new Set(["initial_setup_complete", "initial_password_setup_required", "vapid_private_key", "vapid_public_key"]);
const timeSort = (rows: Row[]) => rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
const wishView = (r: Row) => ({ ...pick(r, "id user_id title url image_url notes converted_to_reward_id created_at"), user_display_name: null });
const eventView = (r: Row) => ({ ...r, is_active: eventInRange(r) });
async function names(store: Store) { return new Map((await store.rows("users")).map(u => [u.id, u.display_name || u.username])); }
export function registerHousehold(api: BusinessRouter) {
	api.add({ method: "get", path: "/api/admin/settings/features", role: "authenticated", async run({ store }) {
			const result: Row = { leaderboard_enabled: "true", spin_wheel_enabled: "true", chore_trading_enabled: "true" };
			for (const s of await store.rows("app_settings"))
				if (s.key && Object.hasOwn(result, String(s.key)))
					result[String(s.key)] = s.value;
			return result;
		} });
	api.add({ method: "get", path: "/api/admin/settings", role: "parent", async run({ store }) { return Object.fromEntries((await store.rows("app_settings")).filter(s => !privateSettings.has(String(s.key))).map(s => [s.key, s.value])); } });
	api.add({ method: "put", path: "/api/admin/settings", role: "parent", rules: { settings: { type: "dict" } }, async run({ store, body }) {
			for (const [key, value] of Object.entries(object(body.settings))) {
				if (typeof value !== "string")
					throw new BusinessError(422, [{ type: "string_type", loc: ["body", "settings", key], msg: "Input should be a valid string" }]);
				// Setup flags are authentication state, not parent-editable preferences.
				if (privateSettings.has(key))
					throw new BusinessError(400, "Authentication and push key state cannot be changed through settings");
				await store.db.$executeRaw `INSERT INTO app_settings (key, value, updated_at) VALUES (${key}, ${value}, ${sqliteTimestamp()}) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;
			}
			return { detail: "Settings updated" };
		} });
	api.add({ method: "get", path: "/api/notifications", role: "authenticated", async run({ store, user, query }) {
			const q = query({ unread_only: { type: "bool", default: false }, limit: { type: "int", min: 1, max: 100, default: 20 }, offset: { type: "int", min: 0, default: 0 } });
			return store.rows("notifications", Prisma.sql `WHERE user_id = ${user.id} ${q.unread_only ? Prisma.sql `AND is_read = 0` : Prisma.empty} ORDER BY ${createdAtOrder} DESC LIMIT ${q.limit} OFFSET ${q.offset}`);
		} });
	api.add({ method: "get", path: "/api/notifications/unread-count", role: "authenticated", async run({ store, user }) {
			const [row] = await store.db.$queryRaw<Array<{
				count: bigint;
			}>> `SELECT COUNT(*) AS count FROM notifications WHERE user_id = ${user.id} AND is_read = 0`;
			return { count: Number(row.count) };
		} });
	api.add({ method: "post", path: "/api/notifications/read-all", role: "authenticated", async run({ store, user }) { await store.db.$executeRaw `UPDATE notifications SET is_read = 1 WHERE user_id = ${user.id}`; return { detail: "All notifications marked as read" }; } });
	api.add({ method: "post", path: "/api/notifications/:notification_id/read", role: "authenticated", async run({ store, user, id }) {
			const row = await store.one("notifications", id("notification_id"), "Notification");
			if (row.user_id !== user.id)
				throw new BusinessError(403, "Not your notification");
			await store.update("notifications", Number(row.id), { is_read: true });
			return { ...row, is_read: true };
		} });
	const wishFields: Rules = { title: str(200), url: optional(str()), image_url: optional(str()), notes: optional(str()) };
	api.add({ method: "get", path: "/api/wishlist", role: "authenticated", async run({ store, user }) {
			const map = await names(store);
			return timeSort(await store.rows("wishlist_items", user.role === "kid" ? Prisma.sql `WHERE user_id = ${user.id}` : Prisma.empty)).map(r => ({ ...wishView(r), user_display_name: map.get(r.user_id) ?? null }));
		} });
	api.add({ method: "post", path: "/api/wishlist", role: "authenticated", status: 201, rules: wishFields, async run({ store, user, body }) { return wishView(await store.insert("wishlist_items", { user_id: user.id, url: null, image_url: null, notes: null, converted_to_reward_id: null, ...body })); } });
	api.add({ method: "put", path: "/api/wishlist/:item_id", role: "authenticated", rules: Object.fromEntries(Object.entries(wishFields).map(([k, v]) => [k, optional({...v,max:undefined})])), async run({ store, user, body, id }) {
			const item = await store.one("wishlist_items", id("item_id"), "Wishlist item");
			if (item.user_id !== user.id)
				throw new BusinessError(403, "You can only update your own wishlist items");
			const values = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null));
			await store.update("wishlist_items", Number(item.id), values);
			return wishView({ ...item, ...values });
		} });
	api.add({ method: "delete", path: "/api/wishlist/:item_id", role: "authenticated", async run({ store, user, id }) {
			const item = await store.one("wishlist_items", id("item_id"), "Wishlist item");
			if (item.user_id !== user.id && user.role === "kid")
				throw new BusinessError(403, "Not authorized to delete this item");
			await store.remove("wishlist_items", Number(item.id));
			return { detail: "Wishlist item deleted" };
		} });
	api.add({ method: "post", path: "/api/wishlist/:item_id/convert", role: "parent", rules: { point_cost: int(0) }, async run({ store, user, body, id }) {
			const item = await store.one("wishlist_items", id("item_id"), "Wishlist item");
			if (item.converted_to_reward_id !== null)
				throw new BusinessError(400, "Item has already been converted to a reward");
			const reward = await newReward(store, { title: item.title, description: item.notes, point_cost: body.point_cost, stock: 1 }, user.id);
			await store.remove("wishlist_items", Number(item.id));
			return rewardView(reward);
		} });
	api.add({ method: "get", path: "/api/announcements", role: "authenticated", async run({ store }) {
			const map = await names(store);
			return (await store.rows("announcements", Prisma.sql `ORDER BY is_pinned DESC, ${createdAtOrder} DESC LIMIT 50`)).map(r => ({ ...r, creator_name: map.get(r.created_by) ?? null }));
		} });
	api.add({ method: "post", path: "/api/announcements", role: "parent", rules: { title: str(200), message: str(1000), icon: optional(str()), is_pinned: { type: "bool", default: false } }, async run({ store, user, body }) {
			const row = await store.insert("announcements", { icon: null, ...body, created_by: user.id });
			for (const kid of await store.rows("users", Prisma.sql `WHERE role = 'kid' AND is_active = 1`))
				await notify(store, Number(kid.id), "announcement", String(row.title), String(row.message), "announcement");
			return { ...row, creator_name: user.display_name };
		} });
	api.add({ method: "delete", path: "/api/announcements/:announcement_id", role: "parent", async run({ store, id }) { const row = await store.one("announcements", id("announcement_id"), "Announcement"); await store.remove("announcements", Number(row.id)); return { ok: true }; } });
	api.add({ method: "get", path: "/api/shoutouts", role: "authenticated", async run({ store }) {
			const map = await names(store), cutoff = Date.now() - 7 * 86400000;
			return (await store.rows("shoutouts", Prisma.sql `WHERE ${createdAtOrder} >= ${cutoff} ORDER BY ${createdAtOrder} DESC LIMIT 50`)).map(r => ({ ...r, from_user_name: map.get(r.from_user_id) ?? null, to_user_name: map.get(r.to_user_id) ?? null }));
		} });
	api.add({ method: "post", path: "/api/shoutouts", role: "authenticated", status: 201, rules: { to_user_id: int(), message: str(200), emoji: { ...str(10), default: "star" } }, async run({ store, user, body }) {
			if (body.to_user_id === user.id)
				throw new BusinessError(400, "Cannot shoutout yourself");
			const target = await store.one("users", Number(body.to_user_id), "User");
			if (!target.is_active)
				throw new BusinessError(404, "User not found");
			const sent = await store.rows("shoutouts", Prisma.sql `WHERE from_user_id = ${user.id}`);
			if (sent.filter(s => String(s.created_at).slice(0, 10) >= day(new Date())).length >= 5)
				throw new BusinessError(429, "Max 5 shoutouts per day");
			const row = await store.insert("shoutouts", { ...body, from_user_id: user.id });
			await notify(store, Number(target.id), "shoutout", "Shoutout!", `${user.display_name} gave you a shoutout: ${body.message}`, "shoutout");
			return { ...row, from_user_name: user.display_name || user.username, to_user_name: target.display_name || target.username };
		} });
	const eventFields: Rules = { title: str(200), description: optional(str()), multiplier: { type: "float", gt: 1 }, start_date: { type: "datetime" }, end_date: { type: "datetime" } };
	api.add({ method: "get", path: "/api/events", role: "authenticated", async run({ store }) { return (await store.rows("seasonal_events")).sort((a, b) => String(b.start_date).localeCompare(String(a.start_date))).map(eventView); } });
	api.add({ method: "post", path: "/api/events", role: "parent", status: 201, rules: eventFields, async run({ store, user, body }) {
			if (compareTimestamps(String(body.end_date), String(body.start_date)) <= 0)
				throw new BusinessError(400, "end_date must be after start_date");
			const row = await store.insert("seasonal_events", { description: null, ...body, is_active: true, created_by: user.id });
			for (const kid of await store.rows("users", Prisma.sql `WHERE role = 'kid' AND is_active = 1`))
				await notify(store, Number(kid.id), "bonus_points", "Bonus Event Started!", `'${row.title}' is live — earn ${Math.trunc((Number(row.multiplier) - 1) * 100)}% bonus XP on all quests!`, "event", Number(row.id));
			return eventView(row);
		} });
	api.add({ method: "put", path: "/api/events/:event_id", role: "parent", rules: Object.fromEntries(Object.entries(eventFields).map(([k, v]) => [k, optional({...v,max:undefined,gt:undefined})])), async run({ store, body, id }) {
			const row = await store.one("seasonal_events", id("event_id"), "Event"), values = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null));
			const updated = { ...row, ...values };
			if (compareTimestamps(String(updated.end_date), String(updated.start_date)) <= 0)
				throw new BusinessError(400, "end_date must be after start_date");
			await store.update("seasonal_events", Number(row.id), values);
			return eventView(updated);
		} });
	api.add({ method: "post", path: "/api/events/:event_id/end", role: "parent", async run({ store, id }) { const row = await store.one("seasonal_events", id("event_id"), "Event"); await store.update("seasonal_events", Number(row.id), { is_active: false }); return eventView({ ...row, is_active: false }); } });
	api.add({ method: "delete", path: "/api/events/:event_id", role: "parent", async run({ store, id }) { const row = await store.one("seasonal_events", id("event_id"), "Event"); await store.remove("seasonal_events", Number(row.id)); return { detail: "Event deleted" }; } });
	api.add({ method: "get", path: "/api/vacation", role: "parent", async run({ store }) { return store.rows("vacation_periods", Prisma.sql `WHERE is_active = 1 ORDER BY start_date DESC`); } });
	api.add({ method: "post", path: "/api/vacation", role: "parent", status: 201, rules: { start_date: { type: "date" }, end_date: { type: "date" } }, async run({ store, user, body }) {
			if (String(body.end_date) < String(body.start_date))
				throw new BusinessError(400, "End date must be after start date");
			if (String(body.end_date) < day())
				throw new BusinessError(400, "Cannot create vacation in the past");
			return store.insert("vacation_periods", { ...body, is_active: true, created_by: user.id });
		} });
	api.add({ method: "delete", path: "/api/vacation/:vacation_id", role: "parent", status: 204, async run({ store, id }) { const row = await store.one("vacation_periods", id("vacation_id"), "Vacation"); await store.update("vacation_periods", Number(row.id), { is_active: false }); } });
	api.add({ method: "get", path: "/api/points/:user_id", role: "authenticated", async run({ store, user, id, query }) {
			const uid = id("user_id"), q = query({ limit: { type: "int", min: 1, max: 200, default: 50 }, offset: { type: "int", min: 0, default: 0 } });
			if (user.role === "kid" && user.id !== uid)
				throw new BusinessError(403, "Kids can only view their own points");
			const target = await store.one("users", uid, "User"), transactions = await store.rows("point_transactions", Prisma.sql `WHERE user_id = ${uid} ORDER BY ${createdAtOrder} DESC LIMIT ${q.limit} OFFSET ${q.offset}`);
			return { user: userView(target), balance: target.points_balance, total_earned: target.total_points_earned, transactions: transactions.map(r => pick(r, "id user_id amount type description reference_id created_at")) };
		} });
	for (const bonus of [true, false])
		api.add({ method: "post", path: bonus ? "/api/points/:user_id/bonus" : "/api/points/adjust/:user_id", role: bonus ? "parent" : "admin", rules: { amount: int(bonus ? 0 : undefined), description: str() }, async run({ store, user, id, body, request }) {
				const target = await store.one("users", id("user_id"), "User"), amount = Number(body.amount);
				if (Number(target.points_balance) + amount < 0)
					throw new BusinessError(400, "Adjustment would result in a negative balance");
				const levelup = await award(store, target, amount);
				const tx = await points(store, Number(target.id), amount, bonus ? "bonus" : "adjustment", String(body.description), null, user.id);
				if (bonus) {
					await notify(store, Number(target.id), "bonus_points", "Bonus Points!", `You received ${amount} bonus XP: ${body.description}`, "point_transaction");
					if (levelup)
						await notify(store, Number(target.id), "pet_levelup", "Pet Levelled Up!", `Your ${levelup.pet} reached level ${levelup.new_level} (${levelup.name})!`, "pet");
					await achievements(store, target);
				}
				else
					await store.insert("audit_logs", { user_id: user.id, action: "point_adjustment", details: { target_user_id: target.id, amount, description: body.description, new_balance: target.points_balance }, ip_address: request.ip ?? null });
				return pick(tx, "id user_id amount type description reference_id created_at");
			} });
}
