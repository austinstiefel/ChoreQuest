import { Prisma } from "@prisma/client";
import { BusinessError, object, type Row } from "./store.js";
import { int, optional, str } from "./validation.js";
import type { BusinessRouter } from "./router.js";
/** Phase 5 transports must report real delivery, not enqueue an undocumented
 * process-local imitation. Notification rows are already durable separately. */
export interface Delivery {
	emote?: (event: Row) => Promise<void>;
	testPush?: (userId: number) => Promise<number>;
	vapidPublicKey?: () => Promise<string>;
}
export function registerIntegrations(api: BusinessRouter, delivery: Delivery = {}) {
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
	api.add({ method: "get", path: "/api/push/vapid-public-key", role: "authenticated", async run({ store }) {
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
			await delivery.emote({ user_id: user.id, user_name: user.display_name || user.username, emote: body.emote, target_user_id: body.target_user_id ?? null });
			return { status: "sent" };
		} });
}
