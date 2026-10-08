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
