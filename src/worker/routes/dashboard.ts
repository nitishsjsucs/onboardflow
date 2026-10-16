// /api/dashboard: read-only aggregates for coordinators and admins (the same
// role gate as the live hub: view_dashboard).
//   /summary          the dashboard aggregates recomputed from D1 on request, in the same shape as the
//                     live OpsHubAgent state (and the hub consistency check).
//   /start-readiness  people starting each week from today, by readiness for day one: one grouped
//                     statement over employees (150 rows in the seed) with primary-key lookups of their
//                     case and current stage, bucketed in src/shared/readiness.ts.
import { Hono } from "hono";
import type { HubState } from "../../shared/agent-state.ts";
import { StartReadinessQuery, type StartReadinessDto } from "../../shared/api.ts";
import type { CaseStatus, StageStatus } from "../../shared/domain.ts";
import { bucketReadiness, readinessWindow } from "../../shared/readiness.ts";
import type { StageId } from "../../shared/stages.ts";
import { computeHubDomain } from "../agents/projection.ts";
import { requireRole } from "../auth/middleware.ts";
import type { AppEnv } from "../http.ts";
import { query } from "./util.ts";

export const DEFAULT_READINESS_WEEKS = 12;

export function dashboardRoutes() {
  const r = new Hono<AppEnv>();
  r.get("/summary", requireRole("coordinator", "admin"), async (c) => {
    const now = c.get("clock").nowIso();
    const { domain, asOfSeq } = await computeHubDomain(c.env.DB, now);
    const body: HubState = { ...domain, asOfSeq, reconciledAt: now, version: 0 };
    return c.json(body);
  });

  // No Cache-Control: a browser cache would outlive Switch persona, which clears only the query cache.
  r.get("/start-readiness", requireRole("coordinator", "admin"), async (c) => {
    const q = query(c, StartReadinessQuery);
    if (!q.ok) return q.response;
    const weeks = q.value.weeks ?? DEFAULT_READINESS_WEEKS;
    const today = c.get("clock").nowIso().slice(0, 10);
    const { end } = readinessWindow(today, weeks);
    // Start dates before `end`; of those before today, only cases that are not complete (already started, not finished).
    const rows = await c.env.DB.prepare(
      `SELECT e.start_date, c.status AS case_status, c.current_stage, cs.status AS stage_status, COUNT(*) AS n
         FROM employees e
         JOIN cases c ON c.employee_id = e.id
         LEFT JOIN case_stages cs ON cs.employee_id = c.employee_id AND cs.stage_id = c.current_stage
        WHERE e.start_date < ? AND (e.start_date >= ? OR c.status <> 'complete')
        GROUP BY e.start_date, c.status, c.current_stage, cs.status`,
    )
      .bind(end, today)
      .all<{ start_date: string; case_status: CaseStatus; current_stage: StageId | null; stage_status: StageStatus | null; n: number }>();
    const body: StartReadinessDto = bucketReadiness(
      rows.results.map((x) => ({ startDate: x.start_date, caseStatus: x.case_status, currentStage: x.current_stage, stageStatus: x.stage_status, n: x.n })),
      today,
      weeks,
    );
    return c.json(body);
  });
  return r;
}
