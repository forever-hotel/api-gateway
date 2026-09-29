# Forever Hotel API gateway

Self-contained REST gateway for the six Forever Hotel subsystems, with MAD enabled
first. Copy this entire directory to the root of its own repository. It does not
import code, environment files, fixtures or packages from the manager dashboard.

Implemented: prefix routing, HS256 JWT verification, central session validation,
role/method restrictions, first-password-change gating, per-IP rate limiting,
bounded request/response bodies, upstream timeouts, strict CORS, spoofed-header
removal, request IDs, redacted errors, structured logs, health endpoints and graceful
shutdown. Local Docker and production HTTPS/Redis examples are included.

The central Auth service, business APIs and frontend applications remain separate.
WebSocket upgrades are explicitly rejected until the realtime authentication
contract is agreed. This is a REST gateway implementation, not a completed deployment
of every platform component in the SDS.

## Local setup (PowerShell)

Use Node 22.14.x and npm 10+. From this directory:

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm.cmd ci --ignore-scripts
npm.cmd run dev
```

Configure the real `JWT_SECRET`, `JWT_ISSUER`, `AUTH_SERVICE_URL`,
`MAD_SERVICE_URL`, and `AUTH_API_URL` in `.env`. The example secret is development
only. The gateway listens at `http://localhost:8080`; MAD remains on 4000 and the
separate Auth service is expected on 5000 unless configured otherwise.

For a compiled run:

```powershell
npm.cmd run build
npm.cmd start
```

Endpoints:

| Path                         | Behavior                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /health/live`           | Gateway process responds                                                                  |
| `GET /health/ready`          | Redis connection, when configured, and enabled upstream `/health/ready` endpoints respond |
| `POST /auth/login`           | Public, rate-limited proxy to MAD `/auth/login`                                           |
| `GET /auth/session`          | Verified manager JWT/session, allows pending password change, forwards to MAD             |
| `POST /auth/change-password` | Same pending-change allowance; forwards to MAD                                            |
| `POST /auth/logout`          | Verified manager JWT; forwards to MAD even if central Auth is unavailable                 |
| `/mad/*`                     | Active MANAGER session with completed password change; prefix preserved                   |

Routes not enabled in `config/routes.json` return 404. No upstream location is
taken from a client header, query value or request body.

## Connect the existing manager frontend

Change its **local** `frontend/.env.local` settings to:

```dotenv
NEXT_PUBLIC_API_URL=http://localhost:8080
BACKEND_API_URL=http://localhost:8080
APP_ORIGIN=http://localhost:3000
```

Restart the frontend. Keep MAD's `AUTH_SERVICE_URL` pointing directly to central
Auth. Never point it to the gateway `/auth` facade, which would create a loop.
The gateway's `/auth/*` target must remain MAD for the existing frontend: MAD
returns the safe session fields expected by its BFF and performs local logout
revocation. The gateway does not set browser cookies or create login accounts.

These are instructions only: no existing MAD configuration was changed by creating
this folder. Booking and occupancy data still require the provider reporting views
documented in the MAD repository.

## Containers

After creating `.env`, run from this directory:

```powershell
docker compose up --build -d
docker compose logs -f gateway
docker compose down
```

This starts the gateway and a private Redis instance. Local Compose explicitly
targets host MAD/Auth services using `host.docker.internal`. It does not start MAD,
Auth, PostgreSQL or any business subsystem. Edit Compose if those services run on
a shared Docker network instead. The production file is separate and must be used
with `-f compose.production.yaml`; see the maintenance report before deploying.

## Verification

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd run build
npm.cmd test
npm.cmd run test:cov
```

Tests use temporary loopback HTTP providers and generated test JWTs. They do not
need real Auth, MAD, PostgreSQL or Redis. The production Redis/Caddy deployment
still needs separate staging acceptance. Tests were provided but not run during
implementation, respecting the existing user preference.

Read [MAINTENANCE.md](MAINTENANCE.md) for operation, security boundaries, adding
services, deployment, testing, upgrade and recovery procedures, and outstanding
cross-service agreements. [TEST_REGISTER.md](TEST_REGISTER.md) maps the tests.
