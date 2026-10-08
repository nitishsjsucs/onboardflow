// HTTP API contract shared by the worker, the web client and the tests: the
// route registry (every /api route with the roles that may pass its role
// gate), zod request schemas, and zod response schemas from which the DTO
// types are derived. api-routes.test.ts validates every response against
// these schemas, and auth-roles.test.ts iterates the registry.
import { z } from "zod";
import {
  APPROVAL_STATUSES,
  ASSIGNEES,
  BLOCKER_KINDS,
  CASE_STATUSES,
  EMPLOYMENT_TYPES,
  EQUIPMENT_PROFILES,
  FAILURE_REASONS,
  INTEGRATION_OUTCOMES,
  LICENSE_BUNDLES,
  RESOURCE_TYPES,
  SEVERITIES,
  STAGE_STATUSES,
  SYSTEM_IDS,
  TASK_STATUSES,
  WORK_MODES,
} from "./domain.ts";
import { DEPARTMENTS, ROLES, type Role } from "./roles.ts";
import { STAGE_IDS } from "./stages.ts";

// ---------------------------------------------------------------------------
// Route registry
// ---------------------------------------------------------------------------
export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export type RouteDef = {
  id: string;
  method: HttpMethod;
  path: string;
  /** "public" needs no token; otherwise the roles that may pass the role gate (resource policy may narrow further). */
  roles: "public" | readonly Role[];
};

const ALL: readonly Role[] = ["employee", "manager", "coordinator", "admin"];
const STAFF: readonly Role[] = ["manager", "coordinator", "admin"];
const OPS: readonly Role[] = ["coordinator", "admin"];
const ADMIN: readonly Role[] = ["admin"];

export const API_ROUTES = [
  { id: "health", method: "GET", path: "/api/health", roles: "public" },
  { id: "me", method: "GET", path: "/api/me", roles: ALL },
  { id: "me.checklist", method: "GET", path: "/api/me/checklist", roles: ["employee"] },
  { id: "employees.list", method: "GET", path: "/api/employees", roles: STAFF },
  { id: "employees.get", method: "GET", path: "/api/employees/:id", roles: ALL },
  { id: "employees.patch", method: "PATCH", path: "/api/employees/:id", roles: OPS },
  { id: "cases.start", method: "POST", path: "/api/cases/:id/start", roles: OPS },
  { id: "cases.get", method: "GET", path: "/api/cases/:id", roles: ALL },
  { id: "cases.audit", method: "GET", path: "/api/cases/:id/audit", roles: ALL },
  { id: "cases.integrations", method: "GET", path: "/api/cases/:id/integrations", roles: OPS },
  { id: "cases.retry", method: "POST", path: "/api/cases/:id/stages/:stage/retry", roles: OPS },
  { id: "cases.scan", method: "POST", path: "/api/cases/:id/scan", roles: OPS },
  { id: "cases.restart", method: "POST", path: "/api/cases/:id/restart", roles: ADMIN },
  { id: "cases.terminate", method: "POST", path: "/api/cases/:id/terminate", roles: ADMIN },
  { id: "tasks.complete", method: "POST", path: "/api/tasks/:taskId/complete", roles: ALL },
  { id: "approvals.list", method: "GET", path: "/api/approvals", roles: STAFF },
  { id: "approvals.decision", method: "POST", path: "/api/approvals/:id/decision", roles: STAFF },
  { id: "approvals.resubmit", method: "POST", path: "/api/approvals/:id/resubmit", roles: OPS },
  { id: "blockers.list", method: "GET", path: "/api/blockers", roles: OPS },
  { id: "blockers.resolve", method: "POST", path: "/api/blockers/:id/resolve", roles: OPS },
  { id: "followups.list", method: "GET", path: "/api/followups", roles: OPS },
  { id: "dashboard.summary", method: "GET", path: "/api/dashboard/summary", roles: OPS },
  { id: "integrations.health", method: "GET", path: "/api/integrations/health", roles: OPS },
  { id: "audit.list", method: "GET", path: "/api/audit", roles: ADMIN },
] as const satisfies readonly RouteDef[];

