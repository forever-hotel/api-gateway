# Gateway verification register

Execution: **not run**, respecting the user's existing preference. Actual results,
coverage and evidence links are pending. All cases are high-priority isolated
integration/unit tests in `test/gateway.test.ts`; upstreams are temporary local
HTTP servers with test-only tokens. No database or real provider is contacted.

| Case                      | Input/precondition                                                                         | Expected outcome                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Public login / forwarding | Raw JSON and spoofed identity/forwarding/cookie headers                                    | Body preserved; unsafe headers removed; no upstream cookie passed back   |
| Protected routing         | Active manager and booking query                                                           | MAD prefix/query preserved; verified identity and bearer forwarded       |
| Token validity            | Missing, malformed, wrong signature/algorithm, expired or wrong staff duration             | 401 before business upstream                                             |
| Role/session gates        | Worker, inactive manager, forced password change                                           | 403/401; session endpoint remains available to pending-change staff      |
| Auth outage/logout        | Auth returns 503                                                                           | Business request fails closed; valid logout reaches MAD local revocation |
| Upstream faults           | Timeout, 500 with private text, redirect                                                   | 504/503/502 without private body leakage                                 |
| Route boundary            | Disabled/unknown prefix, encoded traversal, unsupported Auth method                        | 404/400 with no upstream call                                            |
| Limits / CORS             | Oversized body, repeated login, disallowed origin                                          | 413/429/403 with retry metadata for quota                                |
| Guest stay                | Matching active room, then inactive stay                                                   | Success then 401                                                         |
| Read-only roles           | Manager allowed only GET/HEAD                                                              | GET succeeds; DELETE denied                                              |
| Readiness                 | Healthy upstream then unavailable origin                                                   | Ready 200 then 503; liveness stays 200                                   |
| Configuration             | Short key, trust-all proxy, credentials in URL, unsafe production config, duplicate prefix | Startup validation fails                                                 |

Run from the gateway root:

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd run build
npm.cmd test
npm.cmd run test:cov
```

Separate staging evidence is required for Redis limits shared by multiple gateway
replicas, Redis outage behavior, TLS issuance/renewal, trusted-proxy IP handling,
load, shutdown under traffic and real service/Auth contracts. The fixture tests do
not establish those results.
