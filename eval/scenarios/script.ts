// Script building blocks shared by the scenario files.
import type { FaultPlanInput } from "../../src/shared/api.ts";
import type { FaultKind, SystemId } from "../../src/shared/domain.ts";
import type { Action } from "./types.ts";

export const paperwork = (order?: "reverse"): Action => ({ do: "completeEmployeeTasks", stage: "paperwork", ...(order ? { order } : {}) });
export const orientation = (order?: "reverse"): Action => ({ do: "completeEmployeeTasks", stage: "orientation", ...(order ? { order } : {}) });
export const managerApproves = (privileged?: boolean): Action => ({ do: "decide", checkpoint: "manager_approval", decision: "approve", as: "manager", ...(privileged !== undefined ? { privileged } : {}) });
export const closeoutApproved = (as: "people_ops" | "people_ops_2" | "admin" = "people_ops"): Action => ({ do: "decide", checkpoint: "closeout", decision: "approve", as });

/** Every human action on time, in order. */
export function happyPath(opts: { privileged?: boolean } = {}): Action[] {
  return [paperwork(), managerApproves(opts.privileged), orientation(), closeoutApproved()];
}

export function fault(employeeRef: string, system: SystemId, operation: string, kind: FaultKind, remaining: number | null, params?: { retryAfterMs?: number }): FaultPlanInput {
  return { system, operation, employeeRef, fault: kind, remaining, ...(params ? { params } : {}) };
}

/** One ledger row for every POST operation of an onboarding (the no-duplicate invariant). */
export const ONE_EACH = {
  "hr.create-worker": 1,
  "hr.start-document-verification": 1,
  "it.create-account": 1,
  "it.assign-licenses": 1,
  "it.order-device": 1,
  "facilities.assign-workspace": 1,
  "facilities.issue-badge": 1,
  "hr.enroll-orientation": 1,
  "hr.activate-worker": 1,
} as const;
