# SQLite deployment and Python-to-Node migration

These database safety procedures support the integrated Node backend, including
authentication, business REST routes, WebSockets, push and daily maintenance.
See `../PHASE5.md` for runtime parity and `../PHASE6.md` for deployment evidence
and remaining acceptance gates. Never run `prisma migrate reset` or `db push`
on live data. Schema provisioning remains an explicit offline operation.

## Toolchain and file conventions

Use the existing dependencies and Git Bash UCRT64 toolchain, from `server/`:

```bash
cd /path/to/ChoreQuest/server
node --version
pnpm --version
pnpm exec prisma --version
pnpm exec node scripts/verify-schema-engine.mjs
```

Verified with Node 22.14.0, pnpm 10.34.6, Prisma/client 6.19.3 and TypeScript
5.9.3. A login shell can change directory in its profile: explicitly `cd` before
commands. Codex's injected PowerShell/Node/PATH can differ from the developer's
interactive shell; missing commands are environment problems, not schema defects.
No dependency upgrade is needed for this migration.

The diagnostic creates only new disposable databases, verifies 28 application
tables and foreign keys, and removes its temporary files. Both `db push` and
`migrate deploy` have passed. In an agent-launched CLI, automatic creation of a
missing file failed with a generic schema-engine error even under Node 22, while
direct engine creation, schema comparison and operations on existing empty files
worked. Explicit exclusive empty-file initialization resolves that reproducibly;
the diagnostic now includes it. Interactive Git Bash also passed before this
change. Do not treat the historical agent error as a current repository blocker.

Node's `DATABASE_URL` uses `file:`, not Python's `sqlite+aiosqlite:` scheme.
Prefer an absolute Windows path with forward slashes, e.g. `file:C:/private/app.db`.
Relative paths are relative to `server/prisma/schema.prisma`, not the shell's
working directory. Startup validates the existing SQLite header and required
account schema before bootstrap/listening: a mistyped/missing path cannot silently
create a database. Parent directories are not automatically created.

## A. Fresh Node installation

1. Create a private existing directory for database files/backups. Supply a
   new absolute path and initialize it **once**; an existing file is refused:

   ```bash
   db_path='C:/private/chorequest-new.db'  # Choose an absolute path in an existing private directory.
   pnpm exec node scripts/initialize-sqlite.mjs "$db_path"
   export DATABASE_URL="file:$db_path"
   pnpm exec prisma migrate deploy
   pnpm exec prisma migrate status
   pnpm exec prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
   ```

   The migration creates all application tables and migration history. The last
   command must exit 0 (no drift); exit 2 means a difference requiring review.
   A zero-byte file is an intentional SQLite initialization placeholder, not a
   ready application database. Do not start before migrations succeed.

2. Supply configuration through your service's protected environment. Never
   commit `.env`, database files, credentials or diagnostic copies. `SECRET_KEY`
   is required (at least 16 characters, not a known weak value); use a strong
   operator-generated secret, not an example/default value. To enter an existing
   operator-provided value in Git Bash without echoing it:

   ```bash
   IFS= read -r -s -p 'New SECRET_KEY: ' SECRET_KEY; printf '\n'; export SECRET_KEY
   ```

   Defaults: `ACCESS_TOKEN_EXPIRE_MINUTES=15`, `REFRESH_TOKEN_EXPIRE_DAYS=30`,
   `COOKIE_SECURE=false`, `CORS_ORIGINS` empty, `PORT=3000`. Optional `HOST` sets
   the bind address; unset preserves Node's normal default. For HTTPS set
   `COOKIE_SECURE=true`; configure permitted comma-separated frontend origins.
   Empty origins do not permit cross-origin credentialed access. `server/.env`
   is local-only if used; the Python root `.env` is not Node's configuration.

3. Optional `INITIAL_ADMIN_USERNAME` and `INITIAL_ADMIN_DISPLAY_NAME` override
   `Admin` / `Administrator`. An optional `INITIAL_ADMIN_PASSWORD` must satisfy
   the six-character minimum. Without it, bootstrap stores an unknown random
   password hash and requires first-run password creation, not a default password.
   Bootstrap runs once only on an empty users table; it does not repair an
   installation with users but no administrator or overwrite existing accounts.

