// /api/dev/* eval hooks (SPEC Section 9): fault plans, the simulated clock,
// profile corruption for 422 scenarios, agent eviction, the hub snapshot and
// a full per-case dump. They exist only with AUTH_MODE=dev and EVAL_HOOKS=on
// (and SIM_CLOCK=on for the clock); otherwise every path answers 404. Admin
// only, behind the same Access, origin and Idempotency-Key checks as /api.
import { getAgentByName } from "agents";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { FaultPlanInput } from "../../shared/api.ts";
import { auditIds } from "../../shared/ids.ts";
import { HUB_NAME } from "../agents/ops-hub-agent.ts";
import { requireRole } from "../auth/middleware.ts";
import { auditInsert } from "../db/audit.ts";
import { getEmployee, TASK_COLUMNS, type TaskRow, toTaskView } from "../db/repo.ts";
import { errorMessage } from "../integrations/errors.ts";
import { apiError, type AppContext, type AppEnv } from "../http.ts";
import { clearFaultPlans, clearFaultPlansById, insertFaultPlan } from "../sims/faults.ts";
import { body, caseRef, idempotent } from "./util.ts";

// Negative values are allowed so the eval harness can pin the simulated "now" to the seed's
// reference date (the committed seed is anchored at 2026-11-02 and never changes).
const ClockBody = z.object({ ms: z.number().int().min(-3660 * 86_400_000).max(366 * 86_400_000) });
const CorruptBody = z.discriminatedUnion("field", [
  z.object({ field: z.literal("costCenter"), value: z.string().min(1).max(32) }),
  z.object({ field: z.literal("licenseBundle"), value: z.enum(["ft-standard", "ft-engineering", "contractor-basic", "intern-basic"]) }),
  z.object({ field: z.literal("photoOnFile"), value: z.union([z.boolean(), z.literal(0), z.literal(1)]) }),
]);
const COLUMN = { costCenter: "cost_center", licenseBundle: "license_bundle", photoOnFile: "photo_on_file" } as const;

function evalAudit(c: AppContext, action: "eval.fault_set" | "eval.clock_advanced" | "eval.agent_evicted", entityType: string, entityId: string, detail: Record<string, unknown>, employeeId?: string) {
  const requestId = c.get("requestId");
  const p = c.get("principal");
  return auditInsert(c.env.DB, {
    id: auditIds.user(requestId, action),
    occurredAt: c.get("clock").nowIso(),
    actorType: "user",
    actorId: p.email,
    actorRole: p.role,
    action,
    entityType,
    entityId,
    employeeId: employeeId ?? null,
    requestId,
    detail,
  }).run();
}

/** Registered before authentication, so in production these paths simply do not exist. */
export const evalHooksEnabled: MiddlewareHandler<AppEnv> = async (c, next) => {
  const cfg = c.get("config");
  if (cfg.authMode !== "dev" || !cfg.evalHooks) return apiError(c, 404, "not_found", "not found");
  return next();
};

