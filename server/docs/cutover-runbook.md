# Future operator-controlled cutover and rollback — NOT executed

Required gates: actual green Linux CI and Docker smoke, independent review,
private HTTPS/NPM/wss and approved real-browser push acceptance, rehearsal of the
specific legacy fixture and permissions. Pin the reviewed image digest and keep
the previous Python image/configuration. Keep one Node process/replica. Neither
this document nor Phase 6 authorizes a production deployment.

1. Schedule maintenance and block new writes/access. Stop the Python writer and
   any old Node processes/jobs. Verify no other writer can reach SQLite/uploads.
2. Record actual Python `DATABASE_URL`, uploads root, TZ, reset hour, signing key,
   cookie/origin configuration and VAPID source **privately**, never in a ticket.
   Copy configuration into protected offline recovery storage. Preserve the
   VAPID identity for subscription continuity. Follow the established legacy
   signing-key rotation requirement below; do not promise session continuity.
3. With writers stopped, snapshot database/uploads/config together. Example paths
   below are placeholders: choose absolute private paths, not the repository's
   development database. On Windows use the existing `.venv/Scripts/python.exe`;
   on Linux use the deployment's approved Python 3.12 interpreter.

   ```bash
   python3 -B server/scripts/snapshot-state.py --database /private/source/chorequest.db --uploads /private/source/uploads --configuration /private/source/deployment.env --output /private/backups/pre-node --writers-stopped
   ```

   The destination must not exist. SQLite backup captures committed WAL pages;
   the tool checks integrity/FKs, copies uploads/config with private permissions
   and hashes all files. Do not copy only an active `.db` file or omit uploads.
   `--writers-stopped` is an operator assertion, not a process-lock detector.
   Use existing OS ACLs/encrypted storage and an off-host recovery copy. Never
   include backups in image contexts or Git. Hashes detect accidental corruption,
   not malicious alteration of both backup and manifest.
4. Follow `../prisma/README.md` preparation on a **new copy**, compare all rows,
   account IDs/roles, hashes, balances/history, recurrence, achievements, avatar/
   pets, settings, notifications, subscriptions and microsecond dates. Require
   integrity/FK checks and exact schema diff, then explicitly baseline the reviewed
   copy and run deploy/status. Do not run `migrate deploy` against unbaselined
   legacy tables. Keep the pre-cutover original and snapshot immutable.
5. Follow `../prisma/README.md`'s mandatory **SECRET_KEY rotation** on every
   backend accepting tokens for the legacy cutover. Historical deleted user IDs
   cannot be reconstructed; old JWTs must not revive against reused IDs. Require
   everyone to log in again. Never automatically rotate or print a live key.
   Preserve the correct VAPID key pair independently of this signing-key change.
   Place the prepared copy/uploads on separately provisioned Node state, owned
   by UID/GID 1000. Keep the old Python state offline. Start one Node privately
   against an absolute `file:` URL, with reviewed signing/VAPID identity and TLS
   cookie/origin settings. Runtime startup must not alter schema. Existing users
   prevent bootstrap from creating admins or changing credentials.
6. Privately verify login, current roles, chore create/assign/complete/verify,
   balances/achievements, rewards/history, upload reads, WS events, scheduler and
   test-device push. Liveness alone is insufficient. Confirm WAL/SHM writes and
   restart persistence. Review logs without publishing secrets or account data.
7. Only with explicit operator approval switch NPM upstream; preserve the same
   host and WS headers. Validate HTTPS cookies, wss reconnect and browser push.
   Do not run Python and Node writers simultaneously. Observe DB errors, daily
   warnings, retries/exhaustion, disk and graceful shutdown. Retain rollback state
   through an agreed acceptance window.

## Rollback

Keep users in maintenance. Stop Node and verify its process/workers/connections
are gone before any other writer starts. Preserve post-cutover Node state in a
separate snapshot for investigation. Restore the immutable pre-cutover snapshot
into a **new** private directory, never over a running DB:

```bash
python3 -B server/scripts/snapshot-state.py --restore-from /private/backups/pre-node --output /private/recovery/python-rollback
```

Verify manifest, SQLite integrity/FKs, uploads and configuration. Restore original
Python configuration/image, paths, ownership and VAPID identity; coordinate signing
keys so rollback does not reaccept invalidated pre-cutover JWTs. Confirm
SQLAlchemy can read the restored data before explicitly starting a private Python
instance. The local rehearsal checks actual Python SQLAlchemy reads, not a claim
that a live Python deployment was started. Only the operator restarts production
Python and changes proxy routing after acceptance. Confirm login/business/uploads.

**Pre-cutover restoration loses user writes after cutover.** Do not silently merge
or replay two divergent databases. Keep the stopped Node snapshot and reconcile
any accepted writes through an operator-reviewed plan, or keep maintenance until
the decision is made. Restored push jobs may retry; delivery can duplicate. VAPID
identity and saved subscriptions belong to the same backup. Never rollback by
pointing Python at an unreviewed mutated Node database.

## Persistent-state inventory

SQLite: users/password hashes/PINs/roles, refresh revocation, API keys/invites/audit,
chores/rules/rotations/assignments, XP/streaks, achievements, rewards/redemptions,
wishlists, avatar inventory/progression, vacations/events/bulletin, notifications,
push subscriptions, database-backed VAPID pair, settings, private daily checkpoint
and push queue/leases (`__runtime_*`). Upload binaries are outside SQLite; back
them up with DB references. Signing key, env-provided VAPID keys/contact, TLS/proxy
configuration and pinned image/version are external and require protected backup.
Built static assets are reproducible from the reviewed commit/lockfiles. WebSocket
connections, in-memory budgets and provider in-flight requests are not durable;
clients reconnect and refresh REST state. No WS event replay log exists.
