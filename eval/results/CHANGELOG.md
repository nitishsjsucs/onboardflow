# Eval results changelog

Every change to the scenario catalog, fault tables or harness behavior that
could affect recorded numbers after the first recorded run is logged here
with its reason. Nothing here is tuned toward a target.

## 2026-10-08

- Catalog v1 (60 scenarios) and the standard and scale harness modes created.
- Before any results were recorded, a trial standard run failed O19 and R07
  (CaseAgent evicted mid-flow). The cause was a product bug, fixed in the
  workflow (callbacks re-resolve the agent after an eviction); the scenarios
  were not changed.
- Chaos mode (SPEC 12.3) added. Its fault table, seeds, persona policies and
  coordinator bot are committed in `eval/harness/policies.ts` before the first
  recorded chaos run. Choices made before recording, with the trial runs that
  informed them (seed 1 only, not recorded):
  - Trial 1 used the 20 ms retry base of the scripted suite: 0/60 completed,
    all `recovery_rounds_exhausted`. Sustained outage windows (10 to 60 s, real
    time) outlast every retry the workflow can make when its retries are
    compressed 100x while faults and bots run in real seconds. Chaos runs
    therefore use the production retry base (2 s) and a 1 s poll interval
    (`CHAOS_VARS`), so time is expressed in the same unit everywhere.
  - Trial 2 with those timings: 20/60, mostly deadlines. The cause was a
    product bug: the engine compounded the exponential backoff (2, 8, 32,
    128 s). Fixed in the workflow (`fix(workflow): apply exponential retry
    backoff once`), not in the eval.
  - Trial 3 after the fix: 58/60 on seed 1.
  - SPEC 12.3 asks for a single 4-day clock advance "so overdue is
    reachable". With the committed seed (cohorts 2026-11-02 to 2027-01-04,
    paperwork due 7 to 14 days before the start date) and the pinned
    simulated now of 2026-10-08, four days cannot make any task overdue. The
    harness instead jumps 90 days once at a seeded point (5 to 15 s), then
    advances 3 days every 20 s so pending approvals keep crossing their 48 h
    SLA. Disengaged employees therefore act once their overdue follow-up
    exists, and silent managers are covered by the admin after
    `approval_overdue`, as the policies intend.

## 2026-10-08, Tier 2 recording round (file names carry UTC times, 2026-10-09)

- Standard and scale were re-recorded after the retry backoff fix (e7c0f3e)
  at git 6dbf935. Standard: `2026-10-09T00-14-18-955Z-standard.json`.
- Scale ran twice at 6dbf935, both files committed. The first run
  (`2026-10-09T00-15-13-395Z-scale.json`) completed 148/150: two harness
  requests got an HTTP 500 whose plain-text body was Miniflare's
  `Error: Network connection lost.` (the entry worker returns `e.stack` when
  the Worker's fetch fails inside the local runtime, before the app's error
  handler), and the harness stops driving a case after a failed request, so
  E001 and E009 were left mid-flow. That run took 224 s against 76 s for the
  second while another repository's test suite was loading the machine. The
  second run (`2026-10-09T00-19-51-014Z-scale.json`, started with `--keep`
  to capture the server log) completed 150/150 and is the `latest` file
  because it is the most recent run, not because it is better. The harness
  now names the request, status and body of such a response
  (`fix(eval): report non-JSON responses ...`); outcomes are unchanged.
