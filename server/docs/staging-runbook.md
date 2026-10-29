# Isolated Node staging (opt-in)

No command here changes the Python Compose service, proxy, DNS or live database.
Use a Linux Docker host with Compose >= 2.24.4, Node 22 and pnpm 10.34.6. The image
contains one Node process; do not scale replicas or run two application writers.
Phase 6 Linux container acceptance passed at commit
`4b85827e838b6de4017ba1a6f5d0aecb4f46feb8` in
[run 40631656245](https://github.com/austinstiefel/ChoreQuest/actions/runs/40631656245).
That proves the disposable HTTP/WS harness, not a private homelab deployment,
trusted browser HTTPS/WSS, NPM integration or real browser push. See
[`../PHASE7.md`](../PHASE7.md) for separate evidence and pending gates.

All commands below are **operator-run after deployment authorization**, from the
reviewed checkout on the selected Linux Docker host. They have not been executed
against the homelab. Never use production data, volumes, networks or credentials.

## Prerequisites and private topology

Confirm `git rev-parse HEAD`, `node --version` (22), `pnpm --version` (10.34.6),
`docker compose version` (>=2.24.4) and `docker info --format '{{.OSType}}'`
(`linux`). Require free disk for images, DB/WAL, uploads and two recovery copies;
Python 3.12 for the existing snapshot tool; Docker administration authorization;
private filesystem/backup storage; and an approved private proxy/DNS plan.
Docker access is effectively host administration. Never start a daemon or change
another project to get past a failed prerequisite. Stop on any failed command.

Browser -> internal DNS -> trusted HTTPS staging proxy -> app:8122 -> this
project's SQLite/uploads volumes. The host diagnostic mapping stays
127.0.0.1:8123; the project bridge permits egress. No public router forwarding,
tunnel, wildcard bind or production proxy-network membership is required.
An NPM container's 127.0.0.1 is its own loopback, not the Docker host's.
Use the exact same-host or separate-VM operator procedure in
[`staging-https-acceptance.md`](staging-https-acceptance.md) before browser login.

## Build and disposable smoke

From repository root:

```bash
docker build -f server/Dockerfile.node -t chorequest-node-staging:phase6 .
cd server
pnpm install --frozen-lockfile
node scripts/docker-smoke.mjs
```

The smoke creates a random Compose project and private temporary environment,
initializes a new named volume explicitly, starts the production image, exercises
HTTP/WS/uploads, verifies native modules/SQLite/WAL/non-root operation, sends
SIGTERM, restarts and checks persistence. It removes only its own project and
volumes in `finally`. It never sends push or connects to production. If interrupted
forcibly, remove only the `chorequest-phase6-*` project identified by your run.
Build failures are fatal, not a reason to upgrade dependencies or run as root.
The smoke's temporary override requests an ephemeral host port on 127.0.0.1;
normal staging keeps port 8123. Port discovery validates live container identity
and the exact 8122/TCP loopback mapping, and repeats the query after restart.
Static configuration tests require the Docker Compose CLI (no daemon needed);
`CHOREQUEST_TEST_DOCKER` can explicitly select its executable if absent from PATH.

## Operator-controlled isolated instance

The following Linux shell commands use a new private directory outside Git.
Generate unique credentials; do not reuse the production signing key or accounts.

```bash
set -euo pipefail
umask 077
# Clear inherited Compose overrides; the private file is authoritative.
for variable in ${!STAGING_@}; do unset "$variable"; done
staging_project="chorequest-phase7-$(date -u +%Y%m%d%H%M%S)-$(node -p "require('node:crypto').randomBytes(3).toString('hex')")"
# Refuse reuse, including stopped containers or orphaned state.
test -z "$(docker ps -aq --filter "label=com.docker.compose.project=$staging_project")"
test -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$staging_project")"
test -z "$(docker network ls -q --filter "label=com.docker.compose.project=$staging_project")"
mkdir "$HOME/chorequest-staging-private"
node server/scripts/create-staging-env.mjs "$HOME/chorequest-staging-private/staging.env"
staging_env="$HOME/chorequest-staging-private/staging.env"
# Before starting, privately edit staging.env: STAGING_COOKIE_SECURE=true;
# set a real STAGING_VAPID_CONTACT, review TZ/reset hour, leave CORS empty for
# same-origin use. Never source/print this file. Do not log in over HTTP.
dc() { docker compose --project-name "$staging_project" --env-file "$staging_env" -f server/compose.staging.yml "$@"; }
dc --profile tools config --quiet
dc build app provision
# Record these non-secret image IDs with the checkout commit in private records.
docker image inspect --format '{{.Id}}' chorequest-node-staging:phase6 chorequest-node-provision:phase6
dc run --rm provision
dc up -d --wait --wait-timeout 120 --scale app=1 app
curl --fail http://127.0.0.1:8123/api/health
curl --fail http://127.0.0.1:8123/api/auth/setup-status
```

Record the generated project name privately and reuse it for lifecycle commands;
do not regenerate it to operate on existing state. Image tags are mutable and
base images/apt packages are not digest-pinned, so builds are lockfile-controlled
but not bit-for-bit reproducible. Retain the reviewed built image IDs/digests;
do not rebuild or pull new tags during a recovery rehearsal. The current defaults
do not auto-restart after host reboot: after stopping, the operator explicitly
starts the same project. Port conflicts must stop deployment, not trigger a
wildcard bind or changes to another service.

`up --wait` and `/api/health` establish process liveness only. Before acceptance,
verify one app ID (`dc ps --quiet app`), private TLS, synthetic login, current role,
authenticated read/write, file read, DB/WAL integrity and committed WS events.
Use the browser checklist below; do not print login/refresh responses in shell.

Read `STAGING_ADMIN_PASSWORD` privately in a trusted editor/password manager;
log in as Admin. Never print the environment, `docker inspect` environment,
`docker compose config`, tokens, subscription keys or login response into CI logs.
The generator exclusively creates a new file and does not print credentials.
Unix modes are 0600; on Windows enforce a user-only ACL separately.

Provisioning exclusively creates **only** `/app/data/chorequest.db` in this
project's new volume, runs `prisma migrate deploy` then `migrate status`, and
refuses an existing file. Do not rerun it on a populated volume, delete a database
to bypass the refusal, or use it for legacy data. Failed provisioning leaves its
isolated file for inspection. App startup neither creates nor migrates a schema.
The absolute `file:/app/data/chorequest.db` URL avoids Prisma's schema-relative
path interpretation. Existing legacy preparation remains in `../prisma/README.md`.

Environment names: required `STAGING_SECRET_KEY`, `STAGING_ADMIN_PASSWORD`;
optional `STAGING_PORT` (8123), `STAGING_COOKIE_SECURE` (false for loopback HTTP),
`STAGING_CORS_ORIGINS` (empty), `STAGING_TZ` (UTC), `STAGING_RESET_HOUR` (0 UTC),
`STAGING_VAPID_CONTACT` (set a real operator contact before provider acceptance).
They map to `SECRET_KEY`, `INITIAL_ADMIN_PASSWORD`, `COOKIE_SECURE`, `CORS_ORIGINS`,
`TZ`, `DAILY_RESET_HOUR`, `VAPID_CLAIM_EMAIL`. Default username/display name are
Admin/Administrator. Token lifetime defaults remain 15 minutes / 30 days.
The runtime also supports paired `VAPID_PRIVATE_KEY`/`VAPID_PUBLIC_KEY`; staging
defaults generate and retain their own database-backed pair, never production's.

Two project-scoped named volumes contain the DB and uploads. No bind mounts,
external proxy network, fixed container names, public bind or production volume
is used. A standard bridge named `<project>_staging` is created for this project;
it is neither external nor connected to the production proxy. The previous
internal-only bridge could accept a publish request without a live host mapping
(see the Phase 6.3 investigation in `../PHASE6-CI-FIX.md`).

**Outbound connectivity is now possible. Staging is not egress-blocked.**
Loopback-only inbound publishing does not restrict outbound traffic. Automated
smoke workflows create no real push subscriptions and perform no real provider
delivery. Compiled push probes use an injected mock sender and a separate
disposable database; application endpoint validation remains enabled. Do not put
real subscriptions or production credentials into staging. Runtime
uses UID/GID 1000, read-only root filesystem, writable DB/upload volumes and
bounded temporary storage, no added capabilities. Do not solve permission errors
with `chmod 777` or root runtime. New volumes inherit image directory ownership;
for operator-supplied restored state, provision UID/GID 1000 ownership privately.

If strict no-egress checks are required, use a separate disposable project with
an operator-reviewed `internal: true` network and published ports removed, and
run assertions **inside** that network/container (or use `network_mode: none`
for entirely local probes). That mode does not provide host-published HTTP/WS
acceptance. It is a separate proposed test mode, not part of this runbook's
standard bridge deployment or a reason to skip host reachability tests. No extra
mode, firewall rule, or network has been installed by these changes.

```bash
# Stop/restart without deleting data (run from repository root).
dc stop -t 75 app
dc up -d --wait --wait-timeout 120 --scale app=1 app
# Stop and remove containers/network while KEEPING DB/uploads:
dc down --timeout 75
```

Back up and restore using [`staging-state-recovery.md`](staging-state-recovery.md).
Never run the provisioner against restored/existing state. No reset or retry loop
is a recovery procedure. A failed provision/migration retains the isolated state
for inspection and stops this procedure.

Only after independent confirmation that the selected project is disposable,
its recovery copy is verified, and any dedicated staging proxy is stopped and
disconnected, may the operator delete its volumes. Production project selection
is forbidden. Recheck exact Compose project ownership labels on **both** volumes
and all selected containers; reject any foreign/external volume or container.
In the same shell retaining the reviewed `dc`, project and env selections:

```bash
case "$staging_project" in chorequest-phase7-*) ;; *) exit 1 ;; esac
test "$staging_project" != chorequest-node-staging
read -r -p 'Type the full disposable project name to DELETE ITS DATA: ' confirmation
test "$confirmation" = "$staging_project"
# Destructive, explicitly selected staging resources only; never prune.
dc down --volumes --timeout 75
```

## Proxy / HTTPS acceptance (documentation only)

Follow [`staging-https-acceptance.md`](staging-https-acceptance.md) for topology,
DNS-01, NPM logging/TLS configuration and the recorded browser/push checklist.
The notes here describe the application contract; they do not authorize changes
to an existing proxy or constitute acceptance evidence.

An operator may later approve a private TLS staging host in Nginx Proxy Manager.
Keep this Compose project off the production proxy network by default. A proxy
in another container cannot use its own `127.0.0.1` to reach this loopback port;
an explicit isolated network/topology change and TLS certificate are prerequisites
for that acceptance step, not changes automated by this runbook. Do not publish
the backend or relax its bind/origin policy just to make a proxy reach it.

Use the same HTTPS host for React, `/api/` and `/ws/`. NPM: enable Websockets
Support, TLS, Force SSL, and an upstream timeout longer than the 30s heartbeat
(e.g. 90s). Equivalent upstream location settings:

```nginx
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_read_timeout 90s;
proxy_send_timeout 90s;
```

Use restricted access logs that omit query strings, Authorization, cookies and
Sec-WebSocket-Protocol: legacy query-token connections remain compatible but
can leak through default `$request` logging. Browser clients now send bearer
credentials in a subprotocol. Never log that handshake header. Preserve Origin
and host; set `COOKIE_SECURE=true` for HTTPS and explicit allowed origins for a
separate frontend origin. Empty CORS means no foreign origins. Express does not
globally trust forwarded headers; rate limits see the immediate proxy address.
Do not blindly enable `trust proxy=true` to change this behavior.

Operator checklist: confirm wss handshake (only `chorequest` echoed), allowed and
rejected Origin, same-user multiple sessions, private events, reconnect/REST
resync after restart, expiry closure (4001), shutdown closure (1001), heartbeat
survival through proxy idle timeout. Logout stops the frontend socket; already
issued access JWTs remain valid until expiration (no new revocation guarantee).
Cloudflare forwarding/idle rules need separate acceptance; no DNS/tunnel changes
were performed. Local HTTP tests do not prove HTTPS cookie or wss behavior.

## Real browser push (operator approval required)

The staging bridge may already permit provider egress, subject to host firewall
policy. Real browser push acceptance requires explicitly approved, controlled
outbound HTTPS to the browser's supported provider plus a private HTTPS staging
host, valid VAPID identity and browser permission. Network capability alone is
not permission to send. After approval, log in as a synthetic
test parent, verify the service worker, request browser notification permission,
subscribe, verify `/api/push/status`, and trigger `/api/push/test` as that parent.
Confirm the correct device receives the payload and click opens the correct
route. Unsubscribe and verify no delivery; resubscribe, restart, verify unchanged
public VAPID key and delivery. Use a real VAPID contact and a fresh staging pair.
Never automatically enroll real devices or reuse production subscriptions.
Mocked provider success is not evidence of external browser delivery. Queue
delivery is bounded, at-least-once attempt semantics: four attempts / 24h, with
possible duplicates after provider success before acknowledgement, and possible
non-delivery after exhaustion. Shared devices can retain OS subscriptions after
logout; explicitly unsubscribe before changing users.

## Diagnostics

`/api/health` is process liveness, not proof of DB writes, push, scheduled work
or overall readiness. Check setup status plus authenticated reads/writes privately.
Missing/invalid/unprepared schema: stop and inspect deployment paths/schema;
do not auto-create, reset, or repair. Write/permission failure: check free space,
UID/GID 1000, directory write and WAL/SHM access. Startup reconciliation failure
prevents listening. Daily maintenance warning means its transaction/checkpoint
rolled back and will retry; inspect privately, avoid concurrent application writers.
Push worker warning means persisted jobs retry; provider rejection/retry-limit
warnings distinguish terminal removal. No tokens/payloads are included in those
messages. Repeated WS 401/403 means check JWT expiry, account activity and Origin;
WS rejects are intentionally not individually logged to avoid noisy/secret logs.
Graceful shutdown has a 60s deadline; Compose allows 75s. Timeout is a failure,
not a successful stop. Logs/private DB inspection may contain sensitive data;
never paste raw diagnostic output in public reports.
