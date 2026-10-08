// awaitGate: the only way the workflow waits (ADR 0002, SPEC 8.3).
//   check (D1, in a step) -> if open, done -> else bounded waitForEvent -> re-check
// A gate already open in D1 passes on its first check with no wait, which is
// what makes restart safe: the engine wipes delivered events on restart, but
// D1 still says the tasks are done or the approval is decided. A lost wake-up
// costs one bounded wait; a stale one costs one extra check. Only an exhausted
// wait budget ends a case, as failed with wait_budget_exhausted.
import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import { WAKE_REASONS } from "../../shared/domain.ts";
import type { StageId } from "../../shared/stages.ts";
import { evaluateGate, type GateResult, type GateSpec } from "../agents/gate-predicates.ts";
import { auditInsertWhen, stamped } from "../db/audit.ts";
import { runGuarded } from "../db/guarded.ts";
import { errorMessage, isEngineAbort } from "../integrations/errors.ts";
import { CHECK_STEP } from "./retry-policy.ts";
import { failCase, type RunCtx, writer } from "./run-context.ts";

export const WakePayload = z.object({
  round: z.number().int().min(1),
  reason: z.enum(WAKE_REASONS),
  ref: z.string().optional(),
});

export type Gate = { stage: StageId; label: string; round: number; spec: GateSpec };

type Checked = { satisfied: boolean; result: GateResult; checks: number };

/** One gate check in a step: read D1; when open, record stage.gate_passed { checks: k } in the same step. */
async function checkAndRecord(ctx: RunCtx, g: Gate, k: number, stepName: string): Promise<Checked> {
  const result = await evaluateGate(ctx.env.DB, ctx.employeeId, g.spec);
  const w = await writer(ctx, stepName);
  const stageKey = [ctx.employeeId, g.stage];
  if (result.satisfied) {
    const statements = [
      auditInsertWhen(
        w.db,
        w.audit("stage.gate_passed", "stage", `${ctx.employeeId}:${g.stage}`, { stageId: g.stage, round: g.round, detail: { gate: g.label, kind: g.spec.kind, checks: k } }),
        { sql: "1 = 1", binds: [] },
      ),
    ];
    if (g.spec.kind === "tasks") {
      statements.push(
        w.db
          .prepare("UPDATE case_stages SET status = 'active', updated_at = ? WHERE employee_id = ? AND stage_id = ? AND status = 'waiting_on_employee'")
          .bind(w.now, ...stageKey),
      );
    }
    await w.db.batch(statements);
  } else if (k === 1 && g.spec.kind === "tasks") {
    // First failed check of a task gate: the stage now waits on the employee.
    await runGuarded({
      db: w.db,
      mutation: w.db
        .prepare("UPDATE case_stages SET status = 'waiting_on_employee', updated_at = ?, last_mutation_id = ? WHERE employee_id = ? AND stage_id = ? AND status = 'active'")
        .bind(w.now, w.stamp, ...stageKey),
      applied: stamped("case_stages", "employee_id = ? AND stage_id = ?", stageKey, w.stamp),
      onApplied: (when) => [auditInsertWhen(w.db, w.audit("stage.waiting_on_employee", "stage", `${ctx.employeeId}:${g.stage}`, { stageId: g.stage, round: g.round }), when)],
    });
  }
  return { satisfied: result.satisfied, result, checks: k };
}

export async function awaitGate(ctx: RunCtx, g: Gate): Promise<GateResult> {
  const base = `${g.stage}.${g.label}`;
  for (let k = 1; ; k++) {
    const name = `${base}.check#r${g.round}.${k}`;
    const r = await ctx.step.do(name, CHECK_STEP, () => checkAndRecord(ctx, g, k, name));
    if (r.satisfied) return r.result;
    if (k === 1) await ctx.report({ stage: g.stage, kind: "gate_waiting", gate: g.label, round: g.round });

    if (ctx.waitsLeft-- <= 0) {
      const stepName = `${base}.budget-exhausted#r${g.round}`;
      await ctx.step.do(stepName, CHECK_STEP, () => failCase(ctx, g.stage, "wait_budget_exhausted", stepName, { gate: g.label }));
      throw new NonRetryableError(`wait budget exhausted at ${base}`);
    }
    try {
      const ev = await ctx.step.waitForEvent<{ round?: number; reason?: string; ref?: string }>(`${base}.wait#r${g.round}.${k}`, {
        type: `wake_${g.stage}`,
        timeout: ctx.cfg.gates.waitTimeoutMs,
      });
      // Wake-ups are validated and logged, never trusted: only the D1 re-check decides.
      const parsed = WakePayload.safeParse(ev.payload);
      if (!parsed.success) console.warn(`${ctx.instanceId} ${base}: ignoring invalid wake payload`);
    } catch (err) {
      if (isEngineAbort(err)) throw err;
      // Timeout (or any other wait error): fall through to the re-check; the budget bounds the loop.
      if (!/timed out|timeout/i.test(errorMessage(err))) console.warn(`${ctx.instanceId} ${base}: wait error ${errorMessage(err)}`);
    }
  }
}
