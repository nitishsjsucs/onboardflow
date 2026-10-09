# OnboardFlow build progress

Source of truth for the design: `SPEC.md` (revision 2, including its Review log in Section 23).
This file records where the build stands so a later agent can continue without re-deriving state.

## Commit plan position

Current: Tier 1 complete (commits 1 to 25), tagged `v1-tier1`. Tier 2: commits 26 to 31 done; the llama run of commit 31 was recorded by builder 2 in a follow-up commit once the machine was awake. Four extra harness fixes came out of the Tier 2 recording round, plus one README rendering fix; both ablations were then re-recorded without a host stall and chaos was run a fourth time (listed in the table and in `eval/results/CHANGELOG.md`). Every planned commit in SPEC Section 21 is done. Builder 3 re-ran every check from a clean tree, found the likely cause of the one intermittent test failure (a race in the test, not in the product) and fixed the test. Nothing has been pushed; the remote `origin` is set to https://github.com/nitishsjsucs/onboardflow.git.

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
| 29 | feat(web): integrations and audit explorer pages (T2) | done |
| 30 | feat(scripts): demo driver (T2) | done |
| (extra) | fix(eval): report non-JSON responses with their request and status | done |
| (extra) | fix(eval): chaos orchestrator applies its schedule through runtime errors | done |
| (extra) | fix(eval): retry requests the local proxy drops, with the same Idempotency-Key | done |
| (extra) | feat(eval): flag runs during which the host slept or stalled | done |
| 31 | chore(eval): record chaos, ablation and llama results (T2) | done: chaos and ablations in 697c8fc; the llama run in the next two rows |
| (extra) | fix(eval): list the stub standard run before the local-LLM run in the README | done |
| 31 (cont.) | chore(eval): record the local-LLM run and update README results | done |
| (extra) | chore(eval): re-record both ablations on an awake machine | done |
| (extra) | chore(eval): record a fourth chaos run on an awake machine | done |
| (extra) | fix(eval): watch chaos host stalls from a healthy server onward | done (typechecked; not yet exercised by a chaos run) |
| (extra) | test(workflow): wait for the first IT call row before comparing it with the manager decision | done (builder 3; see "Known noise and caveats") |

## Check status (last run, 2026-10-08 20:57 PDT, builder 3, at 9e24593)

- `npm run typecheck`: pass (worker, web, node projects)
- `npm test`: pass (45 files, 335 tests: worker in workerd, node, web), twice: once at e78af45 before any change (20:53) and once after the test fix (20:56)
- `npm run build`: pass (`check-bundle` ok)
- `npm run typegen:check`: up to date (last run by builder 2)
- `npm run seed:check`: ok (last run by builder 2) (sha256 56851eead5f6b2a6e9d22866bf9dd5e7533ccb4f20cc0d3270a09839a1f9a85e)
- `npm run deploy:dry-run`: pass, last run by builder 2 (2182 KiB upload, 500 KiB gzip). It leaves a production-flattened dist/, so run `npm run build` again before any eval.
- Recorded results (all committed in `eval/results/`, rendered into the README by `npm run results:readme`; `test/node/readme-results.test.ts` guards drift; full account in `eval/results/CHANGELOG.md`):
  - `npm run eval:ci` (git f5c8cfb, after the backoff fix): 60/60 completed, 60/60 passed, 0 duplicates, audit coverage 1, hub consistent, CI gate passed.
  - `npm run eval:scale` (git f5c8cfb): two runs, both committed. 148/150 (two harness requests got a local runtime plain-text 500), then 150/150 (latest).
  - `npm run eval:chaos`, four runs on seeds 1 to 5, all committed. Run 1 (6f9a11d) 230/300, invalid seed 3 (outage window never ended, harness bug). Run 2 (a510536) 210/300, with 248 bot requests lost to dropped local proxy connections. Run 3 (5e2635b) 280/300: per-seed mean 0.933, min 0.85, max 1.0; seed 5 overlapped a system sleep, so seeds 1 to 4 (228/240) are its clean part. Run 4 (c04aeb7, latest, 20:22 PDT, lid open, 983 s) 287/300: per-seed 58, 57, 58, 58, 56 (mean 0.9567, min 0.9333, max 0.9667), 0 duplicates, 0 transport or control retries, 12 deadlines and 1 `case_failed` (seed 3 E059, `recovery_rounds_exhausted` at Facilities). Its detector counted one 5.8 s gap in seed 1, flagged in the README; the power log shows no sleep, and that watch window included the blocking `prepareDatabase` setup.
  - `npm run eval:ablate`, two pairs, all committed. Latest (e082bc2, 20:14 PDT, no host stall, no transport retry): keys off 60/60 completed, 50/60 passed, 28 duplicate side effects, 39 s; retries off 44/60 completed, 43/60 passed, 0 duplicates, 205 s. First pair (5e2635b, through system sleep): keys off 59/60, 50/60, 27 duplicates (R05 timed out in a stall; R06 one duplicate fewer, a restart race); retries off identical counts.
  - `npm run eval:llama` (git 697c8fc, started 20:09 PDT, lid open, no host stall): 60/60 completed and passed, 0 duplicates, 20 follow-ups all drafted by Qwen3-1.7B, 100% schema-valid, category agreement 100%, p50 2874 ms. Validity and agreement are close to guaranteed (schema-constrained output, the prompt names the rule kind); the README says so.
