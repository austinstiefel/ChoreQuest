import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exercise, verifyRestart } from "./runtime-smoke.mjs";
const exec = promisify(execFile), root = fileURLToPath(new URL("../../", import.meta.url));
const docker = process.env.CHOREQUEST_TEST_DOCKER || "docker";
// Check BEFORE creating anything. Never launch a daemon or touch other projects.
try { await exec(docker, ["info", "--format", "{{.ServerVersion}}"], { timeout: 15000, windowsHide: true }); }
catch { throw new Error("A usable Linux Docker daemon is required; nothing was created"); }
const directory = await mkdtemp(resolve(tmpdir(), "chorequest-container-test-"));
const project = `chorequest-phase6-${randomBytes(6).toString("hex")}`, envFile = resolve(directory, ".env");
const password = randomBytes(24).toString("hex");
await writeFile(envFile, `STAGING_SECRET_KEY=${randomBytes(32).toString("hex")}\nSTAGING_ADMIN_PASSWORD=${password}\nSTAGING_PORT=0\n`, { mode: 0o600 });
const args = ["compose", "--project-name", project, "--env-file", envFile, "-f", resolve(root, "server/compose.staging.yml")];
// Shell variables override Compose env files. Never inherit an operator's real
// staging credentials, port or configuration into this disposable test.
const composeEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("STAGING_")));
async function compose(...command) {
  // Never stream resolved configuration, login responses or raw exception output.
  return exec(docker, [...args, ...command], { cwd: root, env: composeEnvironment, timeout: 900000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
}
let failure;
try {
  await compose("build", "app", "provision");
  await compose("run", "--rm", "provision");
  await assert.rejects(compose("run", "--rm", "provision"), "Provisioning must reject an existing database");
  await compose("up", "-d", "--wait", "--wait-timeout", "120", "app");
  async function baseUrl() {
    const { stdout } = await compose("port", "app", "8122");
    assert.match(stdout.trim(), /^127\.0\.0\.1:\d+$/);
    return `http://${stdout.trim()}`;
  }
  const state = await exercise(await baseUrl(), password);
  await compose("exec", "-T", "-w", "/app/server", "app", "node", "--input-type=module", "-e", [
    "import assert from 'node:assert/strict';import bcrypt from 'bcrypt';import sharp from 'sharp';import {PrismaClient} from '@prisma/client';import {access} from 'node:fs/promises';",
    "assert.notEqual(process.getuid(),0);assert(await bcrypt.compare('fixture',await bcrypt.hash('fixture',4)));",
    "await sharp({create:{width:2,height:2,channels:3,background:'red'}}).png().toBuffer();",
    "const db=new PrismaClient();assert.deepEqual(await db.$queryRawUnsafe('PRAGMA foreign_key_check'),[]);",
    "assert((await db.$queryRawUnsafe(\"SELECT key FROM app_settings WHERE key='__runtime_daily'\")).length);",
    "await db.$queryRawUnsafe('PRAGMA journal_mode=WAL');await db.$executeRawUnsafe(\"UPDATE app_settings SET value=value WHERE key='__runtime_daily'\");",
    "await access('/app/data/chorequest.db-wal');await access('/etc/ssl/certs/ca-certificates.crt');await access('/usr/share/zoneinfo/America/Chicago');await db.$disconnect();",
  ].join(""));
  await compose("exec", "-T", "app", "openssl", "version");
  await compose("stop", "-t", "75", "app");
  const { stdout: ids } = await compose("ps", "-a", "-q", "app");
  const { stdout: exit } = await exec(docker, ["inspect", "--format", "{{.State.ExitCode}}", ids.trim()]);
  assert.equal(exit.trim(), "0", "SIGTERM must exit cleanly without SIGKILL");
  const probe = await readFile(new URL("./container-probes.mjs", import.meta.url), "utf8");
  await compose("run", "--rm", "--no-deps", "-T", "-w", "/app/server", "--entrypoint", "node", "app", "--input-type=module", "-e", probe);
  await compose("up", "-d", "--wait", "--wait-timeout", "120", "app");
  await verifyRestart(await baseUrl(), state);
  console.log("PASS: isolated Linux image, native modules, HTTP/WS, static UI, upload, WAL, VAPID, scheduler, SIGTERM and restart persistence");
} catch {
  failure = new Error("Disposable container verification failed; inspect privately, never publish resolved environment/log secrets");
} finally {
  try { await compose("down", "--volumes", "--remove-orphans", "--timeout", "75"); }
  catch { failure = new Error(`Disposable Compose cleanup failed; remove only project ${project}`); }
  await rm(directory, { recursive: true, force: true });
}
if (failure) throw failure;
