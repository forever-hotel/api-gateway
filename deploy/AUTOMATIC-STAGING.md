# Automatic api-gateway staging

After final-head peer approval and merge to develop, the existing CI and image publication jobs run. A successful publication automatically deploys that same run's images using the SHA-pinned shared infra action. There is no second infra PR or extra deployment approval for routine code releases.

Profile: gateway. Publication artifact: gateway-release-image. Progress: this repository's Actions run, Deploy api-gateway to staging. Only this service's allowlisted containers are replaced. Gateway/WebSocket releases additionally check all managed apps and public frontends.

Settings: SERVICE_STAGING_ENABLED=true, STAGING_HOST, STAGING_USER; develop-only (or development-only here) staging environment with encrypted STAGING_SSH_KEY and STAGING_KNOWN_HOSTS. Source branch for this repository is develop. These settings were configured with owner authorization.

The shared action independently verifies the source repository, latest release commit and final-head peer approval. It uses approved VM configuration, shared locks and previous-image recovery. It does not apply SQL or edit env files, routes, Caddy or broker settings. Coordinate compatible database and configuration changes separately. Run browser business checks after deployment; readiness is not full feature verification.

Shared implementation and tests: forever-hotel/infra commit ec9d483c73910945b224bd66682b69b2a15eb10c, docs/SERVICE-AUTODEPLOY.md. Review and merge the infra action PR before approving this service PR. Future shared-action updates require a reviewed pin change. Production is unchanged.

A full-system infra release must align its selected images with successful service receipts. The updated infra controller rejects conflicts to avoid silently reverting automatically deployed services.
