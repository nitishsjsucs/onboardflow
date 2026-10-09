// Approval checkpoints (stages 3 and 8, SPEC 8.3):
//   request approval apr:<employee>:<checkpoint>:<round> -> decision gate
//   approved: continue
//   rejected: revision_requested (the scan opens an approval_rejected blocker
//   and a "Revise and resubmit" follow-up) -> resubmit gate -> next round.
// The third rejection ends the case with approval_rejected_final. Gates are
// keyed by approval id and round, so no other checkpoint or round can open them.
import { NonRetryableError } from "cloudflare:workflows";
import type { Checkpoint } from "../../shared/domain.ts";
import { approvalId as buildApprovalId } from "../../shared/ids.ts";
import type { StageId } from "../../shared/stages.ts";
import { auditInsertWhen, stamped } from "../db/audit.ts";
import { runGuarded } from "../db/guarded.ts";
import { getEmployee } from "../db/repo.ts";
import { awaitGate } from "./gates.ts";
import { CHECK_STEP } from "./retry-policy.ts";
import { failCase, type RunCtx, writer } from "./run-context.ts";

const HOUR_MS = 3_600_000;

async function requestApproval(ctx: RunCtx, stage: StageId, checkpoint: Checkpoint, round: number, stepName: string) {
  const w = await writer(ctx, stepName);
  const e = await getEmployee(w.db, ctx.employeeId);
  if (!e) throw new NonRetryableError(`fatal:approval http=404: employee ${ctx.employeeId} not found`);
  const id = buildApprovalId(ctx.employeeId, checkpoint, round);
  const dueAt = new Date(Date.parse(w.now) + ctx.cfg.approvalSlaHours * HOUR_MS).toISOString();
  const request =
    checkpoint === "manager_approval"
      ? {
          equipmentProfile: e.equipmentProfile,
          licenseBundle: e.licenseBundle,
          needsPrivilegedAccess: e.needsPrivilegedAccess,
          workMode: e.workMode,
          site: e.site,
          startDate: e.startDate,
        }
      : { summary: "All stages before sign-off are complete", startDate: e.startDate };
  const stageKey = [ctx.employeeId, stage];
  const pending = { sql: "EXISTS (SELECT 1 FROM approvals WHERE id = ? AND status = 'pending')", binds: [id] };
  await runGuarded({
    db: w.db,
    // INSERT OR IGNORE: on a restart the approval already exists (perhaps decided) and is honored, not re-requested.
    mutation: w.db
      .prepare(
        `INSERT OR IGNORE INTO approvals (id, employee_id, stage_id, checkpoint, round, approver_role, approver_staff_id, status, request_json, requested_at, due_at, last_mutation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .bind(
        id,
        ctx.employeeId,
        stage,
        checkpoint,
        round,
        checkpoint === "manager_approval" ? "manager" : "coordinator",
        checkpoint === "manager_approval" ? e.managerId : null,
        JSON.stringify(request),
        w.now,
        dueAt,
        w.stamp,
      ),
    applied: stamped("approvals", "id = ?", [id], w.stamp),
    onApplied: (when) => [auditInsertWhen(w.db, w.audit("approval.requested", "approval", id, { stageId: stage, round, detail: { checkpoint, dueAt } }), when)],
    extra: [
      w.db
        .prepare(
          `UPDATE case_stages SET status = 'awaiting_approval', updated_at = ?, last_mutation_id = ?
            WHERE employee_id = ? AND stage_id = ? AND status IN ('active','awaiting_approval') AND ${pending.sql}`,
        )
        .bind(w.now, `${w.stamp}:stage`, ...stageKey, ...pending.binds),
      auditInsertWhen(
        w.db,
        w.audit("stage.awaiting_approval", "stage", `${ctx.employeeId}:${stage}`, { stageId: stage, round, detail: { approvalId: id } }),
        stamped("case_stages", "employee_id = ? AND stage_id = ?", stageKey, `${w.stamp}:stage`),
      ),
      w.db
        .prepare(`UPDATE cases SET status = 'awaiting_approval', updated_at = ? WHERE employee_id = ? AND status IN ('in_progress','blocked') AND ${pending.sql}`)
        .bind(w.now, ctx.employeeId, ...pending.binds),
    ],
  });
  return { approvalId: id };
}

async function markRevisionRequested(ctx: RunCtx, stage: StageId, round: number, approvalId: string, stepName: string) {
  const w = await writer(ctx, stepName);
  const stageKey = [ctx.employeeId, stage];
  await runGuarded({
    db: w.db,
    mutation: w.db
      .prepare(
        `UPDATE case_stages SET status = 'revision_requested', updated_at = ?, last_mutation_id = ?
          WHERE employee_id = ? AND stage_id = ? AND round = ? AND status IN ('awaiting_approval','active')`,
      )
      .bind(w.now, w.stamp, ...stageKey, round),
    applied: stamped("case_stages", "employee_id = ? AND stage_id = ?", stageKey, w.stamp),
    onApplied: (when) => [
      w.db.prepare(`UPDATE cases SET status = 'blocked', updated_at = ? WHERE employee_id = ? AND status NOT IN ('complete','failed') AND ${when.sql}`).bind(w.now, ctx.employeeId, ...when.binds),
      auditInsertWhen(w.db, w.audit("stage.revision_requested", "stage", `${ctx.employeeId}:${stage}`, { stageId: stage, round, detail: { approvalId } }), when),
    ],
  });
}

/**
 * Runs the checkpoint until approved. Returns the approval id that was approved.
 *
 * It starts at the round an earlier run saw approved, if any, and otherwise at the stage's D1 round.
 * The approved round wins because closeout's stage round also counts the recovery rounds of
 * hr.activate-worker: after an activation retry the stage round is past the approval, and starting
 * there would request a second sign-off that nobody asked for. The approved approval already exists,
 * so the request step changes nothing and the decision gate passes on its first check.
 */
export async function approvalLoop(ctx: RunCtx, stage: StageId, checkpoint: Checkpoint): Promise<string> {
  let round = ctx.approvedRound[checkpoint] ?? ctx.stageRound[stage];
  for (;;) {
    const requestName = `${stage}.request-approval#r${round}`;
    const { approvalId } = await ctx.step.do(requestName, CHECK_STEP, () => requestApproval(ctx, stage, checkpoint, round, requestName));
    await ctx.step.sendEvent({ kind: "awaiting_approval", stage, round });
    const decision = await awaitGate(ctx, { stage, label: "decision", round, spec: { kind: "decision", approvalId } });
    if (decision.satisfied && decision.kind === "decision" && decision.status === "approved") {
      // Operations after the approval (closeout's activation) count their recovery rounds from here.
      ctx.roundBase[stage] = round;
      return approvalId;
    }

    const rejectedName = `${stage}.rejected#r${round}`;
    await ctx.step.do(rejectedName, CHECK_STEP, () => markRevisionRequested(ctx, stage, round, approvalId, rejectedName));
    await ctx.step.sendEvent({ kind: "revision_requested", stage, round });
    if (round >= ctx.limits.maxApprovalRounds) {
      const finalName = `${stage}.rejected-final#r${round}`;
      await ctx.step.do(finalName, CHECK_STEP, () => failCase(ctx, stage, "approval_rejected_final", finalName, { approvalId }));
      throw new NonRetryableError(`${checkpoint} rejected ${round} times`);
    }
    const resubmitted = await awaitGate(ctx, { stage, label: "resubmit", round, spec: { kind: "resubmit", stage, round } });
    round = resubmitted.satisfied && resubmitted.kind === "round" ? resubmitted.round : round + 1;
    ctx.stageRound[stage] = round;
  }
}
