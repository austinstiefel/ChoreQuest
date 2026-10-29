# Private HTTPS/WSS and browser acceptance — operator-run, pending

No hostname, IP, certificate, NPM instance or DNS record is assumed to exist.
Examples below require operator selection. `staging.example.com` is a placeholder
for a name under an **actually owned public domain**, never an issuance target.
No instruction authorizes production proxy changes or public exposure.

## Choose the private route before deploying

Recommended for isolation: a **dedicated staging NPM**, with separate configuration
and certificate storage, restricted LAN/VPN ingress and private admin access.
The existing production NPM remains untouched. Do not deploy a second proxy on
an occupied host IP/port. If there is no unused approved private address, use a
separate staging proxy VM or defer deployment. No address is selected here.

### NPM and staging on the same Docker host

After approval and after the app project has created its bridge, create the
following **private file outside Git** for the new staging proxy. This is a
template, not an installed service. Select a reviewed, pinned NPM image digest
and an existing host-owned RFC1918 IPv4 address. Confirm 80/443 on that address
and the chosen loopback admin port are free. An address must be non-wildcard,
not a public IP, and reachable only on the approved LAN/VPN/firewall path.
Set the four required variables in a separate private env file (0600), not chat.

```yaml
services:
  proxy:
    image: ${STAGING_NPM_IMAGE:?Select a reviewed NPM image digest}
    ports:
      - "${PRIVATE_PROXY_IPV4:?Select an approved private host IP}:80:80"
      - "${PRIVATE_PROXY_IPV4:?Select an approved private host IP}:443:443"
      - "127.0.0.1:${NPM_ADMIN_PORT:?Select an unused admin port}:81"
    volumes:
      - proxy-data:/data
      - certificates:/etc/letsencrypt
    networks: [upstream]
networks:
  upstream:
    external: true
    name: ${STAGING_APP_PROJECT:?Select the new staging app project}_staging
volumes:
  proxy-data:
  certificates:
```

Use a unique `chorequest-phase7-proxy-*` project and explicit absolute env/Compose
paths with `docker compose --project-name ... --env-file ... -f ... config --quiet`,
then (only after approval) `up -d`. The externally referenced network is **only
the new staging project's bridge**, not an existing production network. Verify
its `com.docker.compose.project` label equals the selected staging app project
before starting the proxy. NPM upstream is `http`, hostname `app`, port `8122`.
The app's host mapping stays exactly 127.0.0.1:8123. Use an SSH local forward to
the host's chosen loopback admin port for NPM administration.

Only app and the dedicated proxy should be connected to the staging bridge.
NPM can contact app's plain HTTP inside that bridge and can inspect credentials
in transit; compromise of this proxy can compromise staging. No Docker socket,
app DB/uploads volumes, production mounts or production networks go into NPM.
NPM has its own upstream image privilege model; app hardening is unchanged.
Block unapproved LAN clients at the proxy/host firewall. DNS privacy alone is
not access control. Check actual LAN/VPN reachability and absence of WAN ingress.
Stop/remove the dedicated proxy before app project network cleanup. Retain its
certificates/configuration for renewal; do not delete them with app data cleanup.

Attaching a running production NPM to this network is an alternative requiring
separate approval and a reviewed change/reversal plan. It crosses the production
proxy isolation boundary and is **not** the recommended isolated rehearsal.

### NPM and staging on separate hosts/VMs

Container DNS/bridges do not span hosts. Do not point remote NPM at 127.0.0.1:8123
or replace the app bind with 0.0.0.0. Prefer moving **only the dedicated staging
proxy** to the app host if an approved private address is available. Otherwise,
an operator may approve a dedicated SSH tunnel from the staging proxy host to
the app host's loopback service, with a restricted forwarding-only SSH identity:

```bash
# Run on the staging proxy host. All uppercase values are operator-selected.
# FORWARD_IP must be an RFC1918 host address reachable by the staging NPM bridge;
# firewall its chosen port to that bridge only. No wildcard/public bind.
ssh -NT -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  -L "${FORWARD_IP:?}:${FORWARD_PORT:?}:127.0.0.1:8123" "${APP_SSH_DESTINATION:?}"
```

Pin/verify the app host key, restrict the dedicated SSH key to forwarding with
`permitopen="127.0.0.1:8123"` and no shell/agent/X11, and restrict tunnel ingress
to the staging proxy. On NPM use that private forward IP/port as HTTP upstream.
Manage tunnel supervision/restart explicitly; failure must produce 502, never
direct/public fallback. The link between hosts is encrypted; proxy-to-forwarder
traffic remains private HTTP. Exact IP/firewall/SSH service configuration depends
on the operator's topology and is a deployment gate, not an assumed installed
adapter. Do not alter the existing production NPM to provide this route.

## DNS and trusted certificate checklist

