# 0002: Gates are D1 predicates; events are only wake-ups

Status: accepted (2026-10-08)

## Context

The local Workflows engine deletes every buffered and delivered event when an instance restarts (`wipeRestartState` in miniflare 5.20261006.1-alpha). A prototype gate that treated the event as the data deadlocked after a restart. The SDK's `waitForApproval` also treats a rejection as an error, while a rejection here is a normal branch (revise and resubmit).

## Decision

Every wait is a gate (`src/worker/workflows/gates.ts`): a D1 predicate (`src/worker/agents/gate-predicates.ts`) checked in a step before waiting, a `waitForEvent` with a bounded timeout, then a re-check. Events (`wake_<stage>`) carry a round and a reason, are validated and logged, and are never trusted. A wait budget (120 waits by default) bounds the loop; only an exhausted budget fails a case. The CaseAgent's scan nudges any waiting stage whose gate already holds in D1. `approveWorkflow` and `waitForApproval` are not used.

## Consequences

A gate already satisfied in D1 passes on its first check, which makes restarts safe (tests assert `checks: 1` after restart). A lost wake-up costs one bounded wait or one scan interval; a stale one costs one extra check. Overdue approvals and tasks surface as blockers rather than timeouts.
