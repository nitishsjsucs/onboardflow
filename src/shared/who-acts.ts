// Who has to act on a stage in a given state. The dashboard's stage chart, the
// case page's sentence and a manager's team rows all say who the work waits on;
// they take it from here so the three never disagree.
//
// The answer is structural: an employee-task stage waits on the employee, the
// manager_approval checkpoint on the hiring manager, closeout and every
// revision on People Ops, and a blocked operation on the department that owns
// the simulated system it calls (SYSTEM_OWNER), unless the open blocker names
// its owner, which is more precise (the cross-system check calls all three).
import type { StageStatus } from "./domain.ts";
import { DEPARTMENTS, type Department, SYSTEM_OWNER } from "./roles.ts";
import { OPERATIONS, STAGE_BY_ID, type StageId } from "./stages.ts";

export type Actor =
  | { kind: "employee" }
  | { kind: "manager" }
  | { kind: "department"; departments: Department[] }
  | { kind: "workflow" }
  | { kind: "admin" }
  | { kind: "nobody" };

/** The departments that own the simulated systems a stage calls (People Ops for a stage that calls none). */
export function stageBlockedOwners(stageId: StageId): Department[] {
  const owners = new Set(STAGE_BY_ID[stageId].operations.map((op) => SYSTEM_OWNER[OPERATIONS[op].system]));
  const ordered = DEPARTMENTS.filter((d) => owners.has(d));
  return ordered.length > 0 ? ordered : ["people_ops"];
}

/** Who acts on a stage in this status. `blockerOwner`: the open blocker's owner department, when known. */
export function stageActor(stageId: StageId, stageStatus: StageStatus, blockerOwner?: Department | null): Actor {
  switch (stageStatus) {
    case "waiting_on_employee":
      return { kind: "employee" };
    case "awaiting_approval":
      return STAGE_BY_ID[stageId].checkpoint === "manager_approval" ? { kind: "manager" } : { kind: "department", departments: ["people_ops"] };
    case "revision_requested":
      return { kind: "department", departments: ["people_ops"] };
    case "blocked":
      return { kind: "department", departments: blockerOwner ? [blockerOwner] : stageBlockedOwners(stageId) };
    case "active":
      return { kind: "workflow" };
    case "failed":
      return { kind: "admin" };
    case "pending":
    case "complete":
      return { kind: "nobody" };
  }
}

/**
 * The hub's stage rollup folds revision_requested into `waiting` (projection.ts). Which status that count
 * stands for depends on the stage's gate: at a checkpoint it is a revision (People Ops acts), at an
 * employee-task stage it is the employee's checklist.
 */
export function waitingStatusAt(stageId: StageId): "revision_requested" | "waiting_on_employee" {
  return STAGE_BY_ID[stageId].gate === "approval" ? "revision_requested" : "waiting_on_employee";
}
