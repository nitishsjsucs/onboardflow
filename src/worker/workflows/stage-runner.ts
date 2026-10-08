// runOp: every integration call of the workflow goes through here (SPEC 8.3).
//   step.do with retries -> success, or after the retry budget:
//   mark blocked (guarded on the round) -> stage_blocked event (the CaseAgent's
//   scan opens a blocker and a follow-up) -> retry gate (a coordinator retries)
//   -> next round with the same Idempotency-Key.
// Input is rebuilt from D1 inside each step, so a field fix applies to the
// next attempt. Polled resources (documents, device order, badge) are polled
// until terminal or POLL_MAX; not reaching it raises a stalled error into the
// same recovery path, and the next round replays the order by its key.
import { NonRetryableError } from "cloudflare:workflows";
import { OPERATIONS, type OperationId, POLL_TERMINAL, type StageId } from "../../shared/stages.ts";
import { loadClock } from "../db/clock.ts";
import { getEmployee } from "../db/repo.ts";
import { IntegrationClient } from "../integrations/client.ts";
import { classifyFailure, isEngineAbort, RetryableIntegrationError, StalledError } from "../integrations/errors.ts";
import * as fac from "../integrations/facilities.ts";
import * as hr from "../integrations/hr.ts";
import * as it from "../integrations/it.ts";
import { awaitGate } from "./gates.ts";
import { CHECK_STEP, retryPolicy } from "./retry-policy.ts";
import { failCase, markBlocked, provisioningItem, recordProvisioning, type RunCtx } from "./run-context.ts";

export type OpResult = { externalId: string | null; status: string };

async function requireExternal(ctx: RunCtx, resource: Parameters<typeof provisioningItem>[2]): Promise<string> {
  const item = await provisioningItem(ctx.env.DB, ctx.employeeId, resource);
  if (!item?.external_id) throw new RetryableIntegrationError("retryable_error", `prerequisite.${resource}`, null, `no ${resource} provisioned yet`);
  return item.external_id;
}

/** One attempt of one operation (runs inside a step). */
export async function callOperation(ctx: RunCtx, stage: StageId, op: OperationId, stepName: string, attempt: number): Promise<OpResult> {
  const db = ctx.env.DB;
  const clock = await loadClock(ctx.cfg, db);
  const e = await getEmployee(db, ctx.employeeId);
  if (!e) throw new NonRetryableError(`fatal:${op} http=404: employee ${ctx.employeeId} not found`);
  const client = new IntegrationClient(db, ctx.cfg, clock, { employeeId: ctx.employeeId, instanceId: ctx.instanceId, runNo: ctx.runNo, stepName, attempt });
  const def = OPERATIONS[op];
  const record = async (externalId: string, status: string, detail: Record<string, unknown> = {}) => {
    // A replayed POST must not move a polled resource back from a later status.
    const existing = await provisioningItem(db, ctx.employeeId, def.resource);
    const keep = existing?.external_id === externalId && POLL_TERMINAL[def.resource] !== undefined && existing.status !== status && def.method === "POST";
    const finalStatus = keep ? existing.status : status;
    await recordProvisioning(ctx, stepName, { system: def.system, resource: def.resource, externalId, status: finalStatus, polls: existing?.polls ?? 0, detail });
    return { externalId, status: finalStatus };
  };

  switch (op) {
    case "hr.create-worker": {
      const r = await hr.createWorker(client, e);
      return record(r.data.id, r.data.status);
    }
    case "hr.start-document-verification": {
      const r = await hr.startDocumentVerification(client, e.id, await requireExternal(ctx, "hr_worker"));
      return record(r.data.id, r.data.status);
    }
    case "hr.enroll-orientation": {
      // Orientation sessions run on start dates (Mondays), so the session is the start date.
      const r = await hr.enrollOrientation(client, e.id, await requireExternal(ctx, "hr_worker"), e.startDate);
      return record(r.data.id, "enrolled", { sessionDate: r.data.sessionDate });
    }
    case "hr.activate-worker": {
      const workerId = await requireExternal(ctx, "hr_worker");
      const r = await hr.activateWorker(client, e.id, workerId);
      return record(workerId, r.data.status);
    }
    case "hr.get-worker": {
      const r = await hr.getWorker(client, await requireExternal(ctx, "hr_worker"));
      if (r.data.employeeRef !== e.id) throw new RetryableIntegrationError("retryable_error", op, r.status, "verification mismatch: worker belongs to another employee");
      return { externalId: r.data.id, status: r.data.status };
    }
    case "it.create-account": {
      const r = await it.createAccount(client, e);
      return record(r.data.id, r.data.status);
    }
    case "it.assign-licenses": {
      // Privileged access comes from the manager's decision in D1, not from workflow memory.
      const approval = await db
        .prepare("SELECT id, privileged_access_approved FROM approvals WHERE employee_id = ? AND checkpoint = 'manager_approval' AND status = 'approved' ORDER BY round DESC LIMIT 1")
        .bind(e.id)
        .first<{ id: string; privileged_access_approved: number | null }>();
      const r = await it.assignLicenses(client, e, await requireExternal(ctx, "it_account"), {
        approved: approval?.privileged_access_approved === 1,
        approvalRef: approval?.id ?? null,
      });
      return record(`${await requireExternal(ctx, "it_account")}:licenses`, "assigned", { assigned: r.data.assigned });
    }
    case "it.order-device": {
      const r = await it.orderDevice(client, e, await requireExternal(ctx, "it_account"));
      return record(r.data.id, r.data.status);
    }
    case "it.get-account": {
      const r = await it.getAccount(client, await requireExternal(ctx, "it_account"));
      if (r.data.status !== "active" || r.data.licenses.length === 0) {
        throw new RetryableIntegrationError("retryable_error", op, r.status, "verification mismatch: account inactive or unlicensed");
      }
      return { externalId: r.data.id, status: r.data.status };
    }
    case "facilities.assign-workspace": {
      const r = await fac.assignWorkspace(client, e);
      return record(r.data.id, r.data.kind === "desk" ? "desk_assigned" : "remote_kit_assigned", { kind: r.data.kind, deskId: r.data.deskId ?? null, preference: r.preference });
    }
    case "facilities.issue-badge": {
      const r = await fac.issueBadge(client, e);
      return record(r.data.id, r.data.status);
    }
    case "facilities.get-badge": {
      const r = await fac.getBadge(client, await requireExternal(ctx, "fac_badge"));
      if (r.data.status !== "active") throw new RetryableIntegrationError("retryable_error", op, r.status, `verification mismatch: badge is ${r.data.status}`);
      return { externalId: r.data.id, status: r.data.status };
    }
    case "hr.get-document-verification":
    case "it.get-device-order":
      throw new NonRetryableError(`fatal:${op} http=0: polling operations run through pollOnce`);
  }
}

