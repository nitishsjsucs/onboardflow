import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import { FIRST_ROUND_OPERATIONS, POLLED_OPERATIONS, STAGES } from "../../src/shared/stages.ts";
import { EVAL_VARS } from "../../eval/harness/server.ts";
import { CHAOS_VARS } from "../../eval/harness/policies.ts";
import { WORKER_TEST_VARS } from "../setup/worker-vars.ts";
import {
  PRODUCTION_STEP_CONFIG,
  STEP_BUDGET_CEILING,
  type StepBudgetConfig,
  STEP_LIMIT_FREE,
  stepBudgetBreakdown,
  worstCaseSteps,
} from "../../src/shared/step-budget.ts";

type Vars = Record<string, string | undefined>;
const wranglerVars = (parse(readFileSync("wrangler.jsonc", "utf8")) as { vars: Vars }).vars;

/** The loop bounds a Worker reads from its vars (src/worker/config.ts), as a step budget input. */
function stepConfigOf(vars: Vars): StepBudgetConfig {
  const n = (k: string) => {
    const v = Number(vars[k]);
    if (!Number.isInteger(v) || v < 0) throw new Error(`${k} is ${vars[k]}`);
    return v;
  };
  return { pollMax: n("POLL_MAX"), maxRecoveryRounds: n("MAX_RECOVERY_ROUNDS"), maxApprovalRounds: n("MAX_APPROVAL_ROUNDS"), waitBudget: n("WAIT_BUDGET") };
}

// The eval configurations as they run: wrangler.jsonc vars with each harness's overrides on top
// (EVAL_VARS for standard, scale, ablations and the demo driver; CHAOS_VARS on top for chaos).
// The worker tests run with WORKER_TEST_VARS on top (vitest.config.ts imports the same constant).
const EVAL_CONFIGS: Array<[string, Vars]> = [
  ["standard, scale, ablations, demo", { ...wranglerVars, ...EVAL_VARS }],
  ["chaos", { ...wranglerVars, ...EVAL_VARS, ...CHAOS_VARS }],
  ["worker tests", { ...wranglerVars, ...WORKER_TEST_VARS }],
];

describe("step budget", () => {
  it("matches the SPEC 8.3 table with production defaults (561 steps)", () => {
    const b = stepBudgetBreakdown(PRODUCTION_STEP_CONFIG);
    expect(b).toMatchObject({
      runFrame: 3,
      stages: 32,
      checklist: 1,
      firstRoundOperations: 12,
      polling: 72,
      firstRoundGates: 8,
      extraApprovalRounds: 24,
      recoveryRounds: 168,
      terminalFailure: 1,
      waits: 240,
    });
    expect(b.total).toBe(561);
  });

  it("stays at or below 1,000 for production and eval configurations", () => {
    expect(STEP_BUDGET_CEILING).toBeLessThan(STEP_LIMIT_FREE);
    expect(worstCaseSteps(PRODUCTION_STEP_CONFIG)).toBeLessThanOrEqual(STEP_BUDGET_CEILING);
    for (const [name, vars] of EVAL_CONFIGS) {
      expect(worstCaseSteps(stepConfigOf(vars)), name).toBeLessThanOrEqual(STEP_BUDGET_CEILING);
    }
  });

  it("sees an override of a loop bound in any eval configuration", () => {
    for (const [name, vars] of EVAL_CONFIGS) {
      expect(worstCaseSteps(stepConfigOf({ ...vars, WAIT_BUDGET: "400" })), name).toBeGreaterThan(STEP_BUDGET_CEILING);
    }
  });

  it("derives its inputs from the stage registry", () => {
    expect(STAGES).toHaveLength(8);
    expect(FIRST_ROUND_OPERATIONS).toHaveLength(12);
    expect(POLLED_OPERATIONS).toEqual([
      "hr.start-document-verification",
      "it.order-device",
      "facilities.issue-badge",
    ]);
  });

  it("grows with every bound, so a config change is caught", () => {
    const base = worstCaseSteps(PRODUCTION_STEP_CONFIG);
    expect(worstCaseSteps({ ...PRODUCTION_STEP_CONFIG, waitBudget: 121 })).toBe(base + 2);
    expect(worstCaseSteps({ ...PRODUCTION_STEP_CONFIG, maxRecoveryRounds: 7 })).toBe(base + 28);
    expect(worstCaseSteps({ ...PRODUCTION_STEP_CONFIG, pollMax: 13 })).toBe(base + 6 + 12);
    expect(worstCaseSteps({ ...PRODUCTION_STEP_CONFIG, maxApprovalRounds: 4 })).toBe(base + 12);
  });
});

describe("the workflow's loop bounds come from the same configuration", () => {
  const wrangler = parse(readFileSync("wrangler.jsonc", "utf8")) as {
    vars: Record<string, string>;
    env: { production: { vars: Record<string, string> } };
  };
  for (const [name, vars] of [
    ["dev", wrangler.vars],
    ["production", wrangler.env.production.vars],
  ] as const) {
    it(`${name} vars match PRODUCTION_STEP_CONFIG`, () => {
      expect({
        pollMax: Number(vars.POLL_MAX),
        maxRecoveryRounds: Number(vars.MAX_RECOVERY_ROUNDS),
        maxApprovalRounds: Number(vars.MAX_APPROVAL_ROUNDS),
        waitBudget: Number(vars.WAIT_BUDGET),
      }).toEqual(PRODUCTION_STEP_CONFIG);
    });
  }
});
