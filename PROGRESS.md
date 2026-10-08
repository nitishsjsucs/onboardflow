# OnboardFlow build progress

Source of truth for the design: `SPEC.md` (revision 2, including its Review log in Section 23).
This file records where the build stands so a later agent can continue without re-deriving state.

## Commit plan position

Current: commit 1 of 25 (Tier 1) done.

| # | Commit (SPEC Section 21) | Status |
|---|---|---|
| 1 | chore: scaffold Workers + Vite + React app with strict TS projects | done |
| 2 | feat(shared): stage registry, role model, domain vocabularies, step budget | next |
| 3 | feat(db): D1 migrations | todo |
| 4 | feat(seed): deterministic synthetic dataset | todo |
| 5 | feat(auth): Access JWT verification, dev keys, persona login, CSRF | todo |
| 6 | feat(auth): role policy matrix and principal loading | todo |
| 7 | feat(sims): simulators with atomic idempotency | todo |
| 8 | feat(sims): ordered fault pipeline | todo |
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
- `npm test`: pass (no test files yet; `passWithNoTests`)
- `npm run build`: pass (`check-bundle` ok)
- `npm run typegen:check`: up to date

## Deviations from SPEC.md

1. `scripts/check-bundle.ts` accepts `var CaseAgent = class extends ...` as well as `class CaseAgent`. Vite 8 (Rolldown) emits the former; the anonymous class still gets `.name === "CaseAgent"` through ECMAScript name inference, which is what Agent callbacks rely on.
2. `scripts/dev-keys.ts` exports `generateDevSecrets()`; `vitest.config.ts` imports it for the per-run test key pair (the spec's `makeTestKeys()`), and the eval harness will reuse it.

## Environment notes

- Shared machine: use only `wrangler dev --port 8781 --inspector-port 9231`, and llama-server on 8110 if ever needed. Kill every wrangler/workerd/llama process you start.
- Node 25.9 on this Mac; CI targets Node 24.
