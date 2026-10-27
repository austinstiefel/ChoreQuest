# Phase 5 — integrated runtime handoff

Branch: `node-js-conversion`. Python source, the running Python service and real
databases were not modified. No commit, push, deployment, DNS/proxy change or
Docker service start was performed. This is an implementation handoff, **not a
production cutover approval**.

## A. Runtime parity inventory

The reference was inspected independently: `backend/main.py`,
`websocket_manager.py`, `services/push.py`, `services/push_hook.py`,
`services/assignment_generator.py`, `services/rotation.py`, all router socket
call sites, authentication dependencies and frontend callers. The read-only
`scripts/audit-runtime-contracts.py` emits the exact source functions, lines,
payload expressions, delivery methods, push URL map and REST inventory. It
imports no application code and accesses no configuration/database.

Reference counts:

- **121 REST method/path pairs:** 98 business, 10 auth, 12 admin identity/key/
  invite/audit, 1 health. All are registered by the integrated Node runtime.
- **101 business routes:** the 98 reference pairs plus 3 assignment-specific
  lifecycle aliases. Total Node REST registrations: **124**.
- **51 Python WebSocket emission sites; 16 event types.** All emission paths
  have Node equivalents. This counts emitted messages, not connection helpers.
- **1 scheduled job**, with 3 maintenance responsibilities, plus startup and
  post-commit push processing. No additional missed-chore/event-expiry/reminder
  jobs exist in the Python source; none have been invented here.
- **0 required runtime services deferred.** The previously deferred emote/push
  test operations and partial VAPID endpoint are integrated with actual adapters.
  Counts describe implemented behavior, not an assertion of byte-for-byte parity
  for every possible Pydantic error or an exhaustive browser/device certification.

Status classification: the 121 REST capabilities and the daily job are
**implemented with documented differences**, not certified exact equivalence.
The 16 socket message payload contracts are implemented; connection security,
additional invalidations and recovery differ as documented. There are **0 known
incomplete/deferred/blocked required backend capabilities**. Docker/Linux and
external HTTPS/provider acceptance are **blocked/unverified deployment checks**,
not claimed implementations of a missing transport. Deferred enhancements are
listed separately in section G.

### WebSocket wire contract

Endpoint remains `/ws/{user_id}`. JSON remains `{ type, data }`.
`runtime/events.ts` maps successful operation results/inserted records to the
following payloads; it does not repeat business mutations.

| Type | Trigger/reference functions | Data and recipients | Frontend consumers |
| --- | --- | --- | --- |
| `data_changed` | Chore/category CRUD, assign/rules, undo/skip; reward CRUD; rotation CRUD/advance; wishlist CRUD/conversion; event CRUD/end; avatar save/purchase; `auth.update_me`; `points.adjust_points`; calendar remove/accept | `{entity}`, with `new_balance` for point adjustment. Preserve reference actor exclusions and targeted avatar/points/wishlist updates. Event update/end/delete and rotations reach everyone. | `App.jsx` dispatches `ws:message`; page refresh listeners and `useSettings` |
| `chore_completed` | `chores.complete_chore` | `chore_id,chore_title,user_id,user_display_name,points,assignment_id`; current active parents/admins only | Parent dashboard, notifications; common page refresh listeners |
| `chore_verified` | `chores.verify_chore` | `chore_id,chore_title,points,assignment_id`, optional `avatar_drop` (`id,category,item_id,display_name,rarity`); assignee only | Child dashboard, avatar/XP refresh |
| `achievement_unlocked` | `achievements._unlock_achievement` (including bonus/spin/verification checks) | `achievement_key,title,points`; owner only | Child dashboard and common account/notification refresh |
| `bonus_points` | `points.award_bonus` | `amount,description,new_balance`; owner only, after achievement awards | Account/XP refresh |
| `reward_redeemed` | `rewards.redeem_reward` | `redemption_id,reward_title,points_spent,status`; purchaser only | Rewards/inventory and common refresh |
| `reward_approved` | `rewards.approve_redemption` | `redemption_id,reward_title`; purchaser only; other clients get redemption invalidation | Rewards/inventory |
| `reward_denied` | `rewards.deny_redemption` | `redemption_id,reward_title,points_refunded`; purchaser only | Rewards/inventory |
| `reward_fulfilled` | `rewards.fulfill_redemption` | `redemption_id,reward_title`; purchaser only; others get redemption invalidation | Rewards/inventory |
| `trade_proposed` | `calendar.propose_trade` | `notification_id,from_user,assignment_id,chore_title`; intended recipient only | Notification trade controls/calendar |
| `trade_accepted` | `calendar.accept_trade` | Proposer: `notification_id,accepted_by,assignment_id,chore_title`; accepter: `assignment_id,chore_title`; other clients get assignment invalidation | Notifications/calendar |
| `trade_denied` | `calendar.deny_trade` | `notification_id,denied_by,assignment_id,chore_title`; proposer only | Notifications/calendar |
| `announcement` | `announcements.create_announcement` | `title,message`; all connected accounts | Party and common refresh |
| `shoutout` | `shoutouts.create_shoutout` | `from_user_id,from_user_name,to_user_id,to_user_name,message,emoji`; all accounts | Shoutout panel/Party/avatar reactions |
| `spin_result` | `spin.execute_spin` | `points_won`; spinner only | Spin wheel/account refresh |
| `emote` | `emotes.send_emote` | `user_id,user_name,emote,target_user_id`; broadcast including sender (target identifies the animation, not a private channel) | `EmoteBar`, `AvatarDisplay` |

