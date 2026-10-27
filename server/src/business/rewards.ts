import { Prisma } from "@prisma/client";
import { BusinessError, pick, userView, type Store, type Row } from "./store.js";
import { achievements, notify, points } from "./gamification.js";
import { int, optional, str, type Rules } from "./validation.js";
import type { BusinessRouter } from "./router.js";
export const rewardView = (row: Row) => pick(row, "id title description point_cost icon category stock auto_approve_threshold is_active created_by created_at");
export async function redemptionView(store: Store, row: Row) {
	return { ...pick(row, "id reward_id user_id points_spent status approved_by approved_at fulfilled_by fulfilled_at created_at"), reward: rewardView(await store.one("rewards", Number(row.reward_id), "Reward")), user: userView(await store.one("users", Number(row.user_id), "User")) };
}
export async function newReward(store: Store, body: Row, creator: number) {
	return store.insert("rewards", { title: body.title, description: null, icon: null, category: null, stock: null, auto_approve_threshold: null, ...body, is_active: true, created_by: creator });
}
export function registerRewards(api: BusinessRouter) {
	const fields: Rules = { title: str(200), description: optional(str()), point_cost: int(0), icon: optional(str()), category: optional(str()), stock: optional(int()), auto_approve_threshold: optional(int()) };
	api.add({ method: "get", path: "/api/rewards/redemptions", role: "authenticated", async run({ store, user, query }) {
			const { status } = query({ status: optional(str()) });
			if (status !== undefined && !["pending", "approved", "denied", "fulfilled"].includes(String(status)))
				throw new BusinessError(400, `Invalid status: ${status}`);
			const rows = await store.rows("reward_redemptions", Prisma.sql `WHERE ${user.role === "kid" ? Prisma.sql `user_id = ${user.id}` : Prisma.sql `1 = 1`} ${status !== undefined ? Prisma.sql `AND status = ${status}` : Prisma.empty}`);
			const rewards = new Map((await store.rows("rewards")).map(r => [r.id, r])), users = new Map((await store.rows("users")).map(u => [u.id, u]));
			return rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).map(row => ({ ...pick(row, "id reward_id user_id points_spent status approved_by approved_at fulfilled_by fulfilled_at created_at"), reward: rewardView(rewards.get(row.reward_id)!), user: userView(users.get(row.user_id)!) }));
		} });
	for (const action of ["approve", "deny", "fulfill"] as const)
		api.add({ method: "post", path: `/api/rewards/redemptions/:redemption_id/${action}`, role: "parent", async run({ store, user, id }) {
				const row = await store.one("reward_redemptions", id("redemption_id"), "Redemption");
				if(!Number.isSafeInteger(Number(row.points_spent))||Number(row.points_spent)<=0)throw new BusinessError(400,"Redemption points are invalid; administrator review is required");
				if (row.status !== (action === "fulfill" ? "approved" : "pending"))
					throw new BusinessError(400, action === "fulfill" ? "Only approved redemptions can be fulfilled" : "Redemption is not pending");
				const reward = await store.one("rewards", Number(row.reward_id), "Reward");
				const status = action === "approve" ? "approved" : action === "deny" ? "denied" : "fulfilled";
				if (action === "deny") {
					const target = await store.one("users", Number(row.user_id), "User");
					await store.update("users", Number(target.id), { points_balance: Number(target.points_balance) + Number(row.points_spent) });
					await points(store, Number(target.id), Number(row.points_spent), "reward_redeem", `Refund for denied redemption of '${reward.title}'`, Number(row.id), user.id);
				}
				await store.update("reward_redemptions", Number(row.id), { status, ...(action === "fulfill" ? { fulfilled_by: user.id, fulfilled_at: new Date() } : { approved_by: user.id, approved_at: new Date() }) });
				const title = action === "approve" ? "Reward Approved!" : action === "deny" ? "Reward Denied" : "Reward Delivered!";
				const message = action === "approve" ? `Your redemption of '${reward.title}' has been approved!` : action === "deny" ? `Your redemption of '${reward.title}' was denied. ${row.points_spent} XP has been refunded.` : `Your reward '${reward.title}' has been handed out!`;
				await notify(store, Number(row.user_id), action === "deny" ? "reward_denied" : "reward_approved", title, message, "redemption", Number(row.id));
				return redemptionView(store, await store.one("reward_redemptions", Number(row.id), "Redemption"));
			} });
	api.add({ method: "get", path: "/api/rewards", role: "authenticated", async run({ store }) { return (await store.rows("rewards", Prisma.sql `WHERE is_active = 1 ORDER BY point_cost`)).map(rewardView); } });
	api.add({ method: "post", path: "/api/rewards", role: "parent", status: 201, rules: fields, async run({ store, body, user }) { return rewardView(await newReward(store, body, user.id)); } });
	api.add({ method: "get", path: "/api/rewards/:reward_id", role: "authenticated", async run({ store, id }) { return rewardView(await store.one("rewards", id("reward_id"), "Reward")); } });
	api.add({ method: "put", path: "/api/rewards/:reward_id", role: "parent", rules: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, optional({...v,max:undefined})])), async run({ store, id, body }) {
			const reward = await store.one("rewards", id("reward_id"), "Reward");
			// Deliberate integrity tightening: zero/negative prices cannot mint points.
			if (body.point_cost !== undefined && (body.point_cost === null || Number(body.point_cost) <= 0))
				throw new BusinessError(400, "point_cost must be positive");
			if (body.title === null)
				throw new BusinessError(400, "title cannot be null");
			await store.update("rewards", Number(reward.id), body);
			return rewardView({ ...reward, ...body });
		} });
	api.add({ method: "delete", path: "/api/rewards/:reward_id", role: "parent", status: 204, async run({ store, id }) { const r = await store.one("rewards", id("reward_id"), "Reward"); await store.update("rewards", Number(r.id), { is_active: false }); } });
	api.add({ method: "post", path: "/api/rewards/:reward_id/redeem", role: "authenticated", async run({ store, user, id }) {
			const reward = await store.one("rewards", id("reward_id"), "Reward"), target = await store.one("users", user.id, "User");
			if (!reward.is_active)
				throw new BusinessError(400, "Reward is no longer available");
			if (Number(reward.point_cost) <= 0)
				throw new BusinessError(400, "Reward cost is invalid");
			if (Number(target.points_balance) < Number(reward.point_cost))
				throw new BusinessError(400, "Insufficient points balance");
			if (reward.stock !== null && Number(reward.stock) <= 0)
				throw new BusinessError(400, "Reward is out of stock");
			if (reward.stock !== null)
				await store.update("rewards", Number(reward.id), { stock: Number(reward.stock) - 1 });
			target.points_balance = Number(target.points_balance) - Number(reward.point_cost);
			await store.update("users", user.id, { points_balance: target.points_balance });
			await points(store, user.id, -Number(reward.point_cost), "reward_redeem", `Redeemed reward: ${reward.title}`, Number(reward.id));
			const redemption = await store.insert("reward_redemptions", { reward_id: reward.id, user_id: user.id, points_spent: reward.point_cost, status: "approved", approved_by: null, approved_at: new Date(), fulfilled_by: null, fulfilled_at: null });
			const parents = await store.rows("users", Prisma.sql `WHERE role IN ('parent', 'admin') AND is_active = 1`);
			for (const p of parents)
				await notify(store, Number(p.id), "reward_approved", "Reward Redeemed!", `${target.display_name} redeemed '${reward.title}' for ${reward.point_cost} XP`, "redemption", Number(redemption.id));
			await achievements(store, target);
			return redemptionView(store, redemption);
		} });
}
