import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { API_ROUTES } from "../../src/shared/api.ts";
import { api, type CallOptions } from "../helpers/api.ts";
import { emailOf } from "../helpers/auth.ts";
import { fastWorkflows, managerOf, waitFor, waitForStage } from "../helpers/workflow.ts";

const DB = env.DB;
const now = () => new Date().toISOString();

type MutationCase = { as: string; path: string; opts: CallOptions; action: string; entityType: string; entityId: string; role: string };

let manager148 = "";
beforeAll(async () => {
  manager148 = await managerOf("E148");
  await DB.batch([
    // retry: a started case with a blocked stage (no live instance; the wake-up simply fails, never throws)
    DB.prepare("UPDATE cases SET workflow_instance_id = 'onb-E144-1', status = 'blocked' WHERE employee_id = 'E144'"),
    DB.prepare("UPDATE case_stages SET status = 'blocked', blocked_reason_json = '{\"round\":1}' WHERE employee_id = 'E144' AND stage_id = 'it_provisioning'"),
    // complete task and decide
    DB.prepare(
      "INSERT INTO tasks (id, employee_id, stage_id, kind, template_key, assignee, title, description, status, created_at) VALUES ('chk:E148:w4','E148','paperwork','checklist','w4','employee','W-4','d','open',?)",
    ).bind(now()),
    DB.prepare(
      `INSERT INTO approvals (id, employee_id, stage_id, checkpoint, round, approver_role, approver_staff_id, status, request_json, requested_at, due_at)
       VALUES ('apr:E148:manager_approval:1','E148','manager_approval','manager_approval',1,'manager',?, 'pending','{}',?,?)`,
    ).bind(manager148, now(), now()),
    // resubmit
    DB.prepare(
      `INSERT INTO approvals (id, employee_id, stage_id, checkpoint, round, approver_role, approver_staff_id, status, request_json, requested_at, due_at, decided_at)
       SELECT 'apr:E149:manager_approval:1','E149','manager_approval','manager_approval',1,'manager',manager_id,'rejected','{}',?,?,? FROM employees WHERE id = 'E149'`,
    ).bind(now(), now(), now()),
    DB.prepare("UPDATE case_stages SET status = 'revision_requested' WHERE employee_id = 'E149' AND stage_id = 'manager_approval'"),
    // resolve
    DB.prepare(
      `INSERT INTO blockers (id, employee_id, stage_id, kind, severity, owner_department, subject, dedupe_key, status, detail_json, detected_at)
       VALUES ('blk:E149:fixture','E149','it_provisioning','integration_outage','high','it','it.order-device','E149:fixture','open','{}',?)`,
    ).bind(now()),
  ]);
});