export type RouteId = (typeof API_ROUTES)[number]["id"];

export const MAX_PAGE = 100;
export const DEFAULT_PAGE = 50;

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------
const note = z.string().trim().max(1000);

export const EmptyBody = z.object({}).strict();
export const NoteBody = z.object({ note: note.optional() });
export const ReasonBody = z.object({ reason: note.min(1) });
export const DecisionBody = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: note.optional(),
  privilegedAccessApproved: z.boolean().optional(),
});
export const ResubmitBody = z.object({ note: note.min(1) });
export const ResolveBody = z.object({ resolution: note.min(1) });
/** Exactly one field per request, so each correction is its own audited change. */
export const PatchEmployeeBody = z
  .object({
    costCenter: z.string().trim().min(1).max(32).optional(),
    licenseBundle: z.enum(LICENSE_BUNDLES).optional(),
    photoOnFile: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length === 1, { message: "send exactly one of costCenter, licenseBundle, photoOnFile" });

const limit = z.coerce.number().int().min(1).max(MAX_PAGE).optional();
export const PageQuery = z.object({ cursor: z.string().optional(), limit });
export const EmployeesQuery = PageQuery.extend({
  stage: z.enum(STAGE_IDS).optional(),
  status: z.enum(CASE_STATUSES).optional(),
  orgUnit: z.string().optional(),
  q: z.string().max(100).optional(),
});
export const ApprovalsQuery = PageQuery.extend({ status: z.enum([...APPROVAL_STATUSES, "all"]).optional() });
export const BlockersQuery = PageQuery.extend({
  status: z.enum(["open", "resolved", "all"]).optional(),
  department: z.enum(DEPARTMENTS).optional(),
  kind: z.enum(BLOCKER_KINDS).optional(),
});
export const FollowupsQuery = PageQuery.extend({ status: z.enum([...TASK_STATUSES, "all"]).optional(), department: z.enum(DEPARTMENTS).optional() });
export const AuditQuery = PageQuery.extend({ action: z.string().optional(), actor: z.string().optional(), employeeId: z.string().optional() });
export const HealthQuery = z.object({ window: z.enum(["1h", "24h", "7d", "all"]).optional() });

// ---------------------------------------------------------------------------
// Response schemas and DTO types
// ---------------------------------------------------------------------------
export const page = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item), nextCursor: z.string().nullable() });
export type Page<T> = { items: T[]; nextCursor: string | null };

export const ErrorEnvelopeSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), requestId: z.string() }) });
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

export const Health = z.object({ ok: z.literal(true), authMode: z.enum(["access", "dev"]), version: z.string() });

export const Me = z.object({
  email: z.string(),
  role: z.enum(ROLES),
  displayName: z.string(),
  employeeId: z.string().optional(),
  staffId: z.string().optional(),
  department: z.enum(DEPARTMENTS).optional(),
});
export type MeDto = z.infer<typeof Me>;

export const TaskViewSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  stageId: z.enum(STAGE_IDS),
  kind: z.enum(["checklist", "followup"]),
  templateKey: z.string().nullable(),
  assignee: z.enum(ASSIGNEES),
  title: z.string(),
  description: z.string(),
  status: z.enum(TASK_STATUSES),
  dueAt: z.string().nullable(),
  blockerId: z.string().nullable(),
  draftedBy: z.string().nullable(),
  llmSuggestedCategory: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  completedBy: z.string().nullable(),
});
export type TaskView = z.infer<typeof TaskViewSchema>;

export const ApprovalViewSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  employeeName: z.string(),
  stageId: z.enum(STAGE_IDS),
  checkpoint: z.enum(["manager_approval", "closeout"]),
  round: z.number().int(),
  approverRole: z.enum(["manager", "coordinator"]),
  approverStaffId: z.string().nullable(),
  status: z.enum(APPROVAL_STATUSES),
  request: z.record(z.string(), z.unknown()),
  privilegedAccessApproved: z.boolean().nullable(),
  requestedAt: z.string(),
  dueAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedOnBehalfOf: z.string().nullable(),
  reason: z.string().nullable(),
  /** List responses only: the stage awaits a resubmission of this (rejected) round. */
  resubmittable: z.boolean().optional(),
});
export type ApprovalView = z.infer<typeof ApprovalViewSchema>;

