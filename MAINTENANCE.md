# Shared gateway integration and maintenance

## Architecture and requirements

This guide is for the owners of MAD, HW, FDS, FOSS, KMS and WKMS and the team
operating the shared gateway. The gateway is a standalone TypeScript/Fastify
application, independent of the frameworks used by subsystem backends.
Each backend owns credential verification,
session/token issuance and validation, permissions, password policy and logout.
The gateway has no users, JWT keys, central Auth service or business database.
Authorization and configured cookies are opaque transport data.

There is no Redis service or response cache. Rate counters are local to the gateway
process and responses remain no-store. Any frontend offline cache belongs to its
subsystem.

The current integration contract uses independent subsystem login with cookie or
Authorization transport. Existing backends and frontends must be adapted by their
owners if they still depend on another authentication architecture. Enabling a
gateway route does not complete those changes.

| Owner | Responsibilities |
| --- | --- |
| Gateway team | Route destinations, cookie allowlists, CORS, limits, TLS and operational logs |
| Each backend team | Login, credential storage, session/token validation, roles, CSRF, logout and readiness |
| Each frontend/BFF team | Subsystem API paths, credentials, CSRF transport and session UI |

## Repository and ownership

| Path | Purpose |
| --- | --- |
| src/config.ts | Environment, prefix and cookie-name validation |
| src/app.ts | Forwarding, limits, CORS, health, logs |
| src/cookies.ts | Subsystem cookie filtering and response scope |
| src/http.ts | Canonical paths and bounded responses |
| src/errors.ts | Safe transport errors |
| src/server.ts | Startup and graceful shutdown |
| config/routes.json | Enabled routes and cookie names |
| test/gateway.test.ts | Isolated provider tests |
| compose.yaml | Local gateway only |
| compose.production.yaml | Gateway and Caddy HTTPS edge |
| deploy/Caddyfile | TLS and trusted forwarding headers |
| .github/workflows/ci.yml | CI after transfer to its own repository |

Copy the folder with dotfiles and lockfile. Exclude node_modules, .npm-cache, dist,
.test-build, coverage, logs and actual environment files. Do not copy the parent
repository's .git directory. The parent .gitignore currently ignores api-gateway;
the nested CI workflow becomes active only when copied to a repository root.

## Configuration

Configuration loads once at startup. Restart after environment or route changes.

| Variable | Default/example | Purpose |
| --- | --- | --- |
| NODE_ENV | development | Production requires HTTPS frontend origins |
| HOST / PORT | 127.0.0.1 / 8080 | Containers override host to 0.0.0.0 |
| LOG_LEVEL | info | fatal, error, warn, info, debug, silent |
| MAD_SERVICE_URL | http://localhost:4000 | MAD origin |
| HW_SERVICE_URL | http://localhost:4100 | HW origin |
| FDS_SERVICE_URL | http://localhost:4200 | FDS origin |
| FOSS_SERVICE_URL | http://localhost:4300 | FOSS origin |
| KMS_SERVICE_URL | http://localhost:4500 | KMS origin |
| WKMS_SERVICE_URL | http://localhost:4600 | WKMS origin |
| ALLOWED_ORIGINS | localhost ports 3000–3005 | Exact frontend origins; sample ports only |
| TRUSTED_PROXIES | Empty | Trusted immediate proxy IPs/CIDRs |
| RATE_LIMIT_MAX | 120 | Per-process client-IP request threshold |
| LOGIN_RATE_LIMIT_MAX | 10 | Lower threshold for paths ending /login |
| RATE_LIMIT_WINDOW_MS | 60000 | Rate window |
| BODY_LIMIT_BYTES | 1048576 | Buffered request limit |
| RESPONSE_LIMIT_BYTES | 10485760 | Buffered response limit |
| UPSTREAM_TIMEOUT_MS | 4000 | Request and response-reading deadline |
| HEALTH_TIMEOUT_MS | 2000 | Each backend readiness deadline |
| ROUTES_FILE | config/routes.json | Relative to gateway working directory |

