// Typed D1 queries shared by routes, agents and workflow steps.
import type { ApprovalView, AuditEventView, BlockerView, IntegrationCallView, StageView, TaskView } from "../../shared/api.ts";
import type { StageId } from "../../shared/stages.ts";
import type { Assignee, BlockerKind, EmploymentType, EquipmentProfile, LicenseBundle, WorkMode } from "../../shared/domain.ts";

export type EmployeeProfile = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  jobTitle: string;
  orgUnit: string;
  employmentType: EmploymentType;
  workMode: WorkMode;
  site: string;
  startDate: string;
  managerId: string;
  equipmentProfile: EquipmentProfile;
  licenseBundle: LicenseBundle;
  needsPrivilegedAccess: boolean;
  costCenter: string;
  photoOnFile: boolean;
};

type EmployeeRow = {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  job_title: string;
  org_unit: string;
  employment_type: EmploymentType;
  work_mode: WorkMode;
  site: string;
  start_date: string;
  manager_id: string;
  equipment_profile: EquipmentProfile;
  license_bundle: LicenseBundle;
  needs_privileged_access: number;
  cost_center: string;
  photo_on_file: number;
};

export function toEmployeeProfile(r: EmployeeRow): EmployeeProfile {
  return {
    id: r.id,
    email: r.email,
    firstName: r.first_name,
    lastName: r.last_name,
    jobTitle: r.job_title,
    orgUnit: r.org_unit,
    employmentType: r.employment_type,
    workMode: r.work_mode,
    site: r.site,
    startDate: r.start_date,
    managerId: r.manager_id,
    equipmentProfile: r.equipment_profile,
    licenseBundle: r.license_bundle,
    needsPrivilegedAccess: r.needs_privileged_access === 1,
    costCenter: r.cost_center,
    photoOnFile: r.photo_on_file === 1,
  };
}

export const EMPLOYEE_COLUMNS =
  "id, email, first_name, last_name, job_title, org_unit, employment_type, work_mode, site, start_date, manager_id, equipment_profile, license_bundle, needs_privileged_access, cost_center, photo_on_file";

export async function getEmployee(db: D1Database, id: string): Promise<EmployeeProfile | null> {
  const r = await db.prepare(`SELECT ${EMPLOYEE_COLUMNS} FROM employees WHERE id = ?`).bind(id).first<EmployeeRow>();
  return r ? toEmployeeProfile(r) : null;
}

// ---------------------------------------------------------------------------
// Row -> view mappers
// ---------------------------------------------------------------------------

export type TaskRow = {
  id: string;
  employee_id: string;
  stage_id: StageId;
  kind: "checklist" | "followup";
  template_key: string | null;
  assignee: Assignee;
  title: string;
  description: string;
  status: "open" | "done" | "cancelled";
  due_at: string | null;
  blocker_id: string | null;
  drafted_by: string | null;
  llm_suggested_category: string | null;
  created_at: string;
  completed_at: string | null;
  completed_by: string | null;
};

export function toTaskView(r: TaskRow): TaskView {
  return {
    id: r.id,
    employeeId: r.employee_id,
    stageId: r.stage_id,
    kind: r.kind,
    templateKey: r.template_key,
    assignee: r.assignee,
    title: r.title,
    description: r.description,
    status: r.status,
    dueAt: r.due_at,
    blockerId: r.blocker_id,
    draftedBy: r.drafted_by,
    llmSuggestedCategory: r.llm_suggested_category,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    completedBy: r.completed_by,
  };
}

export const TASK_COLUMNS =
  "id, employee_id, stage_id, kind, template_key, assignee, title, description, status, due_at, blocker_id, drafted_by, llm_suggested_category, created_at, completed_at, completed_by";

