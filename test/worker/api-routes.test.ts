import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  ApprovalViewSchema,
  AuditEventViewSchema,
  ChangesSchema,
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
  StartReadinessSchema,
  StartResponse,
  TaskViewSchema,
  TerminateResponse,
} from "../../src/shared/api.ts";
import type { CaseStatus, StageStatus } from "../../src/shared/domain.ts";
import { READINESS_KEYS, readinessClass, weekStart } from "../../src/shared/readiness.ts";
import type { StageId } from "../../src/shared/stages.ts";
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
  it("me: the recovery limits only for coordinators and admins", async () => {
    for (const as of ["C01", "C03", "C05", "A01"]) {
      const me = valid(Me, await api("/api/me", { as }));
      expect(me.limits, as).toEqual({ maxStageRounds: 4, maxRecoveryRounds: 6 });
    }
    for (const as of [DONE, manager]) {
      const res = await api("/api/me", { as });
      expect(valid(Me, res).limits, as).toBeUndefined();
      expect(Object.keys(res.body as object)).not.toContain("limits");
    }
  });

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
    // status=open: started and not finished, as the dashboard's stage funnel counts them. A complete case keeps
    // its last stage, so it is in stage=closeout but not in its open cases.
    expect(valid(page(EmployeeSummarySchema), await api("/api/employees?stage=closeout", { as: "C01" })).items.map((e) => e.id)).toContain(DONE);
    const OPEN = "E021";
    const before = await DB.prepare("SELECT status, current_stage FROM cases WHERE employee_id = ?").bind(OPEN).first<{ status: string; current_stage: string | null }>();
    try {
      await DB.prepare("UPDATE cases SET status = 'awaiting_approval', current_stage = 'closeout' WHERE employee_id = ?").bind(OPEN).run();
      const open = valid(page(EmployeeSummarySchema), await api("/api/employees?stage=closeout&status=open", { as: "C01" }));
      expect(open.items.map((e) => e.id)).toEqual([OPEN]);
      const anyStage = valid(page(EmployeeSummarySchema), await api("/api/employees?status=open&limit=100", { as: "A01" }));
      expect(anyStage.items.every((e) => ["in_progress", "blocked", "awaiting_approval"].includes(e.caseStatus))).toBe(true);
      expect(anyStage.items.map((e) => e.id)).toContain(OPEN);
    } finally {
      await DB.prepare("UPDATE cases SET status = ?, current_stage = ? WHERE employee_id = ?").bind(before!.status, before!.current_stage, OPEN).run();
    }
    expect((await api("/api/employees?status=bogus", { as: "C01" })).status).toBe(400);
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
    const all = valid(page(ApprovalViewSchema), await api("/api/approvals?status=all", { as: "A01" }));
    // round history is only for rounds after the first
    expect(all.items.filter((a) => a.round === 1).every((a) => a.previousRound === undefined)).toBe(true);
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
      const rejectedBlocker = blockers.items.find((b) => b.kind === "approval_rejected" && b.employeeId === id);
      // each blocker carries its stage's current status and round, for the queue's stage line
      expect([rejectedBlocker?.stageStatus, rejectedBlocker?.stageRound]).toEqual(["revision_requested", 1]);
      const queue = valid(page(ApprovalViewSchema), await api("/api/approvals?status=rejected", { as: "C01" }));
      expect(queue.items.find((a) => a.id === apr)?.resubmittable).toBe(true);
      expect(valid(RoundResponse, await api(`/api/approvals/${apr}/resubmit`, { as: "C01", body: { note: "revised" } }), 202).round).toBe(2);
      await setFault({ system: "it", operation: "create-account", employeeRef: id, fault: "fail_503" });
      const apr2 = `apr:${id}:manager_approval:2`;
      await waitFor(() => DB.prepare("SELECT 1 AS ok FROM approvals WHERE id = ? AND status = 'pending'").bind(apr2).first(), { what: apr2 });
      // the round-2 card carries the round-1 rejection reason and the note People Ops resubmitted with
      const round2 = valid(page(ApprovalViewSchema), await api("/api/approvals", { as: m })).items.find((a) => a.id === apr2);
      expect(round2?.previousRound).toEqual({ round: 1, reason: "no", note: "revised" });
      valid(ApprovalViewSchema, await api(`/api/approvals/${apr2}/decision`, { as: m, body: { decision: "approve" } }));
      await waitForStage(id, "it_provisioning", "blocked");
      const blocker = await waitFor(() => DB.prepare("SELECT id FROM blockers WHERE employee_id = ? AND kind = 'integration_outage' AND status = 'open'").bind(id).first<{ id: string }>(), { what: "outage blocker" });
      const outage = valid(page(BlockerViewSchema), await api("/api/blockers?kind=integration_outage", { as: "C03" })).items.find((b) => b.id === blocker.id);
      expect([outage?.stageStatus, outage?.stageRound]).toEqual(["blocked", 1]);
      expect(valid(BlockerViewSchema, await api(`/api/blockers/${blocker.id}/resolve`, { as: "C03", body: { resolution: "vendor ticket" } })).status).toBe("resolved");
      valid(RoundResponse, await api(`/api/cases/${id}/stages/it_provisioning/retry`, { as: "C03", body: {} }), 202);
      const retried = valid(page(BlockerViewSchema), await api("/api/blockers?status=resolved&kind=integration_outage", { as: "C03" })).items.find((b) => b.id === blocker.id);
      // the retry advanced the stage's round; with the outage still injected it may already be blocked again
      expect(retried?.stageRound).toBe(2);
      expect(["active", "blocked"]).toContain(retried?.stageStatus);
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

