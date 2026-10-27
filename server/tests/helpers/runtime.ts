import { createServer } from "node:http";
import { once } from "node:events";
import { resolve } from "node:path";
import { WebSocket } from "ws";
import type { users as PrismaUser } from "@prisma/client";
import { newUserData } from "../../src/auth/accounts.js";
import { createAccessToken } from "../../src/auth/tokens.js";
import { loadAuthConfig } from "../../src/config/auth.js";
import { Store } from "../../src/business/store.js";
import { UploadStorage } from "../../src/business/uploads.js";
import { createRuntime } from "../../src/runtime/index.js";
import type { PushSender } from "../../src/runtime/push.js";
import { disposableDatabase } from "./sqlite.js";
export async function runtimeFixture(sender: PushSender = async () => undefined, staticDirectory?: string) {
	const db = await disposableDatabase(), store = await Store.open(db.prisma);
	const config = loadAuthConfig({ SECRET_KEY: "phase-five-disposable-fixture-only", CORS_ORIGINS: "https://frontend.example" });
	const users: PrismaUser[] = [];
	for (const [username, role] of [["Admin", "admin"], ["Parent", "parent"], ["Kid", "kid"], ["Other", "kid"]])
		users.push(await db.prisma.users.create({ data: newUserData({ username, displayName: username, role, passwordHash: "unusable-test-only" }) }));
	const tokens = await Promise.all(users.map(u => createAccessToken(u.id, u.role, config)));
	const category = await store.insert("chore_categories", { name: "Fixture", icon: "star", colour: "#123456", is_default: false });
	const runtime = await createRuntime(db.prisma, config, { uploads: new UploadStorage(resolve(db.directory, "uploads")), pushConfig: { subject: "mailto:fixture@example.com" }, sender, dailyHour: 0, staticDirectory });
	const server = createServer(runtime.app);
	await runtime.start(server, false);
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing test listener");
	const base = `http://127.0.0.1:${address.port}`;
	async function http(path: string, method = "GET", user = 0, body?: unknown) { return fetch(base + path, { method, headers: { Authorization: `Bearer ${tokens[user]}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); }
	async function socket(user = 2, query = false) {
		const endpoint = base.replace("http:", "ws:") + `/ws/${users[user].id}`;
		const ws = query ? new WebSocket(endpoint + `?token=${tokens[user]}`, { origin: "https://frontend.example" }) : new WebSocket(endpoint, ["chorequest", `bearer.${tokens[user]}`], { origin: "https://frontend.example" });
		const messages: Array<{
			type: string;
			data: Record<string, unknown>;
		}> = [];
		ws.on("message", data => messages.push(JSON.parse(String(data))));
		await once(ws, "open");
		return { ws, messages };
	}
	return { db, store, config, users, tokens, category, runtime, server, base, http, socket, async dispose() { await runtime.close(server); await db.dispose(); } };
}