describe("every mutating route writes exactly one primary audit event", () => {
  // cases.scan is excluded on purpose: it changes nothing itself; what the scan opens or resolves
  // is audited as agent actions (blocker.opened, followup.created, blocker.auto_resolved).
  const NOT_PRIMARY = new Set(["cases.scan"]);

  it("covers every mutating route of the registry", () => {
    const mutating = API_ROUTES.filter((r) => r.method !== "GET" && !NOT_PRIMARY.has(r.id)).map((r) => r.id);
    expect(mutating.sort()).toEqual(
      ["employees.patch", "cases.start", "cases.retry", "cases.restart", "cases.terminate", "tasks.complete", "approvals.decision", "approvals.resubmit", "blockers.resolve"].sort(),
    );
  });

  it("records actor, role, entity and request id, in one row per request", async () => {
    const intro = await fastWorkflows();
    try {
      const cases: MutationCase[] = [
        { as: "C01", path: "/api/employees/E142", opts: { method: "PATCH", body: { costCenter: "CC-7777" } }, action: "employee.field_corrected", entityType: "employee", entityId: "E142", role: "coordinator" },
        { as: "C01", path: "/api/cases/E143/start", opts: { body: {} }, action: "case.started", entityType: "case", entityId: "E143", role: "coordinator" },
        { as: "C03", path: "/api/cases/E144/stages/it_provisioning/retry", opts: { body: { note: "vendor fixed" } }, action: "stage.retry_requested", entityType: "stage", entityId: "E144:it_provisioning", role: "coordinator" },
        { as: "E148", path: "/api/tasks/chk:E148:w4/complete", opts: { body: {} }, action: "task.completed", entityType: "task", entityId: "chk:E148:w4", role: "employee" },
        { as: "", path: "/api/approvals/apr:E148:manager_approval:1/decision", opts: { body: { decision: "approve" } }, action: "approval.approved", entityType: "approval", entityId: "apr:E148:manager_approval:1", role: "manager" },
        { as: "C02", path: "/api/approvals/apr:E149:manager_approval:1/resubmit", opts: { body: { note: "revised" } }, action: "approval.resubmitted", entityType: "approval", entityId: "apr:E149:manager_approval:1", role: "coordinator" },
        { as: "C04", path: "/api/blockers/blk:E149:fixture/resolve", opts: { body: { resolution: "fixed by hand" } }, action: "blocker.resolved", entityType: "blocker", entityId: "blk:E149:fixture", role: "coordinator" },
      ];
      cases[4]!.as = manager148;
      const check = async (c: MutationCase) => {
        const r = await api(c.path, { as: c.as, ...c.opts });
        expect(r.status, c.path).toBeLessThan(300);
        const requestId = r.headers.get("X-Request-Id");
        expect(requestId).toBeTruthy();
        const rows = await DB.prepare("SELECT action, actor_id, actor_role, actor_type, entity_type, entity_id FROM audit_events WHERE request_id = ?").bind(requestId).all();
        expect(rows.results, c.path).toEqual([
          { action: c.action, actor_id: await emailOf(c.as), actor_role: c.role, actor_type: "user", entity_type: c.entityType, entity_id: c.entityId },
        ]);
      };
      for (const c of cases) await check(c);
      // restart and terminate the case started above (a live instance)
      await waitForStage("E143", "paperwork", "waiting_on_employee");
      await check({ as: "A01", path: "/api/cases/E143/restart", opts: { body: { reason: "audit test" } }, action: "case.restarted", entityType: "case", entityId: "E143", role: "admin" });
      await waitFor(() => DB.prepare("SELECT 1 AS ok FROM integration_calls WHERE employee_id = 'E143' AND run_no = 2").first(), { what: "run 2" });
      await check({ as: "A01", path: "/api/cases/E143/terminate", opts: { body: { reason: "audit test" } }, action: "case.terminated", entityType: "case", entityId: "E143", role: "admin" });
    } finally {
      await intro.dispose();
    }
  });
});

describe("deterministic ids for workflow, integration and agent actions", () => {
  it("embed the instance, run_no, step name (with round) and action", async () => {
    const rows = await DB.prepare("SELECT id, actor_type, action, run_no, round FROM audit_events WHERE employee_id = 'E143' AND actor_type = 'workflow'").all<{ id: string; action: string; run_no: number; round: number | null }>();
    expect(rows.results.length).toBeGreaterThan(5);
    for (const r of rows.results) {
      if (r.action === "integration.call") expect(r.id).toMatch(new RegExp(`^ic:onb-E143-1:${r.run_no}:[^:]+#r\\d+(\\.\\d+)?(~\\d+)?:\\d+$`));
      else expect(r.id.startsWith(`wf:onb-E143-1:${r.run_no}:`), r.id).toBe(true);
    }
    expect(rows.results.some((r) => r.run_no === 2)).toBe(true);
    const waiting = rows.results.find((r) => r.action === "stage.waiting_on_employee" && r.run_no === 1);
    expect(waiting?.id).toBe("wf:onb-E143-1:1:paperwork.tasks.check#r1.1:stage.waiting_on_employee");
    const started = rows.results.filter((r) => r.action === "stage.started");
    expect(started.every((r) => r.id === `wf:onb-E143-1:${r.run_no}:${r.id.split(":")[3]}:stage.started`)).toBe(true);
  });
});

describe("per-case audit endpoint", () => {
  it("orders by seq and paginates without gaps", async () => {
    const all: number[] = [];
    let cursor: string | null = null;
    do {
      const r: { status: number; body: { items: Array<{ seq: number }>; nextCursor: string | null } } = await api(`/api/cases/E143/audit?limit=5${cursor ? `&cursor=${cursor}` : ""}`, { as: "A01" });
      expect(r.status).toBe(200);
      expect(r.body.items.length).toBeLessThanOrEqual(5);
      all.push(...r.body.items.map((i) => i.seq));
      cursor = r.body.nextCursor;
    } while (cursor);
    const direct = await DB.prepare("SELECT seq FROM audit_events WHERE employee_id = 'E143' ORDER BY seq").all<{ seq: number }>();
    expect(all).toEqual(direct.results.map((r) => r.seq));
    expect([...all].sort((a, b) => a - b)).toEqual(all);
  });
});
