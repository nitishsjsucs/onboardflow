import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  ApprovalViewSchema,
  AuditEventViewSchema,
  BlockerViewSchema,
  CaseDetailSchema,
  ChecklistSchema,
  EmployeeProfileSchema,
  EmployeeSummarySchema,
  ErrorEnvelopeSchema,
  Health,
  HubStateSchema,
  IntegrationCallViewSchema,
  IntegrationsHealthSchema,
  Me,
  page,
  RestartResponse,
  RoundResponse,
  ScanResponse,
  StartResponse,
  TaskViewSchema,
  TerminateResponse,
} from "../../src/shared/api.ts";
import { api } from "../helpers/api.ts";
import { setFault } from "../helpers/sims.ts";
import { driveHappyPathViaApi, fastWorkflows, managerOf, waitFor, waitForStage } from "../helpers/workflow.ts";

const DB = env.DB;
const DONE = "E020";
let manager = "";

function valid<T extends z.ZodTypeAny>(schema: T, r: { status: number; body: unknown }, status = 200): z.infer<T> {
  expect(r.status).toBe(status);
  const parsed = schema.safeParse(r.body);
  if (!parsed.success) throw new Error(`schema mismatch: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`);
  return parsed.data;
}

beforeAll(async () => {
  manager = await managerOf(DONE);
  const intro = await fastWorkflows();
  try {
    expect((await driveHappyPathViaApi(DONE)).status).toBe("complete");
  } finally {
    await intro.dispose();
  }
}, 60_000);

describe("read routes return the documented shapes", () => {
  it("health, me, checklist", async () => {
    valid(Health, await api("/api/health"));
    expect(valid(Me, await api("/api/me", { as: DONE })).employeeId).toBe(DONE);
    const cl = valid(ChecklistSchema, await api("/api/me/checklist", { as: DONE }));
    expect(cl.caseStatus).toBe("complete");
    expect(cl.tasks).toHaveLength(10);
  });

  it("employees: list with filters, manager scope, profile", async () => {
    const all = valid(page(EmployeeSummarySchema), await api("/api/employees?limit=100", { as: "A01" }));
    expect(all.items).toHaveLength(100);
    expect(all.nextCursor).not.toBeNull();
    const rest = valid(page(EmployeeSummarySchema), await api(`/api/employees?limit=100&cursor=${all.nextCursor}`, { as: "A01" }));
    expect(all.items.length + rest.items.length).toBe(150);
    expect(rest.nextCursor).toBeNull();
    const done = valid(page(EmployeeSummarySchema), await api("/api/employees?status=complete", { as: "C01" }));
    expect(done.items.map((e) => e.id)).toEqual([DONE]);
    const mine = valid(page(EmployeeSummarySchema), await api("/api/employees?limit=100", { as: manager }));
    expect(mine.items.every((e) => e.managerId === manager)).toBe(true);
    expect(mine.items.map((e) => e.id)).toContain(DONE);
    const q = valid(page(EmployeeSummarySchema), await api(`/api/employees?q=${DONE}`, { as: "C01" }));
    expect(q.items.map((e) => e.id)).toEqual([DONE]);
    valid(EmployeeProfileSchema, await api(`/api/employees/${DONE}`, { as: DONE }));
  });

  it("case detail, audit trail, integration log", async () => {
    const d = valid(CaseDetailSchema, await api(`/api/cases/${DONE}`, { as: "A01" }));
    expect(d.case.status).toBe("complete");
    expect(d.stages.every((s) => s.status === "complete")).toBe(true);
    expect(d.approvals).toHaveLength(2);
    expect(d.integrationSummary.it.calls).toBeGreaterThan(0);
    const audit = valid(page(AuditEventViewSchema), await api(`/api/cases/${DONE}/audit?limit=100`, { as: DONE }));
    expect(audit.items.length).toBeGreaterThan(20);
    const calls = valid(page(IntegrationCallViewSchema), await api(`/api/cases/${DONE}/integrations?limit=100`, { as: "C03" }));
    expect(calls.items.length).toBeGreaterThanOrEqual(12);
  });

  it("queues, dashboard, health, audit explorer", async () => {
    valid(page(ApprovalViewSchema), await api("/api/approvals?status=all", { as: "A01" }));
    valid(page(ApprovalViewSchema), await api("/api/approvals", { as: manager }));
    valid(page(BlockerViewSchema), await api("/api/blockers?status=all", { as: "C03" }));
    valid(page(TaskViewSchema), await api("/api/followups?status=all", { as: "C01" }));
    const hub = valid(HubStateSchema, await api("/api/dashboard/summary", { as: "C05" }));
    expect(Object.values(hub.totals).reduce((a, b) => a + b, 0)).toBe(150);
    expect(hub.totals.complete).toBe(1);
    const health = valid(IntegrationsHealthSchema, await api("/api/integrations/health?window=all", { as: "C03" }));
    expect(health.hr.calls).toBeGreaterThan(0);
    const audit = valid(page(AuditEventViewSchema), await api("/api/audit?limit=10&action=case.completed", { as: "A01" }));
    expect(audit.items.map((a) => a.employeeId)).toEqual([DONE]);
  });
});