/** One poll of an async resource (runs inside a step). */
async function pollOnce(ctx: RunCtx, op: OperationId, externalId: string, stepName: string, attempt: number): Promise<{ status: string; polls: number }> {
  const db = ctx.env.DB;
  const clock = await loadClock(ctx.cfg, db);
  const client = new IntegrationClient(db, ctx.cfg, clock, { employeeId: ctx.employeeId, instanceId: ctx.instanceId, runNo: ctx.runNo, stepName, attempt });
  const def = OPERATIONS[op];
  const r =
    op === "hr.get-document-verification"
      ? await hr.getDocumentVerification(client, externalId)
      : op === "it.get-device-order"
        ? await it.getDeviceOrder(client, externalId)
        : await fac.getBadge(client, externalId);
  const existing = await provisioningItem(db, ctx.employeeId, def.resource);
  const polls = (existing?.polls ?? 0) + 1;
  await recordProvisioning(ctx, stepName, { system: def.system, resource: def.resource, externalId, status: r.data.status, polls });
  return { status: r.data.status, polls };
}

async function pollUntilTerminal(ctx: RunCtx, stage: StageId, postOp: OperationId, round: number, first: OpResult): Promise<void> {
  const def = OPERATIONS[postOp];
  const getOp = def.polledBy;
  const terminal = POLL_TERMINAL[def.resource];
  if (!getOp || !terminal || !first.externalId) return;
  if (first.status === terminal) return; // already terminal (for example after a restart): skip polling
  for (let n = 1; n <= ctx.limits.pollMax; n++) {
    const name = `${stage}.poll-${def.resource}#r${round}.${n}`;
    const r = await ctx.step.do(name, retryPolicy(ctx.cfg), (s) => pollOnce(ctx, getOp, first.externalId as string, name, s.attempt));
    await ctx.report({ stage, kind: "poll", resource: def.resource, status: r.status, poll: n });
    if (r.status === terminal) return;
    await ctx.step.sleep(`${stage}.poll-wait#r${round}.${n}`, ctx.cfg.poll.intervalMs);
  }
  throw new StalledError(postOp, def.resource, ctx.limits.pollMax);
}

export async function runOp(ctx: RunCtx, stage: StageId, op: OperationId): Promise<OpResult> {
  let round = ctx.stageRound[stage];
  for (;;) {
    try {
      const name = `${stage}.${op}#r${round}`;
      const result = await ctx.step.do(name, retryPolicy(ctx.cfg), (s) => callOperation(ctx, stage, op, name, s.attempt));
      await pollUntilTerminal(ctx, stage, op, round, result);
      return result;
    } catch (err) {
      if (isEngineAbort(err)) throw err;
      const reason = classifyFailure(err);
      if (round >= ctx.limits.maxStageRounds || ctx.recoveriesLeft-- <= 0) {
        const name = `${stage}.${op}.exhausted#r${round}`;
        await ctx.step.do(name, CHECK_STEP, () => failCase(ctx, stage, "recovery_rounds_exhausted", name, { operation: op, reason: reason.message }));
        throw new NonRetryableError(`stage ${stage} exhausted recovery rounds at ${op}`);
      }
      const blockedName = `${stage}.${op}.mark-blocked#r${round}`;
      await ctx.step.do(blockedName, CHECK_STEP, () => markBlocked(ctx, stage, round, { ...reason, operation: op, system: OPERATIONS[op].system }, blockedName));
      await ctx.step.sendEvent({ kind: "stage_blocked", stage, round });
      const opened = await awaitGate(ctx, { stage, label: `${op}.retry`, round, spec: { kind: "retry", stage, round } });
      round = opened.satisfied && opened.kind === "round" ? opened.round : round + 1;
      ctx.stageRound[stage] = round;
    }
  }
}

