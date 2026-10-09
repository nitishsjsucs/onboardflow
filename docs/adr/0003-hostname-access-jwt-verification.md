# 0003: Hostname Access application; the Worker verifies the JWT itself

Status: accepted (2026-10-08)

## Context

Cloudflare's Worker-level Access integration does not support WebSocket connections (upgrades fail with 403), and the live dashboards are WebSockets. Local development and tests also need to exercise the same verification code without a Cloudflare account.

## Decision

Production puts a self-hosted (hostname) Access application in front of the Worker. The Worker verifies `Cf-Access-Jwt-Assertion` (or the `CF_Authorization` cookie) with `jose`: RS256 only, issuer and audience enforced, `exp`, `iat` and `email` required (jose checks `exp` only when it is present), keys from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`. In dev and tests the same `verifyAccessJwt` runs against a locally generated JWKS; `/dev/login` (localhost only) mints Access-shaped tokens.

## Consequences

One verification path for all environments. Placeholder Access settings fail closed. Production Access is unverified until the owner deploys; until then the honest wording is "Access-compatible RS256 JWT verification".
