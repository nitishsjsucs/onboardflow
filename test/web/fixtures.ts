import type { ApprovalView, AuditEventView, BlockerView, CaseDetail, EmployeeProfileDto, EmployeeSummary, StartReadinessDto } from "../../src/shared/api.ts";
import { STAGES } from "../../src/shared/stages.ts";

export function approval(over: Partial<ApprovalView> = {}): ApprovalView {
  return {
    id: "apr:E001:manager_approval:1",
    employeeId: "E001",
    employeeName: "Avery Abara",
    stageId: "manager_approval",
    checkpoint: "manager_approval",
    round: 1,
    approverRole: "manager",
    approverStaffId: "M01",
    status: "pending",
    request: { equipmentProfile: "engineering", licenseBundle: "ft-engineering", needsPrivilegedAccess: true },
    privilegedAccessApproved: null,
    requestedAt: "2026-10-01T00:00:00.000Z",
    dueAt: new Date(Date.now() + 10 * 3600_000).toISOString(),
    decidedAt: null,
    decidedBy: null,
    decidedOnBehalfOf: null,
    reason: null,
    ...over,
  };
}

export function auditEvent(seq: number, over: Partial<AuditEventView> = {}): AuditEventView {
  return {
    seq,
    id: `usr:req-${seq}:task.completed`,
    occurredAt: new Date(Date.UTC(2026, 9, 1, 12, seq)).toISOString(),
    actorType: "user",
    actorId: "avery.abara.e001@onboardflow.test",
    actorRole: "employee",
    action: "task.completed",
    entityType: "task",
    entityId: `chk:E001:t${seq}`,
    employeeId: "E001",
    stageId: "paperwork",
    runNo: null,
    round: null,
    requestId: `req-${seq}`,
    detail: {},
    ...over,
  };
}

export function caseDetail(blockedStage: string | null = "it_provisioning"): CaseDetail {
  return {
    employee: {
      id: "E001",
      email: "avery.abara.e001@onboardflow.test",
      firstName: "Avery",
      lastName: "Abara",
      jobTitle: "Software Engineer",
      orgUnit: "Engineering",
      employmentType: "full_time",
      workMode: "onsite",
      site: "Austin",
      startDate: "2026-11-02",
      managerId: "M01",
      equipmentProfile: "engineering",
      licenseBundle: "ft-engineering",
      needsPrivilegedAccess: false,
      costCenter: "CC-1100",
      photoOnFile: true,
      managerName: "Gray Marlow",
    },
    case: { status: blockedStage ? "blocked" : "in_progress", failureReason: null, currentStage: "it_provisioning", runNo: 1, revision: 1, workflowInstanceId: "onb-E001-1", startedAt: "2026-10-01T00:00:00.000Z", completedAt: null },
    stages: STAGES.map((s) => ({
      id: s.id,
      ordinal: s.ordinal,
      name: s.name,
      owner: s.owner,
      status: s.ordinal < 4 ? "complete" : s.id === blockedStage ? "blocked" : s.ordinal === 4 ? "active" : "pending",
      round: 1,
      startedAt: null,
      completedAt: null,
      blockedReason: s.id === blockedStage ? { class: "retryable", operation: "it.order-device", message: "service_unavailable", round: 1 } : null,
    })),
    tasks: [],
    approvals: [approval({ status: "approved" })],
    blockers: blockedStage
      ? [
          {
            id: "blk:E001:integration_outage:it_provisioning:it.order-device:1",
            employeeId: "E001",
            employeeName: "Avery Abara",
            stageId: "it_provisioning",
            kind: "integration_outage",
            severity: "high",
            ownerDepartment: "it",
            subject: "it.order-device",
            status: "open",
            detail: {},
            detectedAt: "2026-10-01T01:00:00.000Z",
            resolvedAt: null,
            resolvedBy: null,
            resolution: null,
            followUpTaskId: "fu:x",
            stageStatus: "blocked",
            stageRound: 1,
          },
        ]
      : [],
    provisioning: [
      { system: "hr", resource: "hr_worker", externalId: "wkr_1", status: "preboarding", polls: 0, updatedAt: "2026-10-01T00:00:00.000Z" },
      { system: "it", resource: "it_account", externalId: "acct_1", status: "active", polls: 0, updatedAt: "2026-10-01T00:00:00.000Z" },
    ],
    integrationSummary: { hr: { calls: 3, ok: 3, retried: 0, replayed: 0, fatal: 0 }, it: { calls: 7, ok: 2, retried: 5, replayed: 0, fatal: 0 }, facilities: { calls: 0, ok: 0, retried: 0, replayed: 0, fatal: 0 } },
  };
}

export function blocker(over: Partial<BlockerView> = {}): BlockerView {
  return {
    id: "blk:E001:it",
    employeeId: "E001",
    employeeName: "Avery Abara",
    stageId: "it_provisioning",
    kind: "integration_outage",
    severity: "high",
    ownerDepartment: "it",
    subject: "it.order-device",
    status: "open",
    detail: { system: "it", operation: "it.order-device", message: "service unavailable" },
    detectedAt: "2026-10-08T10:00:00.000Z",
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
    followUpTaskId: null,
    stageStatus: "blocked",
    stageRound: 1,
    ...over,
  };
}

export function employee(id: string, name: string, over: Partial<EmployeeSummary> = {}): EmployeeSummary {
  return {
    id,
    name,
    email: `${name.toLowerCase().replace(/ /g, ".")}.${id.toLowerCase()}@onboardflow.test`,
    jobTitle: "Analyst",
    orgUnit: "Finance",
    employmentType: "full_time",
    workMode: "hybrid",
    startDate: "2026-11-02",
    managerId: "M01",
    caseStatus: "not_started",
    currentStage: null,
    openBlockers: 0,
    blockerOwner: null,
    ...over,
  };
}

export function profile(over: Partial<EmployeeProfileDto> = {}): EmployeeProfileDto {
  return {
    id: "E042",
    email: "logan.northcott.e042@onboardflow.test",
    firstName: "Logan",
    lastName: "Northcott",
    jobTitle: "Software Engineer",
    orgUnit: "Engineering",
    employmentType: "full_time",
    workMode: "onsite",
    site: "Austin",
    startDate: "2026-11-02",
    managerId: "M01",
    equipmentProfile: "engineering",
    licenseBundle: "ft-engineering",
    needsPrivilegedAccess: false,
    costCenter: "CC 1100",
    photoOnFile: true,
    ...over,
  };
}

/** A readiness response: asOf 2026-10-16 (a Friday), the week of Oct 12 (this week) and of Oct 19 empty, then two cohorts. */
export function readiness(over: Partial<StartReadinessDto> = {}): StartReadinessDto {
  const zero = { total: 0, ready: 0, blocked: 0, waiting: 0, inSetup: 0, notStarted: 0, failed: 0 };
  return {
    asOf: "2026-10-16",
    weeks: [
      { weekStart: "2026-10-12", ...zero },
      { weekStart: "2026-10-19", ...zero },
      { weekStart: "2026-11-02", total: 15, ready: 6, blocked: 1, waiting: 3, inSetup: 5, notStarted: 0, failed: 0 },
      { weekStart: "2026-11-09", total: 10, ready: 2, blocked: 0, waiting: 0, inSetup: 0, notStarted: 7, failed: 1 },
    ],
    alreadyStarted: null,
    ...over,
  };
}