All six routes are enabled, so all service URLs are required. Origins must be
HTTP(S), with no credentials, path, query or fragment. Existing .env files are
not modified automatically: copy new values from .env.example and remove
REDIS_URL and obsolete central-Auth/JWT variables.

Do not publish actual environment files or expanded Compose configuration.
There are no Redis deployment credentials or JWT signing keys to configure.

## Routing and service onboarding

Each route has id, enabled, prefix, rewritePrefix, upstreamEnv and optional
cookieNames (defaults to an empty array, meaning no cookie forwarding).
Obsolete roles, endpoints and readOnlyRoles are rejected.

A prefix matches itself or its slash-delimited descendants. The longest match
wins. General routes preserve `/<subsystem>/*`. The current configuration also
has a more specific `/mad/auth/*` to `/auth/*` mapping for that backend's path
layout; other teams can use the same pattern when needed.

Use these templates for a backend whose business paths include its prefix and
whose authentication paths start at `/auth`. Replace every placeholder before
adding entries to JSON; edit existing routes rather than duplicating them:

```json
[
  {
    "id": "<subsystem>-auth",
    "enabled": true,
    "prefix": "/<subsystem>/auth",
    "rewritePrefix": "/auth",
    "upstreamEnv": "<SUBSYSTEM>_SERVICE_URL",
    "cookieNames": ["<subsystem>_session", "<subsystem>_csrf"]
  },
  {
    "id": "<subsystem>",
    "enabled": true,
    "prefix": "/<subsystem>",
    "rewritePrefix": "/<subsystem>",
    "upstreamEnv": "<SUBSYSTEM>_SERVICE_URL",
    "cookieNames": ["<subsystem>_session", "<subsystem>_csrf"]
  }
]
```

Use lowercase `mad`, `hw`, `fds`, `foss`, `kms` or `wkms` for
`<subsystem>`, and its uppercase form for `<SUBSYSTEM>`. If authentication
already uses `/<subsystem>/auth` internally, the general route is enough.
Keep all routes for one subsystem below the same first path segment and
use consistent cookie allowlists for its login and business routes.

All supported methods under an enabled prefix reach the backend. Authentication,
role checks and internal endpoint protection belong to that backend. Query strings
are preserved; ambiguous/encoded paths, dot segments, backslashes and double
slashes are rejected. Destinations never come from caller-supplied URLs.

The finite-response proxy supports GET, HEAD, POST, PUT, PATCH and DELETE.
CORS handles OPTIONS. WebSocket, CONNECT, SSE and file streaming are unsupported.
Redirects other than 304 are rejected; writes are never automatically retried.

Every subsystem team should supply the following integration details:

| Contract item | Information to provide |
| --- | --- |
| Destination | Local and production backend origins and service owner |
| Routes | Public gateway prefix and actual backend authentication/business paths |
| Health | Implementation of `GET /health/ready` and its dependency checks |
| Login/session | Credential fields, response schema, session validation and expiry behavior |
| Authorization | Public operations and backend-enforced roles/object permissions |
| Cookies | Names, HttpOnly/SameSite settings, expiry and logout deletion |
| CSRF | Token acquisition, write validation and allowed frontend origins |
| Frontend/BFF | Direct browser or server-side API calls and credential forwarding |

All services are enabled in the supplied route file, but must be provided and
run independently. Confirm these contracts before connecting production traffic.

## Cookie contract

Default cookie allowlists:

| Subsystem | Names | Public cookie path |
| --- | --- | --- |
| MAD | mad_session, mad_csrf | /mad |
| HW | hw_session, hw_csrf | /hw |
| FDS | fds_session, fds_csrf | /fds |
| FOSS | foss_session, foss_csrf | /foss |
| KMS | kms_session, kms_csrf | /kms |
| WKMS | wkms_session, wkms_csrf | /wkms |

Backend owners should use these names or change cookieNames to their actual names.
An unlisted cookie is not forwarded in either direction. Names cannot overlap
between different subsystem path roots. Names are not renamed and values are not
decoded, validated, logged or stored by the gateway.

