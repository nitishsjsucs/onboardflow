# OnboardFlow

An employee onboarding platform on Cloudflare Workers that coordinates setup across People Operations, IT and Facilities. Employees work a checklist, managers and People Ops approve at two checkpoints, and a durable workflow provisions accounts, devices, workspaces and badges through three **simulated** enterprise systems (HR, IT, Facilities). Coordination agents detect blockers, create follow-up tasks for the owning department, and keep live dashboards current. Every action lands in an append-only audit trail.

All 150 employees are synthetic. The HR, IT and Facilities systems are simulators that run inside the same Worker; nothing here talks to a real HRIS, identity provider, MDM or badge system.

What "agents" means here: `CaseAgent` and `OpsHubAgent` are [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/) classes (Durable Objects with SQLite, schedules, WebSocket state sync and workflow callbacks). Their decisions come from a deterministic rule engine, not from an LLM. An LLM, when one is configured, only drafts the wording of follow-up tasks; the default everywhere, including CI and production, is a deterministic stub ([ADR 0004](docs/adr/0004-rules-decide-llm-drafts.md)).

## What is in the box

- **Portal** (React 19, TypeScript, Vite): employee checklist with an 8-stage stepper, approvals, department queue, cases table, case detail with the audit trail, a live dashboard, integration health with per-case call logs, and an admin audit explorer. Four roles: employee, manager, coordinator (People Ops, IT or Facilities) and admin.
- **API** (Hono on Workers): every mutation requires `Idempotency-Key`, `X-OnboardFlow: 1` and a same-origin `Origin`, is checked against a role policy, and is written as a guarded D1 batch with its audit row ([ADR 0008](docs/adr/0008-guarded-mutations.md)).
- **Workflow** (Cloudflare Workflows): eight stages, retries with exponential backoff and Retry-After, polling of async resources, recovery rounds after a coordinator retries, two approval checkpoints with reject and resubmit (up to 3 rounds; an admin restart after the final rejection opens one more round), restart and terminate. Every wait is a D1 gate with a bounded timeout, so restarts and lost events cannot strand a case ([ADR 0002](docs/adr/0002-d1-gates-and-wake-up-events.md)).
- **Agents** (Agents SDK): one `CaseAgent` per employee (commands, wake-ups, blocker scans, follow-ups, read-only live state) and one `OpsHubAgent` (debounced reconcile of the dashboard from D1).
- **Simulated systems** under `/sim/*`: HR, IT and Facilities with idempotency keys honored atomically, async state machines, genuine validation errors, and injectable faults (503, 429 with Retry-After, timeout, lost response, malformed body, stall, desk conflict) ([ADR 0005](docs/adr/0005-loopback-simulated-systems.md)).
- **Auth**: Access-compatible RS256 JWT verification with `jose` (issuer and audience enforced; `exp`, `iat` and `email` required), not yet exercised against a real Cloudflare Access application or team JWKS. Locally, the same verifier runs against a generated key and a persona picker ([ADR 0003](docs/adr/0003-hostname-access-jwt-verification.md)).
- **Eval suite**: 60 scripted scenarios (20 onboarding, 24 integration failures, 16 recovery), a 150-employee scale run, a chaos mode (5 seeds of seeded faults and outages worked by generic policy bots), two ablations and an optional local-LLM run, all driven over HTTP as the real personas against `wrangler dev`.

## Architecture

```mermaid
flowchart LR
  SPA["React SPA"] -->|HTTPS + Access JWT| API["Hono /api/*<br/>auth, CSRF, policy,<br/>Idempotency-Key"]
  SPA -. "WebSocket (read-only)" .-> AR["/agents/*"]
  API -->|DO RPC| CA[("CaseAgent x150")]
  AR --> CA
  AR --> HUB[("OpsHubAgent")]
  CA -->|guarded SQL batch| D1[("D1")]
  CA -->|start, wake-ups| WF[["OnboardingWorkflow<br/>8 stages, D1 gates"]]
  WF -->|callbacks| CA
  WF -->|steps| D1
  WF --> IC["IntegrationClient"] -->|loopback HTTP| SIM["/sim/hr, /sim/it, /sim/facilities<br/>(simulated)"]
  SIM --> D1
  CA -->|caseChanged| HUB -->|reconcile| D1
```