- First recorded chaos run (`2026-10-09T00-22-45-731Z-chaos.json`, git
  2ed49fe): seeds 1 to 5 completed 59, 57, 0, 58 and 56 of 60. Seed 3 is a
  harness failure, not a measurement: a burst of the same runtime 500s hit
  the orchestrator's `DELETE /api/dev/faults?ids=173,174`, which was meant to
  end a 10 to 60 s Facilities outage window. The orchestrator did not retry
  it, so that outage lasted the rest of the seed (both fault plans were still
  uncleared in the seed's D1) and every case stopped at `facilities_setup`.
  The committed schedule was therefore not what ran. Fix
  (`fix(eval): chaos orchestrator applies its schedule through runtime
  errors`): every orchestrator control call (fault plans, outage windows,
  stall clears, clock moves, corruption, case starts) retries a transport
  failure, a 5xx or `409 idempotency_in_progress` with the same
  Idempotency-Key for up to 75 s, which the eval hooks replay instead of
  applying twice; timed actions no longer block the bots' loop while they do;
  a transport error in a bot's polling skips that bot for one tick instead of
  aborting the seed. Bot behavior (what they do, their delays and patience)
  is unchanged, and a bot action lost to a transport error is still not
  retried by the policy. Each seed now records control retries, control
  failures and bot request errors, and the README flags any seed whose
  schedule was not fully applied. Fault tables, seeds and policies are
  unchanged. Chaos was then re-run in full on the same 5 seeds; the first
  run stays committed and is cited next to the results.
- Second chaos run (`2026-10-09T00-43-47-708Z-chaos.json`, git 3b3ed1a):
  seeds 1 to 5 completed 57, 49, 22, 27 and 55 of 60 (mean 0.70). No control
  action failed (4 control retries), but seeds 3 and 4 recorded 74 and 174
  bot request errors: the same plain-text 500s, now on employees' task
  completions and managers' decisions. The server log names the cause:
  under load, wrangler dev's ProxyWorker drops its connection to the Worker;
  it retries a GET itself ("recovered on attempt 2 after a dropped
  connection to the UserWorker") and fails a POST, since it cannot know the
  request is idempotent. The workerd processes did not restart, and seed 3's
  D1 held no stuck idempotency claim (899 complete, 0 pending). A lost task
  completion was redone by the employee bot on a later tick, but a lost
  manager decision was not (the policy decides each approval once), so those
  cases waited for the admin's overdue path or ran out of time. The drops
  come from the local proxy, which production does not have, not from the
  fault model; the machine was also shared with other repositories' test
  suites (API latencies of 1.3 to 3 s in the server log). Fix
  (`fix(eval): retry requests the local proxy drops, with the same
  Idempotency-Key`): the harness HTTP layer retries a network error or a
  5xx whose body is not JSON (the app's own errors are always JSON) with the
  same Idempotency-Key for up to 75 s, plus a 409 `idempotency_in_progress`
  that follows such a retry. This is the client behavior the API is built
  for (SPEC 7.1 and 18: the key is reused on a retry of the same action).
  Answers from the app are never retried. Every run now records how many
  requests were retried and how many still failed, and the README shows
  both. It applies to every mode; standard and scale were not re-recorded
  because no request reached the harness as a transport failure in their
  recorded runs (any such failure would have failed a scenario, and every
  scenario passed), so the change cannot alter them. Chaos was run a third
  time on the same 5 seeds.
- Third chaos run (`2026-10-09T01-03-54-407Z-chaos.json`, git ab9c3e7):
  seeds 1 to 5 completed 59, 51, 60, 58 and 52 of 60 (mean 0.933, min
  0.85, max 1.0), with 33 transport retries (none still failed), no control
  failure, 0 duplicate side effects, a consistent hub, and every miss a
  deadline. The laptop's lid was closed at 18:18:37 PDT during seed 5
  (`pmset -g log`: "Clamshell Sleep" on battery), and the machine slept from
  18:19:35 to 18:34:40 PDT. Seed 5's longest recorded case is 1077 s against
  a 180 s deadline, which only a host stall explains, so its 8 deadline
  misses are not a reliable measurement. Seeds 1 to 4 ended before the sleep
  (no case over 181 s) and completed 228 of 240.
- Ablations (git ab9c3e7) ran while the machine slept between brief wakes.
  Idempotency-Key handling off
  (`2026-10-09T01-34-56-328Z-ablation-idempotency.json`): 59/60 completed,
  50/60 passed, 27 duplicate side effects in the simulated systems against
  0 in standard mode. The duplicates are the measurement and do not depend
  on timing. Scenarios stalled for 16 to 17 minutes three times (two
  blocks of concurrent scenarios, then the serial R03), and R05's "timed
  out waiting for closeout approval" comes from a stall, not from the
  ablation. Retries off
  (`2026-10-09T02-42-19-526Z-ablation-retries.json`): 44/60 completed,
  43/60 passed, 0 duplicates. Every incomplete case is a scenario whose
  fault needs a step retry (the stage blocks after one attempt), plus R11,
  whose blocker is classified `integration_outage` instead of
  `provisioning_stalled` without retries. Those outcomes are structural, but
  the run's timings include stalls.
- The llama run (`npm run eval:llama`) was not recorded in this round: by
  the time the ablations finished, the lid was closed and the machine slept
  between brief wakes, so a run would have measured the sleep. The earlier
  trial numbers in `PROGRESS.md` stay trial numbers.
- Harness change (`feat(eval): flag runs during which the host slept or
  stalled`): every run now records host stalls (gaps of more than 5 s in a
  1 s wall-clock timer, which is how a system sleep appears), per chaos seed
  and per run, and the README marks a stalled run or seed as not reliable
  for timeouts and deadlines. The runs above predate it; their sleep is
  documented here from the power log and the recorded durations.

## 2026-10-08, local-LLM run, clean ablation re-runs and a fourth chaos run (file names carry UTC times, 2026-10-09)

- The README Results block now lists the stub run of a mode before any
  local-LLM run of the same mode, so the CI regression gate stays first.
  Rendering only (`fix(eval): list the stub standard run before the
  local-LLM run in the README`); no recorded number changed.
- Local-LLM run (`2026-10-09T03-09-57-525Z-standard.json`, git 8a849de,
  `npm run eval:llama`), started 20:09 PDT with the lid open on battery,
  Low Power Mode off, no host stall and no transport retry. llama-server ran
  Qwen3-1.7B Q4_0 on port 8110 (`-np 1 -c 8192 -ngl 99 --jinja`) and was
  stopped by the harness afterwards. 60/60 completed and passed, 0
  duplicate side effects, audit coverage 1, hub consistent. All 20
  follow-ups were drafted by the model (none fell back to the template),
  100% schema-valid, category agreement 100%, p50 2874 ms. The output is
  constrained by the JSON schema (the category is an enum) and the prompt
  names the rule-decided kind, so validity and agreement are close to
  guaranteed and show that the path works, not model quality. The harness
  does not record draft text, so wording quality is not measured.
- Nothing in the catalog, fault tables, prompt or harness behavior changed
  for this run.
- Both ablations re-run at git d9ed36d (`npm run eval:ablate`, started
  20:14 PDT, lid open, on battery, Low Power Mode off) because the first
  runs overlapped a system sleep. Neither recorded a host stall or a
  transport retry. Nothing in the catalog, fault tables or harness behavior
  changed between the two pairs of runs. Both pairs are committed.
  - Idempotency-Key handling off
    (`2026-10-09T03-14-54-049Z-ablation-idempotency.json`): 60/60
    completed, 50/60 passed, 28 duplicate side effects, 39 s. Against the
    first run (59/60, 50/60, 27): R05 completed this time, which confirms
    its earlier timeout came from the sleep, and R06 counted 8 duplicates
    instead of 7 (`hr.enroll-orientation` too). R06 restarts the case while
    the old workflow instance is still running, so how far that instance
    gets before termination is a race. Every other scenario matched.
  - Step retries off (`2026-10-09T03-15-37-722Z-ablation-retries.json`):
    44/60 completed, 43/60 passed, 0 duplicates, 205 s, the same counts
    and integration calls (1017, 25 retried) as the first run.
- Fourth chaos run (`2026-10-09T03-22-57-148Z-chaos.json`, git f442532,
  `npm run eval:chaos`, started 20:22 PDT, lid open, on battery from 24% to
  15%, Low Power Mode off, other repositories' builds running). Between the
  third and fourth runs only the stall detector and README rendering
  changed; product code, scenarios, fault tables, seeds and bot policies did
  not. Seeds 1 to 5 completed 58, 57, 58, 58 and 56 of 60 (287/300, mean
  0.9567, min 0.9333, max 0.9667), 0 duplicate side effects, a consistent
  hub, 0 transport retries, 0 control retries or failures, 0 bot request
  errors, 0 bot patience. 12 misses are deadlines; one is the first
  `case_failed` in any chaos run: seed 3's E059 met a Facilities outage and
  a data issue (3 fatal Facilities calls) after an HR outage in paperwork,
  and the workflow failed the case with `recovery_rounds_exhausted` (limits
  4 rounds per stage, 6 per case). The run took 983 s.
- The fourth run's detector counted one 5.8 s gap, in seed 1, so the README
  flags that seed. `pmset -g log` shows no sleep or wake during the run.
  The per-seed watch in chaos mode started before `prepareDatabase`, whose
  two synchronous `wrangler d1` calls block the harness's event loop (timed
  afterwards at about 2.1 s on a quieter machine); the file cannot say
  whether the gap fell there or while cases ran.
