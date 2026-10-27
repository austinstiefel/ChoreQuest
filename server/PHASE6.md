# Phase 6 — deployment verification and recovery handoff

This work was performed on `node-js-conversion`, starting at the exact requested
Phase 5 commit `7437ac4f765a99075d7a7235fb6056781fe7be8e`. No production cutover,
Docker daemon/service start, proxy/DNS/tunnel change, commit or push occurred.
Only synthetic, disposable databases were used; the development/live database
was not opened, migrated or copied. Results below distinguish local Windows
execution from prepared but unexecuted Linux validation.

## A. Repository audit and documentation recovery

Starting tracked tree was clean; root `PHASE4.md` and `PHASE5.md` were already
untracked user files. Both remain untouched. `server/PHASE4.md` was restored
byte-for-byte from `7437ac4^:server/PHASE4.md`, and `server/PHASE5.md` copied
byte-for-byte from the actual root handoff. Both byte comparisons passed. The
Phase 5 test/browser results are recovered historical evidence, not invented
Phase 6 runs. The Prisma README's obsolete auth-only framing was updated while
retaining its explicit provisioning, copy-only preparation, baseline/checksum,
non-reused-ID and signing-key rotation safeguards.

Architecture reviewed: root Python Dockerfile/Compose (unchanged); opt-in Node
Dockerfile and ignore rules; Node/frontend package files and locks; all 28 Prisma
application tables and baseline history; initialization/preparation/snapshot
tools; server bootstrap/schema guards/static serving/shutdown; WS, push, VAPID,
daily scheduler; uploads and integration/compatibility fixtures. The original
Python application remains available and untouched. No CI existed initially.

Changes (repository-relative paths):

- `.github/workflows/node-migration.yml`: backend, frontend and Linux-container
  jobs, read-only repository permissions, no deployment/publication/secrets.
- `.gitignore`: private env, SQLite sidecars, backup/key exclusions.
- `server/Dockerfile.node`: OpenSSL/CA build dependencies for Prisma generation;
  separate full-CLI provisioner target; separate production-pruning stage with
  native import/encode probes. Runtime remains non-root; no migration on startup.
- `server/Dockerfile.node.dockerignore`: allowlisted build inputs plus sensitive
  file exclusions; tests/recovery/docs are not included in the build context.
- `server/compose.staging.yml`: separate opt-in project, internal network,
  loopback binding, independent named DB/uploads volumes, unprivileged read-only
  root filesystem and a separate explicit provisioning profile.
- `server/scripts/{create-staging-env,staging-init,docker-smoke,runtime-smoke,container-probes}.mjs`:
  exclusive private config creation, fixed-path fresh-only provisioning,
  disposable container orchestration, shared HTTP/WS/restart workflow, compiled
  native/mock-provider/permission probes.
- `server/scripts/snapshot-state.py`: SQLite-backup API plus uploads/config
  snapshot, integrity/FK checks, private permissions, hash manifest, new-directory
  restore. Existing destinations are never overwritten.
- `server/tests/helpers/python.ts`: explicit interpreter override for Linux CI;
  local default remains the repository's existing platform-specific `.venv`.
- Seven existing test files now use that helper: `business/rules.test.ts`,
  `db/deployment.test.ts`, `integration/business-startup.test.ts`,
  `integration/catalog-safety.test.ts`, `integration/legacy-compatibility.test.ts`,
  `integration/runtime-compat.test.ts`, `runtime/push.test.ts`.
- `server/tests/integration/deployment-runtime.test.ts`: fresh migrate/status/
  drift, compiled HTTP/WS/upload workflow, repeated startup/credential protection,
  persistence/recovery/Python reads, WAL/overwrite/corruption, Unix permission
  rejection and portable execution of the container probe.
- `server/tests/integration/catalog-safety.test.ts`: extended populated legacy
  fixture with reward history, transactions, notifications and safe subscriptions;
  compare every Store table before/after copy-only preparation and all existing
  SQL values through repeated seeding.
- `server/src/runtime/push.ts` and its existing test: distinct generic warnings
  for permanent rejection and exhausted retries, with no payload/key material.
- `server/prisma/README.md`, `server/PHASE4.md`, `server/PHASE5.md`, this handoff,
  `server/docs/staging-runbook.md`, `server/docs/cutover-runbook.md`.