Design decisions are recorded in [docs/adr](docs/adr) and the domain vocabulary in [CONTEXT.md](CONTEXT.md). The full build specification, including every API fact it relies on and how it was verified, is [SPEC.md](SPEC.md).

## Local versus production

| Concern | Local (this machine, and GitHub Actions for the published copy) | Production (after deploy) |
|---|---|---|
| Worker runtime | workerd via `vite dev`, `wrangler dev` on the build, and `@cloudflare/vitest-plugin` (Miniflare) | Cloudflare Workers |
| Front end | Vite dev server, or `dist/client` served by local assets | Workers static assets with SPA fallback |
| D1 | local SQLite under `.wrangler/state` or a `--persist-to` directory | D1 `onboardflow-prod` |
| Agents (Durable Objects, SQLite) | local Durable Objects | Durable Objects |
| Workflows | local Workflows engine; restart wipes delivered events (D1 gates make this harmless) | Cloudflare Workflows; restarting a terminated instance is unverified, so a new-revision fallback covers it |
| Auth | `AUTH_MODE=dev`: RS256 JWT minted by `/dev/login` with a locally generated key, verified by the same code as production; persona picker | `AUTH_MODE=access`: hostname Access application, `Cf-Access-Jwt-Assertion` verified against the team's JWKS with `iss` and `aud` |
| CSRF defenses | Origin + `X-OnboardFlow` + required `Idempotency-Key`; dev cookie `SameSite=Strict` | same checks; Access cookie set to `SameSite=Lax`, HttpOnly |
| Secrets | `.dev.vars` from `npm run dev:keys`; tests use Miniflare bindings; evals generate a fresh set per run | `wrangler secret put SIM_API_KEY` |
| LLM (follow-up wording only) | deterministic stub (default), or an OpenAI-compatible server such as llama-server with Qwen3-1.7B Q4_0 | stub by default; optionally Workers AI `@cf/qwen/qwen3-30b-a3b-fp8` through AI Gateway (built, never run) |
| HR, IT, Facilities | **simulated**, same Worker, `/sim/*` | **still simulated**, same Worker, `/sim/*` |
| Clock | real, or an offset clock with `SIM_CLOCK=on` (evals and tests) | real only |
| Fault injection, eval hooks, eviction route | `EVAL_HOOKS=on` in eval runs | off; the routes answer 404 |
| Eval suite | runs here against `wrangler dev` | not run (it needs the hooks and the simulated clock) |

The deployment to Cloudflare has not been done yet; until it is, everything in this README was run locally (workerd through Miniflare and `wrangler dev`).

