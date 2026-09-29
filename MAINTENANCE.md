# API gateway setup and maintenance report

## 1. Scope and current status

The SDS describes prefix routing, JWT verification, role enforcement, rate limits
and an HTTPS entry point. This directory implements the REST portion, with MAD
enabled first and configuration entries for HW, FDS, FOSS, KMS and WKMS disabled
until their owners provide working contracts. HTTPS is supplied by the included
Caddy edge configuration, with Redis shared counters in production.

This is a separate deployable application. It owns no hotel tables, credentials,
booking records or business migrations. Auth owns issuing tokens, password policy,
staff activation and central revocation. Each business service still authorizes
requests and enforces data ownership. The gateway is not an alternative source of
truth for room access, transaction validity or staff permissions.

Not yet accepted against real providers: guest session fields, optional subsystem
paths/public endpoints, endpoint-level kitchen-manager MAD access, network topology,
throughput/latency, live Redis failure behavior and TLS deployment. WebSocket,
Socket.IO, SSE, large file streaming and frontend page hosting are outside this
REST implementation. Upgrade/CONNECT requests are rejected rather than bypassing
authentication. The existing Next.js apps continue to host their own pages/BFFs.

## 2. Repository layout and moving this folder

| Path                                          | Responsibility                                                      |
| --------------------------------------------- | ------------------------------------------------------------------- |
| `src/config.ts`                               | Validate environment and enabled route policy                       |
| `src/auth.ts`                                 | JWT checks, active-session checks, role and forced-change rules     |
| `src/http.ts`                                 | Canonical paths and bounded upstream response reader                |
| `src/app.ts`                                  | HTTP lifecycle, limits, safe forwarding, errors, readiness and logs |
| `src/server.ts`                               | Configuration/startup and graceful shutdown                         |
| `config/routes.json`                          | Explicit service destinations and access policies                   |
| `test/gateway.test.ts`                        | Isolated HTTP-provider and authentication tests                     |
| `compose.yaml`                                | Local gateway plus Redis, reaching host services                    |
| `compose.production.yaml`, `deploy/Caddyfile` | Private gateway/Redis behind HTTPS edge                             |
| `.github/workflows/ci.yml`                    | Checks after this folder becomes a repository root                  |

Copy the complete folder, including dotfiles, route configuration and lockfile.
Exclude `node_modules`, `.npm-cache`, `dist`, `.test-build`, coverage, logs and real
`.env` files. Keep your secrets separately and recreate the destination environment.
Do not copy the parent manager-dashboard `.git` directory. In the new repository:

```powershell
git init
npm.cmd ci --ignore-scripts
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd run build
# Run tests yourself before making the first reviewed release.
npm.cmd test
git add .
git commit -m "feat(gateway): establish shared REST gateway with MAD routing"
```

Add your new remote and push only when ready. The nested workflow does not execute
from the manager-dashboard root; it becomes active in the new repository.

## 3. Configuration reference

`.env.example` is the template. Configuration is read once at startup; restart after
changing it or `config/routes.json`. No hot configuration reload is implemented.

| Variable               | Default/example          | Meaning                                                                |
| ---------------------- | ------------------------ | ---------------------------------------------------------------------- |
| `NODE_ENV`             | `development`            | `production` additionally requires HTTPS origins and Redis             |
| `HOST`, `PORT`         | `127.0.0.1`, `8080`      | Local listener; containers bind `0.0.0.0` internally                   |
| `LOG_LEVEL`            | `info`                   | `fatal`, `error`, `warn`, `info`, `debug`, `silent`                    |
| `JWT_SECRET`           | Development example only | Shared HS256 signing secret, at least 32 bytes                         |
| `JWT_ISSUER`           | `central-auth`           | Exact token issuer; must match Auth and business services              |
| `AUTH_SERVICE_URL`     | `http://localhost:5000`  | Direct internal central Auth origin; never this gateway                |
| `AUTH_API_URL`         | `http://localhost:4000`  | MAD auth facade for the existing manager frontend                      |
| `MAD_SERVICE_URL`      | `http://localhost:4000`  | MAD business API origin                                                |
| `ALLOWED_ORIGINS`      | `http://localhost:3000`  | Comma-separated exact browser origins, no paths or wildcards           |
| `TRUSTED_PROXIES`      | Empty                    | Exact immediate proxy IPs/CIDRs allowed to supply forwarding addresses |
| `REDIS_URL`            | Empty locally            | Shared rate store; production requires it; supports `redis:`/`rediss:` |
| `RATE_LIMIT_MAX`       | 120                      | Requests per client-IP window                                          |
| `LOGIN_RATE_LIMIT_MAX` | 10                       | Stricter maximum for paths ending `/login`                             |
| `RATE_LIMIT_WINDOW_MS` | 60000                    | Rate window; local memory is per process and resets on restart         |
| `BODY_LIMIT_BYTES`     | 1048576                  | Maximum request body buffered by Fastify                               |
| `RESPONSE_LIMIT_BYTES` | 10485760                 | Maximum upstream response buffered by the gateway                      |
| `UPSTREAM_TIMEOUT_MS`  | 4000                     | Business call plus response-reading deadline                           |
| `AUTH_TIMEOUT_MS`      | 2000                     | Session lookup and each readiness call deadline                        |
| `ROUTES_FILE`          | `config/routes.json`     | Policy file relative to the gateway working directory                  |

