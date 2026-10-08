// /api/audit: the admin audit explorer (newest first, filterable).
import { Hono } from "hono";
import { AuditQuery } from "../../shared/api.ts";
import { requireRole } from "../auth/middleware.ts";
import { type AuditRow, toAuditView } from "../db/repo.ts";
import type { AppEnv } from "../http.ts";
import { decodeCursor, pageLimit, query, toPage } from "./util.ts";

export function auditRoutes() {
  const r = new Hono<AppEnv>();
  r.get("/", requireRole("admin"), async (c) => {
    const q = query(c, AuditQuery);
    if (!q.ok) return q.response;
    const limit = pageLimit(q.value.limit);
    const where: string[] = [];
    const binds: unknown[] = [];
    if (q.value.action) {
      where.push("action = ?");
      binds.push(q.value.action);
    }
    if (q.value.actor) {
      where.push("actor_id = ?");
      binds.push(q.value.actor);
    }
    if (q.value.employeeId) {
      where.push("employee_id = ?");
      binds.push(q.value.employeeId);
    }
    const before = decodeCursor<number>(q.value.cursor);
    if (before !== null) {
      where.push("seq < ?");
      binds.push(before);
    }
    const rows = await c.env.DB.prepare(`SELECT * FROM audit_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ?`)
      .bind(...binds, limit + 1)
      .all<AuditRow>();
    return c.json(toPage(rows.results, limit, toAuditView, (x) => x.seq));
  });
  return r;
}
