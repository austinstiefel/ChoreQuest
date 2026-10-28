import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exercise, verifyRestart } from "./runtime-smoke.mjs";
import { SmokeStageError, smokeStage, safeDiagnostics, safeContainerState, safeWorkflowOperation, cleanupCommand } from "./docker-smoke-diagnostics.mjs";
import { discoverLoopbackUrl, ephemeralPortOverride } from "./docker-smoke-ports.mjs";
const defaultExecute = promisify(execFile), root = fileURLToPath(new URL("../../", import.meta.url));

// Injectable orchestration is tested without Docker or an application database.
export async function runDockerSmoke({ execute = defaultExecute, workflow = exercise, restart = verifyRestart,
  log = entry => console.log(JSON.stringify(entry)) } = {}) {
const exec = execute, stage = (name, action) => smokeStage(name, action, log);
const docker = process.env.CHOREQUEST_TEST_DOCKER || "docker";
// Check BEFORE creating anything. Never launch a daemon or touch other projects.
await stage("docker-availability", async () => {
  const { stdout } = await exec(docker, ["info", "--format", "{{.OSType}}"], { timeout: 15000, windowsHide: true });
  assert.equal(stdout.trim(), "linux", "A Linux Docker daemon is required");
});
const directory = await stage("fixture-directory", () => mkdtemp(resolve(tmpdir(), "chorequest-container-test-")));
const project = `chorequest-phase6-${randomBytes(6).toString("hex")}`, envFile = resolve(directory, ".env");
const overrideFile = resolve(directory, "compose.smoke.yml");
const password = randomBytes(24).toString("hex");
log({ stage: "fixture-project", project, status: "allocated" });
const args = ["compose", "--project-name", project, "--env-file", envFile, "-f", resolve(root, "server/compose.staging.yml"), "-f", overrideFile];
// Shell variables override Compose env files. Never inherit an operator's real
// staging credentials, port or configuration into this disposable test.
const composeEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("STAGING_")));
async function compose(...command) {
  // Never stream resolved configuration, login responses or raw exception output.
  return exec(docker, [...args, ...command], { cwd: root, env: composeEnvironment, timeout: 900000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
}
let failure, cleanupFailure;
try {
  await stage("fixture-configuration", async () => {
    await writeFile(envFile, `STAGING_SECRET_KEY=${randomBytes(32).toString("hex")}\nSTAGING_ADMIN_PASSWORD=${password}\n`, { mode: 0o600, flag: "wx" });
    await writeFile(overrideFile, ephemeralPortOverride, { mode: 0o600, flag: "wx" });
  });
  await stage("build-runtime-image", () => compose("build", "app"));
  await stage("build-provisioner-image", () => compose("build", "provision"));
  await stage("provision-database", () => compose("run", "--rm", "provision"));
  await stage("reject-repeated-provisioning", async () => {
    try { await compose("run", "--rm", "provision"); }
    catch (error) {
      if (error.code === 1 && String(error.stderr ?? "").includes("SQLite initialization refused: use a new absolute path")) return;
      throw error;
    }
    assert.fail("Repeat provisioning must fail specifically at exclusive file initialization");
  });
  await stage("startup-health", () => compose("up", "-d", "--wait", "--wait-timeout", "120", "app"));
  async function baseUrl() {
    return discoverLoopbackUrl({ compose, execute: exec, docker, project });
  }
  const base = await stage("discover-loopback-port", baseUrl);
  const progress = operation => log({ stage: "http-ws-workflow", operation: safeWorkflowOperation(operation), status: "start" });
  const state = await stage("http-ws-workflow", () => workflow(base, password, progress));
  await stage("native-sqlite-wal-scheduler-checks", () => compose("exec", "-T", "-w", "/app/server", "app", "node", "--input-type=module", "-e", [
    "import assert from 'node:assert/strict';import bcrypt from 'bcrypt';import sharp from 'sharp';import {PrismaClient} from '@prisma/client';import {access} from 'node:fs/promises';",
    "assert.notEqual(process.getuid(),0);assert(await bcrypt.compare('fixture',await bcrypt.hash('fixture',4)));",
    "await sharp({create:{width:2,height:2,channels:3,background:'red'}}).png().toBuffer();",
    "const db=new PrismaClient();assert.deepEqual(await db.$queryRawUnsafe('PRAGMA foreign_key_check'),[]);",
    "assert((await db.$queryRawUnsafe(\"SELECT key FROM app_settings WHERE key='__runtime_daily'\")).length);",
    "await db.$queryRawUnsafe('PRAGMA journal_mode=WAL');await db.$executeRawUnsafe(\"UPDATE app_settings SET value=value WHERE key='__runtime_daily'\");",
    "await access('/app/data/chorequest.db-wal');await access('/etc/ssl/certs/ca-certificates.crt');await access('/usr/share/zoneinfo/America/Chicago');await db.$disconnect();",
  ].join("")));
  await stage("openssl", () => compose("exec", "-T", "app", "openssl", "version"));
  await stage("sigterm-stop", () => compose("stop", "-t", "75", "app"));
  await stage("sigterm-exit-code", async () => {
    const { stdout: ids } = await compose("ps", "-a", "-q", "app");
    const { stdout: exit } = await exec(docker, ["inspect", "--format", "{{.State.ExitCode}}", ids.trim()], { timeout: 15000, windowsHide: true });
    if (Number.isInteger(Number(exit.trim()))) log({ stage: "sigterm-exit-code", containerExitCode: Number(exit.trim()) });
    assert.equal(exit.trim(), "0", "SIGTERM must exit cleanly without SIGKILL");
  });
  const probe = await stage("read-container-probes", () => readFile(new URL("./container-probes.mjs", import.meta.url), "utf8"));
  await stage("mock-push-unix-permission-probes", () => compose("run", "--rm", "--no-deps", "-T", "-w", "/app/server", "--entrypoint", "node", "app", "--input-type=module", "-e", probe));
  await stage("restart-health", () => compose("up", "-d", "--wait", "--wait-timeout", "120", "app"));
  const restarted = await stage("restart-loopback-port", baseUrl);
  await stage("restart-persistence", () => restart(restarted, state));
} catch (error) {
  failure = error;
  // Neither raw application logs nor environment/command/labels are exposed.
  try {
    const { stdout } = await compose("ps", "-a", "--format", "json");
    log({ stage: "failure-container-state", containers: safeContainerState(stdout) });
  } catch { log({ stage: "failure-container-state", status: "unavailable" }); }
  try {
    const output = await compose("logs", "--no-color", "--tail", "80", "app");
    log({ stage: "failure-application-diagnostics", ...safeDiagnostics(output) });
  } catch { log({ stage: "failure-application-diagnostics", status: "unavailable" }); }
} finally {
  try { await stage("compose-cleanup", () => compose("down", "--volumes", "--remove-orphans", "--timeout", "75")); }
  catch (error) {
    cleanupFailure = error;
    log({ stage: "compose-cleanup", project, manualCleanupFromRepositoryRoot: cleanupCommand(project) });
  }
  try { await stage("temporary-file-cleanup", () => rm(directory, { recursive: true, force: true })); }
  catch (error) { cleanupFailure ??= error; }
}
// Never replace a primary failure with cleanup failures. No raw error is thrown.
if (failure || cleanupFailure) throw failure ?? cleanupFailure;
log({ stage: "docker-smoke", status: "pass" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await runDockerSmoke(); }
  catch (error) {
    if (!(error instanceof SmokeStageError)) console.error(JSON.stringify({ stage: "orchestration-setup", status: "fail", ...safeDiagnostics(error) }));
    process.exitCode = 1; // Stage failures were already logged; never dump errors.
  }
}
