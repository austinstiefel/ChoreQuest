import { Prisma } from "@prisma/client";
import { BusinessError, object, type Row, type Store } from "./store.js";
import type { SocketEvent } from "../runtime/websocket.js";
import { int, optional, str } from "./validation.js";
import type { BusinessRouter } from "./router.js";
/** Phase 5 transports must report real delivery, not enqueue an undocumented
 * process-local imitation. Notification rows are already durable separately. */
export interface Delivery {
	prepare?: (store: Store) => Promise<void>;
	publish?: (events: SocketEvent[]) => Promise<void>;
	emote?: (event: Row) => Promise<void>;
	testPush?: (userId: number) => Promise<number>;
	vapidPublicKey?: () => Promise<string>;
}
export function registerIntegrations(api: BusinessRouter, delivery: Delivery = {}) {
	const emoteBudgets=new Map<number,{start:number;count:number}>();
	const rules = { endpoint: str(), keys: { type: "dict" as const } };
	api.add({ method: "get", path: "/api/push/status", role: "authenticated", async run({ store, user }) { return { subscribed: (await store.rows("push_subscriptions", Prisma.sql `WHERE user_id = ${user.id} LIMIT 1`)).length > 0 }; } });
	api.add({ method: "post", path: "/api/push/subscribe", role: "authenticated", rules, async run({ store, user, body }) {
			const keys = object(body.keys);
			if (typeof keys.p256dh !== "string" || !keys.p256dh || typeof keys.auth !== "string" || !keys.auth)
				throw new BusinessError(400, "Missing p256dh or auth keys");
			await store.db.$executeRaw `DELETE FROM push_subscriptions WHERE user_id = ${user.id} AND endpoint = ${body.endpoint}`;
			await store.insert("push_subscriptions", { user_id: user.id, endpoint: body.endpoint, p256dh: keys.p256dh, auth: keys.auth });
			return { detail: "Subscribed" };
		} });
	api.add({ method: "post", path: "/api/push/unsubscribe", role: "authenticated", rules, async run({ store, user, body }) {
			const count = await store.db.$executeRaw `DELETE FROM push_subscriptions WHERE user_id = ${user.id} AND endpoint = ${body.endpoint}`;
			if (!count)
				throw new BusinessError(404, "Subscription not found");
			return { detail: "Unsubscribed" };
		} });
	api.add({ method: "get", path: "/api/push/vapid-public-key", role: "authenticated", writes: false, async run({ store }) {
			if (delivery.vapidPublicKey)
				return { public_key: await delivery.vapidPublicKey() };
			const key = (await store.rows("app_settings", Prisma.sql `WHERE key = 'vapid_public_key'`))[0]?.value;
			if (typeof key === "string" && key)
				return { public_key: key };
			throw new BusinessError(503, "Push key initialization is deferred until the push transport is configured");
		} });
	api.add({ method: "post", path: "/api/push/test", role: "parent", writes: false, async run({ store, user }) {
			const subs = await store.rows("push_subscriptions", Prisma.sql `WHERE user_id = ${user.id}`);
			if (!subs.length)
				throw new BusinessError(400, "No push subscriptions found. Toggle push off and on again.");
			if (!delivery.testPush)
				throw new BusinessError(501, "Push delivery is not implemented in this migration phase");
			const sent = await delivery.testPush(user.id);
			return { detail: `Sent to ${sent}/${subs.length} device(s)` };
		} });
	api.add({ method: "post", path: "/api/emotes", role: "authenticated", writes: false, rules: { emote: str(20), target_user_id: optional(int()) }, async run({ user, body }) {
			const valid = ["dance", "wave", "cheer", "flex", "sparkle", "highfive"];
			if (!valid.includes(String(body.emote)))
				throw new BusinessError(400, `Invalid emote. Valid: ['${valid.join("', '")}']`);
			if (!delivery.emote)
				throw new BusinessError(501, "WebSocket emote delivery is not implemented in this migration phase");
			const now=Date.now(),budget=emoteBudgets.get(user.id);
			if(budget && now-budget.start<10_000 && budget.count>=10)throw new BusinessError(429,"Too many emotes; try again shortly");
			if(!budget||now-budget.start>=10_000)emoteBudgets.set(user.id,{start:now,count:1});else budget.count++;
			if(emoteBudgets.size>1000)for(const [id,value] of emoteBudgets)if(now-value.start>=10_000)emoteBudgets.delete(id);
			await delivery.emote({ user_id: user.id, user_name: user.display_name || user.username, emote: body.emote, target_user_id: body.target_user_id ?? null });
			return { status: "sent" };
		} });
}
