# Phase 4 implementation handoff

Reference: `backend/routers/*.py`, `backend/schemas.py`, `backend/models.py`,
`backend/achievements.py`, `backend/services/*.py`, and frontend `api()` callers.
Python remains authoritative. No source database is used by tests.

## Domain inventory established before implementation

| Router | Contracts and rules | Dependencies |
| --- | --- | --- |
| chores | Categories, library/active/kid views, templates, assignments, rules, rotations, debug, complete/verify/uncomplete/skip/feedback, stale cleanup. Parent mutations except self-completion. Photo proof uses multipart. Verified work alone awards points; stacked active-event multipliers; undo preserves lifetime XP. | Recurrence/rotation, notifications, achievements, pets, item drops, uploads, broadcasts |
| calendar | Monday-only week view generates missing assignments; all authenticated members see household calendar. Self-owned pending trades; recipient-only decisions. Parent pending removal with exclusions/all-future. | Assignment generator, notifications, broadcasts |
| rewards | Active catalogue sorted by cost; parent CRUD/approval/denial/fulfillment; self redemption automatically approved (threshold is not used). Stock decremented; pending denial refunds, does not replenish stock. Soft deletion preserves history. | Balances, transactions, achievements, notifications, broadcasts |
| points | Self history for kids, any user for parents; parent positive bonus; admin signed adjustment cannot make balance negative. Positive changes award pet XP; bonus checks achievements. | Audit, notifications, pet progression |
| stats/progress | Self, roster, kids, parent family/user details, weekly positive-XP leaderboard, 7/30-day history, achievement list/update/SVG badge; 30-day charts aggregate active kids for parents. Stale streak corrected at read time using vacation gaps. | Calendar generation, rank/pet logic |
| avatar/pets/spin | Public fixed catalogue; self config/shop/milestone unlocks; parents see all items unlocked; per-pet XP; 3 interactions/day; one spin/day when all assignments completed/verified (skipped blocks). | Points, achievements, notifications, random drops |
| wishlist | Kid self list/parent all; self create/update, owner or parent delete; parent conversion creates stock-1 reward and deletes wish. | Broadcasts |
| events | Authenticated list with computed active range, parent CRUD/end; end strictly after start; creation multiplier >1. | Notifications, quest XP, broadcasts |
| announcements/shoutouts | Parent bulletin posting/deletion; authenticated read; self cannot shout out; active recipient; 5/day, last 7 days/50 results. | Durable notifications, broadcasts |
| vacation | Parent list/create/cancel; inclusive dates; cannot end in past. | Generation and streak exceptions |
| notifications | Self list/unread-count/read/read-all; pagination 20/1–100, offset >=0; foreign notification gives 403. | Push delivery hooks deferred |
| admin settings | Parent get/update string dictionary; any authenticated user feature flags with true defaults. Must mount before admin-only router. | Frontend feature toggles |
| uploads | Authenticated multipart image upload, public file download, parent delete. Full raster decoding, MIME/extension/size validation and generated names. | Filesystem, completion proof, sharp |
| push/emotes | Self subscription upsert/unsubscribe/status; authenticated VAPID; parent test; ephemeral emote broadcast. | Push and WebSocket transports explicitly deferred |

## Security and compatibility decisions

The actual schema is **single-household**, not multi-tenant: no family or membership
tables/IDs exist. Preserve shared roster/calendar access; enforce reference
ownership on private resources instead of inventing families.

Mutation transactions reserve the SQLite writer before reading state, then commit
business rows, balances, unlocks and notification rows together. No external
transport calls occur in transactions. Notification storage does not imply push
or WebSocket delivery. Transport implementation and scheduling remain Phase 5.

Business persistence casts SQLite JSON/date columns at read boundaries and writes
SQLAlchemy-readable UTC text / ISO date-only values. Existing numeric date values
are parsed through the Phase 3 helper. Calendar/spin/streak days follow the process
timezone, like Python `date.today()`. Stored timestamps, shoutout daily limits and
transaction reporting dates are UTC, like the reference's `utcnow()`/SQLite date
queries. Configure the same process timezone on both runtimes. In particular,
local Sunday and UTC Monday can belong to different reporting weeks; tests pin
their transaction dates rather than silently changing that reference behavior.

## Route parity and source audit

See [the endpoint-by-endpoint contract matrix](docs/business-api.md) for all **98**
remaining Python business REST endpoints, request/schema references, roles,
success/error statuses, database references, side effects and frontend callers.
The source inventory generator is read-only and imports no application code.

