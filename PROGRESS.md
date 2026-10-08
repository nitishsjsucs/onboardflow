# OnboardFlow build progress

Source of truth for the design: `SPEC.md` (revision 2, including its Review log in Section 23).
This file records where the build stands so a later agent can continue without re-deriving state.

## Commit plan position

Current: commit 7 of 25 (Tier 1) done.

| # | Commit (SPEC Section 21) | Status |
|---|---|---|
| 1 | chore: scaffold Workers + Vite + React app with strict TS projects | done |
| 2 | feat(shared): stage registry, role model, domain vocabularies, step budget | done |
| 3 | feat(db): D1 migrations | done |
| 4 | feat(seed): deterministic synthetic dataset | done |
| 5 | feat(auth): Access JWT verification, dev keys, persona login, CSRF | done |
| 6 | feat(auth): role policy matrix and principal loading | done |
| 7 | feat(sims): simulators with atomic idempotency | done |
| 8 | feat(sims): ordered fault pipeline | next |
| 9 | feat(integrations): client | todo |
| 10 | feat(db): guarded mutations and API idempotency store | todo |
| 11 | feat(agents): CaseAgent commands, wake-ups, workflow control, callbacks | todo |
| 12 | feat(workflow): D1 gates and the eight stages end to end | todo |
| 13 | feat(workflow): recovery, approvals, restart, terminate, fallbacks | todo |
| 14 | feat(agents): blocker rules, nudges, follow-up drafting, scheduled scans | todo |
| 15 | feat(agents): OpsHubAgent reconcile and read-only subscriptions | todo |
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
- `npm test`: pass (node 2 files, worker 8 files)
- `npm run build`: pass (`check-bundle` ok)
- `npm run typegen:check`: up to date

## Deviations from SPEC.md

1. `scripts/check-bundle.ts` accepts `var CaseAgent = class extends ...` as well as `class CaseAgent`. Vite 8 (Rolldown) emits the former; the anonymous class still gets `.name === "CaseAgent"` through ECMAScript name inference, which is what Agent callbacks rely on.
2. `/dev/personas` returns 3 personas per role except admin, which has 2: the seed defines exactly 2 admins (SPEC 16), so "3 per role" (SPEC 9) cannot hold for admins. Coordinators are one per department.
3. `scripts/dev-keys.ts` exports `generateDevSecrets()`; `vitest.config.ts` imports it for the per-run test key pair (the spec's `makeTestKeys()`), and the eval harness will reuse it.

4. `canRetryStage` falls back to the stage's owning department when the stage has no open blocker (SPEC 6.2 names only the blocker's department). Without it, a coordinator retrying a stage that is not blocked would get 403 instead of the guarded 409 that R14 expects.

5. Simulated IT `assign-licenses` takes an optional `approvalRef` alongside `{ bundle, privileged }`: SPEC 9.1 requires a 422 for "privileged without approval flag" but the body it lists carries no approval field. IT reads the employment type from the simulated HR worker record for the bundle check.

## Environment notes

- Shared machine: use only `wrangler dev --port 8781 --inspector-port 9231`, and llama-server on 8110 if ever needed. Kill every wrangler/workerd/llama process you start.
- Node 25.9 on this Mac; CI targets Node 24.
