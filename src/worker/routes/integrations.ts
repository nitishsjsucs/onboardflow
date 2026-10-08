// /api/integrations/health: per-system call statistics over a time window.
import { Hono } from "hono";
import type { IntegrationHealth } from "../../shared/agent-state.ts";
import { HealthQuery } from "../../shared/api.ts";
import { SYSTEM_IDS, type SystemId } from "../../shared/domain.ts";
import { requireRole } from "../auth/middleware.ts";
import type { AppEnv } from "../http.ts";
import { query } from "./util.ts";

const WINDOWS_MS = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000 } as const;

export function integrationRoutes() {
  const r = new Hono<AppEnv>();
  r.get("/health", requireRole("coordinator", "admin"), async (c) => {
    const q = query(c, HealthQuery);
    if (!q.ok) return q.response;
    const w = q.value.window ?? "24h";
    const since = w === "all" ? "" : new Date(c.get("clock").nowMs() - WINDOWS_MS[w]).toISOString();
    const rows = await c.env.DB.prepare(
      `SELECT system, COUNT(*) AS calls, SUM(outcome = 'ok') AS ok, SUM(outcome IN ('retryable_error','timeout','malformed')) AS retried,
              SUM(outcome = 'replayed') AS replayed, MAX(CASE WHEN outcome NOT IN ('ok','replayed') THEN created_at END) AS last_error_at
         FROM integration_calls WHERE created_at >= ? GROUP BY system`,
    )
      .bind(since)
      .all<{ system: SystemId; calls: number; ok: number; retried: number; replayed: number; last_error_at: string | null }>();
    const out = Object.fromEntries(SYSTEM_IDS.map((s) => [s, { calls: 0, ok: 0, retried: 0, replayed: 0, lastErrorAt: null }])) as Record<SystemId, IntegrationHealth>;
    for (const x of rows.results) out[x.system] = { calls: x.calls, ok: x.ok, retried: x.retried, replayed: x.replayed, lastErrorAt: x.last_error_at };
    return c.json(out);
  });
  return r;
}
