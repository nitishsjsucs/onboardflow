// Route policies (SPEC Section 6.2): pure functions over (principal, resource).
// They implement PERMISSION_MATRIX in src/shared/roles.ts; auth-roles.test.ts
// checks every function against the matrix and every route against both.
import type { Assignee, Checkpoint, FixableField } from "../../shared/domain.ts";
import { type Capability, type Department, FIELD_OWNER, type Grant, PERMISSION_MATRIX } from "../../shared/roles.ts";
import { EMPLOYEE_ID_PATTERN } from "../../shared/ids.ts";
import type { Principal } from "../http.ts";

export type CaseRef = { employeeId: string; managerId: string };
export type TaskRef = { employeeId: string; kind: "checklist" | "followup"; assignee: Assignee };
export type ApprovalRef = { checkpoint: Checkpoint; approverStaffId: string | null };

export type Decision = { allowed: boolean; onBehalfOf?: string };

export function grant(p: Principal, cap: Capability): Grant {
  return PERMISSION_MATRIX[cap][p.role];
}

export function canViewCase(p: Principal, c: CaseRef): boolean {
  switch (grant(p, "view_case")) {
    case "yes":
      return true;
    case "own":
      return p.employeeId === c.employeeId;
    case "reports":
      return p.staffId !== undefined && p.staffId === c.managerId;
    default:
      return false;
  }
}

/** Checklist tasks: the employee themself, or an admin. Follow-ups: the owning department, or an admin. */
export function canCompleteTask(p: Principal, t: TaskRef): boolean {
  if (t.kind === "checklist") {
    const g = grant(p, "complete_checklist_task");
    if (g === "yes") return true;
    return g === "own" && t.assignee === "employee" && p.employeeId === t.employeeId;
  }
  return canWorkDepartment(p, t.assignee);
}

/** Work follow-ups and blockers owned by a department. */
export function canWorkDepartment(p: Principal, owner: Assignee | Department): boolean {
  const g = grant(p, "work_followups");
  if (g === "yes") return true;
  return g === "department" && p.department !== undefined && p.department === owner;
}

export function canDecideApproval(p: Principal, a: ApprovalRef): Decision {
  const cap: Capability = a.checkpoint === "manager_approval" ? "decide_manager_approval" : "decide_closeout";
  switch (grant(p, cap)) {
    case "approver":
      return { allowed: p.staffId !== undefined && p.staffId === a.approverStaffId };
    case "people_ops":
      return { allowed: p.department === "people_ops" };
    case "on_behalf":
      return {
        allowed: true,
        onBehalfOf: a.checkpoint === "manager_approval" ? (a.approverStaffId ?? "manager") : "people_ops",
      };
    case "yes":
      return { allowed: true };
    default:
      return { allowed: false };
  }
}

function peopleOpsOrYes(p: Principal, cap: Capability): boolean {
  const g = grant(p, cap);
  return g === "yes" || (g === "people_ops" && p.department === "people_ops");
}

export function canStartCase(p: Principal): boolean {
  return peopleOpsOrYes(p, "start_case");
}

export function canResubmit(p: Principal): boolean {
  return peopleOpsOrYes(p, "resubmit_approval");
}

/**
 * Retry a blocked stage: the department that owns the stage's open blocker.
 * With no open blocker, the stage's owning department (so a retry of a stage
 * that is not blocked reaches the guarded 409 instead of a 403).
 */
export function canRetryStage(p: Principal, owner: Department): boolean {
  const g = grant(p, "retry_stage");
  if (g === "yes") return true;
  return g === "department" && p.department === owner;
}

export function canFixField(p: Principal, field: FixableField): boolean {
  const g = grant(p, "fix_profile_field");
  if (g === "yes") return true;
  return g === "department" && p.department === FIELD_OWNER[field];
}

export function canRestartOrTerminate(p: Principal): boolean {
  return grant(p, "restart_or_terminate") === "yes";
}

export function canViewDashboard(p: Principal): boolean {
  return grant(p, "view_dashboard") === "yes";
}

export type AgentClass = "CASE_AGENT" | "OPS_HUB_AGENT";

/**
 * WebSocket subscriptions (SPEC 10.3). `name` must already be validated:
 * CASE_AGENT names match ^E\d{3}$ and exist in D1; OPS_HUB_AGENT is "global".
 */
export function canSubscribe(p: Principal, className: string, name: string, c?: CaseRef): boolean {
  if (className === "CASE_AGENT") {
    if (!EMPLOYEE_ID_PATTERN.test(name) || !c || c.employeeId !== name) return false;
    const g = grant(p, "subscribe_case");
    if (g === "yes") return true;
    if (g === "own") return p.employeeId === name;
    if (g === "reports") return p.staffId !== undefined && p.staffId === c.managerId;
    return false;
  }
  if (className === "OPS_HUB_AGENT") {
    return name === "global" && grant(p, "subscribe_hub") === "yes";
  }
  return false;
}
