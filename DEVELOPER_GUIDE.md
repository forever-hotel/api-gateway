# Shared API gateway: developer handoff

This guide applies to MAD, HW, FDS, FOSS, KMS and WKMS. The gateway is a standalone
Fastify application written in TypeScript, not a NestJS application. Subsystem
backends can use NestJS or another HTTP framework.

## What it does

The gateway selects a configured backend by the request's path prefix, optionally
rewrites that prefix, and forwards the method, query string and body.
It supplies CORS handling, process-local IP rate limits, request IDs, bounded
request/response bodies, timeouts and readiness endpoints.

It does not store users, issue JWTs, validate JWTs, check roles or contact a
central Auth service. Each backend implements its own login, session/token
validation, permissions, password policy and logout. There is no Redis or API
response cache. Rate counters reset on restart and are not shared across replicas.

## Files to give another developer

Copy this gateway directory, including dotfiles, package.json, package-lock.json,
src, config, deploy, Dockerfile, Compose files and the documentation.
Exclude node_modules, dist, .test-build, coverage, .npm-cache, logs and real .env
files. Do not copy the manager dashboard's .git directory.

The gateway has no source-code imports from the dashboard. It can be placed at
the root of its own repository. Its .github workflow then becomes that
repository's CI workflow. The manager repository currently ignores this directory,
so a dashboard clone alone does not supply the gateway code.

## Default routing

| Subsystem | Environment variable | Example backend port | Public prefix | Cookie names |
| --- | --- | --- | --- | --- |
| MAD | MAD_SERVICE_URL | 4000 | /mad | mad_session, mad_csrf |
| HW | HW_SERVICE_URL | 4100 | /hw | hw_session, hw_csrf |
| FDS | FDS_SERVICE_URL | 4200 | /fds | fds_session, fds_csrf |
| FOSS | FOSS_SERVICE_URL | 4300 | /foss | foss_session, foss_csrf |
| KMS | KMS_SERVICE_URL | 4500 | /kms | kms_session, kms_csrf |
| WKMS | WKMS_SERVICE_URL | 4600 | /wkms | wkms_session, wkms_csrf |

All six are enabled in config/routes.json. Ports are examples; replace them
with each team's actual service addresses. General routes preserve their prefix.
MAD also has a more specific /mad/auth mapping to backend /auth.
There is no shared root /auth or /identity endpoint.

The longest matching prefix wins. /fds matches /fds and /fds/... but not /fds-other.
The gateway rejects ambiguous encoded paths and dot segments. Query strings retain
their encoding. Backend URLs are fixed configuration, never caller-supplied targets.

## Configure your subsystem

1. Obtain the backend origin, actual endpoint paths and frontend origins from its owner.
2. Set its *_SERVICE_URL. Use an origin only, without credentials, a path, query or fragment.
3. Adjust prefix/rewritePrefix in config/routes.json to match its paths.
4. Match cookieNames to the backend's cookies, if it uses cookies. Names must be
   unique across different subsystem roots.
5. Add the frontend's exact scheme, hostname and port to ALLOWED_ORIGINS.
6. Implement GET /health/ready in the backend and protect private endpoints there.
7. Restart the gateway after route or environment changes.

A backend that serves /fds/... needs the normal /fds mapping.
If it instead serves auth endpoints at /auth/..., add this more specific route
alongside its existing general route:

```json
{
  "id": "fds-auth",
  "enabled": true,
  "prefix": "/fds/auth",
  "rewritePrefix": "/auth",
  "upstreamEnv": "FDS_SERVICE_URL",
  "cookieNames": ["fds_session", "fds_csrf"]
}
```

Use the same pattern for any subsystem, substituting its prefix, service variable
and cookie names. This does not create login endpoints in the backend.

When developing only one subsystem, use a separate local route file with its
routes enabled and point ROUTES_FILE at that file. Disabled routes require no
backend URL and return 404. Do not replace the shared defaults for every team
merely to customize one developer's environment.

## Run with Node.js

