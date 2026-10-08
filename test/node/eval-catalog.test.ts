import { describe, expect, it } from "vitest";
import { SCENARIOS, scenarioById } from "../../eval/scenarios/index.ts";
import { FAULT_CLASSES, type Scenario } from "../../eval/scenarios/types.ts";
import { generateDataset } from "../../src/shared/synthetic/generate.ts";

const employees = new Map(generateDataset().employees.map((e) => [e.id, e]));

function matches(s: Scenario): boolean {
  const e = employees.get(s.employeeId);
  if (!e) return false;
  return Object.entries(s.archetype).every(([k, v]) => (e as unknown as Record<string, unknown>)[k] === v);
}

describe("scenario catalog", () => {
  it("has exactly 60 scenarios: 20 onboarding, 24 integration failure, 16 recovery", () => {
    expect(SCENARIOS).toHaveLength(60);
    const by = (c: Scenario["category"]) => SCENARIOS.filter((s) => s.category === c).length;
    expect([by("onboarding"), by("integration_failure"), by("recovery")]).toEqual([20, 24, 16]);
  });

  it("uses unique scenario ids and unique employees", () => {
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(60);
    expect(new Set(SCENARIOS.map((s) => s.employeeId)).size).toBe(60);
  });

  it("covers all 8 fault classes x 3 systems exactly once", () => {
    const covered = SCENARIOS.filter((s) => s.category === "integration_failure").map((s) => `${s.covers?.faultClass}:${s.covers?.system}`);
    const expected = FAULT_CLASSES.flatMap((f) => ["hr", "it", "facilities"].map((sys) => `${f}:${sys}`));
    expect(covered.sort()).toEqual(expected.sort());
  });

  it("binds every scenario to a seed employee that matches its archetype", () => {
    for (const s of SCENARIOS) {
      expect(employees.has(s.employeeId), `${s.id} ${s.employeeId}`).toBe(true);
      expect(matches(s), `${s.id} archetype ${JSON.stringify(s.archetype)}`).toBe(true);
    }
  });

  it("puts the O13 employee under the same manager as O09", () => {
    const o13 = scenarioById("O13")!;
    expect(o13.sameManagerAs).toBe("O09");
    expect(employees.get(o13.employeeId)?.managerId).toBe(employees.get(scenarioById("O09")!.employeeId)?.managerId);
  });

  it("targets fault setups and corruptions at the scenario's own employee", () => {
    for (const s of SCENARIOS) {
      for (const item of s.setup) if ("employeeRef" in item) expect(item.employeeRef, s.id).toBe(s.employeeId);
      for (const a of s.script) if (a.do === "setFault") expect(a.plan.employeeRef, s.id).toBe(s.employeeId);
    }
  });

  it("marks the clock-moving scenarios, which run serially after the others", () => {
    const moving = SCENARIOS.filter((s) => s.script.some((a) => a.do === "advanceClock")).map((s) => s.id);
    expect(moving).toEqual(["O10", "R02", "R03"]);
    for (const id of moving) expect(scenarioById(id)?.movesClock).toBe(true);
    expect(SCENARIOS.filter((s) => s.movesClock).map((s) => s.id)).toEqual(moving);
  });

  it("expects every scenario to complete (failures are recovered by construction)", () => {
    for (const s of SCENARIOS) expect(s.expect.terminal, s.id).toBe("complete");
  });
});