CI: the copy of this repository published on GitHub runs `.github/workflows/ci.yml` in [GitHub Actions](https://github.com/nitishsjsucs/onboardflow/actions) on every push, on Node 24 (required) and Node 25 (allowed to fail), on ubuntu: typegen and seed checks, typecheck, tests, build, the standard eval with its CI gate, and a production deploy dry run. That copy is a rewrite of this history (different commit SHAs, no co-author trailers), and it was not pushed from this repository; [eval/results/published-sha-map.json](eval/results/published-sha-map.json) maps this history's SHAs to the published ones. Between 2026-10-08 23:14 UTC and 2026-10-09 20:32 UTC it ran 19 times: 14 green and 5 red. One red run (Node 24) came from an intermittent test race, fixed in the test since; in one green run the allowed-to-fail Node 25 job was red, from a hub debounce race fixed in the product since; both are described in PROGRESS.md under "Known noise". The other 4 red runs (2026-10-09 18:24 to 19:10 UTC) came from the SHA rewrite made for publishing, which changed the expected strings of two tests in `test/node/eval-metrics.test.ts` but not the fixture SHAs they derive from; those fixtures now use synthetic SHAs that no rewrite touches, and main has been green since that change was published (19:30 UTC), on both Node versions, with the current `ci.yml` (read-only token, actions pinned by commit SHA).

## Run it locally

Requirements: npm and Node. Developed and tested on Node 25.9 (macOS); GitHub Actions has run the checks of the published copy on Node 24 and 25 (ubuntu). `engines` allows 22.18 or later, but Node 22 has not been run.

```sh
npm ci
npm run dev:keys          # writes .dev.vars: a local RS256 key pair and SIM_API_KEY
npm run db:reset:local    # applies the D1 migrations and the committed synthetic seed
npm run dev               # Vite dev server with the Worker in workerd
```

Open the printed URL, pick a persona on the login page (three employees, three managers, one coordinator per department, two admins), start a case from **Cases** as the People Ops coordinator, and follow it through the employee portal, the approvals page and the live dashboard.

To serve the production-like build instead: `npm run build && npm run serve:local` (wrangler dev on the built Worker).

To see the dashboards with something on them, the demo driver fills the local state with a seeded mix of cases: it resets `.wrangler/state`, applies the migrations and the seed, starts `wrangler dev` on the build, pins the simulated clock, and drives all 150 employees over HTTP as the personas. Its seeded plan completes 42 cases and holds the rest in each of the eight stages: 24 each at the four human checkpoints (paperwork, manager approval, orientation, closeout approval), and 3 each at intake, IT, Facilities and provisioning verification, where only a simulated outage (a sustained 503 for that one employee) can hold a case, so those 12 show real integration blockers. At the end the driver reads every case back over the API, prints the mix it observed and exits non-zero if any case is not where the plan put it. Then `npm run serve:local` serves that state (on the real clock, without the eval hooks).

```sh
npm run build && npm run dev:keys
npm run demo:drive            # --port and --inspector-port if 8787/9229 are taken, --seed to reshuffle
npm run serve:local
```

### Checks

```sh
npm run typecheck       # strict TypeScript: worker, web and node projects
npm test                # vitest: worker tests inside workerd, node tests, web tests (happy-dom)
npm run build           # vite build + check that Agent class names survive bundling
npm run seed:check      # the committed seed is byte-identical to the generator
npm run typegen:check   # worker-configuration.d.ts matches wrangler.jsonc
npm run deploy:dry-run  # production bundle without credentials (run `npm run build` again afterwards)
```

### Eval

```sh
npm run build
npm run eval:ci       # 60 scripted scenarios, CI gate
npm run eval:scale    # all 150 synthetic employees, no faults
npm run eval:chaos    # 60 employees x 5 seeds, seeded faults and policy bots (about 20 minutes)
npm run eval:ablate   # the 60 scenarios with Idempotency-Key handling off, then with retries off
npm run eval:llama    # standard mode with llama-server (Qwen3-1.7B Q4_0, port 8110) drafting follow-up wording
npm run llm:smoke     # one structured-output request against the local llama-server
```

The harness creates a fresh local D1 per run (migrations and the committed seed), generates fresh secrets into that run's own `.dev.vars`, starts `wrangler dev` (port 8781 by default, `--port` to change), pins the simulated clock to 2026-10-08 (the seed's reference date, so results do not drift with the calendar), and plays each scenario over HTTP as the real personas. Results are written to `eval/results/`.

Read the standard numbers for what they are: every scenario is designed so a correct system finishes the case, with failures recovered automatically (retries, idempotent replay) or by the scripted action a real coordinator would take. Standard mode is therefore a regression suite (CI requires 60/60), not an estimate of completion under uncontrolled conditions.

The two ablations rerun the same scenarios with one mechanism switched off (Idempotency-Key handling in the simulated systems, or step retries), to show that the mechanism, not luck, produces the standard results.

Chaos mode is the informative measurement: `npm run eval:chaos` runs the same 60 employees for 5 seeds, each on a fresh local D1 and server, with no per-scenario script. A seeded injector faults about 30% of (employee, operation) pairs (some beyond the retry budget), opens 0 to 2 sustained outage windows of 10 to 60 s per system, and corrupts validated fields; generic seeded bots play the employees, managers, the three department coordinators and an admin, acting only on what the API shows them. Each case has 180 s: it counts as completed only if a poll saw it `complete` within that time, and the bots stop working a case once its deadline passes. The coordinator bots give up after 3 retries of one blocker, but the workflow's own limit comes first: a blocker stays open across rounds, so its third retry starts a stage's fourth round at the earliest, which is the last one, and if that round fails the workflow fails the case (at most 4 rounds per stage and 6 per case). So "bot patience" is 0 by construction, and the limit that applies is the workflow's recovery-round cap. The fault table and policies are in `eval/harness/policies.ts`; decisions taken before the first recorded run, and the trial runs behind them, are logged in `eval/results/CHANGELOG.md`.

