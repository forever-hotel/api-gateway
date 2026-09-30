# Forever Hotel API gateway

Shared Fastify application written in TypeScript for MAD, HW, FDS, FOSS, KMS
and WKMS. This guide applies to every subsystem team. Each subsystem
owns login, credentials, token/session validation, permissions and logout.
The gateway routes requests and applies CORS, IP rate limits, body limits,
timeouts and request IDs. It does not issue or validate JWTs.

There is no Redis dependency or response cache. Rate counters use local process
memory. Frontend offline caching belongs to the relevant subsystem.

## Routes

For the complete team handoff, configuration, cookie integration and maintenance
instructions, read [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md).

All six subsystems are enabled. The example ports must match your actual backends.

| Gateway path | Upstream path | Example port | Allowed cookie names |
| --- | --- | --- | --- |
| `/mad/auth/*` | `/auth/*` | 4000 | mad_session, mad_csrf |
| `/mad/*` | `/mad/*` | 4000 | mad_session, mad_csrf |
| `/hw/*` | `/hw/*` | 4100 | hw_session, hw_csrf |
| `/fds/*` | `/fds/*` | 4200 | fds_session, fds_csrf |
| `/foss/*` | `/foss/*` | 4300 | foss_session, foss_csrf |
| `/kms/*` | `/kms/*` | 4500 | kms_session, kms_csrf |
| `/wkms/*` | `/wkms/*` | 4600 | wkms_session, wkms_csrf |

The longest prefix wins. There is no shared /auth or /identity route.
Confirm each backend's paths and update rewritePrefix as needed. Enabling routes
does not create the subsystem implementations.

GET /health/live checks the gateway process. GET /health/ready checks every distinct
enabled backend's /health/ready endpoint. It returns 503 if any backend is unavailable;
other routes can still forward to their available backends.

## Local setup (PowerShell)

Use Node 22.14.x and npm 10+. Run inside this folder:

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm.cmd ci --ignore-scripts
npm.cmd run dev
```

Start each subsystem backend using its own repository's setup instructions.
Set all six `*_SERVICE_URL` values and exact frontend `ALLOWED_ORIGINS` in .env.
The example frontend ports 3000 through 3005 are placeholders. The gateway listens
on port 8080. Existing .env files are not overwritten: copy the newly required
service variables manually. No Redis or service on port 5000 is needed.

Remove obsolete REDIS_URL, JWT_SECRET, JWT_ISSUER, AUTH_SERVICE_URL, AUTH_API_URL
and IDENTITY_SERVICE_URL from gateway deployment environments. Replace
AUTH_TIMEOUT_MS with HEALTH_TIMEOUT_MS.

For a compiled run, use npm run build followed by npm start.

```powershell
docker compose up --build -d
docker compose logs -f gateway
docker compose down
```

Local Compose starts only the gateway and points the six routes at host services.
It does not create backends or databases. Production Compose adds a Caddy HTTPS
edge. See [MAINTENANCE.md](MAINTENANCE.md) before deployment.

## Cookies and browser calls

Both Cookie requests and Set-Cookie responses are supported. Each route's
cookieNames list controls which cookies reach its backend and which it may set.
Use the listed names in your subsystem, or update that list to match its actual
cookie names. Names must be unique across subsystems.

The gateway removes upstream Domain and normalizes Path to the subsystem root
(`/<subsystem>` for its login and business routes). Multiple Set-Cookie headers stay separate.
HttpOnly, SameSite, expiration and logout deletion attributes are preserved;
SameSite defaults to Lax, and production adds Secure. Backends should mark
session cookies HttpOnly. Cookies named __Host-* require Path=/ and are therefore
not supported by this path-scoped design.

Use the same request pattern for any subsystem. The path, login payload and
response schema come from that subsystem's API contract:

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