No dependencies, lockfiles, Python source, frontend source, Prisma schema/history,
root Dockerfile or Python Compose were changed. Root untracked handoffs predate
this work and are not Phase 6 edits.

## B. Linux/Docker results

Docker CLI is installed, but `docker info --format '{{.ServerVersion}}'` failed:
the `dockerDesktopLinuxEngine` named pipe does not exist. Per the task boundary,
no daemon start, infrastructure workaround or service modification was attempted.

**NOT RUN locally:** image construction, Linux native loading, actual container
health/UID/volume permissions/WAL, container restart, real Linux SIGTERM, image
content inspection. A usable Docker daemon is the local validation blocker.

Prepared reproducible commands:

```bash
# repository root, only after a Linux Docker daemon is available
docker build -f server/Dockerfile.node -t chorequest-node-staging:phase6 .
cd server
node scripts/docker-smoke.mjs
```

The smoke builds runtime and provisioner from the root context with lockfiles,
generates unique private disposable config, uses a random Compose project,
explicitly initializes a new volume, and proves repeated initialization refuses
an existing DB. It waits for health, runs the shared compiled-image HTTP/WS/static/
upload/chore/reward workflow, checks bcrypt/sharp/Prisma, OpenSSL, CA/timezone data,
UID, WAL and scheduler state, verifies exit code 0 after Compose SIGTERM, executes
mock-push/permission probes on a separate `/tmp` DB, restarts and verifies state,
then removes only its own project/volumes in `finally`. No provider is contacted.
The probe script runs as an ephemeral `node -e` command and is not baked into
the image. Windows execution of its portable portion passed; Linux assertions
remain unexecuted locally.

The runtime is Debian bookworm/glibc, Node 22, unprivileged UID/GID 1000, pruned
production dependencies plus generated Prisma client, static frontend and
OpenSSL/CA/tzdata. The provisioner retains dev CLI dependencies independently.
Neither target implicitly migrates an arbitrary existing database. Successful
static review or Windows native probes do not prove a Linux image works.

## C. CI

`node-migration.yml` runs relevant-path pushes to `node-js-conversion`, relevant
pull requests, and manual dispatch. Three Ubuntu jobs:

1. Backend: Node 22, pnpm 10.34.6, Python 3.12 + existing requirements;
   `pnpm install --frozen-lockfile`, `pnpm prisma:generate`, schema engine check,
   typecheck, build, all Vitest tests. Python is explicitly selected through
   `CHOREQUEST_TEST_PYTHON`; tests no longer hardcode Windows.
2. Frontend: Node 22, `npm ci`, `npm run build`. No separate frontend test script
   exists; socket/service-worker tests are part of Vitest.
3. Linux container: after both quality jobs, frozen backend install and
   `node scripts/docker-smoke.mjs`. Disposable image/HTTP/WS/DB, mocked providers,
   native/permissions, restart and SIGTERM gates.

Permissions: `contents: read`; bounded timeouts/concurrency; no production secrets,
environment deployment, registry login, container push or settings changes.
Compose static parsing **passed** (`config --quiet`, explicit empty temporary
env file and synthetic values; no resolved secrets printed). Workflow structure
was inspected; **no GitHub Actions run has occurred** and no actionlint execution
is claimed. After manual commit/push, inspect all three real jobs and resolve
any Linux-only failures before staging acceptance. Green local tests are not a
substitute for that gate.

## D. Database safety and recovery

Fresh migration, status and zero-drift checks passed against new disposable
SQLite files, followed by compiled startup and account/business workflow.
Restart with a different `INITIAL_ADMIN_PASSWORD` preserved the actual credential;
original login still passed, no extra administrator was created. Existing
concurrent bootstrap/deletion/refresh/password safeguards continue in the suite.
Startup rejects missing/unprepared schemas; no automatic schema creation or
repair was added. Baseline and migrations are byte-unchanged.

