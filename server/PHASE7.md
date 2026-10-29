# Phase 7 — private staging preparation and acceptance handoff

Branch `node-js-conversion`, starting commit
`4b85827e838b6de4017ba1a6f5d0aecb4f46feb8`. Tracked tree started clean; the three
existing untracked review patches (`changes-CI-Fix.diff`, `changes-CI-Fix_2.diff`,
`phase6.1-full-review.diff`) are preserved. No commit, push, homelab deployment,
DNS/proxy/firewall modification, device enrollment or real push delivery occurred.
No development/production DB was opened, copied or modified; all fixtures are new
temporary synthetic databases. Python remains available and unchanged.

## Acceptance status — deliberately separate

| Category | Evidence/status |
| --- | --- |
| Implemented | Operator deployment/TLS/push/recovery procedures and 14 focused test cases; existing runtime/Compose/security behavior retained |
| Tested locally | Windows, existing Node 22.14.0 / pnpm 10.34.6 / repository Python `.venv`; actual results below |
| Tested in Linux CI | **Starting commit only:** [run 40631656245](https://github.com/austinstiefel/ChoreQuest/actions/runs/40631656245) passed all three jobs; logs verified through GitHub API |
| New Phase 7 changes in Linux CI | **NOT RUN**; no commit/push/workflow dispatch |
| Actual private homelab HTTPS/WSS/NPM | **NOT RUN / awaiting operator-assisted acceptance** |
| Real browser push | **NOT RUN / awaiting specific enrollment/delivery approval** |

The verified backend CI log shows **365 tests passed across 26 files, no skips**.
The Linux-container log ends with `docker-smoke: pass`, after runtime/provisioner
build, exclusive provision/repeat rejection, health, validated loopback discovery,
real HTTP/WS/business/upload workflow, native modules/SQLite/WAL, OpenSSL,
SIGTERM exit 0, mocked-provider/Unix permission probes, restart persistence and
isolated project/temp cleanup. Frontend production build also passed. This
supersedes earlier Phase 6 handoffs' then-unverified Linux state for that commit;
those historical reports are intentionally not rewritten.

## Change inventory

- `docs/staging-runbook.md`: prerequisites, verified CI provenance, uniquely
  selected project, refusal of state reuse, explicit one-app lifecycle, private
  HTTPS configuration before login, image identity recording, readiness versus
  liveness, guarded deletion and links to detailed procedures.
- `docs/staging-https-acceptance.md`: same-host isolated NPM template, separate-VM
  private forwarding alternative, private DNS/DNS-01/certificate renewal,
  effective NPM log/Host/Upgrade settings, secure browser/WSS and real push gates.
- `docs/staging-state-recovery.md`: stopped-writer backup, volume ownership and
  metadata checks, fresh-directory/fresh-project restore, UID/GID 1000 import,
  integrity/WAL verification and state retention on failure. Operator commands
  are prepared, not represented as a performed Docker-volume rehearsal.
- `tests/integration/https-proxy.test.ts`: eight production-build TLS/WSS tests.
- `tests/runtime/staging-safety.test.ts`: six configuration/recovery safety tests.
- `PHASE7.md`: this evidence, security review and handoff.

No runtime source, frontend source, package/lockfile, CI workflow, Dockerfile,
Compose file, Prisma schema/migration or existing tests were changed. No new
dependency, browser automation framework or deployment service was installed.

## Architecture review and decisions

Browser -> internal DNS -> private trusted HTTPS staging proxy -> app:8122 ->
dedicated project SQLite/uploads volumes. The normal diagnostic host binding
remains **127.0.0.1:8123**. Standard project bridge allows outbound traffic; it is
**not egress-blocked**. Ingress privacy depends on actual proxy binds, LAN/VPN
firewalls and private DNS, not on DNS secrecy alone.

| Area inspected | Verified implementation and operational consequence |
| --- | --- |
| Isolation | `compose.staging.yml` owns network/volumes; no production bind mounts, external production network or fixed container names. Provisioner uses network none and an opt-in tools profile. |
| Images | Separate runtime/provisioner; Node 22 Bookworm, frozen pnpm/npm lockfiles, native bcrypt/sharp/Prisma checks. Mutable base/image tags and apt repository contents prevent a bit-for-bit reproducibility guarantee; retain reviewed image IDs/digests for recovery. |
| Process lifecycle | One Node process/replica; process-local WS fanout. `server.ts` starts only after schema/bootstrap/catalogue/runtime reconciliation; SIGTERM/SIGINT drains workers/sockets/HTTP, deadline 60s, Compose allowance 75s. No automatic restart policy after host reboot. |
| Runtime privileges | Image USER node (UID/GID 1000), read-only root, all capabilities dropped, no-new-privileges, init, bounded noexec/nosuid /tmp. Only project DB/uploads are persistent writable app mounts. |
| SQLite/bootstrap | Explicit fresh-only provision/migrate/status; app never provisions/migrates schema. Existing users prevent bootstrap credential overwrite. Repeated catalogue initialization preserves customized state (existing populated-fixture tests). Never retry failure by deleting data. |
| Storage | DB/WAL/SHM directory and uploads need UID/GID 1000 write/traverse access. Existing snapshot helper checks integrity/FKs, includes committed WAL and protected configuration; restore refuses occupied destinations. |
| Health | `/api/health` is process liveness. Readiness also requires schema/worker startup, synthetic authenticated reads/writes/upload reads and committed WS events. No new public diagnostic endpoint exposes DB or queue details. |
| Network/resource limits | HTTP maxConnections 512, request timeout 30s, headers 15s; WS handshake/session/frame/backpressure limits; push queue batch/retry/deadline bounds. Compose has no CPU/memory/disk quota; operator capacity/monitoring and log rotation remain required. |

Read existing staging/cutover runbooks, Dockerfile/ignore/Compose, generator,
smoke/port discovery/diagnostics, snapshot tool, Phase 6 reports, Prisma README,
CI workflow and runtime/auth/push/scheduler/frontend clients before choosing
this minimal test/documentation change. Existing Phase 6 runtime/port discovery
assertions were preserved.

Recommended topology is a **dedicated staging NPM**, with private IP ingress and
separate proxy/certificate state. On the same host it joins only the app project's
new staging bridge; upstream `app:8122` avoids the container-loopback trap without
changing backend publication. It can inspect staging HTTP credentials and is a
trusted staging boundary. No Docker socket/DB/uploads belong in the proxy.

Separate hosts cannot share local Docker bridge DNS. Prefer the dedicated proxy
on the app host; otherwise an explicitly approved restricted SSH forward can
bridge the remote proxy to the app host's unchanged loopback port. Exact private
addresses, host keys, firewall, SSH service and supervision are operator decisions.
No wildcard/backend LAN publication or modification of the production NPM is
automated. The template's actual pinned NPM image and installed-version logging
configuration must be reviewed before deployment.

## Deployment and operator gates

Use [staging-runbook.md](docs/staging-runbook.md) from the reviewed checkout:
check local Linux Engine/Compose/toolchain/disk/private storage; select a **new**
project and reject existing labeled state; generate a new protected env; privately
set Secure cookies, timezone/reset hour and real VAPID contact; record image IDs;
build app/provisioner; provision once; start exactly one app; perform only
anonymous loopback diagnostics until private TLS is ready. On failure preserve
state and stop. Normal stop/down retains volumes; deletion requires explicit
project identity/ownership review and typed name confirmation.

Use [HTTPS acceptance](docs/staging-https-acceptance.md) for the approved private
proxy topology, protected NPM setup, trusted certificate, HTTPS redirect and
same-origin `/`, `/api/`, `/ws/`. Preserve browser Host/Origin/Upgrade and use
90s read/send timeouts. Do not globally trust proxy headers. CORS remains empty
for same-origin use; authenticated browser traffic must use Secure cookies and
HTTPS/WSS. DNS-01 can validate an owned public domain while the app stays private;
TXT changes still require approval. Certificate names are visible through CT.
Protect scoped Cloudflare credentials and persistent NPM renewal/key storage;
Node gets no certificate key. Actual renewal/browser trust must be demonstrated.

**Log gate before credentials:** inspect effective NPM server/location access
and error logging, not just UI settings. Default request-line logs can leak legacy
query-token URLs; never log Authorization/Cookie/Set-Cookie/WS subprotocols. The
guide supplies a method/path/status-only format and restrictive error logging,
but installed NPM templates can override server-level directives. Test non-secret
markers and inspect all relevant logs privately. Inability to establish safe
effective logging blocks authenticated staging acceptance.

Approvals still required: homelab deployment and Docker administration; dedicated
proxy/network/address/firewall or SSH-forward creation; private DNS and Cloudflare
DNS-01 changes; certificate/renewal configuration; designated test-device enrollment
and each real notification test. No credentials should be supplied in chat.
Real family data is unnecessary and prohibited for this phase. Production key
rotation, proxy cutover, legacy migration and Python retirement stay out of scope.

## Automated acceptance and remaining browser coverage

New TLS fixture imports the **compiled** runtime/business upload storage. It
starts ephemeral loopback HTTP upstream and HTTPS reverse proxy; a one-day test
certificate is generated with the existing Python cryptography dependency and
trusted only by the fixture clients. No global TLS bypass, host trust change,
external DNS, provider call, live database or real browser is involved.

Eight tests cover: TLS SPA/API and Secure/HttpOnly/scoped refresh cookies;
rejection without explicit certificate trust; admin/parent/kid role restrictions;
forged/expired access rejection and foreign-Origin rejection with empty CORS;
preserved Host/Origin, same-user sessions, private routing and actual ping/pong;
synthetic proxy logs excluding subprotocol/cookie/query credentials; logout refresh
revocation without inventing access-JWT revocation; graceful WS 1001 restart with
reconnection and persisted REST account/VAPID resynchronization. The synthetic
logger is test infrastructure, **not evidence of NPM's logging behavior**.

Six safety cases verify distinct random credentials/no secret output, exclusive
file creation/overwrite refusal, absolute path/existing-parent prerequisites,
stopped-writer acknowledgement, corrupt-fixture rejection with partial-backup
cleanup and unchanged source bytes, and in-place/occupied restore refusal with
backup/target preservation. Unix mode 0600 assertion runs only on Unix; Windows
needs separately managed ACLs.

Existing integration/runtime/deployment/push/scheduler/frontend tests retain
coverage for real HTTP chore verification/private events, current DB roles,
WSS credential state transitions at the socket layer, session/frame bounds,
heartbeat expiry/stale clients, frontend reconnect/refresh/REST resync/cleanup,
service-worker display/click behavior, DB/uploads/points/reward history and VAPID
restart, WAL snapshot/recovery/Python reads, corrupt backup rejection, queued push
retry/restart/leases, independent scheduler checkpoints and Unix startup failure.
New TLS tests add the transport boundary without duplicating those suites.

Actual browser idle survival through multiple proxy timeouts, NPM effective log
redaction, DNS/cert renewal/trust, browser-enforced cookie behavior, browser UI
reconnection and real provider/device display/click are **pending**, with explicit
checkboxes in the guide. Node clients verifying Set-Cookie cannot prove a browser
accepted/sent the cookie. No mocked sender or compiled test proves device delivery.

Push acceptance needs an intentional secure-context SW registration/permission,
designated synthetic parent subscription, private status/key-digest check, one
approved delivery/click, restart with unchanged key and separately approved
recovery delivery, then explicit unsubscribe/backend removal. Account-wide status
does not alone prove this browser is subscribed. Shared-device OS subscriptions
can outlive logout. Bounded retries/24h lifetime and provider allowlist remain;
at-least-once attempts permit duplicates and exhaustion permits non-delivery.

## Recovery and security assessment

[State recovery](docs/staging-state-recovery.md) documents local-rootful-Linux
volume label/driver checks, stopped-writer/exit checks, immutable protected backup,
manifest/integrity/FK validation, restore into a new directory and unused project,
empty-volume guards and UID/GID 1000 import. It never provisions an existing DB
or overwrites source state. Backup configuration and VAPID/private delivery state
are secrets. Keep encrypted/off-host copies; hashes are not authenticated backups.
Restore tests here exercise disposable files/databases; **actual Docker-volume
export/import and homelab recovery are not yet performed**.

Preserved security controls: Python-compatible bcrypt, HS256 typed tokens and
current DB role/activity checks; admin/self/final-admin/transaction protections;
hashed/rotating refresh persistence; Secure configurable HttpOnly Lax scoped
cookie; validated uploads; URL/provider restrictions, no public registration;
non-secret request/worker diagnostics; explicit provisioning and image context
secret exclusion. Docker administrators can inspect container environments; 0600
files do not hide secrets from them. Access JWTs remain in browser localStorage
and valid until expiration; do not promise immediate logout revocation. Keep
proxy/API caching off and do not collect HAR/header dumps. Proxy-shared rate
budgets, capacity, image patch review and renewal monitoring remain operational
limitations, not changes to auth semantics.

## Commands and actual results

Executed using existing installed dependencies; no reinstall was necessary.
`CHOREQUEST_TEST_DOCKER` explicitly selected the installed Docker Desktop CLI for
static parsing. Python fixtures use `.venv/Scripts/python.exe` through the existing
test helper. Checks completed with the results below.

```bash
# server/, existing Node 22/pnpm environment
node --version
pnpm --version
pnpm prisma:generate
pnpm exec node scripts/verify-schema-engine.mjs
pnpm typecheck
pnpm build
pnpm test
pnpm exec vitest run tests/integration/https-proxy.test.ts tests/runtime/staging-safety.test.ts tests/integration/deployment-runtime.test.ts tests/runtime/docker-network.test.ts
for script in scripts/*.mjs; do node --check "$script"; done
node scripts/docker-smoke.mjs
# frontend/
npm run build
# root
git diff --check
git status --short
```

Additional read-only validation uses the existing repository Python interpreter
to extract the runbooks' Bash blocks and call `bash -n`, and real Compose CLI
`config --format json` with an empty temporary env and synthetic proxy values.
No deployment command inside documentation is executed by that syntax check.

| Check | Actual result |
| --- | --- |
| Prisma client generation | PASS, client 6.19.3 |
| Schema-engine verification | PASS, separate disposable db-push and migrate-deploy; 28 application tables and clean FK check each |
| `pnpm typecheck`, `pnpm build` | PASS |
| Full `pnpm test` | **PASS: 378 passed, 1 skipped, 379 collected; 28 files passed** |
| Focused four-file integration/safety/Compose command above | **PASS: 22 passed, 1 skipped, 23 collected; 4 files passed** |
| New tests | All **14 passed**, including all eight compiled-runtime HTTPS/WSS tests |
| Frontend `npm run build` | PASS, 1,994 modules; existing >500kB Profile chunk warning only |
| JavaScript syntax | PASS, all nine existing `scripts/*.mjs` parsed |
| Real Compose static validation | PASS, five existing normal/ephemeral/project isolation cases; dedicated proxy template also parsed using synthetic env, with private HTTP/TLS binds, loopback admin bind and staging-only upstream network asserted |
| Runbook Bash examples | PASS, all eight Bash blocks across the three operator guides checked with existing Git Bash `bash -n`; no contained deployment command executed |
| Diff/scope checks | PASS, `git diff --check` plus explicit new-file whitespace/file-ending checks; only the six listed files differ, index empty, protected runtime/frontend/schema/scripts/deployment configuration unchanged |
| Snapshot/restore | PASS on disposable fixtures: WAL capture, integrity/FKs, DB/upload/config/history/account persistence, Python reads, overwrite/corruption rejection and new occupied-restore/source-preservation checks |
| Local Linux Docker smoke | **UNAVAILABLE:** harness exited 1 at `docker-availability`, classified `docker_daemon_unavailable`; no fixtures/containers/volumes/networks were allocated |
| New Linux CI / homelab / NPM / browser / real provider | **NOT RUN** |

The sole skip is the existing Unix-only unwritable-directory startup test on
Windows; starting-commit Linux CI executed it. No new test is skipped. The first
focused TLS run passed eight tests but revealed a test-only Socket/Duplex typing
mismatch; it was corrected and final typecheck/full/focused runs passed. An initial
sandboxed shell launch could not run; checks succeeded with the existing tools
after scoped execution approval. No environment/dependency installation or runtime
security bypass was needed.

## Commit recommendation and remaining blockers

Recommend a **reviewed development-branch commit of this preparation/test patch**
after the final diff/whitespace checks; no known code-level blocker remains from
the executed checks. No commit is made here. The full review patch includes all
six changed/new files and excludes the three preserved pre-existing patches.

**Phase 7 is awaiting operator-assisted acceptance, not deployment-complete.**
Before declaring Phase 7 complete: run the new tests in Linux CI; obtain explicit
homelab/proxy/DNS/notification approvals; select actual private topology/name and
reviewed proxy image; verify effective log redaction and certificate renewal;
perform trusted browser HTTPS/WSS/role/session/heartbeat/restart checks; complete
approved real-device push/unsubscribe acceptance; and rehearse actual isolated
Docker-volume backup/restore/ownership on that host. Prepared template/shell
syntax and file-based recovery tests do not substitute for these runtime checks.

Production cutover remains blocked on those acceptance gates plus the existing
copy-only legacy migration/rollback rehearsal, explicit maintenance approval,
one-writer handoff, mandatory legacy signing-key rotation and VAPID continuity
plan, retained Python recovery state and post-cutover write-loss decision from
[cutover-runbook.md](docs/cutover-runbook.md). None is performed in this phase.