describe("readiness by start week", () => {
  type Saved = { id: string; start_date: string; status: string; current_stage: string | null };
  /** Puts cases in the given states for the test, and restores them afterwards. */
  async function withCases(changes: Array<{ id: string; startDate?: string; status: string; stage: string | null }>, run: () => Promise<void>) {
    const ids = changes.map((x) => x.id);
    const saved = await DB.prepare(
      `SELECT e.id, e.start_date, c.status, c.current_stage FROM employees e JOIN cases c ON c.employee_id = e.id WHERE e.id IN (${ids.map(() => "?").join(", ")})`,
    )
      .bind(...ids)
      .all<Saved>();
    try {
      for (const x of changes) {
        if (x.startDate) await DB.prepare("UPDATE employees SET start_date = ? WHERE id = ?").bind(x.startDate, x.id).run();
        await DB.prepare("UPDATE cases SET status = ?, current_stage = ? WHERE employee_id = ?").bind(x.status, x.stage, x.id).run();
      }
      await run();
    } finally {
      for (const r of saved.results) {
        await DB.prepare("UPDATE employees SET start_date = ? WHERE id = ?").bind(r.start_date, r.id).run();
        await DB.prepare("UPDATE cases SET status = ?, current_stage = ? WHERE employee_id = ?").bind(r.status, r.current_stage, r.id).run();
      }
    }
  }

  it("counts everyone starting in the window by week, on the server's clock", async () => {
    const r = valid(StartReadinessSchema, await api("/api/dashboard/start-readiness?weeks=26", { as: "C01" }));
    // the tests pin the simulated clock to 2026-10-08, a Thursday
    expect(r.asOf).toBe("2026-10-08");
    expect(r.weeks[0]!.weekStart).toBe("2026-10-05");
    expect(r.weeks).toHaveLength(27);
    expect(r.alreadyStarted).toBeNull();
    expect(r.weeks.reduce((a, w) => a + w.total, 0)).toBe(150);
    const nov2 = r.weeks.find((w) => w.weekStart === "2026-11-02")!;
    expect(nov2.total).toBe(15);
    // weeks without start dates are listed with zeros
    expect(r.weeks.find((w) => w.weekStart === "2026-10-12")).toEqual({ weekStart: "2026-10-12", total: 0, ready: 0, blocked: 0, waiting: 0, inSetup: 0, notStarted: 0, failed: 0 });
    // every count equals a direct count per employee (one row each, classed by the same rule)
    const people = await DB.prepare(
      `SELECT e.start_date, c.status, c.current_stage, cs.status AS stage_status FROM employees e JOIN cases c ON c.employee_id = e.id
         LEFT JOIN case_stages cs ON cs.employee_id = e.id AND cs.stage_id = c.current_stage`,
    ).all<{ start_date: string; status: CaseStatus; current_stage: StageId | null; stage_status: StageStatus | null }>();
    const expected = new Map<string, Record<string, number>>();
    for (const p of people.results) {
      const w = expected.get(weekStart(p.start_date)) ?? { total: 0, ready: 0, blocked: 0, waiting: 0, inSetup: 0, notStarted: 0, failed: 0 };
      w.total! += 1;
      w[READINESS_KEYS[readinessClass(p.status, p.current_stage, p.stage_status)]]! += 1;
      expected.set(weekStart(p.start_date), w);
    }
    for (const w of r.weeks.filter((x) => x.total > 0)) expect({ weekStart: w.weekStart, ...expected.get(w.weekStart) }).toEqual(w);
    // DONE (E020) is complete, so its week counts it as ready
    expect(r.weeks.find((w) => w.weekStart === "2026-12-28")!.ready).toBeGreaterThanOrEqual(1);
    // the default window is 12 weeks: the cohort of 2027-01-04 is past it
    const twelve = valid(StartReadinessSchema, await api("/api/dashboard/start-readiness", { as: "A01" }));
    expect(twelve.weeks.map((w) => w.weekStart).at(-1)).toBe("2026-12-28");
    expect(twelve.weeks.reduce((a, w) => a + w.total, 0)).toBe(135);
  });

  it("classes started cases with several start dates, and lists the already started apart", async () => {
    await withCases(
      [
        { id: "E031", startDate: "2026-11-03", status: "blocked", stage: "it_provisioning" },
        { id: "E032", startDate: "2026-11-04", status: "awaiting_approval", stage: "manager_approval" },
        { id: "E033", startDate: "2026-11-05", status: "in_progress", stage: "facilities_setup" },
        { id: "E034", startDate: "2026-11-06", status: "in_progress", stage: "orientation" },
        { id: "E035", startDate: "2026-11-07", status: "failed", stage: "intake" },
        { id: "E036", startDate: "2026-10-01", status: "blocked", stage: "intake" },
        { id: "E037", startDate: "2026-10-02", status: "awaiting_approval", stage: "closeout" },
        { id: "E038", startDate: "2026-10-02", status: "complete", stage: "closeout" },
      ],
      async () => {
        const r = valid(StartReadinessSchema, await api("/api/dashboard/start-readiness?weeks=26", { as: "C03" }));
        const nov2 = r.weeks.find((w) => w.weekStart === "2026-11-02")!;
        const before = await DB.prepare("SELECT COUNT(*) AS n FROM employees WHERE start_date BETWEEN '2026-11-02' AND '2026-11-08'").first<{ n: number }>();
        expect(nov2.total).toBe(before!.n);
        expect({ blocked: nov2.blocked, waiting: nov2.waiting, inSetup: nov2.inSetup, failed: nov2.failed, ready: nov2.ready }).toEqual({ blocked: 1, waiting: 1, inSetup: 1, failed: 1, ready: 1 });
        expect(nov2.notStarted).toBe(nov2.total - 5);
        // started before today and not finished: the complete one (E038) is left out
        expect(r.alreadyStarted).toEqual({ total: 2, ready: 1, blocked: 1, waiting: 0, inSetup: 0, notStarted: 0, failed: 0 });
      },
    );
  });

  it("validates the number of weeks", async () => {
    for (const w of ["0", "27", "1.5", "x"]) expect((await api(`/api/dashboard/start-readiness?weeks=${w}`, { as: "A01" })).status, w).toBe(400);
    expect((await api("/api/dashboard/start-readiness?weeks=1", { as: "A01" })).status).toBe(200);
    const res = await api("/api/dashboard/start-readiness", { as: "A01" });
    expect(res.headers.get("Cache-Control")).toBeNull();
  });

  it("filters the employees list by start date range, both ends inclusive", async () => {
    const week = valid(page(EmployeeSummarySchema), await api("/api/employees?startFrom=2026-11-02&startTo=2026-11-08&limit=100", { as: "C01" }));
    expect(week.items).toHaveLength(15);
    expect(week.items.every((e) => e.startDate === "2026-11-02")).toBe(true);
    const one = valid(page(EmployeeSummarySchema), await api("/api/employees?startFrom=2026-11-09&startTo=2026-11-09&limit=100", { as: "C01" }));
    expect(one.items.every((e) => e.startDate === "2026-11-09")).toBe(true);
    expect(one.items).toHaveLength(15);
    const blockedEarly = valid(page(EmployeeSummarySchema), await api("/api/employees?status=blocked&startTo=2026-11-01", { as: "C01" }));
    expect(blockedEarly.items).toEqual([]);
    // a manager still sees only their reports inside the range
    const mine = valid(page(EmployeeSummarySchema), await api("/api/employees?startFrom=2026-11-02&startTo=2027-01-10&limit=100", { as: manager }));
    expect(mine.items.every((e) => e.managerId === manager)).toBe(true);
    for (const bad of ["2026-11-2", "2026-02-31", "Nov 2", "2026-11-02T00:00:00Z"]) {
      expect((await api(`/api/employees?startFrom=${encodeURIComponent(bad)}`, { as: "C01" })).status, bad).toBe(400);
    }
  });
});

