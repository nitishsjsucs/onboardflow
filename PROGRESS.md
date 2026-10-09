# OnboardFlow build progress

Source of truth for the design: `SPEC.md` (revision 2, including its Review log in Section 23).
This file records where the build stands so a later agent can continue without re-deriving state.

## Commit plan position

Current: Tier 1 complete (commits 1 to 25), tagged `v1-tier1`. Tier 2 in progress: commits 26 (chaos), 27 (ablations) and 28 (Workers AI provider, llama eval mode, LLM metrics, llm:smoke) done; next is commit 29 (Integrations and Audit explorer pages). Nothing has been pushed; the remote `origin` is set to https://github.com/nitishsjsucs/onboardflow.git.

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
| 15 | feat(agents): OpsHubAgent reconcile and read-only subscriptions | done |
| 16 | feat(api): REST routes | done |
| 17 | feat(api): dev eval hooks | done |
| 18 | feat(web): app shell, dev login, routing, API client, employee portal | done |
| 19 | feat(web): approvals, queue, cases, case detail with audit trail | done |
| 20 | feat(web): live dashboard | done |
| 21 | feat(eval): 60-scenario catalog | done |
| (extra) | fix(workflow): re-resolve the CaseAgent when a callback stub is broken | done |
| 22 | feat(eval): harness, standard and scale modes, metrics | done |
| 23 | ci | done |
| 24 | docs: README, CONTEXT.md, ADRs | done |
| 25 | chore(eval): record results, render README results, tag v1-tier1 | done |
| (extra) | test(agents): push a live state frame on an employee task completion | done |
| (extra) | fix(workflow): apply exponential retry backoff once, not compounded by the engine | done |
| 26 | feat(eval): chaos mode with seeded fault schedules and policy bots (T2) | done |
| 27 | feat(eval): idempotency and retry ablations (T2) | done |
| 28 | feat(llm): Workers AI provider, llama eval mode, LLM metrics, llm:smoke (T2) | done |
| 29 | feat(web): integrations and audit explorer pages (T2) | next |
| 30 | feat(scripts): demo driver (T2) | todo |
| 31 | chore(eval): record chaos, ablation and llama results (T2) | todo |

## Check status (last run, 2026-10-08)

- `npm run typecheck`: pass (worker, web, node projects)
- `npm test`: pass (41 files, 310 tests: worker in workerd, node, web)
- `npm run build`: pass (`check-bundle` ok)
- `npm run typegen:check`: up to date
- `npm run seed:check`: ok (sha256 56851eead5f6b2a6e9d22866bf9dd5e7533ccb4f20cc0d3270a09839a1f9a85e)
- `npm run deploy:dry-run`: pass (2179 KiB upload, 499 KiB gzip). It leaves a production-flattened dist/, so run `npm run build` again before any eval.
- `npm run eval:ci` (recorded, git 1a18873): 60/60 completed, 60/60 passed, 0 duplicate side effects, audit coverage 1, hub consistent, CI gate passed. File: `eval/results/latest-standard-stub.json`.
- `npm run eval:scale` (recorded, git 1a18873): 150/150 completed, 0 duplicates, hub consistent. File: `eval/results/latest-scale-stub.json`.
- README Results block rendered from those files by `npm run results:readme`; `test/node/readme-results.test.ts` guards drift.
- The recorded standard and scale runs predate the retry backoff fix (e7c0f3e), which changed retry timing (not outcomes). Re-record them in the Tier 2 results commit (31) together with chaos, and log it in `eval/results/CHANGELOG.md`.
- Chaos (not yet recorded): trial runs on seed 1 only; see `eval/results/CHANGELOG.md`. Trial result files are deleted, not committed.

## How to continue

1. Read SPEC.md Sections 12.3 (chaos), 12.4 (metrics) and 21 (Tier 2 list), then this file's deviations.
2. Chaos mode lives in `eval/harness/chaos.ts` (orchestrator and bots) and `eval/harness/policies.ts` (pure seeded policies, tested in `test/node/chaos-policy.test.ts`); `npm run eval:chaos` runs 5 seeds (about 20 minutes on this Mac). Shared run helpers (ROOT, EVAL_VARS, snapshot, hub consistency) are in `eval/harness/server.ts` so `run.ts` and `chaos.ts` do not import each other (a top-level-await cycle deadlocks Node).
3. Before any eval: `npm run build` (dev build). Use only port 8781 / inspector 9231 on this machine; the harness defaults to them and kills its process group at the end.
4. Never edit scenarios or fault tables toward a target; log any change in `eval/results/CHANGELOG.md`.

## Deviations from SPEC.md

