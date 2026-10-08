import { afterEach, describe, expect, it } from "vitest";
import { ALL_ACTIONS_SUPPORTED, executeAction, Harness, type ScenarioRun, SUPPORTED_ACTIONS, UnknownActionError } from "../../eval/harness/actions.ts";
import { runScenario } from "../../eval/harness/run.ts";
import { SCENARIOS } from "../../eval/scenarios/index.ts";
import type { Action, Scenario } from "../../eval/scenarios/types.ts";
import { generateDataset } from "../../src/shared/synthetic/generate.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function kinds(actions: Action[]): string[] {
  return actions.flatMap((a) => (a.do === "duplicate" ? [a.do, ...kinds([a.action])] : a.do === "concurrent" ? [a.do, ...kinds(a.actions)] : [a.do]));
}

describe("action interpreter", () => {
  it("is exhaustive over the Action union (compile-time never check)", () => {
    expect(ALL_ACTIONS_SUPPORTED).toBe(true);
    expect(new Set(SUPPORTED_ACTIONS).size).toBe(SUPPORTED_ACTIONS.length);
  });

  it("supports every action the catalog uses", () => {
    const used = new Set(SCENARIOS.flatMap((s) => kinds(s.script)));
    for (const k of used) expect(SUPPORTED_ACTIONS as readonly string[]).toContain(k);
  });

  it("throws unknown_action for an action it does not know, before touching the network", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network must not be used");
    }) as typeof fetch;
    const h = new Harness("http://localhost:1", generateDataset());
    const run: ScenarioRun = { h, scenario: SCENARIOS[0]!, employeeId: "E001", notes: [], keys: { kind: "fresh" }, duplicatePass: false };
    await expect(executeAction(run, { do: "teleport" } as unknown as Action)).rejects.toThrow(UnknownActionError);
    await expect(executeAction(run, { do: "teleport" } as unknown as Action)).rejects.toThrow(/unknown_action: teleport/);
  });

  it("fails a scenario containing an unknown action with unknown_action instead of skipping it", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;
    const h = new Harness("http://localhost:1", generateDataset());
    const scenario: Scenario = {
      id: "X01",
      category: "onboarding",
      title: "contains an unknown action",
      employeeId: "E001",
      archetype: {},
      setup: [],
      script: [{ do: "start" }, { do: "teleport" } as unknown as Action],
      expect: { terminal: "complete" },
    };
    // "start" would hit the network first; put the unknown action first to keep the test offline
    scenario.script.reverse();
    const r = await runScenario(h, scenario, new Set());
    expect(r.passed).toBe(false);
    expect(r.failureReason).toBe("unknown_action");
    expect(r.failures.join(" ")).toContain("unknown_action: teleport");
  }, 10_000);
});