Delivery occurs only **after the encompassing transaction commits**. Notification
inserts also send an owner-only `data_changed/notification` invalidation so feedback
and other notification-only paths refresh without broadcasting private content.
Settings, vacations and bulletin deletion get invalidations too; these are small
documented additions using the existing envelope. Socket delivery is ephemeral,
like Python. A failed socket write cannot roll back a completed request. On
connection/reconnection the frontend refreshes its views from REST and durable
notification rows; there is no false claim of durable socket replay.

### Push inventory

All `Store`-inserted notifications, regardless of which business module creates
them, enqueue deliveries in their transaction. The original notification remains
the source of title/body. URLs reproduce `_NOTIFICATION_URL_MAP`: chores `/chores`,
achievements `/profile`, trades `/calendar`, rewards `/rewards`, announcements
`/party`; other types `/`. Payload remains `{title,body,url,tag}` with the
notification type as tag. `frontend/public/sw.js` displays it and navigates/focuses
the existing application. Its actual source is exercised by a VM integration test.

There is no Python per-notification preference field: subscription existence is
the opt-in/opt-out boundary. Unsubscribe, expired subscriptions, deleted owners,
disabled accounts and ownership/version mismatches prevent queued delivery.
Like Python, OS notifications can remain enabled after logout until unsubscribed;
shared-device notification/privacy acceptance remains an operator/user concern.

- `/api/push/subscribe`, `/unsubscribe`, `/status`: existing contracts retained.
- `/api/push/vapid-public-key`: authenticated, returns initialized public key.
- `/api/push/test`: parent/admin only, actual provider sends; preserves
  `Sent to X/N device(s)` including honest `0/N` on failure, and the existing
  no-subscriptions 400. This does not create a durable in-app test notification.
- 404/410 remove the obsolete subscription. Network errors, 429 and 5xx retry
  with bounded exponential backoff. Other provider rejections are terminal but
  do not delete the subscription. Provider errors/payloads/keys/URLs are not logged.
- Known HTTPS browser push-service hosts are allowed (Google, Mozilla, Apple,
  Microsoft); arbitrary hosts, private IP URLs, credentials, unusual ports and
  redirects are not used. This deliberately closes the reference's SSRF surface.
  Adding a new legitimate provider requires reviewing the explicit allowlist.

### Job inventory

`backend/main.py.daily_reset_task` runs at `DAILY_RESET_HOUR` **UTC**, not the
parent-editable `daily_reset_hour` setting. Default is 0. Node retains this split.

| Responsibility | Reference behavior / Node implementation |
| --- | --- |
| Daily assignments | `generate_daily_assignments`: active chores and per-child rules; legacy history fallback; occurrence-day rotation advancement; no reopening completed work. Rotations use UTC calendar cadence thresholds 1/7/14/30 days, including Python's initial-null advancement. Vacation days skip generation/rotation. Explicit exclusions are respected rather than resurrected. |
| Streak maintenance | `reset_stale_streaks`: active kids only, vacation-aware gaps, preserve yesterday/today/future completion, reset missing/stale streaks. Do not consume freezes or erase longest streak/history. Freezes remain a completion-time operation. |
| Refresh cleanup | Delete only credentials whose expiry is strictly before now; preserve equality/future values and six-digit microsecond precision. |

