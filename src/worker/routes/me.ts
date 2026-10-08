// /api/me and /api/me/checklist (employee portal).
import { Hono } from "hono";
import type { ChecklistDto } from "../../shared/api.ts";
import { requireRole } from "../auth/middleware.ts";
import { BLOCKER_SELECT, stageViews, TASK_COLUMNS, toBlockerView, toTaskView, type BlockerRow, type TaskRow } from "../db/repo.ts";
import { apiError, type AppEnv } from "../http.ts";

export function meRoutes() {
  const r = new Hono<AppEnv>();
  r.get("/", (c) => c.json(c.get("principal")));

  r.get("/checklist", requireRole("employee"), async (c) => {
    const id = c.get("principal").employeeId;
    if (!id) return apiError(c, 403, "forbidden", "not an employee");
    const db = c.env.DB;
    const kase = await db.prepare("SELECT status FROM cases WHERE employee_id = ?").bind(id).first<{ status: ChecklistDto["caseStatus"] }>();
    if (!kase) return apiError(c, 404, "not_found", "no case");
    const [stages, tasks, blockers] = await Promise.all([
      stageViews(db, id),
      db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE employee_id = ? AND kind = 'checklist' ORDER BY due_at, id`).bind(id).all<TaskRow>(),
      db.prepare(`${BLOCKER_SELECT} WHERE b.employee_id = ? AND b.status = 'open' ORDER BY b.detected_at`).bind(id).all<BlockerRow>(),
    ]);
    const body: ChecklistDto = {
      caseStatus: kase.status,
      stages,
      tasks: tasks.results.map(toTaskView),
      blockers: blockers.results.map(toBlockerView),
    };
    return c.json(body);
  });
  return r;
}
