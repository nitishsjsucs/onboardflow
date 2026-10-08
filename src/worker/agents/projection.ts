// D1 -> CaseState. One DB.batch (a single transaction) reads every table the
// projection needs plus max(audit_events.seq), so asOfSeq describes exactly
// the snapshot the state was computed from.
import type { CaseState, CaseStageState } from "../../shared/agent-state.ts";
import type { BlockerKind, CaseStatus, FailureReason, ResourceType, StageStatus, SystemId } from "../../shared/domain.ts";
import type { Department } from "../../shared/roles.ts";
import type { StageId } from "../../shared/stages.ts";
import type { BlockedReasonJson, ScanSnapshot } from "./blocker-rules.ts";

export async function projectCase(db: D1Database, employeeId: string, workflowStatus: string | null, nowIso: string): Promise<CaseState | null> {
  const [emp, kase, stages, empTasks, deptTasks, approval, prov, blockers, seq] = await db.batch([
    db.prepare("SELECT first_name || ' ' || last_name AS name FROM employees WHERE id = ?").bind(employeeId),
    db.prepare("SELECT status, failure_reason, current_stage, workflow_instance_id, run_no, revision FROM cases WHERE employee_id = ?").bind(employeeId),
    db
      .prepare(
        `SELECT cs.stage_id, s.ordinal, cs.status, cs.round, cs.started_at, cs.completed_at
           FROM case_stages cs JOIN stages s ON s.id = cs.stage_id WHERE cs.employee_id = ? ORDER BY s.ordinal`,
      )
      .bind(employeeId),
    db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE employee_id = ? AND assignee = 'employee' AND status = 'open'")
      .bind(employeeId),
    db
      .prepare(
        "SELECT assignee, COUNT(*) AS n FROM tasks WHERE employee_id = ? AND status = 'open' AND assignee IN ('people_ops','it','facilities') GROUP BY assignee",
      )
      .bind(employeeId),
    db
      .prepare("SELECT id, checkpoint, round, due_at FROM approvals WHERE employee_id = ? AND status = 'pending' ORDER BY requested_at LIMIT 1")
      .bind(employeeId),
    db
      .prepare("SELECT system, resource, status, external_id, polls FROM provisioning_items WHERE employee_id = ? ORDER BY system, resource")
      .bind(employeeId),
    db
      .prepare("SELECT id, kind, stage_id, owner_department, detected_at FROM blockers WHERE employee_id = ? AND status = 'open' ORDER BY detected_at, id")
      .bind(employeeId),
    db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM audit_events"),
  ]);
  const e = emp?.results[0] as { name: string } | undefined;
  const c = kase?.results[0] as
    | { status: CaseStatus; failure_reason: FailureReason | null; current_stage: StageId | null; workflow_instance_id: string | null; run_no: number; revision: number }
    | undefined;
  if (!e || !c) return null;
  const departments: Record<Department, number> = { people_ops: 0, it: 0, facilities: 0 };
  for (const r of (deptTasks?.results ?? []) as Array<{ assignee: Department; n: number }>) departments[r.assignee] = r.n;
  const a = approval?.results[0] as { id: string; checkpoint: "manager_approval" | "closeout"; round: number; due_at: string } | undefined;
  return {
    employeeId,
    displayName: e.name,
    status: c.status,
    failureReason: c.failure_reason,
    currentStage: c.current_stage,
    stages: ((stages?.results ?? []) as Array<{ stage_id: StageId; ordinal: number; status: StageStatus; round: number; started_at: string | null; completed_at: string | null }>).map(
      (s): CaseStageState => ({ id: s.stage_id, ordinal: s.ordinal, status: s.status, round: s.round, startedAt: s.started_at, completedAt: s.completed_at }),
    ),
    openTasks: { employee: ((empTasks?.results[0] as { n: number } | undefined)?.n ?? 0), departments },
    pendingApproval: a ? { id: a.id, checkpoint: a.checkpoint, round: a.round, dueAt: a.due_at } : null,
    provisioning: ((prov?.results ?? []) as Array<{ system: SystemId; resource: ResourceType; status: string; external_id: string | null; polls: number }>).map((p) => ({
      system: p.system,
      resource: p.resource,
      status: p.status,
      externalId: p.external_id,
      polls: p.polls,
    })),
    openBlockers: ((blockers?.results ?? []) as Array<{ id: string; kind: BlockerKind; stage_id: StageId; owner_department: Department; detected_at: string }>).map((b) => ({
      id: b.id,
      kind: b.kind,
      stageId: b.stage_id,
      ownerDepartment: b.owner_department,
      detectedAt: b.detected_at,
    })),
    workflow: { instanceId: c.workflow_instance_id, runNo: c.run_no, revision: c.revision, status: workflowStatus },
    asOfSeq: ((seq?.results[0] as { seq: number } | undefined)?.seq ?? 0),
    projectedAt: nowIso,
  };
}