1. `scripts/check-bundle.ts` accepts `var CaseAgent = class extends ...` as well as `class CaseAgent`. Vite 8 (Rolldown) emits the former; the anonymous class still gets `.name === "CaseAgent"` through ECMAScript name inference, which is what Agent callbacks rely on.
2. `/dev/personas` returns 3 personas per role except admin, which has 2: the seed defines exactly 2 admins (SPEC 16), so "3 per role" (SPEC 9) cannot hold for admins. Coordinators are one per department.
3. `scripts/dev-keys.ts` exports `generateDevSecrets()`; `vitest.config.ts` imports it for the per-run test key pair (the spec's `makeTestKeys()`), and the eval harness reuses it.
4. `canRetryStage` falls back to the stage's owning department when the stage has no open blocker (SPEC 6.2 names only the blocker's department). Without it, a coordinator retrying a stage that is not blocked would get 403 instead of the guarded 409 that R14 expects.
5. Simulated IT `assign-licenses` takes an optional `approvalRef` alongside `{ bundle, privileged }`: SPEC 9.1 requires a 422 for "privileged without approval flag" but the body it lists carries no approval field. IT reads the employment type from the simulated HR worker record for the bundle check.
6. `startCase` does not store its API response inside the claim batch (unlike the other commands): a lost claim is not a conflict, and storing the response before `ensureInstance` would make a same-key retry replay instead of creating a missing instance. A failed create returns 503 (the API releases the key on 5xx), so any retry converges. `created` in the response reports whether this call created the workflow instance.
7. `case-agent.test.ts` grew over commits: the scan, nudge and follow-up cases (SPEC 11.1) landed with the rule engine in commit 14.
8. Commit 12 already contained the code paths for recovery rounds and approval reject/resubmit (the stage runner and approval loop are one mechanism with their happy path); commit 13 added their tests.
9. Test and eval seam: `CaseAgent.startCase(cmd, limits)` passes tighter loop bounds (for example `waitBudget: 2`) to the workflow, which honors them only when `EVAL_HOOKS=on`. Used by the wait-budget test so it runs in seconds instead of 120 bounded waits.
10. Task gates mark the stage `waiting_on_employee` inside the first failed gate check step and ping the CaseAgent with non-durable `reportProgress`, instead of a separate step plus `sendEvent`; this keeps the worst-case step count at the SPEC's 561.
11. Blocker rule details the SPEC leaves open: `employee_task_overdue` is one blocker per waiting stage (subject `checklist:<stage>`, detail lists the overdue task ids) rather than one per task; integration and data-issue blockers auto-resolve only once the blocked operation succeeds after the blocker opened (or the stage completes), which is what R13 expects; auto-resolved and manually resolved blockers cancel their open follow-up. The stub provider records `drafted_by = "stub"` (not `llm:`), so the LLM rate metric stays honest.
12. The Workers AI provider (`src/worker/llm/workers-ai.ts`) is built and unit tested with a fake binding; without the AI binding (everywhere except env.production) `LLM_PROVIDER=workers-ai` yields a provider that always fails, so drafting falls back to templates. It has never run against Cloudflare.
13. Hub rollups count `revision_requested` stages as `waiting`; incidents use open `integration_outage` and `provisioning_stalled` blockers detected in the last 15 minutes, grouped by system.
14. API details the SPEC leaves open: `PATCH /api/employees/:id` takes exactly one field per request (each correction is its own audited change); `/api/me/checklist` also returns the employee's open `blockers` for the portal; approval list items carry `resubmittable`; People Ops coordinators see closeout approvals plus rejected approvals of both checkpoints; every response carries `X-Request-Id` (the audit test correlates audit rows by it). `cases.scan` writes no user audit row of its own (what it opens or resolves is audited as agent actions), so the audit test excludes it with that reason.
15. Eval hooks: the `/api/dev/*` guard runs before authentication so the paths are plain 404s outside dev mode; every hook mutation goes through the same Idempotency-Key wrapper (a replayed clock advance does not advance twice). Profile corruption is audited as `eval.fault_set` with `detail.corrupt`, since the closed AuditAction catalog has no separate corruption action. The hooks are not in `API_ROUTES` (that registry lists the product API the role matrix covers); `eval-hooks.test.ts` checks they are admin only. `DELETE /api/dev/faults` also accepts `system`.
16. Scenario catalog extensions, each needed to script a SPEC 12.2 scenario honestly: Action gains `start` (O16 duplicates the start request), `concurrent` (R12's three concurrent scans), `expectBlockerStatus` (R13's "blocker stays open" and R02/R03's escalation checks), an optional `value` on `fixField` (R09's wrong fix), an optional `system` on `clearFaults` (R10's sequential outages) and an optional `expectStatus` on `retryStage` (R14's 409). Expectations gain `auditCounts`. Archetypes may also pin `equipmentProfile` and `startDate`. O07 holds intake with one 1.5 s rate-limited HR call so the employee demonstrably finishes paperwork before the gate is checked. Scenarios that move the shared simulated clock (O10, R02, R03) are marked `movesClock` and run serially after all others, because the clock is global to the server. Builders live in `eval/scenarios/script.ts`.
17. Eval harness details: the simulated clock is pinned to `2026-10-08T12:00:00Z` (the seed's reference date) at the start of every run through `/api/dev/clock/advance`, which accepts negative values for this; without it, running the eval after 2026-10-19 would make the committed seed's paperwork overdue for every case. Mode `chaos`, the ablations and `--llm llama` are Tier 2 and refuse to run with a clear message. The harness defaults to `--port 8781 --inspector-port 9231` (this machine's allocation; SPEC 12.1 says "free port"); CI uses the same defaults. A preflight logs in as an admin and round-trips a scan before any scenario.
18. An extra commit (`fix(workflow): re-resolve the CaseAgent when a callback stub is broken`) sits between commits 21 and 22: the first trial eval found a real bug (O19, R07 stranded after a CaseAgent eviction), logged in `eval/results/CHANGELOG.md`. `OnboardingWorkflow` overrides the SDK's `notifyAgent` to re-resolve the agent by name once, then drop the callback.
19. Web: the client bundle is about 445 KB raw (137 KB gzip), mostly `agents/react` and its socket client. The live hooks use `useAgent` with `onStateUpdate`; tests mock them.

20. Chaos mode choices (also in `eval/results/CHANGELOG.md`): chaos runs use the production retry base (2 s) and a 1 s poll interval (`CHAOS_VARS`), because its faults, outage windows and bots run in real seconds; and instead of SPEC 12.3's single 4-day clock advance (which cannot make any committed-seed task overdue from the pinned 2026-10-08) the harness jumps 90 days at a seeded 5 to 15 s and then advances 3 days every 20 s. Faultable operations are the nine POST operations; `stall` applies to the three polled resources. The orchestrator (not a bot) clears a stall a seeded 5 to 30 s after its stage starts and applies photo corruption after paperwork (as in F6). Coordinator bots retry or give up only when the case shows the stage blocked. People Ops also signs off closeouts after a seeded delay (SPEC 12.3 does not say who does). Chaos case failures are classified `case_failed`, `bot_patience` (a bot gave up on one of its blockers) or `deadline`.
21. `DELETE /api/dev/faults` also accepts `ids` (chaos ends outage windows and stalls by id).
23. LLM: `--llm llama` (standard mode only) starts llama-server on port 8110 (this machine's allocation; SPEC 12.1 says 8080) with `-np 1 -c 8192 -ngl 99 --jinja` unless one is already healthy there, and stops it if it started it. LLM metrics come from the `followup.created` audit detail (`llm.provider`, `latencyMs`, `error`), which the scan now records. The draft schema moved to `src/shared/followup-draft.ts` so `scripts/llm-smoke.ts` (a raw request with the same shape) needs no worker types. Trial (not recorded): 4 of 4 follow-ups drafted by Qwen3-1.7B were schema-valid, p50 about 1.9 s; `npm run llm:smoke` returned a valid draft in 1.4 s.
22. Ablations (`npm run eval:ablate`) rerun the 60 scripted scenarios with `IDEMPOTENCY_KEYS=off` (simulator key handling off; API keys stay on) or `RETRY_LIMIT=0`, without a gate. Trial (not recorded): with keys off, F-it-lost-response wrote 2 device orders and R11 3; with retries off, F-it-transient stayed blocked.

## Known noise and caveats

- Worker tests print `uncaught exception` lines (`Aborting engine: ...`, `broken.outputGateBroken`, `eval-evict`, occasional "Worker's code had hung"); they come from intentional failures, restarts, terminations and evictions. Tests assert outcomes.
- "Missing required secrets" warnings during tests and builds are expected (tests pass secrets as Miniflare bindings).
- Worker tests pin the simulated clock to 2026-10-08T12:00:00Z in `test/setup/apply-migrations.ts` (as the eval harness does), so overdue rules do not drift with the calendar. Real time is still used for JWT expiry and simulator timestamps.

## Environment notes

- Shared machine: use only `wrangler dev --port 8781 --inspector-port 9231`, and llama-server on 8110 if ever needed. Kill every wrangler/workerd/llama process you start.
- Node 25.9 on this Mac; CI targets Node 24 (required) and 25 (allowed to fail).