## Results

Everything below is rendered by `npm run results:readme` from `eval/results/latest-*.json`, the files the harness wrote, unedited in this repository; a test fails if this block drifts from them. (The copy published on GitHub rewrote the commit SHA fields of every `eval/results` file to point at its own history, in its commit d6df50f; the map above resolves them.) Runs from 2026-10-09 19:00 UTC on also record which build they served: the harness refuses a build that is not from the commit the run starts at, and hashes `dist/` at the start and end of the run. These are local measurements on `wrangler dev` (Miniflare/workerd) on a laptop, with the simulated systems and the stub LLM provider (except the one run labeled as using a local LLM), not production numbers. Standard mode is the regression suite described above: its completion rate is close to guaranteed by construction and is not a measure of how often onboarding succeeds under uncontrolled failures.

<!-- results:start -->
#### Standard mode (regression suite, scripted recovery)

Command `node eval/harness/run.ts --mode standard --llm stub --gate ci` (via `npm run eval:ci`), run 2026-10-09 (git 3646803 at start, clean tree, built from that commit, dist/ unchanged during the run), provider `stub`, local wrangler dev (Miniflare/workerd), concurrency 6.

| Metric | Value |
|---|---|
| Cases started | 60 |
| Completed | 60/60 (100.0%) |
| Passed (completed and every expectation held) | 60/60 |
| onboarding | 20/20 passed |
| integration failure | 24/24 passed |
| recovery | 16/16 passed |
| Integration calls (retried, replayed) | 1280 (60, 27) |
| Duplicate side effects in the simulated systems | 0 |
| Harness requests retried after a dropped local proxy connection (still failed) | 0 (0) |
| Audit coverage (regression check) | 1 |
| Live hub equals D1 reconcile after the run | yes |
| Scenario time p50 / p95, wall time | 9.8 s / 20.6 s, 118 s |
| Host stalls over 5 s (system sleep or a frozen harness) | none |

#### Standard mode with a local LLM drafting follow-up wording

Command `npm run eval:llama` (inferred from the mode; this run predates recorded commands), run 2026-10-09 (git 697c8fc, read when the run ended), provider `llama (openai:qwen3-1.7b, Qwen3-1.7B Q4_0)`, local wrangler dev (Miniflare/workerd), concurrency 6.

| Metric | Value |
|---|---|
| Cases started | 60 |
| Completed | 60/60 (100.0%) |
| Passed (completed and every expectation held) | 60/60 |
| onboarding | 20/20 passed |
| integration failure | 24/24 passed |
| recovery | 16/16 passed |
| Integration calls (retried, replayed) | 1280 (60, 27) |
| Follow-ups drafted by the LLM (schema-valid / attempted) | 20 created, 100.0% valid, category agrees with the rules 100.0%, p50 2874 ms |
| Duplicate side effects in the simulated systems | 0 |
| Harness requests retried after a dropped local proxy connection (still failed) | 0 (0) |
| Audit coverage (regression check) | 1 |
| Live hub equals D1 reconcile after the run | yes |
| Scenario time p50 / p95, wall time | 3.5 s / 9.2 s, 56 s |
| Host stalls over 5 s (system sleep or a frozen harness) | none |

#### Chaos mode (seeded faults and policy bots, 5 seeds)

Command `node eval/harness/run.ts --mode chaos --llm stub --seeds 5` (via `npm run eval:chaos`), run 2026-10-09 (git ea190b8 at start, clean tree, built from that commit, dist/ unchanged during the run), provider `stub`, local wrangler dev (Miniflare/workerd), concurrency 10.