Request Cookie is filtered to the destination route's allowlist. Spoofed X-User-Id,
X-User-Role and X-Room-Number are still stripped; the backend obtains identity by
validating its own token/session.

Each allowed Set-Cookie response is forwarded separately, including on 4xx and
204 responses. Domain is removed so the browser stores it on the public gateway
host. Path is normalized to `/<subsystem>`, including for logout. Login cookies
therefore cover both authentication and business requests for the same subsystem.

This intentionally standardizes all a subsystem's configured cookies to its
subsystem root; it does not preserve narrower upstream Path values. Session
cookies should be HttpOnly, and the backend chooses that flag. Secure is preserved
and added in production. SameSite is preserved or defaults to Lax. Expires,
Max-Age and deletion values are preserved. Backend 5xx responses are sanitized
before cookie forwarding, so logout should clear cookies with a successful or
appropriate 4xx response.

__Host-* cookie names cannot use a subsystem path because browsers require Path=/;
configuration rejects them. If using __Secure-* names, the backend must issue
Secure cookies even during development and use HTTPS.

Browser cookie Path is not a full security boundary. All approved frontends are
trusted applications on this shared gateway origin. The allowlists prevent
accidental cross-service cookie forwarding; they do not isolate compromised
same-origin applications. Strong browser isolation requires separate origins.

## Browser credentials and CSRF

Use fetch with credentials: 'include' for both login and authenticated calls.
The browser stores Set-Cookie and supplies Cookie; JavaScript cannot set those
headers directly. Credentialed CORS responds only to exact ALLOWED_ORIGINS;
wildcard origins are not supported.

Every supplied Origin must be allowed. POST/PUT/PATCH/DELETE carrying an allowed
subsystem cookie also require Origin; missing or null origins are rejected.
Server-side BFF calls using cookies must pass a verified frontend Origin.
Bearer-only calls can still omit Origin.

X-CSRF-Token is allowed in preflight and forwarded, along with Origin.
Subystems must implement and validate their CSRF-token contract and avoid
state changes on GET/HEAD. Login CSRF and cookie issuance remain part of each
subsystem's authentication design. CORS alone is not authentication or complete
CSRF protection.

For frontends and APIs on the same site, SameSite=Lax normally fits this setup.
Truly cross-site deployments need SameSite=None; Secure; browser third-party-cookie
policies may still block them. Prefer same-site HTTPS hosts. Frontend JavaScript
cannot read an HttpOnly session cookie or the Set-Cookie response header.
A CSRF token can be supplied by a backend JSON endpoint for the frontend to return.

For every frontend, configure a gateway origin and a subsystem prefix. Keep the
backend's endpoint and payload definitions in the subsystem's own API contract.
The gateway provides no universal username/password payload or session response.

For a BFF, choose the integration pattern that matches that subsystem:

| Pattern | Frontend/BFF responsibilities |
| --- | --- |
| Browser calls gateway directly | Use `credentials: 'include'` for cookies or send Authorization; use the subsystem prefix and approved Origin |
| BFF owns browser session | Keep its cookie at the frontend and forward the subsystem's API token in Authorization |
| BFF relays backend cookies | Forward only that subsystem's cookies, a verified Origin for writes and CSRF headers; relay each Set-Cookie separately |

If a BFF relays cookies, account for the browser-visible hostname and path as
well as the gateway path. For example, a frontend proxy at `/api/*` cannot
blindly relay `Path=/<subsystem>` cookies and expect the browser to return
them to `/api/*`. Its cookie scope and CSRF handling must match its public
routes. This adaptation belongs to the BFF, independently for each subsystem.

Do not forward every cookie received by a frontend server. Cookie-based writes
must carry the user's verified allowed Origin; a BFF should not manufacture
an approved Origin for requests from untrusted callers.

