import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";
import { afterEach, expect, it } from "vitest";
import { pythonExecutable } from "../helpers/python.js";
import { disposableDatabase } from "../helpers/sqlite.js";
// Shared native-ESM smoke script also runs against the actual Linux image.
// @ts-expect-error Standalone deployment script intentionally has no TS declaration.
import { exercise, verifyRestart } from "../../scripts/runtime-smoke.mjs";

const execute = promisify(execFile), root = fileURLToPath(new URL("../../", import.meta.url));
const cli = resolve(createRequire(import.meta.url).resolve("prisma/package.json"), "../build/index.js");
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function workspace() {
  const directory = await mkdtemp(resolve(tmpdir(), "chorequest-deployment-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return directory;
}
const url = (path: string) => `file:${path.replaceAll("\\", "/")}?connection_limit=1`;
async function unusedPort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}
async function launch(directory: string, path: string, password: string) {
  const port = await unusedPort(), base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [resolve(root, "dist/server.js")], { cwd: directory, windowsHide: true, env: {
    ...process.env, NODE_ENV: "production", DATABASE_URL: url(path), SECRET_KEY: "phase-six-disposable-compiled-runtime-only",
    INITIAL_ADMIN_USERNAME: "Admin", INITIAL_ADMIN_DISPLAY_NAME: "Administrator", INITIAL_ADMIN_PASSWORD: password,
    COOKIE_SECURE: "false", CORS_ORIGINS: "", PORT: String(port), HOST: "127.0.0.1", DAILY_RESET_HOUR: "0", TZ: "America/Chicago",
    STATIC_DIR: resolve(directory, "public"), UPLOAD_DIR: resolve(directory, "uploads"),
    DOTENV_CONFIG_PATH: resolve(directory, "absent.env"), VAPID_PRIVATE_KEY: "", VAPID_PUBLIC_KEY: "", VAPID_CLAIM_EMAIL: "mailto:fixture@example.invalid",
  }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", chunk => { logs = (logs + String(chunk)).slice(-32000); });
  child.stderr.on("data", chunk => { logs = (logs + String(chunk)).slice(-32000); });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, "exit"); child.kill("SIGTERM");
    const deadline = setTimeout(() => child.kill("SIGKILL"), 15000);
    try { await closed; } finally { clearTimeout(deadline); }
  };
  cleanup.push(stop);
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Compiled fixture failed startup");
    try { if ((await fetch(base + "/api/health", { signal: AbortSignal.timeout(500) })).ok) return { base, child, stop, logs: () => logs }; } catch { /* bounded startup wait */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Compiled fixture startup timed out");
}

it("provisions explicitly, exercises the compiled runtime, restarts and restores pre-failure DB/uploads/config", async () => {
  const directory = await workspace(), database = resolve(directory, "chorequest.db"), backup = resolve(directory, "backup"), restored = resolve(directory, "restored");
  await mkdir(resolve(directory, "public")); await mkdir(resolve(directory, "uploads"));
  await writeFile(resolve(directory, "public/index.html"), "<html>synthetic static deployment fixture</html>");
  await execute(process.execPath, [resolve(root, "scripts/initialize-sqlite.mjs"), database]);
  const schema = resolve(root, "prisma/schema.prisma");
  for (const args of [["migrate", "deploy"], ["migrate", "status"], ["migrate", "diff", "--from-url", url(database), "--to-schema-datamodel", schema, "--exit-code"]])
    await execute(process.execPath, [cli, ...args, ...(args[1] === "diff" ? [] : ["--schema", schema])], { cwd: directory, env: { ...process.env, DATABASE_URL: url(database) } });
  const password = randomBytes(24).toString("hex"), first = await launch(directory, database, password);
  const state = await exercise(first.base, password);
  await first.stop();
  const second = await launch(directory, database, "different-password-must-not-overwrite");
  await verifyRestart(second.base, state);
  const login = await fetch(second.base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "Admin", password }) });
  expect(login.status).toBe(200);
  await second.stop();
  const configFile = resolve(directory, "private.env");
  await writeFile(configFile, "SECRET_KEY=synthetic-recovery-fixture-only\n", { mode: 0o600 });
  await execute(pythonExecutable, ["-B", resolve(root, "scripts/snapshot-state.py"), "--database", database, "--uploads", resolve(directory, "uploads"), "--configuration", configFile, "--output", backup, "--writers-stopped"]);
  const db = new PrismaClient({ datasources: { db: { url: url(database) } } });
  try { await db.$executeRawUnsafe("UPDATE users SET points_balance=99999 WHERE username='SmokeKid'"); } finally { await db.$disconnect(); }
  const manifest = JSON.parse(await readFile(resolve(backup, "manifest.json"), "utf8"));
  for (const name of Object.keys(manifest.files).filter(name => name.startsWith("uploads/"))) await writeFile(resolve(directory, name), "deliberately damaged fixture");
  await execute(pythonExecutable, ["-B", resolve(root, "scripts/snapshot-state.py"), "--restore-from", backup, "--output", restored]);
  const restoredClient = new PrismaClient({ datasources: { db: { url: url(resolve(restored, "chorequest.db")) } } });
  try {
    expect((await restoredClient.users.findFirst({ where: { username: "SmokeKid" }, select: { points_balance: true } }))?.points_balance).toBe(state.points);
    expect(await restoredClient.$queryRawUnsafe("PRAGMA foreign_key_check")).toEqual([]);
  } finally { await restoredClient.$disconnect(); }
  await mkdir(resolve(restored, "public")); await writeFile(resolve(restored, "public/index.html"), "<html>restored fixture</html>");
  const recovered = await launch(restored, resolve(restored, "chorequest.db"), password);
  await verifyRestart(recovered.base, state); await recovered.stop();
  // Reference SQLAlchemy must still read the restored state (including timestamps).
  await execute(pythonExecutable, ["-B", "-c", [
    "import sys", "from sqlalchemy import create_engine,select", "from sqlalchemy.orm import Session",
    "from backend.models import User,Chore,ChoreAssignment,Reward,RewardRedemption,Notification,PointTransaction",
    "with Session(create_engine('sqlite:///'+sys.argv[1])) as db:",
    " for model in (User,Chore,ChoreAssignment,Reward,RewardRedemption,Notification,PointTransaction): assert db.scalars(select(model)).all()",
  ].join("\n"), resolve(restored, "chorequest.db")], { cwd: restored, env: { ...process.env, PYTHONPATH: resolve(root, ".."), SECRET_KEY: "phase-six-python-restore-fixture-only" } });
  expect(await readFile(resolve(restored, "configuration.env"), "utf8")).toContain("synthetic-recovery-fixture-only");
  expect(first.logs() + second.logs() + recovered.logs()).not.toContain(password);
  if (process.platform !== "win32") {
    expect(first.child.exitCode).toBe(0); expect(first.logs()).toContain("shutting down gracefully");
  } // Windows kill terminates the process; Linux CI verifies actual SIGTERM.
}, 90000);

