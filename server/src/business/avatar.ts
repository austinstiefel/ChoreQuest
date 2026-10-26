import { Prisma } from "@prisma/client";
import { BusinessError, day, object, pick, type Row, type Store } from "./store.js";
import { achievements, award, petLevel, petXp, points, setPetXp } from "./gamification.js";
import { avatarCatalogue } from "./avatarCatalogue.js";
import { str } from "./validation.js";
import type { BusinessRouter } from "./router.js";
import { mergeAvatarConfig } from "../db/avatarConfig.js";
async function spinAvailability(store: Store, uid: number) {
	const spins = (await store.rows("spin_results", Prisma.sql `WHERE user_id = ${uid}`)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
	const last_result = spins[0]?.points_won ?? null;
	if (spins.some(s => s.spin_date === day()))
		return { can_spin: false, last_result, reason: "You already spun the wheel today! Come back tomorrow." };
	const pending = (await store.rows("chore_assignments", Prisma.sql `WHERE user_id = ${uid}`)).filter(a => a.date === day() && !["completed", "verified"].includes(String(a.status))).length;
	return { can_spin: pending === 0, last_result, reason: pending ? `Complete all of today's quests to unlock the spin! ${pending} remaining.` : null };
}
export function registerAvatar(api: BusinessRouter) {
	api.add({ method: "get", path: "/api/avatar/parts", role: "public", async run() { return avatarCatalogue; } });
	api.add({ method: "put", path: "/api/avatar", role: "authenticated", rules: { config: { type: "dict" } }, async run({ store, user, body }) {
			const account = await store.one("users", user.id, "User");
			const config = mergeAvatarConfig(object(account.avatar_config), object(body.config));
			await store.update("users", user.id, { avatar_config: config });
			return { detail: "Avatar updated", avatar_config: config };
		} });
	api.add({ method: "get", path: "/api/avatar/items", role: "authenticated", writes: true, async run({ store, user }) {
			const account = await store.one("users", user.id, "User"), owned = new Set((await store.rows("user_avatar_items", Prisma.sql `WHERE user_id = ${user.id}`)).map(i => i.avatar_item_id)), result = [];
			for (const item of await store.rows("avatar_items")) {
				let unlocked = user.role !== "kid" || Boolean(item.is_default) || owned.has(item.id);
				if (!unlocked && item.unlock_value && ((item.unlock_method === "xp" && Number(account.total_points_earned) >= Number(item.unlock_value)) || (item.unlock_method === "streak" && Number(account.longest_streak) >= Number(item.unlock_value)))) {
					await store.insert("user_avatar_items", { user_id: user.id, avatar_item_id: item.id, acquired_via: "milestone" });
					unlocked = true;
				}
				result.push({ ...pick(item, "id category item_id display_name rarity unlock_method unlock_value is_default"), unlocked });
			}
			return result;
		} });
	api.add({ method: "post", path: "/api/avatar/items/:item_id/purchase", role: "authenticated", async run({ store, user, id }) {
			const item = await store.one("avatar_items", id("item_id"), "Item"), account = await store.one("users", user.id, "User");
			if (item.is_default)
				throw new BusinessError(400, "This item is already free");
			if (item.unlock_method !== "shop")
				throw new BusinessError(400, "This item cannot be purchased");
			if ((await store.rows("user_avatar_items", Prisma.sql `WHERE user_id = ${user.id} AND avatar_item_id = ${item.id}`)).length)
				throw new BusinessError(400, "You already own this item");
			const cost = Number(item.unlock_value ?? 0);
			if (cost < 0)
				throw new BusinessError(400, "Item cost is invalid");
			if (Number(account.points_balance) < cost)
				throw new BusinessError(400, `Not enough XP. Need ${cost}, have ${account.points_balance}`);
			const balance = Number(account.points_balance) - cost;
			await store.update("users", user.id, { points_balance: balance });
			await points(store, user.id, -cost, "reward_redeem", `Avatar item: ${item.display_name}`, Number(item.id));
			await store.insert("user_avatar_items", { user_id: user.id, avatar_item_id: item.id, acquired_via: "purchase" });
			return { detail: `Purchased ${item.display_name}!`, points_balance: balance };
		} });
	api.add({ method: "post", path: "/api/pets/interact", role: "authenticated", rules: { action: { ...str(), pattern: "^(feed|pet|play)$" } }, async run({ store, user, body }) {
			const account = await store.one("users", user.id, "User"), config = { ...object(account.avatar_config) };
			if (!config.pet || config.pet === "none")
				throw new BusinessError(400, "No pet equipped");
			let interactions = object(config.pet_interactions);
			if (interactions.date !== day())
				interactions = { date: day(), count: 0, actions: [] };
			if (Number(interactions.count) >= 3)
				throw new BusinessError(400, "Your pet is tired! Max 3 interactions per day.");
			const xp = ({ feed: 2, pet: 1, play: 3 } as Record<string, number>)[String(body.action)], old = petLevel(petXp(config));
			const next = petLevel(petXp(config) + xp);
			setPetXp(config, next.xp);
			interactions = { ...interactions, count: Number(interactions.count) + 1, actions: [...(Array.isArray(interactions.actions) ? interactions.actions : []), body.action] };
			config.pet_interactions = interactions;
			const balance = Number(account.points_balance) + xp;
			await store.update("users", user.id, { avatar_config: config, points_balance: balance, total_points_earned: Number(account.total_points_earned) + xp });
			return { action: body.action, xp_awarded: xp, interactions_remaining: 3 - Number(interactions.count), levelup: next.level > old.level ? { old_level: old.level, new_level: next.level, name: next.name, pet: config.pet } : null, new_balance: balance };
		} });
	api.add({ method: "get", path: "/api/spin/availability", role: "authenticated", async run({ store, user }) { return spinAvailability(store, user.id); } });
	api.add({ method: "post", path: "/api/spin/spin", role: "authenticated", async run({ store, user }) {
			const available = await spinAvailability(store, user.id);
			if (!available.can_spin)
				throw new BusinessError(400, String(available.reason));
			const values = [1, 5, 2, 10, 3, 15, 1, 25, 2, 5, 3, 10], won = values[Math.floor(Math.random() * values.length)], account = await store.one("users", user.id, "User");
			await store.insert("spin_results", { user_id: user.id, points_won: won, spin_date: day() });
			await points(store, user.id, won, "spin", `Daily spin: won ${won} XP`);
			await award(store, account, won);
			await achievements(store, account);
			return { points_won: won };
		} });
}
