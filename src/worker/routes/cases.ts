// /api/cases/:id: start, detail, audit trail, integration log, retry, scan, restart, terminate.
import { Hono } from "hono";
import { AuditQuery, type CaseDetail, EmptyBody, NoteBody, PageQuery, ReasonBody } from "../../shared/api.ts";
import type { SystemId } from "../../shared/domain.ts";
import type { Department } from "../../shared/roles.ts";
import { isStageId, STAGE_BY_ID } from "../../shared/stages.ts";
import { requireRole } from "../auth/middleware.ts";
import { canRestartOrTerminate, canRetryStage, canStartCase, canViewCase } from "../auth/policy.ts";
import {
  APPROVAL_SELECT,
  type ApprovalRow,
  type AuditRow,
  BLOCKER_SELECT,
  type BlockerRow,
  getEmployee,
  type IntegrationCallRow,
  stageViews,
  TASK_COLUMNS,
  type TaskRow,
  toApprovalView,
  toAuditView,
  toBlockerView,
  toIntegrationCallView,
  toTaskView,
} from "../db/repo.ts";
import { apiError, type AppEnv } from "../http.ts";
import { body, caseAgent, caseRef, decodeCursor, idempotent, pageLimit, query, toPage } from "./util.ts";

export function caseRoutes() {
  const r = new Hono<AppEnv>();

  r.post("/:id/start", requireRole("coordinator", "admin"), async (c) => {
    const id = c.req.param("id");
    if (!(await caseRef(c.env.DB, id))) return apiError(c, 404, "not_found", "unknown case");
    if (!canStartCase(c.get("principal"))) return apiError(c, 403, "forbidden", "only People Ops coordinators and admins start cases");
    const b = await body(c, EmptyBody);
    if (!b.ok) return b.response;
    return idempotent(c, b.value, async (cmd) => (await caseAgent(c.env, id)).startCase(cmd));
  });

  r.get("/:id", async (c) => {
    const db = c.env.DB;
    const id = c.req.param("id");
    const ref = await caseRef(db, id);
    if (!ref) return apiError(c, 404, "not_found", "unknown case");
    if (!canViewCase(c.get("principal"), ref)) return apiError(c, 403, "forbidden", "not allowed to view this case");
    const [employee, manager, kase, stages, tasks, approvals, blockers, prov, calls] = await Promise.all([
      getEmployee(db, id),
      db.prepare("SELECT display_name FROM staff WHERE id = ?").bind(ref.managerId).first<{ display_name: string }>(),
      db
        .prepare("SELECT status, failure_reason, current_stage, run_no, revision, workflow_instance_id, started_at, completed_at FROM cases WHERE employee_id = ?")
        .bind(id)
        .first<{ status: CaseDetail["case"]["status"]; failure_reason: CaseDetail["case"]["failureReason"]; current_stage: CaseDetail["case"]["currentStage"]; run_no: number; revision: number; workflow_instance_id: string | null; started_at: string | null; completed_at: string | null }>(),
      stageViews(db, id),
      db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE employee_id = ? ORDER BY created_at, id`).bind(id).all<TaskRow>(),
      db.prepare(`${APPROVAL_SELECT} WHERE a.employee_id = ? ORDER BY a.requested_at, a.id`).bind(id).all<ApprovalRow>(),
      db.prepare(`${BLOCKER_SELECT} WHERE b.employee_id = ? ORDER BY b.detected_at, b.id`).bind(id).all<BlockerRow>(),
      db
        .prepare("SELECT system, resource, external_id, status, polls, updated_at FROM provisioning_items WHERE employee_id = ? ORDER BY system, resource")
        .bind(id)
        .all<{ system: SystemId; resource: CaseDetail["provisioning"][number]["resource"]; external_id: string | null; status: string; polls: number; updated_at: string }>(),
      db
        .prepare(
          `SELECT system, COUNT(*) AS calls, SUM(outcome = 'ok') AS ok, SUM(outcome IN ('retryable_error','timeout','malformed')) AS retried,
                  SUM(outcome = 'replayed') AS replayed, SUM(outcome = 'fatal_error') AS fatal
             FROM integration_calls WHERE employee_id = ? GROUP BY system`,
        )
        .bind(id)
        .all<{ system: SystemId; calls: number; ok: number; retried: number; replayed: number; fatal: number }>(),
    ]);
    if (!employee || !kase) return apiError(c, 404, "not_found", "unknown case");
    const summary: CaseDetail["integrationSummary"] = {
      hr: { calls: 0, ok: 0, retried: 0, replayed: 0, fatal: 0 },
      it: { calls: 0, ok: 0, retried: 0, replayed: 0, fatal: 0 },
      facilities: { calls: 0, ok: 0, retried: 0, replayed: 0, fatal: 0 },
    };
    for (const s of calls.results) summary[s.system] = { calls: s.calls, ok: s.ok, retried: s.retried, replayed: s.replayed, fatal: s.fatal };
    const detail: CaseDetail = {
      employee: { ...employee, managerName: manager?.display_name ?? ref.managerId },
      case: {
        status: kase.status,
        failureReason: kase.failure_reason,
        currentStage: kase.current_stage,
        runNo: kase.run_no,
        revision: kase.revision,
        workflowInstanceId: kase.workflow_instance_id,
        startedAt: kase.started_at,
        completedAt: kase.completed_at,
      },
      stages,
      tasks: tasks.results.map(toTaskView),
      approvals: approvals.results.map(toApprovalView),
      blockers: blockers.results.map(toBlockerView),
      provisioning: prov.results.map((p) => ({ system: p.system, resource: p.resource, externalId: p.external_id, status: p.status, polls: p.polls, updatedAt: p.updated_at })),
      integrationSummary: summary,
    };
    return c.json(detail);
  });

  r.get("/:id/audit", async (c) => {
    const id = c.req.param("id");
    const ref = await caseRef(c.env.DB, id);
    if (!ref) return apiError(c, 404, "not_found", "unknown case");
    if (!canViewCase(c.get("principal"), ref)) return apiError(c, 403, "forbidden", "not allowed to view this case");
    const q = query(c, AuditQuery.pick({ cursor: true, limit: true }));
    if (!q.ok) return q.response;
    const limit = pageLimit(q.value.limit);
    const after = decodeCursor(q.value.cursor, "number") ?? 0;
    const rows = await c.env.DB.prepare("SELECT * FROM audit_events WHERE employee_id = ? AND seq > ? ORDER BY seq LIMIT ?").bind(id, after, limit + 1).all<AuditRow>();
    return c.json(toPage(rows.results, limit, toAuditView, (x) => x.seq));
  });

  r.get("/:id/integrations", requireRole("coordinator", "admin"), async (c) => {
    const id = c.req.param("id");
    if (!(await caseRef(c.env.DB, id))) return apiError(c, 404, "not_found", "unknown case");
    const q = query(c, PageQuery);
    if (!q.ok) return q.response;
    const limit = pageLimit(q.value.limit);
    const after = decodeCursor(q.value.cursor, "number") ?? 0;
    const rows = await c.env.DB.prepare("SELECT rowid AS rid, * FROM integration_calls WHERE employee_id = ? AND rowid > ? ORDER BY rowid LIMIT ?")
      .bind(id, after, limit + 1)
      .all<IntegrationCallRow>();
    return c.json(toPage(rows.results, limit, toIntegrationCallView, (x) => x.rid));
  });

  r.post("/:id/stages/:stage/retry", requireRole("coordinator", "admin"), async (c) => {
    const id = c.req.param("id");
    const stage = c.req.param("stage");
    if (!(await caseRef(c.env.DB, id)) || !isStageId(stage)) return apiError(c, 404, "not_found", "unknown case or stage");
    // The department that owns the stage's open blocker; without one, the stage's owner.
    const blocker = await c.env.DB.prepare("SELECT owner_department FROM blockers WHERE employee_id = ? AND stage_id = ? AND status = 'open' ORDER BY detected_at DESC LIMIT 1")
      .bind(id, stage)
      .first<{ owner_department: Department }>();
    const stageOwner = STAGE_BY_ID[stage].owner;
    const owner: Department = blocker?.owner_department ?? (stageOwner === "manager" ? "people_ops" : stageOwner);
    if (!canRetryStage(c.get("principal"), owner)) return apiError(c, 403, "forbidden", `only ${owner} may retry this stage`);
    const b = await body(c, NoteBody);
    if (!b.ok) return b.response;
    return idempotent(c, b.value, async (cmd) => (await caseAgent(c.env, id)).retryStage(stage, cmd, b.value.note));
  });

  r.post("/:id/scan", requireRole("coordinator", "admin"), async (c) => {
    const id = c.req.param("id");
    if (!(await caseRef(c.env.DB, id))) return apiError(c, 404, "not_found", "unknown case");
    const b = await body(c, EmptyBody);
    if (!b.ok) return b.response;
    return idempotent(c, b.value, async (cmd) => (await caseAgent(c.env, id)).scanNow(cmd));
  });

  r.post("/:id/restart", requireRole("admin"), async (c) => {
    const id = c.req.param("id");
    if (!(await caseRef(c.env.DB, id))) return apiError(c, 404, "not_found", "unknown case");
    if (!canRestartOrTerminate(c.get("principal"))) return apiError(c, 403, "forbidden", "admin only");
    const b = await body(c, ReasonBody);
    if (!b.ok) return b.response;
    return idempotent(c, b.value, async (cmd) => (await caseAgent(c.env, id)).restartCase(b.value.reason, cmd));
  });

  r.post("/:id/terminate", requireRole("admin"), async (c) => {
    const id = c.req.param("id");
    if (!(await caseRef(c.env.DB, id))) return apiError(c, 404, "not_found", "unknown case");
    const b = await body(c, ReasonBody);
    if (!b.ok) return b.response;
    return idempotent(c, b.value, async (cmd) => (await caseAgent(c.env, id)).terminateCase(b.value.reason, cmd));
  });

  return r;
}