| Metric | Value |
|---|---|
| Cases started | 300 |
| Completed | 180/300 (60.0%) |
| Completion per seed (mean, min, max) | 60.0%, 25.0%, 96.7% |
| Seed 1 | 58/60; not completed: 0 failed, 0 bot patience, 2 deadline; harness: 0 transport retries, 0 control retries, 0 bot request errors |
| Seed 2 | 34/60; not completed: 0 failed, 0 bot patience, 26 deadline; harness: 32 transport retries, 0 control retries, 0 bot request errors |
| Seed 3 | 43/60; not completed: 1 failed, 0 bot patience, 16 deadline; harness: 6 transport retries, 0 control retries, 0 bot request errors; **host stalled 46 s, deadlines not reliable** |
| Seed 4 | 15/60; not completed: 0 failed, 0 bot patience, 45 deadline; harness: 13 transport retries, 0 control retries, 0 bot request errors; **host stalled 150 s, deadlines not reliable** |
| Seed 5 | 30/60; not completed: 0 failed, 0 bot patience, 30 deadline; harness: 4 transport retries, 0 control retries, 0 bot request errors; **host stalled 62 s, deadlines not reliable** |
| Integration calls (retried, replayed) | 8804 (3833, 84) |
| Duplicate side effects in the simulated systems | 0 |
| Harness requests retried after a dropped local proxy connection (still failed) | 55 (0) |
| Audit coverage (regression check) | 1 |
| Live hub equals D1 reconcile after the run | yes |
| Scenario time p50 / p95, wall time | 162.5 s / 211.9 s, 1154 s |
| Host stalls over 5 s (system sleep or a frozen harness) | 5 (258 s in total, longest 129 s): wall-clock timeouts and deadlines in this run are not reliable |

#### Scale mode (all 150 synthetic employees, no faults)

Command `node eval/harness/run.ts --mode scale --llm stub` (via `npm run eval:scale`), run 2026-10-09 (git 7a61947 at start, clean tree, built from that commit, dist/ unchanged during the run), provider `stub`, local wrangler dev (Miniflare/workerd), concurrency 10.

| Metric | Value |
|---|---|
| Cases started | 150 |
| Completed | 150/150 (100.0%) |
| Integration calls (retried, replayed) | 2850 (0, 0) |
| Duplicate side effects in the simulated systems | 0 |
| Harness requests retried after a dropped local proxy connection (still failed) | 0 (0) |
| Audit coverage (regression check) | 1 |
| Live hub equals D1 reconcile after the run | yes |
| Scenario time p50 / p95, wall time | 6.2 s / 9.6 s, 98 s |
| Host stalls over 5 s (system sleep or a frozen harness) | none |

#### Ablation: Idempotency-Key handling switched off in the simulated systems

Command `node eval/harness/run.ts --mode ablation-idempotency` (inferred from the mode; this run predates recorded commands), run 2026-10-09 (git e082bc2, read when the run ended), provider `stub`, local wrangler dev (Miniflare/workerd), concurrency 6.

| Metric | Value |
|---|---|
| Cases started | 60 |
| Completed | 60/60 (100.0%) |
| Passed (completed and every expectation held) | 50/60 |
| onboarding | 20/20 passed |
| integration failure | 18/24 passed |
| recovery | 12/16 passed |
| Integration calls (retried, replayed) | 1300 (60, 0) |
| Duplicate side effects in the simulated systems | 28 |
| Harness requests retried after a dropped local proxy connection (still failed) | 0 (0) |
| Audit coverage (regression check) | 1 |
| Live hub equals D1 reconcile after the run | yes |
| Scenario time p50 / p95, wall time | 3.1 s / 4.2 s, 39 s |
| Host stalls over 5 s (system sleep or a frozen harness) | none |

#### Ablation: step retries switched off (RETRY_LIMIT=0)

Command `node eval/harness/run.ts --mode ablation-retries` (inferred from the mode; this run predates recorded commands), run 2026-10-09 (git e082bc2, read when the run ended), provider `stub`, local wrangler dev (Miniflare/workerd), concurrency 6.

| Metric | Value |
|---|---|
| Cases started | 60 |
| Completed | 44/60 (73.3%) |
| Passed (completed and every expectation held) | 43/60 |
| onboarding | 19/20 passed |
| integration failure | 9/24 passed |
| recovery | 15/16 passed |
| Integration calls (retried, replayed) | 1017 (25, 24) |
| Duplicate side effects in the simulated systems | 0 |
| Harness requests retried after a dropped local proxy connection (still failed) | 0 (0) |
| Audit coverage (regression check) | 1 |
| Live hub equals D1 reconcile after the run | yes |
| Scenario time p50 / p95, wall time | 3.1 s / 62.1 s, 205 s |
| Host stalls over 5 s (system sleep or a frozen harness) | none |
<!-- results:end -->