it("snapshots committed WAL pages, refuses overwrites and detects damaged backups", async () => {
  const fixture = await disposableDatabase(); cleanup.push(() => fixture.dispose());
  const directory = await workspace(), uploads = resolve(directory, "uploads"), backup = resolve(directory, "backup");
  await mkdir(uploads); await writeFile(resolve(uploads, "fixture.txt"), "before failure");
  await fixture.prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL");
  await fixture.prisma.$queryRawUnsafe("PRAGMA wal_autocheckpoint=0");
  await fixture.prisma.$executeRawUnsafe("INSERT INTO app_settings (key,value,updated_at) VALUES ('wal-fixture','retained','2026-03-01 00:00:00.123456')");
  const args = ["-B", resolve(root, "scripts/snapshot-state.py"), "--database", fixture.databasePath, "--uploads", uploads, "--output", backup, "--writers-stopped"];
  await execute(pythonExecutable, args);
  await expect(execute(pythonExecutable, args)).rejects.toThrow();
  const copied = new PrismaClient({ datasources: { db: { url: url(resolve(backup, "chorequest.db")) } } });
  try { expect(await copied.$queryRawUnsafe("SELECT value,CAST(updated_at AS TEXT) AS stamp FROM app_settings WHERE key='wal-fixture'")).toEqual([{ value: "retained", stamp: "2026-03-01 00:00:00.123456" }]); } finally { await copied.$disconnect(); }
  await writeFile(resolve(backup, "uploads/fixture.txt"), "tampered");
  await expect(execute(pythonExecutable, ["-B", resolve(root, "scripts/snapshot-state.py"), "--restore-from", backup, "--output", resolve(directory, "restore-must-not-exist")])).rejects.toThrow();
}, 30000);

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("fails compiled startup on an unwritable SQLite directory instead of reporting healthy", async () => {
  const fixture = await disposableDatabase(); cleanup.push(() => fixture.dispose());
  await fixture.prisma.$disconnect();
  const secret = "unwritable-startup-fixture-only";
  await chmod(fixture.databasePath, 0o400); await chmod(fixture.directory, 0o500);
  try {
    await expect(execute(process.execPath, [resolve(root, "dist/server.js")], { cwd: fixture.directory, timeout: 15000,
      env: { ...process.env, DATABASE_URL: url(fixture.databasePath), SECRET_KEY: secret, INITIAL_ADMIN_PASSWORD: "", DOTENV_CONFIG_PATH: resolve(fixture.directory, "absent.env") },
    })).rejects.toMatchObject({ code: 1 });
  } finally { await chmod(fixture.directory, 0o700); await chmod(fixture.databasePath, 0o600); }
}, 20000);

it("runs the container's compiled-module/mock-provider probes portably without production data", async () => {
  const script = await readFile(resolve(root, "scripts/container-probes.mjs"), "utf8");
  const result = await execute(process.execPath, ["--input-type=module", "-e", script], { cwd: root, timeout: 20000 });
  expect(result.stdout).toContain("PASS: compiled native modules, mocked push retry/restart, scheduler and VAPID");
}, 30000);
