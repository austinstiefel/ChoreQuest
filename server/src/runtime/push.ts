import { createHash, randomUUID } from "node:crypto";
import { Agent } from "node:https";
import webpush from "web-push";
import { Prisma, type PrismaClient } from "@prisma/client";
import { BusinessError, Store, write, type Row } from "../business/store.js";
import { deleteState, getState, putState, pushJobPrefix, pushJobsFilter } from "./state.js";
import type { PushConfig, VapidKeys } from "./vapid.js";
export interface PushPayload {
	title: string;
	body: string;
	url: string;
	tag: string;
}
export interface Subscription {
	id: number;
	endpoint: string;
	p256dh: string;
	auth: string;
}
export type PushSender = (subscription: Subscription, payload: PushPayload, keys: VapidKeys, subject: string) => Promise<void>;
const urls: Record<string, string> = { chore_assigned: "/chores", chore_completed: "/", chore_verified: "/", achievement_unlocked: "/profile", bonus_points: "/", streak_milestone: "/", trade_proposed: "/calendar", trade_accepted: "/calendar", trade_denied: "/calendar", reward_approved: "/rewards", reward_denied: "/rewards", announcement: "/party", quest_feedback: "/" };
/** Known browser push services only: an authenticated subscription must not
 * turn the backend into a generic SSRF proxy. No redirects/proxies are used. */