**Reading these results.** Dates in the block are UTC. Every run above was made on the evening of 2026-10-08 Pacific time except the standard, scale and chaos runs, made on 2026-10-09 from 12:25 PDT on; all ran on one laptop that was also running other repositories' test suites. All files, including the runs not shown, are committed in `eval/results/`, and every change between runs is logged in [eval/results/CHANGELOG.md](eval/results/CHANGELOG.md).

- **Standard** (git 3646803, on AC power, no host stall) is the first recorded run that includes the second review round's fixes (closeout rounds, restart, dev host guard, hub debounce, token claims, live subscription re-checks, the sim key comparison and the harness's deadline and blocker rules) and the first that records the build it served: built from that commit, `dist/` unchanged during the run. All six committed standard runs, one of them with the local LLM, completed and passed 60 of 60 with 0 duplicate side effects. Its scenario times are about three times the previous run's (p50 9.8 s against 3.0 s, wall time 118 s against 40 s). No product change of this round adds a wait to the scripted path; the likely cause is machine load (load average about 5.5, other repositories' workerd processes running), which was not isolated.
- **Chaos** is the informative number, and on this shared laptop it moves with load and sleep. **The run shown is not a valid measurement:** it started at 13:29 PDT (git ea190b8, built from that commit, `dist/` unchanged), and at 13:39, during seed 3, the laptop's lid was closed and it went into clamshell sleep, waking only briefly from then on. The harness flagged it (5 host stalls, 258 s in total, longest 129 s, in seeds 3 to 5: "wall-clock timeouts and deadlines in this run are not reliable"). It completed 180 of 300 (per-seed 58, 34, 43, 15, 30). Seed 2, before the sleep, also had 26 deadlines and 32 retried harness requests, for which no cause was isolated. It is committed and shown because it is the latest run; read the two runs below and the check after them instead.
- **The run before it** (git d90973f, started 12:52 PDT on AC power, lid open, no host stall over 5 s, 1049 s) completed 215 of 300: per-seed 57, 52, 52, 54 and 0 (mean 71.7%), with 0 duplicate side effects, 84 deadlines and 1 failed case (seed 3's E059 used up the workflow's bounded recovery rounds at Facilities, as in the fourth run). Seed 5, the last, ran from roughly 13:06 PDT (each seed takes about 3.5 minutes), when other repositories' builds pushed the load average from about 4 to between 11 and 15 on 10 cores (sampled every 30 s), and none of its 60 cases finished within 180 s. Seed 5's schedule makes it the most sensitive seed: IT is down from 17.7 s to 101.9 s (two overlapping windows), Facilities from 65.6 s to 116 s and HR from 42.4 s to 74.9 s, so every case finishes close to its deadline and a slower machine pushes all of them past it.
- **The first run with the second review round's fixes** (git 676a939, 12:30 PDT, AC power, no host stall, load average 16 to 20) completed 265 of 300 (per-seed 59, 57, 59, 53, 37: mean 88.3%), also with seed 5 lowest.
- **Is the new code slower?** Not in a way that explains these runs, by two checks logged in the CHANGELOG (diagnostics, not results files): seed 5 run alone four times, alternating the code of 35ebbec (before the second round) and of d90973f, at load average 3 to 6, completed 56 of 60 every time (p50 126.8 and 129.1 s for the old code, 128.9 and 126.8 s for the new). The standard suite, run alternately on both, completed 60 of 60 every time, with a p50 about 6% higher for the new code (3.10 and 3.01 s against 2.93 and 2.81 s), a difference that two runs each cannot separate from noise. The workflow did about the same work in every chaos run (9,534 to 10,044 integration calls).
- **The last chaos run before the second review round** (git 6248014, 2026-10-08 21:30 PDT, AC power, lid open, no host stall) completed 289 of 300 under the same deadline rule (per-seed 57, 58, 60, 58, 56: mean 96.3%, min 93.3%, max 100%), all 11 misses deadlines, no failed case. It predates 9c55e58 and every fix of the second round. All these runs are committed; the Results block shows the latest one because it is the latest, not because it is either the better or the worse.
- **Earlier chaos runs** (the first four) on the same seeds are committed and not hidden, but they counted completion differently: the harness read it from a snapshot taken after the whole seed finished, and the bots kept working cases past their deadline, so a case that completed after its deadline was counted. An independent review found this; the fix and what each old run counted are in the CHANGELOG. The fourth run (git c04aeb7) reported 287 of 300 (per-seed mean 95.7%, min 93.3%); two of its counted cases were closed 180.4 and 180.5 s after their start, so under the deadline rule it is between 285 (mean 95.0%) and 287. It also had the first failed case of any run (seed 3's E059 used up the workflow's bounded recovery rounds at Facilities, as designed). The third (git 5e2635b) reported 280 of 300, counting four late cases, one of them in seed 5, which overlapped a system sleep (its longest case lasted 1077 s). The first (git 6f9a11d) reported 230 of 300, but in seed 3 the harness failed to end a Facilities outage window after a local runtime error (0/60 in that seed). The second (git a510536) reported 210 of 300, with 248 bot requests in seeds 3 and 4 lost to dropped connections in `wrangler dev`'s local proxy, and counted 36 late cases. Each of the first two led to a harness fix (the orchestrator retries its own control calls; the harness retries a dropped request with the same Idempotency-Key, which the API is designed for). Fault tables, seeds and bot policies did not change in any of these runs.
- **Scale** (git 7a61947, 2026-10-09 12:28 PDT, AC power, no host stall, built from that commit) completed 150 of 150 with 0 duplicate side effects and a consistent hub, and includes the second review round's fixes. The two earlier scale runs (git f5c8cfb, before both review rounds) are committed too: the first completed 148 of 150 (two harness requests got a plain-text 500 from the local runtime and the harness stopped driving those two cases), the second 150 of 150.
- **Which code each run measured.** The standard, scale and chaos runs shown include both review rounds' fixes. The ablation runs (git e082bc2) and the local-LLM run (git 697c8fc) predate every review-round product fix (the first round's 39840f1, 68effc0, a294819, 2fdf494, 45198a2 and 9c55e58, and the second round's f25b018, 447aa02, fa9aaec, 2ded851, 68429a3, 4e0446c and f420833) and were not re-recorded.
- **Ablations** show what each mechanism buys. The runs shown were re-recorded at 20:14 PDT with the lid open and no host stall. With Idempotency-Key handling off in the simulated systems, retried and replayed calls produced 28 duplicate side effects (0 in standard mode): all 60 cases completed, but 10 failed their exactly-once expectations. With step retries off, 16 cases stayed blocked where a fault needed a step retry (44/60 completed), with 0 duplicates. The first ablation runs (git 5e2635b) ran while the machine slept between brief wakes and are committed too. Retries off gave the same 44/60 completed and 43/60 passed. Keys off gave 59/60 completed and 27 duplicates: R05 timed out during a stall (it completes in the clean run), and R06 counted one duplicate fewer. R06 restarts a case while its old workflow instance is still running, so how far that instance gets before it is terminated varies by a step between runs.
- **Local LLM** (`npm run eval:llama`, git 697c8fc): the same 60 scenarios with llama-server running Qwen3-1.7B Q4_0 on the laptop's GPU drafting the wording of every follow-up. It was recorded later the same evening (20:09 PDT, lid open, no host stall), because the first attempt was due while the machine slept. All 20 follow-ups were drafted by the model rather than the template, with a p50 of 2.9 s per draft, and the workflow results match the stub run (60/60 passed, 0 duplicates). Read the 100% schema-valid and 100% category-agreement figures as "the drafting path works end to end", not as model quality: llama-server constrains the output to the JSON schema, whose category field is an enum, and the prompt names the blocker kind the rules already decided. The model never decides anything ([ADR 0004](docs/adr/0004-rules-decide-llm-drafts.md)), and the run does not measure whether its wording is better than the template's.