export function getTask(db: D1Database, id: string): Promise<TaskRow | null> {
  return db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`).bind(id).first<TaskRow>();
}

export type ApprovalRow = {
  id: string;
  employee_id: string;
  employee_name: string;
  stage_id: StageId;
  checkpoint: "manager_approval" | "closeout";
  round: number;
  approver_role: "manager" | "coordinator";
  approver_staff_id: string | null;
  status: "pending" | "approved" | "rejected";
  request_json: string;
  privileged_access_approved: number | null;
  requested_at: string;
  due_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decided_on_behalf_of: string | null;
  reason: string | null;
};

export const APPROVAL_SELECT = `SELECT a.id, a.employee_id, e.first_name || ' ' || e.last_name AS employee_name, a.stage_id, a.checkpoint, a.round,
  a.approver_role, a.approver_staff_id, a.status, a.request_json, a.privileged_access_approved, a.requested_at, a.due_at,
  a.decided_at, a.decided_by, a.decided_on_behalf_of, a.reason
  FROM approvals a JOIN employees e ON e.id = a.employee_id`;

export function toApprovalView(r: ApprovalRow): ApprovalView {
  return {
    id: r.id,
    employeeId: r.employee_id,
    employeeName: r.employee_name,
    stageId: r.stage_id,
    checkpoint: r.checkpoint,
    round: r.round,
    approverRole: r.approver_role,
    approverStaffId: r.approver_staff_id,
    status: r.status,
    request: JSON.parse(r.request_json) as Record<string, unknown>,
    privilegedAccessApproved: r.privileged_access_approved === null ? null : r.privileged_access_approved === 1,
    requestedAt: r.requested_at,
    dueAt: r.due_at,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
    decidedOnBehalfOf: r.decided_on_behalf_of,
    reason: r.reason,
  };
}

export function getApproval(db: D1Database, id: string): Promise<ApprovalRow | null> {
  return db.prepare(`${APPROVAL_SELECT} WHERE a.id = ?`).bind(id).first<ApprovalRow>();
}

export type BlockerRow = {
  id: string;
  employee_id: string;
  employee_name: string;
  stage_id: StageId;
  kind: BlockerKind;
  severity: "low" | "medium" | "high";
  owner_department: "people_ops" | "it" | "facilities";
  subject: string;
  status: "open" | "resolved";
  detail_json: string;
  detected_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: string | null;
  follow_up_task_id: string | null;
};

export const BLOCKER_SELECT = `SELECT b.id, b.employee_id, e.first_name || ' ' || e.last_name AS employee_name, b.stage_id, b.kind, b.severity,
  b.owner_department, b.subject, b.status, b.detail_json, b.detected_at, b.resolved_at, b.resolved_by, b.resolution,
  (SELECT t.id FROM tasks t WHERE t.blocker_id = b.id LIMIT 1) AS follow_up_task_id
  FROM blockers b JOIN employees e ON e.id = b.employee_id`;

export function toBlockerView(r: BlockerRow): BlockerView {
  return {
    id: r.id,
    employeeId: r.employee_id,
    employeeName: r.employee_name,
    stageId: r.stage_id,
    kind: r.kind,
    severity: r.severity,
    ownerDepartment: r.owner_department,
    subject: r.subject,
    status: r.status,
    detail: JSON.parse(r.detail_json) as Record<string, unknown>,
    detectedAt: r.detected_at,
    resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by,
    resolution: r.resolution,
    followUpTaskId: r.follow_up_task_id,
  };
}

export function getBlocker(db: D1Database, id: string): Promise<BlockerRow | null> {
  return db.prepare(`${BLOCKER_SELECT} WHERE b.id = ?`).bind(id).first<BlockerRow>();
}

// ---------------------------------------------------------------------------
// Stage, audit, integration call and summary views
// ---------------------------------------------------------------------------

export async function stageViews(db: D1Database, employeeId: string): Promise<StageView[]> {
  const r = await db
    .prepare(
      `SELECT s.id, s.ordinal, s.name, s.owner, cs.status, cs.round, cs.started_at, cs.completed_at, cs.blocked_reason_json
         FROM stages s JOIN case_stages cs ON cs.stage_id = s.id AND cs.employee_id = ? ORDER BY s.ordinal`,
    )
    .bind(employeeId)
    .all<{ id: StageId; ordinal: number; name: string; owner: string; status: StageView["status"]; round: number; started_at: string | null; completed_at: string | null; blocked_reason_json: string | null }>();
  return r.results.map((s) => ({
    id: s.id,
    ordinal: s.ordinal,
    name: s.name,
    owner: s.owner,
    status: s.status,
    round: s.round,
    startedAt: s.started_at,
    completedAt: s.completed_at,
    blockedReason: s.blocked_reason_json ? (JSON.parse(s.blocked_reason_json) as Record<string, unknown>) : null,
  }));
}

export type AuditRow = {
  seq: number;
  id: string;
  occurred_at: string;
  actor_type: AuditEventView["actorType"];
  actor_id: string;
  actor_role: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  employee_id: string | null;
  stage_id: string | null;
  run_no: number | null;
  round: number | null;
  request_id: string | null;
  detail_json: string;
};

export function toAuditView(r: AuditRow): AuditEventView {
  return {
    seq: r.seq,
    id: r.id,
    occurredAt: r.occurred_at,
    actorType: r.actor_type,
    actorId: r.actor_id,
    actorRole: r.actor_role,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    employeeId: r.employee_id,
    stageId: r.stage_id,
    runNo: r.run_no,
    round: r.round,
    requestId: r.request_id,
    detail: JSON.parse(r.detail_json) as Record<string, unknown>,
  };
}

export type IntegrationCallRow = {
  rid: number;
  id: string;
  run_no: number;
  step_name: string;
  system: IntegrationCallView["system"];
  operation: string;
  method: string;
  path: string;
  idempotency_key: string | null;
  attempt: number;
  http_status: number | null;
  outcome: IntegrationCallView["outcome"];
  retry_after_ms: number | null;
  latency_ms: number;
  error: string | null;
  created_at: string;
};

export function toIntegrationCallView(r: IntegrationCallRow): IntegrationCallView {
  return {
    id: r.id,
    runNo: r.run_no,
    stepName: r.step_name,
    system: r.system,
    operation: r.operation,
    method: r.method,
    path: r.path,
    idempotencyKey: r.idempotency_key,
    attempt: r.attempt,
    httpStatus: r.http_status,
    outcome: r.outcome,
    retryAfterMs: r.retry_after_ms,
    latencyMs: r.latency_ms,
    error: r.error,
    createdAt: r.created_at,
  };
}
