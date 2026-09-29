# Gateway maintenance report

## Architecture and ownership

This implementation follows the decision to give all six subsystems their own
login mechanisms. It supersedes the earlier gateway JWT/central-Auth design.
MAD, HW, FDS, FOSS, KMS and WKMS each own credential verification, token issuance,
token/session validation, password policy, roles, authorization and revocation.

The gateway has no user database, signing keys, roles or central Auth dependency.
It forwards Authorization as an opaque header. Missing or malformed credentials
also reach the backend, which must reject them where authentication is required.
A successful gateway route match conveys no permission.

Each service must validate its own tokens and scope access to its own data.
Do not make unrelated services accept a token merely because it arrived through
the gateway. Cross-service access, shared identities, SSO and global logout require
separate contracts and are not implemented here.

The current MAD backend still depends on central Auth. Implementing local MAD
authentication and adapting its frontend BFF are subsequent tasks. The gateway
can route its endpoints now, but cannot replace that missing backend behavior.

## Repository layout and transfer

| Path                     | Purpose                                            |
| ------------------------ | -------------------------------------------------- |
| src/config.ts            | Validate environment and route destinations        |
| src/app.ts               | Forward requests, limits, CORS, health and logging |
| src/http.ts              | Canonical paths and bounded response reader        |
| src/errors.ts            | Transport errors                                   |
| src/server.ts            | Startup and graceful shutdown                      |
| config/routes.json       | Static prefix mappings                             |
| test/gateway.test.ts     | Isolated provider tests                            |
| compose.yaml             | Local gateway and Redis                            |
| compose.production.yaml  | Production gateway, Redis and Caddy edge           |
| deploy/Caddyfile         | HTTPS and forwarding headers                       |
| .github/workflows/ci.yml | CI when this folder becomes a repository root      |

Copy the complete folder including dotfiles, package-lock.json and route
configuration into the separate repository. Exclude node_modules, .npm-cache,
dist, .test-build, coverage, logs and actual .env files. Keep secrets separately.
Do not copy the parent repository's .git directory.

The parent .gitignore currently ignores api-gateway. Changes here are local
until you copy them into the gateway repository and commit them there.
The nested GitHub workflow also only becomes active in that repository.

From its new root, install with npm ci --ignore-scripts. Run typecheck, lint,
format:check and build, then the tests yourself before a release. Commit source
and lockfile together using the destination repository's commit rules.

## Configuration

Configuration loads once at startup. Restart after modifying environment variables
or routes. The .env.example file contains the current template.

| Variable             | Default/example       | Purpose                                       |
| -------------------- | --------------------- | --------------------------------------------- |
| NODE_ENV             | development           | Production requires HTTPS origins and Redis   |
| HOST / PORT          | 127.0.0.1 / 8080      | Listener; containers override HOST to 0.0.0.0 |
| LOG_LEVEL            | info                  | fatal, error, warn, info, debug or silent     |
| MAD_SERVICE_URL      | http://localhost:4000 | MAD backend origin                            |
| HW_SERVICE_URL       | http://localhost:4100 | Required only when HW is enabled              |
| FDS_SERVICE_URL      | http://localhost:4200 | Required only when FDS is enabled             |
| FOSS_SERVICE_URL     | http://localhost:4300 | Required only when FOSS is enabled            |
| KMS_SERVICE_URL      | http://localhost:4500 | Required only when KMS is enabled             |
| WKMS_SERVICE_URL     | http://localhost:4600 | Required only when WKMS is enabled            |
| ALLOWED_ORIGINS      | http://localhost:3000 | Comma-separated exact browser origins         |
| TRUSTED_PROXIES      | Empty                 | Trusted immediate proxy IPs/CIDRs             |
| REDIS_URL            | Empty locally         | Shared rate counters; required in production  |
| RATE_LIMIT_MAX       | 120                   | Requests per client-IP window                 |
| LOGIN_RATE_LIMIT_MAX | 10                    | Threshold for paths ending /login             |
| RATE_LIMIT_WINDOW_MS | 60000                 | IP quota window                               |
| BODY_LIMIT_BYTES     | 1048576               | Buffered request limit                        |
| RESPONSE_LIMIT_BYTES | 10485760              | Buffered response limit                       |
| UPSTREAM_TIMEOUT_MS  | 4000                  | Backend request plus body-reading deadline    |
| HEALTH_TIMEOUT_MS    | 2000                  | Deadline for each readiness probe             |
| ROUTES_FILE          | config/routes.json    | Route file relative to working directory      |

Origins must be HTTP(S) without credentials, paths, queries or fragments. Use
rewritePrefix for path changes. Disabled routes do not require their service URL.
Never dump runtime environment or expanded Compose configuration into public logs.

