// Shared state of one workflow run and the D1 step bodies the stages use.
// Every write is a guarded batch stamped with the step's mutation id
// (wf:<instance>:<run_no>:<step>), and every audit row is gated on that stamp,
// so a step re-executed after a retry or restart never claims an effect it did
// not have (ADR 0008). Ids are deterministic and inserts use OR IGNORE.
import type { AgentWorkflowStep } from "agents/workflows";
import type { AuditAction, FailureReason, ResourceType, SystemId } from "../../shared/domain.ts";
import { auditIds, workflowStamp } from "../../shared/ids.ts";
import type { StageId } from "../../shared/stages.ts";
import type { AppConfig } from "../config.ts";
import { auditInsertWhen, type AuditInput, stamped } from "../db/audit.ts";
import { loadClock } from "../db/clock.ts";
import { runGuarded } from "../db/guarded.ts";
import type { BlockedReason } from "../integrations/errors.ts";

export type StageProgress =
  | { stage: StageId; kind: "poll"; resource: ResourceType; status: string; poll: number }
  | { stage: StageId; kind: "gate_waiting"; gate: string; round: number };

export type RunLimits = {
  waitBudget: number;
  maxStageRounds: number;
  maxRecoveryRounds: number;
  maxApprovalRounds: number;
  pollMax: number;
};

export type RunCtx = {
  step: AgentWorkflowStep;
  env: Env;
  cfg: AppConfig;
  employeeId: string;
  instanceId: string;
  runNo: number;
  stageRound: Record<StageId, number>;
  limits: RunLimits;
  /** Waits left before the case fails with wait_budget_exhausted (deterministic: derived from step results). */
  waitsLeft: number;
  /** Recovery rounds left across all stages. */
  recoveriesLeft: number;
  /** Non-durable progress to the CaseAgent (refreshes live state). Never throws. */
  report(p: StageProgress): Promise<void>;
};

export type StepWriter = {
  db: D1Database;
  now: string;
  stamp: string;
  audit(action: AuditAction, entityType: string, entityId: string, extra?: Partial<AuditInput>): AuditInput;
};

export async function writer(ctx: RunCtx, stepName: string): Promise<StepWriter> {
  const db = ctx.env.DB;
  const now = (await loadClock(ctx.cfg, db)).nowIso();
  return {
    db,
    now,
    stamp: workflowStamp(ctx.instanceId, ctx.runNo, stepName),
    audit: (action, entityType, entityId, extra = {}) => ({
      id: auditIds.workflow(ctx.instanceId, ctx.runNo, stepName, action) + (extra.id ? `:${extra.id}` : ""),
      occurredAt: now,
      actorType: "workflow",
      actorId: ctx.instanceId,
      action,
      entityType,
      entityId,
      employeeId: ctx.employeeId,
      runNo: ctx.runNo,
      ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "id")),
    }),
  };
}

const stageWhere = "employee_id = ? AND stage_id = ?";

/** pending -> active, audited only when this step made the change. */
export async function startStage(ctx: RunCtx, stage: StageId, stepName: string): Promise<{ started: boolean }> {
  const w = await writer(ctx, stepName);
  const { applied } = await runGuarded({
    db: w.db,
    mutation: w.db
      .prepare(`UPDATE case_stages SET status = 'active', started_at = COALESCE(started_at, ?), updated_at = ?, last_mutation_id = ? WHERE ${stageWhere} AND status = 'pending'`)
      .bind(w.now, w.now, w.stamp, ctx.employeeId, stage),
    applied: stamped("case_stages", stageWhere, [ctx.employeeId, stage], w.stamp),
    onApplied: (when) => [auditInsertWhen(w.db, w.audit("stage.started", "stage", `${ctx.employeeId}:${stage}`, { stageId: stage, round: ctx.stageRound[stage] }), when)],
    extra: [
      w.db
        .prepare("UPDATE cases SET current_stage = ?, updated_at = ? WHERE employee_id = ? AND status NOT IN ('complete','failed')")
        .bind(stage, w.now, ctx.employeeId),
    ],
  });
  return { started: applied };
}

/** -> complete, audited only when this step made the change; clears a blocked case status. */
export async function completeStage(ctx: RunCtx, stage: StageId, stepName: string): Promise<{ completed: boolean }> {
  const w = await writer(ctx, stepName);
  const { applied } = await runGuarded({
    db: w.db,
    mutation: w.db
      .prepare(
        `UPDATE case_stages SET status = 'complete', completed_at = ?, blocked_reason_json = NULL, updated_at = ?, last_mutation_id = ?
          WHERE ${stageWhere} AND status <> 'complete'`,
      )
      .bind(w.now, w.now, w.stamp, ctx.employeeId, stage),
    applied: stamped("case_stages", stageWhere, [ctx.employeeId, stage], w.stamp),
    onApplied: (when) => [auditInsertWhen(w.db, w.audit("stage.completed", "stage", `${ctx.employeeId}:${stage}`, { stageId: stage, round: ctx.stageRound[stage] }), when)],
    extra: [
      w.db
        .prepare("UPDATE cases SET status = 'in_progress', updated_at = ? WHERE employee_id = ? AND status IN ('blocked','awaiting_approval')")
        .bind(w.now, ctx.employeeId),
    ],
  });
  return { completed: applied };
}

