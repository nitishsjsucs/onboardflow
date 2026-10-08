// /api/employees: list (managers see direct reports), profile, and field fixes.
import { Hono } from "hono";
import { EmployeesQuery, type EmployeeSummary, PatchEmployeeBody } from "../../shared/api.ts";
import type { FixableField } from "../../shared/domain.ts";
import { requireRole } from "../auth/middleware.ts";
import { canFixField, canViewCase } from "../auth/policy.ts";
import { getEmployee } from "../db/repo.ts";
import { apiError, type AppEnv } from "../http.ts";
import { body, caseAgent, caseRef, decodeCursor, idempotent, pageLimit, query, toPage } from "./util.ts";

type SummaryRow = {
  id: string;
  name: string;
  email: string;
  job_title: string;
  org_unit: string;
  employment_type: EmployeeSummary["employmentType"];
  work_mode: EmployeeSummary["workMode"];
  start_date: string;
  manager_id: string;
  case_status: EmployeeSummary["caseStatus"];
  current_stage: EmployeeSummary["currentStage"];
  open_blockers: number;
};

export function employeeRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/", requireRole("manager", "coordinator", "admin"), async (c) => {
    const q = query(c, EmployeesQuery);
    if (!q.ok) return q.response;
    const p = c.get("principal");
    const limit = pageLimit(q.value.limit);
    const where: string[] = [];
    const binds: unknown[] = [];
    if (p.role === "manager") {
      where.push("e.manager_id = ?");
      binds.push(p.staffId ?? "");
    }
    if (q.value.stage) {
      where.push("c.current_stage = ?");
      binds.push(q.value.stage);
    }
    if (q.value.status) {
      where.push("c.status = ?");
      binds.push(q.value.status);
    }
    if (q.value.orgUnit) {
      where.push("e.org_unit = ?");
      binds.push(q.value.orgUnit);
    }
    if (q.value.q) {
      where.push("(e.id LIKE ? OR e.email LIKE ? OR (e.first_name || ' ' || e.last_name) LIKE ?)");
      const like = `%${q.value.q}%`;
      binds.push(like, like, like);
    }
    const after = decodeCursor<string>(q.value.cursor);
    if (after) {
      where.push("e.id > ?");
      binds.push(after);
    }
    const rows = await c.env.DB.prepare(
      `SELECT e.id, e.first_name || ' ' || e.last_name AS name, e.email, e.job_title, e.org_unit, e.employment_type, e.work_mode,
              e.start_date, e.manager_id, c.status AS case_status, c.current_stage,
              (SELECT COUNT(*) FROM blockers b WHERE b.employee_id = e.id AND b.status = 'open') AS open_blockers
         FROM employees e JOIN cases c ON c.employee_id = e.id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY e.id LIMIT ?`,
    )
      .bind(...binds, limit + 1)
      .all<SummaryRow>();
    return c.json(
      toPage(
        rows.results,
        limit,
        (x): EmployeeSummary => ({
          id: x.id,
          name: x.name,
          email: x.email,
          jobTitle: x.job_title,
          orgUnit: x.org_unit,
          employmentType: x.employment_type,
          workMode: x.work_mode,
          startDate: x.start_date,
          managerId: x.manager_id,
          caseStatus: x.case_status,
          currentStage: x.current_stage,
          openBlockers: x.open_blockers,
        }),
        (x) => x.id,
      ),
    );
  });

  r.get("/:id", async (c) => {
    const ref = await caseRef(c.env.DB, c.req.param("id"));
    if (!ref) return apiError(c, 404, "not_found", "unknown employee");
    if (!canViewCase(c.get("principal"), ref)) return apiError(c, 403, "forbidden", "not allowed to view this employee");
    return c.json(await getEmployee(c.env.DB, ref.employeeId));
  });

  r.patch("/:id", requireRole("coordinator", "admin"), async (c) => {
    const id = c.req.param("id");
    const ref = await caseRef(c.env.DB, id);
    if (!ref) return apiError(c, 404, "not_found", "unknown employee");
    const b = await body(c, PatchEmployeeBody);
    if (!b.ok) return b.response;
    const [field, value] = Object.entries(b.value)[0] as [FixableField, string | boolean];
    if (!canFixField(c.get("principal"), field)) return apiError(c, 403, "forbidden", `only the owner department may correct ${field}`);
    return idempotent(c, b.value, async (cmd) => (await caseAgent(c.env, id)).fixField(field, value, cmd));
  });

  return r;
}