4. Build and start, then verify both health and the database-backed setup status:

   ```bash
   pnpm build
   pnpm start
   # From another terminal:
   curl --fail http://127.0.0.1:3000/api/health
   curl --fail http://127.0.0.1:3000/api/auth/setup-status
   ```

   Restrict first-run access to the intended administrator until password setup
   completes. Use the existing frontend/password setup flow, or the documented
   `/api/auth/setup-password` contract, without placing passwords in shell history.
   If an initial password was configured, log in normally instead. Registration
   remains disabled. Verify authenticated `/api/auth/me` and administrator access.

## B. Migration from Python: backup, prepare, review, then cut over

Do not select the source from Node's URL by assumption. Check Python's configured
`DATABASE_URL`, its working directory and actual SQLite file. All examples below
use operator-selected paths, not repository/user-specific private paths.

### Read-only rehearsal (writers may remain running)

From the repository root, use the existing `.venv` explicitly:

```bash
.venv/Scripts/python.exe -B server/scripts/verify-legacy-preparation.py --source 'C:/private/python-source.db'
```

This creates a private temporary workspace outside the repository. It opens the
source `mode=ro` / `query_only`, uses SQLite's backup API (including committed WAL
data), and verifies a consistent snapshot. It prepares a separate reference,
verifies all rows/identities, constraints, named schema objects, FK/integrity and
actual SQLAlchemy date reads, then creates independent `baseline.db` and
`exercise.db` copies. `report.json` contains paths/counts/fingerprints, no account
contents or credentials. Keep the workspace private; its databases contain real
copied data. Never commit it or include it in public bug reports.

Source preservation compares main-file and WAL hashes, sizes and modification
times. SHM is volatile reader coordination and may change during read-only SQLite
access; it is reported separately, not falsely promised byte-identical. An active
external writer can legitimately change source data during rehearsal: then the
audit refuses to claim unchanged content. No service is stopped by these tools.

From `server/`, validate the private baselining copy BEFORE marking any history:

```bash
baseline_url='file:C:/private/dry-run-workspace/baseline.db'  # Use the report's actual private path.
pnpm exec prisma migrate diff --from-url "$baseline_url" --to-schema-datamodel prisma/schema.prisma --exit-code
DATABASE_URL="$baseline_url" pnpm exec prisma migrate resolve --applied 00000000000000_baseline
DATABASE_URL="$baseline_url" pnpm exec prisma migrate status
DATABASE_URL="$baseline_url" pnpm exec prisma migrate deploy
pnpm build
pnpm exec tsx scripts/smoke-prepared-database.ts 'C:/private/dry-run-workspace'
```

`resolve --applied` records the reviewed baseline checksum **without executing
its table-creation SQL**. An existing application database is not empty. Do not
run `migrate deploy` against an unbaselined prepared database: it would try to
create existing tables. `migrate status` alone is not a drift check. If a history
already exists, inspect it first; never reset/delete history or resolve failed/
different migrations blindly. If the exact baseline is already finished with the
same checksum, skip `resolve` and verify status/deploy normally. The checked-in
baseline SQL and migration history have not been edited by this work.

The smoke command accepts only the workspace's isolated `exercise.db`; it refuses
the source and prepared reference. It starts/stops its own temporary production
server bound only to `127.0.0.1`, uses a fixed **test-only** signing key and new disposable accounts, and
tests role changes, login/PIN, refresh/replay/logout, admin APIs, deletion,
history/family preservation and ID non-reuse. It does not know or reset existing
users' credentials. Re-run on a new workspace rather than reuse an exercised copy.
From the repository root, verify the original again afterward:

```bash
.venv/Scripts/python.exe -B server/scripts/verify-legacy-preparation.py --verify-source 'C:/private/dry-run-workspace/report.json'
```

### What preparation changes (only in a new output)

The preparation tool is `server/scripts/prepare-legacy-auth-db.py`. It never
overwrites an output, creates parent directories, runs at startup, imports Python
app startup, or disables foreign keys. Unknown schema differences fail closed.

- Application tables use the existing reviewed Prisma baseline definitions,
  created only in the new empty output. This includes AUTOINCREMENT on integer
  primary keys, stable named unique indexes, SQLite-equivalent string/numeric
  declarations, and baseline DATE/DATETIME representation. Values and account IDs
  are preserved; previous SQLite sequence high-water marks, including empty
  tables, are retained. Manually inserting retired IDs or clearing
  `sqlite_sequence` defeats identity guarantees and is prohibited.
