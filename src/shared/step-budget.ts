// Worst-case Workflow step count (SPEC Section 8.3). Workflows allow 1,024
// steps per instance on Workers Free; the build asserts at most 1,000 for both
// the production and the eval configuration. The workflow reads the same
// constants for its loop bounds, so a change here and there cannot drift.
import { FIRST_ROUND_OPERATIONS, POLLED_OPERATIONS, STAGES } from "./stages.ts";

export const STEP_LIMIT_FREE = 1024;
export const STEP_BUDGET_CEILING = 1000;

/** Steps around every stage: start, sendEvent(stage_started), complete, sendEvent(stage_completed). */
export const STEPS_PER_STAGE = 4;
/** run.begin, case.complete, reportComplete. */
export const STEPS_RUN_FRAME = 3;
/** Intake checklist creation. */
export const STEPS_CHECKLIST = 1;
/** Per extra approval round: rejected, sendEvent, resubmit pass, request, sendEvent, decision pass. */
export const STEPS_PER_EXTRA_APPROVAL_ROUND = 6;
/** Per recovery round, besides polling: mark-blocked, sendEvent, retry pass, re-run op. */
export const STEPS_PER_RECOVERY_ROUND = 4;
/** Per wait iteration: waitForEvent + re-check. */
export const STEPS_PER_WAIT = 2;
/** Task gates (paperwork, orientation) and approval checkpoints (manager_approval, closeout). */
export const TASK_GATES = STAGES.filter((s) => s.gate === "employee_tasks").length;
export const CHECKPOINTS = STAGES.filter((s) => s.gate === "approval").length;

export type StepBudgetConfig = {
  pollMax: number;
  maxRecoveryRounds: number;
  maxApprovalRounds: number;
  waitBudget: number;
};

export type StepBudgetBreakdown = Record<string, number> & { total: number };

export function stepBudgetBreakdown(c: StepBudgetConfig): StepBudgetBreakdown {
  const rows = {
    runFrame: STEPS_RUN_FRAME,
    stages: STAGES.length * STEPS_PER_STAGE,
    checklist: STEPS_CHECKLIST,
    firstRoundOperations: FIRST_ROUND_OPERATIONS.length,
    polling: POLLED_OPERATIONS.length * c.pollMax * 2,
    firstRoundGates: TASK_GATES + CHECKPOINTS + CHECKPOINTS * 2,
    extraApprovalRounds: CHECKPOINTS * (c.maxApprovalRounds - 1) * STEPS_PER_EXTRA_APPROVAL_ROUND,
    recoveryRounds: c.maxRecoveryRounds * (STEPS_PER_RECOVERY_ROUND + 2 * c.pollMax),
    terminalFailure: 1,
    waits: c.waitBudget * STEPS_PER_WAIT,
  };
  const total = Object.values(rows).reduce((a, b) => a + b, 0);
  return { ...rows, total };
}

export function worstCaseSteps(c: StepBudgetConfig): number {
  return stepBudgetBreakdown(c).total;
}

/** Production defaults from wrangler.jsonc. */
export const PRODUCTION_STEP_CONFIG: StepBudgetConfig = {
  pollMax: 12,
  maxRecoveryRounds: 6,
  maxApprovalRounds: 3,
  waitBudget: 120,
};