Calendar projection still generates a week without advancing persisted rotations.
Spins, pet interaction budgets and event activity remain date/read-time checks;
they need no destructive midnight counter-reset or event-expiry job. No missed
status transition or scheduled reminder exists in Python to translate.

The UTC slot is polled every 30 seconds (at most ~30 seconds scheduling delay),
independent of local DST. Local chore/streak dates follow the process timezone,
as `date.today()` does; persisted timestamps remain naive UTC with six digits.
Configure the same timezone on Python, Node and all Node processes.

**Recovery difference:** Python waits for the next future UTC reset after startup
and does not backfill missed days. Node additionally reconciles **today** before
listening, including a new local date within an already-completed UTC slot. It
does not invent historical missed assignments, replay awards or advance a
rotation repeatedly for guessed offline occurrences. Daily polling remains UTC
scheduled; startup reconciliation is explicit and persisted. Backward clock
movement cannot replay an older slot.

## B. Implementation and dependencies

New runtime modules:

- `runtime/index.ts`: integrated, injectable app/runtime factory and shutdown.
- `runtime/websocket.ts`: `ws` upgrades, connections, authorization, heartbeat,
  routing and bounded resources.
- `runtime/events.ts`: Python-compatible post-commit event projections.
- `runtime/vapid.ts`: P-256 loading/validation/generation and atomic persistence.
- `runtime/push.ts`: web-push adapter, durable jobs, leases/retries and test sends.
- `runtime/scheduler.ts`: daily maintenance, UTC slots and persisted coordination.
- `runtime/state.ts`: reserved internal state keys using existing app_settings.

Integration changes: `server.ts`, `app.ts`, business `router/store/index`,
`integrations`, `household` settings filtering, chore lifecycle/detail endpoints,
reward legacy-amount guards, calendar proposal resolution, date validation and
the auth profile event hook.

Frontend changes are limited to `api/socketConnection.js`, `useWebSocket.js`,
`ParentDashboard.jsx`, `KidQuests.jsx`, `ChoreDetail.jsx`. No UI redesign or public
registration change. The socket controller is separated from React only to make
reconnect/unmount/account-change races directly testable without another framework.

