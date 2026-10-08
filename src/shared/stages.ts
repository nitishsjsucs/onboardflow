// The eight onboarding stages (SPEC Section 6.1), the simulated operations each
// stage performs, and the ten employee checklist templates. migrations/0001
// mirrors STAGES and TASK_TEMPLATES; stages.test.ts asserts they are equal.
import type { Assignee, Checkpoint, ResourceType, SystemId } from "./domain.ts";

export const STAGE_IDS = [
  "intake",
  "paperwork",
  "manager_approval",
  "it_provisioning",
  "facilities_setup",
  "provisioning_verification",
  "orientation",
  "closeout",
] as const;
export type StageId = (typeof STAGE_IDS)[number];

export type StageOwner = "people_ops" | "it" | "facilities" | "manager";
/** D1 `stages.gate` column: what kind of human input the stage waits for. */
export type StageGate = "auto" | "employee_tasks" | "approval";
/** The four gate kinds the workflow checks in D1 before every wait (SPEC 6.1). */
export const GATE_KINDS = ["tasks", "decision", "resubmit", "retry"] as const;
export type GateKind = (typeof GATE_KINDS)[number];

export const OPERATION_IDS = [
  "hr.create-worker",
  "hr.start-document-verification",
  "hr.get-document-verification",
  "hr.enroll-orientation",
  "hr.activate-worker",
  "hr.get-worker",
  "it.create-account",
  "it.assign-licenses",
  "it.order-device",
  "it.get-device-order",
  "it.get-account",
  "facilities.assign-workspace",
  "facilities.issue-badge",
  "facilities.get-badge",
] as const;
export type OperationId = (typeof OPERATION_IDS)[number];

export type OperationDef = {
  id: OperationId;
  system: SystemId;
  method: "GET" | "POST";
  resource: ResourceType;
  /** Async resource this POST creates and the workflow polls until terminal. */
  polledBy?: OperationId;
};

export const OPERATIONS: Record<OperationId, OperationDef> = {
  "hr.create-worker": { id: "hr.create-worker", system: "hr", method: "POST", resource: "hr_worker" },
  "hr.start-document-verification": {
    id: "hr.start-document-verification",
    system: "hr",
    method: "POST",
    resource: "hr_documents",
    polledBy: "hr.get-document-verification",
  },
  "hr.get-document-verification": { id: "hr.get-document-verification", system: "hr", method: "GET", resource: "hr_documents" },
  "hr.enroll-orientation": { id: "hr.enroll-orientation", system: "hr", method: "POST", resource: "hr_orientation" },
  "hr.activate-worker": { id: "hr.activate-worker", system: "hr", method: "POST", resource: "hr_worker" },
  "hr.get-worker": { id: "hr.get-worker", system: "hr", method: "GET", resource: "hr_worker" },
  "it.create-account": { id: "it.create-account", system: "it", method: "POST", resource: "it_account" },
  "it.assign-licenses": { id: "it.assign-licenses", system: "it", method: "POST", resource: "it_licenses" },
  "it.order-device": {
    id: "it.order-device",
    system: "it",
    method: "POST",
    resource: "it_device",
    polledBy: "it.get-device-order",
  },
  "it.get-device-order": { id: "it.get-device-order", system: "it", method: "GET", resource: "it_device" },
  "it.get-account": { id: "it.get-account", system: "it", method: "GET", resource: "it_account" },
  "facilities.assign-workspace": {
    id: "facilities.assign-workspace",
    system: "facilities",
    method: "POST",
    resource: "fac_workspace",
  },
  "facilities.issue-badge": {
    id: "facilities.issue-badge",
    system: "facilities",
    method: "POST",
    resource: "fac_badge",
    polledBy: "facilities.get-badge",
  },
  "facilities.get-badge": { id: "facilities.get-badge", system: "facilities", method: "GET", resource: "fac_badge" },
};

/** Terminal status of each polled async resource. */
export const POLL_TERMINAL: Partial<Record<ResourceType, string>> = {
  hr_documents: "verified",
  it_device: "delivered",
  fac_badge: "active",
};

export type StageDef = {
  id: StageId;
  ordinal: number;
  name: string;
  owner: StageOwner;
  gate: StageGate;
  /** Operations run by the workflow in order (POSTs poll their resource when `polledBy` is set). */
  operations: readonly OperationId[];
  /** For employee_tasks stages: whether the operations run before or after the tasks gate. */
  operationsAfterGate?: boolean;
  checkpoint?: Checkpoint;
};

