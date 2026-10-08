// Mounts the three simulated systems under /sim (ADR 0005). They live in the
// same Worker and are called over HTTP through the loopback
// exports.default.fetch, so status codes, headers, Idempotency-Key and
// timeouts are real HTTP semantics. They are simulations, labeled as such.
import { Hono } from "hono";
import { FaultPlanInput } from "../../shared/api.ts";
import type { AppEnv } from "../http.ts";
import { FACILITIES_OPS } from "./facilities.ts";
import { clearFaultPlans, d1Faults, insertFaultPlan } from "./faults.ts";
import { HR_OPS } from "./hr.ts";
import { IT_OPS } from "./it.ts";
import { type AnyOp, type FaultHooks, runGet, runPost, SIM_KEY_HEADER } from "./pipeline.ts";

export const SIM_OPS: AnyOp[] = [...HR_OPS, ...IT_OPS, ...FACILITIES_OPS];

export function simApp(faults: FaultHooks = d1Faults) {
  const sim = new Hono<AppEnv>();

  // /sim/admin: dev and EVAL_HOOKS=on only; otherwise these paths do not exist.
  sim.use("/admin/*", async (c, next) => {
    const cfg = c.get("config");
    if (cfg.authMode !== "dev" || !cfg.evalHooks) return c.json({ error: { code: "not_found", message: "not found" } }, 404);
    if (c.req.header(SIM_KEY_HEADER) !== cfg.simApiKey) return c.json({ error: { code: "unauthorized", message: "bad sim key" } }, 401);
    return next();
  });
  sim.post("/admin/faults", async (c) => {
    const parsed = FaultPlanInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: "invalid_request", message: parsed.error.message } }, 400);
    return c.json({ id: await insertFaultPlan(c.env.DB, parsed.data, new Date().toISOString()) }, 201);
  });
  sim.delete("/admin/faults", async (c) =>
    c.json({ cleared: await clearFaultPlans(c.env.DB, new Date().toISOString(), c.req.query("employeeRef") ?? null) }),
  );
  sim.get("/admin/ledger", async (c) => {
    const ref = c.req.query("employeeRef");
    const rows = ref
      ? await c.env.DB.prepare("SELECT * FROM sim_side_effects WHERE employee_ref = ? ORDER BY seq").bind(ref).all()
      : await c.env.DB.prepare("SELECT * FROM sim_side_effects ORDER BY seq").all();
    return c.json({ items: rows.results });
  });

  for (const op of SIM_OPS) {
    if (op.method === "POST") sim.post(op.path, (c) => runPost(c, op, faults));
    else sim.get(op.path, (c) => runGet(c, op, faults));
  }
  sim.notFound((c) => c.json({ error: { code: "not_found", message: "unknown simulated endpoint" } }, 404));
  return sim;
}
