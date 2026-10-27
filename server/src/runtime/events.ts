import { Prisma } from "@prisma/client";
import { object, pick, type Store, type Row } from "../business/store.js";
import type { Endpoint } from "../business/router.js";
import type { AuthenticatedUser } from "../middleware/auth.js";
import type { SocketEvent } from "./websocket.js";
/** Translate committed operation results into the Python wire protocol, without
 * redoing mutations. Invoked within the transaction, delivered only after commit. */
export async function planEvents(store: Store, endpoint: Endpoint, user: AuthenticatedUser, body: Row, result: unknown): Promise<SocketEvent[]> {
	const events: SocketEvent[] = [], row = object(result), path = endpoint.path, method = endpoint.method;
	const send = (userId: number, type: string, data: Row) => events.push({ userId, message: { type, data } });
	const broadcast = (type: string, data: Row, excludeUser?: number) => events.push({ excludeUser, message: { type, data } });
	const changed = (entity: string, excludeUser?: number) => broadcast("data_changed", { entity }, excludeUser);
	const notifications = store.inserted.filter(r => r.table === "notifications").map(r => r.row);
	for (const notification of notifications) {
		// Refresh only the owner, including feedback/drop notifications that had
		// no explicit Python socket event. No private message enters a broadcast.
		send(Number(notification.user_id), "data_changed", { entity: "notification" });
		if (notification.type === "achievement_unlocked") {
			const achievement = await store.one("achievements", Number(notification.reference_id), "Achievement");
			send(Number(notification.user_id), "achievement_unlocked", { achievement_key: achievement.key, title: achievement.title, points: achievement.points_reward });
		}
	}
	if (method === "get")
		return events;
	if (path.startsWith("/api/chores/categories"))
		changed("category", user.id);
	else if (path === "/api/chores" || /^\/api\/chores\/(?:rules\/[^/]+|:chore_id(?:\/assign)?)$/.test(path) || ["uncomplete", "skip"].some(a => path.endsWith(`/${a}`)))
		changed("chore", user.id);
	if (path.endsWith("/complete") || path.endsWith("/verify")) {
		const chore = object(row.chore), target = object(row.user);
		if (path.endsWith("/complete")) {
			for (const parent of await store.rows("users", Prisma.sql `WHERE role IN ('parent','admin') AND is_active=1`))
				send(Number(parent.id), "chore_completed", { chore_id: chore.id, chore_title: chore.title, user_id: target.id, user_display_name: target.display_name, points: chore.points, assignment_id: row.id });
		}
		else {
			const transactions = store.inserted.filter(r => r.table === "point_transactions" && r.row.reference_id === row.id && ["chore_complete", "event_multiplier"].includes(String(r.row.type)));
			const data: Row = { chore_id: chore.id, chore_title: chore.title, assignment_id: row.id, points: transactions.reduce((sum, r) => sum + Number(r.row.amount), 0) };
			const drop = notifications.find(n => n.type === "avatar_item_drop");
			if (drop)
				data.avatar_drop = pick(await store.one("avatar_items", Number(drop.reference_id), "Avatar item"), "id category item_id display_name rarity");
			send(Number(target.id), "chore_verified", data);
		}
	}
	if (path === "/api/calendar/trade" || /\/trade\/:notification_id\/(accept|deny)$/.test(path)) {
		for (const n of notifications.filter(n => ["trade_proposed", "trade_accepted", "trade_denied"].includes(String(n.type)))) {
			const assignment = await store.one("chore_assignments", Number(n.reference_id), "Assignment"), chore = await store.one("chores", Number(assignment.chore_id), "Chore");
			const data: Row = { notification_id: n.id, assignment_id: assignment.id, chore_title: chore.title };
			data[n.type === "trade_proposed" ? "from_user" : n.type === "trade_accepted" ? "accepted_by" : "denied_by"] = user.display_name;
			send(Number(n.user_id), String(n.type), data);
			if (n.type === "trade_accepted")
				send(user.id, "trade_accepted", { assignment_id: assignment.id, chore_title: chore.title });
		}
		if (path.endsWith("/accept"))
			changed("assignment", user.id);
	}
	if (path.startsWith("/api/calendar/assignments") && method === "delete")
		changed("assignment", user.id);
	if (path.startsWith("/api/rotations"))
		changed("rotation");
	if (path.startsWith("/api/rewards")) {
		const reward = object(row.reward);
		if (/\/redemptions\//.test(path)) {
			const type = path.endsWith("/approve") ? "reward_approved" : path.endsWith("/deny") ? "reward_denied" : "reward_fulfilled";
			send(Number(row.user_id), type, { redemption_id: row.id, reward_title: reward.title, ...(type === "reward_denied" ? { points_refunded: row.points_spent } : {}) });
			if (type !== "reward_denied")
				changed("redemption", Number(row.user_id));
		}
		else if (path.endsWith("/redeem"))
			send(user.id, "reward_redeemed", { redemption_id: row.id, reward_title: reward.title, points_spent: row.points_spent, status: "approved" });
		else
			changed("reward", user.id);
	}
	if (path.startsWith("/api/wishlist")) {
		if (path.endsWith("/convert")) {
			const wish = store.removed.find(r => r.table === "wishlist_items")?.row;
			if (wish)
				send(Number(wish.user_id), "data_changed", { entity: "wishlist" });
			changed("reward", user.id);
		}
		else
			changed("wishlist", user.id);
	}
	if (path.startsWith("/api/events"))
		changed("event", method === "post" && path === "/api/events" ? user.id : undefined);
	if (path === "/api/announcements" && method === "post")
		broadcast("announcement", { title: body.title, message: body.message });
	if (path === "/api/shoutouts" && method === "post")
		broadcast("shoutout", pick(row, "from_user_id from_user_name to_user_id to_user_name message emoji"));
	if (path === "/api/avatar")
		changed("user", user.id);
	if (path.endsWith("/purchase"))
		send(user.id, "data_changed", { entity: "avatar_items" });
	if (path === "/api/spin/spin")
		send(user.id, "spin_result", { points_won: row.points_won });
	if (path.startsWith("/api/points/")) {
		const target = await store.one("users", Number(row.user_id), "User");
		send(Number(target.id), path.endsWith("/bonus") ? "bonus_points" : "data_changed", path.endsWith("/bonus") ? { amount: body.amount, description: body.description, new_balance: target.points_balance } : { entity: "points", new_balance: target.points_balance });
	}
	// Settings/vacation/bulletin deletion also need UI invalidation. They had no
	// Python broadcasts; retain the existing event envelope rather than add one.
	if (["/api/admin/settings", "/api/vacation"].some(p => path.startsWith(p)) || method === "delete" && path.startsWith("/api/announcements/"))
		changed(path.includes("settings") ? "settings" : path.includes("vacation") ? "vacation" : "announcement");
	return events;
}
