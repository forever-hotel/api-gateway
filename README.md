# Forever Hotel API gateway

Standalone REST gateway for MAD, HW, FDS, FOSS, KMS and WKMS. Each subsystem
owns its login, credential storage, token issuance, token/session validation,
permissions and logout. The gateway only routes API requests and applies
transport controls: CORS, IP rate limits, bounded bodies, timeouts and request IDs.

There is no central login service, JWT signing key, token verification, role check
or session lookup in this application. Authorization headers are passed unchanged
to the selected backend. Every backend must protect its own private endpoints.

## Routes

| Gateway path | Upstream path | Default  |
| ------------ | ------------- | -------- |
| /mad/auth/*  | MAD /auth/*   | Enabled  |
| /mad/*       | MAD /mad/*    | Enabled  |
| /hw/*        | HW /hw/*      | Disabled |
| /fds/*       | FDS /fds/*    | Disabled |
| /foss/*      | FOSS /foss/*  | Disabled |
| /kms/*       | KMS /kms/*    | Disabled |
| /wkms/*      | WKMS /wkms/*  | Disabled |

The longest matching prefix wins. Login belongs to its subsystem, for example
POST /mad/auth/login. There is no shared /auth or /identity route.
Optional route mappings are templates until their backend contracts are confirmed.

GET /health/live checks the gateway process. GET /health/ready checks Redis when
configured and each distinct enabled backend's /health/ready endpoint.

## Local setup (PowerShell)

Use Node 22.14.x and npm 10+. Run inside this folder:

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm.cmd ci --ignore-scripts
npm.cmd run dev
```

Set MAD_SERVICE_URL=http://localhost:4000 and
ALLOWED_ORIGINS=http://localhost:3000 in .env. Gateway listens on port 8080.
No service on port 5000 or authentication environment variables are needed.
When upgrading an existing .env, remove JWT_SECRET, JWT_ISSUER, AUTH_SERVICE_URL,
AUTH_API_URL and IDENTITY_SERVICE_URL; replace AUTH_TIMEOUT_MS with HEALTH_TIMEOUT_MS.
Keep the original .env private; the gateway does not migrate it automatically.

Compiled run:

```powershell
npm.cmd run build
npm.cmd start
```

Local containers:

```powershell
docker compose up --build -d
docker compose logs -f gateway
docker compose down
```

Compose starts the gateway and private Redis. It reaches MAD on the host at port
4000; it does not start any subsystem or database. Use the separate production
Compose file only after following [MAINTENANCE.md](MAINTENANCE.md).

## MAD integration still required

The current MAD backend still calls a central Auth provider. That backend must
be changed separately to implement its own login and token/session validation.
This gateway change does not implement that backend work.

The current MAD frontend BFF also requests /auth/* from its configured backend.
To use this gateway, its auth requests must use /mad/auth/* while business requests
retain /mad/*. Changing only BACKEND_API_URL to port 8080 is insufficient.
Keep the existing direct connection until that adapter is updated.

This gateway currently forwards API authorization headers, not Cookie or
Set-Cookie headers. The existing browser-to-BFF HttpOnly session cookie stays in
the subsystem frontend; its BFF forwards the subsystem's token. A backend using
cookie-only API sessions needs an explicit cookie/CSRF/proxy design before routing
through this implementation. Separate subsystem logins do not provide SSO or
global logout.

## Verification and handoff

Static checks and build:

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd run build
```

Run tests yourself:

```powershell
npm.cmd test
npm.cmd run test:cov
```

The updated tests use temporary local HTTP providers. No tests were run during
this change. See [TEST_REGISTER.md](TEST_REGISTER.md) for coverage and outstanding
staging checks.

Copy this folder, including dotfiles and the lockfile, into its own repository.
Do not copy node_modules, generated output, caches or real environment files.
This copy is currently ignored by the parent repository's .gitignore.
Read [MAINTENANCE.md](MAINTENANCE.md) for the full operating guide.