Service URLs are origins only: no credentials, query, fragment or path. Set the
path mapping with `rewritePrefix`. Never log environment dumps or paste Compose's
expanded configuration into tickets: it can contain secrets.

The gateway and upstream timeout budgets are sequential for protected calls. The
default maximum is approximately 2 seconds for Auth plus 4 seconds for business
I/O. The existing MAD BFF waits 7 seconds. Coordinate budgets across every hop;
increasing only the gateway deadline can still leave the BFF timing out.

## 4. Routing and authentication contracts

An enabled prefix matches itself or `prefix + '/'`; `/madness` never matches
`/mad`. Prefixes cannot overlap. Paths with percent encodings, backslashes,
double slashes or dot segments are rejected. Query encoding is preserved. Keep
resource identifiers URL-safe, such as UUIDs. Do not place JWTs in query strings.

Requests are mapped to a configured origin and `rewritePrefix`; they cannot choose
an arbitrary destination. No upstream redirects are followed. Redirect responses
are rejected (except 304). Requests are not automatically retried, including writes.

An empty `endpoints` array means every path below the prefix is protected by its
role policy. A nonempty array is an exact path/method allowlist: all other endpoints
under that prefix return 404. The default Auth facade allows exactly four endpoints.
`roles` grants normal access; `readOnlyRoles` allows only GET/HEAD. Service-level
checks remain mandatory even if a role is allowed at the gateway.

JWTs require HS256, exact issuer, UUID subject, recognized role and integer `iat`
and `exp`. Staff lifetime must be exactly 28,800 seconds; guest lifetime is at most
86,400 seconds. Future-issued and expired tokens are rejected. There is no refresh
token endpoint or guest credential creation in this gateway.

For protected calls the gateway calls central `GET /auth/session` using the same
bearer token. It requires `active: true`, matching `sub` and `role`; staff additionally
require a boolean `passwordChangeRequired`. No positive session cache is used, so
deactivation/revocation is checked on every request. Provider errors fail closed.

Guests additionally require a token `roomNumber` string, matching session
`roomNumber`, `activeStay: true`, and a future ISO `checkoutAt`. This is a proposed
FOSS/Auth contract, not an asserted existing provider capability. Keep FOSS disabled
until agreed. The business service must enforce per-object/per-room access; passing
gateway validation does not allow requesting another room's records.

Pending staff password changes can use explicitly configured `password-change`
endpoints but cannot access business routes. Logout verifies signature, claims and
role without a central lookup, allowing MAD to persist local token revocation even
when Auth is down. MAD still contacts central Auth and may return 503 after locally
revoking the token. Central-only logout for other services depends on central Auth
availability; the gateway does not maintain a second revocation database.

The current manager browser uses its existing HttpOnly BFF cookie. Its BFF forwards
bearer requests to the gateway, whose `/auth/*` routes proxy MAD. MAD returns the
session shape expected by that BFF. Optional `/identity/*` routes map to central
`/auth/*` for future clients; enable only after reviewing their different payloads.
Never change MAD's internal Auth URL to the gateway's facade: it would recurse.

## 5. Enabling another subsystem

1. Obtain the owner-approved origin, health endpoint, route prefix, token/session
   contract, roles and exact public endpoints.
2. Add its `*_SERVICE_URL` to the gateway environment, with an internal address.
3. Review its disabled entry in `config/routes.json`; set `rewritePrefix` to the
   prefix actually implemented by the service. Enable the entry only after review.
4. For public operations, use a nonempty exact `endpoints` allowlist and set only
   the reviewed operations to `access: "public"`. Include protected endpoints too,
   because an allowlist rejects everything not listed. Do not expose an entire
   website API publicly just because HW is a public-facing product.