Remove obsolete JWT_SECRET, JWT_ISSUER, AUTH_SERVICE_URL, AUTH_API_URL and
IDENTITY_SERVICE_URL from the gateway's private deployment configuration.
Replace AUTH_TIMEOUT_MS with HEALTH_TIMEOUT_MS. Gateway deployments no longer
need access to any subsystem's JWT keys.

## Routing contract

Each route has exactly id, enabled, prefix, rewritePrefix and upstreamEnv.
Obsolete roles, readOnlyRoles and endpoints fields fail configuration validation
instead of silently suggesting enforcement that no longer exists.

A prefix matches itself or prefix followed by a slash. /madness does not match
/mad. More specific prefixes take precedence regardless of file order:
/mad/auth/session maps to MAD /auth/session, while /mad/analytics/bookings
maps to MAD /mad/analytics/bookings. Duplicate enabled prefixes/IDs are rejected.
Health prefixes are reserved for the gateway.

Query strings retain their encoding. Encoded paths, double slashes, backslashes
and dot segments are rejected. Use canonical URL-safe resource identifiers.
Destinations come only from configured origins, never from caller input.

All supported API methods under an enabled prefix reach the backend. There is no
endpoint or role allowlist in the gateway. Avoid exposing internal-only backend
administration endpoints under a public mapped prefix.

The proxy buffers finite responses. It supports GET, HEAD, POST, PUT, PATCH and
DELETE; CORS handles OPTIONS preflights. WebSocket, CONNECT, SSE/streaming and
frontend page hosting are outside this implementation. Upstream redirects are
rejected except 304, and requests are never automatically retried.

Subsystem 4xx statuses and bodies pass through, including 401, 403 and
PASSWORD_CHANGE_REQUIRED. WWW-Authenticate is forwarded. Backend 5xx responses
become a safe 503; oversized responses and redirects become 502; timeouts become 504. The gateway always sends Cache-Control: no-store.

## Authentication transport and browser integration

Authorization, Content-Type, Accept, Idempotency-Key, If-Match, If-None-Match and
Stripe-Signature are allowed upstream headers. Raw request bytes are retained for
signature verification. The gateway neither reads JWT claims nor generates
X-User-Id, X-User-Role or X-Room-Number. Client-supplied identity headers are stripped.
A new X-Request-Id and a trusted client address are generated for each request.

Cookie and Set-Cookie are not forwarded. CORS credentials are disabled. This
supports the existing pattern where each frontend BFF owns its browser session
cookie and forwards an API bearer token. Cookie-only backend sessions, custom
API-key headers, OAuth browser redirects and direct cross-origin cookie login
need deliberate transport changes and their own verification before enabling.