Cookie reference: [MDN Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie).
CSRF reference: [OWASP prevention guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

## Rate limits and deployment

Rate counters now live in each gateway process. They reset on restart and are not
shared between replicas. Login and other requests share an IP counter with the
lower threshold applied to login URLs. Health checks also consume the IP quota.
Account-specific abuse protection stays in each backend. If scaling to multiple
gateway processes, design a separate global throttling policy before treating
these counters as a cluster-wide limit.

Local Compose runs only the gateway and reaches all six host backends using
host.docker.internal. Edit its environment overrides if ports differ or the
backends run on a Docker network. No subsystem is started by this Compose file.

Production uses compose.production.yaml as a standalone file, with
.env.production containing HTTPS origins, all internal service origins,
GATEWAY_DOMAIN, ACME_EMAIL and an immutable GATEWAY_IMAGE tag/digest.

```powershell
docker network create forever-hotel-internal
# Attach all six backends to this network with distinct aliases.
docker build -t your-registry/forever-gateway:0.1.0 .
docker push your-registry/forever-gateway:0.1.0
docker compose --env-file .env.production -f compose.production.yaml up -d
```

Caddy exposes 80/443; gateway 8080 and subsystem ports stay private.
Preserve Caddy certificate volumes. The template trusts only Caddy's
172.30.80.2/32 address; change its address and TRUSTED_PROXIES together if needed.
Do not trust arbitrary caller X-Forwarded-For. A BFF may aggregate users into one
visible IP, so tune quotas or establish trusted address forwarding.

When upgrading an existing deployment that ran Redis, inspect the old Compose
service/container and retire only that gateway-owned Redis container after
confirming no other application uses it. Source changes do not delete running
containers, volumes or unrelated Redis deployments automatically.

Align Caddy request limits with gateway limits and coordinate timeout budgets.
Pin reviewed container image digests. SIGINT/SIGTERM allow graceful close with
a ten-second forced deadline; the production example grants fifteen seconds.

## Monitoring and recovery

/health/live reports process availability. /health/ready probes each distinct
enabled upstream. With all six enabled, an absent backend makes readiness return
503. This is expected until all backends are running; successful routes remain
independently callable. Probes do not prove login correctness.

Access logs include request ID, route ID, method, status and duration.
They omit URLs, query strings, headers, cookies and bodies. Correlate the generated
X-Request-Id with subsystem logs; business audit trails remain upstream.

| Symptom | Check |
| --- | --- |
| Startup error | Missing service URL, invalid origin, cookie-name overlap, route schema |
| 401 | Backend session/token validation |
| 403 | Unapproved/missing Origin for cookie writes, backend CSRF or permissions |
| Cookie missing | credentials: include, cookieNames, Domain/Path, SameSite/Secure, browser policy |
| 404 | Prefix or backend path mismatch |
| 413 | Gateway/Caddy body limit |
| 429 | Local process IP quota, BFF/NAT traffic |
| 502 | Redirect or oversized response |
| 503 | Backend unavailable/5xx or failed readiness |
| 504 | Backend timeout |

Alert on sustained errors, latency, quota pressure and TLS renewal failures.
There is no Redis health dependency or gateway session store to recover.
Authentication incidents are handled by the relevant subsystem through session
revocation and key rotation.

## Maintenance and acceptance

Version routes, source, lockfile, configuration and image together. After changes,
run typecheck, lint, format:check, build and tests before release. Tests were
updated but not executed during this task. CI runs checks after transfer to
the separate repository; do not infer test success from a static build.

Before production, verify actual cookie login/logout with a browser, multiple
cookies, expiration, cross-subsystem filtering, CSRF denial, frontend integration,
all six readiness endpoints, trusted addresses, TLS and shutdown under load.
Fixture tests do not establish these deployment results.

Record acceptance independently for MAD, HW, FDS, FOSS, KMS and WKMS. Each
team should provide its environment, API version, login/logout and denial
results, cookie/CSRF results, readiness evidence and outstanding issues.
Acceptance of one subsystem does not establish compatibility for the others.

For rollback, restore an accepted image and compatible environment/routes.
Older images may require Redis or central Auth; do not mix their configurations.
Back up configuration versions and Caddy state. The gateway owns no database.
Do not delete planning documents, repositories or unrelated volumes during
maintenance.
