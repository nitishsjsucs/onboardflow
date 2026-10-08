// Closed vocabularies shared by the worker, the web app, the seed generator and
// the eval harness. Every list here is mirrored by a CHECK constraint in
// migrations/ and asserted by tests.

export const CASE_STATUSES = [
  "not_started",
  "in_progress",
  "blocked",
  "awaiting_approval",
  "complete",
  "failed",
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const FAILURE_REASONS = [
  "terminated",
  "approval_rejected_final",
  "recovery_rounds_exhausted",
  "wait_budget_exhausted",
  "workflow_error",
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export const STAGE_STATUSES = [
  "pending",
  "active",
  "waiting_on_employee",
  "awaiting_approval",
  "revision_requested",
  "blocked",
  "complete",
  "failed",
] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

/** Stage statuses in which the workflow is waiting on a gate. */
export const WAITING_STAGE_STATUSES = [
  "waiting_on_employee",
  "awaiting_approval",
  "revision_requested",
  "blocked",
] as const satisfies readonly StageStatus[];

export const BLOCKER_KINDS = [
  "integration_outage",
  "data_issue",
  "provisioning_stalled",
  "approval_overdue",
  "employee_task_overdue",
  "approval_rejected",
] as const;
export type BlockerKind = (typeof BLOCKER_KINDS)[number];

export const SEVERITIES = ["low", "medium", "high"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SYSTEM_IDS = ["hr", "it", "facilities"] as const;
export type SystemId = (typeof SYSTEM_IDS)[number];

export const RESOURCE_TYPES = [
  "hr_worker",
  "hr_documents",
  "hr_orientation",
  "it_account",
  "it_licenses",
  "it_device",
  "fac_workspace",
  "fac_badge",
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const TASK_KINDS = ["checklist", "followup"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const TASK_STATUSES = ["open", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ASSIGNEES = ["employee", "people_ops", "it", "facilities", "manager"] as const;
export type Assignee = (typeof ASSIGNEES)[number];

export const CHECKPOINTS = ["manager_approval", "closeout"] as const;
export type Checkpoint = (typeof CHECKPOINTS)[number];

export const APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const BLOCKER_STATUSES = ["open", "resolved"] as const;
export type BlockerStatus = (typeof BLOCKER_STATUSES)[number];

export const INTEGRATION_OUTCOMES = [
  "ok",
  "replayed",
  "retryable_error",
  "fatal_error",
  "timeout",
  "malformed",
  "conflict",
] as const;
export type IntegrationOutcome = (typeof INTEGRATION_OUTCOMES)[number];

export const FAULT_KINDS = [
  "fail_503",
  "rate_limit_429",
  "timeout",
  "lost_response",
  "malformed",
  "stall",
  "conflict_409",
] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

export const WAKE_REASONS = [
  "tasks_done",
  "approval_decided",
  "resubmitted",
  "retry_requested",
  "nudge",
] as const;
export type WakeReason = (typeof WAKE_REASONS)[number];

export const ACTOR_TYPES = ["user", "agent", "workflow", "system"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const EMPLOYMENT_TYPES = ["full_time", "contractor", "intern"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const WORK_MODES = ["onsite", "hybrid", "remote"] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export const EQUIPMENT_PROFILES = ["standard", "engineering", "design"] as const;
export type EquipmentProfile = (typeof EQUIPMENT_PROFILES)[number];

export const LICENSE_BUNDLES = ["ft-standard", "ft-engineering", "contractor-basic", "intern-basic"] as const;
export type LicenseBundle = (typeof LICENSE_BUNDLES)[number];

/** Bundles the simulated IT system accepts per employment type (genuine 422 otherwise). */
export const ALLOWED_BUNDLES: Record<EmploymentType, readonly LicenseBundle[]> = {
  full_time: ["ft-standard", "ft-engineering"],
  contractor: ["contractor-basic"],
  intern: ["intern-basic"],
};

/** Cost center format the simulated HR system validates. */
export const COST_CENTER_PATTERN = /^CC-\d{4}$/;

export const AUDIT_ACTIONS = [
  "case.started",
  "case.restarted",
  "case.terminated",
  "case.revision_created",
  "case.completed",
  "case.failed",
  "stage.started",
  "stage.gate_passed",
  "stage.waiting_on_employee",
  "stage.awaiting_approval",
  "stage.revision_requested",
  "stage.blocked",
  "stage.retry_requested",
  "stage.retry_rejected",
  "stage.completed",
  "task.created",
  "task.completed",
  "task.completion_conflict",
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "approval.resubmitted",
  "approval.resubmit_rejected",
  "approval.decision_conflict",
  "integration.call",
  "provisioning.updated",
  "blocker.opened",
  "blocker.auto_resolved",
  "blocker.resolved",
  "followup.created",
  "followup.completed",
  "employee.field_corrected",
  "auth.denied",
  "dev.login",
  "eval.fault_set",
  "eval.clock_advanced",
  "eval.agent_evicted",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Employee profile fields a coordinator may correct (data issues). */
export const FIXABLE_FIELDS = ["costCenter", "licenseBundle", "photoOnFile"] as const;
export type FixableField = (typeof FIXABLE_FIELDS)[number];

export function isOneOf<T extends string>(values: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (values as readonly string[]).includes(v);
}
