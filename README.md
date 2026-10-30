# Forever Hotel API Gateway and Staff Authentication

NestJS with Fastify. The gateway routes all six subsystem APIs, proxies the shared
WebSocket endpoint, and owns staff login, JWT issuance/validation, session revocation
and password changes. Guest/HW/FOSS authentication remains with its owner until an
agreed guest contract is implemented.

## Local configuration

Use Node 22 and npm 10+. Copy `.env.example` to `.env`, configure the existing shared
PostgreSQL/Neon database, JWT secret/issuer, service URLs and exact frontend origins.
Set `STAFF_AUTH_ENABLED=true`. Run `npm ci --ignore-scripts`, `npm run build`, then
`npm start`, or `npm run dev`. Disable routes for services that are not running.
The parent MAD Compose definition supplies gateway settings from its root `.env`.

Existing `staff_users` and `mad_revoked_sessions` tables must already exist. The
latter name is retained for compatibility, but now stores all staff revocations.
No schema is created, altered or migrated by startup. Apply
`sql/manager-password-reset.sql` manually before enabling email recovery. Grant
only the gateway runtime role access to its reset records. Keep database passwords,
JWT secrets, SendGrid keys and local `.env` files out of Git.

## Staff authentication API

All calls use JSON and HTTPS in deployment. Use an HttpOnly-cookie BFF, as MAD does,
to keep tokens out of browser storage. The BFF supplies `Authorization: Bearer ...`.
The gateway does not mint browser cookies itself. Cookie forwarding remains supported
for owner-managed guest sessions; cookies alone do not authenticate central staff APIs.

| Endpoint                            | Body / behavior                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| `POST /auth/login`                  | `username`, `password`, optional `subsystem` (`mad`, `fds`, `kms`, `wkms`)      |
| `GET /auth/session`                 | Bearer token; current account state and expiry                                  |
| `POST /auth/logout`                 | Bearer token; durable token revocation                                          |
| `POST /auth/change-password`        | Bearer token, `currentPassword`, `newPassword`; own account only                |
| `POST /auth/request-password-reset` | Manager `email`; generic response to avoid account enumeration                  |
| `POST /auth/reset-password`         | Manager `email`, six-digit `code`, `newPassword`; invalidates existing sessions |

`/mad/auth/*` aliases enforce the manager role for login/session/change/logout and
preserve MAD's existing BFF contract. Password recovery always targets active managers.
Each subsystem keeps its own login screen but uses this shared API for staff credentials.

Staff JWTs use HS256, an eight-hour lifetime and `forever-hotel-staff` audience. Existing
MAD-audience tokens remain accepted until their original expiry if signed with the same
configured key/issuer. Existing scrypt manager hashes and bcrypt cost-12 staff hashes are
supported. New passwords use scrypt. Never change the key/issuer without planning a
system-wide sign-out. All owner services must validate sessions against this gateway or
use an agreed secure verification scheme; a role header supplied by a client is not trusted.

Default staff route permissions: MAD=Manager; FDS=Receptionist;
KMS=Kitchen Staff/Kitchen Manager; WKMS=Worker. First-login sessions may change passwords
but cannot call business APIs. Owner services retain business authorization checks.
MAD's backend uses `AUTH_SERVICE_URL` to verify sessions on direct requests too.
Guest route contracts, additional owner-role access and provider login wiring must be
agreed with the respective teams before enabling their services.

## Manager recovery and email

Set `STAFF_EMAIL_ENABLED=true`, `SENDGRID_API_KEY` and a verified
`SENDGRID_FROM_EMAIL`. A code expires after ten minutes, permits five wrong attempts,
and is replaced no more than once per minute per account. Only a keyed hash is stored;
the code is never logged. Reset is atomic and single-use and clears account lockout.
It requires a password different from the current password; older password history
is not retained. Successful recovery does not sign in automatically.

SendGrid 202 means accepted by the provider, not confirmed inbox delivery. Check
SendGrid Email Activity and the recipient inbox/spam folder. Provider failures produce
a safe `manager_reset_email_not_accepted` log event; public responses remain generic.
Staff creation/initial-credentials email remains owned by MAD's encrypted delivery queue.

## Routing, sockets and health

`config/routes.json` or `ROUTES_JSON` selects enabled upstreams and rewrite prefixes.
The longest prefix wins. `/mad/auth/*` is handled locally when staff auth is enabled.
`/auth` and `/health` are reserved. MAD preserves `/mad`, FDS strips `/fds`; review other
owner mappings with each team. CORS, bounded bodies/responses, timeouts and separate
login/recovery rate limits apply. There is no Redis or response cache. Per-IP counters
are process-local; database-backed account lockout/reset limits survive restarts.

Enable `/realtime` with `websocket:true` and set `WEBSOCKET_SERVICE_URL` for the shared
Socket.IO service. It validates sessions using the gateway's session endpoint and enforces
subscription roles. REST auth does not replace the socket ticket/handshake checks.

`/health/live` checks the process. `/health/ready` checks the auth database (and reset
table when email is enabled) and all enabled upstream readiness endpoints. Disabled
services are excluded. Logs omit tokens, request bodies, credentials and email addresses.

## Checks and handoff

`npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build` and
`npm run test:cov` are the quality commands. The gateway is an independent Git repository:
commit it separately from MAD. No SQL execution or deployment is part of an app build.

## Cross-service and performance verification

`npm run test:system` requires disposable `TEST_DATABASE_URL` (database name containing
`test`), `TEST_RABBITMQ_URL` (vhost `/mad_test`), and a built sibling MAD backend.
Set `MAD_BACKEND_PATH` if the backend is not at `../backend`. This runs real central
JWT validation, gateway socket proxying, subscription permissions, RabbitMQ delivery,
redaction and logout invalidation. It never uses the normal application database URL.

`npm run test:performance` runs the same isolated stack with 100 and 300 persistent
sockets and one authenticated API request per client per second. The local smoke
profile measures five seconds after five seconds of warm-up and enforces p95 <= 500ms,
zero errors and realtime fanout within two seconds. Set `PERFORMANCE_WARMUP_ROUNDS=300` and `PERFORMANCE_ROUNDS=900`
for 15-minute measured runs per profile on a dedicated test host. Local smoke results
do not prove production capacity, monthly uptime, log retention, external service
acceptance or UAT. Those require staging evidence and the relevant owners.

MAD's cross-system CI checks out this repository's `main` by default. Set the MAD
repository variable `GATEWAY_TEST_REF` to a gateway commit/branch when coordinating
changes, and publish the gateway test changes before enabling that CI job. The CI
checkout must have read access to both repositories.
