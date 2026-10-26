import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { disposableDatabase } from "../helpers/sqlite.js";
const run = promisify(execFile);
let db: Awaited<ReturnType<typeof disposableDatabase>> | undefined, child: ChildProcess | undefined;
afterEach(async () => {
	if (child && child.exitCode === null) {
		const current = child;
		await new Promise<void>(resolve => {
			const timer = setTimeout(() => { current.kill("SIGKILL"); }, 10000);
			timer.unref();
			current.once("exit", () => { clearTimeout(timer); resolve(); });
			current.kill("SIGTERM");
		});
	}
	await db?.dispose();
});
it("starts the production runtime on an empty disposable DB and completes a real HTTP chore/reward workflow", async () => {
	db = await disposableDatabase();
	const listener = createServer();
	await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
	const address = listener.address();
	if (!address || typeof address === "string")
		throw new Error("Missing disposable port");
	const port = address.port;
	await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
	const root = fileURLToPath(new URL("../../../", import.meta.url));
	child = spawn(process.execPath, [fileURLToPath(new URL("../../dist/server.js", import.meta.url))], {
		cwd: db.directory, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
			DATABASE_URL: `file:${db.databasePath.replaceAll("\\", "/")}?connection_limit=1`, SECRET_KEY: "phase-four-production-smoke-fixture",
			INITIAL_ADMIN_USERNAME: "Admin", INITIAL_ADMIN_DISPLAY_NAME: "Administrator", INITIAL_ADMIN_PASSWORD: "",
			COOKIE_SECURE: "false", CORS_ORIGINS: "", HOST: "127.0.0.1", PORT: String(port), UPLOAD_DIR: `${db.directory}/uploads`,
		},
	});
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Disposable runtime startup timed out")), 15000);
		child!.once("error", reject);
		child!.once("exit", () => reject(new Error("Disposable runtime exited before startup")));
		child!.stdout!.on("data", (chunk: Buffer) => {
			if (chunk.toString().includes("listening")) {
				clearTimeout(timer);
				resolve();
			}
		});
	});
	const base = `http://127.0.0.1:${port}`;
	async function http(path: string, method = "GET", token?: string, body?: unknown, status = 200) {
		const response = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
		expect(response.status, `${method} ${path}`).toBe(status);
		return response.json();
	}
	await http("/api/health");
	expect(await http("/api/auth/setup-status")).toMatchObject({ setup_required: true, password_setup_required: true });
	const initial = await http("/api/auth/setup-password", "POST", undefined, { password: "SyntheticPassword42", confirm_password: "SyntheticPassword42" });
	const admin = initial.access_token as string;
	const kid = await http("/api/admin/users", "POST", admin, { username: "SyntheticKid", display_name: "Synthetic", password: "SyntheticPassword42", role: "kid" });
	const login = await http("/api/auth/login", "POST", undefined, { username: "SyntheticKid", password: "SyntheticPassword42" }), kidToken = login.access_token as string;
	const categories = await http("/api/chores/categories", "GET", admin);
	expect(categories.length).toBeGreaterThan(0);
	const chore = await http("/api/chores", "POST", admin, { title: "Synthetic startup chore", points: 10, difficulty: "easy", category_id: categories[0].id, recurrence: "once", assigned_user_ids: [kid.id] }, 201);
	await http(`/api/chores/${chore.id}/complete`, "POST", kidToken);
	await http(`/api/chores/${chore.id}/verify`, "POST", admin);
	const reward = await http("/api/rewards", "POST", admin, { title: "Synthetic prize", point_cost: 5, stock: 1 }, 201);
	const redemption = await http(`/api/rewards/${reward.id}/redeem`, "POST", kidToken);
	await http(`/api/rewards/redemptions/${redemption.id}/fulfill`, "POST", admin);
	expect(await db.prisma.$queryRaw `PRAGMA foreign_key_check`).toEqual([]);
	const python = fileURLToPath(new URL("../../../.venv/Scripts/python.exe", import.meta.url));
	const result = await run(python, ["-c", [
			"import sys,json",
			"from sqlalchemy import create_engine,select",
			"from sqlalchemy.orm import Session",
			"from backend.models import Chore,ChoreAssignment,Reward,RewardRedemption,User,PointTransaction,Notification,Achievement",
			"engine=create_engine('sqlite:///'+sys.argv[1])",
			"with Session(engine) as session:",
			" for model in (Chore,ChoreAssignment,Reward,RewardRedemption,User,PointTransaction,Notification,Achievement):",
			"  rows=session.scalars(select(model)).all()",
			"  assert rows,model.__name__",
			" print(json.dumps({'created_at':session.scalar(select(Chore).where(Chore.title=='Synthetic startup chore')).created_at.isoformat()}))",
			"print('SQLAlchemy business rows readable')",
		].join("\n"), db.databasePath], { cwd: db.directory, windowsHide: true, env: { ...process.env, PYTHONPATH: root, SECRET_KEY: "phase-four-python-compatibility-fixture", DATABASE_URL: `sqlite+aiosqlite:///${db.databasePath.replaceAll("\\", "/")}` } });
	expect(result.stdout).toContain("SQLAlchemy business rows readable");
	expect(JSON.parse(result.stdout.split(/\r?\n/)[0]).created_at).toBe(chore.created_at);
}, 30000);
