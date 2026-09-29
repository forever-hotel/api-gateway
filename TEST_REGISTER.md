# Gateway verification register

Execution: **not run**, as requested. Results and coverage are pending.
Cases in test/gateway.test.ts use temporary local HTTP servers, without Redis,
central Auth, a database or JWT generation.

For the last gateway implementation change, Node's TypeScript syntax-only checks passed without executing
source or tests. Full typecheck, lint, formatting verification and build remain
unverified: dependencies are missing, the offline installation could not complete,
and permission to download dependencies was declined.

| Case | Expected behavior |
| --- | --- |
| Authentication path rewriting | Longest prefix selects the specific auth route (current fixture: /mad/auth/login to /auth/login) |
| Six subsystems | Each route reaches its own backend |
| Opaque auth | Missing/malformed/bearer credentials reach backend unchanged |
| Cookie request isolation | Only the destination's named cookies pass |
| Cookie response scope | Separate headers, no Domain, subsystem Path, attributes preserved |
| Production cookies | Secure added; missing SameSite defaults to Lax |
| Logout | Cookie cleared with identical subsystem scope on 204 |
| CSRF transport | Origin and X-CSRF-Token forwarded; unsafe cookie calls without approved Origin denied |
| Credentialed CORS | Exact origin with Access-Control-Allow-Credentials: true |
| Backend auth errors | 401/403 and domain error body retained |
| Fault handling | Timeout 504; backend 500 becomes safe 503; redirects 502 |
| Boundaries and limits | Invalid paths rejected; bounded bodies; local IP quotas |
| Health | All enabled upstreams affect readiness, not process liveness |
| Configuration | No Redis/JWT needed; all shipped subsystem routes enabled |
| Cookie configuration | Duplicate cross-subsystem names and __Host-* names rejected |

Maintainer commands, from the gateway directory:

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd run build
npm.cmd test
npm.cmd run test:cov
```

Browser/staging acceptance must verify real subsystem cookie login/logout,
expiration, SameSite behavior, frontend credentials, CSRF validation, all six
backend contracts, TLS, trusted addresses, load and shutdown. The gateway
does not implement backend authentication or shared rate counters across replicas.

## Per-subsystem acceptance

Use this handoff table for every team. All entries below are pending real-provider
evidence; the local fixtures do not establish deployment compatibility.

| Subsystem | Route and health | Login and expiry | Permissions and CSRF | Cookies and logout | Frontend/BFF |
| --- | --- | --- | --- | --- | --- |
| MAD | Pending | Pending | Pending | Pending | Pending |
| HW | Pending | Pending | Pending | Pending | Pending |
| FDS | Pending | Pending | Pending | Pending | Pending |
| FOSS | Pending | Pending | Pending | Pending | Pending |
| KMS | Pending | Pending | Pending | Pending | Pending |
| WKMS | Pending | Pending | Pending | Pending | Pending |

Record the API version, environment, owner and evidence for each completed cell.
Use that subsystem's real credential schema, endpoint paths and authorization
rules. Mark an inapplicable feature with a reason, such as a bearer-only API
that does not issue cookies, instead of claiming a cookie test passed.