export const STAGES: readonly StageDef[] = [
  { id: "intake", ordinal: 1, name: "Pre-boarding intake", owner: "people_ops", gate: "auto", operations: ["hr.create-worker"] },
  {
    id: "paperwork",
    ordinal: 2,
    name: "Paperwork and verification",
    owner: "people_ops",
    gate: "employee_tasks",
    operations: ["hr.start-document-verification"],
    operationsAfterGate: true,
  },
  {
    id: "manager_approval",
    ordinal: 3,
    name: "Manager approval of equipment and access",
    owner: "manager",
    gate: "approval",
    operations: [],
    checkpoint: "manager_approval",
  },
  {
    id: "it_provisioning",
    ordinal: 4,
    name: "IT provisioning",
    owner: "it",
    gate: "auto",
    operations: ["it.create-account", "it.assign-licenses", "it.order-device"],
  },
  {
    id: "facilities_setup",
    ordinal: 5,
    name: "Facilities setup",
    owner: "facilities",
    gate: "auto",
    operations: ["facilities.assign-workspace", "facilities.issue-badge"],
  },
  {
    id: "provisioning_verification",
    ordinal: 6,
    name: "Cross-system provisioning check",
    owner: "it",
    gate: "auto",
    operations: ["hr.get-worker", "it.get-account", "facilities.get-badge"],
  },
  {
    id: "orientation",
    ordinal: 7,
    name: "Orientation and day one",
    owner: "people_ops",
    gate: "employee_tasks",
    operations: ["hr.enroll-orientation"],
    operationsAfterGate: false,
  },
  {
    id: "closeout",
    ordinal: 8,
    name: "People Ops sign-off",
    owner: "people_ops",
    gate: "approval",
    operations: ["hr.activate-worker"],
    checkpoint: "closeout",
  },
];

export const STAGE_BY_ID: Record<StageId, StageDef> = Object.fromEntries(STAGES.map((s) => [s.id, s])) as Record<
  StageId,
  StageDef
>;

export function isStageId(v: unknown): v is StageId {
  return typeof v === "string" && (STAGE_IDS as readonly string[]).includes(v);
}

/** Operations the workflow issues once per round, across all stages (12). */
export const FIRST_ROUND_OPERATIONS: readonly OperationId[] = STAGES.flatMap((s) => s.operations);
/** Async resources the workflow polls (3: documents, device order, badge). */
export const POLLED_OPERATIONS: readonly OperationId[] = FIRST_ROUND_OPERATIONS.filter(
  (op) => OPERATIONS[op].polledBy !== undefined,
);

export type TaskTemplate = {
  key: string;
  stageId: StageId;
  assignee: Assignee;
  title: string;
  description: string;
  /** Days relative to employees.start_date. */
  dueOffsetDays: number;
  sort: number;
};

export const TASK_TEMPLATES: readonly TaskTemplate[] = [
  { key: "offer_docs", stageId: "paperwork", assignee: "employee", title: "Sign offer documents", description: "Review and sign the offer letter and confidentiality agreement.", dueOffsetDays: -14, sort: 1 },
  { key: "i9_section1", stageId: "paperwork", assignee: "employee", title: "Complete Form I-9 Section 1", description: "Fill in Section 1 of Form I-9 (synthetic, no real documents).", dueOffsetDays: -7, sort: 2 },
  { key: "w4", stageId: "paperwork", assignee: "employee", title: "Submit Form W-4", description: "Provide federal tax withholding elections.", dueOffsetDays: -7, sort: 3 },
  { key: "direct_deposit", stageId: "paperwork", assignee: "employee", title: "Set up direct deposit", description: "Enter payroll deposit preferences (synthetic data only).", dueOffsetDays: -7, sort: 4 },
  { key: "emergency_contact", stageId: "paperwork", assignee: "employee", title: "Add an emergency contact", description: "Name one emergency contact.", dueOffsetDays: -7, sort: 5 },
  { key: "badge_photo", stageId: "paperwork", assignee: "employee", title: "Upload a badge photo", description: "Provide a photo for the building badge.", dueOffsetDays: -10, sort: 6 },
  { key: "attend_orientation", stageId: "orientation", assignee: "employee", title: "Attend orientation", description: "Join the new hire orientation session.", dueOffsetDays: 1, sort: 7 },
  { key: "enroll_mfa", stageId: "orientation", assignee: "employee", title: "Enroll in MFA", description: "Register a second factor for your account.", dueOffsetDays: 0, sort: 8 },
  { key: "security_training", stageId: "orientation", assignee: "employee", title: "Complete security training", description: "Finish the security awareness module.", dueOffsetDays: 3, sort: 9 },
  { key: "meet_buddy", stageId: "orientation", assignee: "employee", title: "Meet your onboarding buddy", description: "Schedule a first chat with your buddy.", dueOffsetDays: 5, sort: 10 },
];