All 98 method/path pairs have Node registrations. **95** implement business REST
operations; **2** are transport-deferred; **1** is partially implemented:

- `POST /api/emotes`: 501 without an injected WebSocket delivery adapter.
- `POST /api/push/test`: preserves the no-subscriptions 400; otherwise 501 without
  an injected push sender. Never reports a fake successful delivery.
- `GET /api/push/vapid-public-key`: serves an existing stored public key or an
  injected provider; returns 503 when key initialization is unavailable. Python's
  key generation, validation/repair, and VAPID environment overrides are deferred
  with push delivery. Existing subscriptions remain readable/manageable.

Registration/middleware and workflow tests compare paths, methods, current-role
permissions and success status codes against Python source. They do not prove
every possible Pydantic coercion/error-message branch or every byte of every
response. No frontend changes were needed. The final correction pass adds `sharp`
for actual image decoding; MIME/extension checks alone did not establish content
safety. Existing dependencies and package-manager policy are otherwise unchanged.

## Files and architecture

- `src/business/router.ts`: thin HTTP/auth/validation/transaction boundary.
- `src/business/store.ts`: allowlisted schema-aware parameterized Prisma SQL,
  SQLite JSON/date compatibility, writer-transaction boundary and safe response
  projections. No caller-controlled identifier is interpolated.
- Domain modules: `chores`, `scheduling`, `calendar`, `rewards`, `household`,
  `reports`, `avatar`, `gamification`. State-changing commands share transactions
  rather than committing midway through point/unlock/notification updates.
- `validation.ts`, `response.ts`, `round.ts`, `time.ts`: nested FastAPI-style 422 validation,
  Pydantic-compatible naive UTC business timestamp formatting, microsecond
  preservation, and CPython-compatible ties-to-even float rounding.
- `uploads.ts`: bounded native multipart parsing, full JPEG/PNG/GIF/WebP decoding,
  generated image filenames, public image reads, parent deletion, best-effort
  rollback cleanup of proof files with generic failure warnings.
- `integrations.ts`: explicit delivery adapter boundary and subscription storage.
- `seed.ts` / public catalogue files: translated built-in categories, templates,
  achievements, quests, settings and avatar items. No private data is included.
- `src/db/avatarConfig.ts`: appearance/progression write boundary shared with the
  existing profile repository. This is the only necessary Phase 3 integration
  correction: `/api/auth/me` cannot bypass protected pet state via avatar JSON.
- `src/app.ts` / `src/server.ts`: mount business routes before admin-only routing;
  initialize built-ins after existing schema checks and administrator bootstrap.
- `tests/business/rules.test.ts`, `tests/integration/business*.test.ts`: isolated
  rules, HTTP workflows, schema/authorization/rollback/concurrency and startup.

## Intentional correctness/security differences from Python

1. Reassigning already completed/verified/skipped slots does **not** reopen them.
   The Python assign endpoint could otherwise grant repeat XP for a rewarded slot.
   Explicit parent undo remains available and retains lifetime XP as before.
2. Trade decisions resolve the proposal once. Acceptance resolves competing
   proposals; uniqueness conflicts return 409 rather than a database exception.
3. When a lifecycle endpoint's chore-only path matches multiple eligible children,
   return 409 rather than select a child arbitrarily. Python's
   `scalar_one_or_none()` instead raises an unhandled multiple-row error. The
   current frontend supplies no child/assignment selector to these endpoints;
   resolving that existing ambiguity needs an explicit API/frontend follow-up.
4. Both avatar saving and profile updating preserve server-owned pet XP/maps and
   daily interaction budgets. Forged JSON cannot replenish the budget. A writer
   lock prevents concurrent profile saves from erasing earned progression.
5. Parent-editable settings omit/reject initial-setup state and VAPID key records.
   Python exposed key/state entries through unrestricted settings dictionaries.
6. Nonpositive reward/chore prices and null required fields on updates fail
   validation/business checks rather than enabling point minting or DB errors.
   Points outside JavaScript's safe integer range are rejected rather than rounded.
7. Referenced category deletion returns 400 instead of violating foreign keys.
   Overlapping vacations are accepted as a union instead of failing a
   scalar-one query. SVG user text is XML-escaped.
8. Proof uploads use the same MIME/extension normalization as general uploads;
   downloads accept generated hex image filenames only. Arbitrary legacy suffixes
   allowed by the old proof handler are not served as active content.
   Both handlers now require successful raster decoding, reject MIME/content
   mismatches, and impose a 25-million-decoded-pixel limit (all animation frames)
   in addition to the existing configurable compressed-byte limit (default 5MiB).
   JPEG, PNG, GIF and WebP, including animated GIF/WebP, remain supported.
   Original validated bytes are saved, not re-encoded. Decoder errors are generic.
