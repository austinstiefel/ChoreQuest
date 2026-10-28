// Child-process Error.message includes command/argv, and assertions can include
// token/key actual/expected values. Expose categories, never raw error dumps.
import { portIssues } from "./docker-smoke-ports.mjs";
const processCodes = new Set(["ENOENT", "EACCES", "EPERM", "ENOSPC", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ABORT_ERR", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]);
const kinds = new Set(["AssertionError", "TypeError", "SyntaxError", "AbortError", "TimeoutError", "Error"]);
const signatures = [
  ["docker_daemon_unavailable", /failed to connect to the docker API|Cannot connect to the Docker daemon|dockerDesktopLinuxEngine/i],
  ["noninteractive_module_removal", /ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY/],
  ["lockfile_mismatch", /ERR_PNPM_OUTDATED_LOCKFILE/],
  ["prisma_client_not_generated", /@prisma\/client did not initialize/i],
  ["module_not_found", /Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/],
  ["native_library_load", /ERR_DLOPEN_FAILED|invalid ELF header|libssl\.so|libcrypto\.so|GLIBC_[\d.]+|Could not load the .sharp. module/],
  ["filesystem_permission", /EACCES|EPERM|Permission denied/i],
  ["readonly_filesystem", /Read-only file system|readonly database/i],
  ["missing_file", /ENOENT|No such file or directory/],
  ["sqlite_open_failure", /unable to open database file/i],
  ["sqlite_locked", /database is locked|SQLITE_BUSY/i],
  ["container_unhealthy", /unhealthy|failed to become healthy/i],
  ["port_binding", /port is already allocated|failed to bind host port|address already in use/i],
  ["port_mapping_missing", /no port 8122\/tcp for container/i],
  ["compose_override_unsupported", /unknown tag.*!override|unsupported.*!override/i],
  ["image_platform", /no matching manifest|exec format error/i],
  ["build_failure", /failed to solve|did not complete successfully/i],
  ["build_input_missing", /failed to (?:compute cache key|calculate checksum)/i],
  ["registry_failure", /failed to resolve source metadata|manifest unknown|pull access denied|toomanyrequests/i],
  ["network_timeout", /i\/o timeout|context deadline exceeded|ETIMEDOUT/i],
  ["corepack_signature", /Cannot find matching keyid/],
  ["initialization_refused", /SQLite initialization refused: use a new absolute path/],
  ["database_unprepared", /SQLite database is missing, invalid or uninitialized|Account schema upgrade required/],
  ["configuration_invalid", /Invalid (?:SECRET_KEY|PORT|COOKIE_SECURE|CORS_ORIGINS|VAPID_CLAIM_EMAIL) configuration|Both VAPID key overrides must be configured together/],
  ["shutdown_timeout", /Graceful shutdown timed out/],
];

export function safeDiagnostics(error) {
  const text = [error?.stdout, error?.stderr].filter(value => typeof value === "string").map(value => value.slice(-48000)).join("\n");
  const codes = [...new Set(text.match(/\b(?:ERR_PNPM_[A-Z_]{1,70}|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_DLOPEN_FAILED|P\d{4}|TS\d{4,5})\b/g) ?? [])].slice(0, 12);
  const steps = [...text.matchAll(/#\d+ \[(frontend-build|server-build|production-dependencies|provisioner|runtime) (\d+\/\d+)\](?: (RUN|COPY|WORKDIR|USER|ENV))?/g)]
    .map(match => `${match[1]} ${match[2]}${match[3] ? ` ${match[3]}` : ""}`);
  const code = error?.code ?? error?.cause?.code;
  const httpStatus = /^(?:GET|POST|PUT|DELETE) \/api\/[a-zA-Z0-9_/-]+ returned ([1-5]\d\d)$/.exec(error?.message ?? "")?.[1];
  const websocketStatus = /^Unexpected server response: ([1-5]\d\d)$/.exec(error?.message ?? "")?.[1];
  const portEvidence = Object.fromEntries(["requestedBindingCount", "publishedTargetCount", "publishedBindingCount"]
    .filter(key => Number.isInteger(error?.portEvidence?.[key]) && error.portEvidence[key] >= 0 && error.portEvidence[key] <= 65535)
    .map(key => [key, error.portEvidence[key]]));
  return {
    kind: kinds.has(error?.name) ? error.name : "Error",
    ...(Number.isInteger(code) ? { exitCode: code } : processCodes.has(code) ? { code } : {}),
    ...(error?.signal && /^SIG[A-Z0-9]{1,12}$/.test(error.signal) ? { signal: error.signal } : {}),
    ...(error?.killed === true ? { killed: true } : {}),
    ...(httpStatus ? { httpStatus: Number(httpStatus) } : {}),
    ...(websocketStatus ? { websocketStatus: Number(websocketStatus) } : {}),
    ...(portIssues.has(error?.portIssue) ? { portIssue: error.portIssue, ...portEvidence } : {}),
    codes, categories: signatures.filter(([, pattern]) => pattern.test(text)).map(([category]) => category),
    buildSteps: [...new Set(steps)].slice(-8), capturedOutput: text.length > 0,
    // No fallback raw-output path; add reviewed categories for unknown failures.
  };
}

export class SmokeStageError extends Error {
  constructor(stage, error) {
    super(`Docker smoke stage failed: ${stage}`);
    this.stage = stage;
    this.diagnostic = safeDiagnostics(error);
  }
}

export async function smokeStage(stage, action, log) {
  const started = Date.now();
  log({ stage, status: "start" });
  try {
    const result = await action();
    log({ stage, status: "pass", elapsedMs: Date.now() - started });
    return result;
  } catch (error) {
    const failure = new SmokeStageError(stage, error);
    log({ stage, status: "fail", elapsedMs: Date.now() - started, ...failure.diagnostic });
    throw failure;
  }
}

export function safeContainerState(stdout) {
  const entries = stdout.trim().startsWith("[") ? JSON.parse(stdout) : stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  return entries.filter(entry => ["app", "provision"].includes(entry.Service)).map(entry => ({
    service: entry.Service,
    state: ["running", "exited", "created", "restarting", "dead", "paused", "removing"].includes(entry.State) ? entry.State : "unknown",
    health: ["healthy", "unhealthy", "starting", ""].includes(entry.Health) ? entry.Health : "unknown",
    ...(Number.isInteger(entry.ExitCode) ? { exitCode: entry.ExitCode } : {}),
  }));
}

export function cleanupCommand(project) {
  if (!/^chorequest-phase6-[a-f0-9]{12}$/.test(project)) throw new Error("Invalid disposable project identifier");
  // Linux CI / repository root. Placeholders only parse `down`; never start app.
  return `STAGING_SECRET_KEY=cleanup-only-placeholder STAGING_ADMIN_PASSWORD=cleanup-only-placeholder docker compose --project-name ${project} --env-file /dev/null -f server/compose.staging.yml down --volumes --remove-orphans --timeout 75`;
}

const workflowOperations = new Set([
  "websocket-handshake", "upload", "committed-websocket-event", "static-frontend",
  "http:GET:/api/health", "http:GET:/api/auth/setup-status", "http:POST:/api/auth/login",
  "http:POST:/api/admin/users", "http:GET:/api/chores/categories", "http:POST:/api/chores",
  "http:GET:/api/chores/:id", "http:POST:/api/chores/:id/complete", "http:POST:/api/chores/assignments/:id/verify",
  "http:GET:/api/auth/me", "http:POST:/api/rewards", "http:POST:/api/rewards/:id/redeem",
  "http:GET:/api/rewards/redemptions", "http:GET:/api/notifications", "http:GET:/api/push/vapid-public-key",
]);
export function safeWorkflowOperation(value) {
  const operation = typeof value === "string" ? value.replace(/\/\d+(?=\/|$)/g, "/:id") : "unknown";
  return workflowOperations.has(operation) ? operation : "unknown";
}
