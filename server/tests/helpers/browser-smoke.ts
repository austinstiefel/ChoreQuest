/** Explicit, time-bounded browser acceptance fixture. Never loads dotenv or a
 * configured database. stdin: restart / status / stop. No real push provider. */
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { disposableDatabase } from "./sqlite.js";
import { bootstrapInitialAdmin, loadBootstrapConfig } from "../../src/auth/bootstrap.js";
import { hashPassword } from "../../src/auth/passwords.js";
import { insertAccount } from "../../src/auth/accounts.js";
import { requireDeletionSchema } from "../../src/db/accountSchema.js";
import { seedBusinessData } from "../../src/business/seed.js";
import { Store, write, day } from "../../src/business/store.js";
import { UploadStorage } from "../../src/business/uploads.js";
import { loadAuthConfig } from "../../src/config/auth.js";
import { createRuntime } from "../../src/runtime/index.js";
if (process.argv[2] !== "--serve-disposable")
	throw new Error("Explicit disposable browser fixture flag required");
const db = await disposableDatabase();
await requireDeletionSchema(db.prisma);
const config = loadAuthConfig({ SECRET_KEY: "browser-smoke-test-secret-only", COOKIE_SECURE: "false", CORS_ORIGINS: "" });
await bootstrapInitialAdmin(db.prisma, loadBootstrapConfig({ INITIAL_ADMIN_USERNAME: "Admin", INITIAL_ADMIN_DISPLAY_NAME: "Administrator", INITIAL_ADMIN_PASSWORD: "FixturePassword42" }));
await seedBusinessData(db.prisma);
const store = await Store.open(db.prisma), passwordHash = await hashPassword("FixturePassword42");
const kids = await write(db.prisma, store, async (tx) => {
	const ids = [];
	for (const username of ["FixtureKid", "OtherKid"])
		ids.push(await insertAccount(tx.db, { username, displayName: username, role: "kid", passwordHash }));
	return ids;
});
for (const kid of kids)
	await store.update("users", kid, { points_balance: 25, total_points_earned: 50 });
const category = (await store.rows("chore_categories"))[0], chore = await store.insert("chores", { title: "Browser Shared Quest", description: "Disposable browser compatibility fixture", points: 10, difficulty: "easy", category_id: category.id, recurrence: "daily", custom_days: null, requires_photo: false, is_active: true, created_by: 1 });
for (const kid of kids) {
	await store.insert("chore_assignments", { chore_id: chore.id, user_id: kid, date: day(), status: "completed", completed_at: new Date(), verified_at: null, verified_by: null, photo_proof_path: null, feedback: null });
	await store.insert("chore_assignment_rules", { chore_id: chore.id, user_id: kid, recurrence: "daily", custom_days: null, requires_photo: false, is_active: true });
}
await store.insert("rewards", { title: "Browser Reward", description: "Disposable", point_cost: 5, stock: 5, is_active: true, created_by: 1 });
let runtime: Awaited<ReturnType<typeof createRuntime>>, server: Server, port = 0, stopping = false;
async function start() {
	runtime = await createRuntime(db.prisma, config, { uploads: new UploadStorage(resolve(db.directory, "uploads"), 5), pushConfig: { subject: "mailto:browser-fixture@example.com" }, sender: async () => { throw new Error("Real push disabled in browser fixture"); }, dailyHour: 0, staticDirectory: fileURLToPath(new URL("../../../frontend/dist/", import.meta.url)) });
	server = createServer(runtime.app);
	await runtime.start(server);
	await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing fixture port");
	port = address.port;
	console.log(JSON.stringify({ url: `http://127.0.0.1:${port}`, disposable: true }));
}
async function stop() { if (stopping)
	return; stopping = true; clearTimeout(expiry); await runtime.close(server); await db.dispose(); process.stdin.pause(); console.log("Disposable browser fixture stopped and removed"); }
await start();
const expiry = setTimeout(() => { void stop(); }, 15 * 60000);
expiry.unref();
let commands = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
	for (const command of String(chunk).trim().split(/\r?\n/))
		commands = commands.then(async () => {
			if (command === "stop") {
				await stop();
				return;
			}
			if (command === "restart") {
				await runtime.close(server);
				await start();
				return;
			}
			if (command === "status")
				console.log(JSON.stringify({ sockets: runtime.hub.size, assignments: (await store.rows("chore_assignments")).filter(a => a.chore_id === chore.id).map(a => ({ id: a.id, user_id: a.user_id, status: a.status })), vapidPublicKey: runtime.keys.publicKey }));
		}).catch(() => console.error("Disposable browser fixture command failed"));
});
process.on("SIGINT", () => { void stop(); });
process.on("SIGTERM", () => { void stop(); });
