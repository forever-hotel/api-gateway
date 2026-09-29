# Gateway verification register

Tests were updated but **not executed**, as requested. Results and coverage remain
pending. Cases in test/gateway.test.ts use temporary loopback HTTP servers, without
a database, central Auth service or generated JWTs.

| Case                        | Expected behavior                                                           |
| --------------------------- | --------------------------------------------------------------------------- |
| MAD login                   | /mad/auth/login rewrites to /auth/login with exact body bytes               |
| Header boundaries           | Spoofed identity and cookies stripped; request ID generated                 |
| Six subsystem logins        | Each enabled prefix reaches its own backend                                 |
| Authorization transport     | Missing, malformed or opaque credentials reach backend unchanged            |
| Business queries and writes | Prefix/query preserved; no gateway role decision                            |
| Backend auth failures       | 401/403 and domain error body preserved, including WWW-Authenticate         |
| Fault handling              | Timeout 504; safe 503 for backend 500; redirect 502                         |
| Route/path boundaries       | Unknown/disabled prefixes 404; ambiguous paths 400                          |
| Payload limits              | Request 413; oversized response 502                                         |
| Quotas                      | Login threshold and backend denials consume IP quota                        |
| CORS                        | Unapproved origin 403; approved preflight 204                               |
| Health                      | Unavailable backend affects readiness, not process liveness                 |
| Configuration               | No JWT settings required; obsolete policy fields and unsafe config rejected |

From the gateway directory:

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd run build
npm.cmd test
npm.cmd run test:cov
```

The commands above are for the maintainer. Static checks/build do not prove that
the tests pass. The fixture enables all six destinations for routing coverage;
the shipped configuration enables only MAD.

Staging acceptance must cover real subsystem authentication/authorization,
frontend BFF integration, cookie/header contract compatibility, Redis failure and
multi-replica quotas, trusted proxy addresses, TLS, load and graceful shutdown.
