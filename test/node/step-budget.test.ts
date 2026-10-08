import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import { FIRST_ROUND_OPERATIONS, POLLED_OPERATIONS, STAGES } from "../../src/shared/stages.ts";
import {
  PRODUCTION_STEP_CONFIG,
  STEP_BUDGET_CEILING,
  STEP_LIMIT_FREE,
  stepBudgetBreakdown,
  worstCaseSteps,
} from "../../src/shared/step-budget.ts";

// Eval configuration (SPEC 12.1 and 11): same round and wait limits, fast timings.
const EVAL_STEP_CONFIG = { ...PRODUCTION_STEP_CONFIG };

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
    expect(worstCaseSteps(EVAL_STEP_CONFIG)).toBeLessThanOrEqual(STEP_BUDGET_CEILING);
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
