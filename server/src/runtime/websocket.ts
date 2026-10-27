import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { AuthConfig } from "../config/auth.js";
import { decodeAccessToken } from "../auth/tokens.js";
import type { AuthUserRepository } from "../middleware/auth.js";
import type { Row } from "../business/store.js";
export interface SocketEvent {
	message: {
		type: string;
		data: Row;
	};
	userId?: number;
	excludeUser?: number;
}
interface Connection {
	socket: WebSocket;
	userId: number;
	expires: number;
	alive: boolean;
	messages: number;
}
export class SocketHub {
	private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false, handleProtocols: protocols => protocols.has("chorequest") ? "chorequest" : false });
	private readonly connections = new Set<Connection>();
	private readonly pending = new Set<Promise<void>>();
	private timer?: NodeJS.Timeout;
	private stopping = false;
	private checking?: Promise<void>;
	constructor(private readonly config: AuthConfig, private readonly users: AuthUserRepository) { }
	get size() { return this.connections.size; }
	private originAllowed(request: IncomingMessage): boolean {
		const origin = request.headers.origin;
		if (!origin)
			return true; // native clients still require a valid token
		try {
			const url = new URL(origin);
			return ["http:", "https:"].includes(url.protocol) && (url.host === request.headers.host || this.config.corsOrigins.includes(origin) || this.config.corsOrigins.includes("*"));
		}
		catch {
			return false;
		}
	}
	attach(server: Server, intervalMs = 30000): void {
		server.on("upgrade", this.upgrade);
		this.timer = setInterval(() => { void this.heartbeat(); }, intervalMs);
		this.timer.unref();
	}
	private upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
		const task = this.accept(request, socket, head).catch(() => { socket.destroy(); console.warn("WebSocket connection initialization failed"); });
		this.pending.add(task);
		void task.finally(() => this.pending.delete(task));
	};
	private async accept(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
		socket.on("error", () => undefined);
		if ("setTimeout" in socket)
			(socket as import("node:net").Socket).setTimeout(10000, () => socket.destroy());
		const reject = (status: number) => { if (!socket.destroyed)
			socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
		if (this.stopping || this.connections.size >= 256 || this.pending.size >= 256)
			return reject(503);
		if (!this.originAllowed(request))
			return reject(403);
		const url = new URL(request.url ?? "", "http://localhost"), match = /^\/ws\/([1-9]\d*)$/.exec(url.pathname);
		if (!match)
			return reject(404);
		const protocols = request.headers["sec-websocket-protocol"]?.split(",").map(p => p.trim()) ?? [];
		// Retain Python query-token clients, but prefer a non-echoed subprotocol
		// credential so the React client no longer places secrets in URLs.
		const token = protocols.find(p => p.startsWith("bearer."))?.slice(7) ?? url.searchParams.get("token");
		const claims = token && token.length <= 8192 ? await decodeAccessToken(token, this.config) : null;
		if (!claims || claims.sub !== match[1] || !Number.isSafeInteger(Number(claims.sub)))
			return reject(401);
		const userId = Number(claims.sub), user = await this.users.findUserById(userId);
		if (!user?.is_active || this.stopping)
			return reject(401);
		if (this.connections.size >= 256 || [...this.connections].filter(c => c.userId === userId).length >= 8)
			return reject(429);
		this.wss.handleUpgrade(request, socket, head, ws => {
			if ("setTimeout" in socket)
				(socket as import("node:net").Socket).setTimeout(0);
			const connection: Connection = { socket: ws, userId, expires: claims.exp, alive: true, messages: 0 };
			this.connections.add(connection);
			ws.on("pong", () => { connection.alive = true; });
			ws.on("message", () => { if (++connection.messages > 30)
				ws.close(1008, "Client messages are not supported"); });
			ws.on("close", () => this.connections.delete(connection));
			ws.on("error", () => { this.connections.delete(connection); ws.terminate(); });
		});
	}
	heartbeat(): Promise<void> {
		if (this.stopping)
			return Promise.resolve();
		if (this.checking)
			return this.checking;
		this.checking = (async () => {
			for (const connection of [...this.connections]) {
				try {
					const user = await this.users.findUserById(connection.userId);
					if (!user?.is_active || connection.expires <= Date.now() / 1000) {
						if (connection.socket.readyState === WebSocket.OPEN)
							connection.socket.close(4001, "Authentication expired");
						else
							connection.socket.terminate();
						continue;
					}
					if (!connection.alive) {
						connection.socket.terminate();
						continue;
					}
					connection.alive = false;
					connection.messages = 0;
					connection.socket.ping();
				}
				catch {
					connection.socket.terminate();
					console.warn("WebSocket authentication check failed");
				}
			}
		})().finally(() => { this.checking = undefined; });
		return this.checking;
	}
	async publish(events: SocketEvent[]): Promise<void> {
		for (const event of events) {
			const data = JSON.stringify(event.message);
			for (const connection of [...this.connections]) {
				if (event.userId !== undefined && event.userId !== connection.userId || event.excludeUser === connection.userId)
					continue;
				try {
					const user = await this.users.findUserById(connection.userId);
					if (!user?.is_active || connection.expires <= Date.now() / 1000) {
						connection.socket.close(4001, "Authentication expired");
						continue;
					}
					if (connection.socket.bufferedAmount > 262144) {
						connection.socket.terminate();
						continue;
					}
					if (connection.socket.readyState === WebSocket.OPEN)
						connection.socket.send(data, error => { if (error)
							connection.socket.terminate(); });
				}
				catch {
					connection.socket.terminate();
					console.warn("WebSocket delivery failed");
				}
			}
		}
	}
	async close(): Promise<void> {
		this.stopping = true;
		clearInterval(this.timer);
		await Promise.allSettled([...this.pending, ...(this.checking ? [this.checking] : [])]);
		for (const connection of this.connections)
			connection.socket.close(1001, "Server shutting down");
		const deadline = setTimeout(() => { for (const connection of this.connections)
			connection.socket.terminate(); }, 1000);
		deadline.unref();
		await new Promise<void>(resolve => this.wss.close(() => resolve()));
		clearTimeout(deadline);
		this.connections.clear();
	}
}