// ---------------------------------------------------------------------------
// D1 -> ScanSnapshot (input of the pure rule engine in blocker-rules.ts)
// ---------------------------------------------------------------------------

export async function loadScanSnapshot(db: D1Database, employeeId: string): Promise<ScanSnapshot | null> {
  const [emp, kase, stages, approvals, open, progress, prov, ok, blockers] = await db.batch([
    db.prepare("SELECT first_name || ' ' || last_name AS name FROM employees WHERE id = ?").bind(employeeId),
    db.prepare("SELECT status FROM cases WHERE employee_id = ?").bind(employeeId),
    db.prepare("SELECT stage_id, status, round, blocked_reason_json, last_wake_at FROM case_stages WHERE employee_id = ?").bind(employeeId),
    db.prepare("SELECT id, stage_id, checkpoint, round, status, due_at FROM approvals WHERE employee_id = ?").bind(employeeId),
    db
      .prepare("SELECT id, stage_id, due_at FROM tasks WHERE employee_id = ? AND kind = 'checklist' AND assignee = 'employee' AND status = 'open'")
      .bind(employeeId),
    db
      .prepare(
        `SELECT stage_id, COUNT(*) AS total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
           FROM tasks WHERE employee_id = ? AND kind = 'checklist' AND assignee = 'employee' GROUP BY stage_id`,
      )
      .bind(employeeId),
    db.prepare("SELECT resource, status FROM provisioning_items WHERE employee_id = ?").bind(employeeId),
    db
      .prepare("SELECT operation, MAX(created_at) AS last_at FROM integration_calls WHERE employee_id = ? AND outcome IN ('ok','replayed') GROUP BY operation")
      .bind(employeeId),
    db
      .prepare("SELECT id, kind, stage_id, subject, dedupe_key, detected_at, detail_json FROM blockers WHERE employee_id = ? AND status = 'open'")
      .bind(employeeId),
  ]);
  const e = emp?.results[0] as { name: string } | undefined;
  const c = kase?.results[0] as { status: string } | undefined;
  if (!e || !c) return null;
  const parse = (j: string | null): BlockedReasonJson | null => {
    if (!j) return null;
    try {
      return JSON.parse(j) as BlockedReasonJson;
    } catch {
      return null;
    }
  };
  return {
    employeeId,
    employeeName: e.name,
    caseStatus: c.status,
    stages: ((stages?.results ?? []) as Array<{ stage_id: StageId; status: string; round: number; blocked_reason_json: string | null; last_wake_at: string | null }>).map((s) => ({
      id: s.stage_id,
      status: s.status,
      round: s.round,
      blockedReason: parse(s.blocked_reason_json),
      lastWakeAt: s.last_wake_at,
    })),
    approvals: ((approvals?.results ?? []) as Array<{ id: string; stage_id: StageId; checkpoint: "manager_approval" | "closeout"; round: number; status: "pending" | "approved" | "rejected"; due_at: string }>).map(
      (a) => ({ id: a.id, stageId: a.stage_id, checkpoint: a.checkpoint, round: a.round, status: a.status, dueAt: a.due_at }),
    ),
    openChecklist: ((open?.results ?? []) as Array<{ id: string; stage_id: StageId; due_at: string | null }>).map((t) => ({ id: t.id, stageId: t.stage_id, dueAt: t.due_at })),
    checklistProgress: ((progress?.results ?? []) as Array<{ stage_id: StageId; total: number; done: number | null }>).map((p) => ({ stageId: p.stage_id, total: p.total, done: p.done ?? 0 })),
    provisioning: ((prov?.results ?? []) as Array<{ resource: ResourceType; status: string }>).map((p) => ({ resource: p.resource, status: p.status })),
    successes: ((ok?.results ?? []) as Array<{ operation: string; last_at: string }>).map((x) => ({ operation: x.operation, lastAt: x.last_at })),
    openBlockers: ((blockers?.results ?? []) as Array<{ id: string; kind: BlockerKind; stage_id: StageId; subject: string; dedupe_key: string; detected_at: string; detail_json: string }>).map(
      (b) => ({ id: b.id, kind: b.kind, stageId: b.stage_id, subject: b.subject, dedupeKey: b.dedupe_key, detectedAt: b.detected_at, detail: JSON.parse(b.detail_json) as Record<string, unknown> }),
    ),
  };
}