export function evalHookRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", requireRole("admin"));

  r.post("/clock/advance", async (c) => {
    if (!c.get("config").simClock) return apiError(c, 404, "not_found", "SIM_CLOCK is off");
    const b = await body(c, ClockBody);
    if (!b.ok) return b.response;
    return idempotent(c, b.value, async () => {
      const row = await c.env.DB.prepare("UPDATE sim_clock SET offset_ms = offset_ms + ? WHERE id = 1 RETURNING offset_ms").bind(b.value.ms).first<{ offset_ms: number }>();
      await evalAudit(c, "eval.clock_advanced", "sim_clock", "1", { ms: b.value.ms, offsetMs: row?.offset_ms ?? 0 });
      return { status: 200, body: { offsetMs: row?.offset_ms ?? 0 } };
    });
  });

  r.post("/faults", async (c) => {
    const b = await body(c, FaultPlanInput);
    if (!b.ok) return b.response;
    return idempotent(c, b.value, async () => {
      const id = await insertFaultPlan(c.env.DB, b.value, new Date().toISOString());
      await evalAudit(c, "eval.fault_set", "fault_plan", String(id), { ...b.value }, b.value.employeeRef ?? undefined);
      return { status: 200, body: { id } };
    });
  });

  r.delete("/faults", async (c) => {
    const employeeRef = c.req.query("employeeRef") ?? null;
    const system = c.req.query("system") ?? null;
    const ids = (c.req.query("ids") ?? "")
      .split(",")
      .map((x) => Number(x))
      .filter((x) => Number.isInteger(x) && x > 0);
    return idempotent(c, { employeeRef, system, ids }, async () => {
      const cleared = ids.length > 0 ? await clearFaultPlansById(c.env.DB, new Date().toISOString(), ids) : await clearFaultPlans(c.env.DB, new Date().toISOString(), employeeRef, system);
      await evalAudit(c, "eval.fault_set", "fault_plan", ids.length > 0 ? ids.join(",") : (employeeRef ?? "*"), { cleared, employeeRef, system, ids }, employeeRef ?? undefined);
      return { status: 200, body: { cleared } };
    });
  });

  r.patch("/employees/:id/corrupt", async (c) => {
    const id = c.req.param("id");
    if (!(await caseRef(c.env.DB, id))) return apiError(c, 404, "not_found", "unknown employee");
    const b = await body(c, CorruptBody);
    if (!b.ok) return b.response;
    return idempotent(c, b.value, async () => {
      const value = b.value.field === "photoOnFile" ? (b.value.value === true || b.value.value === 1 ? 1 : 0) : b.value.value;
      await c.env.DB.prepare(`UPDATE employees SET ${COLUMN[b.value.field]} = ?, updated_at = ? WHERE id = ?`).bind(value, c.get("clock").nowIso(), id).run();
      await evalAudit(c, "eval.fault_set", "employee", id, { corrupt: b.value.field, value: b.value.value }, id);
      return { status: 200, body: (await getEmployee(c.env.DB, id)) as object };
    });
  });

  r.post("/agents/:kind/:name/evict", async (c) => {
    const kind = c.req.param("kind");
    const name = c.req.param("name");
    if (kind === "case" && !(await caseRef(c.env.DB, name))) return apiError(c, 404, "not_found", "unknown case");
    if (kind === "hub" && name !== HUB_NAME) return apiError(c, 404, "not_found", "unknown hub");
    if (kind !== "case" && kind !== "hub") return apiError(c, 404, "not_found", "kind must be case or hub");
    return idempotent(c, { kind, name }, async () => {
      try {
        const stub = kind === "case" ? await getAgentByName(c.env.CASE_AGENT, name) : await getAgentByName(c.env.OPS_HUB_AGENT, HUB_NAME);
        await (stub as unknown as { devEvict(): Promise<void> }).devEvict();
      } catch (err) {
        // ctx.abort("eval-evict") fails the RPC that triggered it: that is the expected outcome.
        if (!/eval-evict/.test(errorMessage(err))) throw err;
      }
      await evalAudit(c, "eval.agent_evicted", kind === "case" ? "case_agent" : "ops_hub_agent", name, { kind }, kind === "case" ? name : undefined);
      return { status: 202, body: { evicted: true } };
    });
  });

  r.get("/eval/hub", async (c) => {
    const hub = (await getAgentByName(c.env.OPS_HUB_AGENT, HUB_NAME)) as unknown as { getSnapshot(): Promise<unknown> };
    return c.json((await hub.getSnapshot()) as object);
  });

  r.get("/eval/snapshot/:id", async (c) => {
    const id = c.req.param("id");
    const db = c.env.DB;
    if (!(await caseRef(db, id))) return apiError(c, 404, "not_found", "unknown case");
    const [kase, stages, tasks, approvals, blockers, provisioning, calls, audit, ledger] = await db.batch([
      db.prepare("SELECT * FROM cases WHERE employee_id = ?").bind(id),
      db.prepare("SELECT * FROM case_stages cs JOIN stages s ON s.id = cs.stage_id WHERE cs.employee_id = ? ORDER BY s.ordinal").bind(id),
      db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE employee_id = ? ORDER BY created_at, id`).bind(id),
      db.prepare("SELECT * FROM approvals WHERE employee_id = ? ORDER BY requested_at, id").bind(id),
      db.prepare("SELECT * FROM blockers WHERE employee_id = ? ORDER BY detected_at, id").bind(id),
      db.prepare("SELECT * FROM provisioning_items WHERE employee_id = ? ORDER BY resource").bind(id),
      db.prepare("SELECT * FROM integration_calls WHERE employee_id = ? ORDER BY rowid").bind(id),
      db.prepare("SELECT * FROM audit_events WHERE employee_id = ? ORDER BY seq").bind(id),
      db.prepare("SELECT * FROM sim_side_effects WHERE employee_ref = ? ORDER BY seq").bind(id),
    ]);
    return c.json({
      employeeId: id,
      case: kase?.results[0] ?? null,
      stages: stages?.results ?? [],
      tasks: ((tasks?.results ?? []) as TaskRow[]).map(toTaskView),
      approvals: approvals?.results ?? [],
      blockers: blockers?.results ?? [],
      provisioning: provisioning?.results ?? [],
      integrationCalls: calls?.results ?? [],
      audit: audit?.results ?? [],
      ledger: ledger?.results ?? [],
    });
  });

  return r;
}