export const BlockerViewSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  employeeName: z.string(),
  stageId: z.enum(STAGE_IDS),
  kind: z.enum(BLOCKER_KINDS),
  severity: z.enum(SEVERITIES),
  ownerDepartment: z.enum(DEPARTMENTS),
  subject: z.string(),
  status: z.enum(["open", "resolved"]),
  detail: z.record(z.string(), z.unknown()),
  detectedAt: z.string(),
  resolvedAt: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  resolution: z.string().nullable(),
  followUpTaskId: z.string().nullable(),
});
export type BlockerView = z.infer<typeof BlockerViewSchema>;

export const EmployeeProfileSchema = z.object({
  id: z.string(),
  email: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  jobTitle: z.string(),
  orgUnit: z.string(),
  employmentType: z.enum(EMPLOYMENT_TYPES),
  workMode: z.enum(WORK_MODES),
  site: z.string(),
  startDate: z.string(),
  managerId: z.string(),
  equipmentProfile: z.enum(EQUIPMENT_PROFILES),
  licenseBundle: z.enum(LICENSE_BUNDLES),
  needsPrivilegedAccess: z.boolean(),
  costCenter: z.string(),
  photoOnFile: z.boolean(),
});
export type EmployeeProfileDto = z.infer<typeof EmployeeProfileSchema>;

export const EmployeeSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  jobTitle: z.string(),
  orgUnit: z.string(),
  employmentType: z.enum(EMPLOYMENT_TYPES),
  workMode: z.enum(WORK_MODES),
  startDate: z.string(),
  managerId: z.string(),
  caseStatus: z.enum(CASE_STATUSES),
  currentStage: z.enum(STAGE_IDS).nullable(),
  openBlockers: z.number().int(),
});
export type EmployeeSummary = z.infer<typeof EmployeeSummarySchema>;

