import { describe, expect, it } from "vitest";
import { STAGE_IDS } from "../../src/shared/stages.ts";
import { DEMO_FAULTS, DEMO_MIX, DEMO_TARGETS, demoPlan } from "../../scripts/demo-drive.ts";

const ids = Array.from({ length: 150 }, (_, i) => `E${String(i + 1).padStart(3, "0")}`);

describe("demo plan", () => {
  it("assigns exactly the DEMO_MIX counts, deterministically per seed", () => {
    const plan = demoPlan(7, ids);
    expect(plan.size).toBe(150);
    const counts = new Map<string, number>();
    for (const t of plan.values()) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const t of DEMO_TARGETS) expect(counts.get(t)).toBe(DEMO_MIX[t]);
    expect(counts.get("complete")).toBe(42);
    expect([...demoPlan(7, ids)]).toEqual([...plan]);
    expect([...demoPlan(8, ids)]).not.toEqual([...plan]);
  });

  it("holds cases in every one of the 8 stages, with faults only where a stage cannot hold a case otherwise", () => {
    const faulted = Object.entries(DEMO_FAULTS).map(([t, f]) => ({ t, ...f! }));
    const held = new Set<string>([
      ...faulted.map((f) => f.stage),
      ...DEMO_TARGETS.filter((t) => t !== "complete" && !(t in DEMO_FAULTS)),
    ]);
    expect([...held].sort()).toEqual([...STAGE_IDS].sort());
    const faultedCases = faulted.reduce((n, f) => n + DEMO_MIX[f.t as keyof typeof DEMO_MIX], 0);
    expect(faultedCases).toBeLessThanOrEqual(15);
  });
});