describe("mutation routes return the documented shapes", () => {
  it("start, patch, task, decision, scan, resubmit, retry, resolve, restart, terminate", async () => {
    const intro = await fastWorkflows();
    try {
      const id = "E021";
      const m = await managerOf(id);
      valid(StartResponse, await api(`/api/cases/${id}/start`, { as: "C01", body: {} }), 202);
      valid(EmployeeProfileSchema, await api(`/api/employees/${id}`, { as: "C01", method: "PATCH", body: { costCenter: "CC-1234" } }));
      await waitForStage(id, "paperwork", "waiting_on_employee");
      for (const t of ["offer_docs", "i9_section1", "w4", "direct_deposit", "emergency_contact", "badge_photo"]) {
        valid(TaskViewSchema, await api(`/api/tasks/chk:${id}:${t}/complete`, { as: id, body: { note: "done" } }));
      }
      const apr = `apr:${id}:manager_approval:1`;
      await waitFor(() => DB.prepare("SELECT 1 AS ok FROM approvals WHERE id = ? AND status = 'pending'").bind(apr).first(), { what: apr });
      expect(valid(ApprovalViewSchema, await api(`/api/approvals/${apr}/decision`, { as: m, body: { decision: "reject", reason: "no" } })).status).toBe("rejected");
      await waitForStage(id, "manager_approval", "revision_requested");
      valid(ScanResponse, await api(`/api/cases/${id}/scan`, { as: "C01", body: {} }));
      const blockers = valid(page(BlockerViewSchema), await api("/api/blockers", { as: "C01" }));
      expect(blockers.items.some((b) => b.kind === "approval_rejected" && b.employeeId === id)).toBe(true);
      const queue = valid(page(ApprovalViewSchema), await api("/api/approvals?status=rejected", { as: "C01" }));
      expect(queue.items.find((a) => a.id === apr)?.resubmittable).toBe(true);
      expect(valid(RoundResponse, await api(`/api/approvals/${apr}/resubmit`, { as: "C01", body: { note: "revised" } }), 202).round).toBe(2);
      await setFault({ system: "it", operation: "create-account", employeeRef: id, fault: "fail_503" });
      const apr2 = `apr:${id}:manager_approval:2`;
      await waitFor(() => DB.prepare("SELECT 1 AS ok FROM approvals WHERE id = ? AND status = 'pending'").bind(apr2).first(), { what: apr2 });
      valid(ApprovalViewSchema, await api(`/api/approvals/${apr2}/decision`, { as: m, body: { decision: "approve" } }));
      await waitForStage(id, "it_provisioning", "blocked");
      const blocker = await waitFor(() => DB.prepare("SELECT id FROM blockers WHERE employee_id = ? AND kind = 'integration_outage' AND status = 'open'").bind(id).first<{ id: string }>(), { what: "outage blocker" });
      expect(valid(BlockerViewSchema, await api(`/api/blockers/${blocker.id}/resolve`, { as: "C03", body: { resolution: "vendor ticket" } })).status).toBe("resolved");
      valid(RoundResponse, await api(`/api/cases/${id}/stages/it_provisioning/retry`, { as: "C03", body: {} }), 202);
      valid(RestartResponse, await api(`/api/cases/${id}/restart`, { as: "A01", body: { reason: "test" } }), 202);
      valid(TerminateResponse, await api(`/api/cases/${id}/terminate`, { as: "A01", body: { reason: "test" } }), 202);
      valid(ErrorEnvelopeSchema, await api(`/api/cases/${id}/terminate`, { as: "A01", body: { reason: "again" } }), 409);
    } finally {
      await intro.dispose();
    }
  });
});

