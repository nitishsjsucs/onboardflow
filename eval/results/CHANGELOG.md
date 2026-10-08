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
