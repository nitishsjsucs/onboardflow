# 0001: D1 is the source of truth; agent state is a projection

Status: accepted (2026-10-08)

## Context

Case data is written from three places: Hono routes (through CaseAgent commands), workflow steps, and the CaseAgent's own blocker scans. Workflow steps can run more than once (retries, restarts), and SDK callbacks such as `reportProgress` are not durable and may repeat.

## Decision

All domain records live in D1. `CaseAgent` and `OpsHubAgent` state is recomputed from D1 (`src/worker/agents/projection.ts`) and carries `asOfSeq`, the highest audit sequence read in the same D1 batch; a projection older than the current state is never applied. Writes use deterministic primary keys (`src/shared/ids.ts`) and `INSERT OR IGNORE`, so a repeated step never writes twice.

## Consequences

Repeated or out-of-order callbacks are harmless: they only trigger another projection. A lost agent (eviction) loses nothing; the next call rebuilds its state from D1. The live views are read models, never a second store to reconcile.
