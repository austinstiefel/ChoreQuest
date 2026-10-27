import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, it, vi } from "vitest";
// @ts-expect-error Native ESM deployment script intentionally has no declaration.
import { runDockerSmoke } from "../../scripts/docker-smoke.mjs";
// @ts-expect-error Native ESM diagnostic module intentionally has no declaration.
import { safeDiagnostics, safeContainerState, cleanupCommand, safeWorkflowOperation } from "../../scripts/docker-smoke-diagnostics.mjs";

type Entry = Record<string, unknown>;
const privateText = 'SECRET_KEY=fixture-private-key access_token=fixture-jwt refresh_token=fixture-refresh VAPID_PRIVATE_KEY=fixture-vapid endpoint=https://fcm.googleapis.com/private-subscription auth=fixture-subscription-auth';
const childFailure = () => Object.assign(new Error(`Command/argv must not escape: ${privateText}`), {
  code: 17, signal: "SIGTERM", killed: true,
  stdout: `#12 [production-dependencies 1/2] RUN pnpm prune --prod\n${privateText}`,
  stderr: `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY\n${privateText}`,
});
function harness(failures: Record<string, Error> = {}) {
  const entries: Entry[] = [], commands: string[][] = [];
  const injected = new Set<string>();
  let current = "", provisions = 0, envFile = "", generated = "";
  function maybeFail() { if (failures[current] && !injected.has(current)) { injected.add(current); throw failures[current]; } }
  const execute = vi.fn(async (_file: string, args: string[], options?: { env: NodeJS.ProcessEnv }) => {
    commands.push(args);
    if (args[0] === "info") {
      maybeFail();
      return { stdout: "linux\n", stderr: "" };
    }
    if (args[0] === "inspect") {
      maybeFail();
      return { stdout: "0\n", stderr: "" };
    }
    envFile = args[args.indexOf("--env-file") + 1];
    generated = await readFile(envFile, "utf8");
    expect(options?.env?.STAGING_SECRET_KEY).toBeUndefined();
    maybeFail();
    const command = args.slice(args.indexOf("-f") + 2);
    if (command[0] === "run" && command.at(-1) === "provision" && ++provisions === 2)
      throw Object.assign(new Error("expected fixture refusal"), { code: 1, stderr: "SQLite initialization refused: use a new absolute path with an existing parent; no existing file was overwritten." });
    if (command[0] === "port") return { stdout: "127.0.0.1:43123\n", stderr: "" };
    if (command[0] === "ps") return { stdout: command.includes("json") ? JSON.stringify([{ Service: "app", State: "exited", Health: "unhealthy", ExitCode: 17, Command: privateText, Labels: privateText }]) : "synthetic-container-id\n", stderr: "" };
    if (command[0] === "logs") return { stdout: `${privateText}\nInvalid SECRET_KEY configuration`, stderr: "" };
    return { stdout: privateText, stderr: "" };
  });
  const workflow = vi.fn(async (_base: string, _password: string, progress: (value: string) => void) => {
    progress("http:POST:/api/auth/login");
    progress(privateText); // Unexpected labels must also be suppressed.
    maybeFail();
    return { kid: privateText };
  });
  const restart = vi.fn(async () => { maybeFail(); });
  return { entries, commands, execute, workflow, restart,
    run: () => runDockerSmoke({ execute, workflow, restart, log: (entry: Entry) => { entries.push(entry); if (entry.status === "start" && !entry.operation) current = String(entry.stage); } }),
    async assertPrivateAndRemoved() {
      const output = JSON.stringify(entries);
      for (const secret of ["fixture-private-key", "fixture-jwt", "fixture-refresh", "fixture-vapid", "private-subscription", "fixture-subscription-auth"])
        expect(output).not.toContain(secret);
      for (const line of generated.split("\n").filter(line => /^STAGING_(SECRET_KEY|ADMIN_PASSWORD)=/.test(line)))
        expect(output).not.toContain(line.split("=")[1]);
      if (envFile) await expect(stat(dirname(envFile))).rejects.toThrow();
    },
  };
}

