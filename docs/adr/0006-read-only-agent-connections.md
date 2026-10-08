# 0006: No callable methods; agent connections are read-only

Status: accepted (2026-10-08)

## Context

`@callable()` needs the TC39 decorator transform, which Vite 8's Oxc does not do without an extra Babel plugin. More importantly, mutations should pass through one place that does Access auth, CSRF checks, role policy, Idempotency-Key handling and auditing.

## Decision

Browsers mutate only through the Hono REST API. WebSocket connections to `CaseAgent` and `OpsHubAgent` are state subscriptions: `shouldConnectionBeReadonly` returns true and `validateStateChange` rejects anything not from the server. `/agents/*` runs behind the same Access middleware, and `onBeforeConnect` checks Origin, the agent name and the subscription policy.

## Consequences

One audited mutation path. A client state write is refused with `cf_agent_state_error`.
