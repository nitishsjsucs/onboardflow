# OnboardFlow build progress

Source of truth for the design: `SPEC.md` (revision 2, including its Review log in Section 23).
This file records where the build stands so a later agent can continue without re-deriving state.

## Commit plan position

Current: Tier 1 complete (commits 1 to 25), tagged `v1-tier1`. Tier 2: commits 26 to 31 done; the llama run of commit 31 was recorded by builder 2 in a follow-up commit once the machine was awake. Four extra harness fixes came out of the Tier 2 recording round, plus one README rendering fix; both ablations were then re-recorded without a host stall and chaos was run a fourth time (listed in the table and in `eval/results/CHANGELOG.md`). Every planned commit in SPEC Section 21 is done. Builder 3 re-ran typecheck, tests and build from a clean tree, found the likely cause of the one intermittent test failure (a race in the test, not in the product) and fixed the test. A fixer round then worked through three independent reviews (correctness, security, honesty); every finding, its verdict and its commit are under "Review findings" below. The fixer round stopped before committing its fifth chaos run and its docs; builder 2 (second pass, 2026-10-09) re-ran every check, committed that run, recorded a standard run that includes every review fix, pinned the cost center restart limitation with two tests, and committed the docs. Builder 3 (third pass, 2026-10-09 11:33 PDT onward) started from a clean tree at 4582fb2, re-ran every check (all pass, see "Check status"), found no planned commit, eval, README, ADR or CI work left, and recorded the current state of `origin` (How to continue, item 7). No eval was re-run in that pass. A second fixer round (2026-10-09 from about 11:55 PDT) then worked through three more independent reviews (correctness, security, honesty); every finding, its verdict and its commit are under "Review findings (second round)" below, and new evals were recorded at the end of that round (see "Check status"). Nothing has been pushed from this repository; the remote `origin` is set to https://github.com/nitishsjsucs/onboardflow.git, and a copy of this history is being published there by a process outside these sessions (How to continue, item 7).

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
| (extra) | docs: README with status, architecture, design decisions, local setup and roadmap (cdb20da) | done; the only commit without the Co-Authored-By trailer (see deviation 27) |
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
| (extra) | fix(eval): watch chaos host stalls from a healthy server onward | done; first exercised by the fifth chaos run (de6740d), which found no stall |
| (extra) | test(workflow): wait for the first IT call row before comparing it with the manager decision | done (builder 3; see "Known noise and caveats") |
| (extra) | fix(agents): refuse sub-agent paths and forged SDK headers on live subscriptions (a294819) | done (fixer, security review) |
| (extra) | fix(workflow): block a completed stage when its replay fails after a restart (39840f1) | done (fixer, correctness review) |
| (extra) | fix(integrations): replay the stored workspace preference on re-execution (68effc0) | done (fixer, correctness review) |
| (extra) | fix(eval): count chaos completion only within the case deadline (edb495d) | done (fixer, honesty review) |
| (extra) | feat(eval): record each run's command, commit at start and tree state (0459a03) | done (fixer, honesty review) |
| (extra) | test(eval): cover chaos aggregates (eb514dc) | done (fixer, correctness review) |
| (extra) | fix(api): fail closed on foreign cursors, internal errors and inconsistent accounts (2fdf494) | done (fixer, security review) |
| (extra) | fix(agents): lock the license bundle once the manager's approval is requested (45198a2) | done (fixer, security review) |
| (extra) | test(workflow): take the gate tests' check counts out of the timeout race (2760116) | done (fixer, correctness review) |
| (extra) | chore(eval): record a standard run after the review fixes (6248014) | done |
| (extra) | fix(agents): re-check live subscriptions before every state push (9c55e58) | done (fixer, security review) |
| (extra) | chore(eval): record a fifth chaos run under the deadline rule (de6740d) | done (run by the fixer at 6248014, committed by builder 2) |
| (extra) | fix(eval): describe a late chaos completion as first seen after the deadline (35ebbec) | done (wording only) |
| (extra) | chore(eval): record a standard run after the last review fix (d8b4d20) | done (builder 2) |
| (extra) | test(workflow): pin the cost center replay limitation after a restart (934fab2) | done (builder 2) |
| (extra) | docs: README, PROGRESS and CHANGELOG after the review fixes (4582fb2) | done (builder 2; the commit after 934fab2) |
| (extra) | docs: PROGRESS after re-verifying the final state (10f3b4a) | done (builder 3, third pass; PROGRESS.md only) |
| (extra) | fix(workflow): resume closeout at its approved round and count activation rounds from it (f25b018) | done (second fixer round, correctness review) |
| (extra) | fix(agents): make restart reopen a final rejection and store its response in its batch (447aa02) | done (second fixer round, correctness review) |
| (extra) | fix(api): judge the dev host guard on the routing path and refuse all but /sim/* (fa9aaec) | done (second fixer round, security review) |
| (extra) | fix(agents): debounce the hub reconcile for at least its window (2ded851) | done (second fixer round; root cause of the CI flake the honesty review found) |
| (extra) | fix(auth): require token expiry and fail closed when re-checking live subscriptions (68429a3) | done (second fixer round, security review) |
| (extra) | fix(sims): compare SIM_API_KEY in constant time (4e0446c) | done (second fixer round, security review) |
| (extra) | ci: read-only token and actions pinned to commit SHAs (2557158) | done (second fixer round, security review; not yet run in Actions) |
| (extra) | fix(web): reuse the Idempotency-Key per user action until its answer is final (f420833) | done (second fixer round, correctness review) |
| (extra) | fix(eval): count scripted completion only by the deadline and expect no undeclared blockers (c61517f) | done (second fixer round, correctness and honesty reviews) |
| (extra) | test: make the step budget and simulator abort tests check what they claim (f23651b) | done (second fixer round, correctness review) |
| (extra) | feat(eval): stamp each build and refuse to measure one that is not HEAD's (99ee919) | done (second fixer round, honesty review) |
| (extra) | fix(scripts): demo driver reports the mix it observes and fails on a difference (ac066dd) | done (second fixer round, honesty review) |
| (extra) | docs: README, PROGRESS and the published SHA map after the second review round | done (second fixer round; the commit after ac066dd) |

## Check status (last run, 2026-10-09, builder 3 third pass)

- At 4582fb2 (clean tree, AC power), 11:33 to 11:37 PDT: `npm run typecheck` pass; `npm test` pass (45 files, 364 tests, 73 s); `npm run build` pass (`check-bundle` ok); `npm run typegen:check` up to date; `npm run seed:check` ok (sha256 56851eead5f6b2a6e9d22866bf9dd5e7533ccb4f20cc0d3270a09839a1f9a85e); `npm run deploy:dry-run` pass (2190.05 KiB upload, 502.32 KiB gzip), followed by `npm run build` to restore the dev build. No eval was run in this pass.
- With this pass's PROGRESS.md edit in the tree (the only change), 11:37 to 11:39 PDT: `npm run typecheck` pass; `npm test` pass (45 files, 364 tests); `npm run build` pass.

Earlier pass (builder 2, second pass):

- At the starting state (9c55e58 plus the fixer's uncommitted fifth chaos run and docs), 11:21 to 11:26 PDT: `npm run typecheck` pass; `npm test` pass (45 files, 362 tests); `npm run build` pass (`check-bundle` ok); `npm run typegen:check` up to date; `npm run seed:check` ok (sha256 56851eead5f6b2a6e9d22866bf9dd5e7533ccb4f20cc0d3270a09839a1f9a85e); `npm run deploy:dry-run` pass (2190 KiB upload, 502 KiB gzip), followed by `npm run build` to restore the dev build.
- At 934fab2 (the code of the final commit; the docs commit after it changes no code), 11:30 to 11:33 PDT: `npm run typecheck` pass; `npm test` pass (45 files, 364 tests: the 362 plus the two cost center restart tests); `npm run build` pass. `npx vitest run --project node` (93 tests, which include the README results drift test) passed at de6740d and 35ebbec, and the README results drift test at d8b4d20.
- `npm run eval:ci` at 35ebbec (clean tree, 11:27 PDT): 60/60 completed and passed, CI gate passed (committed in d8b4d20).
- Recorded results (all committed in `eval/results/`, rendered into the README by `npm run results:readme`; `test/node/readme-results.test.ts` guards drift; full account in `eval/results/CHANGELOG.md`):
  - `npm run eval:ci`: every standard run is 60/60 completed and passed with 0 duplicates, audit coverage 1, hub consistent, CI gate passed: git f5c8cfb (after the backoff fix), 2760116 (after the review fixes, 1 transport retry), and 35ebbec (latest, 2026-10-09 11:27 PDT, the first with 9c55e58, 0 transport retries, no host stall).
  - `npm run eval:scale` (git f5c8cfb): two runs, both committed. 148/150 (two harness requests got a local runtime plain-text 500), then 150/150 (latest).
  - `npm run eval:chaos`, five runs on seeds 1 to 5, all committed. Run 5 (6248014 at start, clean tree, 2026-10-08 21:30 PDT, AC power, lid open, 945 s; committed in de6740d; latest) is the first under the deadline rule and the first with the post-setup stall watch: 289/300, per-seed 57, 58, 60, 58, 56 (mean 0.9633, min 0.9333, max 1.0), 0 duplicates, 0 transport, control or bot request errors, no host stall, all 11 misses deadlines (none of those cases had completed by the end of its seed), no failed case, slowest counted case 170.5 s. It predates 9c55e58 (the harness opens no live subscription). Runs 1 to 4 were counted under the old rule (late completions counted; see the CHANGELOG). Run 1 (6f9a11d) 230/300, invalid seed 3 (outage window never ended, harness bug). Run 2 (a510536) 210/300, with 248 bot requests lost to dropped local proxy connections. Run 3 (5e2635b) 280/300: per-seed mean 0.933, min 0.85, max 1.0; seed 5 overlapped a system sleep, so seeds 1 to 4 (228/240) are its clean part. Run 4 (c04aeb7, 20:22 PDT, lid open, 983 s) 287/300: per-seed 58, 57, 58, 58, 56 (mean 0.9567, min 0.9333, max 0.9667), 0 duplicates, 0 transport or control retries, 12 deadlines and 1 `case_failed` (seed 3 E059, `recovery_rounds_exhausted` at Facilities). Its detector counted one 5.8 s gap in seed 1, flagged in the README; the power log shows no sleep, and that watch window included the blocking `prepareDatabase` setup.
  - `npm run eval:ablate`, two pairs, all committed. Latest (e082bc2, 20:14 PDT, no host stall, no transport retry): keys off 60/60 completed, 50/60 passed, 28 duplicate side effects, 39 s; retries off 44/60 completed, 43/60 passed, 0 duplicates, 205 s. First pair (5e2635b, through system sleep): keys off 59/60, 50/60, 27 duplicates (R05 timed out in a stall; R06 one duplicate fewer, a restart race); retries off identical counts.
  - `npm run eval:llama` (git 697c8fc, started 20:09 PDT, lid open, no host stall): 60/60 completed and passed, 0 duplicates, 20 follow-ups all drafted by Qwen3-1.7B, 100% schema-valid, category agreement 100%, p50 2874 ms. Validity and agreement are close to guaranteed (schema-constrained output, the prompt names the rule kind); the README says so.
- No wrangler, workerd or llama process of this repo is left running; `eval/.state` is removed.

## How to continue

1. Read SPEC.md Sections 12.3 (chaos), 12.4 (metrics) and 21, `eval/results/CHANGELOG.md`, then this file's deviations.
2. Every planned commit is done and every review finding of both rounds is fixed or pinned, except one verified minor finding that is deferred with a reason (early checklist completion, "Review findings (second round)"). The clean chaos run that was wanted exists (run 5, no flagged seed). Nothing else is required before the user's verification and push. If anyone records another run: commit every run (never only the better one), add a CHANGELOG line, then `npm run results:readme` and update the README's "Reading these results" notes to match. A chaos run takes about 16 minutes; run it on AC power with the lid open.
3. Chaos mode lives in `eval/harness/chaos.ts` (orchestrator and bots) and `eval/harness/policies.ts` (pure seeded policies). The HTTP layer with same-key transport retries is `Harness` in `eval/harness/actions.ts`; the host stall detector is `eval/harness/host.ts`. Shared run helpers are in `eval/harness/server.ts` so `run.ts` and `chaos.ts` do not import each other (a top-level-await cycle deadlocks Node).
4. Before any eval: commit, then `npm run build` (dev build). The harness refuses a build that was not made from HEAD on a clean tree (`dist/build-info.json`); `--allow-unmatched-build` exists for unrecorded experiments only. Use only port 8781 / inspector 9231 on this machine; the harness defaults to them and kills its process group at the end. Other repositories run their own test suites on this Mac at the same time; expect load.
5. Never edit scenarios, fault tables or bot policies toward a target; log any harness change in `eval/results/CHANGELOG.md`.
6. Deployment (README "Deploy") needs a Cloudflare account and is the user's step; nothing has been deployed or pushed.
7. The published copy on `origin`, and what a publisher must do. State as read on 2026-10-09 at about 12:22 PDT with read-only GitHub API calls (`gh api`, `gh run`; nothing fetched into this repository, its refs unchanged, nothing pushed from it):
   - `origin/main` (2ded851 at that time) is a rewrite of this history, published by a process outside these build sessions. Its commits are authored as nitishsjsucs, carry no `Co-Authored-By` trailer, and match this history commit for commit by author date and subject, plus one extra commit, d6df50f `chore: point measured-commit references at the published history`. It already includes the first four commits of the second fixer round (through 2ded851), published within minutes of being committed here; later commits were not on it yet. `eval/results/published-sha-map.json` (generated 19:22 UTC) maps every local SHA to its published one and lists the commits not yet published; regenerate it the same way (pair by author date and subject) before relying on it.
   - The README the published copy serves is the post-review README of 4582fb2 (published as 4582fb2) with remapped SHAs, so the honesty review's first blocking finding (published README still pre-fix) no longer held at verification time.
   - `main` on GitHub has failed CI since d6df50f: that commit rewrote the expected strings of two tests in `test/node/eval-metrics.test.ts` (c04aeb7 to c04aeb7, f5c8cfb to f5c8cfb) but not the fixture SHAs they are rendered from (runs 37973000400, 37973630262, 37975982146, 37978395725: 2 failed, 362 passed). c61517f here replaces those fixtures with synthetic SHAs (1111111..., 2222222...) that no remap touches; main turns green only after that change is published (if the published file still carries the remapped expectations, the publisher must take this repository's version of the file).
   - Rules for whoever publishes: (a) a SHA remap may touch citations only: the README, PROGRESS.md, `eval/results/CHANGELOG.md`, and nothing under `test/` (test SHAs are fixtures). (b) Do not edit `eval/results/*.json`: they are harness output; use `published-sha-map.json` instead. The published copy did edit them (`gitSha` and `provenance.headAtStart` in all 24 files in d6df50f); if those edits stay, the published README and CHANGELOG must say so, as this repository's README now does. (c) Commit message bodies on the published copy still cite local SHAs (for example d8b4d20 cites 35ebbec and de6740d cites 6248014); the map resolves them. (d) Run `npm run typecheck` and `npm test` on the rewritten tree before pushing it. (e) Whether commits keep the `Co-Authored-By` trailer is the user's decision under SPEC Section 20 row 6; it is not something an agent copies from the published copy.
   - A plain `git push` from here would be rejected (unrelated histories), and a force push would discard the published rewrite. This repository pushes nothing; publishing is the user's step.

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

27. Commit cdb20da (`docs: README with status, architecture, design decisions, local setup and roadmap`, 2026-10-08 15:11 PDT) sits between commits 15 and 16. It is not in the SPEC commit plan, its body only repeats the subject, and it is the only commit without the `Co-Authored-By: Claude Opus 5.5` trailer (checked by grepping every commit body). It was not rebased: a rebase would change every later SHA, and the committed `eval/results/*.json` files and the README Results cite those SHAs. Whether to keep the history as is (and how the trailer question of SPEC Section 20 row 6 is settled) is the user's decision before the first push.
28. Fixer round (after three independent reviews). Product: `markBlocked` may move a `complete` stage to `blocked` (a replay after a restart can fail), and `runOp` fails the case as `workflow_error` if marking blocked changes nothing; the workspace step starts from the stored preference and treats a 422 `idempotency_key_reuse` as "try the next preference"; `fixField` refuses a `licenseBundle` change once a manager approval exists unless an open `data_issue` blocker is on that field (409 `field_locked_by_approval`); cursors are type-checked (400 `invalid_cursor`) and unexpected errors return a generic message; `loadPrincipal` refuses accounts whose role does not match the staff row (coordinators need a department); `/agents/*` accepts only `/agents/<class>/<name>`, strips SDK-internal headers, and both agents refuse sub-agents; agents re-check live subscriptions before every state push. Test seam: `RunLimits.gateWaitTimeoutMs` (EVAL_HOOKS only). Harness: chaos completion requires `complete` within the 180 s deadline and bots stop at the deadline; cases count as started only after an accepted start; runs record their command, commit at start and tree state. All logged in `eval/results/CHANGELOG.md`.

29. Closeout shares `case_stages.round` between its approval rounds and the recovery rounds of `hr.activate-worker`. Instead of a new column, `run.begin` also reads each checkpoint's approved round; the approval loop resumes there, and `runOp` counts `MAX_STAGE_ROUNDS` from the round the approval was granted in (`RunCtx.roundBase`, 1 for every other stage). SPEC 8.3's `round >= maxStageRounds` is therefore `round - roundBase + 1 >= maxStageRounds`. No new steps.
30. SPEC 6.1 lets an admin restart a case that ended `approval_rejected_final` but does not say what the restart does. Here the restart batch opens one more approval round (stage round + 1, guarded on the rejected approval of that round, recorded as `reopenedApproval` in the `case.restarted` audit detail). A rejection of the reopened round is final again; each admin restart grants one more round, so a checkpoint can exceed MAX_APPROVAL_ROUNDS only through audited admin restarts.
31. `restartCase` stores its 202 in its own batch (SPEC 9) with the current instance id, and replaces the stored body if the new-revision fallback takes over. Workflow control after the commit never makes the API fail: a failure schedules `convergeRestart` (2, 4, 8, 16, 32 s), which creates the recorded revision's instance or retries the restart until the instance runs or the case has moved on.
32. SPEC 5.2 guard 1 lists `/api/*`, `/agents/*` and `/dev/*` as covered. The guard is inverted and judged on the routing path: in dev mode on a non-loopback host every Worker path except `/sim/*` is refused, so `/` and unknown paths get 500 `dev_auth_on_public_host` there instead of 404. Static assets never reach the Worker (`run_worker_first`), so the SPEC's exemption for them still holds.
33. The Agents SDK stores schedule times in whole seconds rounded down, so `schedule(1, ...)` can fire almost at once. The hub debounce schedules at a time rounded up to the next whole second, so it waits between `HUB_DEBOUNCE_S` and `HUB_DEBOUNCE_S + 1` seconds. Other schedules (scans, failure confirmation, restart convergence) keep the SDK's rounding; their exact delay does not matter.
34. SPEC 17's "reuse the key when the same action is retried" is implemented once for every mutation (`src/web/api/action-keys.ts`): an action is its name and input; the key is kept while the outcome is unknown (network error, unparsable answer, 5xx, 409 `idempotency_in_progress`) and dropped after any final answer, so a final 409 is not replayed forever.
35. Harness: standard and scale completion require that the terminal wait saw `complete` by the deadline; a scenario without declared blockers expects none; every run records its build (`dist/build-info.json` stamp and a hash of `dist/` at start and end) and refuses a build not made from HEAD on a clean tree unless `--allow-unmatched-build`. All logged in `eval/results/CHANGELOG.md`.
36. `verifyAccessJwt` requires `exp`, `iat` and `email` (SPEC 10.1 names issuer and audience only); live subscription re-checks fail closed (a connection whose check throws is closed, and a CaseAgent whose check fails pushes no state).

## Review findings (fixer round, 2026-10-08)

Each finding was checked before acting on it. "Verified" says how. Commits are listed in the table above.

Correctness review:
- Important, restart deadlock when a replay fails on a completed stage (run-context.ts markBlocked): verified, the new restart test timed out at "run 2 blocks intake" without the fix. Fixed in 39840f1 (also fails the case as `workflow_error` if marking blocked still changes nothing).
- Important, workspace preference cannot be replayed after a desk conflict (facilities.ts): verified, the new restart test and a client-level test failed (422 key reuse) without the fix. Fixed in 68effc0. The same drift for `hr.create-worker` after a cost center correction followed by a restart is not fixed; it now ends as an audited data issue instead of hanging, and the README lists it under known limitations. Builder 2 pinned both paths with tests in 934fab2 (retries fail with 422 `idempotency_key_reuse` until `recovery_rounds_exhausted`, one worker; restoring the old cost center lets the replay through).
- Important, no test for `chaosAggregate`: verified with grep. Fixed in eb514dc.
- Minor, live-websocket frame test polled a frozen copy: verified by reading. Fixed in a294819 (polls the live list; checks the pushed frame shows the task completed).
- Minor, request validation test skipped 404s: verified by reading. Fixed in 2fdf494 (inserts the pending approval; every probe must be 400).
- Minor, workflow-gates exact check counts depend on the 1 s bounded wait: verified by reading the tests and `vitest.config.ts`. Fixed in 2760116 with an EVAL_HOOKS-only `gateWaitTimeoutMs` limit; the counts are unchanged.
- Minor, restart test cleared the outage before run 2 had blocked: verified by reading. Fixed in 39840f1 (waits for the run 2 `stage.blocked` audit and 5 run 2 attempts).
- Minor, approvals test compared call completion with the decision: verified (`integration_calls.created_at` is written after the fetch). Fixed in 45198a2 (asserts the pause directly, then compares the call start).
- Minor, `startedCases` counted before the start ran: verified in run.ts (and chaos counted every case). Fixed in edb495d.
- Minor, blocker-rules test never checked a not-started case: verified. Fixed in 2760116.

Security review:
- Blocking, sub-agent paths (`/agents/case-agent/E130/sub/ops-hub-agent/...`): verified, the new test got 101 without the fix. Fixed in a294819.
- Blocking, forged `x-cf-agents-subagent-url` header: verified, the new test saw identity `ops-hub-agent` without the fix. Fixed in a294819 (forwarded request rebuilt without `x-cf-agents-*` and `x-agents-*` headers; agents refuse sub-agents in `onBeforeSubAgent`).
- Minor, the approval is not bound to what is provisioned: verified by reading. Fixed differently from the suggested fix in 45198a2. Provisioning from the approved `request_json` was rejected because it would break the documented F6 IT correction flow (the approved bundle is the corrupted one, and the coordinator's correction must apply on retry). Instead the bundle is locked once a manager approval exists, except to correct an open data issue on it.
- Minor, live subscriptions authorized only at the upgrade: verified by reading. Fixed in 9c55e58: the route passes the subscriber (email, token expiry) in a server-owned header, the agents store it on the connection, and before every state push (CaseAgent refresh, OpsHubAgent reconcile, which also runs every 60 s) they close sockets whose token expired (4401) or whose account no longer passes `canSubscribe` (4403). A socket on a case that never changes is re-checked only when that case or the hub next changes.
- Minor, cursor decoding and leaked D1 error text: verified with the reviewer's probes as tests. Fixed in 2fdf494.
- Minor, department scoping fails open for a coordinator without a department: verified by reading the schema and `loadPrincipal`. Fixed in 2fdf494.

Honesty review:
- Blocking, chaos counted cases that completed after their deadline: verified in the committed files (run 4 counts chaos-1-E017 at 180,528 ms and chaos-1-E020 at 180,401 ms; run 3 four such cases; run 2 thirty-six). Fixed in edb495d, covered by a fake-timeline test, and chaos was run again (fifth run, committed in de6740d). The old runs stay committed; the CHANGELOG lists what each counted.
- Minor, "bot patience" is 0 by construction: verified (patience 3 retries per blocker, a blocker stays open across rounds, `MAX_STAGE_ROUNDS` 4 fails the case first). README and CHANGELOG now say so; the policy is unchanged.
- Minor, README presented Access verification without the caveat: fixed in the README (Access-compatible wording; production Access, remote D1, deploy and CI listed as never exercised).
- Minor, this file claimed builder 3 re-ran every check: corrected above; this round re-ran all of them (see check status).
- Minor, commit cdb20da missing from this file and without the trailer: verified. Added to the table and as deviation 27; not rebased.
- Minor, README numbers no script produced ("about 2 s" setup timing, "150 of them" hung messages): removed from the README; the CHANGELOG keeps the setup timing only as an ad hoc measurement.
- Minor, the README command was inferred from the mode: fixed in 0459a03; older runs are labeled as inferred.
- Minor, "same-site Origin": corrected to same-origin in the README.
- Minor, Node 22.18 "works" and CI read as having run: README now says tested on Node 25.9 only and that CI first runs after the first push.

Rejected findings: none. One fix differs from the suggestion (approval binding, above).

## Review findings (second round, 2026-10-09)

Each finding was verified before acting on it: a new regression test that failed on the old code (said as "failed before the fix"), a probe, or a read of the code, the published repository or its CI logs. Commits are in the table above.

Correctness review:
- Important, closeout approval and recovery rounds share `case_stages.round` (restart after an activation retry requests a second sign-off): verified, the new restart test (E119) timed out without the fix, and a closeout approved in round 2 lost its last activation round (E106 test). Fixed in f25b018 (deviation 29).
- Important, restart cannot recover an `approval_rejected_final` case: verified, the new test (E120) found the stage back at round 3 and the case failed again without the fix. Fixed in 447aa02 (deviation 30).
- Important, restart did not store its response, so a same-key retry after a failure past the commit restarted twice: verified, the new API test got 500 then a second restart without the fix. Fixed in 447aa02 (deviation 31).
- Minor, web pages minted a new Idempotency-Key per click and the queue buttons were not disabled while pending: verified by reading; the new web test failed before the change. Fixed in f420833 (deviation 34).
- Minor, standard and scale counted a case completed after its deadline: verified in `run.ts`. Fixed in c61517f; no recorded run had a deadline miss in those modes.
- Minor, 21 scenarios without blocker expectations were never checked for spurious blockers: verified (O03 to O08, O11 to O20, R06, R07, R08, R14, R16). Fixed in c61517f; none of them had a blocker in any recorded standard run.
- Minor, the hub debounce test did not prove one reconcile: verified; it now asserts version 0 before the window and exactly 1 after (2ded851), together with the product fix for the flake below.
- Minor, a restart test name claimed a re-armed schedule it never checked: verified; the test now checks it (f25b018).
- Minor, the step budget test's eval configuration was a copy of production: verified. Fixed in f23651b.
- Minor, the simulator abort test never saw an abort after dispatch: verified with a probe (of AbortSignal.timeout(0..29 ms) only 0 ms aborted; workerd's clock does not advance during execution). Fixed in f23651b with three known abort timings.

Security review:
- Important, percent-encoded paths bypassed the dev host guard (`/%64ev/login` minted an admin token on a public host): verified, the new test got 200 without the fix. Fixed in fa9aaec (deviation 32).
- Minor, an employee can complete checklist tasks of a stage that has not started: verified by reading (`canCompleteTask` and the guarded UPDATE check only ownership and open status). Not fixed: the scripted scenarios depend on early completion (O07 completes paperwork while intake runs; every scripted happy path completes orientation tasks right after the manager approves), so the restriction needs a scenario catalog change and new runs. Listed in the README's known limitations.
- Minor, Access tokens without `exp` were accepted: verified (the new test got 200 for a token without exp, iat or email). Fixed in 68429a3.
- Minor, live subscription re-checks failed open: verified, both new tests failed before the fix. Fixed in 68429a3.
- Minor, SIM_API_KEY compared with string equality: verified by reading. Fixed in 4e0446c.
- Minor, CI token scope and actions pinned by tag: verified by reading. Fixed in 2557158 (SHAs resolved from the v4 tags via the GitHub API on 2026-10-09); not yet run in Actions.

Honesty review:
- Blocking, the published README still had the pre-fix wording: no longer true when verified. `origin/main` then carried 4582fb2, the published copy of 4582fb2, whose README differs from this one only in remapped SHAs (How to continue, item 7). No change needed beyond documenting the published copy.
- Blocking, the published main fails CI because the SHA remap changed two test expectations but not their fixtures: verified in the CI logs of all four runs since d6df50f. Fixed on this side in c61517f (synthetic fixture SHAs) and item 7 now says exactly what a remap may touch and requires typecheck and tests before a push. The published main stays red until that change is published.
- Important, README and PROGRESS said CI had never run: verified (16 runs on the published copy since 2026-10-08 23:14 UTC, on Node 24 and 25). README rewritten (CI paragraph, Node line, local column, "Not built" list); item 7 updated.
- Important, the published eval result files were edited after the fact without disclosure: verified (d6df50f rewrote `gitSha` and `provenance.headAtStart` in all of them). This repository's files are unedited harness output; `eval/results/published-sha-map.json` maps the SHAs, and the README Results preamble and the CHANGELOG now disclose the published edit.
- Important, Known noise omitted a second CI flake and called the approvals race unreproduced: verified in runs 37886812337 and 37877471758. Both are now under Known noise; the hub flake had a product cause, fixed in 2ded851.
- Minor, provenance did not tie the build to the recorded commit: verified. Fixed in 99ee919 (deviation 35).
- Minor, "Reading these results" did not say which runs predate the review-round fixes: verified; the notes now list them (docs commit after ac066dd, updated with the runs recorded in this round).
- Minor, the demo driver printed the planned mix: verified. Fixed in ac066dd; README now describes the plan and the driver's check.
- Minor, item 7's "the same way" was ambiguous about message SHAs and trailers: verified. Item 7 now lists what a remap may touch and leaves the trailer question to the user.

Rejected findings: none. One verified finding is not fixed (early checklist completion, reason above).

## Known noise and caveats

- Intermittent test, cause fixed in 9e24593: once locally (2026-10-08 about 20:46 PDT, under heavy load, message not captured) and once in GitHub Actions (run 37877471758, Node 24, on the published copy of 5e2635b), `test/worker/workflow-approvals.test.ts > does not start provisioning before the manager decides` failed. The CI log captured the message: `expected NaN to be greater than or equal to 1791460804422` at line 143, which is the diagnosed race: the test read `MIN(created_at)` of E104's IT calls as soon as `it_provisioning` was `active`, `IntegrationClient` writes a call row only when the call returns, so the query can return NULL in between and `Date.parse(null)` is NaN. The test now waits for the first IT row and keeps the same ordering assertion, so a real ordering bug would still fail it.
- Intermittent test with a product cause, fixed in 2ded851: in GitHub Actions run 37886812337 (Node 25 job, allowed to fail, on the published copy of 9c55e58), `test/worker/ops-hub-agent.test.ts > debounces an out-of-order burst of caseChanged into one reconcile ...` failed with `expected { dirty: 1, debounce_pending: 1 } to deeply equal { dirty: +0, debounce_pending: +0 }` at line 51, the whole file taking 131 ms. The Agents SDK floors schedule times to whole seconds, so the 1 s debounce could fire within milliseconds, in the middle of the burst; a later `caseChanged` then armed a second debounce that was still pending at the end. The debounce now waits at least its window (deviation 33), and the test asserts no reconcile before the window and exactly one after, without weakening the original assertions.

- Worker tests print `uncaught exception` lines (`Aborting engine: ...`, `broken.outputGateBroken`, `eval-evict`, occasional "Worker's code had hung"); they come from intentional failures, restarts, terminations and evictions. Tests assert outcomes.
- "Missing required secrets" warnings during tests and builds are expected (tests pass secrets as Miniflare bindings).
- Worker tests pin the simulated clock to 2026-10-08T12:00:00Z in `test/setup/apply-migrations.ts` (as the eval harness does), so overdue rules do not drift with the calendar. Real time is still used for JWT expiry and simulator timestamps.

## Environment notes

- Shared machine: use only `wrangler dev --port 8781 --inspector-port 9231`, and llama-server on 8110 if ever needed. Kill every wrangler/workerd/llama process you start.
- Node 25.9 on this Mac; CI targets Node 24 (required) and 25 (allowed to fail).
