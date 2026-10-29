# Isolated staging backup and NEW-project recovery

Operator-only commands, **not executed against the homelab**. Use synthetic
staging state exclusively. Preserve production and the source staging instance;
restore into a newly named project and newly created volumes. Never initialize,
reset, overwrite or migrate the source as a recovery shortcut.

## State and consistency

Keep DB, uploads, protected app environment and reviewed image ID together.
SQLite includes accounts/roles/hashes/refresh revocation, chores/assignments,
history/balances, rewards, settings, VAPID identity, scheduler checkpoint and
durable push jobs/leases. Upload bytes are in a different volume. Proxy TLS,
renewal/DNS credentials and NPM configuration are a separate protected backup.
Open WS connections are ephemeral; clients reconcile using REST after reconnect.
Retried restored push jobs can duplicate delivery: recovery must not deliver
real notifications without approval. Do not enroll real devices for this rehearsal.

Stop the **only** app writer/worker before cross-resource backup and verify a
successful exit. No provisioning container, second app, Python process or manual
SQLite writer may access this staging state. `--writers-stopped` asserts that
operator check; it does not discover or stop writers. The existing tool uses
SQLite backup(), captures committed WAL pages, checks integrity/FKs, copies
uploads/config, hashes files and refuses an existing destination. Never copy
only a running `.db` or omit WAL/SHM/uploads.

## Backup on a local Linux Docker Engine

These commands require the reviewed runbook shell's `dc`, `staging_project` and
absolute `staging_env`, authorized sudo, Python 3.12 and a **local rootful Linux
Engine** with local named volumes. They do not apply to Docker Desktop, a remote
context, bind/remote volumes or rootless storage. Verify the selected Docker
context points to this host before using volume mountpoints. If that prerequisite
fails, stop and plan a separate reviewed offline export; do not guess host paths.

```bash
set -euo pipefail
umask 077
case "$staging_project" in chorequest-phase7-*) ;; *) exit 1 ;; esac
test "$(docker info --format '{{.OSType}}')" = linux
case "$(docker context inspect --format '{{.Endpoints.docker.Host}}')" in unix://*) ;; *) exit 1 ;; esac

# Only accepts the two project-owned local volumes used by this Compose file.
volume_root() {
  local project="$1" logical="$2" volume="${1}_${2}"
  case "$project" in chorequest-phase7-*) ;; *) return 1 ;; esac
  case "$logical" in database|uploads) ;; *) return 1 ;; esac
  test "$(docker volume inspect --format '{{.Driver}}' "$volume")" = local
  test "$(docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}' "$volume")" = "$project"
  test "$(docker volume inspect --format '{{index .Labels "com.docker.compose.volume"}}' "$volume")" = "$logical"
  # Reject local-driver bind/NFS options; only the fresh default volumes qualify.
  case "$(docker volume inspect --format '{{json .Options}}' "$volume")" in null|'{}') ;; *) return 1 ;; esac
  docker volume inspect --format '{{.Mountpoint}}' "$volume"
}

database_root="$(volume_root "$staging_project" database)"
uploads_root="$(volume_root "$staging_project" uploads)"
case "$database_root:$uploads_root" in /*:/*) ;; *) exit 1 ;; esac
dc stop -t 75 app
app_id="$(dc ps --all --quiet app)"
[[ "$app_id" =~ ^[a-f0-9]{64}$ ]]
test "$(docker inspect --format '{{.State.Running}}' "$app_id")" = false
test "$(docker inspect --format '{{.State.ExitCode}}' "$app_id")" = 0
# Also verify no other container/process mounts or writes these volumes.
# Select a NEW absolute backup path OUTSIDE both source volumes and Git.
read -r -p 'New absolute private backup directory: ' backup_dir
case "$backup_dir" in /*) ;; *) exit 1 ;; esac
sudo python3 -B server/scripts/snapshot-state.py \
  --database "$database_root/chorequest.db" --uploads "$uploads_root" \
  --configuration "$staging_env" --output "$backup_dir" --writers-stopped
```

On any error, keep the selected instance stopped and state intact for private
inspection. Do not delete files or automatically retry migrations. The backup
directory must have an existing protected parent; it is created exclusively with
0700 directories/0600 files. Keep encrypted/off-host recovery copies. The manifest
detects accidental corruption, not an attacker replacing both data and hashes.
Record only success, commit/image IDs and non-secret counts/digests in reports.
The backed-up env contains signing/admin secrets; never print or commit it.

After verified backup, the source may explicitly resume using its unchanged
project/env/images: `dc up -d --wait --scale app=1 app`. Restoring elsewhere must
not stop, mutate, repoint, reprovision or delete the resumed source.

## Restore into fresh isolated volumes

Use the same reviewed checkout/images and a **different** new project. No real
devices/subscriptions belong in the source fixture. Do not restore a DB containing
real subscriptions and then allow the worker to send automatically.