9. Initialization fills missing built-ins without overwriting customized
   achievement rewards, credentials, or existing schedules. The Python startup's
   old assignment-rule migration/cleanup and achievement metadata rewrites are
   **not** rerun automatically. Existing schedules are handled by the reference
   legacy generation fallback; fresh catalogues include complete metadata.
10. Multi-step workflows, daily budgets and unlocks are serialized and committed
    together. Failure rolls back all database changes instead of leaving the
    reference's intermediate commits. SQLite constraints remain authoritative.
11. Static `/api/chores/templates` is registered before `/:chore_id`; the Python
    declaration order shadows that route with integer-path validation. The Node
    route serves the template catalogue expected by the existing create modal.

As in Python, separate bonus requests and adequately funded/stocked purchases
are distinct operations; the contract has no idempotency key to deduplicate an
ambiguous client retry. One-time lifecycle transitions, refunds, spins and item
ownership are protected by persisted state and serialized transactions.

Business timestamp responses match SQLAlchemy/Pydantic naive UTC strings,
including existing six-digit microseconds. Date-only values remain ISO dates.
Event ordering and inclusive activity/multiplier boundaries compare actual UTC
instants at microsecond precision rather than lexically or by truncated Date.parse.
Phase 3 auth timestamp responses are unchanged. Validation preserves the frontend's
422 `detail` array convention, nested locations, ignored extra fields and common
coercions; this is not a general-purpose reimplementation of all Pydantic behavior.

## Database/deployment impact

No Prisma schema, baseline, migration, Python source, frontend, environment,
or live database changes. `package.json` and the pnpm lockfile add only the
justified `sharp` decoder and its transitive/platform packages; deployment must
install the appropriate platform binary normally through pnpm. The existing
Phase 3 prepared-schema and non-reused-user-ID guards remain required. Do not bypass the documented legacy
database preparation procedure or run Python and Node as concurrent writers.

On an operator-started Node runtime, catalogue initialization can add missing
public built-ins to the configured database, matching the Python seed intent.
It does not delete rows or overwrite user credentials/settings. Tests exercise
this only in disposable databases. No runtime was started on the developer DB.

Intentional insertions: categories only when their table is empty; missing
achievement/settings keys; default quests with missing titles only when their
category and an admin/parent creator exist; templates/avatar catalogue only when
their respective table is empty. A nonempty customized template/avatar catalogue
is not supplemented. Existing rows, including inactive/customized records and
schedules, are retained unchanged. Startup does not create assignments or rerun
Python's destructive legacy rule cleanup.

## Final review correction findings

1. **Reward prices — investigated, policy retained.** Actual Python create and
   wishlist conversion schemas require `point_cost > 0`; their update schema is
   unconstrained and redemption does not reject zero/negative legacy prices.
   The existing Node `int(0)` means strictly greater than zero, not zero allowed.
   Node already consistently rejects zero/negative create/edit/convert values and
   legacy redemption values, preventing point minting. No reward policy rewrite.
2. **Chore points — investigated, policy retained.** Python creation requires
   `points > 0`, while its update schema is unconstrained. Node's strict positive
   create/edit policy was already consistent and is intentionally retained.
   Tests execute the actual reference Pydantic schemas via source AST extraction,
   without importing app configuration, as well as HTTP success/failure paths.
3. **Uploads — confirmed and corrected.** A claimed image MIME/filename previously
   sufficed. A raster-only signature gate now precedes strict full pixel decoding
   with `sharp`; metadata alone is insufficient. Partial file-write failures are
   cleaned up, exclusive-create collisions never delete an existing file, and
   rollback cleanup failures warn generically without masking database failures.
4. **Trades — tested and retained.** Acceptance transfers to the intended
   recipient, the original owner receives exactly one resolution notification,
   competing proposals are invalidated, and resolved acceptance/denial cannot
   replay. `Store.update()` does not mutate the original assignment snapshot;
   its local `a.user_id` remains the correct notification recipient. No change
   to `calendar.ts`.
5. **Dates/timezones — partial defect corrected.** Local day/Monday boundaries,
   UTC creation weekdays/reporting dates and date-only vacation/spin/streak rules
   already match Python. Seasonal event comparisons could lose microseconds or
   misorder equivalent timestamp representations; shared precise comparisons fix
   creation, editing, activity responses and verification multipliers. Isolated
   process-clock HTTP/database tests cover Chicago midnight/DST and Tokyo, and
   prove legacy six-digit timestamps survive reads and unrelated edits.
