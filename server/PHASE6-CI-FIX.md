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

## Phase 6.2 — ephemeral loopback publication and discovery

Starting commit: `18a16fe46399a0ea6880488d510d8d995e1187e5`, branch
`node-js-conversion`. Existing untracked `phase6.1-full-review.diff` was preserved.
This section supplements the historical Phase 6.1 findings above.

### Second run: verified evidence and limits

Read run metadata, job results and actual decoded logs for
[run 40455183259](https://github.com/austinstiefel/ChoreQuest/actions/runs/40455183259).
It ran at exactly the starting commit. Backend job `122026736281` passed with
**337 tests / 25 files / no skips**; frontend also passed. In
[Linux-container job 122027378843](https://github.com/austinstiefel/ChoreQuest/actions/runs/40455183259/job/122027378843),
both image builds, provisioning, expected repeat refusal and startup/health passed.
`discover-loopback-port` failed with child exit 1. The app was running/healthy;
both cleanup stages passed. HTTP/WS and subsequent runtime checks did not run.

**Established:** the failing operation was `docker compose port app 8122`, not
the old regex assertion (the reported kind was Error, not AssertionError).
**Not established:** why that command failed, whether an active host mapping
existed, or whether explicit zero caused the failure. The failed run published
no requested/live port-map metadata; cleanup removed its disposable containers.
No usable local Linux Docker daemon is available for reproduction.

Static evaluation with installed Compose v5.5.0 accepted the old
`127.0.0.1:0:8122` and normalized it to target 8122/TCP, host 127.0.0.1, published
`"0"`. Therefore it is not justified to call that syntax invalid from this log.
Static normalization does not prove actual host allocation or reachability.
Docker's [Compose ports reference](https://docs.docker.com/reference/compose-file/services/#ports)
supports omitting the host port for automatic allocation. The correction uses
that definition explicitly and validates actual live metadata rather than
inferring runtime state from a requested configuration or internal health check.

### Exact correction (five files)

- `scripts/docker-smoke.mjs`: remove `STAGING_PORT=0` from the generated test
  environment; create `compose.smoke.yml` inside the existing private temporary
  directory, exclusively with mode 0600. All Compose operations, including
  cleanup, use the base file plus this override. Both initial and post-restart
  discovery call the same fresh metadata-query function.
- New `scripts/docker-smoke-ports.mjs`: owns the override and strict query/parser.
  Its generated override is exactly:

  ```yaml
  services:
    app:
      ports: !override
        - target: 8122
          host_ip: 127.0.0.1
          protocol: tcp
  ```

  `published` is omitted. The [Compose replacement rule](https://docs.docker.com/reference/compose-file/merge/#replace-value)
  requires Compose >= 2.24.4; `!override` replaces the base sequence instead of
  appending another mapping. There is no fallback to wildcard binding or fixed
  test port. An unsupported Compose version fails visibly.
- `scripts/docker-smoke-diagnostics.mjs`: expose only allowlisted `portIssue`
  categories and requested/published binding counts; preserve child exit/signal/
  code classification on query failure. Add safe missing-port/unsupported-override
  categories. No raw response, environment, labels or port-map dump is logged.
- `tests/runtime/docker-smoke.test.ts`: retain the original 14 diagnostics/
  security/provisioning/cleanup cases and add 23 port cases. The orchestration
  fixture now models two Compose files and real-shaped container inspect data.
- `PHASE6-CI-FIX.md`: this investigation, correction and evidence.

Normal `compose.staging.yml` is **unchanged**, with its default loopback 8123
publication. Dockerfile, CI workflow, network isolation, capabilities, read-only
filesystem, provisioning rules, Python/frontend/application source, Prisma,
dependencies and lockfiles are unchanged. The generated override never enters
the repository or image, and is removed with the existing private test directory.
The existing base-only manual `down` command remains sufficient for cleaning the
same generated project if automatic cleanup fails; it creates no new services.

### Live metadata checks

1. Query `compose ps --all --quiet app` within the uniquely generated project;
   require exactly one full 64-hex container ID.
2. Use `docker inspect --type container --format <fixed-template> <that-id>`.
   Request only ID, running state, the two exact Compose project/service identity
   values, `HostConfig.PortBindings` and `NetworkSettings.Ports`. No environment
   or complete labels/configuration is requested. Identity values are consumed
   privately and never emitted as label data.
3. Require matching ID/project, service `app`, and a running container. Require
   the live port map to contain exactly `8122/tcp` with one binding. Reject absent,
   malformed, duplicate or unexpected target/protocol entries.
4. Require exact `HostIp: "127.0.0.1"` and a decimal `HostPort` from 1–65535.
   Reject zero, wildcard/all-interface binding, invalid values and competing
   mappings. Only then construct the HTTP URL. Requested ports are diagnostic
   evidence only; they can never substitute for an active mapping.
5. After restart repeat both container lookup and inspection, accepting a newly
   assigned valid port and/or new matching container ID, without caching the URL.

This follows Docker's documented
[port-map inspection structure](https://docs.docker.com/reference/cli/docker/inspect/#find-a-specific-port-mapping).
If the next runner has a requested binding but no live mapping, the failure will
show `published_port_missing`, requested count 1 and published count 0. The smoke
will fail safely before HTTP, retaining its primary error and cleaning only its
own project; it will not guess another address or relax the staging network.
The existing internal network remains unchanged; any engine/network publication
issue still requires actual metadata/runtime evidence, not a speculative change.

### Regression coverage and static configuration proof

The focused file passed **37 cases**: the original 14 plus 23 additions covering
valid allocated loopback, missing/null mappings, host port 0/out-of-range/noninteger,
wildcard IP, wrong target/protocol, competing/duplicate bindings, wrong identity,
malformed JSON, multiple/missing container IDs, query failure, and cleanup.
The successful orchestration case changes both container ID and host port after
restart and verifies that the workflows receive the new validated URL.

Using the actual exported override string and synthetic environment variables,
`docker compose ... config --format json` passed these assertions without a
daemon: base staging has exactly one loopback mapping published on 8123; smoke
has exactly one loopback 8122/TCP mapping with no `published` field. Resolved
configurations are deeply equal after removing only the app `ports` field.
This proves staging defaults and all other settings are preserved **statically**;
it does not prove Linux runtime publication.

### Phase 6.2 validation and acceptance

Commands actually executed:

```bash
# server/
pnpm exec vitest run tests/runtime/docker-smoke.test.ts
pnpm typecheck
pnpm build
pnpm exec node scripts/verify-schema-engine.mjs
pnpm test
node --check scripts/docker-smoke.mjs
node --check scripts/docker-smoke-diagnostics.mjs
node --check scripts/docker-smoke-ports.mjs
# frontend/
npm run build
# repository root
git diff --check
git status --short
```

Also executed: read-only Docker availability/version commands and static Compose
normalization/configuration comparison, with temporary empty environment files
and synthetic credentials. The first focused typecheck identified two mock
functions typed with no parameters; adding their actual argument signatures
corrected the test typings without weakening assertions.

| Phase 6.2 check | Actual result |
| --- | --- |
| Focused Docker smoke regressions | PASS: 37 tests (14 retained, 23 added) |
| Full `pnpm test` | PASS; original 337 cases retained plus 23 added; existing Unix-only startup permission case skipped on Windows |
| Typecheck and production TypeScript build | PASS |
| Schema-engine verifier | PASS: separate disposable db-push/deploy, 28 app tables, clean FKs |
| Frontend production build | PASS: 1,994 modules; existing Profile chunk warning only |
| Three smoke-script syntax checks | PASS |
| Exact generated Compose override / normal config comparison | PASS, static only; default 8123 and all other settings preserved |
| Diff/new-file whitespace and scope checks | PASS |
| Real Linux Docker smoke | BLOCKED / NOT RUN: Linux daemon unavailable |
| New GitHub Actions run | NOT RUN: no commit, push or dispatch |

All tests use disposable SQLite or synthetic metadata; no development database,
production state, network settings or running service was modified. No package
or dependency installation/change was required. Automatic cleanup and all prior
security/provisioning assertions remain enabled.

**Root-cause verdict:** the failing query is established; the engine/Compose
reason and the role of explicit zero are **not established** by available
evidence. The correction removes that dependency and adds validated inspection.
**Real Linux acceptance:** full end-to-end smoke has **not passed**. The previous
CI proves its images build and start, but the new publication/discovery logic and
all downstream workflows still need an actual Linux Docker run. No new workflow
was dispatched and no commit/push/deployment was performed. Runtime success is
unverified locally because the Linux daemon is unavailable. Review this focused
patch for a development-branch commit, then require the next complete CI run to
pass before claiming staging acceptance or proceeding toward production.

## Phase 6.3 — replace the internal-only staging bridge

Starting branch/commit: `node-js-conversion` /
`bec2664a3fa483aa7a39a93ef7d01a68d1794f45`. Tracked files were clean; existing
untracked `changes-CI-Fix.diff` and `phase6.1-full-review.diff` were left untouched.

### Third failed run and cause assessment

Read actual run metadata, jobs and decoded logs for
[run 40623038233](https://github.com/austinstiefel/ChoreQuest/actions/runs/40623038233),
whose head matches the starting commit. Backend job `122601359591` passed
**360/360 tests in 25 files with no skips**; frontend job `122601359233` passed.
In [Linux-container job 122601985269](https://github.com/austinstiefel/ChoreQuest/actions/runs/40623038233/job/122601985269),
runtime/provisioner builds, fresh provisioning, expected repeat refusal and health
passed. Discovery then failed with:

```json
{"portIssue":"published_port_missing","requestedBindingCount":1,"publishedTargetCount":0,"publishedBindingCount":0}
```

The app was running/healthy with exit code 0. Both cleanup stages passed. This
time live inspection proves the request was stored without a realized published
mapping; this is not merely a `compose port` formatting failure. No host HTTP,
WS or later container acceptance steps ran.

The app's only network was `isolated`, configured with `internal: true`.
[Docker's network documentation](https://docs.docker.com/reference/compose-file/networks/#internal)
distinguishes externally isolated internal networks from normal external
connectivity. [Moby discussion #53256](https://github.com/moby/moby/discussions/53256)
reports the same internal-only bridge behavior: a healthy service, stored publish
request, absent live port, and a working normal-bridge control. That independent
report supports the proposed correction but does not reproduce this application.

**Cause status: internal-only networking is the leading, evidence-supported
hypothesis, not locally runtime-confirmed.** The installed Docker CLI exists
(Compose v5.5.0), but `docker info` still fails because the Linux-engine pipe is
absent. No daemon was started or infrastructure changed. A real Linux run after
this correction is required before claiming the hypothesis proven or the issue
fully resolved. Static parsing and synthetic tests cannot provide that proof.

### Minimal configuration and security change

Four files are changed:

- `compose.staging.yml`: app now attaches to the project-scoped `staging` network
  with `driver: bridge`, replacing `isolated: { internal: true }`. No explicit
  shared network name, `external` reference or production proxy attachment is
  added. The explicit `127.0.0.1:${STAGING_PORT:-8123}:8122` mapping is unchanged.
- `docs/staging-runbook.md`: documents outbound connectivity, retains inbound
  loopback restrictions, explains mocked push/no real subscription policy,
  controlled real-push acceptance, and a proposed separate no-egress test mode.
  Also documents the existing Compose >= 2.24.4 requirement and static-test CLI
  selection through `CHOREQUEST_TEST_DOCKER`.
- New `tests/runtime/docker-network.test.ts`: five tests parse both real normal
  and ephemeral configurations using the installed Compose CLI, plus another
  project name, without contacting a Docker daemon or creating containers.
- `PHASE6-CI-FIX.md`: this evidence, security assessment, validation and verdict.

**Security difference: the standard bridge may allow outbound traffic. Staging
is no longer egress-blocked.** Host-local inbound publication remains explicit;
there is no wildcard/host-network fallback. Independent project networks and
volumes do not constitute an outbound firewall. Real provider acceptance needs
operator-approved controlled outbound HTTPS, HTTPS/browser permission and VAPID
configuration. Network capability is not authorization to send real push.

Automated smoke still provisions only new synthetic data; its HTTP workflow
does not create push subscriptions. The compiled push probe injects a mock sender
and uses a separate `/tmp` database. It does not contact real push providers.
Application-side push endpoint allowlisting is unchanged. No production database,
uploads, credentials, external network or live service was used.

For strict no-egress testing, the runbook proposes a separate disposable internal
network with host publication removed and assertions run inside the container/
network, or `network_mode: none` for local-only probes. That mode is **not** host
HTTP/WS acceptance. No additional mode/network/firewall infrastructure was added.

The Phase 6.2 override, exact container/project/service/running checks, single
8122/TCP binding, exact 127.0.0.1 host IP, nonzero 1–65535 port, competing-map
rejection and fresh restart discovery are unchanged. So are non-root image user,
dropped capabilities, no-new-privileges, read-only root, private DB/uploads
volumes, provisioning tools profile and `network_mode: none` for provisioner.
Root Python Compose/Dockerfile, application/frontend/Python source, Prisma,
dependencies and workflow were not modified. Existing CI runs the new tests
through `pnpm test`; its real Docker job must still pass the complete smoke.

### Focused test evidence

**42 focused tests passed:** all existing 37 diagnostics/port/cleanup cases plus
five new real-CLI static configuration tests. New assertions verify:

1. Normal staging has exactly one 127.0.0.1:8123 → 8122/TCP mapping.
2. The actual exported temporary override yields exactly one 127.0.0.1 mapping
   with target 8122/TCP and `published` omitted, without retaining port 8123.
3. App attaches only to a non-internal/non-external standard bridge; its resolved
   name changes with Compose project (`<project>_staging`). No host networking.
4. No fixed container name/privilege elevation, hardening unchanged, DB URL
   unchanged, no host bind mounts, and named DB/uploads volumes scoped to the
   test project. Provisioner remains opt-in and has no network.
5. Normal and ephemeral configurations are identical except for app ports;
   production Compose bytes remain unchanged during static inspection. Final
   Git scope checks independently confirm no root deployment edits.

These tests use explicit empty temporary environment files and synthetic config
values. They do not parse the user's `.env`. Config digest comparison avoids
printing resolved environment values. Static checks require the existing Docker
Compose CLI, selected by PATH or `CHOREQUEST_TEST_DOCKER`; no daemon is required.
The initial focused run correctly omitted the tools-profile service from default
`config` output; the test now enables `--profile tools` **for inspection only**
and verifies that provisioning remains opt-in. No application control was relaxed.

### Commands and final results

Executed with existing Git Bash Node 22/pnpm 10.34.6, explicit installed Docker
CLI selection on Windows, and disposable database fixtures only:

```bash
# server/ (CHOREQUEST_TEST_DOCKER may select the existing Docker CLI)
pnpm exec vitest run tests/runtime/docker-network.test.ts tests/runtime/docker-smoke.test.ts
pnpm exec node scripts/verify-schema-engine.mjs
pnpm build
pnpm test
pnpm typecheck
node --check scripts/docker-smoke.mjs
node --check scripts/docker-smoke-ports.mjs
node --check scripts/docker-smoke-diagnostics.mjs
node --check scripts/runtime-smoke.mjs
node --check scripts/container-probes.mjs
# frontend/
npm run build
# repository root
git diff --check
git status --short
```

Static validation invokes `docker compose --profile tools --project-name <test>
--env-file <temporary-empty-file> -f <staging-file> [ -f <temporary-override> ]
config --format json`, for both normal and smoke configuration and a second
project. All generated configuration/files are removed afterwards. No `up`,
`build`, `run`, network-creation or daemon command is part of these static tests.

| Phase 6.3 check | Actual final result |
| --- | --- |
| Focused static-network + existing smoke tests | PASS: **42 tests** across two files (5 new, 37 retained) |
| Full `pnpm test` | PASS: **364 passed, 1 skipped (365 collected), 26 files**; skip is the existing Unix-only unwritable-directory startup test on Windows |
| Schema-engine verifier | PASS: separate disposable db-push/deploy, 28 application tables and clean FKs each |
| `pnpm build` and `pnpm typecheck` | PASS |
| Five relevant JavaScript syntax checks | PASS |
| Frontend `npm run build` | PASS: 1,994 modules; existing large Profile chunk warning only |
| Normal/ephemeral Compose static parsing | PASS with the real CLI; no daemon, containers or network requests |
| Production Compose and Phase 6.2 discovery safeguards | Unchanged; verified by final Git scope inspection; original 37 tests still pass |
| `git diff --check`, new-file whitespace/scope inspection | PASS; only four implementation/report files changed; index empty |
| Full Linux Docker runtime | **BLOCKED / NOT RUN**: Linux-engine pipe unavailable |
| New GitHub Actions execution | **NOT RUN**; no commit, push or dispatch |

The complete command chain exited 0. No dependency/tool installation, database
migration against real state, live service/daemon start or production-network
operation was performed. Disposable integration fixtures used loopback test
servers and cleaned them up afterwards.

### Acceptance and remaining blockers

**Real Linux acceptance: NOT RUN / UNVERIFIED for this correction.** Original CI
verified builds, provisioning and internal health only. The next full Linux job
must demonstrate an allocated loopback port, real host HTTP and authenticated WS,
business workflow, native modules, WAL, mocked push, Unix permission rejection,
SIGTERM and restart persistence. No mock/static result substitutes for that run.
No GitHub workflow was dispatched and no commit/push/deployment was performed.

Recommend an independently reviewed development-branch commit of this focused
network correction after local gates pass. It is not production cutover approval
or proof that internal-only networking was the sole cause. Linux publication and
all downstream acceptance steps remain blockers until the actual next run passes.
