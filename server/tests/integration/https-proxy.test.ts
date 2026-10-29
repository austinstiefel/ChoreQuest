import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer, request as upstreamRequest, type Server } from "node:http";
import { createServer as createTlsServer, request as tlsRequest, type Server as TlsServer } from "node:https";
import type { Duplex } from "node:stream";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { WebSocket } from "ws";
import { SignJWT } from "jose";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { disposableDatabase } from "../helpers/sqlite.js";
import { pythonExecutable } from "../helpers/python.js";
import { loadAuthConfig } from "../../src/config/auth.js";
import { hashPassword } from "../../src/auth/passwords.js";
import { insertAccount } from "../../src/auth/accounts.js";
// Exercise the production build, not a replacement auth or socket implementation.
// @ts-expect-error Production JS intentionally has no generated declarations.
import { createRuntime } from "../../dist/runtime/index.js";
// @ts-expect-error Production JS intentionally has no generated declarations.
import { UploadStorage } from "../../dist/business/uploads.js";

// All listeners are ephemeral loopback, state/certificates disposable, push
// injected. This proves a Node TLS proxy contract, NOT NPM/browser acceptance.
const execute = promisify(execFile);
const config = loadAuthConfig({ SECRET_KEY: "phase-seven-proxy-test-only", COOKIE_SECURE: "true", CORS_ORIGINS: "" });
const password = "Phase7-fixture-only!";
let db: Awaited<ReturnType<typeof disposableDatabase>>, runtime: Awaited<ReturnType<typeof createRuntime>>;
let backend: Server, proxy: TlsServer, backendPort: number, base: string, ca: Buffer;
const sessions: Array<{ id: number; token: string; cookie: string }> = [];
const sockets = new Set<Duplex>(), clients = new Set<WebSocket>();
const accessLog: string[] = [];
const port = (server: Server) => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing disposable listener");
  return address.port;
};
async function startBackend() {
  runtime = await createRuntime(db.prisma, config, {
    uploads: new UploadStorage(resolve(db.directory, "uploads")), staticDirectory: resolve(db.directory, "public"),
    pushConfig: { subject: "mailto:fixture@example.invalid" }, sender: async () => { throw new Error("Unexpected push in TLS fixture"); },
  });
  backend = createServer(runtime.app);
  await runtime.start(backend, false);
  await new Promise<void>(done => backend.listen(0, "127.0.0.1", done));
  backendPort = port(backend);
}
async function http(path: string, method = "GET", token?: string, body?: unknown, cookie?: string) {
  return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; text: string; json: () => any }>((done, fail) => {
    const request = tlsRequest(base + path, { ca, method, agent: false, timeout: 5000, headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    } }, response => {
      let text = "";
      response.on("data", chunk => { text += String(chunk); });
      response.on("end", () => done({ status: response.statusCode!, headers: response.headers, text, json: () => JSON.parse(text) }));
      response.on("error", fail);
    });
    request.on("timeout", () => request.destroy(new Error("TLS fixture request timeout")));
    request.on("error", fail);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function socket(user = 2, token = sessions[user].token, origin = base, query = false) {
  const endpoint = base.replace("https:", "wss:") + `/ws/${sessions[user].id}`;
  const ws = new WebSocket(endpoint + (query ? `?token=${token}` : ""), query ? [] : ["chorequest", `bearer.${token}`], { ca, origin, handshakeTimeout: 5000 });
  clients.add(ws);
  const messages: Array<{ type: string; data: Record<string, unknown> }> = [];
  ws.on("message", data => messages.push(JSON.parse(String(data))));
  ws.on("error", () => undefined);
  const status = await new Promise<number>((done, fail) => {
    ws.once("open", () => done(101));
    ws.once("unexpected-response", (_request, response) => { response.resume(); ws.terminate(); done(response.statusCode!); });
    ws.once("error", fail);
  });
  return { ws, messages, status };
}
beforeAll(async () => {
  db = await disposableDatabase();
  // Existing Python environment/dependencies; no openssl install, OS trust
  // changes, real domain, or NODE_TLS_REJECT_UNAUTHORIZED override.
  await execute(pythonExecutable, ["-B", "-c", [
    "import sys,ipaddress", "from pathlib import Path", "from datetime import datetime,timedelta,timezone",
    "from cryptography import x509", "from cryptography.x509.oid import NameOID",
    "from cryptography.hazmat.primitives import hashes,serialization", "from cryptography.hazmat.primitives.asymmetric import rsa",
    "key=rsa.generate_private_key(public_exponent=65537,key_size=2048)",
    "name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'disposable-proxy-fixture')])", "now=datetime.now(timezone.utc)",
    "cert=x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(days=1)).not_valid_after(now+timedelta(days=1)).add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]),critical=False).sign(key,hashes.SHA256())",
    "for filename,data in [('tls.key',key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption())),('tls.crt',cert.public_bytes(serialization.Encoding.PEM))]:",
    " path=Path(sys.argv[1])/filename; path.write_bytes(data); path.chmod(0o600)",
  ].join("\n"), db.directory]);
  ca = await readFile(resolve(db.directory, "tls.crt"));
  await mkdir(resolve(db.directory, "public"));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(resolve(db.directory, "public/index.html"), "<html>synthetic HTTPS fixture</html>");
  const hash = await hashPassword(password);
  for (const [username, role] of [["Admin", "admin"], ["Parent", "parent"], ["Kid", "kid"], ["Other", "kid"]]) {
    const id = await db.prisma.$transaction(tx => insertAccount(tx, { username, displayName: username, role, passwordHash: hash }));
    sessions.push({ id, token: "", cookie: "" });
  }
  await startBackend();
  proxy = createTlsServer({ key: await readFile(resolve(db.directory, "tls.key")), cert: ca }, (request, response) => {
    // Deliberately narrow synthetic logs. NPM's actual generated log settings
    // must be checked separately: this does not configure or test NPM logging.
    accessLog.push(`${request.method} ${new URL(request.url!, base).pathname}`);
    const upstream = upstreamRequest({ hostname: "127.0.0.1", port: backendPort, path: request.url, method: request.method, headers: request.headers }, incoming => {
      response.writeHead(incoming.statusCode!, incoming.headers); incoming.pipe(response);
    });
    upstream.on("error", () => { response.writeHead(502); response.end(); });
    request.pipe(upstream);
  });
  proxy.on("connection", connection => { sockets.add(connection); connection.on("close", () => sockets.delete(connection)); });
  proxy.on("upgrade", (request, connection, head) => {
    accessLog.push(`${request.method} ${new URL(request.url!, base).pathname}`);
    const upstream = upstreamRequest({ hostname: "127.0.0.1", port: backendPort, path: request.url, headers: request.headers });
    upstream.on("upgrade", (response, peer, upstreamHead) => {
      connection.write(`HTTP/1.1 101 Switching Protocols\r\n${response.rawHeaders.reduce((s, h, i) => s + (i % 2 ? h + "\r\n" : h + ": "), "")}\r\n`);
      if (upstreamHead.length) connection.write(upstreamHead);
      if (head.length) peer.write(head);
      connection.pipe(peer).pipe(connection);
      connection.on("error", () => peer.destroy()); peer.on("error", () => connection.destroy());
      connection.on("close", () => peer.destroy()); peer.on("close", () => connection.destroy());
    });
    upstream.on("response", response => { response.resume(); connection.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); });
    upstream.on("error", () => connection.destroy());
    connection.on("error", () => upstream.destroy());
    upstream.end();
  });
  await new Promise<void>(done => proxy.listen(0, "127.0.0.1", done));
  base = `https://127.0.0.1:${port(proxy)}`;
  for (let i = 0; i < sessions.length; i++) {
    const login = await http("/api/auth/login", "POST", undefined, { username: ["Admin", "Parent", "Kid", "Other"][i], password });
    expect(login.status).toBe(200);
    sessions[i].token = login.json().access_token;
    sessions[i].cookie = login.headers["set-cookie"]![0];
  }
}, 30000);
afterAll(async () => {
  for (const ws of clients) ws.terminate();
  if (runtime) await runtime.close(backend);
  for (const connection of sockets) connection.destroy();
  if (proxy) await new Promise<void>(done => proxy.close(() => done()));
  if (db) await db.dispose();
});

