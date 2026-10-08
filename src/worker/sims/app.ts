// Mounts the three simulated systems under /sim (ADR 0005). They live in the
// same Worker and are called over HTTP through the loopback
// exports.default.fetch, so status codes, headers, Idempotency-Key and
// timeouts are real HTTP semantics. They are simulations, labeled as such.
import { Hono } from "hono";
import type { AppEnv } from "../http.ts";
import { FACILITIES_OPS } from "./facilities.ts";
import { HR_OPS } from "./hr.ts";
import { IT_OPS } from "./it.ts";
import { type AnyOp, type FaultHooks, NO_FAULTS, runGet, runPost } from "./pipeline.ts";

export const SIM_OPS: AnyOp[] = [...HR_OPS, ...IT_OPS, ...FACILITIES_OPS];

export function simApp(faults: FaultHooks = NO_FAULTS) {
  const sim = new Hono<AppEnv>();
  for (const op of SIM_OPS) {
    if (op.method === "POST") sim.post(op.path, (c) => runPost(c, op, faults));
    else sim.get(op.path, (c) => runGet(c, op, faults));
  }
  sim.notFound((c) => c.json({ error: { code: "not_found", message: "unknown simulated endpoint" } }, 404));
  return sim;
}
