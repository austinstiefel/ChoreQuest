import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, it, vi } from "vitest";
// @ts-expect-error Native ESM deployment script intentionally has no declaration.
import { runDockerSmoke } from "../../scripts/docker-smoke.mjs";
// @ts-expect-error Native ESM diagnostic module intentionally has no declaration.
import { safeDiagnostics, safeContainerState, cleanupCommand, safeWorkflowOperation } from "../../scripts/docker-smoke-diagnostics.mjs";
// @ts-expect-error Native ESM port validation module intentionally has no declaration.
import { discoverLoopbackUrl, ephemeralPortOverride, portInspectFormat, singleContainerId, validatedLoopbackUrl } from "../../scripts/docker-smoke-ports.mjs";

type Entry = Record<string, unknown>;
const privateText = 'SECRET_KEY=fixture-private-key access_token=fixture-jwt refresh_token=fixture-refresh VAPID_PRIVATE_KEY=fixture-vapid endpoint=https://fcm.googleapis.com/private-subscription auth=fixture-subscription-auth';
const childFailure = () => Object.assign(new Error(`Command/argv must not escape: ${privateText}`), {
  code: 17, signal: "SIGTERM", killed: true,
  stdout: `#12 [production-dependencies 1/2] RUN pnpm prune --prod\n${privateText}`,
  stderr: `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY\n${privateText}`,
});
function harness(failures: Record<string, Error> = {}, discoveryChanges: Entry = {}) {
  const entries: Entry[] = [], commands: string[][] = [];
  const injected = new Set<string>();
  let current = "", provisions = 0, envFile = "", generated = "", discoveries = 0;
  function maybeFail() { if (failures[current] && !injected.has(current)) { injected.add(current); throw failures[current]; } }
  const execute = vi.fn(async (_file: string, args: string[], options?: { env: NodeJS.ProcessEnv }) => {
    commands.push(args);
    if (args[0] === "info") {
      maybeFail();
      return { stdout: "linux\n", stderr: "" };
    }
    if (args[0] === "inspect") {
      maybeFail();
      if (args.includes(portInspectFormat)) {
        const scoped = commands.find(command => command[0] === "compose")!;
        const project = scoped[scoped.indexOf("--project-name") + 1];
        return { stdout: JSON.stringify({ id: args.at(-1), project, service: "app", running: true,
          ports: { "8122/tcp": [{ HostIp: "127.0.0.1", HostPort: discoveries === 1 ? "43123" : "43124" }] },
          requestedPorts: { "8122/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
          ...discoveryChanges,
        }), stderr: "" };
      }
      return { stdout: "0\n", stderr: "" };
    }
    envFile = args[args.indexOf("--env-file") + 1];
    generated = await readFile(envFile, "utf8");
    expect(generated).not.toContain("STAGING_PORT=");
    expect(await readFile(args[args.lastIndexOf("-f") + 1], "utf8")).toBe(ephemeralPortOverride);
    expect(options?.env?.STAGING_SECRET_KEY).toBeUndefined();
    maybeFail();
    const command = args.slice(args.lastIndexOf("-f") + 2);
    if (command[0] === "run" && command.at(-1) === "provision" && ++provisions === 2)
      throw Object.assign(new Error("expected fixture refusal"), { code: 1, stderr: "SQLite initialization refused: use a new absolute path with an existing parent; no existing file was overwritten." });
    if (command[0] === "ps") {
      if (command.includes("--quiet")) discoveries++;
      return { stdout: command.includes("json") ? JSON.stringify([{ Service: "app", State: "exited", Health: "unhealthy", ExitCode: 17, Command: privateText, Labels: privateText }]) : `${(discoveries <= 1 ? "a" : "b").repeat(64)}\n`, stderr: "" };
    }
    if (command[0] === "logs") return { stdout: `${privateText}\nInvalid SECRET_KEY configuration`, stderr: "" };
    return { stdout: privateText, stderr: "" };
  });
  const workflow = vi.fn(async (_base: string, _password: string, progress: (value: string) => void) => {
    progress("http:POST:/api/auth/login");
    progress(privateText); // Unexpected labels must also be suppressed.
    maybeFail();
    return { kid: privateText };
  });
  const restart = vi.fn(async (_base: string, _state: unknown) => { maybeFail(); });
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
  expect(h.workflow.mock.calls[0][0]).toBe("http://127.0.0.1:43123");
  expect(h.restart.mock.calls[0][0]).toBe("http://127.0.0.1:43124");
  expect(h.commands.filter(args => args.includes(portInspectFormat)).map(args => args.at(-1))).toEqual(["a".repeat(64), "b".repeat(64)]);
  expect(h.commands.some(args => args.includes("port"))).toBe(false);
  expect(h.entries.filter(entry => entry.status === "pass").map(entry => entry.stage)).toEqual([
    "docker-availability", "fixture-directory", "fixture-configuration", "build-runtime-image", "build-provisioner-image",
    "provision-database", "reject-repeated-provisioning", "startup-health", "discover-loopback-port", "http-ws-workflow",
    "native-sqlite-wal-scheduler-checks", "openssl", "sigterm-stop", "sigterm-exit-code", "read-container-probes",
    "mock-push-unix-permission-probes", "restart-health", "restart-loopback-port", "restart-persistence", "compose-cleanup",
    "temporary-file-cleanup", "docker-smoke",
  ]);
  await h.assertPrivateAndRemoved();
});

