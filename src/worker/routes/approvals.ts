// /api/approvals: the approver's queue, decisions (admin on behalf), and People Ops resubmission.
import { Hono } from "hono";
import { ApprovalsQuery, DecisionBody, ResubmitBody } from "../../shared/api.ts";
import { approvalId } from "../../shared/ids.ts";
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
    const after = decodeCursor(q.value.cursor, "string");
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
    const previous = await previousRounds(c.env.DB, rows.results.slice(0, limit));
    return c.json(
      toPage(
        rows.results,
        limit,
        (a) => {
          const prev = previous.get(approvalId(a.employee_id, a.checkpoint, a.round - 1));
          return { ...toApprovalView(a), resubmittable: a.status === "rejected" && awaiting.has(`${a.employee_id}:${a.stage_id}:${a.round}`), ...(a.round > 1 && prev ? { previousRound: prev } : {}) };
        },
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

type PreviousRound = { round: number; reason: string | null; note: string | null };

/**
 * Read-only round history for the approvals list: for each item past round 1, the previous round's
 * rejection reason (its approvals row) and the People Ops note sent with the resubmission (the
 * approval.resubmitted audit row of that approval, entity index). One query per 50 items, usually one.
 */
async function previousRounds(db: D1Database, items: ApprovalRow[]): Promise<Map<string, PreviousRound>> {
  const ids = [...new Set(items.filter((a) => a.round > 1).map((a) => approvalId(a.employee_id, a.checkpoint, a.round - 1)))];
  const out = new Map<string, PreviousRound>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const r = await db
      .prepare(
        `SELECT a.id, a.round, a.reason,
                (SELECT json_extract(ae.detail_json, '$.note') FROM audit_events ae
                  WHERE ae.entity_type = 'approval' AND ae.entity_id = a.id AND ae.action = 'approval.resubmitted'
                  ORDER BY ae.seq DESC LIMIT 1) AS note
           FROM approvals a WHERE a.id IN (${chunk.map(() => "?").join(", ")})`,
      )
      .bind(...chunk)
      .all<{ id: string; round: number; reason: string | null; note: string | null }>();
    for (const row of r.results) out.set(row.id, { round: row.round, reason: row.reason, note: typeof row.note === "string" ? row.note : null });
  }
  return out;
}
