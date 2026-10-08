# 0008: Guarded mutations with stamp-gated audits

Status: accepted (2026-10-08)

## Context

Two requests can race on one case (double-clicked approvals, concurrent retries), and Durable Object input gates do not block outbound I/O. A batched audit `INSERT` commits even when the guarded `UPDATE` changed nothing, which would record `approval.approved` for a request that got 409.

## Decision

Every change that can lose a race is one `UPDATE ... WHERE <guard>` that stamps `last_mutation_id` with the request's (or step's) id. The success audit, follow-on rows and the stored API response sit in the same `DB.batch` behind `WHERE EXISTS (row carries the stamp)`; the conflict audit and 409 response behind `NOT EXISTS` (`src/worker/db/guarded.ts`). Side effects outside D1 (workflow wake-ups) run after commit and are safe to lose.

## Consequences

Only the winner's audit row exists; a client retry after any later failure replays the stored response. Tests cover concurrent decisions and a blocker that loses to the open-dedupe index.