- [ ] Obtain approval for a staging name under the owned Cloudflare-managed
  domain. Internal DNS resolves it **only** to the selected private proxy address.
  Check all test clients/VPNs and IPv4/IPv6; no public A/AAAA pointing to staging,
  router forwarding, Cloudflare proxy/tunnel or alternate insecure hostname.
- [ ] In the dedicated NPM SSL Certificates UI, request the selected name with
  Let's Encrypt **DNS challenge**, Cloudflare provider. Keep DNS credentials in
  NPM's protected storage, never in the app env, source, reports or diagnostics.
  Use a token scoped to the needed zone and DNS editing, with only additional
  read permissions actually required by the installed provider. Avoid a global
  API key. Review the provider's displayed credential format/version privately.
- [ ] DNS-01 validates a publicly resolvable `_acme-challenge` TXT record, so the
  web app need not be public. It cannot issue for an invented `.local` name.
  Certificate Transparency exposes issued certificate names even when the app
  is private. A Cloudflare Origin CA certificate alone is not browser-trusted.
- [ ] Allow only the needed DNS API/ACME outbound connectivity from the dedicated
  NPM. Its `/data` and `/etc/letsencrypt` volumes persist credentials, renewal state
  and private keys. Protect/backup them separately from app state. Do not mount
  them in Node. Terminate TLS in NPM; Node needs no certificate/private key.
- [ ] Check full chain, hostname, validity and browser trust without bypasses.
  Verify automatic renewal, token validity, DNS propagation and certificate reload
  using the installed NPM's supported renewal controls. Record expiry/renewal
  evidence privately; repeated issuance to fix configuration can hit CA limits.
  Losing proxy volumes or moving containers without their renewal state breaks
  continuity even when the app DB is intact.

