# 0005: Simulated systems served by the same Worker, called over loopback HTTP

Status: accepted (2026-10-08)

## Context

The workflow integrates with HR, IT and Facilities systems that do not exist. The integration code should still face real HTTP semantics: status codes, headers, `Idempotency-Key`, `Retry-After`, timeouts.

## Decision

The three systems are simulators under `/sim/*` in the same Worker (`src/worker/sims/`), protected by `X-Sim-Api-Key`, and the `IntegrationClient` calls them through the loopback `exports.default.fetch` (on by default since compatibility date 2025-11-17). Each POST runs one fixed pipeline: auth, required key, pre-execution faults, replay, validation, one atomic batch (idempotency row as the lock, resource, side-effect ledger), post-execution fault. `SIM_BASE_URL` can point at an external simulator.

## Consequences

One deployable unit and one local process. The systems are simulations and are labeled as such in the UI and the README, including in production.
