import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
// @ts-expect-error The unchanged frontend toolchain uses JavaScript, not TS declarations.
import { connectAccountSocket } from "../../../frontend/src/api/socketConnection.js";
class FakeSocket {
	static instances: FakeSocket[] = [];
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((event: {
		data: string;
	}) => void) | null = null;
	constructor(readonly url: string, readonly protocols: string[]) { FakeSocket.instances.push(this); }
	close = vi.fn(() => this.onclose?.());
}
beforeEach(() => { vi.useFakeTimers(); FakeSocket.instances = []; });
afterEach(() => vi.useRealTimers());
function connection(extra: Record<string, unknown> = {}) {
	const message = vi.fn(), connected = vi.fn(), expired = vi.fn(), refresh = vi.fn(async () => undefined);
	const stop = connectAccountSocket({ userId: 3, location: { protocol: "https:", host: "frontend.example" }, WebSocket: FakeSocket, getToken: () => "synthetic-token", refreshToken: refresh, onMessage: message, onConnection: connected, onExpired: expired, ...extra });
	return { stop, message, connected, expired, refresh };
}
it("keeps JWT credentials out of socket URLs and reconciles views after connection", () => {
	const state = connection(), socket = FakeSocket.instances[0];
	expect(socket.url).toBe("wss://frontend.example/ws/3");
	expect(socket.url).not.toContain("synthetic-token");
	expect(socket.protocols).toEqual(["chorequest", "bearer.synthetic-token"]);
	socket.onopen?.();
	expect(state.connected).toHaveBeenCalledWith(true);
	expect(state.message).toHaveBeenCalledWith({ type: "data_changed", data: { entity: "connection" } });
	state.stop();
});
it("refreshes credentials before reconnect and forwards parsed events", async () => {
	const state = connection();
	FakeSocket.instances[0].onclose?.();
	await vi.advanceTimersByTimeAsync(1000);
	expect(state.refresh).toHaveBeenCalledOnce();
	expect(FakeSocket.instances).toHaveLength(2);
	FakeSocket.instances[1].onmessage?.({ data: JSON.stringify({ type: "chore_verified", data: { points: 10 } }) });
	expect(state.message).toHaveBeenCalledWith({ type: "chore_verified", data: { points: 10 } });
	FakeSocket.instances[1].onmessage?.({ data: "malformed" });
	expect(state.message).toHaveBeenCalledOnce();
	state.stop();
});
it("never reconnects after unmount, including an in-flight refresh race", async () => {
	let release!: () => void;
	const state = connection({ refreshToken: () => new Promise<void>(resolve => { release = resolve; }) });
	FakeSocket.instances[0].onclose?.();
	await vi.advanceTimersByTimeAsync(1000);
	expect(release).toBeDefined();
	state.stop();
	release();
	await vi.advanceTimersByTimeAsync(60000);
	expect(FakeSocket.instances).toHaveLength(1);
});
it("cancels pending reconnects and ignores obsolete socket messages on account changes", async () => {
	const old = connection();
	const obsolete = FakeSocket.instances[0].onmessage;
	FakeSocket.instances[0].onclose?.();
	old.stop();
	const next = connection({ userId: 4 });
	await vi.advanceTimersByTimeAsync(60000);
	obsolete?.({ data: '{"type":"private-old-account"}' });
	expect(old.message).not.toHaveBeenCalled();
	expect(FakeSocket.instances).toHaveLength(2);
	next.stop();
});
it("bounds exponential reconnect delay at thirty seconds", async () => {
	const state = connection();
	for (let i = 0; i < 8; i++) {
		const count = FakeSocket.instances.length;
		FakeSocket.instances.at(-1)!.onclose?.();
		const wait = Math.min(1000 * 2 ** i, 30000);
		await vi.advanceTimersByTimeAsync(wait - 1);
		expect(FakeSocket.instances).toHaveLength(count);
		await vi.advanceTimersByTimeAsync(1);
		expect(FakeSocket.instances).toHaveLength(count + 1);
	}
	state.stop();
});
it("signals expired authentication without creating an anonymous socket", async () => {
	let token: string | null = "fixture";
	const state = connection({ getToken: () => token, refreshToken: async () => { token = null; throw new Error("expired"); } });
	FakeSocket.instances[0].onclose?.();
	await vi.advanceTimersByTimeAsync(1000);
	expect(state.expired).toHaveBeenCalledOnce();
	expect(FakeSocket.instances).toHaveLength(1);
	state.stop();
});
it("does not connect before authentication or when an account is absent", () => {
	connection({ userId: undefined }).stop();
	connection({ getToken: () => null }).stop();
	expect(FakeSocket.instances).toEqual([]);
});
it("delivers backend push payloads through the actual service worker and handles notification navigation", async () => {
	const handlers = new Map<string, (event: any) => void>(), showNotification = vi.fn(async () => undefined), navigate = vi.fn(), focus = vi.fn(), waits: Promise<unknown>[] = [];
	const context = { self: { addEventListener: (name: string, fn: (e: any) => void) => handlers.set(name, fn), registration: { showNotification }, location: { origin: "https://frontend.example" } }, clients: { matchAll: async () => [{ url: "https://frontend.example/", navigate, focus }], openWindow: vi.fn() }, caches: {} };
	vm.runInNewContext(await readFile(new URL("../../../frontend/public/sw.js", import.meta.url), "utf8"), context);
	handlers.get("push")!({ data: { json: () => ({ title: "Quest Approved!", body: "Synthetic notification", tag: "chore_verified", url: "/profile" }) }, waitUntil: (promise: Promise<unknown>) => waits.push(promise) });
	await Promise.all(waits);
	expect(showNotification).toHaveBeenCalledWith("Quest Approved!", expect.objectContaining({ body: "Synthetic notification", tag: "chore_verified", data: { url: "/profile" }, icon: "/icon-192.png" }));
	handlers.get("notificationclick")!({ notification: { close: vi.fn(), data: { url: "/profile" } }, waitUntil: (promise: Promise<unknown>) => waits.push(promise) });
	await Promise.all(waits);
	expect(navigate).toHaveBeenCalledWith("/profile");
	expect(focus).toHaveBeenCalledOnce();
});