5. Require the service to implement `GET /health/ready`, as expected by this gateway.
6. Add contract tests for success, unauthenticated, forbidden, write denial, outage,
   query forwarding and public exceptions. Run all tests and staging acceptance.
7. Deploy the service first, then the reviewed gateway policy/image. Monitor 4xx,
   5xx, latency and readiness immediately after release.

Default proposals: MAD manager only; FDS receptionist plus read-only manager; KMS
kitchen staff/manager; WKMS worker plus read-only manager; FOSS guest; HW protected
until exact public routes are reviewed. Kitchen-manager partial MAD access needs
specific endpoint policies and backend support before being enabled.

## 6. Network, TLS and rate-limit operation

For host development use `.env` and `npm run dev`. For local Docker use
`compose.yaml`, which reaches host services on ports 4000/5000 and binds the public
gateway port only to loopback. It intentionally uses development mode.

Production uses **only** `compose.production.yaml`. Create `.env.production` from
the template, set real secrets, HTTPS origins, internal service addresses,
`GATEWAY_DOMAIN`, `ACME_EMAIL` and an immutable `GATEWAY_IMAGE` tag/digest.
Create the external network and attach the independently deployed services:

```powershell
docker network create forever-hotel-internal
# Configure each service's Compose file to join this network with unique aliases.
docker build -t your-registry/forever-gateway:0.1.0 .
docker push your-registry/forever-gateway:0.1.0
docker compose --env-file .env.production -f compose.production.yaml up -d
```

Use service aliases such as `http://mad-backend:4000` and the real Auth alias. DNS
for `GATEWAY_DOMAIN` must point to the host. Caddy exposes 443 for HTTPS and 80 for
redirects/certificate challenges. Its data/config volumes retain certificate state
and must survive restarts. Do not publish gateway port 8080, Redis, database or
internal service ports publicly. Restrict staff-facing access using the hotel VPN,
firewall or a separately reviewed edge policy; role checks alone are not a Wi-Fi
restriction.

The example trusts only the Caddy IP `172.30.80.2/32`; Caddy overwrites client
forwarding headers. Change the subnet/IP together if they conflict with your
network. Do not set a global trust-all proxy option. If a load balancer precedes
Caddy, configure its trusted network explicitly; the shipped edge derives the IP
from its immediate TCP peer.

When the existing Next.js BFF calls the gateway, the gateway sees the BFF server IP
unless that BFF deliberately supplies a verified client address through an agreed
trusted path. The current MAD BFF does not do so: its users share one IP quota.
Tune limits accordingly or add a reviewed trusted forwarding contract at the BFF.
Never solve this by trusting arbitrary client `X-Forwarded-For` headers.

Local memory counters are suitable for one development process only. Production
requires Redis so replicas share limits. Redis errors do not disable enforcement;
requests fail closed. The example Redis is private, uses no disk persistence and
rejects writes at its memory limit rather than evicting active counters. Restarts
reset counters. For managed/remote Redis use network access controls, credentials
and `rediss:` where appropriate. Never expose its port publicly.

Limits for `/login` and other requests share the client counter, with a stricter
threshold applied to login requests. Health checks also consume the IP window;
probe intervals and limits must account for this. Caddy's 1MB body limit should
match gateway policy. Responses are buffered and bounded: increasing the limit
increases per-concurrent-request memory use. Benchmark before increasing it.

## 7. Daily monitoring and incident response

Use `/health/live` for process liveness and `/health/ready` for enabled upstreams
plus the Redis connection. Readiness checks each distinct enabled upstream's
`/health/ready`; it does not separately validate central Auth unless Auth is itself
an enabled upstream. Protected requests still check central Auth every time.
An enabled optional service outage makes aggregate readiness fail.

Access logs contain request ID, service route ID, HTTP method, status and duration.
They deliberately omit URL/query, headers, cookies, bodies, credentials, user IDs
and guest room numbers. The gateway supplies a new `X-Request-Id` and propagates it
upstream. Have services log that ID without logging authorization headers. These
operational logs are not the SDS's tamper-evident business audit log; that remains
an owner-service responsibility. Configure log collection, retention and alerting
in your deployment platform.

Suggested alerts: readiness failure, sustained 5xx, unusual 401/403/429 rates,
latency approaching the configured deadlines, Redis unavailability/memory pressure,
and certificate renewal failures. Establish numeric thresholds from staging load
tests rather than treating guessed values as an SLA.