## Deploy (Cloudflare account required)

1. `npx wrangler login`
2. `npx wrangler d1 create onboardflow-prod`, then paste the id into `env.production.d1_databases[0].database_id` in `wrangler.jsonc`.
3. `npx wrangler d1 migrations apply onboardflow-prod --remote -c wrangler.jsonc --env production`
4. Edit `seed/prod-admins.sql` with your Access email(s) (one `staff` row with `kind = 'admin'` and one `app_users` row per email), then run `npx wrangler d1 execute onboardflow-prod --remote --env production --file seed/seed.sql` (or a date-shifted demo seed, below) and the same for `seed/prod-admins.sql`.
5. `npx wrangler secret put SIM_API_KEY --env production`
6. In Zero Trust, create a self-hosted Access application for the Worker's hostname with a policy allowing your email(s). Do not use the Worker-level Access tab: it does not support WebSockets, which the live views need. Copy the team domain and the Application Audience (AUD) tag into `env.production.vars.TEAM_DOMAIN` and `POLICY_AUD`.
7. In the same application's cookie settings, set SameSite to `Lax` and keep HttpOnly on.
8. `npm run deploy`. It refuses to deploy while any production value still contains `REPLACE`.
9. Smoke test: open the site, sign in through Access, check that `/api/me` returns your admin role, start one case from Cases, and watch the dashboard update.

