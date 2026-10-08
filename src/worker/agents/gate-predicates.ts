// D1 gate predicates (ADR 0002). The workflow checks these in a step before
// every wait and after every wake-up or bounded timeout; the CaseAgent's scan
// uses the same predicates to nudge a workflow whose wake-up was lost. Events
// never carry decisions: only these reads decide whether a gate is open.
import type { Checkpoint } from "../../shared/domain.ts";
import type { StageId } from "../../shared/stages.ts";

export type GateSpec =
  | { kind: "tasks"; stage: StageId }
  | { kind: "decision"; approvalId: string }
  | { kind: "resubmit"; stage: StageId; round: number }
  | { kind: "retry"; stage: StageId; round: number };

export type GateResult =
  | { satisfied: false }
  | { satisfied: true; kind: "tasks" }
  | { satisfied: true; kind: "decision"; status: "approved" | "rejected"; privilegedAccessApproved: boolean | null }
  | { satisfied: true; kind: "round"; round: number };

/** Every employee checklist task of the stage is done (and the checklist exists). */
export async function tasksDone(db: D1Database, employeeId: string, stage: StageId): Promise<boolean> {
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
         FROM tasks WHERE employee_id = ? AND stage_id = ? AND kind = 'checklist' AND assignee = 'employee'`,
    )
    .bind(employeeId, stage)
    .first<{ total: number; done: number | null }>();
  return !!r && r.total > 0 && (r.done ?? 0) === r.total;
}

/** Approval `apr:<employee>:<checkpoint>:<round>` is decided. Keyed by id, so no other checkpoint or round can satisfy it. */
export async function approvalDecision(db: D1Database, approvalId: string): Promise<GateResult> {
  const r = await db
    .prepare("SELECT status, privileged_access_approved FROM approvals WHERE id = ?")
    .bind(approvalId)
    .first<{ status: string; privileged_access_approved: number | null }>();
  if (!r || (r.status !== "approved" && r.status !== "rejected")) return { satisfied: false };
  return {
    satisfied: true,
    kind: "decision",
    status: r.status,
    privilegedAccessApproved: r.privileged_access_approved === null ? null : r.privileged_access_approved === 1,
  };
}

/** case_stages.round has advanced past `round` (a resubmission or a retry was committed). */
export async function roundAdvanced(db: D1Database, employeeId: string, stage: StageId, round: number): Promise<GateResult> {
  const r = await db
    .prepare("SELECT round FROM case_stages WHERE employee_id = ? AND stage_id = ?")
    .bind(employeeId, stage)
    .first<{ round: number }>();
  return r && r.round > round ? { satisfied: true, kind: "round", round: r.round } : { satisfied: false };
}

export async function evaluateGate(db: D1Database, employeeId: string, g: GateSpec): Promise<GateResult> {
  switch (g.kind) {
    case "tasks":
      return (await tasksDone(db, employeeId, g.stage)) ? { satisfied: true, kind: "tasks" } : { satisfied: false };
    case "decision":
      return approvalDecision(db, g.approvalId);
    case "resubmit":
    case "retry":
      return roundAdvanced(db, employeeId, g.stage, g.round);
  }
}

export function checkpointOf(stage: StageId): Checkpoint | null {
  return stage === "manager_approval" || stage === "closeout" ? stage : null;
}