Legacy rehearsal uses the offline fixtures, not a real source. Copy-only
preparation preserved source bytes and normalized records across all 25 Store
tables (the account suites separately cover API keys, invites and refresh tokens).
Expanded records cover IDs/roles/password/PIN hashes, balances/history,
assignments/rules/rotations/exclusions, streaks, achievements, avatar/pet state,
rewards/redemptions, settings, notifications and synthetic subscriptions. Existing
tests verify actual SQLAlchemy reads, microsecond timestamps, unique constraints,
named schema objects, sequence high-water marks, FKs and unsupported-schema
refusal. Repeated catalogue startup preserves existing SQL values and schedules.
Intentional insertions remain: missing achievements/settings by key, missing
built-in chore titles where categories/creator exist, and categories/templates/
avatar catalogue only when their respective table is empty. No overwrite or
destructive Python legacy rule cleanup is performed.

Recovery rehearsal passed: stop disposable compiled server; snapshot DB, uploads
and synthetic configuration; deliberately damage points/upload content; restore
into a new directory; verify original balance, upload availability, VAPID key,
authenticated REST state and actual Python SQLAlchemy reads. Separate WAL fixture
proved committed uncheckpointed rows and six-digit timestamps are captured;
overwrite attempts and corrupted-backup restores were rejected. Integrity/FKs
passed. No live Python service or production rollback was started.

Cross-resource consistency requires **writers stopped**; the tool cannot detect
that assertion automatically. New snapshot/restore directories only, mode 0700/
0600 on Unix; Windows needs equivalent ACLs. Hashes are corruption checks, not
cryptographic authentication of untrusted backups. Persistent-state inventory and
the post-cutover write-loss policy are in `docs/cutover-runbook.md`.

## E. Frontend and transports

Current frontend production build passed (1,994 modules, existing large Profile
chunk warning only). No frontend files were edited. Shared smoke passed against
the actual compiled backend on loopback, with a synthetic static HTML fixture;
the actual built React image is reserved for Docker CI. Phase 5's recovered
browser screenshots/results are historical; no new browser or real-device push
session was initiated in Phase 6.

The full runtime suite covers intended-recipient WS events, subprotocol/query
compatibility, Origin and JWT/DB activity checks, limits, expiry/heartbeat,
multiple sessions/reconnect, shutdown and post-commit rollback isolation.
Mocked push verifies payload routing, subscriptions, 404/410 cleanup, transient
failures/backoff/exhaustion, leasing/recovery/version checks, worker shutdown and
VAPID continuity/Python key parsing. Compiled-module provider injection also
passed without external requests. These are not real provider-delivery results.

NPM/HTTPS/wss/Cloudflare and real browser push are **NOT RUN**, deliberately.
`docs/staging-runbook.md` contains topology/access-log/header/timeouts/cookie/
Origin guidance and an explicit operator-approved ten-step push acceptance flow.
Default staging has no proxy network or external provider egress. No DNS, tunnel,
TLS certificate, browser permission or subscription enrollment was changed.

## F. Deployment security review

- Root Python deployment stays unchanged. Node staging has separate project/
  volumes, no production bind mounts/container names/network, loopback-only port,
  internal network, non-root runtime, dropped capabilities and read-only root.
  Image/volume assertions remain Linux gates, not locally proven statements.
- Build-context allowlist excludes local env/DB/key/backup/test artifacts; Git
  ignores common private-state patterns. Recovery paths are outside the repo.
  These exclusions do not inspect or certify every preexisting tracked asset as
  secret-free. No real secrets were opened/printed or used in tests.
- Fresh staging secrets are randomly generated into an exclusive private file;
  no public default password or insecure signing-key fallback. First login must
  stay private. A half-configured VAPID override fails, valid DB keys persist.
- Empty CORS does not allow arbitrary foreign origins; credentialed CORS and
  Secure cookie tests remain. HTTP loopback staging uses insecure transport only
  within the test boundary; HTTPS acceptance requires secure cookies and Origin.
- WS access uses current active DB user plus verified access JWT. Legacy query
  tokens can leak through default proxy access logs; use restricted logging.
  Do not log bearer subprotocol headers either. No unrestricted trust proxy.
- Uploads retain content decoding, size/pixel limits, random names and rollback
  cleanup. Public upload URLs are the existing contract, not a new privacy model.
  Static/API boundaries and no-cache service-worker behavior remain tested.
- Private `__runtime_*` settings stay hidden/rejected by parent settings APIs.
  No route/access-token/auth semantics were broadened. JWT localStorage and
  access-token validity until expiry remain existing design constraints.
