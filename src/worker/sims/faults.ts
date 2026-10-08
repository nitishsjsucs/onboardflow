// Fault plans for the simulated systems (SPEC Section 9.1). A plan matches a
// (system, operation, employee) triple; employee_ref NULL matches anyone.
// Each matching call consumes one unit of `remaining`; NULL means the fault
// holds until cleared (a sustained outage). Phases:
//   pre  (before replay): fail_503, rate_limit_429, timeout, malformed, conflict_409
//   post (after the atomic commit, first execution only): lost_response
//   poll (GET of an async resource): stall
import type { FaultKind, SystemId } from "../../shared/domain.ts";
import type { FaultPlanInput } from "../../shared/api.ts";
import { type FaultHooks, type SimCtx, type SimReply, simError } from "./pipeline.ts";

export const PRE_FAULTS: readonly FaultKind[] = ["fail_503", "rate_limit_429", "timeout", "malformed", "conflict_409"];
export const POST_FAULTS: readonly FaultKind[] = ["lost_response"];
export const POLL_FAULTS: readonly FaultKind[] = ["stall"];

type PlanRow = { id: number; fault: FaultKind; remaining: number | null; param_json: string };

/** Finds and consumes the first active plan of one of `kinds` for this call. */
export async function consumeFault(
  db: D1Database,
  system: SystemId,
  operation: string,
  employeeRef: string | null,
  kinds: readonly FaultKind[],
): Promise<PlanRow | null> {
  const placeholders = kinds.map(() => "?").join(",");
  const plans = await db
    .prepare(
      `SELECT id, fault, remaining, param_json FROM sim_fault_plans
        WHERE system = ? AND operation = ? AND cleared_at IS NULL
          AND (employee_ref IS NULL OR employee_ref = ?)
          AND (remaining IS NULL OR remaining > 0)
          AND fault IN (${placeholders})
        ORDER BY id`,
    )
    .bind(system, operation, employeeRef ?? "", ...kinds)
    .all<PlanRow>();
  for (const plan of plans.results) {
    if (plan.remaining === null) return plan;
    const took = await db
      .prepare("UPDATE sim_fault_plans SET remaining = remaining - 1 WHERE id = ? AND remaining > 0")
      .bind(plan.id)
      .run();
    if (took.meta.changes === 1) return plan;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function preReply(ctx: SimCtx, plan: PlanRow): Promise<SimReply> {
  const params = JSON.parse(plan.param_json) as { retryAfterMs?: number };
  switch (plan.fault) {
    case "fail_503":
      return simError(503, "service_unavailable", "simulated outage");
    case "rate_limit_429": {
      const ms = params.retryAfterMs ?? 1000;
      return {
        ...simError(429, "rate_limited", "simulated rate limit"),
        headers: { "Retry-After": String(Math.max(1, Math.ceil(ms / 1000))), "retry-after-ms": String(ms) },
      };
    }
    case "timeout":
      // Holds the request past the client's timeout; the client aborts first.
      await sleep(2 * ctx.config.integrationTimeoutMs);
      return simError(504, "upstream_timeout", "simulated timeout");
    case "malformed":
      return { status: 200, body: { ok: "maybe", payload: "<html>maintenance</html>" } };
    case "conflict_409":
      return simError(409, "desk_conflict", "requested workspace preference is taken", { preference: "requested" });
    default:
      return simError(500, "fault_misconfigured", `fault ${plan.fault} is not a pre-execution fault`);
  }
}

export const d1Faults: FaultHooks = {
  async pre(ctx, employeeRef) {
    const plan = await consumeFault(ctx.db, ctx.system, ctx.operation, employeeRef, PRE_FAULTS);
    return plan ? preReply(ctx, plan) : null;
  },
  async post(ctx, employeeRef) {
    const plan = await consumeFault(ctx.db, ctx.system, ctx.operation, employeeRef, POST_FAULTS);
    return plan ? simError(500, "lost_response", "simulated lost response after commit") : null;
  },
  async stalled(ctx, employeeRef) {
    return (await consumeFault(ctx.db, ctx.system, ctx.operation, employeeRef, POLL_FAULTS)) !== null;
  },
};

export async function insertFaultPlan(db: D1Database, p: FaultPlanInput, now: string): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO sim_fault_plans (system, operation, employee_ref, fault, remaining, param_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(p.system, p.operation, p.employeeRef ?? null, p.fault, p.remaining ?? null, JSON.stringify(p.params ?? {}), now)
    .first<{ id: number }>();
  return row!.id;
}

/** Clears active plans (all, one employee's, and optionally one system's). Returns the number cleared. */
export async function clearFaultPlans(db: D1Database, now: string, employeeRef?: string | null, system?: string | null): Promise<number> {
  const where = ["cleared_at IS NULL"];
  const binds: unknown[] = [now];
  if (employeeRef) {
    where.push("employee_ref = ?");
    binds.push(employeeRef);
  }
  if (system) {
    where.push("system = ?");
    binds.push(system);
  }
  const r = await db.prepare(`UPDATE sim_fault_plans SET cleared_at = ? WHERE ${where.join(" AND ")}`).bind(...binds).run();
  return r.meta.changes;
}

/** Clears specific plans by id (eval chaos mode ends outage windows and stalls this way). */
export async function clearFaultPlansById(db: D1Database, now: string, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const r = await db
    .prepare(`UPDATE sim_fault_plans SET cleared_at = ? WHERE cleared_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`)
    .bind(now, ...ids)
    .run();
  return r.meta.changes;
}
