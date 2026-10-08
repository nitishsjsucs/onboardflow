// /api/approvals: the approver's queue, decisions (admin on behalf), and People Ops resubmission.
import { Hono } from "hono";
import { ApprovalsQuery, DecisionBody, ResubmitBody } from "../../shared/api.ts";
import { requireRole } from "../auth/middleware.ts";
import { canDecideApproval, canResubmit } from "../auth/policy.ts";
import { APPROVAL_SELECT, type ApprovalRow, getApproval, toApprovalView } from "../db/repo.ts";
import { apiError, type AppEnv } from "../http.ts";
import { body, caseAgent, decodeCursor, idempotent, pageLimit, query, toPage } from "./util.ts";

export function approvalRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/", requireRole("manager", "coordinator", "admin"), async (c) => {
    const p = c.get("principal");
    if (p.role === "coordinator" && p.department !== "people_ops") return apiError(c, 403, "forbidden", "approvals are handled by managers and People Ops");
    const q = query(c, ApprovalsQuery);
    if (!q.ok) return q.response;
    const limit = pageLimit(q.value.limit);
    const status = q.value.status ?? "pending";
    const where: string[] = [];
    const binds: unknown[] = [];
    if (status !== "all") {
      where.push("a.status = ?");
      binds.push(status);
    }
    if (p.role === "manager") {
      where.push("a.approver_staff_id = ?");
      binds.push(p.staffId ?? "");
    } else if (p.role === "coordinator") {
      // People Ops decides closeout and resubmits rejected requests of either checkpoint.
      where.push("(a.checkpoint = 'closeout' OR a.status = 'rejected')");
    }
    const after = decodeCursor<string>(q.value.cursor);
    if (after) {
      where.push("a.id > ?");
      binds.push(after);
    }
    const rows = await c.env.DB.prepare(`${APPROVAL_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY a.id LIMIT ?`)
      .bind(...binds, limit + 1)
      .all<ApprovalRow>();
    const stages = await c.env.DB.prepare("SELECT employee_id, stage_id, status, round FROM case_stages WHERE stage_id IN ('manager_approval','closeout') AND status = 'revision_requested'").all<{
      employee_id: string;
      stage_id: string;
      round: number;
    }>();
    const awaiting = new Set(stages.results.map((s) => `${s.employee_id}:${s.stage_id}:${s.round}`));
    return c.json(
      toPage(
        rows.results,
        limit,
        (a) => ({ ...toApprovalView(a), resubmittable: a.status === "rejected" && awaiting.has(`${a.employee_id}:${a.stage_id}:${a.round}`) }),
        (a) => a.id,
      ),
    );
  });

  r.post("/:id/decision", requireRole("manager", "coordinator", "admin"), async (c) => {
    const a = await getApproval(c.env.DB, c.req.param("id"));
    if (!a) return apiError(c, 404, "not_found", "unknown approval");
    const allowed = canDecideApproval(c.get("principal"), { checkpoint: a.checkpoint, approverStaffId: a.approver_staff_id });
    if (!allowed.allowed) return apiError(c, 403, "forbidden", "not the approver of this checkpoint");
    const b = await body(c, DecisionBody);
    if (!b.ok) return b.response;
    return idempotent(c, b.value, async (cmd) =>
      (await caseAgent(c.env, a.employee_id)).decideApproval(a.id, { ...b.value, ...(allowed.onBehalfOf ? { onBehalfOf: allowed.onBehalfOf } : {}) }, cmd),
    );
  });

  r.post("/:id/resubmit", requireRole("coordinator", "admin"), async (c) => {
    const a = await getApproval(c.env.DB, c.req.param("id"));
    if (!a) return apiError(c, 404, "not_found", "unknown approval");
    if (!canResubmit(c.get("principal"))) return apiError(c, 403, "forbidden", "only People Ops and admins resubmit");
    const b = await body(c, ResubmitBody);
    if (!b.ok) return b.response;
    return idempotent(c, b.value, async (cmd) => (await caseAgent(c.env, a.employee_id)).resubmitApproval(a.id, cmd, b.value.note));
  });

  return r;
}