The MAD frontend currently calls backend /auth/* and /mad/_. Its gateway adapter
must send auth requests to /mad/auth/_ and business requests to /mad/*.
Changing only its backend URL cannot do that prefix split.
Also complete MAD's local login implementation before claiming login works.

Backend services must sanitize their own 4xx responses because those bodies are
preserved. Password checks, account lockouts, token expiry, object-level permissions
and logout invalidation remain backend responsibilities.

## Add or enable a subsystem

1. Obtain its origin, API prefix, login/session contract and /health/ready endpoint.
2. Verify its backend authenticates private requests and enforces permissions.
3. Set its *_SERVICE_URL and enable its entry in config/routes.json.
4. Confirm rewritePrefix matches its actual backend paths. If FDS exposes /auth/*
   rather than /fds/auth/*, add a more specific /fds/auth mapping with rewritePrefix
   /auth, using FDS_SERVICE_URL. Keep the general /fds mapping.
5. Confirm header/cookie needs fit the transport contract above.
6. Add provider cases for routing and forwarded authentication errors. Run them
   yourself, then verify real login, invalid tokens, authorization and logout in staging.
7. Deploy the backend first, then the gateway route configuration/image.

An unavailable enabled service makes aggregate readiness fail. Enable only services
that are ready for the current environment. Disabling a route stops new matching
requests but does not revoke that subsystem's existing sessions.

## Local and production operation

Local node: copy .env.example to .env if absent, install dependencies and run
npm run dev. MAD normally listens on 4000; the gateway listens on 8080.
Local Compose starts Redis and reaches host MAD through host.docker.internal.
Other host service URLs also need container-reachable names when enabled.

Production uses compose.production.yaml as a standalone file. Create a private
.env.production with HTTPS ALLOWED_ORIGINS, real internal service URLs,
GATEWAY_DOMAIN, ACME_EMAIL and an immutable GATEWAY_IMAGE tag/digest.

```powershell
docker network create forever-hotel-internal
# Attach each service to that external network with a unique network alias.
docker build -t your-registry/forever-gateway:0.1.0 .
docker push your-registry/forever-gateway:0.1.0
docker compose --env-file .env.production -f compose.production.yaml up -d
```

Use internal origins such as http://mad-backend:4000. Caddy exposes ports 80/443;
gateway 8080, Redis and subsystem ports should stay private. Configure DNS for
GATEWAY_DOMAIN and retain Caddy certificate volumes. Pin accepted container digests
in production rather than relying indefinitely on floating major-version tags.

The production template trusts only Caddy at 172.30.80.2/32. If changing the subnet,
change the IP and trust setting together. Caddy derives the forwarded address from
its immediate TCP peer. An additional upstream load balancer needs its own reviewed
trusted-proxy configuration. Do not trust arbitrary caller X-Forwarded-For.

A frontend BFF may cause many users to share one visible client IP. The current MAD
BFF does not forward a verified client IP. Tune quotas for this topology or implement
a trusted forwarding contract; do not simply trust all proxies.

Production requires Redis for shared counters. Redis failures do not bypass rate
limits. The supplied private Redis has no persistence and refuses new writes at its
memory ceiling. Restarts reset counters; monitor memory and connectivity. Remote
Redis should use suitable access controls, credentials and TLS.

Login and other requests share an IP counter, with a lower threshold for /login.
Health checks also consume the quota. Account-specific login throttling remains in
each subsystem. Align Caddy's body limit and gateway limits. Coordinate timeout
budgets with BFF callers and backends; there is no extra central session roundtrip.

## Monitoring and troubleshooting

Use /health/live for process status and /health/ready for enabled backends and
Redis connection status. Readiness is not a full login or database acceptance test;
each backend owns what its readiness endpoint checks.

Access logs contain request ID, route ID, HTTP method, status and duration.
They omit raw URL/query, headers, bodies, credentials and tokens. Correlate the
generated X-Request-Id with backend logs. Business audit trails belong to each
subsystem. Set retention and alerting in your deployment platform.

| Symptom                     | Check                                                                |
| --------------------------- | -------------------------------------------------------------------- |
| Startup configuration error | Named variable, old route policy fields, duplicate prefixes          |
| 401                         | Destination backend's login/session/token validation                 |
| 403                         | CORS origin or destination backend's permissions                     |
| 404                         | Disabled/unknown prefix, old root /auth path, backend route mismatch |
| 413                         | Gateway or Caddy request limit                                       |
| 429                         | Shared IP quota, NAT/BFF traffic, Retry-After                        |
| 502                         | Backend redirect or oversized response                               |
| 503                         | Backend 5xx/unreachable service, Redis or readiness failure          |
| 504                         | Backend request exceeded timeout                                     |

Alert on sustained 5xx/429, readiness failures, approaching deadlines, Redis
capacity and certificate renewal failures. Choose thresholds from staging traffic.
An authentication incident is handled in the affected subsystem: rotate its keys,
revoke its sessions and investigate its audit trail. Gateway key rotation is no
longer required because it has no JWT keys.

## Maintenance, release and rollback

For each change, update affected contracts and tests; run typecheck, lint,
format:check, build and tests before release. This task did not execute tests.
CI performs checks, test coverage, a production dependency audit and a container
build after this folder is moved to its own repository.

Review dependencies, Node support, image tags and advisories regularly. Update
dependencies in a branch, preserve package-lock.json and verify staging before
release. Review route changes together with the destination service owner.

Version source, image, routes and configuration together. Record image digest and
upstream compatibility. For rollback, restore the previous accepted image plus its
compatible route/environment configuration. Avoid rolling back to the old gateway
auth design without its separate central-Auth dependencies and contracts.

SIGINT/SIGTERM allow graceful close with a ten-second forced exit deadline. Keep
the orchestrator grace period longer; the production example uses fifteen seconds.
Compose alone does not supply rolling deployment or proven zero downtime.

Back up configuration versions, secret-store references and Caddy certificate state.
The gateway owns no database schema; rate counters do not need durable backup.
Do not delete application repositories, planning documents or database volumes as
part of gateway maintenance.

## Acceptance still required

The supplied isolated tests use local HTTP fixtures; see TEST_REGISTER.md.
They do not establish real subsystem login correctness, production capacity or
multi-replica behavior. Before release verify local MAD authentication, BFF path
adaptation, each enabled backend's login/logout/denial behavior, Redis outages,
shared quotas, trusted client addressing, TLS renewal and shutdown under traffic.
