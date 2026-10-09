// /api/blockers: department queues of blockers, and manual resolution.
import { Hono } from "hono";
import { BlockersQuery, ResolveBody } from "../../shared/api.ts";
import { requireRole } from "../auth/middleware.ts";
import { canWorkDepartment } from "../auth/policy.ts";
import { BLOCKER_SELECT, type BlockerRow, getBlocker, toBlockerView } from "../db/repo.ts";
import { apiError, type AppEnv } from "../http.ts";
import { body, caseAgent, decodeCursor, idempotent, pageLimit, query, toPage } from "./util.ts";

export function blockerRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/", requireRole("coordinator", "admin"), async (c) => {
    const p = c.get("principal");
    const q = query(c, BlockersQuery);
    if (!q.ok) return q.response;
    const limit = pageLimit(q.value.limit);
    const where: string[] = [];
    const binds: unknown[] = [];
    const status = q.value.status ?? "open";
    if (status !== "all") {
      where.push("b.status = ?");
      binds.push(status);
    }
    // Coordinators see only their own department's queue (fail closed without one); admins may filter.
    if (p.role === "coordinator" && !p.department) return apiError(c, 403, "forbidden", "coordinator account has no department");
    const dept = p.role === "coordinator" ? p.department : q.value.department;
    if (dept) {
      where.push("b.owner_department = ?");
      binds.push(dept);
    }
    if (q.value.kind) {
      where.push("b.kind = ?");
      binds.push(q.value.kind);
    }
    const after = decodeCursor(q.value.cursor, "string");
    if (after) {
      where.push("b.id > ?");
      binds.push(after);
    }
    const rows = await c.env.DB.prepare(`${BLOCKER_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY b.id LIMIT ?`)
      .bind(...binds, limit + 1)
      .all<BlockerRow>();
    return c.json(toPage(rows.results, limit, toBlockerView, (b) => b.id));
  });

  r.post("/:id/resolve", requireRole("coordinator", "admin"), async (c) => {
    const b = await getBlocker(c.env.DB, c.req.param("id"));
    if (!b) return apiError(c, 404, "not_found", "unknown blocker");
    if (!canWorkDepartment(c.get("principal"), b.owner_department)) return apiError(c, 403, "forbidden", `owned by ${b.owner_department}`);
    const parsed = await body(c, ResolveBody);
    if (!parsed.ok) return parsed.response;
    return idempotent(c, parsed.value, async (cmd) => (await caseAgent(c.env, b.employee_id)).resolveBlocker(b.id, parsed.value.resolution, cmd));
  });

  return r;
}
