# Phase 6.1 — Linux CI failure investigation and instrumentation

Starting branch/commit: `node-js-conversion` /
`c2d6cf03fc5e28c8e3f5ce281a29fdf06ec3b064`. The working tree was clean.
No commit, push, deployment, production database access, daemon/service start,
DNS or proxy change was performed.

## Verified GitHub evidence

Read the actual GitHub run metadata, jobs and decoded job logs through the
connected GitHub tools (not just the supplied summary):

- [Run 40449453153](https://github.com/austinstiefel/ChoreQuest/actions/runs/40449453153),
  attempt 1, completed failure at the exact starting commit.
- Backend job `122008489451`: success; actual logs show **323 tests passed in
  24 files, no skips**, schema-engine db-push/deploy both pass, 28 tables and
  clean foreign keys. Frontend job `122008489730`: success.
- [Linux-container job 122008956714](https://github.com/austinstiefel/ChoreQuest/actions/runs/40449453153/job/122008956714):
  installation passed; `node scripts/docker-smoke.mjs` failed with only the
  generic wrapper error. The step ran approximately 44 seconds. No build-step
  output, child-process exit code, application response or container stage was
  published. The old script captured stdout/stderr and then discarded them.

**Original underlying failure stage and cause: NOT ESTABLISHED.** The log cannot
distinguish build, provisioner, health, HTTP/WS, native/permission, shutdown or
restart failures. Timing alone is insufficient. There is no evidence to blame
pnpm pruning, Prisma, bcrypt, sharp, filesystem restrictions or the application.
No speculative image, dependency, Prisma, Compose or runtime changes were made.

The confirmed defects corrected are loss of stage/process diagnostics and cleanup
failure replacing the original error. A new instrumented Linux execution is
needed to identify and then correct the original container defect, if any.

## Changes

Only these five files comprise this correction:

1. `scripts/docker-smoke.mjs`: named structured start/pass/fail events with
   elapsed time; runtime/provisioner builds reported separately; sanitized
   process diagnostics; private workflow progress; safe container metadata and
   classified application-log diagnostics before cleanup; original failure
   preserved even if cleanup also fails. The exact random project and safe Linux
   cleanup command are reported when needed. Initial project allocation is also
   logged for interrupted-run recovery. Availability now explicitly requires a
   Linux daemon before allocating resources. CLI exits nonzero on any failure.
2. `scripts/docker-smoke-diagnostics.mjs`: bounded technical-code/category/
   BuildKit-stage extraction, HTTP/WS status classification, allowlisted container
   fields and workflow names, and strict disposable-project cleanup-command
   validation. Unknown output is suppressed instead of dumped.
3. `scripts/runtime-smoke.mjs`: optional progress callback for HTTP route/method,
   WS handshake, upload, committed events and static frontend checks. All existing
   assertions and workflow operations remain. Logged numeric IDs are replaced by
   route placeholders; unexpected labels are suppressed. No response bodies or
   authentication material are emitted.
4. `tests/runtime/docker-smoke.test.ts`: 14 focused regression cases using an
   injected fake executor, synthetic private values and temporary fixture files.
   No Docker daemon/application DB or real secret is required.
5. This handoff, `PHASE6-CI-FIX.md`.

Repeated provisioning must now reject specifically with exit 1 and the known
exclusive-initialization refusal; an unrelated Docker/permissions/transport error
no longer counts as a successful safety check. No failing check was skipped or
disabled. Dockerfile, ignore rules, Compose, CI workflow, provisioner implementation,
container probes, application/auth/business code, Python, frontend, dependencies,
lockfiles, Prisma and schema history are unchanged.

## Execution order and failure coverage

The instrumented smoke retains the complete sequence:

1. Linux Docker availability; private temporary directory/configuration and
   unique `chorequest-phase6-<12 hex>` project.
2. `build-runtime-image`, `build-provisioner-image`.
3. `provision-database`, `reject-repeated-provisioning`.
4. `startup-health`, `discover-loopback-port` (loopback-only ephemeral mapping).
5. `http-ws-workflow`: health/setup/login, disposable parent/child creation,
   login, WS handshake, chore create/complete/verify, points, reward redemption,
   upload, notifications/VAPID, committed events and static frontend. Each
   route/transport sub-operation reports a safe progress label.
6. `native-sqlite-wal-scheduler-checks`, `openssl`: bcrypt/sharp/Prisma loading,
   non-root, FK integrity, WAL and daily checkpoint, CA/timezone assets.
7. `sigterm-stop`, `sigterm-exit-code`: actual numeric container exit code,
   requiring zero rather than a forced kill.
8. `read-container-probes`, `mock-push-unix-permission-probes`: the existing
   compiled mocked-provider/durable retry, VAPID, scheduler and Unix write-refusal
   checks, still running in a separate disposable `/tmp` DB.
9. `restart-health`, `restart-loopback-port`, `restart-persistence`.
10. `compose-cleanup`, `temporary-file-cleanup`: executed on success or failure;
    cleanup failure also fails an otherwise successful run. A primary failure
    always remains primary.

Originally every awaited operation inside the broad try block could fail without
useful published diagnostics. Even cleanup could replace its predecessor. Now
each operation is named and logs a sanitized failure before cleanup; unexpected
setup exceptions also receive a safe fallback classification. A killed CI runner
cannot guarantee `finally` execution; the logged project allows isolated cleanup.

## Diagnostic security

There is **no raw-output fallback**. Never stringify original errors: their
message/argv, assertion actual/expected, stdout/stderr, response bodies and stack
can contain private material. Only known error names, numeric exit/HTTP/WS codes,
allowlisted process codes/signals, diagnostic categories, and recognized BuildKit
stage/step/instruction metadata survive. Build commands themselves are omitted.
Unknown output produces `capturedOutput: true` without exposing its content.
Application logs are captured only for this generated project and classified
through the same allowlist; raw lines are never printed or saved as artifacts.
Compose metadata discards command, labels, names, ports and environment. No
`docker inspect` environment or resolved `compose config` is requested.

Tests inject credential/JWT/refresh/VAPID/subscription strings into stdout,
stderr, error messages, assertion values, container metadata and unexpected
progress labels; output contains none of those values, nor the generated random
password/signing key. Cleanup uses only the validated random project. Its Linux
command uses harmless parsing placeholders plus `/dev/null`, so it works after
the private temporary env file is deleted and never prints actual credentials.
The command is `down --volumes` only; it does not start an account with those
placeholders. Run from the repository root and only for the exact reported test
project; do not substitute a production project.

## Verification

Local Windows Docker CLI is present, but the Linux daemon remains unavailable
(`dockerDesktopLinuxEngine` pipe missing). No daemon start/workaround was tried.
Running the revised CLI with the installed executable failed at the expected
`docker-availability` stage with process exit 1 before fixture allocation. This
verifies the failure path, **not** a container build/run.

Commands executed using the existing Git Bash Node 22 / pnpm 10.34.6 toolchain:

```bash
# server/
pnpm exec vitest run tests/runtime/docker-smoke.test.ts
pnpm exec node scripts/verify-schema-engine.mjs
pnpm typecheck
pnpm build
pnpm test
node --check scripts/docker-smoke.mjs
node --check scripts/docker-smoke-diagnostics.mjs
node --check scripts/runtime-smoke.mjs
# frontend/
npm run build
# repository root
git diff --check
git status --short
```

Focused tests: **14 passed**. They cover safe diagnostics, multiple injected
failure stages, targeted cleanup, primary-plus-cleanup errors, cleanup-only
failure, expected provisioning refusal vs unrelated failure, unavailable Docker,
operation/metadata filtering and preservation of the full successful sequence.
An initial test-double run reinjected the same fault into follow-up metadata
collection; corrected to inject each intended stage fault once, then all passed.

Final complete-suite/build/whitespace results are recorded below.

## Remaining blockers and next run

No new GitHub Actions run was dispatched, and these edits are not committed or
pushed. **The workflow is not claimed green.** The original run remains failed.
After developer review/commit/push, inspect the new `linux-container` job's first
`status: fail` JSON record, its preceding stage/operation, exit/classification,
container state and safe technical categories. Fix the demonstrated failure and
repeat the full image workflow; do not bypass a native/permission/health/security
assertion or infer success from the previously green backend/frontend jobs.

Commit recommendation: this is a focused diagnostic correction suitable for a
development-branch commit after local gates and independent review. It is not a
claim to have fixed the unknown original Linux container defect. Linux image,
staging and production acceptance remain blocked until actual new execution and
any resulting correction succeed. Production services/data were untouched.

### Final local results

| Check | Actual result |
| --- | --- |
| `pnpm exec node scripts/verify-schema-engine.mjs` | PASS: independent disposable db-push and migrate-deploy, 28 application tables and clean FKs each |
| `pnpm test` | PASS: **336 passed, 1 skipped (337 collected), 25 files**; existing Unix-only unwritable-directory startup test skipped on Windows; all 323 original cases retained |
| Focused new tests | PASS: 14 cases; no Docker daemon or application DB used |
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS |
| Frontend `npm run build` | PASS: 1,994 modules; existing large Profile chunk warning only |
| Three edited/new ESM scripts, `node --check` | PASS |
| `git diff --check` + explicit new-file whitespace/scope scan | PASS; only the five listed files changed; index empty |
| `docker compose --env-file <temporary-empty-file> -f server/compose.staging.yml config --quiet` | PASS with synthetic variables; static validation only |
| Revised CLI against installed Docker executable | Expected failure at `docker-availability`, exit 1, `docker_daemon_unavailable`; no fixtures/containers allocated |
| Full real Linux Docker build/runtime smoke | **BLOCKED / NOT RUN**: Linux daemon unavailable; no infrastructure workaround attempted |
| New GitHub Actions execution | **NOT RUN**: no commit/push/dispatch; original run remains failed |

The original run's verified 323/323 Linux backend result is historical evidence
for the starting commit, not a passing result for these unpushed changes.
No application server was added for these diagnostic tests; existing integration
fixtures started/stopped their own disposable servers. No user service or real
database was accessed, reset or modified. No dependencies were installed/changed.

Ready for an independently reviewed development-branch **diagnostic** commit;
not ready to claim the underlying container defect corrected or CI/staging green.
