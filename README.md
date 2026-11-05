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

| Gateway path  | Upstream path | Example port | Allowed cookie names    |
| ------------- | ------------- | ------------ | ----------------------- |
| `/mad/auth/*` | `/auth/*`     | 4000         | mad_session, mad_csrf   |
| `/mad/*`      | `/mad/*`      | 4000         | mad_session, mad_csrf   |
| `/hw/*`       | `/*`          | 4100         | hw_session, hw_csrf     |
| `/fds/*`      | `/*`          | 4200         | fds_session, fds_csrf   |
| `/foss/*`     | `/foss/*`     | 4300         | foss_session, foss_csrf |
| `/kms/*`      | `/kms/*`      | 4500         | kms_session, kms_csrf   |
| `/wkms/*`     | `/wkms/*`     | 4600         | wkms_session, wkms_csrf |

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

```javascript
function createSubsystemClient(gatewayOrigin, subsystem) {
  // subsystem: mad, hw, fds, foss, kms or wkms
  const baseUrl = gatewayOrigin + '/' + subsystem;
  return (path, options = {}) =>
    fetch(baseUrl + path, { ...options, credentials: 'include' });
}

async function login(request, loginPath, credentials) {
  // Supply the subsystem's documented path and credential fields.
  return request(loginPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
}

async function readResource(request, resourcePath) {
  return request(resourcePath);
}
```

The browser handles cookies; frontend JavaScript does not set the Cookie header.
Requests from an unapproved Origin are rejected. Cookie-authenticated writes
without Origin are also rejected, including server-to-server cookie calls.
A BFF must forward a verified allowed Origin for such writes. X-CSRF-Token is
allowed through CORS and forwarded; each subsystem validates its own CSRF tokens.
Do not use GET/HEAD to modify state.

Use frontend and API hosts under the same site where possible. Truly cross-site
cookies need SameSite=None; Secure and can still be blocked by browser cookie
policies. Credential forwarding does not create single sign-on.

## Integration steps for every subsystem

1. Select your prefix and service URL from the route table. Run the backend at
   that origin and provide `GET /health/ready`.
2. Compare the backend's real paths with `prefix` and `rewritePrefix` in
   `config/routes.json`. If it exposes `/auth/*` separately from its business
   prefix, add a more specific `/<subsystem>/auth` mapping to `/auth`.
   The shipped MAD mapping is an existing example; the same configuration
   pattern works for every subsystem.
3. Implement login, token/session validation, permissions and logout in your
   backend. Decide which operations are public; gateway routing does not enforce
   endpoint authentication.
4. Match backend cookie names to every applicable route's `cookieNames`, or use
   Authorization headers. Implement CSRF checks for cookie-authenticated writes.
5. Add your frontend's exact origin to `ALLOWED_ORIGINS`. Point API calls at
   the gateway with your subsystem prefix and use the browser helper above.
6. If the frontend uses a backend-for-frontend (BFF), update its upstream path
   mapping and credential forwarding too. Changing only its API hostname may
   leave old paths pointing at the wrong gateway endpoint.
7. Verify login, protected reads/writes, expired sessions, access denial,
   logout and health using your backend's real contracts.

These steps are required independently for all six teams. Route availability does
not establish that a subsystem's authentication or frontend integration is complete.
See [MAINTENANCE.md](MAINTENANCE.md) for route templates, BFF integration and the
shared operating procedures.

## Verification and transfer

Static checks:

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd run build
```

Tests for you to run:

```powershell
npm.cmd test
npm.cmd run test:cov
```

Tests were updated but not run. See [TEST_REGISTER.md](TEST_REGISTER.md).
Copy this folder, including dotfiles and lockfile, into its own repository.
Exclude node_modules, caches, generated output and actual environment files.
The parent repository currently ignores api-gateway.

Hotel website integration: /hw/room-types, /hw/contact/enquiries, and
/hw/guests/{register,login,me} forward to the same paths without /hw.
Guest authentication uses the backend Authorization bearer token contract.