export function validPushEndpoint(endpoint: string): boolean {
	try {
		const url = new URL(endpoint), host = url.hostname.toLowerCase();
		const allowed = ["fcm.googleapis.com", "android.googleapis.com", "push.services.mozilla.com", "updates.push.services.mozilla.com", "web.push.apple.com"];
		return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") && !url.hash && (allowed.includes(host) || host.endsWith(".push.services.mozilla.com") || host.endsWith(".notify.windows.com") || host.endsWith(".push.apple.com"));
	}
	catch {
		return false;
	}
}
export const sendWebPush: PushSender = async (subscription, payload, keys, subject) => {
	const agent = new Agent({ keepAlive: false });
	// web-push's timeout is an inactivity timeout; destroy this request's agent
	// as well to bound total delivery time, including slow/trickling responses.
	const deadline = setTimeout(() => agent.destroy(), 10000);
	deadline.unref();
	try {
		const response = await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, JSON.stringify(payload), {
			TTL: 86400, contentEncoding: "aes128gcm", timeout: 5000, agent,
			vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
		});
		if (response.statusCode < 200 || response.statusCode > 202)
			throw Object.assign(new Error("Push provider rejected delivery"), { statusCode: response.statusCode });
	}
	finally {
		clearTimeout(deadline);
		agent.destroy();
	}
};
interface Job {
	notification: number;
	subscription: number;
	notificationVersion: string;
	subscriptionVersion: string;
	attempts: number;
	next: number;
	created: number;
	token?: string;
}
const notificationVersion = (n: Row) => createHash("sha256").update(JSON.stringify([n.id, n.user_id, n.created_at, n.title, n.message])).digest("hex");
const subscriptionVersion = (s: Row) => createHash("sha256").update(JSON.stringify([s.id, s.user_id, s.created_at, s.endpoint, s.p256dh, s.auth])).digest("hex");
interface Claimed {
	key: string;
	job: Job;
	notification: Row;
	subscription: Subscription;
}
export class PushService {
	private readonly tasks = new Set<Promise<unknown>>();
	private stopping = false;
	private running?: Promise<void>;
	private readonly testBudgets = new Map<number, {
		start: number;
		count: number;
	}>();
	constructor(private readonly prisma: PrismaClient, private readonly keys: VapidKeys, private readonly config: PushConfig, private readonly sender: PushSender = sendWebPush) { }
	/** Persist IDs, not duplicated private payloads, in the same transaction as
	 * notifications. A crash before commit creates no jobs; after commit retries
	 * survive restart. Newly subscribed devices do not receive old notifications. */
	async prepare(store: Store): Promise<void> {
		for (const n of store.inserted.filter(r => r.table === "notifications").map(r => r.row)) {
			for (const s of await store.rows("push_subscriptions", Prisma.sql `WHERE user_id=${n.user_id}`)) {
				const key = `${pushJobPrefix}${n.id}.${s.id}`;
				await putState(store.db, key, { notification: Number(n.id), subscription: Number(s.id), notificationVersion: notificationVersion(n), subscriptionVersion: subscriptionVersion(s), attempts: 0, next: Date.now(), created: Date.now() } satisfies Job);
			}
		}
	}
	private async deliver(subscription: Subscription, payload: PushPayload): Promise<"sent" | "gone" | "retry" | "rejected"> {
		if (!validPushEndpoint(subscription.endpoint))
			return "rejected";
		try {
			await this.sender(subscription, payload, this.keys, this.config.subject);
			return "sent";
		}
		catch (error) {
			const status = Number((error as {
				statusCode?: number;
			})?.statusCode);
			if ([404, 410].includes(status))
				return "gone";
			if (status === 429 || status >= 500 || !status)
				return "retry";
			return "rejected";
		}
	}
	private async removeObsolete(store: Store, id: number, version: string): Promise<void> {
		const current = (await store.rows("push_subscriptions", Prisma.sql `WHERE id=${id}`))[0];
		if (current && subscriptionVersion(current) === version)
			await store.remove("push_subscriptions", id);
	}
	private async claim(now?: number): Promise<Claimed | "discarded" | null> {
		const store = await Store.open(this.prisma);
		return write(this.prisma, store, async (tx) => {
			const currentTime = now ?? Date.now();
			const [row] = await tx.db.$queryRaw<Array<{
				key: string;
				value: string;
			}>>(Prisma.sql `SELECT key,value FROM app_settings WHERE ${pushJobsFilter} AND json_extract(value,'$.next') <= ${currentTime} ORDER BY json_extract(value,'$.next'),key LIMIT 1`);
			if (!row)
				return null;
			const job = JSON.parse(row.value) as Job;
			const [n] = await tx.rows("notifications", Prisma.sql `WHERE id=${job.notification}`), [sub] = await tx.rows("push_subscriptions", Prisma.sql `WHERE id=${job.subscription}`);
			const user = n ? (await tx.rows("users", Prisma.sql `WHERE id=${n.user_id} AND is_active=1`))[0] : undefined;
			if (!n || !sub || !user || sub.user_id !== n.user_id || notificationVersion(n) !== job.notificationVersion || subscriptionVersion(sub) !== job.subscriptionVersion || currentTime - job.created >= 86400000 || job.attempts >= 4) {
				await deleteState(tx.db, row.key);
				return "discarded" as const;
			}
			job.attempts++;
			// Read the actual clock for EVERY lease, not just once per batch.
			// Earlier network attempts must not make later leases already expired.
			job.next = (now ?? Date.now()) + 60000;
			job.token = randomUUID();
			await putState(tx.db, row.key, job);
			return { key: row.key, job, notification: n, subscription: sub as unknown as Subscription };
		});
	}
	async processBatch(now?: number, limit = 20): Promise<void> {
		if (this.stopping)
			return;
		for (let i = 0; i < limit && !this.stopping; i++) {
			const claimed = await this.claim(now);
			if (!claimed)
				break;
			if (claimed === "discarded")
				continue;
			const n = claimed.notification;
			const outcome = await this.deliver(claimed.subscription, { title: String(n.title), body: String(n.message), url: urls[String(n.type)] ?? "/", tag: String(n.type || "chorequest") });
			const store = await Store.open(this.prisma);
			await write(this.prisma, store, async (tx) => {
				const current = await getState<Job>(tx.db, claimed.key);
				if (!current || current.token !== claimed.job.token)
					return;
				if (outcome === "gone")
					await this.removeObsolete(tx, claimed.subscription.id, claimed.job.subscriptionVersion);
				if (outcome === "retry" && current.attempts < 4) {
					current.next = (now ?? Date.now()) + 30000 * 2 ** (current.attempts - 1);
					delete current.token;
					await putState(tx.db, claimed.key, current);
				}
				else
					await deleteState(tx.db, claimed.key);
			});
			if (["retry", "rejected"].includes(outcome))
				console.warn("Push provider delivery failed; bounded retry policy applied");
		}
	}
	kick(): void {
		if (this.running || this.stopping)
			return;
		this.running = this.processBatch().catch(() => { console.warn("Push delivery worker failed; persisted jobs will be retried"); }).finally(() => { this.running = undefined; });
	}
	test(userId: number): Promise<number> {
		if (this.stopping)
			return Promise.reject(new BusinessError(503, "Push delivery is shutting down"));
		if (this.tasks.size >= 4)
			return Promise.reject(new BusinessError(429, "Too many push test requests"));
		const now = Date.now(), budget = this.testBudgets.get(userId);
		if (budget && now - budget.start < 60000 && budget.count >= 5)
			return Promise.reject(new BusinessError(429, "Too many push test requests"));
		if (!budget || now - budget.start >= 60000)
			this.testBudgets.set(userId, { start: now, count: 1 });
		else
			budget.count++;
		if (this.testBudgets.size > 1000)
			for (const [id, value] of this.testBudgets)
				if (now - value.start >= 60000)
					this.testBudgets.delete(id);
		const task = this.testUser(userId);
		this.tasks.add(task);
		void task.finally(() => this.tasks.delete(task)).catch(() => undefined);
		return task;
	}
	private async testUser(userId: number): Promise<number> {
		const store = await Store.open(this.prisma), subs = await store.rows("push_subscriptions", Prisma.sql `WHERE user_id=${userId}`);
		let sent = 0;
		for (const sub of subs) {
			if (this.stopping)
				break;
			const outcome = await this.deliver(sub as unknown as Subscription, { title: "ChoreQuest Test", body: "Push notifications are working!", url: "/", tag: "test" });
			if (outcome === "sent")
				sent++;
			if (outcome === "gone")
				await write(this.prisma, store, tx => this.removeObsolete(tx, Number(sub.id), subscriptionVersion(sub)));
		}
		return sent;
	}
	async stop(): Promise<void> { this.stopping = true; await Promise.allSettled([...(this.running ? [this.running] : []), ...this.tasks]); }
}