/**
 * Marks the stage blocked for this round (guarded on the round), with the classified reason.
 * A `complete` stage can be blocked again: after a restart the run replays every completed
 * operation, and if a replay fails (for example during an outage) the stage must become
 * retryable, or no coordinator could open its retry gate. completeStage completes it again.
 */
export async function markBlocked(ctx: RunCtx, stage: StageId, round: number, reason: BlockedReason & { operation?: string; system?: SystemId }, stepName: string) {
  const w = await writer(ctx, stepName);
  const detail = { ...reason, round };
  const { applied } = await runGuarded({
    db: w.db,
    mutation: w.db
      .prepare(
        `UPDATE case_stages SET status = 'blocked', blocked_reason_json = ?, updated_at = ?, last_mutation_id = ?
          WHERE ${stageWhere} AND round = ? AND status IN ('active','blocked','waiting_on_employee','awaiting_approval','complete')`,
      )
      .bind(JSON.stringify(detail), w.now, w.stamp, ctx.employeeId, stage, round),
    applied: stamped("case_stages", stageWhere, [ctx.employeeId, stage], w.stamp),
    onApplied: (when) => [
      w.db.prepare(`UPDATE cases SET status = 'blocked', updated_at = ? WHERE employee_id = ? AND status NOT IN ('complete','failed') AND ${when.sql}`).bind(w.now, ctx.employeeId, ...when.binds),
      auditInsertWhen(w.db, w.audit("stage.blocked", "stage", `${ctx.employeeId}:${stage}`, { stageId: stage, round, detail }), when),
    ],
  });
  return { blocked: applied };
}

/** Fails the case (guarded: never overwrites complete or failed) and the current stage. */
export async function failCase(ctx: RunCtx, stage: StageId | null, reason: FailureReason, stepName: string, detail: Record<string, unknown> = {}) {
  const w = await writer(ctx, stepName);
  const { applied } = await runGuarded({
    db: w.db,
    mutation: w.db
      .prepare("UPDATE cases SET status = 'failed', failure_reason = ?, updated_at = ?, last_mutation_id = ? WHERE employee_id = ? AND status NOT IN ('complete','failed')")
      .bind(reason, w.now, w.stamp, ctx.employeeId),
    applied: stamped("cases", "employee_id = ?", [ctx.employeeId], w.stamp),
    onApplied: (when) => [
      ...(stage
        ? [w.db.prepare(`UPDATE case_stages SET status = 'failed', updated_at = ? WHERE ${stageWhere} AND status <> 'complete' AND ${when.sql}`).bind(w.now, ctx.employeeId, stage, ...when.binds)]
        : []),
      auditInsertWhen(w.db, w.audit("case.failed", "case", ctx.employeeId, { stageId: stage, detail: { failureReason: reason, ...detail } }), when),
    ],
  });
  return { failed: applied, reason };
}

export async function completeCase(ctx: RunCtx, stepName: string) {
  const w = await writer(ctx, stepName);
  const { applied } = await runGuarded({
    db: w.db,
    mutation: w.db
      .prepare(
        `UPDATE cases SET status = 'complete', completed_at = ?, current_stage = 'closeout', updated_at = ?, last_mutation_id = ?
          WHERE employee_id = ? AND status NOT IN ('complete','failed')`,
      )
      .bind(w.now, w.now, w.stamp, ctx.employeeId),
    applied: stamped("cases", "employee_id = ?", [ctx.employeeId], w.stamp),
    onApplied: (when) => [auditInsertWhen(w.db, w.audit("case.completed", "case", ctx.employeeId, { detail: { runNo: ctx.runNo } }), when)],
  });
  return { completed: applied };
}

/** Upserts a provisioning item and audits the update in the same batch. */
export async function recordProvisioning(
  ctx: RunCtx,
  stepName: string,
  item: { system: SystemId; resource: ResourceType; externalId: string; status: string; polls?: number; detail?: Record<string, unknown> },
) {
  const w = await writer(ctx, stepName);
  await w.db.batch([
    w.db
      .prepare(
        `INSERT INTO provisioning_items (employee_id, system, resource, external_id, status, polls, detail_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (employee_id, resource) DO UPDATE SET external_id = excluded.external_id, status = excluded.status,
           polls = MAX(provisioning_items.polls, excluded.polls), detail_json = excluded.detail_json, updated_at = excluded.updated_at`,
      )
      .bind(ctx.employeeId, item.system, item.resource, item.externalId, item.status, item.polls ?? 0, JSON.stringify(item.detail ?? {}), w.now),
    auditInsertWhen(
      w.db,
      w.audit("provisioning.updated", "provisioning_item", `${ctx.employeeId}:${item.resource}`, { detail: { status: item.status, externalId: item.externalId, polls: item.polls ?? 0 } }),
      { sql: "1 = 1", binds: [] },
    ),
  ]);
}

export async function provisioningItem(db: D1Database, employeeId: string, resource: ResourceType) {
  return db
    .prepare("SELECT external_id, status, polls FROM provisioning_items WHERE employee_id = ? AND resource = ?")
    .bind(employeeId, resource)
    .first<{ external_id: string | null; status: string; polls: number }>();
}