- No wrangler, workerd or llama process of this repo is left running; `eval/.state` is removed.

## How to continue

1. Read SPEC.md Sections 12.3 (chaos), 12.4 (metrics) and 21, `eval/results/CHANGELOG.md`, then this file's deviations.
2. Commit 31 is complete (the llama run is recorded), both ablations were re-recorded cleanly and chaos ran a fourth time. Optionally run `npm run eval:chaos` (about 17 minutes) again on a quiet machine on power for a run with no flagged seed; it is also the first run with the chaos stall watch starting after setup: the harness now records host stalls and transport retries, so a clean run is self-evidently clean. Commit every run (never only the better one), add a CHANGELOG line, then `npm run results:readme` and update the README's "Reading these results" notes to match. Builder 3 did not run it: at 20:53 PDT the Mac was on battery at 8% and discharging, with about 18 minutes left, which is shorter than the run, and a run cut by sleep or shutdown would only add another flagged result.
3. Chaos mode lives in `eval/harness/chaos.ts` (orchestrator and bots) and `eval/harness/policies.ts` (pure seeded policies). The HTTP layer with same-key transport retries is `Harness` in `eval/harness/actions.ts`; the host stall detector is `eval/harness/host.ts`. Shared run helpers are in `eval/harness/server.ts` so `run.ts` and `chaos.ts` do not import each other (a top-level-await cycle deadlocks Node).
4. Before any eval: `npm run build` (dev build). Use only port 8781 / inspector 9231 on this machine; the harness defaults to them and kills its process group at the end. Other repositories run their own test suites on this Mac at the same time; expect load.
5. Never edit scenarios, fault tables or bot policies toward a target; log any harness change in `eval/results/CHANGELOG.md`.
6. Deployment (README "Deploy") needs a Cloudflare account and is the user's step; nothing has been deployed or pushed.
7. Before any push: on 2026-10-08 `git ls-remote origin` showed a `main` branch at c04aeb7, which is not in this repository's history (the repo was meant to be empty, and no push was made from here). It was not fetched or inspected; whoever pushes must decide what to do with it rather than force-push blindly.

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
22. Ablations (`npm run eval:ablate`) rerun the 60 scripted scenarios with `IDEMPOTENCY_KEYS=off` (simulator key handling off; API keys stay on) or `RETRY_LIMIT=0`, without a gate. Trial (not recorded): with keys off, F-it-lost-response wrote 2 device orders and R11 3; with retries off, F-it-transient stayed blocked.
23. LLM: `--llm llama` (standard mode only) starts llama-server on port 8110 (this machine's allocation; SPEC 12.1 says 8080) with `-np 1 -c 8192 -ngl 99 --jinja` unless one is already healthy there, and stops it if it started it. LLM metrics come from the `followup.created` audit detail (`llm.provider`, `latencyMs`, `error`), which the scan now records. The draft schema moved to `src/shared/followup-draft.ts` so `scripts/llm-smoke.ts` (a raw request with the same shape) needs no worker types. Trial (not recorded): 4 of 4 follow-ups drafted by Qwen3-1.7B were schema-valid, p50 about 1.9 s; `npm run llm:smoke` returned a valid draft in 1.4 s.
24. Demo driver (`npm run demo:drive`, SPEC 16): "the rest spread across the 8 stages" is read as 24 cases at each of the four human checkpoints and 3 at each of intake, IT, Facilities and provisioning verification, which can only hold a case under a simulated outage (a sustained per-employee 503), so those 12 are the "handful of faults". It reuses the eval harness (fresh local state, dev build, `EVAL_VARS`, pinned clock) and defaults to port 8787 like `serve:local`; on this machine run it with `--port 8781 --inspector-port 9231`. Verified here: the resulting local D1 holds exactly that mix with 12 open `integration_outage` blockers.

25. Eval harness transport handling (Tier 2 recording round, logged in `eval/results/CHANGELOG.md`): the harness HTTP layer retries a network error, or a 5xx whose body is not JSON, with the same Idempotency-Key for up to 75 s (wrangler dev's ProxyWorker drops connections under load and fails POSTs); chaos orchestrator control calls also retry 5xx and `409 idempotency_in_progress`; timed chaos actions no longer block the bots' loop; every run records transport retries and host stalls (`eval/harness/host.ts`). SPEC 12 does not describe transport handling; app answers are never retried.
26. Commit 31 is split in two: chaos and ablations were recorded in 697c8fc, and the llama run in a later commit, because the machine was asleep with the lid closed on battery when it was first due. The README Results block lists the stub run of a mode before its local-LLM run (a rendering fix, so the CI gate stays first).

## Known noise and caveats

- Intermittent test, probable cause fixed in 9e24593: once (2026-10-08 about 20:46 PDT), a full `npm test` under heavy load (two other repositories' wrangler and llama servers running, battery near 12%) failed `test/worker/workflow-approvals.test.ts > does not start provisioning before the manager decides`, without its message captured. The test read `MIN(created_at)` of E104's IT calls as soon as `it_provisioning` was `active`. `startStage` marks the stage active in its own step, and `IntegrationClient` writes a call row only when the call returns, so the query can return NULL in between; `Date.parse(null)` is NaN and the ordering assertion fails. Load widens that window. This was found by reading the code, not reproduced. The test now waits for the first IT row and keeps the same ordering assertion, so a real ordering bug would still fail it. If it ever fails again, capture the assertion output (`npx vitest run --project worker test/worker/workflow-approvals.test.ts`) before changing anything.

- Worker tests print `uncaught exception` lines (`Aborting engine: ...`, `broken.outputGateBroken`, `eval-evict`, occasional "Worker's code had hung"); they come from intentional failures, restarts, terminations and evictions. Tests assert outcomes.
- "Missing required secrets" warnings during tests and builds are expected (tests pass secrets as Miniflare bindings).
- Worker tests pin the simulated clock to 2026-10-08T12:00:00Z in `test/setup/apply-migrations.ts` (as the eval harness does), so overdue rules do not drift with the calendar. Real time is still used for JWT expiry and simulator timestamps.

## Environment notes

- Shared machine: use only `wrangler dev --port 8781 --inspector-port 9231`, and llama-server on 8110 if ever needed. Kill every wrangler/workerd/llama process you start.
- Node 25.9 on this Mac; CI targets Node 24 (required) and 25 (allowed to fail).