6. **Catalogues — tested and retained.** Canonical and prepared populated legacy
   fixtures preserve every existing SQL value, customized catalogue row,
   credential, setting, balance, historical record and schedule across startup.
   Three consecutive calls are idempotent and foreign-key checks remain clean.
   Preparing the disposable legacy fixture leaves its source bytes unchanged.

Files changed in this correction pass only (relative to `server/`; previously
staged Phase 4 implementation files outside this list were not edited):

```text
PHASE4.md
package.json
pnpm-lock.yaml
src/business/chores.ts
src/business/household.ts
src/business/router.ts
src/business/time.ts
src/business/uploads.ts
tests/business/rules.test.ts
tests/business/uploads.test.ts
tests/helpers/business-clock-worker.ts
tests/helpers/images.ts
tests/integration/business.test.ts
tests/integration/business-time.test.ts
tests/integration/catalog-safety.test.ts
```

List relationship reads are batched and paginated point/notification histories
are limited in SQL. Report calculations use batch snapshots; very large household
histories would benefit from further bounded aggregate queries/performance tests.
No new indexes have been introduced without measured evidence.

## Verification

Run from `server/`, using the established Node 22/pnpm Git Bash environment:

```sh
pnpm build
pnpm exec node scripts/verify-schema-engine.mjs
pnpm test
pnpm exec vitest run tests/business/rules.test.ts tests/business/uploads.test.ts tests/integration/business.test.ts tests/integration/business-time.test.ts tests/integration/catalog-safety.test.ts
pnpm typecheck
pnpm build
git diff --check
```

The build before tests is required for the production-runtime smoke tests, as in
the existing deployment tests. Source-only audit from the repository root:

```powershell
.\.venv\Scripts\python.exe server/scripts/audit-business-contracts.py
```

Tests use synthetic temporary SQLite files, never live databases or real secrets.
The loopback startup test completes setup/login, account creation, chore approval,
redemption/fulfillment, checks FKs, reads business rows through actual Python
SQLAlchemy and compares timestamp formatting. Test servers are stopped afterward.
Expected rollback-injection tests log only the generic request-error message.

Final verification on this diff:

- Schema engine: `db push` and `migrate deploy` both passed on separate disposable
  databases, each with 28 application tables and a clean foreign-key check.
- Full suite: **234 tests passed in 17 files** (116 Phase 4 tests, including 37
  final-review regression tests; 118 existing tests). No failed or skipped tests
  were reported.
- Focused correction run: **115 tests passed in 5 files**, including actual HTTP
  requests, foreign-key checks and populated legacy/canonical database snapshots.
- Typecheck, production build and `git diff --check`: passed. New untracked files
  also received an explicit whitespace check because ordinary `git diff` omits
  untracked content.
- Real loopback production-runtime HTTP workflow and actual Python SQLAlchemy
  reads/timestamp comparison: passed; the test server was stopped.
- Original database/configuration, Python backend, React frontend, Prisma schema
  and migration history were not modified. The only new direct dependency is
  `sharp`, for content validation. No commit or push.
- An additional `git diff --cached --check` found whitespace only inside the
  pre-existing staged `phase4-full-review.diff` review artifact, which was already
  absent from the working tree before this correction pass. The staged server
  source check passes. That artifact, the untracked `phase4-complete-review.diff`
  artifact and the index were left untouched; review their intended inclusion
  separately before committing.

## Phase 5 / readiness

REST implementations are ready for developer review, **not a production cutover**.
Full end-to-end parity is not yet achieved. Phase 5 can begin on this foundation:

- Implement real WebSocket and push adapters, VAPID initialization/environment
  handling and delivery retry/checkpoint/outbox semantics. Notification rows are
  durable in-app state, **not** a guaranteed push-delivery queue.
- Implement scheduling: daily generation/rotation advancement, persisted stale
  streak resets, refresh-token cleanup and scheduler error/retry policy. Current
  calendar/family reads generate a week; daily jobs are not silently imitated.
- Resolve the pre-existing multi-child lifecycle targeting ambiguity before
  calling that frontend workflow production-ready.
- Complete deployment/static frontend serving and integration/cutover testing.
  No React redesign or Python retirement occurs in Phase 4.

Remaining validation-coercion/message edge cases and large-history performance
are review/test-hardening items, not proof of complete contract equivalence.
File writes cannot participate in a SQLite transaction: normal rollback cleans
proof files, but a process crash can leave an unreferenced file needing cleanup.
These limitations must remain visible when reviewing/committing this migration.