- The following preserved links become nullable with `ON DELETE SET NULL`:
  `chores.created_by`, `rewards.created_by`, `seasonal_events.created_by`,
  `api_keys.created_by`, `invite_codes.created_by`, `announcements.created_by`,
  `vacation_periods.created_by`, both shoutout user IDs, assignment `verified_by`,
  redemption `approved_by`/`fulfilled_by`, point transaction `created_by`, and
  audit `user_id`. Required ownership FKs remain required; no blanket cascades.
- Source columns/defaults/PKs/effective uniqueness and FK relationships are
  checked before copying. Only the listed nullability/delete-action differences
  and baseline-equivalent type declarations are accepted. Extra named indexes,
  triggers and views are preserved. SQLite's internal auto-index names may be
  replaced by canonical baseline names while preserving uniqueness. Conflicting
  named indexes, extra inline constraints/defaults, CHECK/collation/generated
  definitions or unknown tables require manual review, not silent removal.
  Custom extra indexes can produce a nonempty Prisma diff; review them and stop
  rather than automatically dropping them or falsely claiming baseline equality.
- Numeric auth timestamps in users, settings, refresh tokens, API keys, invites
  and audit logs become equivalent naive-UTC `YYYY-MM-DD HH:mm:ss.ffffff` text.
  Existing text/other values remain unchanged. New Node auth writes use that
  Python-readable format, and Node reads accept both old milliseconds and text.
  Future business phases must reuse this boundary: Prisma's typed DateTime reader
  cannot read every Python timestamp spelling, and passing Date objects directly
  to SQLite writes reintroduces epoch-millisecond incompatibility.
- FK enforcement stays ON; deferred constraints permit copy ordering. The tool
  compares every copied row, checks FK/integrity before commit and again after
  commit, and removes only its newly created output on failure. The original and
  verified backup remain the rollback point. A second preparation is logically
  idempotent, but always produces another new file rather than modifying input.

### Actual cutover (manual, after rehearsal acceptance)

1. Stop all Python/Node/database writers and background jobs. The tools do not do
   this. Keep the original file; do not overwrite it or raw-copy a live WAL file.
2. Run the read-only audit above again while writers are stopped. Its SQLite
   snapshot is a consistent backup. Verify `integrity_check=ok`, clean FK check,
   all row/ID comparisons and main/WAL preservation. Retain original and snapshot
   on protected storage and review the prepared reference before activation.
3. Independently verify zero Prisma drift on the prepared reference (or resolve
   approved custom schema differences first). Establish its migration history
   with `migrate resolve --applied` as rehearsed, then verify status/deploy. Do not
   replay schema-creation SQL on it or mark unknown drift as applied.
4. **Rotate SECRET_KEY to a fresh operator-provided strong value on every backend
   that will accept tokens.** Legacy deleted IDs cannot be reconstructed; this
   invalidates all pre-cutover JWTs, including stored refresh credentials. Everyone
   must log in again. Tools never read, print or rotate the active secret.
5. Switch the service's Node `DATABASE_URL` to the accepted prepared file. Keep
   the old file/backup untouched. Start Node, verify health plus authenticated
   account/admin access and FK integrity. Do not reactivate old writers.
6. If startup/verification fails before writes reopen, stop Node and restore the
   old configuration/backup. Coordinate signing keys; do not inadvertently accept
   pre-cutover sessions again. After new writes, restoring an older snapshot loses
   those writes: back up the active database and plan reconciliation first.

Python SQLAlchemy date reads were verified, and the prepared file can support an
explicitly reviewed code rollback. **Simultaneous Python and Node writers are not
supported by this Phase 3 procedure.** Python startup has its own schema changes
and jobs; Python role/token concurrency behavior differs. Sharing timestamps or
JWT signing formats does not prove safe dual-writer/auth coexistence. Prefer one
authoritative backend/writer; review routing, jobs, schema, signing keys and
authorization separately before any hybrid deployment. No live cutover, service
stop, configuration change or key rotation is performed by the dry-run tools.

## Regression checks

```bash
pnpm exec node scripts/verify-schema-engine.mjs
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Automated suites use synthetic disposable SQLite files only, including WAL
snapshots, legacy preparation/rollback, schema objects, ID history, actual
SQLAlchemy date reads, fresh migration/bootstrap, baseline checksum/deploy and
invalid-path startup. Real-schema rehearsals are explicit operator commands,
never an implicit dependency on development data in `pnpm test`.
