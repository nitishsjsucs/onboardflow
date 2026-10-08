// /api/followups: department queues of follow-up tasks created by the agents.
import { Hono } from "hono";
import { FollowupsQuery } from "../../shared/api.ts";
import { requireRole } from "../auth/middleware.ts";
import { TASK_COLUMNS, type TaskRow, toTaskView } from "../db/repo.ts";
import type { AppEnv } from "../http.ts";
import { decodeCursor, pageLimit, query, toPage } from "./util.ts";

export function followupRoutes() {
  const r = new Hono<AppEnv>();
  r.get("/", requireRole("coordinator", "admin"), async (c) => {
    const p = c.get("principal");
    const q = query(c, FollowupsQuery);
    if (!q.ok) return q.response;
    const limit = pageLimit(q.value.limit);
    const where = ["kind = 'followup'"];
    const binds: unknown[] = [];
    const status = q.value.status ?? "open";
    if (status !== "all") {
      where.push("status = ?");
      binds.push(status);
    }
    const dept = p.role === "coordinator" ? p.department : q.value.department;
    if (dept) {
      where.push("assignee = ?");
      binds.push(dept);
    }
    const after = decodeCursor<string>(q.value.cursor);
    if (after) {
      where.push("id > ?");
      binds.push(after);
    }
    const rows = await c.env.DB.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`).bind(...binds, limit + 1).all<TaskRow>();
    return c.json(toPage(rows.results, limit, toTaskView, (t) => t.id));
  });
  return r;
}