it("serves SPA and API through verified TLS, with Secure HttpOnly scoped refresh cookies", async () => {
  expect((await http("/")).text).toContain("<html>");
  expect((await http("/api/health")).json().status).toBe("ok");
  for (const { cookie } of sessions) for (const flag of ["Secure", "HttpOnly", "Path=/api/auth", "SameSite=lax"]) expect(cookie.includes(flag)).toBe(true);
  const refresh = await http("/api/auth/refresh", "POST", undefined, undefined, sessions[1].cookie.split(";")[0]);
  expect(refresh.status).toBe(200);
  expect(Boolean(refresh.headers["set-cookie"]?.[0].includes("Secure"))).toBe(true);
});
it("does not trust the disposable certificate without explicit client trust", async () => {
  await expect(new Promise((done, fail) => { const request = tlsRequest(base + "/api/health", { agent: false }, done); request.on("error", fail); request.end(); })).rejects.toMatchObject({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
});
it("preserves current database roles across the TLS proxy", async () => {
  expect((await http("/api/admin/users", "GET", sessions[0].token)).status).toBe(200);
  for (const i of [1, 2]) expect((await http("/api/admin/users", "GET", sessions[i].token)).status).toBe(403);
  expect((await http("/api/push/test", "POST", sessions[2].token)).status).toBe(403);
});
it("rejects forged/expired tokens and foreign origins over WSS with empty CORS", async () => {
  const expired = await new SignJWT({ sub: String(sessions[2].id), role: "kid", type: "access", exp: 1 }).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(config.secretKey));
  for (const token of ["invalid", expired]) expect((await socket(2, token)).status).toBe(401);
  expect((await socket(2, sessions[2].token, "https://attacker.example.invalid")).status).toBe(403);
});
it("preserves Host/Origin, multiple sessions, private events and ping/pong through WSS", async () => {
  const a = await socket(), b = await socket(), other = await socket(3);
  expect(a.status).toBe(101); expect(a.ws.protocol).toBe("chorequest");
  const pong = once(a.ws, "ping"); await runtime.hub.heartbeat(); await pong;
  await runtime.hub.publish([{ userId: sessions[2].id, message: { type: "proxy_private", data: { value: 1 } } }]);
  await vi.waitFor(() => { expect(a.messages).toHaveLength(1); expect(b.messages).toHaveLength(1); }, { timeout: 2000 });
  expect(other.messages).toHaveLength(0);
  a.ws.close(); b.ws.close(); other.ws.close();
});
it("keeps credentials out of the synthetic proxy log, including legacy query-token URLs", async () => {
  const legacy = await socket(2, sessions[2].token, base, true); expect(legacy.status).toBe(101); legacy.ws.close();
  const log = accessLog.join("\n");
  for (const secret of [password, config.secretKey, ...sessions.flatMap(s => [s.token, s.cookie.split(";")[0]])]) expect(log.includes(secret)).toBe(false);
  expect(log.includes("?token=")).toBe(false); expect(log.includes("bearer.")).toBe(false);
});
it("clears/revokes refresh on logout without claiming immediate access-JWT revocation", async () => {
  const cookie = sessions[0].cookie.split(";")[0];
  const logout = await http("/api/auth/logout", "POST", sessions[0].token, undefined, cookie);
  expect(logout.status).toBe(200);
  expect(Boolean(logout.headers["set-cookie"]?.[0].includes("Max-Age=0"))).toBe(true);
  expect((await http("/api/auth/refresh", "POST", undefined, undefined, cookie)).status).toBe(401);
  expect((await http("/api/auth/me", "GET", sessions[0].token)).status).toBe(200);
});
it("closes WSS on graceful restart, reconnects and resynchronizes persisted REST/VAPID state", async () => {
  const connected = await socket(), closed = once(connected.ws, "close");
  const key = (await http("/api/push/vapid-public-key", "GET", sessions[2].token)).json().public_key;
  await runtime.close(backend); expect((await closed)[0]).toBe(1001);
  await startBackend();
  const reconnected = await socket(); expect(reconnected.status).toBe(101);
  expect((await http("/api/auth/me", "GET", sessions[2].token)).json().id).toBe(sessions[2].id);
  expect((await http("/api/push/vapid-public-key", "GET", sessions[2].token)).json().public_key).toBe(key);
  expect(await db.prisma.$queryRawUnsafe("PRAGMA foreign_key_check")).toEqual([]);
  reconnected.ws.close();
});