- Established legacy cutover signing-key rotation remains mandatory (deleted-ID
  history cannot be reconstructed). Preserve VAPID identity separately; do not
  claim existing JWT session continuity during legacy cutover.

## G. Operational readiness

Daily scheduler tests cover UTC trigger/local date, Monday/DST and ahead-of-UTC
boundaries, repeated/restart reconciliation, independent connections/processes,
vacations, assignments, rotation, stale streaks, expired refreshes and transaction
rollback/checkpoint retry. Existing two-process tests passed locally; Linux
execution is assigned to CI. A single application replica remains required for
process-local WS fanout; do not use concurrent full runtimes as a scaling strategy.

Push jobs/settings/VAPID are SQLite-persistent; leases/backoff/exhaustion are
bounded, with possible duplicates after provider success before ACK and possible
non-delivery after terminal removal. New warnings distinguish exhaustion and
permanent rejection without logging payloads, endpoints or keys. Existing daily,
worker, startup, listener and shutdown diagnostics remain. WS authentication
rejection is intentionally not individually logged; use private client diagnostics.

`/api/health` remains liveness only. No readiness endpoint or schema-writing health
probe was added. Readiness requires authenticated read/write + operational checks.
Permission failures must be corrected through volume ownership/free-space/WAL
diagnosis, never a root-runtime fallback. Windows process termination verifies
state recovery but cannot prove Unix graceful-signal delivery; Linux CI checks
SIGTERM exit 0 with 75s Compose grace exceeding the 60s application deadline.

## H. Verification matrix and commands

| Concern / required verification | Evidence and result | Remaining gate |
| --- | --- | --- |
| Historical documentation | PASS: exact byte comparisons | None |
| Fresh schema engine | PASS: separate db-push and migrate-deploy temp files, 28 app tables, clean FKs | Linux repetition |
| Fresh deploy/status/drift + compiled workflow | PASS: deployment-runtime suite | Actual image run |
| Legacy records/schema/startup guards | PASS: compatibility/deployment/catalogue suites | Operator-specific copy rehearsal before cutover |
| DB/upload/config backup and restore | PASS: damage/restore + WAL + Python reads | Operator storage/ACL and restore acceptance |
| Full Vitest | PASS: 322 passed, 1 Unix-only permission test skipped on Windows; 24 files | Linux CI |
| TypeScript/build | PASS: final typecheck and production build | Linux CI |
| React build | PASS: 1,994 modules; existing chunk warning | Image inclusion acceptance |
| Mocked push/scheduler/VAPID compiled probes | PASS on Windows; Unix probe NOT RUN there | Linux image probe |
| Compose structure/isolation | PASS: Docker Compose static config validation | Runtime mounts/network/non-root checks BLOCKED locally |
| Docker image build/run/native modules | BLOCKED: Linux daemon unavailable | `node scripts/docker-smoke.mjs` in CI/Linux |
| Linux UID/WAL/read-only permissions/SIGTERM | NOT RUN locally; explicit Unix test skipped | Linux CI/container test |
| NPM/TLS/wss/Cloudflare | NOT RUN: no approved proxy/test host | Guided private staging acceptance |
| Real browser push/provider | NOT RUN: no enrollment/egress authorization | Guided operator-approved acceptance |
| GitHub Actions | NOT RUN: uncommitted workflow | Developer commit/push, inspect all jobs |
| Diff/new-file whitespace and script parse | PASS: tracked diff, new-file scan, five ESM scripts and Python syntax | None |

Commands actually executed (existing Git Bash Node 22.14.0 / pnpm 10.34.6;
Python checks use the existing repository `.venv/Scripts/python.exe`):

```bash
# server/
pnpm exec node scripts/verify-schema-engine.mjs
pnpm test
pnpm typecheck
pnpm build
pnpm exec vitest run tests/integration/deployment-runtime.test.ts
pnpm exec vitest run tests/integration/deployment-runtime.test.ts tests/integration/catalog-safety.test.ts
node --check scripts/create-staging-env.mjs
node --check scripts/staging-init.mjs
node --check scripts/docker-smoke.mjs
node --check scripts/runtime-smoke.mjs
node --check scripts/container-probes.mjs
# frontend/
npm run build
# repository root
git diff --check
git status --short
```

