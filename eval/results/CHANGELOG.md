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