Use Node 22.14.x and npm 10+. From the gateway root:

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm ci --ignore-scripts
npm run dev
```

Edit .env before starting: set the service origins for all enabled routes and
the allowed frontend origins. The template uses backend ports 4000, 4100, 4200,
4300, 4500 and 4600, and frontend ports 3000 through 3005.
Those frontend port assignments are examples, not required subsystem conventions.

The default listener is http://localhost:8080. No JWT secret, database or
central Auth URL belongs in the gateway environment.

For a compiled run:

```powershell
npm run build
npm start
```

## Run with Docker

From the gateway root, after creating .env:

```powershell
docker compose up --build -d
docker compose logs -f gateway
docker compose ps
docker compose down
```

This standalone Compose file starts only the gateway. Its environment overrides
all six service URLs to host.docker.internal with the example ports, so backends
are expected on the host. Edit those Compose overrides if using different ports
or Docker-network aliases; changing only .env will not override those entries.
The file provides the host-gateway mapping for Linux.

Inside a container, localhost refers to that container, not the host or another
service. When backend and gateway share a Docker network, use the backend's
network alias, for example http://fds-backend:4200.

The manager repository has a separate root Compose stack that starts its frontend,
backend, database and this gateway together. It mounts a MAD-only local route file
and uses internal Docker service names. Do not start both stacks on the same port.

## Cookies, tokens and frontend calls

Authorization headers pass unchanged to the selected backend. Missing or malformed
tokens are not rejected by the gateway; the backend must reject them where needed.
The gateway never generates trusted user/role headers from caller input.

For cookies, only names in the selected route's cookieNames list pass upstream.
Only those names may be forwarded back in Set-Cookie. Multiple Set-Cookie headers
remain separate, including expiry commas. The gateway removes Domain and sets
Path to the subsystem root, such as /fds, for both login and logout cookies.
HttpOnly and expiry/deletion attributes are preserved. SameSite defaults to Lax
when absent; production adds Secure. Backends should mark session cookies HttpOnly.
Names starting __Host- are rejected because their required Path=/ conflicts
with subsystem path scoping.

Browser clients using cookie authentication must set credentials: 'include'
on both login and subsequent API requests. Configure their exact Origin in
ALLOWED_ORIGINS. The browser supplies Cookie and handles Set-Cookie automatically.
The gateway does not dictate login fields or response schemas.

```javascript
function subsystemClient(gatewayOrigin, subsystem) {
  return (path, options = {}) =>
    fetch(gatewayOrigin + '/' + subsystem + path, {
      ...options,
      credentials: 'include',
    });
}
// Select mad, hw, fds, foss, kms or wkms and use that backend's API contract.
```

Unapproved Origins are rejected. Cookie-authenticated POST/PUT/PATCH/DELETE
requests also require Origin. X-CSRF-Token and Origin are forwarded; each backend
validates its own CSRF tokens. Do not change state through GET/HEAD.
For truly cross-site cookies, the backend must use SameSite=None; Secure, and
browser third-party-cookie policies may still prevent the flow.

For a frontend BFF, either keep the browser cookie at the BFF and forward a
bearer token, or explicitly relay your subsystem's cookies. A cookie-relaying
BFF must forward a verified allowed Origin for writes and adapt cookie paths
to its browser-visible routes. A /fds cookie will not accompany a request to
/api merely because the BFF forwards that request to /fds internally.

Separate cookies do not provide single sign-on. All approved frontends must be
trusted: cookie paths are not strong isolation between compromised applications
on a shared browser origin.

## Configuration reference

| Setting | Default/example | Purpose |
| --- | --- | --- |
| HOST / PORT | 127.0.0.1 / 8080 | Listener; containers set HOST=0.0.0.0 |
| NODE_ENV | development | Production requires HTTPS allowed origins |
| LOG_LEVEL | info | Structured operational logging |
| *_SERVICE_URL | See route table | Required for enabled route destinations |
| ALLOWED_ORIGINS | Exact frontend origins | Comma-separated; no wildcard |
| ROUTES_FILE | config/routes.json | Relative to working directory unless absolute |
| TRUSTED_PROXIES | Empty | Explicit trusted proxy IPs/CIDRs |
| RATE_LIMIT_MAX | 120 | Per-process client-IP window threshold |
| LOGIN_RATE_LIMIT_MAX | 10 | Lower threshold for paths ending /login |
| RATE_LIMIT_WINDOW_MS | 60000 | Rate window duration |
| BODY_LIMIT_BYTES | 1048576 | Buffered request limit |
| RESPONSE_LIMIT_BYTES | 10485760 | Buffered response limit |
| UPSTREAM_TIMEOUT_MS | 4000 | Request/response-reading deadline |
| HEALTH_TIMEOUT_MS | 2000 | Readiness probe deadline per backend |

Login, other requests and health probes share IP counters. A BFF may present one
IP for many users. Account-level login protection still belongs in each backend.
Do not treat these process-local counters as a shared multi-replica quota.

## Health, errors and scope

GET /health/live reports gateway process availability.
GET /health/ready probes /health/ready on every distinct enabled upstream.
An unavailable enabled service makes aggregate readiness return 503; other
healthy routes can still forward independently.

Backend 4xx responses, including auth errors, pass through. Backend 5xx responses
are sanitized to 503. Timeouts become 504; oversized responses and unsupported
redirects become 502. Requests are not automatically retried.
Responses are no-store. Access logs contain request ID, route, method, status
and duration; they omit raw cookies, tokens and credentials.

This gateway handles bounded REST responses. WebSocket, CONNECT, SSE, streaming
downloads and browser OAuth redirects need separate support.
It does not host the subsystem frontends.

## Maintenance and acceptance

Commit source, package-lock.json, routes and compatible configuration together.
Keep real .env files out of Git. Review route changes with the backend owner.
Rebuild Docker images for source/default-route changes; restart after mounted
route-file changes and recreate containers for environment changes.

Maintainer checks:

```powershell
npm run typecheck
npm run lint
npm run format:check
npm run build
npm test
npm run test:cov
```

These are commands for the receiving developer; tests were not run during this
handoff work. Verify real login/logout, cookie scope, authorization/CSRF denial,
backend outages, health and limits for each connected subsystem. Fixture tests
alone do not establish the other repositories' compatibility.

For production TLS and operating details, read MAINTENANCE.md and review
compose.production.yaml. The local Compose examples are not production deployment
instructions.