Basis: [NPM Docker networks/custom includes](https://nginxproxymanager.com/advanced-config/),
[Let's Encrypt DNS-01](https://letsencrypt.org/docs/challenge-types/#dns-01-challenge),
[Cloudflare Certbot token guidance](https://certbot-dns-cloudflare.readthedocs.io/en/stable/).

## Exact NPM proxy-host checklist

1. Create a **staging-only** Proxy Host for the approved name. HTTP upstream is
   `app:8122` on the same-host template, or the approved private tunnel endpoint
   for separate hosts. Do not rewrite paths: `/`, `/api/`, `/ws/` use one origin.
   Enable Websockets Support. Do not enable asset/API caching.
2. Select the trusted staging certificate; enable Force SSL. Test an anonymous
   HTTP request redirects to HTTPS before any login. Never send credentials to
   HTTP. Do not enable parent-domain HSTS/preload as part of this rehearsal.
   The app already sends one-year includeSubDomains HSTS when Secure cookies are
   configured; choose a dedicated staging hostname and understand that scope.
3. Preserve `Host` (including port if not standard 443), `Origin`, Upgrade and
   Connection. Review the actual generated config; the upstream must see the
   browser host to accept same-origin WS with empty CORS. Set read/send timeouts
   to 90s (heartbeat is 30s) in this proxy host's Advanced settings:

   ```nginx
   proxy_read_timeout 90s;
   proxy_send_timeout 90s;
   ```

   Websockets Support should supply HTTP/1.1 and Upgrade/Connection. Confirm in
   the generated **location**; if the installed NPM version does not preserve
   the original Host, use its supported custom-location/include configuration
   to set `proxy_set_header Host $http_host;` in that location. Do not duplicate
   Host or Upgrade directives blindly or replace all of NPM's generated config.
4. Before any credentials, make access logging safe. Default `$request` includes
   query strings, and legacy WS query tokens remain accepted. Never log
   Authorization, Cookie, Set-Cookie or Sec-WebSocket-Protocol. For the dedicated
   proxy, the supported `/data/nginx/custom/http_top.conf` include may define:

   ```nginx
   log_format staging_safe '$request_method $uri $status';
   ```

   Configure the staging server **and its effective location** to use only
   `access_log /data/logs/staging-safe.log staging_safe;` (or disable all access
   logs for that host). NPM versions generate their own location log directives;
   a server-level directive alone may not override these. Inspect the staging
   server/location via `nginx -T` **privately**; remove/override unsafe inherited
   logs using the installed NPM's supported configuration, then `nginx -t` and
   reload only the dedicated proxy. If this cannot be established, stop before
   login. Do not modify production templates to achieve this.
5. Keep Nginx error logging at a restrictive level (e.g. `crit`) for the staging
   host: ordinary upstream errors can include raw request lines and legacy query
   tokens. No debug/header/request-body logging, analytics or packet capture.
   Configure log rotation/retention. Never publish raw `nginx -T`, NPM DB/config,
   request dumps, HAR exports or browser storage; these can contain secrets.
6. Use a deliberately invalid **non-secret marker** in a legacy query and a
   failed upstream request before login; inspect every effective staging access/
   error log privately for query/header leakage. During later synthetic account
   testing, inspect for accidental token/cookie/subprotocol retention privately
   without copying values into the acceptance record. Record pass/fail only.
7. Set app `STAGING_COOKIE_SECURE=true` before authenticated use. Keep
   `STAGING_CORS_ORIGINS` empty for same-origin deployment. If a separate frontend
   is actually required, list only its exact HTTPS origin; no wildcard. Preserve
   Origin checks and Express's current untrusted forwarded-header behavior.
   Rate limits see the immediate proxy IP (shared budget); do not turn on broad
   `trust proxy` to bypass this. Avoid extra NPM Basic Auth/access-list behavior
   that could consume or replace the application's Bearer Authorization header.

## Record actual HTTPS/WSS browser acceptance

Record checkout/image IDs, private test date/browser/proxy versions and pass/fail
privately, no credentials or family data. Each unchecked item remains pending.

- [ ] Fresh Admin login, first-run completion, create synthetic parent/kid, login
  each. Parent/kid cannot manage users/API keys/invites/audit; parent retains
  intended family-management access. Current DB role changes take effect.
- [ ] Browser trusts the cert and uses only HTTPS assets/API and WSS. DevTools
  shows refresh cookie Secure, HttpOnly, SameSite=Lax, path `/api/auth`; refresh
  rotates it. No mixed content, insecure fallback or API response caching.
- [ ] `/ws/{own_id}` handshake 101 with allowed same Origin; only `chorequest`
  echoed. Invalid/expired/identity-mismatched tokens reject 401; foreign Origin
  rejects 403. Use synthetic accounts and a private diagnostic client for headers
  browsers cannot override; never put a live token into shell history.
- [ ] Two sessions for one kid both receive their own verification/points events;
  another kid receives no private events. Complete/verify a synthetic chore via
  parent/kid UI; verify balances, histories and notifications with REST as well.
- [ ] Keep the tab idle through at least two 90s timeout windows; heartbeat keeps
  WSS live. Expired credentials close 4001 and refresh/reconnect or return to
  login. Do not shorten a live deployment's token lifetime just for testing.
- [ ] Restart the selected app gracefully. Observe 1001 shutdown (not forced
  timeout), reconnect/backoff and REST resynchronization of events missed while
  disconnected. Confirm no duplicate awards/scheduler effects and persisted data.
- [ ] Logout closes the frontend socket, clears local access token and revokes
  the supplied refresh token. Previously issued access JWTs remain valid until
  expiry; this is existing behavior, not immediate global session revocation.
- [ ] Confirm actual NPM logs remain credential-free. A passing Node TLS fixture
  does not establish any of these browser/NPM/operator results.

## Real browser push — separate explicit approval required

Network capability does not authorize enrollment or delivery. Use one designated
test browser/device, a synthetic parent, a fresh staging VAPID pair and a real
operator contact. No production keys/subscriptions or automatic external probe.

1. Open the approved private HTTPS host; confirm `window.isSecureContext`, browser
   push support and `/sw.js` registration/scope `/`. Wait for active controller;
   handle the existing update prompt. iOS may require installed standalone PWA.
2. Intentionally grant notifications in the UI; deny/no-permission must not enroll
   a device. Subscribe, then inspect `/api/push/status` privately. Its status is
   account-wide, so also verify the browser's own PushManager subscription. Never
   export its endpoint/auth/p256dh. These are confidential delivery credentials.
3. Record only a digest of the public VAPID key (not private material). Keys live
   in app_settings unless explicitly overridden as a pair; do not reset/rekey.
   `STAGING_VAPID_CONTACT` must be configured before sending. Provider HTTPS
   allowlist, endpoint validation, timeouts and bounded retries stay enabled.
4. With **specific approval to send**, use the synthetic parent's existing test
   action (`POST /api/push/test`) once. Verify honest sent/total response, intended
   device notification, title/body and click route on the correct staging origin.
   No bulk/family notifications. Test action is parent/admin only.
5. Restart app with retained DB; verify unchanged public-key digest and subscription
   status. Approve a second controlled delivery after restart to prove recovery.
   Durable jobs have four attempts/24h, 30/60/120s backoff, bounded lease/network
   timeouts; provider success is not proof of browser display. Delivery can
   duplicate after provider acceptance before local acknowledgement.
6. Unsubscribe in the UI and verify browser subscription plus backend removal.
   Only if separately approved, trigger the test action and confirm no delivery
   to that device (other test devices must be absent). 404/410 expires subscriptions;
   terminal/transient failures must not disclose endpoints or payloads in logs.
7. Explicitly unsubscribe **before** changing users on a shared device; logout
   alone does not remove the OS subscription. Revoke test permission/clean up
   only synthetic staging enrollment when finished. Record real provider/device
   results separately from mocked push coverage, leaving unavailable items pending.