```bash
# Select NEW absolute output, outside backup/source/Git. It must not exist.
read -r -p 'New absolute private recovery directory: ' recovery_dir
case "$recovery_dir" in /*) ;; *) exit 1 ;; esac
sudo python3 -B server/scripts/snapshot-state.py --restore-from "$backup_dir" --output "$recovery_dir"

restore_project="chorequest-phase7-restore-$(node -p "require('node:crypto').randomBytes(6).toString('hex')")"
test "$restore_project" != "$staging_project"
test -z "$(docker ps -aq --filter "label=com.docker.compose.project=$restore_project")"
test -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$restore_project")"
test -z "$(docker network ls -q --filter "label=com.docker.compose.project=$restore_project")"
# Make a NEW private config copy, preserving signing/VAPID identity. Do not
# regenerate credentials. Select an UNUSED loopback port privately in this copy
# if source still occupies 8123. Use Secure cookies for later HTTPS acceptance.
restore_env="$recovery_dir/restore.env"
sudo install -m 0600 -o "$(id -u)" -g "$(id -g)" "$recovery_dir/configuration.env" "$restore_env"
# The recovery directory is root-private: authorize operator traversal privately
# without widening world permissions (e.g. chown its directory to the operator).
sudo chown "$(id -u):$(id -g)" "$recovery_dir"
# Edit restore.env in a private editor now. Do not source/print it.
rdc() { docker compose --project-name "$restore_project" --env-file "$restore_env" -f server/compose.staging.yml "$@"; }
rdc config --quiet
# Creates containers, project network and initialized volume directories only;
# does NOT start app, run provisioner, or create a database schema.
rdc create --no-build --scale app=1 app
restore_database="$(volume_root "$restore_project" database)"
restore_uploads="$(volume_root "$restore_project" uploads)"
# Refuse any existing state: image's empty uploads mountpoint alone is allowed.
sudo test ! -e "$restore_database/chorequest.db"
test -z "$(sudo find "$restore_database" -mindepth 1 -maxdepth 1 ! -name uploads -print -quit)"
test -z "$(sudo find "$restore_database/uploads" -mindepth 1 -print -quit)"
test -z "$(sudo find "$restore_uploads" -mindepth 1 -print -quit)"
sudo install -m 0600 -o 1000 -g 1000 "$recovery_dir/chorequest.db" "$restore_database/chorequest.db"
sudo cp -a "$recovery_dir/uploads/." "$restore_uploads/"
sudo chown -R 1000:1000 "$restore_database" "$restore_uploads"
# Use a pre-existing reviewed image, never provision or rebuild to repair state.
rdc up -d --no-build --wait --wait-timeout 120 --scale app=1 app
```

All recursive ownership/copy targets above are operator-verified **new local
project volumes**, not a path computed from untrusted application data. Stop if
any validation fails; preserve partial restore state for inspection. Source
snapshot and source deployment are untouched by restore. The working recovery
directory gains a separate runtime configuration after manifest verification;
do not treat that subsequently modified directory as an immutable backup.
Backups retain their original manifest/config; do not edit them to make
verification pass.

Before accepting recovery, privately verify SQLite integrity/FKs and WAL using
the selected container's Prisma, without printing rows/secrets:

```bash
rdc exec -T -w /app/server app node --input-type=module -e '
import assert from "node:assert/strict"; import {PrismaClient} from "@prisma/client";
const db=new PrismaClient(); try {
assert.deepEqual(await db.$queryRawUnsafe("PRAGMA integrity_check"),[{integrity_check:"ok"}]);
assert.deepEqual(await db.$queryRawUnsafe("PRAGMA foreign_key_check"),[]);
assert.deepEqual(await db.$queryRawUnsafe("PRAGMA journal_mode"),[{journal_mode:"wal"}]);
console.log("PASS: SQLite integrity, FKs and WAL");
} finally {await db.$disconnect();}'
```

Use the restored project's own approved private HTTPS route for browser checks;
do not switch the source proxy upstream to rehearse recovery. Compare synthetic
account IDs/roles, balances, chore/reward histories, upload bytes, VAPID public-key
digest, scheduler checkpoint and push queue behavior. Restart once more and
verify no credential overwrite, duplicate awards, lost uploads or unexpected
delivery. Clear only synthetic test subscriptions with operator approval.
Shutdown exit 0 and subsequent startup must pass; health alone is insufficient.

Cleanup defaults to `rdc down --timeout 75` **without volumes**. Destruction of
the restored project's data requires the exact-name confirmation/ownership checks
in the staging runbook, applied to `restore_project` and `rdc`, never the source.
Preserve backups and stopped failure fixtures until reviewed. No broad prune,
in-place restore or automatic production rollback is part of this procedure.