const containerId = "c".repeat(64), projectId = "chorequest-phase6-abcdef012345";
const validPorts = { "8122/tcp": [{ HostIp: "127.0.0.1", HostPort: "54321" }] };
const portMetadata = (changes: Entry = {}) => ({ id: containerId, project: projectId, service: "app", running: true, ports: validPorts,
  requestedPorts: { "8122/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] }, ...changes });

it("accepts one allocated loopback TCP mapping for the exact project/service/container", () => {
  expect(validatedLoopbackUrl(JSON.stringify(portMetadata()), containerId, projectId)).toBe("http://127.0.0.1:54321");
  expect(singleContainerId(`${containerId}\n`)).toBe(containerId);
  expect(ephemeralPortOverride).toContain("ports: !override");
  expect(ephemeralPortOverride).toContain("host_ip: 127.0.0.1");
  expect(ephemeralPortOverride).not.toContain("published");
});

it.each([
  [null, "published_port_missing"],
  [{}, "published_port_missing"],
  [{ "8122/tcp": null }, "published_port_missing"],
  [{ "8122/tcp": [] }, "published_port_missing"],
  [{ "8122/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }] }, "host_port_invalid"],
  [{ "8122/tcp": [{ HostIp: "127.0.0.1", HostPort: "65536" }] }, "host_port_invalid"],
  [{ "8122/tcp": [{ HostIp: "127.0.0.1", HostPort: "1.5" }] }, "host_port_invalid"],
  [{ "8122/tcp": [{ HostIp: "0.0.0.0", HostPort: "54321" }] }, "host_binding_not_loopback"],
  [{ "8123/tcp": validPorts["8122/tcp"] }, "unexpected_target_or_protocol"],
  [{ "8122/udp": validPorts["8122/tcp"] }, "unexpected_target_or_protocol"],
  [{ ...validPorts, "8123/tcp": validPorts["8122/tcp"] }, "unexpected_target_or_protocol"],
  [{ "8122/tcp": [...validPorts["8122/tcp"], ...validPorts["8122/tcp"]] }, "published_port_ambiguous"],
  [{ "8122/tcp": "malformed" }, "port_metadata_malformed"],
])("rejects invalid/ambiguous published metadata (%j) as %s", (ports, portIssue) => {
  let error;
  try { validatedLoopbackUrl(JSON.stringify(portMetadata({ ports })), containerId, projectId); }
  catch (caught) { error = caught; }
  expect(safeDiagnostics(error)).toMatchObject({ portIssue, requestedBindingCount: 1 });
});

it.each([{ id: "d".repeat(64) }, { service: "provision" }, { project: "other-project" }])("rejects metadata for a different container/service/project (%j)", changes => {
  expect(() => validatedLoopbackUrl(JSON.stringify(portMetadata(changes)), containerId, projectId)).toThrow("Docker port discovery failed");
});

it("rejects malformed output and missing/multiple container IDs without leaking captured output", () => {
  for (const raw of [privateText, "{}garbage", "[]", JSON.stringify([portMetadata()])]) {
    expect(() => validatedLoopbackUrl(raw, containerId, projectId)).toThrow("Docker port discovery failed");
  }
  for (const raw of ["", privateText, `${containerId}\n${"d".repeat(64)}`])
    expect(() => singleContainerId(raw)).toThrow("Docker port discovery failed");
});

it("reports requested versus missing live bindings using counts only", () => {
  let failure;
  try { validatedLoopbackUrl(JSON.stringify(portMetadata({ ports: null, Env: privateText, Labels: privateText })), containerId, projectId); }
  catch (error) { failure = error; }
  const diagnostic = safeDiagnostics(failure);
  expect(diagnostic).toMatchObject({ portIssue: "published_port_missing", requestedBindingCount: 1, publishedBindingCount: 0, publishedTargetCount: 0 });
  expect(JSON.stringify(diagnostic)).not.toContain(privateText);
});

it("preserves an inspect query's failure classification without logging argv or private output", async () => {
  const compose = vi.fn(async (..._args: string[]) => ({ stdout: containerId })), execute = vi.fn(async (_file: string, _args: string[]) => { throw childFailure(); });
  let failure;
  try { await discoverLoopbackUrl({ compose, execute, docker: "synthetic-docker", project: projectId }); }
  catch (error) { failure = error; }
  expect(safeDiagnostics(failure)).toMatchObject({ portIssue: "port_query_failed", exitCode: 17 });
  expect(JSON.stringify(safeDiagnostics(failure))).not.toContain("fixture-private-key");
  expect(execute.mock.calls[0][1]).toContain("--type");
  expect(execute.mock.calls[0][1]).toContain(portInspectFormat);
  expect(portInspectFormat).not.toContain(".Config.Env");
  expect(portInspectFormat).not.toContain("{{json .Config.Labels}}");
});

it.each(["discover-loopback-port", "restart-loopback-port"])("preserves isolated cleanup if %s query fails", async stage => {
  const h = harness({ [stage]: childFailure() });
  await expect(h.run()).rejects.toMatchObject({ stage, diagnostic: { exitCode: 17, portIssue: "port_query_failed" } });
  expect(h.commands.some(args => args.includes("down"))).toBe(true);
  expect(h.entries).toContainEqual(expect.objectContaining({ stage: "compose-cleanup", status: "pass" }));
  await h.assertPrivateAndRemoved();
});

it("cleans the private override/project and never starts HTTP if the healthy container has no live published mapping", async () => {
  const h = harness({}, { ports: null });
  await expect(h.run()).rejects.toMatchObject({ stage: "discover-loopback-port", diagnostic: {
    portIssue: "published_port_missing", requestedBindingCount: 1, publishedBindingCount: 0,
  } });
  expect(h.workflow).not.toHaveBeenCalled();
  expect(h.entries).toContainEqual(expect.objectContaining({ stage: "compose-cleanup", status: "pass" }));
  await h.assertPrivateAndRemoved();
});
