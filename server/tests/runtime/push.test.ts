import { pythonExecutable } from "../helpers/python.js";
import { generateKeyPairSync } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { PrismaClient, Prisma } from "@prisma/client";
import webpush from "web-push";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initializeVapid, keyPair, loadPushConfig } from "../../src/runtime/vapid.js";
import { PushService, sendWebPush, validPushEndpoint, type PushSender } from "../../src/runtime/push.js";
import { deleteState, getState, pushJobPrefix, pushJobsFilter, putState } from "../../src/runtime/state.js";
import { Store, write } from "../../src/business/store.js";
import { notify } from "../../src/business/gamification.js";
import { newUserData } from "../../src/auth/accounts.js";
import { disposableDatabase } from "../helpers/sqlite.js";
let db: Awaited<ReturnType<typeof disposableDatabase>>, store: Store, push: PushService, user: number, sub: number;
const config = { subject: "mailto:fixture@example.com" }, sender = vi.fn<PushSender>(async () => undefined);
beforeEach(async () => {
	db = await disposableDatabase();
	store = await Store.open(db.prisma);
	sender.mockReset().mockResolvedValue(undefined);
	user = (await db.prisma.users.create({ data: newUserData({ username: "Fixture", displayName: "Fixture", role: "kid", passwordHash: "fixture" }) })).id;
	sub = Number((await store.insert("push_subscriptions", { user_id: user, endpoint: "https://fcm.googleapis.com/fixture", p256dh: "fixture-public", auth: "fixture-auth" })).id);
	push = new PushService(db.prisma, await initializeVapid(db.prisma, config), config, sender);
});
afterEach(async () => { await push.stop(); vi.restoreAllMocks(); await db.dispose(); });
async function enqueue(type = "achievement_unlocked") {
	return write(db.prisma, store, async (tx) => { const n = await notify(tx, user, type, "Synthetic title", "Synthetic private message"); await push.prepare(tx); return n; });
}
const jobs = () => db.prisma.$queryRaw<Array<{
	key: string;
	value: string;
}>>(Prisma.sql `SELECT key,value FROM app_settings WHERE ${pushJobsFilter}`);
it("generates Python-readable P-256 keys once and preserves them across restarts/concurrent initialization", async () => {
	const before = await db.prisma.$queryRaw `SELECT key,value,CAST(updated_at AS TEXT) AS updated_at FROM app_settings ORDER BY key`;
	const second = new PrismaClient({ datasources: { db: { url: `file:${db.databasePath.replaceAll("\\", "/")}?connection_limit=1` } } });
	try {
		const pairs = await Promise.all([initializeVapid(db.prisma, config), initializeVapid(second, config)]);
		expect(pairs[0]).toEqual(pairs[1]);
	}
	finally {
		await second.$disconnect();
	}
	expect(await db.prisma.$queryRaw `SELECT key,value,CAST(updated_at AS TEXT) AS updated_at FROM app_settings ORDER BY key`).toEqual(before);
	const result = await promisify(execFile)(pythonExecutable, ["-B", "-c", [
			"import sys,sqlite3,base64",
			"from cryptography.hazmat.primitives import serialization",
			"db=sqlite3.connect(sys.argv[1])",
			"keys=dict(db.execute(\"select key,value from app_settings where key in ('vapid_private_key','vapid_public_key')\"))",
			"key=serialization.load_pem_private_key(keys['vapid_private_key'].encode(),password=None)",
			"public=key.public_key().public_bytes(serialization.Encoding.X962,serialization.PublicFormat.UncompressedPoint)",
			"assert key.curve.name=='secp256r1'",
			"assert base64.urlsafe_b64encode(public).rstrip(b'=').decode()==keys['vapid_public_key']",
			"print('Python VAPID compatible')",
		].join("\n"), db.databasePath], { windowsHide: true });
	expect(result.stdout).toContain("Python VAPID compatible");
});
it("accepts Python-compatible PEM, raw scalar and DER private key representations", () => {
	const privateKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey, pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString(), pair = keyPair(pem);
	expect(keyPair(pair.privateKey, pair.publicKey)).toEqual(pair);
	for (const type of ["pkcs8", "sec1"] as const)
		expect(keyPair(privateKey.export({ format: "der", type }).toString("base64url"), pair.publicKey)).toEqual(pair);
	expect(() => keyPair(generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString())).toThrow("Invalid VAPID key configuration");
});
it.each(["missing-private", "invalid-private", "mismatch"])("repairs %s stored keys atomically and persists the replacement", async (mode) => {
	if (mode === "missing-private")
		await db.prisma.app_settings.delete({ where: { key: "vapid_private_key" }, select: { key: true } });
	if (mode === "invalid-private")
		await db.prisma.app_settings.update({ where: { key: "vapid_private_key" }, data: { value: "synthetic-unreadable" }, select: { key: true } });
	if (mode === "mismatch")
		await db.prisma.app_settings.update({ where: { key: "vapid_public_key" }, data: { value: "synthetic-mismatch" }, select: { key: true } });
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const pair = await initializeVapid(db.prisma, config);
	expect(await initializeVapid(db.prisma, config)).toEqual(pair);
	expect(await db.prisma.app_settings.count({ where: { key: { in: ["vapid_private_key", "vapid_public_key"] } } })).toBe(2);
});
it("validates environment overrides and never exposes configuration contents in errors", async () => {
	const pair = await initializeVapid(db.prisma, config), before = await db.prisma.$queryRaw `SELECT key,value,CAST(updated_at AS TEXT) AS updated_at FROM app_settings ORDER BY key`;
	expect(loadPushConfig({})).toEqual({ subject: "mailto:admin@example.com", privateKey: undefined, publicKey: undefined });
	expect(await initializeVapid(db.prisma, loadPushConfig({ VAPID_PRIVATE_KEY: pair.privateKey, VAPID_PUBLIC_KEY: pair.publicKey, VAPID_CLAIM_EMAIL: "https://example.com/contact" }))).toEqual(pair);
	for (const env of [{ VAPID_PRIVATE_KEY: "private-secret" }, { VAPID_PRIVATE_KEY: "private-secret", VAPID_PUBLIC_KEY: "public-secret" }, { VAPID_CLAIM_EMAIL: "invalid-secret" }]) {
		expect(() => loadPushConfig(env)).toThrow();
		try {
			loadPushConfig(env);
			throw new Error("Expected config rejection");
		}
		catch (error) {
			expect(String(error)).not.toMatch(/private-secret|public-secret|invalid-secret/);
		}
	}
	expect(await db.prisma.$queryRaw `SELECT key,value,CAST(updated_at AS TEXT) AS updated_at FROM app_settings ORDER BY key`).toEqual(before);
});
it("persists delivery IDs with the notification commit, but none on rollback", async () => {
	await expect(write(db.prisma, store, async (tx) => { await notify(tx, user, "bonus_points", "fixture", "private-body"); await push.prepare(tx); throw new Error("injected"); })).rejects.toThrow("injected");
	expect(await jobs()).toEqual([]);
	expect(await db.prisma.notifications.count()).toBe(0);
	await enqueue();
	const all = await jobs();
	expect(all).toHaveLength(1);
	expect(all[0].value).not.toContain("Synthetic private message");
});
it("delivers correct payloads to every current subscription with notification-type routing", async () => {
	await store.insert("push_subscriptions", { user_id: user, endpoint: "https://web.push.apple.com/fixture", p256dh: "second", auth: "second" });
	await enqueue();
	await push.processBatch();
	expect(sender).toHaveBeenCalledTimes(2);
	expect(sender.mock.calls[0][1]).toEqual({ title: "Synthetic title", body: "Synthetic private message", url: "/profile", tag: "achievement_unlocked" });
	expect(await jobs()).toEqual([]);
});
it.each([404, 410])("removes provider-expired subscriptions (%s) rather than retrying", async (statusCode) => {
	sender.mockRejectedValue({ statusCode });
	await enqueue();
	await push.processBatch();
	expect(await db.prisma.push_subscriptions.count()).toBe(0);
	expect(await jobs()).toEqual([]);
});
it.each([429, 500, 503, 0])("retains subscriptions and retries temporary delivery failures across restart (%s)", async (statusCode) => {
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	sender.mockRejectedValueOnce(statusCode ? { statusCode } : new Error("private transport detail"));
	await enqueue("chore_completed");
	const now = Date.now() + 1;
	await push.processBatch(now);
	expect(sender).toHaveBeenCalledTimes(1);
	expect(await jobs()).toHaveLength(1);
	await push.stop();
	push = new PushService(db.prisma, await initializeVapid(db.prisma, config), config, sender);
	await push.processBatch(now + 29999);
	expect(sender).toHaveBeenCalledTimes(1);
	await push.processBatch(now + 30000);
	expect(sender).toHaveBeenCalledTimes(2);
	expect(await jobs()).toEqual([]);
});
it("bounds retries and emits only generic warnings", async () => {
	const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	sender.mockRejectedValue(new Error("private payload/endpoint/key"));
	await enqueue();
	const now = Date.now() + 1;
	for (const offset of [0, 30000, 90000, 210000, 500000])
		await push.processBatch(now + offset);
	expect(sender).toHaveBeenCalledTimes(4);
	expect(await jobs()).toEqual([]);
	expect(await db.prisma.push_subscriptions.count()).toBe(1);
	expect(JSON.stringify(warning.mock.calls)).not.toContain("private payload");
	expect(warning.mock.calls.flat()).toContain("Push retry limit reached; queued delivery removed");
});
it("claims push jobs across independent database connections without concurrent duplicates", async () => {
	await enqueue();
	const second = new PrismaClient({ datasources: { db: { url: `file:${db.databasePath.replaceAll("\\", "/")}?connection_limit=1` } } });
	const worker = new PushService(second, await initializeVapid(second, config), config, sender);
	try {
		await Promise.all([push.processBatch(), worker.processBatch()]);
		expect(sender).toHaveBeenCalledTimes(1);
	}
	finally {
		await worker.stop();
		await second.$disconnect();
	}
});
it("recovers abandoned leases and expires stale jobs without replaying historical notifications", async () => {
	const n = await enqueue(), key = `${pushJobPrefix}${n.id}.${sub}`, now = Date.now();
	const original = await getState<Record<string, unknown>>(db.prisma, key);
	await putState(db.prisma, key, { ...original, attempts: 1, next: now + 30000, created: now, token: "abandoned-process" });
	await push.processBatch(now);
	expect(sender).not.toHaveBeenCalled();
	await push.processBatch(now + 30000);
	expect(sender).toHaveBeenCalledOnce();
	await putState(db.prisma, key, { ...original, attempts: 0, next: now, created: now - 86400000 });
	await push.processBatch(now);
	expect(sender).toHaveBeenCalledOnce();
	expect(await jobs()).toEqual([]);
});
it("honors opt-out, inactive accounts and deleted notification ownership without sending", async () => {
	await enqueue();
	await store.update("users", user, { is_active: false });
	await push.processBatch();
	expect(sender).not.toHaveBeenCalled();
	await store.update("users", user, { is_active: true });
	await enqueue();
	await store.remove("push_subscriptions", sub);
	await push.processBatch();
	expect(sender).not.toHaveBeenCalled();
	expect(await jobs()).toEqual([]);
});
it("never retries permanent provider rejection and reports zero successful test deliveries", async () => {
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	sender.mockRejectedValue({ statusCode: 403 });
	await enqueue();
	await push.processBatch();
	expect(await jobs()).toEqual([]);
	expect(await push.test(user)).toBe(0);
	expect(await db.prisma.push_subscriptions.count()).toBe(1);
});
it.each(["http://fcm.googleapis.com/a", "https://localhost/a", "https://127.0.0.1/a", "https://fcm.googleapis.com.attacker.example/a", "https://user:secret@fcm.googleapis.com/a", "https://fcm.googleapis.com:444/a"])("blocks arbitrary/private push URLs before any provider call: %s", async (endpoint) => {
	expect(validPushEndpoint(endpoint)).toBe(false);
	await store.update("push_subscriptions", sub, { endpoint });
	expect(await push.test(user)).toBe(0);
	expect(sender).not.toHaveBeenCalled();
});
it("uses actual web-push encryption configuration through a mocked provider, never real network", async () => {
	const provider = vi.spyOn(webpush, "sendNotification").mockResolvedValue({ statusCode: 201, body: "", headers: {} }), keys = await initializeVapid(db.prisma, config);
	await sendWebPush({ id: sub, endpoint: "https://fcm.googleapis.com/fixture", p256dh: "fixture", auth: "fixture" }, { title: "Synthetic", body: "Synthetic", url: "/", tag: "test" }, keys, config.subject);
	expect(provider).toHaveBeenCalledOnce();
	expect(provider.mock.calls[0][2]).toMatchObject({ TTL: 86400, contentEncoding: "aes128gcm", timeout: 5000, vapidDetails: { subject: config.subject, publicKey: keys.publicKey, privateKey: keys.privateKey } });
});
it("waits for an in-flight push at shutdown and rejects new test sends", async () => {
	let release!: () => void;
	sender.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
	const test = push.test(user);
	await vi.waitFor(() => expect(release).toBeDefined());
	let stopped = false;
	const stopping = push.stop().then(() => { stopped = true; });
	expect(stopped).toBe(false);
	release();
	expect(await test).toBe(1);
	await stopping;
	await expect(push.test(user)).rejects.toMatchObject({ status: 503 });
});
it("drops stale jobs when legacy row IDs are reused with a different subscription or notification", async () => {
	const n = await enqueue();
	await store.update("push_subscriptions", sub, { endpoint: "https://fcm.googleapis.com/replacement" });
	await push.processBatch();
	expect(sender).not.toHaveBeenCalled();
	await enqueue();
	await db.prisma.$executeRaw `UPDATE notifications SET message='replaced legacy record'`;
	await push.processBatch();
	expect(sender).not.toHaveBeenCalled();
	expect(await jobs()).toEqual([]);
});
it("limits provider test traffic and rejects a resolved-but-rejected provider response", async () => {
	for (let i = 0; i < 5; i++)
		expect(await push.test(user)).toBe(1);
	await expect(push.test(user)).rejects.toMatchObject({ status: 429 });
	vi.spyOn(webpush, "sendNotification").mockResolvedValue({ statusCode: 503, body: "provider details must not escape", headers: {} });
	const keys = await initializeVapid(db.prisma, config);
	await expect(sendWebPush({ id: sub, endpoint: "https://fcm.googleapis.com/fixture", p256dh: "fixture", auth: "fixture" }, { title: "fixture", body: "fixture", url: "/", tag: "test" }, keys, config.subject)).rejects.toMatchObject({ statusCode: 503 });
});
it("gives later jobs fresh leases after a slow earlier attempt instead of reusing the batch start time", async () => {
	await store.insert("push_subscriptions", { user_id: user, endpoint: "https://fcm.googleapis.com/second", p256dh: "second", auth: "second" });
	await enqueue();
	let clock = Date.now() + 1, release!: () => void, count = 0;
	vi.spyOn(Date, "now").mockImplementation(() => clock);
	sender.mockImplementation(async () => { if (++count === 1)
		clock += 65000;
	else
		await new Promise<void>(resolve => { release = resolve; }); });
	const batch = push.processBatch();
	await vi.waitFor(() => expect(release).toBeDefined());
	try {
		const remaining = await jobs();
		expect(JSON.parse(remaining[0].value).next).toBe(clock + 60000);
	}
	finally {
		release();
		await batch;
	}
});
it("does not delete a subscription refreshed while an obsolete provider request was in flight", async () => {
	sender.mockImplementationOnce(async () => { await store.update("push_subscriptions", sub, { auth: "refreshed-during-queue-send" }); throw { statusCode: 410 }; });
	await enqueue();
	await push.processBatch();
	expect(await db.prisma.push_subscriptions.count()).toBe(1);
	sender.mockImplementationOnce(async () => { await store.update("push_subscriptions", sub, { auth: "refreshed-during-test-send" }); throw { statusCode: 404 }; });
	expect(await push.test(user)).toBe(0);
	expect((await store.one("push_subscriptions", sub, "Subscription")).auth).toBe("refreshed-during-test-send");
});