describe("request validation", () => {
  beforeAll(async () => {
    // a real pending approval, so the decision probe reaches body validation instead of a 404
    await DB.prepare(
      `INSERT INTO approvals (id, employee_id, stage_id, checkpoint, round, approver_role, approver_staff_id, status, request_json, requested_at, due_at)
       VALUES ('apr:E022:manager_approval:1', 'E022', 'manager_approval', 'manager_approval', 1, 'manager', (SELECT manager_id FROM employees WHERE id = 'E022'), 'pending', '{}', ?, ?)`,
    )
      .bind(new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString())
      .run();
  });

  it("rejects malformed bodies and queries with 400 and the error envelope", async () => {
    const bad = [
      await api("/api/approvals/apr:E022:manager_approval:1/decision", { as: "A01", body: { decision: "maybe" } }),
      await api("/api/employees/E022", { as: "A01", method: "PATCH", body: { costCenter: "CC-1", photoOnFile: true } }),
      await api("/api/employees/E022", { as: "A01", method: "PATCH", body: { licenseBundle: "gold" } }),
      await api("/api/cases/E022/restart", { as: "A01", body: {} }),
      await api("/api/cases/E022/start", { as: "A01", body: { extra: 1 } }),
      await api("/api/employees?limit=1000", { as: "A01" }),
      await api("/api/blockers?kind=nope", { as: "A01" }),
    ];
    for (const r of bad) expect(valid(ErrorEnvelopeSchema, r, 400).error.code).toBe("invalid_request");
    expect((await api("/api/approvals/apr:E022:manager_approval:9/decision", { as: "A01", body: { decision: "approve" } })).status).toBe(404);
    expect((await api("/api/cases/E022/stages/nope/retry", { as: "A01", body: {} })).status).toBe(404);
    expect((await api("/api/cases/E999/start", { as: "A01", body: {} })).status).toBe(404);
  });

  it("rejects a cursor the server did not issue with 400 invalid_cursor, never a SQL error", async () => {
    const object = btoa('{"a":1}');
    const fraction = btoa("1.5");
    const garbage = "%%%";
    const probes: Array<[string, string]> = [
      [`/api/employees?cursor=${object}`, "C01"],
      [`/api/approvals?cursor=${object}`, "A01"],
      [`/api/blockers?cursor=${object}`, "A01"],
      [`/api/followups?cursor=${object}`, "A01"],
      [`/api/audit?cursor=${object}`, "A01"],
      [`/api/audit?cursor=${fraction}`, "A01"],
      [`/api/cases/E022/audit?cursor=${object}`, "E022"],
      [`/api/cases/E022/integrations?cursor=${btoa('"x"')}`, "A01"],
      [`/api/employees?cursor=${garbage}`, "A01"],
    ];
    for (const [path, as] of probes) {
      const r = await api(path, { as });
      expect(r.status, path).toBe(400);
      expect(valid(ErrorEnvelopeSchema, r, 400).error.code, path).toBe("invalid_cursor");
      expect(JSON.stringify(r.body), path).not.toMatch(/D1_|SQL/);
    }
    // a cursor the server issued still pages
    const first = await api("/api/employees?limit=2", { as: "A01" });
    const next = await api(`/api/employees?limit=2&cursor=${first.body.nextCursor}`, { as: "A01" });
    expect(next.status).toBe(200);
    expect(next.body.items[0].id).toBe("E003");
  });
});