The committed seed is anchored at 2026-11-02. For a live demo after that, generate a date-shifted copy of the same people: `npm run seed:generate -- --anchor <next Monday> --out seed/seed.demo.sql` (gitignored).

## Project layout

```
src/shared/        stages, roles, vocabularies, API schemas, agent state types, synthetic data generator
src/worker/        Hono app, auth, routes, D1 helpers, agents, workflow, integrations, simulators, LLM seam
src/web/           React SPA: pages, components, API client, live hooks
migrations/        D1 schema (6 migrations)
seed/              generated seed.sql and manifest.json (sha256), production admin template
test/              worker (workerd), node and web test projects
eval/              scenario catalog, harness, recorded results
docs/adr/          architecture decision records 0001 to 0008
```

## Not built in this version

Every feature in the specification's Tier 1 and Tier 2 scope is built. These parts exist but have never been exercised, because they need a Cloudflare account:

- production Cloudflare Access (a real Access application and team JWKS; the verifier is tested only against locally generated keys), remote D1, and `npm run deploy`;
- the Workers AI provider, which is unit tested against a fake binding only.

Known limitations:

- Live subscriptions are authorized when the WebSocket upgrades and re-checked before every state push (dashboard sockets at least once a minute, since the hub reconciles every 60 s): a socket whose Access token expired, or whose account was deactivated or lost the role, is closed then. A socket on a case that never changes is not re-checked until something changes.
- An employee can complete the checklist tasks of a stage that has not started yet, including the four orientation tasks while provisioning is still running: tasks are created at intake and completion checks only ownership and open status. The scripted scenarios rely on early completion (O07 finishes paperwork before its gate is checked, and every scripted happy path completes orientation tasks right after the manager approves), so restricting it would change the measured behavior and needs a catalog change and new runs; it is not done in this version.
- If the platform refuses a restart and creating the replacement instance then fails, the restart is already committed: the API answers 202 (a retry with the same Idempotency-Key replays it) and the CaseAgent retries the instance creation on a schedule (2 to 32 s, five attempts). If all five fail, the case shows `in_progress` with no running workflow until an admin restarts it again.
- After the HR worker was created, a coordinator can still correct the cost center. If an admin then restarts the case, replaying the stored worker creation sends a different request under the same Idempotency-Key, which the simulated HR system refuses (422). The intake stage blocks as a data issue that no field correction can clear (only restoring the old value would); retries fail the same way until the stage's recovery rounds run out and the workflow fails the case with `recovery_rounds_exhausted` (audited). No second worker is created. Both paths are pinned by tests in `test/worker/workflow-restart.test.ts`.

## Troubleshooting

Worker test runs print `uncaught exception` lines such as `Aborting engine: User called restart`, `broken.outputGateBroken`, `eval-evict` and occasional "Worker's code had hung" messages. They come from steps that fail on purpose, restarts, terminations and evictions; tests assert outcomes, not log silence. The "Missing required secrets" warning during tests and builds is expected: tests pass secrets as Miniflare bindings.

Under load, `wrangler dev`'s local ProxyWorker can drop its connection to the Worker. It retries a GET itself ("recovered on attempt 2 after a dropped connection to the UserWorker") and answers a POST with a plain-text 500, `Error: Network connection lost.` The eval harness retries such a request with the same Idempotency-Key and counts it in the results. A browser user would see the request fail and could repeat the action. Eval timeouts and chaos deadlines are wall-clock: run evals with the machine awake (lid open, on power), since every run records host stalls and the Results block flags them. Kept eval logs (`--keep`) also show "Worker's code had hung" errors that belong to no request.