export const StageViewSchema = z.object({
  id: z.enum(STAGE_IDS),
  ordinal: z.number().int(),
  name: z.string(),
  owner: z.string(),
  status: z.enum(STAGE_STATUSES),
  round: z.number().int(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  blockedReason: z.record(z.string(), z.unknown()).nullable(),
});
export type StageView = z.infer<typeof StageViewSchema>;

export const ChecklistSchema = z.object({
  caseStatus: z.enum(CASE_STATUSES),
  stages: z.array(StageViewSchema).length(8),
  tasks: z.array(TaskViewSchema),
  blockers: z.array(BlockerViewSchema),
});
export type ChecklistDto = z.infer<typeof ChecklistSchema>;

export const ProvisioningViewSchema = z.object({
  system: z.enum(SYSTEM_IDS),
  resource: z.enum(RESOURCE_TYPES),
  externalId: z.string().nullable(),
  status: z.string(),
  polls: z.number().int(),
  updatedAt: z.string(),
});

const SystemSummary = z.object({ calls: z.number(), ok: z.number(), retried: z.number(), replayed: z.number(), fatal: z.number() });

export const CaseDetailSchema = z.object({
  employee: EmployeeProfileSchema.extend({ managerName: z.string() }),
  case: z.object({
    status: z.enum(CASE_STATUSES),
    failureReason: z.enum(FAILURE_REASONS).nullable(),
    currentStage: z.enum(STAGE_IDS).nullable(),
    runNo: z.number().int(),
    revision: z.number().int(),
    workflowInstanceId: z.string().nullable(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
  }),
  stages: z.array(StageViewSchema).length(8),
  tasks: z.array(TaskViewSchema),
  approvals: z.array(ApprovalViewSchema),
  blockers: z.array(BlockerViewSchema),
  provisioning: z.array(ProvisioningViewSchema),
  integrationSummary: z.object({ hr: SystemSummary, it: SystemSummary, facilities: SystemSummary }),
});
export type CaseDetail = z.infer<typeof CaseDetailSchema>;

export const AuditEventViewSchema = z.object({
  seq: z.number().int(),
  id: z.string(),
  occurredAt: z.string(),
  actorType: z.enum(["user", "agent", "workflow", "system"]),
  actorId: z.string(),
  actorRole: z.string().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  employeeId: z.string().nullable(),
  stageId: z.string().nullable(),
  runNo: z.number().int().nullable(),
  round: z.number().int().nullable(),
  requestId: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()),
});
export type AuditEventView = z.infer<typeof AuditEventViewSchema>;

export const IntegrationCallViewSchema = z.object({
  id: z.string(),
  runNo: z.number().int(),
  stepName: z.string(),
  system: z.enum(SYSTEM_IDS),
  operation: z.string(),
  method: z.string(),
  path: z.string(),
  idempotencyKey: z.string().nullable(),
  attempt: z.number().int(),
  httpStatus: z.number().int().nullable(),
  outcome: z.enum(INTEGRATION_OUTCOMES),
  retryAfterMs: z.number().int().nullable(),
  latencyMs: z.number().int(),
  error: z.string().nullable(),
  createdAt: z.string(),
});
export type IntegrationCallView = z.infer<typeof IntegrationCallViewSchema>;

export const IntegrationHealthSchema = z.object({
  calls: z.number().int(),
  ok: z.number().int(),
  retried: z.number().int(),
  replayed: z.number().int(),
  lastErrorAt: z.string().nullable(),
});
export const IntegrationsHealthSchema = z.object({ hr: IntegrationHealthSchema, it: IntegrationHealthSchema, facilities: IntegrationHealthSchema });

const count = z.number().int().min(0);
export const HubStateSchema = z.object({
  totals: z.object(Object.fromEntries(CASE_STATUSES.map((s) => [s, count])) as Record<(typeof CASE_STATUSES)[number], typeof count>),
  byStage: z
    .array(z.object({ stage: z.enum(STAGE_IDS), active: count, waiting: count, blocked: count, awaitingApproval: count, complete: count }))
    .length(8),
  blockersOpen: z.object({
    byKind: z.object(Object.fromEntries(BLOCKER_KINDS.map((k) => [k, count])) as Record<(typeof BLOCKER_KINDS)[number], typeof count>),
    byDepartment: z.object({ people_ops: count, it: count, facilities: count }),
  }),
  approvalsPending: z.object({ count, overdue: count }),
  integrationHealth: IntegrationsHealthSchema,
  systemIncidents: z.array(z.object({ system: z.enum(SYSTEM_IDS), openedAt: z.string(), casesAffected: count })),
  recentActivity: z.array(z.object({ seq: z.number().int(), occurredAt: z.string(), action: z.string(), employeeId: z.string().nullable(), actorId: z.string() })).max(50),
  asOfSeq: z.number().int(),
  reconciledAt: z.string(),
  version: z.number().int(),
});

export const StartResponse = z.object({ instanceId: z.string(), created: z.boolean() });
export const RoundResponse = z.object({ round: z.number().int() });
export const ScanResponse = z.object({ opened: count, autoResolved: count, nudged: count });
export const RestartResponse = z.object({ runNo: z.number().int(), instanceId: z.string() });
export const TerminateResponse = z.object({ status: z.literal("failed"), failureReason: z.literal("terminated") });

// ---------------------------------------------------------------------------
// Fault plans for the simulated systems (eval hooks and tests only)
// ---------------------------------------------------------------------------
export const FaultPlanInput = z.object({
  system: z.enum(SYSTEM_IDS),
  /** Simulator operation name without the system prefix, e.g. "order-device" or "get-device-order". */
  operation: z.string().min(1),
  /** null or omitted = any employee */
  employeeRef: z.string().nullable().optional(),
  fault: z.enum(["fail_503", "rate_limit_429", "timeout", "lost_response", "malformed", "stall", "conflict_409"]),
  /** null or omitted = until cleared (sustained outage) */
  remaining: z.number().int().min(1).nullable().optional(),
  params: z.object({ retryAfterMs: z.number().int().min(0).optional() }).optional(),
});
export type FaultPlanInput = z.infer<typeof FaultPlanInput>;