it("retains technical codes/build steps while dropping argv, bodies, tokens, keys and assertion values", () => {
  expect(safeDiagnostics(childFailure())).toMatchObject({ exitCode: 17, signal: "SIGTERM", killed: true,
    codes: ["ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY"], categories: ["noninteractive_module_removal"],
    buildSteps: ["production-dependencies 1/2 RUN"], capturedOutput: true });
  const assertion = Object.assign(new Error(privateText), { name: "AssertionError", actual: privateText, expected: privateText });
  const output = JSON.stringify(safeDiagnostics(assertion));
  expect(output).toContain("AssertionError"); expect(output).not.toContain("fixture-");
  expect(safeDiagnostics(Object.assign(new Error(privateText), { code: "ENOENT" })).code).toBe("ENOENT");
  expect(safeDiagnostics(Object.assign(new Error(privateText), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" })).code).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
  expect(safeDiagnostics(new Error("POST /api/auth/login returned 401")).httpStatus).toBe(401);
  expect(safeDiagnostics(new Error("Unexpected server response: 403")).websocketStatus).toBe(403);
  expect(safeDiagnostics({ stderr: "failed to connect to the docker API at dockerDesktopLinuxEngine" }).categories).toContain("docker_daemon_unavailable");
});

it("only exposes known container state fields and known workflow operations", () => {
  expect(safeContainerState(JSON.stringify([{ Service: "app", State: "exited", Health: "unhealthy", ExitCode: 1, Command: privateText, Labels: privateText }]))).toEqual([
    { service: "app", state: "exited", health: "unhealthy", exitCode: 1 },
  ]);
  expect(safeWorkflowOperation("http:POST:/api/chores/123/complete")).toBe("http:POST:/api/chores/:id/complete");
  expect(safeWorkflowOperation(privateText)).toBe("unknown");
});

it.each(["build-runtime-image", "build-provisioner-image", "provision-database", "startup-health", "native-sqlite-wal-scheduler-checks", "mock-push-unix-permission-probes", "restart-persistence"])("identifies %s and always cleans its exact isolated project", async stage => {
  const h = harness({ [stage]: childFailure() });
  await expect(h.run()).rejects.toMatchObject({ stage, diagnostic: { exitCode: 17 } });
  expect(h.entries).toContainEqual(expect.objectContaining({ stage, status: "fail", exitCode: 17 }));
  const down = h.commands.find(args => args.includes("down"))!;
  expect(down).toContain("--volumes"); expect(down).toContain("--remove-orphans");
  const project = down[down.indexOf("--project-name") + 1];
  expect(project).toMatch(/^chorequest-phase6-[a-f0-9]{12}$/);
  for (const command of h.commands.filter(args => args[0] === "compose")) expect(command[command.indexOf("--project-name") + 1]).toBe(project);
  expect(h.entries).toContainEqual(expect.objectContaining({ stage: "failure-application-diagnostics", categories: ["configuration_invalid"] }));
  await h.assertPrivateAndRemoved();
});

it("does not let cleanup failures conceal the primary failure and emits a credential-free manual cleanup", async () => {
  const h = harness({ "build-runtime-image": childFailure(), "compose-cleanup": Object.assign(new Error(privateText), { code: "EACCES" }) });
  await expect(h.run()).rejects.toMatchObject({ stage: "build-runtime-image", diagnostic: { exitCode: 17 } });
  const manual = h.entries.find(entry => entry.manualCleanupFromRepositoryRoot)!;
  expect(manual.project).toMatch(/^chorequest-phase6-[a-f0-9]{12}$/);
  expect(manual.manualCleanupFromRepositoryRoot).toContain(`--project-name ${manual.project}`);
  expect(manual.manualCleanupFromRepositoryRoot).toContain("--env-file /dev/null");
  expect(() => cleanupCommand("other-project")).toThrow("Invalid disposable project");
  await h.assertPrivateAndRemoved();
});

it("treats cleanup failure after an otherwise successful run as failure", async () => {
  const h = harness({ "compose-cleanup": childFailure() });
  await expect(h.run()).rejects.toMatchObject({ stage: "compose-cleanup" });
  expect(h.entries).not.toContainEqual({ stage: "docker-smoke", status: "pass" });
  await h.assertPrivateAndRemoved();
});

it("does not accept an arbitrary Docker error as successful repeat-provisioning rejection", async () => {
  const h = harness({ "reject-repeated-provisioning": Object.assign(new Error(privateText), { code: "ENOENT" }) });
  await expect(h.run()).rejects.toMatchObject({ stage: "reject-repeated-provisioning", diagnostic: { code: "ENOENT" } });
  await h.assertPrivateAndRemoved();
});

it("requires a Linux daemon and reports availability failures before allocating resources", async () => {
  const h = harness({ "docker-availability": Object.assign(new Error(privateText), { code: "ENOENT" }) });
  await expect(h.run()).rejects.toMatchObject({ stage: "docker-availability", diagnostic: { code: "ENOENT" } });
  expect(h.commands).toHaveLength(1);
  expect(h.entries.some(entry => entry.stage === "fixture-directory")).toBe(false);
  await h.assertPrivateAndRemoved();
});

it("retains every original build/provision/workflow/native/shutdown/restart check in order on success", async () => {
  const h = harness();
  await h.run();
  expect(h.workflow).toHaveBeenCalledOnce(); expect(h.restart).toHaveBeenCalledOnce();
  expect(h.entries.filter(entry => entry.status === "pass").map(entry => entry.stage)).toEqual([
    "docker-availability", "fixture-directory", "fixture-configuration", "build-runtime-image", "build-provisioner-image",
    "provision-database", "reject-repeated-provisioning", "startup-health", "discover-loopback-port", "http-ws-workflow",
    "native-sqlite-wal-scheduler-checks", "openssl", "sigterm-stop", "sigterm-exit-code", "read-container-probes",
    "mock-push-unix-permission-probes", "restart-health", "restart-loopback-port", "restart-persistence", "compose-cleanup",
    "temporary-file-cleanup", "docker-smoke",
  ]);
  await h.assertPrivateAndRemoved();
});
