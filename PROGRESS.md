# OnboardFlow build progress

Source of truth for the design: `SPEC.md` (revision 2, including its Review log in Section 23).
This file records where the build stands so a later agent can continue without re-deriving state.

## Commit plan position

Current: commit 14 of 25 (Tier 1) done.

| # | Commit (SPEC Section 21) | Status |
|---|---|---|
| 1 | chore: scaffold Workers + Vite + React app with strict TS projects | done |
| 2 | feat(shared): stage registry, role model, domain vocabularies, step budget | done |
| 3 | feat(db): D1 migrations | done |
| 4 | feat(seed): deterministic synthetic dataset | done |
| 5 | feat(auth): Access JWT verification, dev keys, persona login, CSRF | done |
| 6 | feat(auth): role policy matrix and principal loading | done |
| 7 | feat(sims): simulators with atomic idempotency | done |
| 8 | feat(sims): ordered fault pipeline | done |
| 9 | feat(integrations): client | done |
| 10 | feat(db): guarded mutations and API idempotency store | done |
| 11 | feat(agents): CaseAgent commands, wake-ups, workflow control, callbacks | done |
| 12 | feat(workflow): D1 gates and the eight stages end to end | done |
| 13 | feat(workflow): recovery, approvals, restart, terminate, fallbacks | done |
| 14 | feat(agents): blocker rules, nudges, follow-up drafting, scheduled scans | done |
| 15 | feat(agents): OpsHubAgent reconcile and read-only subscriptions | next |
| 16 | feat(api): REST routes | todo |
| 17 | feat(api): dev eval hooks | todo |
| 18 | feat(web): app shell, dev login, routing, API client, employee portal | todo |
| 19 | feat(web): approvals, queue, cases, case detail with audit trail | todo |
| 20 | feat(web): live dashboard | todo |
| 21 | feat(eval): 60-scenario catalog | todo |
| 22 | feat(eval): harness, standard and scale modes, metrics | todo |
| 23 | ci | todo |
| 24 | docs: README, CONTEXT.md, ADRs | todo |
| 25 | chore(eval): record results, render README results, tag v1-tier1 | todo |

## Check status (last run)

- `npm run typecheck`: pass
- `npm test`: pass (23 files, 190 tests)
- `npm run build`: pass (`check-bundle` ok)
- `npm run typegen:check`: up to date

## Deviations from SPEC.md

1. `scripts/check-bundle.ts` accepts `var CaseAgent = class extends ...` as well as `class CaseAgent`. Vite 8 (Rolldown) emits the former; the anonymous class still gets `.name === "CaseAgent"` through ECMAScript name inference, which is what Agent callbacks rely on.
2. `/dev/personas` returns 3 personas per role except admin, which has 2: the seed defines exactly 2 admins (SPEC 16), so "3 per role" (SPEC 9) cannot hold for admins. Coordinators are one per department.
3. `scripts/dev-keys.ts` exports `generateDevSecrets()`; `vitest.config.ts` imports it for the per-run test key pair (the spec's `makeTestKeys()`), and the eval harness will reuse it.

4. `canRetryStage` falls back to the stage's owning department when the stage has no open blocker (SPEC 6.2 names only the blocker's department). Without it, a coordinator retrying a stage that is not blocked would get 403 instead of the guarded 409 that R14 expects.

5. Simulated IT `assign-licenses` takes an optional `approvalRef` alongside `{ bundle, privileged }`: SPEC 9.1 requires a 422 for "privileged without approval flag" but the body it lists carries no approval field. IT reads the employment type from the simulated HR worker record for the bundle check.

6. `startCase` does not store its API response inside the claim batch (unlike the other commands): a lost claim is not a conflict, and storing the response before `ensureInstance` would make a same-key retry replay instead of creating a missing instance. A failed create returns 503 (the API releases the key on 5xx), so any retry converges. `created` in the response reports whether this call created the workflow instance.
7. `case-agent.test.ts` grows over commits: the scan, nudge and follow-up cases (SPEC 11.1) land with the rule engine in commit 14, since `scanBlockers` only refreshes until then.

8. Commit 12 already contains the code paths for recovery rounds and approval reject/resubmit (the stage runner and approval loop are one mechanism with their happy path); commit 13 adds their tests (workflow-retries, -recovery, -approvals, -restart) and any fixes they force.
9. Test and eval seam: `CaseAgent.startCase(cmd, limits)` passes tighter loop bounds (for example `waitBudget: 2`) to the workflow, which honors them only when `EVAL_HOOKS=on`. Used by the wait-budget test so it runs in seconds instead of 120 bounded waits.
10. Task gates mark the stage `waiting_on_employee` inside the first failed gate check step and ping the CaseAgent with non-durable `reportProgress`, instead of a separate step plus `sendEvent`; this keeps the worst-case step count at the SPEC's 561.

11. Blocker rule details the SPEC leaves open: `employee_task_overdue` is one blocker per waiting stage (subject `checklist:<stage>`, detail lists the overdue task ids) rather than one per task; integration and data-issue blockers auto-resolve only once the blocked operation succeeds after the blocker opened (or the stage completes), which is what R13 expects; auto-resolved and manually resolved blockers cancel their open follow-up. The stub provider records `drafted_by = "stub"` (not `llm:`), so the LLM rate metric stays honest.
12. The Workers AI provider (Tier 2) is not built; `LLM_PROVIDER=workers-ai` yields a provider that always fails, so drafting falls back to templates.

## Environment notes

- Shared machine: use only `wrangler dev --port 8781 --inspector-port 9231`, and llama-server on 8110 if ever needed. Kill every wrangler/workerd/llama process you start.
- Node 25.9 on this Mac; CI targets Node 24.
