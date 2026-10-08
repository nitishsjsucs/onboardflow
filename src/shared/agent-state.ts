// Agent state shapes, shared by the worker (Agents SDK classes) and the web app
// (useAgent<T>). Both are projections recomputed from D1 (ADR 0001) and carry
// asOfSeq, the max audit_events.seq read in the same D1 batch, so an older read
// never overwrites a newer one.
import type { BlockerKind, CaseStatus, FailureReason, ResourceType, StageStatus, SystemId } from "./domain.ts";
import type { Department } from "./roles.ts";
import type { StageId } from "./stages.ts";

export type CaseStageState = {
  id: StageId;
  ordinal: number;
  status: StageStatus;
  round: number;
  startedAt: string | null;
  completedAt: string | null;
};

export type CaseState = {
  employeeId: string;
  displayName: string;
  status: CaseStatus;
  failureReason: FailureReason | null;
  currentStage: StageId | null;
  /** always 8 entries, in ordinal order */
  stages: CaseStageState[];
  openTasks: { employee: number; departments: Record<Department, number> };
  pendingApproval: { id: string; checkpoint: "manager_approval" | "closeout"; round: number; dueAt: string } | null;
  provisioning: Array<{ system: SystemId; resource: ResourceType; status: string; externalId: string | null; polls: number }>;
  openBlockers: Array<{ id: string; kind: BlockerKind; stageId: StageId; ownerDepartment: Department; detectedAt: string }>;
  workflow: { instanceId: string | null; runNo: number; revision: number; status: string | null };
  asOfSeq: number;
  projectedAt: string;
};

export type StageRollup = {
  stage: StageId;
  active: number;
  waiting: number;
  blocked: number;
  awaitingApproval: number;
  complete: number;
};

export type IntegrationHealth = { calls: number; ok: number; retried: number; replayed: number; lastErrorAt: string | null };

export type HubState = {
  totals: Record<CaseStatus, number>;
  byStage: StageRollup[];
  blockersOpen: { byKind: Record<BlockerKind, number>; byDepartment: Record<Department, number> };
  approvalsPending: { count: number; overdue: number };
  integrationHealth: Record<SystemId, IntegrationHealth>;
  systemIncidents: Array<{ system: SystemId; openedAt: string; casesAffected: number }>;
  recentActivity: Array<{ seq: number; occurredAt: string; action: string; employeeId: string | null; actorId: string }>;
  asOfSeq: number;
  reconciledAt: string;
  version: number;
};

export function emptyCaseState(employeeId: string): CaseState {
  return {
    employeeId,
    displayName: "",
    status: "not_started",
    failureReason: null,
    currentStage: null,
    stages: [],
    openTasks: { employee: 0, departments: { people_ops: 0, it: 0, facilities: 0 } },
    pendingApproval: null,
    provisioning: [],
    openBlockers: [],
    workflow: { instanceId: null, runNo: 1, revision: 1, status: null },
    asOfSeq: -1,
    projectedAt: "",
  };
}