Also executed: read-only Docker availability check; `docker compose --env-file
<temporary-empty-file> -f server/compose.staging.yml config --quiet` with synthetic
process environment; byte comparison of recovered documentation. New-file
whitespace and ignore checks are recorded in the final verification below.

An initial new test-harness run failed because cleanup awaited a second exit
event on an already signaled Windows process. Cleanup now checks both exitCode
and signalCode; the corrected focused suite passed. No application defect or
data loss was involved. A sandbox temp-file permission issue during static
Compose validation was retried with scoped execution and passed. No environment
permissions, dependencies or user services were changed to make checks pass.

## I. Remaining gates

- **Commit blockers:** final local checks must pass; independently review all
  uncommitted changes. No known remaining functional defect from local tests.
- **Staging blockers:** actual Linux CI/container build/run/native/permission/
  SIGTERM/persistence checks are not proven; Docker unavailable here. Do not
  label the prepared Compose environment as runtime-validated yet.
- **Production cutover blockers:** green staging gates; operator-specific legacy
  copy rehearsal and protected recovery storage; explicit maintenance/cutover
  approval; correct signing-key rotation/VAPID continuity; private HTTPS/proxy/
  wss and real-browser push acceptance; one-writer topology; rollback decision
  and post-cutover write-loss agreement. No automatic deployment is provided.
- **Deferred enhancements:** multi-replica event transport and external monitoring
  infrastructure are outside scope. Existing localStorage/access-token semantics
  and shared-device push considerations remain documented, not redesigned.

## J. Verdict

Engineering work feasible without Docker is complete, subject to the final local
results below. The opt-in Linux validation and CI are prepared, **not proven by
execution**. The image is not yet demonstrated to build/run on Linux, and the
Compose runtime is not yet demonstrated to work. Database backup/restore and
compiled Windows runtime recovery are verified. This can be a development-branch
commit after final review/local PASS; it is not production cutover approval.
An operator can run the isolated staging verification as the next acceptance
step, but normal staging deployment readiness requires its actual green result.

### Final local verification

- **PASS:** `pnpm test` — 24 files passed, **322 tests passed, 1 skipped (323
  collected)**. The one skip is the explicitly Unix-only unwritable-directory
  startup test on this Windows host; Linux CI must execute it. All 319 original
  tests remain. Four new deployment cases include the platform-specific case.
- **PASS:** `pnpm typecheck`; `pnpm build`; `npm run build` (frontend).
- **PASS:** `pnpm exec node scripts/verify-schema-engine.mjs` — independent
  disposable db-push/deploy, 28 application tables and clean FK checks each.
- **PASS:** focused final deployment/catalogue command — 5 passed, 1 Windows
  skip across two files. Compiled runtime/recovery, WAL capture, Python reads,
  native bcrypt/sharp/Prisma and mocked durable worker probes all executed.
- **PASS:** five new ESM scripts parse; Python recovery script compiles without
  creating bytecode. Tracked `git diff --check`, explicit untracked-file whitespace
  scan and NUL-delimited private-state Git-ignore examples passed. Git status
  confirms only the listed work; no staging/commit/push or live-state operation.
- **PASS (static only):** Compose v2 `config --quiet` with synthetic environment
  and an explicit empty temporary env file; no Docker daemon/container required.
- **PASS:** standalone temporary-config exercise proved random key/password
  formats, no secret output and refusal to overwrite an existing configuration.
  The Docker smoke also removes inherited `STAGING_*` shell values so they cannot
  override its generated disposable environment. Unix config mode checks remain
  Linux-only. The early failed harness's identified leftover fixture was removed
  after verifying its absolute temp path and synthetic markers; no test server
  remains. User services were not stopped.
- **BLOCKED / NOT RUN:** Linux image build/run, Linux native/UID/mount/read-only
  checks, Linux SIGTERM; Docker Linux daemon unavailable. Prepared CI has **NOT
  RUN**. Proxy/HTTPS/real push are **NOT RUN**, pending operator-approved acceptance.

No development-branch commit blocker is known after these local checks, subject
to independent review. Linux/staging acceptance and production cutover gates
remain exactly as described above. No claim of completed deployment validation
is made.
