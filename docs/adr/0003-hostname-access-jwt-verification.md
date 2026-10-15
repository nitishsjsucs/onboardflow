# 0003: Hostname Access application; the Worker verifies the JWT itself

Status: accepted (2026-10-08)

## Context

Cloudflare's Worker-level Access integration does not support WebSocket connections (upgrades fail with 403), and the live dashboards are WebSockets. Local development and tests also need to exercise the same verification code without a Cloudflare account.

## Decision

Production puts a self-hosted (hostname) Access application in front of the Worker. The Worker verifies `Cf-Access-Jwt-Assertion` (or the `CF_Authorization` cookie) with `jose`: RS256 only, issuer and audience enforced, `exp`, `iat` and `email` required (jose checks `exp` only when it is present), keys from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`. In dev and tests the same `verifyAccessJwt` runs against a locally generated JWKS; `/dev/login` (localhost only) mints Access-shaped tokens.

## Consequences

One verification path for all environments. Placeholder Access settings fail closed. Production Access is unverified until the owner deploys; until then the honest wording is "Access-compatible RS256 JWT verification".

## Addendum (2026-10-15): service tokens

The production verification script drives cases through Access with a service token (a Service Auth policy on the same application). Access signs such a request's JWT without an `email` claim: `sub` is the empty string and `common_name` is the token's Client ID. `verifyAccessJwt` therefore requires `exp` and `iat`, and takes the identity from `email` when present, otherwise from a well-formed `common_name` with an empty `sub`, as `service-token:<client id>`. That identity contains no `@`, so no email login can ever map to it, and like any identity it grants nothing until an `app_users` row exists for it (the setup script provisions one admin row for its own token). Any other token without an email is still refused with 401.

