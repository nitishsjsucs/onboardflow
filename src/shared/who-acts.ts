// Who has to act on a stage in a given state. The dashboard's stage chart, the
// case page's sentence and a manager's team rows all say who the work waits on;
// they take it from here so the three never disagree.
//
// The answer is structural, except at a blocked stage: an employee-task stage
// waits on the employee, the manager_approval checkpoint on the hiring manager,
// closeout and every revision on People Ops. A blocked stage waits on the
// department that owns the open blocker it is blocked by (blockingBlocker picks
// it; the hub's stage rollup and the employees list pick it the same way in
// SQL, with BLOCKING_BLOCKER_ORDER). Only while no blocker is open yet (the
// CaseAgent's scan opens it just after the stage blocks) does a blocked stage
// fall back to the departments that own the simulated systems it calls
// (SYSTEM_OWNER): one for most stages, all three at the cross-system check.
import type { BlockerKind, StageStatus } from "./domain.ts";
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

/**
 * The open blocker a blocked stage is blocked by, of the open blockers at that stage: a data issue first (an
 * outage blocker can stay open beside the data issue a later retry hit, and the data issue is what blocks now),
 * else the earliest detected, then the lowest id. SQL that needs the same pick orders by BLOCKING_BLOCKER_ORDER.
 */
export function blockingBlocker<B extends { kind: BlockerKind; detectedAt: string; id: string }>(openAtStage: readonly B[]): B | null {
  const binary = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0); // SQLite's BINARY collation
  const sorted = [...openAtStage].sort((a, b) => Number(b.kind === "data_issue") - Number(a.kind === "data_issue") || binary(a.detectedAt, b.detectedAt) || binary(a.id, b.id));
  return sorted[0] ?? null;
}

/** blockingBlocker's order as an SQL ORDER BY over `blockers b` (test/worker/blocked-owner.test.ts checks they agree). */
export const BLOCKING_BLOCKER_ORDER = "(b.kind = 'data_issue') DESC, b.detected_at, b.id";

/**
 * Who acts on a stage's blocked cases, for the dashboard. The hub counts them by the owner of the blocker each
 * one is blocked by (`blockedBy`), so every department named acts on cases of its own (`exact`). A blocked case
 * with no open blocker yet, or a hub state saved before `blockedBy` existed, counts for the stage's structural
 * owners instead, as the case page does without a blocker: one of those acts, and `exact` is false.
 */
export function blockedOwnersAt(stageId: StageId, blocked: number, blockedBy?: Partial<Record<Department, number>>): { departments: Department[]; exact: boolean } {
  const known = DEPARTMENTS.filter((d) => (blockedBy?.[d] ?? 0) > 0);
  const covered = known.reduce((a, d) => a + (blockedBy?.[d] ?? 0), 0);
  if (known.length > 0 && covered >= blocked) return { departments: known, exact: true };
  const any = new Set<Department>([...known, ...stageBlockedOwners(stageId)]);
  return { departments: DEPARTMENTS.filter((d) => any.has(d)), exact: false };
}

/** Who acts on a stage in this status. `blockerOwner`: the owner department of the stage's blockingBlocker, when one is open. */
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
