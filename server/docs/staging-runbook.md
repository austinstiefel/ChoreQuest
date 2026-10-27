# Isolated Node staging (opt-in)

No command here changes the Python Compose service, proxy, DNS or live database.
Use a Linux Docker host with Compose v2, Node 22 and pnpm 10.34.6. The image
contains one Node process; do not scale replicas or run two application writers.
The local Phase 6 authoring environment had no Docker Linux daemon. Container
steps below must pass before treating this as a validated deployment.

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

## Operator-controlled isolated instance

The following Linux shell commands use a new private directory outside Git.
Generate unique credentials; do not reuse the production signing key or accounts.

```bash
umask 077
mkdir "$HOME/chorequest-staging-private"
node server/scripts/create-staging-env.mjs "$HOME/chorequest-staging-private/staging.env"
staging_env="$HOME/chorequest-staging-private/staging.env"
docker compose --project-name chorequest-node-staging --env-file "$staging_env" -f server/compose.staging.yml build app provision
docker compose --project-name chorequest-node-staging --env-file "$staging_env" -f server/compose.staging.yml run --rm provision
docker compose --project-name chorequest-node-staging --env-file "$staging_env" -f server/compose.staging.yml up -d --wait app
curl --fail http://127.0.0.1:8123/api/health
curl --fail http://127.0.0.1:8123/api/auth/setup-status
```

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
is used. The internal network blocks provider egress intentionally. Runtime
uses UID/GID 1000, read-only root filesystem, writable DB/upload volumes and
bounded temporary storage, no added capabilities. Do not solve permission errors
with `chmod 777` or root runtime. New volumes inherit image directory ownership;
for operator-supplied restored state, provision UID/GID 1000 ownership privately.

```bash
# Stop/restart without deleting data (run from repository root).
docker compose --project-name chorequest-node-staging --env-file "$staging_env" -f server/compose.staging.yml stop -t 75 app
docker compose --project-name chorequest-node-staging --env-file "$staging_env" -f server/compose.staging.yml up -d --wait app
# REMOVE ONLY THIS DISPOSABLE PROJECT AND ITS DATA when finished:
docker compose --project-name chorequest-node-staging --env-file "$staging_env" -f server/compose.staging.yml down --volumes --timeout 75
```

## Proxy / HTTPS acceptance (documentation only)

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

The default internal network cannot send external push. Only after approving
isolated provider egress and a private HTTPS staging host: log in as a synthetic
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
