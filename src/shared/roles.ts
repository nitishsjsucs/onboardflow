// The four permission roles and the capability matrix from SPEC Section 6.2.
// Department is an attribute of a coordinator principal, not a fifth role.
// The pure policy functions in src/worker/auth/policy.ts implement this matrix;
// the auth-roles test checks both against each other and against the D1 CHECK.
import type { BlockerKind, FixableField, SystemId } from "./domain.ts";

export const ROLES = ["employee", "manager", "coordinator", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const DEPARTMENTS = ["people_ops", "it", "facilities"] as const;
export type Department = (typeof DEPARTMENTS)[number];

/** How a role relates to a capability. */
export type Grant =
  | "yes"
  | "no"
  | "own" // only their own case
  | "reports" // only direct reports
  | "approver" // only approvals assigned to them
  | "department" // only items owned by their department
  | "people_ops" // only coordinators in People Ops
  | "on_behalf"; // admin acting on behalf of the assigned decider (audited)

export const CAPABILITIES = [
  "view_own_case",
  "view_case",
  "complete_checklist_task",
  "start_case",
  "decide_manager_approval",
  "decide_closeout",
  "resubmit_approval",
  "work_followups",
  "retry_stage",
  "fix_profile_field",
  "restart_or_terminate",
  "subscribe_case",
  "subscribe_hub",
  "view_dashboard",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const PERMISSION_MATRIX: Record<Capability, Record<Role, Grant>> = {
  view_own_case: { employee: "own", manager: "no", coordinator: "no", admin: "no" },
  view_case: { employee: "own", manager: "reports", coordinator: "yes", admin: "yes" },
  complete_checklist_task: { employee: "own", manager: "no", coordinator: "no", admin: "yes" },
  start_case: { employee: "no", manager: "no", coordinator: "people_ops", admin: "yes" },
  decide_manager_approval: { employee: "no", manager: "approver", coordinator: "no", admin: "on_behalf" },
  decide_closeout: { employee: "no", manager: "no", coordinator: "people_ops", admin: "on_behalf" },
  resubmit_approval: { employee: "no", manager: "no", coordinator: "people_ops", admin: "yes" },
  work_followups: { employee: "no", manager: "no", coordinator: "department", admin: "yes" },
  retry_stage: { employee: "no", manager: "no", coordinator: "department", admin: "yes" },
  fix_profile_field: { employee: "no", manager: "no", coordinator: "department", admin: "yes" },
  restart_or_terminate: { employee: "no", manager: "no", coordinator: "no", admin: "yes" },
  subscribe_case: { employee: "own", manager: "reports", coordinator: "yes", admin: "yes" },
  subscribe_hub: { employee: "no", manager: "no", coordinator: "yes", admin: "yes" },
  view_dashboard: { employee: "no", manager: "no", coordinator: "yes", admin: "yes" },
};

/** Which department owns each simulated system (integration blockers route here). */
export const SYSTEM_OWNER: Record<SystemId, Department> = {
  hr: "people_ops",
  it: "it",
  facilities: "facilities",
};

/** Which department may correct each profile field (data_issue blockers route here). */
export const FIELD_OWNER: Record<FixableField, Department> = {
  costCenter: "people_ops",
  licenseBundle: "it",
  photoOnFile: "facilities",
};

/** Owner department for the blocker kinds that are not tied to a system or field. */
export const FIXED_BLOCKER_OWNER: Partial<Record<BlockerKind, Department>> = {
  approval_overdue: "people_ops",
  employee_task_overdue: "people_ops",
  approval_rejected: "people_ops",
};

export function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v);
}
export function isDepartment(v: unknown): v is Department {
  return typeof v === "string" && (DEPARTMENTS as readonly string[]).includes(v);
}