New direct dependencies: `ws@8.22.0`, `web-push@3.6.7`; development typings:
`@types/ws@8.18.2`, `@types/web-push@3.6.4`. pnpm lockfile updated. Prisma and
existing dependency versions were not upgraded. pnpm reported the existing
bcrypt build-script warning; package approval policy was not altered. Bcrypt
compatibility remains covered by the full suite.
Library references: [ws](https://github.com/websockets/ws),
[web-push](https://github.com/web-push-libs/web-push).

Exact Git change inventory: **42 files**, all unstaged (paths relative to repo):

```text
frontend/src/api/socketConnection.js
frontend/src/hooks/useWebSocket.js
frontend/src/pages/ChoreDetail.jsx
frontend/src/pages/KidQuests.jsx
frontend/src/pages/ParentDashboard.jsx
server/Dockerfile.node
server/Dockerfile.node.dockerignore
server/docs/business-api.md
server/package.json
server/PHASE5.md
server/pnpm-lock.yaml
server/scripts/audit-runtime-contracts.py
server/src/app.ts
server/src/business/calendar.ts
server/src/business/chores.ts
server/src/business/household.ts
server/src/business/index.ts
server/src/business/integrations.ts
server/src/business/rewards.ts
server/src/business/router.ts
server/src/business/store.ts
server/src/business/validation.ts
server/src/routes/auth.ts
server/src/runtime/events.ts
server/src/runtime/index.ts
server/src/runtime/push.ts
server/src/runtime/scheduler.ts
server/src/runtime/state.ts
server/src/runtime/vapid.ts
server/src/runtime/websocket.ts
server/src/server.ts
server/tests/business/rules.test.ts
server/tests/helpers/browser-smoke.ts
server/tests/helpers/runtime.ts
server/tests/helpers/scheduler-worker.ts
server/tests/integration/business.test.ts
server/tests/integration/runtime-compat.test.ts
server/tests/integration/runtime-static.test.ts
server/tests/integration/runtime.test.ts
server/tests/runtime/frontend.test.ts
server/tests/runtime/push.test.ts
server/tests/runtime/scheduler.test.ts
```

## C. Database and transaction safety

**No schema changes or new migrations.** The Phase 1 baseline and Phase 3 legacy
preparation scripts are unchanged. The existing `app_settings` key/value table
already stores private auth/VAPID state and can also hold this household-scale
runtime state without adding a framework or rebuilding tables:

- `__runtime_daily`: UTC execution slot and reconciled local date.
- `__runtime_push.<notification-id>.<subscription-id>`: IDs, SHA-256 version
  fingerprints, attempt count, next-attempt/lease time, creation time and a random
  claim token. No duplicated notification bodies, subscription keys or credentials.

The private prefix is hidden/rejected by settings APIs. SQL uses literal-prefix
GLOB, not LIKE's underscore wildcards. Notifications and outbox jobs commit or
roll back together. Socket plans collected in failed transactions are discarded.

Workers reserve SQLite's writer before selecting a due job, lease it for 60
seconds, then perform network work **outside** the transaction. A separate short
transaction acknowledges/retries only the same claim token. Version fingerprints
protect legacy row-ID reuse or replacement; expired-provider responses cannot
delete a subscription refreshed during an in-flight send. Every claim uses a fresh
clock reading, so earlier slow sends cannot expire later leases prematurely.
A crashed worker's lease is reclaimable.
Expired/orphaned jobs are removed during bounded batches, without a schema cascade.

Policy: up to 4 attempts, retry intervals 30/60/120 seconds, 24-hour job lifetime,
20 claims per batch, one local worker awakened every second. Transport requests
have a 5-second inactivity timeout and a 10-second total agent deadline. Test
sends use the same provider adapter but no automatic queue retry. Jobs are durable
with **at-least-once attempt semantics under the bounded retry policy**, not a
guarantee of external delivery: permanent failure or retry exhaustion can deliver
zero pushes. A crash after provider acceptance but before acknowledgement can
duplicate a push. Existing
tags mitigate OS notification duplication; durable in-app notifications remain.

Daily work and its checkpoint share one writer transaction, so independent Node
processes cannot execute the same slot concurrently. Exceptions roll back
assignments, rotations, streak corrections, token cleanup and checkpoint together;
polling retries failure. No database lock is held for push network delivery.

Prepared legacy-copy tests exercise the runtime's VAPID/outbox paths, keep the
original source bytes unchanged and pass foreign-key checks. Schema-engine
verification still reports 28 application tables. New writes use the established
Python-readable timestamp helpers; existing microseconds are not rewritten.

## D. Security and compatibility decisions

- WebSocket upgrades verify the existing HS256 access utility, exact subject/path
  match, positive safe user ID and current active database user. Token role is
  not authorization. Deleted/inactive/expired sessions are rejected/closed.
- Python query-token clients remain supported without logging URLs/tokens. React
  now sends `chorequest` plus `bearer.<JWT>` subprotocols; only `chorequest` is echoed.
  Initial invalid upgrades return HTTP 401 (Python's pre-accept close is typically
  an HTTP denial); live expiry/revocation closes with 4001. No cookie-only upgrade.
- Browser Origin must be same-host or explicitly permitted by CORS; an empty list
  does not permit foreign origins. Native clients without Origin still need JWTs.
- Multiple sessions supported: 8/account, 256 total/pending upgrades. Handshakes
  time out, messages are capped at 4KiB, compression disabled, abandoned sessions
  heartbeat/terminate, slow outbound queues above 256KiB are terminated. Client
  frames cannot invoke commands or forge server events. Excess client frames close.
- Delivery and heartbeat recheck account activity/expiration. HTTP parent/admin
  guards, API keys/invites/audit restrictions, final-admin/self-deletion checks,
  non-reused identities, refresh rotation and credential concurrency are retained.
- Emotes: 10 per 10 seconds/account. Push tests: 5/minute/account, maximum 4
  concurrent test requests per process. These resource limits are documented
  security additions, not changes to successful response envelopes.
- VAPID accepts Python PKCS8/SEC1 PEM/DER-base64url and raw P-256 scalars. Valid
  stored pairs are never rewritten/regenerated on restart. Missing/invalid stored
  pairs are repaired atomically, with a generic warning if replacement is needed.
  Browser resubscription may be necessary after repair. Both environment overrides
  must be present, valid and matching; partial/invalid overrides fail startup,
  rather than silently switching identities. Private material is never exposed.
- Chore aliases `POST /api/chores/assignments/{assignment_id}/{verify|uncomplete|skip}`
  reuse the existing role/state/transaction logic and remain today-only. Legacy
  chore paths still work and accept an optional validated `assignment_id` query;
  an omitted ambiguous target still gives 409 rather than selecting a child.
  Child completion remains self-only. Repeated transitions cannot replay awards.
- Chore detail adds `server_today` and owner-filtered assignments: all today's
  records plus up to 50 past records, excluding future calendar projections.
  Reads are batched. Parent controls select a named hero when necessary; dashboard
  and child-detail approvals use assignment IDs. Required photo proof is now
  uploadable from the detail page, including per-child photo overrides.
- Resolved competing trade proposals are marked read as well as resolved, so the
  existing notification UI does not offer stale decisions. The original local
  `a.user_id` resolution recipient is unchanged.
- Date-only validation matches verified Pydantic local-midnight/offset semantics
  and rejects nonzero microseconds instead of truncating them into an accepted day.
- Nonpositive legacy reward prices are not deleted or silently changed. Redemption
  rejects them without balance changes; an administrator must edit them to a
  positive price. Legacy chore points must likewise be made positive before
  verification. Invalid historical redemption amounts remain readable, but
  approve/deny/fulfill reject them without refunds or status/balance changes;
  they require explicit, backed-up operator review/repair, not automatic rewriting
  or deletion. Other intentional Phase 4 integrity/security differences remain.

## E. Verification

All database-dependent tests use new temporary SQLite files. Providers are mocked;
no real push, subscription, VAPID secret or development database is used. Python
commands explicitly use the existing repository `.venv`. No dependency/environment
changes were made merely to pass a test.

Commands executed from `server/` with Node 22.14.0 / pnpm 10.34.6:

```sh
pnpm exec node scripts/verify-schema-engine.mjs
pnpm test
pnpm typecheck
pnpm build
pnpm exec vitest run tests/runtime/push.test.ts tests/runtime/scheduler.test.ts tests/integration/runtime.test.ts
pnpm exec vitest run tests/runtime/frontend.test.ts tests/integration/runtime.test.ts tests/integration/runtime-static.test.ts tests/integration/runtime-compat.test.ts tests/runtime/push.test.ts tests/runtime/scheduler.test.ts
pnpm exec tsx tests/helpers/browser-smoke.ts --serve-disposable
```

From `frontend/`: `npm run build` (existing npm dependencies/lockfile).
From the repository root:

```powershell
.\.venv\Scripts\python.exe -B server/scripts/audit-runtime-contracts.py
git diff --check
```

The source audit reports 121/51/16 as above. Focused runs and the full suite cover:
real loopback HTTP/WebSockets, recipient isolation, credential/origin failures,
reconnection, bounds, post-commit rollback, all event families, honest provider
counts, key persistence/repair, Python key loading, queue retries/leases/restart,
cross-connection and cross-process scheduler coordination, UTC/local/DST dates,
vacations, freezes, expired sessions, rollback/retry, graceful shutdown, actual
Python daily generation/rotation/streak equivalence, prepared legacy copies,
static/SPAs/security headers and the actual service-worker source.

Browser smoke against the production-built React bundle and a disposable Node
runtime verified configured-password initial login, separate approvals of two
children's shared chore, the named-hero detail selector, child login, live bonus/
achievement/notification refresh without navigation, reward redemption and inventory
persistence/session restoration after reload. No console errors were reported in
the child tab. No push permission was requested and no real provider was contacted.
Screenshots were saved outside the repository as review evidence. The helper is
time-bounded and disposes its temporary database on shutdown.

Final command results/test counts are recorded at the end of this report after
the final validation pass. Earlier failed iterations were corrected: a missing
root chore-creation broadcast; fixture queries bypassing legacy-safe datetime
projections; a fixture HTTP status expectation; and fixture-created numeric account
dates that were not Python-readable. These do not remain open failures.

## F. Deployment readiness and rollback

`Dockerfile.node` is a **separate opt-in** multi-stage Node 22 image, built with
`docker build -f server/Dockerfile.node -t chorequest-node:phase5 .` from repo root.
Its Dockerfile-specific ignore file excludes real databases, env files, keys,
workspace metadata and existing node_modules/build outputs. The image builds the
existing frontend, generates Prisma, compiles/prunes server dependencies, serves
the SPA, runs as UID 1000, includes CA/SSL/timezone support and has a loopback health
check. The original Python Dockerfile/Compose configuration is untouched.

**Docker build/run was not verified:** `docker info --format '{{.ServerVersion}}'`
failed because the Linux daemon pipe is unavailable. No daemon/service was started
or existing container altered. Build and Linux lifecycle/native-dependency checks
are mandatory before cutover, not claimed as passed.

Required/operator-reviewed configuration (never commit values):

- `DATABASE_URL`: explicit, provisioned SQLite file. Preserve Phase 3 startup and
  prepared-schema guards; a typo/missing file must fail, never auto-create data.
- `SECRET_KEY`: existing strong signing secret, stable across cutover to retain
  compatible access/refresh verification. Existing token lifetime settings,
  login/PIN rate-limit configuration and initial-admin overrides retain defaults.
- `COOKIE_SECURE=true` for HTTPS; correct explicit `CORS_ORIGINS` if cross-origin.
- `HOST`, `PORT` (image 8122), `STATIC_DIR` (image `/app/static`).
- `UPLOAD_DIR` (image `/app/data/uploads`), existing `MAX_UPLOAD_SIZE_MB` and image
  decoder safety limit. Mount existing uploads persistently, writable by UID 1000.
- `TZ`: explicitly set the intended process timezone consistently; UTC reset-hour
  scheduling is separate from local chore dates. `DAILY_RESET_HOUR` is 0–23 UTC.
- Existing `VAPID_PRIVATE_KEY` + `VAPID_PUBLIC_KEY` overrides, if deployed, must be
  retained together. Otherwise keep the persisted DB pair. Set
  `VAPID_CLAIM_EMAIL` to a valid real `mailto:`/HTTPS operator contact (reference
  default `mailto:admin@example.com` is not a production contact).

Cutover/rollback plan (a separate human-authorized operation):

1. Stop the Python writer before taking a consistent SQLite backup (including
   committed WAL content through the documented backup/preparation tooling).
   Back up uploads and configuration/VAPID identity together; protect permissions.
2. Prepare a **copy** using the existing Phase 3 procedure. Inspect its report,
   indexes/constraints/identities/FKs and user/history samples; deploy/baseline only
   that copy as documented in `prisma/README.md`. Do not reset/push over real data.
3. Build/test the Node image and staged copy privately. Run exactly **one Node
   application process/replica** with persistent DB/uploads and the same timezone.
   SQLite job coordination tolerates accidental extra processes, but socket
   broadcasts are process-local; clustered fan-out is not supported infrastructure.
4. Terminate TLS at the existing reverse proxy. Route `/api`, `/ws` and frontend
   assets to the same service; forward HTTP Upgrade/Connection for `/ws`, preserve
   Host/Origin, allow an idle timeout longer than the 30-second heartbeat. Do not
   cache authenticated APIs or `/sw.js`. Keep security headers/CSP compatible.
   Cloudflare/tunnels must permit WebSocket upgrades and idle heartbeats; do not
   log Authorization, subprotocol credentials or legacy token query strings.
   Trust proxy addresses explicitly before changing rate-limit client-IP behavior;
   do not globally trust arbitrary forwarded headers.
5. Verify HTTPS cookies, login/refresh, multiple sockets/reconnect, mounted uploads,
   health, real staged-browser push permission/delivery, VAPID persistence, reset
   timing/DST and operator log collection. A 200 health endpoint is liveness,
   not proof of provider delivery or successful maintenance; generic worker
   failures must be monitored and investigated.
6. Allow up to 60 seconds for shutdown: stop HTTP intake and new push attempts,
   close socket upgrades/connections, cancel/wait daily work, drain HTTP work and active push attempts,
   then disconnect Prisma. Persisted unsent jobs resume after restart. Validate
   POSIX signal and container stop behavior in the actual Linux deployment.
7. For rollback, stop Node completely before starting Python. Prefer restoring the
   pre-cutover database/uploads/configuration snapshot together. If retaining Node
   writes, first verify the copied database through Python SQLAlchemy and decide
   explicitly how to retain post-cutover user changes. Runtime namespace keys are
   private Node state (the Python parent settings endpoint is less restrictive);
   remove only these keys from a rollback **copy** if required by the operator's
   security plan, never blindly delete ordinary settings. Never run both writers.

## G. Outstanding issues

**Commit blockers:** none known after successful final checks and independent
review. There is no commit or staging performed by this task.

**Production blockers/prerequisites:**

- Independent code/security review and human-approved cutover/rollback rehearsal.
- Actual Linux Docker build, native bcrypt/sharp/Prisma loading, storage permissions
  and OS-signal/container shutdown verification (daemon unavailable here).
- Staging HTTPS/reverse-proxy/Cloudflare checks and real browser/OS push acceptance,
  permissions and provider connectivity. Automated tests intentionally mock delivery.
- Review real configured timezone, UTC reset hour, valid VAPID identity/contact,
  push-provider allowlist, backup restore procedure, worker failure monitoring and
  one-process deployment. No public exposure is authorized by this handoff.

**Deferred enhancements (not missing Python behavior):** clustered socket fan-out,
external queue infrastructure, per-notification preferences, richer dead-letter/
delivery metrics UI, exact-once external effects, exhaustive Pydantic wording and
coercion equivalence, broad cross-browser visual certification and large-history
performance work. Filesystem proof cleanup remains best-effort on crash/unlink
failure, as documented in Phase 4.

## H. Final verdict

- Phase 5 implementation complete: **yes**, for the requested backend integration
  and local verification; deployment acceptance remains explicitly unverified.
- Backend functional parity: **implemented and locally verified with documented
  differences**, not a claim of exact universal behavioral equivalence. The 121 reference REST registrations, 16 event types
  across 51 emit paths, push/VAPID and the sole daily job are implemented, with
  the explicit correctness/security/recovery differences above.
- React compatibility: **yes for the tested contracts and representative built-app workflows**; automated
  transport, service-worker, contract and lifecycle tests supplement them. Not a
  claim that every browser, permission flow and external provider was exercised.
- Ready for independent code review and subsequent developer commit: **yes**; not
  ready for unattended production cutover. Production prerequisites remain above.

### Final validation results

| Check | Actual final result |
| --- | --- |
| `pnpm exec node scripts/verify-schema-engine.mjs` | PASS: separate disposable `db push` and `migrate deploy`, 28 application tables each, clean foreign keys |
| `pnpm test` | PASS: **319 tests in 23 files**, zero failed/skipped; the original 234 remain covered, with 85 added regressions |
| Runtime/regression coverage within full suite | 80 tests across the 6 new runtime test files, plus 5 additional date-validation cases |
| `pnpm typecheck` | PASS, including test/helper typings |
| `pnpm build` | PASS, production TypeScript output |
| `npm run build` in frontend | PASS, 1,994 modules; existing large Profile chunk warning remains, no unrelated splitting/refactoring |
| Source audit via repository `.venv` | PASS: 121 reference REST pairs, 51 emission sites, 16 event types |
| Actual Python/SQLAlchemy/cryptography compatibility | PASS on disposable fixtures; daily generation/rotation/streak state matches, keys load correctly, six-digit historical timestamps remain readable |
| Prepared legacy-copy runtime test | PASS; original source bytes unchanged and foreign keys clean |
| HTTP/WebSocket/push/scheduler shutdown and concurrency | PASS, including independent processes, slow batches, refreshed subscriptions and in-flight HTTP push drain |
| Built React browser smoke | PASS for the listed flows; no console errors in the checked child session, live XP/notification updates observed without reload |
| `git diff --check` and explicit new-file whitespace scan | PASS |
| Docker/Linux image build/run | NOT RUN: Docker Linux daemon unavailable; `docker info` failed, no service started |
| Real external push/HTTPS/proxy acceptance | NOT RUN deliberately; separate staged production prerequisites |

The browser fixture reported successful shutdown/removal of its temporary
database. Its two temporary browser tabs were closed. No test server remains
from this task. Git index remains unchanged; nothing was staged, committed or
pushed. Python, Prisma schema/history, live database and running deployment remain
untouched.