describe("what changed (dashboard feed)", () => {
  let n = 0;
  /** Appends an audit row for E077 (a fixture: the triggers allow inserts only). */
  async function audit(action: string, detail: Record<string, unknown>, over: { stageId?: string | null; round?: number | null; entityId?: string; actorId?: string } = {}) {
    n++;
    await DB.prepare(
      `INSERT INTO audit_events (id, occurred_at, actor_type, actor_id, action, entity_type, entity_id, employee_id, stage_id, round, detail_json)
       VALUES (?, ?, 'user', ?, ?, 'fixture', ?, 'E077', ?, ?, ?)`,
    )
      .bind(`fixture:changes:${n}`, new Date(Date.UTC(2026, 9, 8, 13, n)).toISOString(), over.actorId ?? "c01.someone@onboardflow.test", action, over.entityId ?? `fixture-${n}`, over.stageId ?? null, over.round ?? null, JSON.stringify(detail))
      .run();
  }

  it("lists the latest case events in seq order, with only whitelisted detail", async () => {
    await audit("integration.call", { system: "it" });
    await audit("stage.blocked", { class: "retryable", system: "it", operation: "it.create-account", httpStatus: 503, message: "service unavailable", round: 2, field: "x", reason: "contact ops@example.com" }, { stageId: "it_provisioning", round: 2 });
    await audit("stage.retry_requested", { note: "called the vendor, see jo@example.com", newRound: 3 }, { stageId: "it_provisioning", round: 3 });
    await audit("approval.rejected", { decision: "rejected", reason: "wrong laptop, ask Sam", onBehalfOf: "M01", privilegedAccessApproved: null }, { stageId: "manager_approval", round: 1 });
    await audit("approval.resubmitted", { note: "fixed the laptop", newRound: 2 }, { stageId: "manager_approval", round: 2 });
    await audit("blocker.opened", { kind: "integration_outage", ownerDepartment: "it", subject: "it.create-account", severity: "high" }, { stageId: "it_provisioning" });
    await audit("blocker.opened", { kind: "approval_overdue", ownerDepartment: "people_ops", subject: "apr:E077:closeout:1", severity: "medium" }, { stageId: "closeout" });
    await audit("blocker.auto_resolved", { kind: "integration_outage", reason: "operation_succeeded" }, { entityId: "blk:E077:integration_outage:it_provisioning:it.create-account:1791460804422" });
    await audit("provisioning.updated", { status: "active" });
    await audit("task.completed", {});
    await audit("dev.login", {});
    await audit("case.failed", { failureReason: "recovery_rounds_exhausted", operation: "it.create-account", reason: "HTTP 503 from it" }, { stageId: "it_provisioning" });

    const r = valid(ChangesSchema, await api("/api/dashboard/changes?limit=30", { as: "C05" }));
    expect(r.items.length).toBeGreaterThan(0);
    // newest first, merged across actions by seq
    expect(r.items.map((i) => i.seq)).toEqual([...r.items.map((i) => i.seq)].sort((a, b) => b - a));
    // the noise actions never appear
    expect(r.items.some((i) => ["integration.call", "provisioning.updated", "task.completed", "dev.login"].includes(i.action))).toBe(false);
    const mine = r.items.filter((i) => i.employeeId === "E077");
    expect(mine.map((i) => i.action)).toEqual(["case.failed", "blocker.auto_resolved", "blocker.opened", "approval.resubmitted", "approval.rejected", "stage.retry_requested", "stage.blocked"]);
    expect(mine.every((i) => i.employeeName.length > 0)).toBe(true);
    const by = (a: string) => mine.find((i) => i.action === a)!;
    expect(by("stage.blocked")).toMatchObject({ stageId: "it_provisioning", round: 2, detail: { system: "it", operation: "it.create-account", httpStatus: 503, message: "service unavailable", round: 2 } });
    expect(by("stage.retry_requested").detail).toEqual({});
    expect(by("approval.rejected").detail).toEqual({ onBehalfOf: "M01", checkpoint: "manager_approval" });
    expect(by("approval.resubmitted")).toMatchObject({ round: 2, detail: { checkpoint: "manager_approval" } });
    // only the approval and checklist kinds of blocker.opened: an outage repeats stage.blocked
    expect(by("blocker.opened").detail).toEqual({ kind: "approval_overdue", checkpoint: "closeout" });
    expect(by("blocker.auto_resolved")).toMatchObject({ stageId: "it_provisioning", detail: { kind: "integration_outage" } });
    expect(by("case.failed").detail).toEqual({ failureReason: "recovery_rounds_exhausted", operation: "it.create-account" });
    // no reason, note, field or email reaches the response
    const text = JSON.stringify(r);
    for (const secret of ["wrong laptop", "fixed the laptop", "called the vendor", "@", "HTTP 503 from it", "operation_succeeded", "privilegedAccessApproved", "ownerDepartment", "subject"]) expect(text, secret).not.toContain(secret);
  });

  it("bounds the limit", async () => {
    for (const l of ["0", "31", "x"]) expect((await api(`/api/dashboard/changes?limit=${l}`, { as: "A01" })).status, l).toBe(400);
    const two = valid(ChangesSchema, await api("/api/dashboard/changes?limit=2", { as: "A01" }));
    expect(two.items).toHaveLength(2);
    const dflt = valid(ChangesSchema, await api("/api/dashboard/changes", { as: "C03" }));
    expect(dflt.items.length).toBeLessThanOrEqual(15);
  });
});
