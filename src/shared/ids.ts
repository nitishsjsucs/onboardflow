// Deterministic id builders. Workflow steps, agents and simulators may run a
// write more than once (retries, restarts, replays); deterministic ids plus
// INSERT OR IGNORE make those repeats harmless (ADR 0001).
import type { BlockerKind, Checkpoint } from "./domain.ts";
import type { OperationId, StageId } from "./stages.ts";

export const EMPLOYEE_ID_PATTERN = /^E\d{3}$/;
export const INSTANCE_ID_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/;

export function employeeId(n: number): string {
  return `E${String(n).padStart(3, "0")}`;
}

export function instanceId(employee: string, revision: number): string {
  return `onb-${employee}-${revision}`;
}

export function approvalId(employee: string, checkpoint: Checkpoint, round: number): string {
  return `apr:${employee}:${checkpoint}:${round}`;
}

export function checklistTaskId(employee: string, templateKey: string): string {
  return `chk:${employee}:${templateKey}`;
}

export function blockerDedupeKey(employee: string, kind: BlockerKind, stage: StageId, subject: string): string {
  return `${employee}:${kind}:${stage}:${subject}`;
}

export function blockerId(dedupeKey: string, openedAtMs: number): string {
  return `blk:${dedupeKey}:${openedAtMs}`;
}

export function followUpTaskId(blocker: string): string {
  return `fu:${blocker}`;
}

/** Idempotency key sent to the simulated systems. Excludes run and revision on purpose, so restarts replay. */
export function simIdempotencyKey(employee: string, op: OperationId): string {
  return `${employee}:${op}`;
}

export function integrationCallId(instance: string, runNo: number, stepName: string, attempt: number): string {
  return `${instance}:${runNo}:${stepName}:${attempt}`;
}

/** Mutation stamp for a user request (guarded mutations, ADR 0008). */
export function userStamp(requestId: string): string {
  return `usr:${requestId}`;
}

/** Mutation stamp for a workflow step. */
export function workflowStamp(instance: string, runNo: number, stepName: string): string {
  return `wf:${instance}:${runNo}:${stepName}`;
}

export const auditIds = {
  user: (requestId: string, action: string) => `usr:${requestId}:${action}`,
  workflow: (instance: string, runNo: number, stepName: string, action: string) =>
    `wf:${instance}:${runNo}:${stepName}:${action}`,
  agent: (employee: string, action: string, entityId: string) => `ag:${employee}:${action}:${entityId}`,
  integration: (callId: string) => `ic:${callId}`,
};