| Symptom                        | Investigation                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| Startup configuration error    | Check named variable and route schema; never print the secret                             |
| 401                            | Issuer/key mismatch, expired/wrong-duration token, deactivated or mismatched session      |
| 403 / PASSWORD_CHANGE_REQUIRED | Role/method policy, CORS origin, pending password change                                  |
| 404                            | Disabled prefix, unknown exact Auth path/method or missing allowlist entry                |
| 413                            | Body exceeds gateway or Caddy limit                                                       |
| 429                            | IP quota; multiple users behind NAT/BFF; inspect Retry-After                              |
| 502                            | Upstream redirect or oversized response                                                   |
| 503                            | Auth/business/Redis unavailable or unsafe upstream error; inspect correlated service logs |
| 504                            | Upstream exceeded deadline; inspect service latency before increasing timeouts            |

On suspected compromise, contain traffic, rotate the shared secret in a coordinated
release, invalidate sessions at Auth and investigate owner-service audit records.
Do not enable an authentication bypass to restore availability.

## 8. Maintenance schedule and upgrades

For each change: update its contract/test case, run typecheck, lint, format check,
build and tests, review the diff, then deploy to staging. CI runs these checks and
audits production dependencies. Coverage is reported; no claim is made that the
new gateway has reached the main project's 80%/90% thresholds until measured and
enforced with an agreed coverage policy.

Weekly: review error/rate trends, Redis capacity, certificate status and dependency
advisories. Monthly or on security release: update dependencies in a branch, commit
the lockfile, run the full suite, rebuild the container and verify staging. Review
Node support and container tags regularly. The supplied major-version Docker tags
are convenient templates; pin tested image digests in your production release.

JWT key rotation: this implementation accepts one active HS256 secret. Coordinate
Auth, gateway and every validating service, expect existing tokens to require login,
and do not introduce overlapping keys without a separately reviewed key-ID policy.
Do not commit `.env.production`, private certificates or registry credentials.

Keep API route/role changes under peer review. Use Conventional Commits such as
`feat(gateway): route approved FDS endpoints`, `fix(auth): reject inactive sessions`,
and `chore(deps): update gateway dependencies`, referencing the actual task/issue.

## 9. Release, rollback and recovery

Version the source, lockfile, route policy and container image together. Record the
image digest, config version and upstream compatibility in release notes. Verify
health, representative login/session/logout, each enabled service, and denied-role
requests in staging before deployment.

For rollback, set `GATEWAY_IMAGE` to the last accepted digest, restore its compatible
route/environment policy and redeploy. No business database rollback is needed
because the gateway owns no schema. Preserve Caddy certificate volumes. The default
gateway image contains its route file; build a new image for route changes rather
than editing running containers.

SIGINT/SIGTERM stop accepting connections and allow graceful close; a 10-second
deadline forces exit. Keep orchestrator grace time above that (example: 15 seconds).
Test behavior under traffic before claiming zero downtime. Docker Compose by itself
does not provide an orchestrated rolling deployment strategy.

Back up reviewed route/config versions, secret-manager references and Caddy state.
Redis rate counters need not be backed up; losing them resets quotas. Never delete
application repositories, planning documents or database volumes during gateway
maintenance. `npm ci` replaces only this project's installed dependency tree.

## 10. Tests and acceptance handoff

`npm test` compiles isolated tests and runs Node's test runner. Fixtures use random
loopback ports and test-only JWTs. No real Auth, hotel database or live business
service is involved. `npm run test:cov` prints experimental Node coverage. Tests
were authored but not executed during implementation. See TEST_REGISTER.md.

Before production acceptance, run real-provider tests for token issuance/expiry,
revocation/deactivation, forced password change, logout outages, source outages,
both analytics APIs, each optional service policy, Redis failure/recovery, trusted
client addressing, TLS renewal, body limits and load. Confirm a guest checkout
immediately prevents further access. Add a separately reviewed WebSocket design
before opening a realtime upgrade endpoint; browser WebSocket APIs cannot simply
attach the same Authorization header used by REST clients.

## References

Project scope: provided SDS sections 1.1–1.2, 6.1–6.2 and 7.3, plus the existing
MAD Auth/BFF contracts inspected during implementation. Upstream documentation:

- [Fastify server configuration](https://fastify.dev/docs/latest/Reference/Server/)
- [Fastify rate-limit options and Redis support](https://github.com/fastify/fastify-rate-limit)
- [JOSE JWT verification](https://github.com/panva/jose)
- [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
- [Caddy request body limits](https://caddyserver.com/docs/caddyfile/directives/request_body)
