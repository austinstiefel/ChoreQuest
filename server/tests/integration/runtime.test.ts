import { once } from "node:events";
import { WebSocket } from "ws";
import { SignJWT } from "jose";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRefreshToken } from "../../src/auth/tokens.js";
import { putState, pushJobsFilter } from "../../src/runtime/state.js";
import { Prisma } from "@prisma/client";
import { runtimeFixture } from "../helpers/runtime.js";
import { addDays, day } from "../../src/business/store.js";
import type { PushSender } from "../../src/runtime/push.js";
let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
const sender = vi.fn<PushSender>(async () => undefined);
beforeEach(async () => { sender.mockReset().mockResolvedValue(undefined); fixture = await runtimeFixture(sender); });
afterEach(async () => { vi.restoreAllMocks(); await fixture.dispose(); });
const eventually = (f: () => void) => vi.waitFor(f, { timeout: 2000, interval: 10 });
async function chore(extra: object = {}) {
	const r = await fixture.http("/api/chores", "POST", 0, { title: "Shared quest", points: 10, difficulty: "easy", category_id: fixture.category.id, recurrence: "daily", assigned_user_ids: [fixture.users[2].id, fixture.users[3].id], ...extra });
	expect(r.status).toBe(201);
	return r.json();
}
async function rejected(path: string, protocols?: string[], origin = "https://frontend.example") {
	const ws = protocols ? new WebSocket(fixture.base.replace("http:", "ws:") + path, protocols, { origin }) : new WebSocket(fixture.base.replace("http:", "ws:") + path, { origin });
	ws.on("error", () => undefined);
	return new Promise<number>(resolve => { ws.once("unexpected-response", (_request, response) => { response.resume(); ws.terminate(); resolve(response.statusCode!); }); ws.once("open", () => { ws.close(); resolve(101); }); });
}
it("accepts both browser subprotocol and legacy query credentials, multiple sessions and reconnects", async () => {
	const a = await fixture.socket(), b = await fixture.socket(2, true);
	expect(fixture.runtime.hub.size).toBe(2);
	expect(a.ws.protocol).toBe("chorequest");
	a.ws.close();
	await once(a.ws, "close");
	await eventually(() => expect(fixture.runtime.hub.size).toBe(1));
	const c = await fixture.socket();
	expect(fixture.runtime.hub.size).toBe(2);
	c.ws.close();
	b.ws.close();
});
it("rejects missing, forged, wrong-type, expired and identity-mismatched socket credentials", async () => {
	const id = fixture.users[2].id, token = fixture.tokens[2];
	const expired = await new SignJWT({ sub: String(id), role: "admin", type: "access", exp: 1 }).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(fixture.config.secretKey));
	for (const credential of ["malformed", token.slice(0, -4) + "abcd", expired, await createRefreshToken(id, fixture.config), fixture.tokens[3]])
		expect(await rejected(`/ws/${id}?token=${credential}`)).toBe(401);
	expect(await rejected(`/ws/${id}`)).toBe(401);
	expect(fixture.runtime.hub.size).toBe(0);
});
it("checks current account activity and origins without trusting the token role", async () => {
	const id = fixture.users[2].id, protocols = ["chorequest", `bearer.${fixture.tokens[2]}`];
	expect(await rejected(`/ws/${id}`, protocols, "https://attacker.example")).toBe(403);
	await fixture.store.update("users", id, { is_active: false });
	expect(await rejected(`/ws/${id}`, protocols)).toBe(401);
	await fixture.store.update("users", id, { is_active: true, role: "parent" });
	const socket = await fixture.socket();
	await fixture.store.update("users", id, { is_active: false });
	const closed = once(socket.ws, "close");
	await fixture.runtime.hub.heartbeat();
	expect((await closed)[0]).toBe(4001);
});
it("limits sessions per account and ignores attempts to forge server events", async () => {
	const sessions: Awaited<ReturnType<typeof fixture.socket>>[] = [];
	for (let i = 0; i < 8; i++)
		sessions.push(await fixture.socket());
	expect(await rejected(`/ws/${fixture.users[2].id}`, ["chorequest", `bearer.${fixture.tokens[2]}`])).toBe(429);
	sessions[0].ws.send(JSON.stringify({ type: "bonus_points", data: { amount: 99999, user_id: fixture.users[3].id } }));
	await fixture.runtime.hub.publish([{ userId: fixture.users[2].id, message: { type: "data_changed", data: { entity: "fixture" } } }]);
	await eventually(() => expect(sessions[1].messages).toHaveLength(1));
	expect(sessions[1].messages[0].type).toBe("data_changed");
});
it("terminates stale connections and closes all sessions gracefully", async () => {
	const a = await fixture.socket();
	vi.spyOn(a.ws, "pong").mockImplementation(() => undefined);
	const stale = once(a.ws, "close");
	await fixture.runtime.hub.heartbeat();
	await fixture.runtime.hub.heartbeat();
	await stale;
	await eventually(() => expect(fixture.runtime.hub.size).toBe(0));
	const b = await fixture.socket();
	const close = once(b.ws, "close");
	await fixture.runtime.close(fixture.server);
	expect((await close)[0]).toBe(1001);
	expect(fixture.runtime.hub.size).toBe(0);
});
it("delivers committed HTTP chore workflows, private notifications and queued push to their intended recipients", async () => {
	const parent = await fixture.socket(1), kid = await fixture.socket(), other = await fixture.socket(3);
	await fixture.http("/api/push/subscribe", "POST", 1, { endpoint: "https://fcm.googleapis.com/fixture-parent", keys: { p256dh: "fixture-public", auth: "fixture-auth" } });
	await fixture.http("/api/push/subscribe", "POST", 2, { endpoint: "https://fcm.googleapis.com/fixture-kid", keys: { p256dh: "fixture-public", auth: "fixture-auth" } });
	const c = await chore();
	await eventually(() => expect(kid.messages.some(e => e.type === "data_changed" && e.data.entity === "chore")).toBe(true));
	parent.messages.length = kid.messages.length = other.messages.length = 0;
	expect((await fixture.http(`/api/chores/${c.id}/complete`, "POST", 2)).status).toBe(200);
	await eventually(() => expect(parent.messages.find(e => e.type === "chore_completed")?.data).toMatchObject({ chore_id: c.id, user_id: fixture.users[2].id, points: 10 }));
	expect(other.messages.find(e => e.type === "chore_completed")).toBeUndefined();
	const detail = await (await fixture.http(`/api/chores/${c.id}`)).json(), a = detail.assignments.find((a: {
		user_id: number;
	}) => a.user_id === fixture.users[2].id);
	expect((await fixture.http(`/api/chores/assignments/${a.id}/verify`, "POST")).status).toBe(200);
	await eventually(() => expect(kid.messages.find(e => e.type === "chore_verified")?.data).toMatchObject({ assignment_id: a.id, points: 10 }));
	expect(other.messages.find(e => e.type === "chore_verified")).toBeUndefined();
	await fixture.runtime.push.processBatch();
	expect(sender).toHaveBeenCalled();
	const parentPush = sender.mock.calls.find(call => (call as unknown as [
		{
			endpoint: string;
		}
	])[0].endpoint.endsWith("fixture-parent"));
	expect(parentPush).toBeDefined();
	expect(await fixture.db.prisma.$queryRaw `PRAGMA foreign_key_check`).toEqual([]);
});
it("does not emit success events or persist push work when the business transaction rolls back", async () => {
	const kid = await fixture.socket();
	await fixture.http("/api/push/subscribe", "POST", 2, { endpoint: "https://fcm.googleapis.com/fixture", keys: { p256dh: "public", auth: "auth" } });
	await fixture.db.prisma.$executeRawUnsafe("CREATE TRIGGER fail_runtime_notice BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'private fixture'); END");
	expect((await fixture.http("/api/chores", "POST", 0, { title: "Rollback", points: 10, difficulty: "easy", category_id: fixture.category.id, recurrence: "once", assigned_user_ids: [fixture.users[2].id] })).status).toBe(500);
	expect(await fixture.db.prisma.chores.count()).toBe(0);
	expect(await fixture.db.prisma.$queryRaw(Prisma.sql `SELECT key FROM app_settings WHERE ${pushJobsFilter}`)).toEqual([]);
	await fixture.runtime.push.processBatch();
	expect(sender).not.toHaveBeenCalled();
	await fixture.runtime.hub.publish([{ userId: fixture.users[2].id, message: { type: "sentinel", data: {} } }]);
	await eventually(() => expect(kid.messages).toHaveLength(1));
	expect(kid.messages[0].type).toBe("sentinel");
});
it("completes emote/push/VAPID endpoints with real adapters and honest delivery counts", async () => {
	const a = await fixture.socket(), b = await fixture.socket(3);
	expect((await fixture.http("/api/emotes", "POST", 2, { emote: "wave", target_user_id: fixture.users[3].id })).status).toBe(200);
	await eventually(() => { expect(a.messages.find(e => e.type === "emote")?.data).toMatchObject({ user_id: fixture.users[2].id, emote: "wave", target_user_id: fixture.users[3].id }); expect(b.messages.find(e => e.type === "emote")).toBeDefined(); });
	expect((await (await fixture.http("/api/push/vapid-public-key")).json()).public_key).toBe(fixture.runtime.keys.publicKey);
	await fixture.http("/api/push/subscribe", "POST", 0, { endpoint: "https://fcm.googleapis.com/test", keys: { p256dh: "public", auth: "auth" } });
	expect(await (await fixture.http("/api/push/test", "POST")).json()).toEqual({ detail: "Sent to 1/1 device(s)" });
	sender.mockRejectedValueOnce({ statusCode: 503 });
	expect(await (await fixture.http("/api/push/test", "POST")).json()).toEqual({ detail: "Sent to 0/1 device(s)" });
	expect((await fixture.http("/api/push/test", "POST", 2)).status).toBe(403);
});
it("isolates private runtime checkpoint/outbox state from settings readers and writers", async () => {
	await putState(fixture.db.prisma, "__runtime_private.fixture", { secret: "synthetic-only" });
	const settings = await (await fixture.http("/api/admin/settings")).json();
	expect(JSON.stringify(settings)).not.toContain("__runtime_");
	expect((await fixture.http("/api/admin/settings", "PUT", 1, { settings: { __runtime_daily: "forged" } })).status).toBe(400);
	expect((await fixture.http("/api/admin/settings", "PUT", 1, { settings: { aaruntime_push_fake: "not-json" } })).status).toBe(200);
	await expect(fixture.runtime.push.processBatch()).resolves.toBeUndefined();
});
it("targets shared chores securely through assignment aliases and legacy selectors without replaying awards", async () => {
	const c = await chore();
	await fixture.http(`/api/chores/${c.id}/complete`, "POST", 2);
	await fixture.http(`/api/chores/${c.id}/complete`, "POST", 3);
	expect((await fixture.http(`/api/chores/${c.id}/verify`, "POST")).status).toBe(409);
	const detail = await (await fixture.http(`/api/chores/${c.id}`)).json(), [a, b] = detail.assignments;
	expect((await fixture.http(`/api/chores/assignments/${a.id}/verify`, "POST", 2)).status).toBe(403);
	expect((await fixture.http(`/api/chores/assignments/${a.id}/verify`, "POST")).status).toBe(200);
	expect((await fixture.http(`/api/chores/assignments/${a.id}/verify`, "POST")).status).toBe(404);
	expect((await fixture.store.one("chore_assignments", b.id, "Assignment")).status).toBe("completed");
	expect((await fixture.http(`/api/chores/${c.id}/verify?assignment_id=${b.id}`, "POST")).status).toBe(200);
	const own = await (await fixture.http(`/api/chores/${c.id}`, "GET", 2)).json();
	expect(own.assignments).toHaveLength(1);
	expect(own.assignments[0].user_id).toBe(fixture.users[2].id);
	expect((await fixture.http(`/api/chores/assignments/${a.id}/uncomplete`, "POST")).status).toBe(200);
	expect((await fixture.http(`/api/chores/assignments/${a.id}/skip`, "POST")).status).toBe(200);
	expect((await fixture.http(`/api/chores/${c.id}/verify?assignment_id=bad`, "POST")).status).toBe(422);
});
it("keeps all today's selectable assignments even when a future calendar exceeds the history limit", async () => {
	const c = await chore(), today = day();
	for (let i = 1; i <= 31; i++)
		for (const user_id of [fixture.users[2].id, fixture.users[3].id])
			await fixture.store.insert("chore_assignments", { chore_id: c.id, user_id, date: addDays(today, i), status: "pending", completed_at: null, verified_at: null, verified_by: null, photo_proof_path: null, feedback: null });
	const own = (await fixture.store.rows("chore_assignments")).find(a => a.user_id === fixture.users[2].id && a.date === today)!;
	await fixture.db.prisma.$executeRaw `UPDATE chore_assignments SET date=${Date.parse(today + "T00:00:00Z")} WHERE id=${own.id}`;
	const detail = await (await fixture.http(`/api/chores/${c.id}`)).json();
	expect(detail.assignments).toHaveLength(2);
	expect(detail.assignments.every((a: {
		date: string;
	}) => a.date === today)).toBe(true);
	const kid = await (await fixture.http(`/api/chores/${c.id}`, "GET", 2)).json();
	expect(kid.assignments).toHaveLength(1);
	expect(kid.assignments[0].id).toBe(own.id);
});
it("preserves achievement, bonus, spin and profile event payloads", async () => {
	const kid = await fixture.socket(), other = await fixture.socket(3);
	await fixture.store.insert("achievements", { key: "runtime_fixture", title: "Fixture badge", description: "Synthetic", icon: "star", points_reward: 2, criteria: { type: "total_points_earned", amount: 1 }, tier: null, group_key: null, sort_order: 1 });
	expect((await fixture.http(`/api/points/${fixture.users[2].id}/bonus`, "POST", 0, { amount: 5, description: "Synthetic bonus" })).status).toBe(200);
	await eventually(() => expect(kid.messages.find(e => e.type === "achievement_unlocked")?.data).toEqual({ achievement_key: "runtime_fixture", title: "Fixture badge", points: 2 }));
	expect(kid.messages.find(e => e.type === "bonus_points")?.data).toEqual({ amount: 5, description: "Synthetic bonus", new_balance: 7 });
	expect(other.messages.find(e => e.type === "bonus_points")).toBeUndefined();
	const spin = await fixture.http("/api/spin/spin", "POST", 2);
	expect(spin.status).toBe(200);
	const won = await spin.json();
	await eventually(() => expect(kid.messages.find(e => e.type === "spin_result")?.data).toEqual(won));
	expect((await fixture.http("/api/auth/me", "PUT", 2, { display_name: "Changed" })).status).toBe(200);
	await eventually(() => expect(other.messages.find(e => e.type === "data_changed" && e.data.entity === "user")).toBeDefined());
});
it("preserves reward redemption, approval, denial and fulfillment socket contracts", async () => {
	const kid = await fixture.socket(), parent = await fixture.socket(1);
	await fixture.store.update("users", fixture.users[2].id, { points_balance: 100 });
	const reward = await (await fixture.http("/api/rewards", "POST", 0, { title: "Fixture reward", point_cost: 5 })).json();
	const purchase = await fixture.http(`/api/rewards/${reward.id}/redeem`, "POST", 2);
	expect(purchase.status).toBe(200);
	const redemption = await purchase.json();
	await eventually(() => expect(kid.messages.find(e => e.type === "reward_redeemed")?.data).toEqual({ redemption_id: redemption.id, reward_title: reward.title, points_spent: 5, status: "approved" }));
	expect((await fixture.http(`/api/rewards/redemptions/${redemption.id}/fulfill`, "POST")).status).toBe(200);
	await eventually(() => expect(kid.messages.find(e => e.type === "reward_fulfilled")?.data).toEqual({ redemption_id: redemption.id, reward_title: reward.title }));
	for (const action of ["approve", "deny"]) {
		const row = await fixture.store.insert("reward_redemptions", { reward_id: reward.id, user_id: fixture.users[2].id, points_spent: 5, status: "pending", approved_by: null, approved_at: null, fulfilled_by: null, fulfilled_at: null });
		expect((await fixture.http(`/api/rewards/redemptions/${row.id}/${action}`, "POST")).status).toBe(200);
		await eventually(() => expect(kid.messages.find(e => e.type === (action === "approve" ? "reward_approved" : "reward_denied"))?.data).toMatchObject({ redemption_id: row.id, reward_title: reward.title }));
	}
	expect(parent.messages.some(e => e.type === "data_changed" && e.data.entity === "redemption")).toBe(true);
});
it("preserves trade proposer/recipient payloads and broadcasts resolved ownership", async () => {
	const proposer = await fixture.socket(), recipient = await fixture.socket(3);
	const c = await chore({ assigned_user_ids: [fixture.users[2].id] }), [assignment] = await fixture.store.rows("chore_assignments");
	const proposal = await (await fixture.http("/api/calendar/trade", "POST", 2, { assignment_id: assignment.id, target_user_id: fixture.users[3].id })).json();
	await eventually(() => expect(recipient.messages.find(e => e.type === "trade_proposed")?.data).toEqual({ notification_id: proposal.notification_id, from_user: "Kid", assignment_id: assignment.id, chore_title: c.title }));
	expect((await fixture.http(`/api/calendar/trade/${proposal.notification_id}/accept`, "POST", 3)).status).toBe(200);
	await eventually(() => expect(proposer.messages.find(e => e.type === "trade_accepted")?.data).toMatchObject({ accepted_by: "Other", assignment_id: assignment.id, chore_title: c.title }));
	expect(recipient.messages.find(e => e.type === "trade_accepted")?.data).toEqual({ assignment_id: assignment.id, chore_title: c.title });
	const reverse = await (await fixture.http("/api/calendar/trade", "POST", 3, { assignment_id: assignment.id, target_user_id: fixture.users[2].id })).json();
	expect((await fixture.http(`/api/calendar/trade/${reverse.notification_id}/deny`, "POST", 2)).status).toBe(200);
	await eventually(() => expect(recipient.messages.find(e => e.type === "trade_denied")?.data).toMatchObject({ denied_by: "Kid", assignment_id: assignment.id, chore_title: c.title }));
});
it("broadcasts household events with reference payloads and rate-limits emote flooding", async () => {
	const kid = await fixture.socket(), other = await fixture.socket(3);
	expect((await fixture.http("/api/announcements", "POST", 0, { title: "Notice", message: "Synthetic household message" })).status).toBe(200);
	await eventually(() => expect(kid.messages.find(e => e.type === "announcement")?.data).toEqual({ title: "Notice", message: "Synthetic household message" }));
	expect((await fixture.http("/api/shoutouts", "POST", 2, { to_user_id: fixture.users[3].id, message: "Nice work", emoji: "star" })).status).toBe(201);
	await eventually(() => expect(other.messages.find(e => e.type === "shoutout")?.data).toEqual({ from_user_id: fixture.users[2].id, from_user_name: "Kid", to_user_id: fixture.users[3].id, to_user_name: "Other", message: "Nice work", emoji: "star" }));
	for (let i = 0; i < 10; i++)
		expect((await fixture.http("/api/emotes", "POST", 2, { emote: "wave" })).status).toBe(200);
	expect((await fixture.http("/api/emotes", "POST", 2, { emote: "wave" })).status).toBe(429);
});
it("drains an in-flight HTTP push test at shutdown without starting further device sends", async () => {
	for (const device of ["one", "two"])
		await fixture.http("/api/push/subscribe", "POST", 0, { endpoint: `https://fcm.googleapis.com/${device}`, keys: { p256dh: "fixture", auth: "fixture" } });
	let release!: () => void;
	sender.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
	const request = fixture.http("/api/push/test", "POST");
	await eventually(() => expect(release).toBeDefined());
	const closing = fixture.runtime.close(fixture.server);
	release();
	const response = await request;
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ detail: "Sent to 1/2 device(s)" });
	await closing;
	expect(sender).toHaveBeenCalledOnce();
});
it.each([0, -1])("preserves invalid legacy chore records without awarding or removing points (%s)", async (points) => {
	const c = await chore({ assigned_user_ids: [fixture.users[2].id] });
	await fixture.store.update("chores", c.id, { points });
	expect((await fixture.http(`/api/chores/${c.id}/complete`, "POST", 2)).status).toBe(200);
	expect((await fixture.http(`/api/chores/${c.id}/verify`, "POST")).status).toBe(400);
	expect((await fixture.store.one("users", fixture.users[2].id, "User")).points_balance).toBe(0);
	expect(await fixture.db.prisma.point_transactions.count()).toBe(0);
	expect((await fixture.store.rows("chore_assignments"))[0].status).toBe("completed");
	expect((await fixture.store.one("chores", c.id, "Chore")).points).toBe(points);
});
it.each([0, -1])("does not silently refund or transition an invalid legacy redemption (%s)", async (points_spent) => {
	const reward = await (await fixture.http("/api/rewards", "POST", 0, { title: "Legacy history", point_cost: 5 })).json();
	const row = await fixture.store.insert("reward_redemptions", { reward_id: reward.id, user_id: fixture.users[2].id, points_spent, status: "pending", approved_by: null, approved_at: null, fulfilled_by: null, fulfilled_at: null });
	for (const action of ["approve", "deny", "fulfill"])
		expect((await fixture.http(`/api/rewards/redemptions/${row.id}/${action}`, "POST")).status).toBe(400);
	expect((await fixture.store.one("users", fixture.users[2].id, "User")).points_balance).toBe(0);
	expect(await fixture.db.prisma.point_transactions.count()).toBe(0);
	expect(await fixture.store.one("reward_redemptions", Number(row.id), "Redemption")).toMatchObject({ status: "pending", points_spent });
});
