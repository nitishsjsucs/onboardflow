// /api/dashboard/summary: the dashboard aggregates recomputed from D1 on request,
// in the same shape as the live OpsHubAgent state (and the hub consistency check).
import { Hono } from "hono";
import type { HubState } from "../../shared/agent-state.ts";
import { computeHubDomain } from "../agents/projection.ts";
import { requireRole } from "../auth/middleware.ts";
import type { AppEnv } from "../http.ts";

export function dashboardRoutes() {
  const r = new Hono<AppEnv>();
  r.get("/summary", requireRole("coordinator", "admin"), async (c) => {
    const now = c.get("clock").nowIso();
    const { domain, asOfSeq } = await computeHubDomain(c.env.DB, now);
    const body: HubState = { ...domain, asOfSeq, reconciledAt: now, version: 0 };
    return c.json(body);
  });
  return r;
}
