import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { API_ROUTES, type RouteId } from "../../src/shared/api.ts";
import { CAPABILITIES, PERMISSION_MATRIX, ROLES, type Department, type Role } from "../../src/shared/roles.ts";
import {
  canCompleteTask,
  canDecideApproval,
  canFixField,
  canResubmit,
  canRestartOrTerminate,
  canRetryStage,
  canStartCase,
  canSubscribe,
  canViewCase,
  canViewDashboard,
  canWorkDepartment,
} from "../../src/worker/auth/policy.ts";
import type { Principal } from "../../src/worker/http.ts";
import { call, type CallOptions } from "../helpers/api.ts";

// ---------------------------------------------------------------------------
// Personas: an employee, their manager, a manager of someone else, one
// coordinator per department, and an admin.
// ---------------------------------------------------------------------------
type PersonaKey = "anon" | "employee" | "manager" | "otherManager" | "coordPeopleOps" | "coordIt" | "coordFacilities" | "admin";
const ids: Record<Exclude<PersonaKey, "anon">, string> = {
  employee: "E001",
  manager: "",
  otherManager: "",
  coordPeopleOps: "C01",
  coordIt: "C03",
  coordFacilities: "C05",
  admin: "A01",
};

beforeAll(async () => {
  const DB = env.DB;
  const e = await DB.prepare("SELECT manager_id FROM employees WHERE id = 'E001'").first<{ manager_id: string }>();
  ids.manager = e!.manager_id;
  const other = await DB.prepare("SELECT id FROM staff WHERE kind = 'manager' AND id <> ? ORDER BY id LIMIT 1")
    .bind(ids.manager)
    .first<{ id: string }>();
  ids.otherManager = other!.id;
  // Fixtures in states where an allowed caller reaches the guarded command and gets a clean 409,
  // so the matrix exercises authorization without side effects.
  const now = new Date().toISOString();
  await DB.batch([
    DB.prepare(
      `INSERT INTO approvals (id, employee_id, stage_id, checkpoint, round, approver_role, approver_staff_id, status, request_json, requested_at, due_at, decided_at, decided_by)
       VALUES ('apr:E001:manager_approval:1', 'E001', 'manager_approval', 'manager_approval', 1, 'manager', ?, 'approved', '{}', ?, ?, ?, 'fixture')`,
    ).bind(ids.manager, now, now, now),
    DB.prepare(
      `INSERT INTO blockers (id, employee_id, stage_id, kind, severity, owner_department, subject, dedupe_key, status, detail_json, detected_at, resolved_at)
       VALUES ('blk:fixture', 'E001', 'it_provisioning', 'integration_outage', 'high', 'it', 'it.order-device', 'fixture', 'resolved', '{}', ?, ?)`,
    ).bind(now, now),
    DB.prepare(
      `INSERT INTO tasks (id, employee_id, stage_id, kind, template_key, assignee, title, description, status, created_at, completed_at)
       VALUES ('chk:E001:w4', 'E001', 'paperwork', 'checklist', 'w4', 'employee', 'W-4', 'd', 'done', ?, ?)`,
    ).bind(now, now),
  ]);
});

// ---------------------------------------------------------------------------
// Route registry x personas. Every route in API_ROUTES must have a case here,
// so a new route cannot land without its authorization expectations.
// ---------------------------------------------------------------------------
type RouteCase = { path: string; opts?: Omit<CallOptions, "as">; expect: Record<PersonaKey, number> };
const all = (anon: number, status = 200): Record<PersonaKey, number> => ({
  anon,
  employee: status,
  manager: status,
  otherManager: status,
  coordPeopleOps: status,
  coordIt: status,
  coordFacilities: status,
  admin: status,
});

/** Statuses for everyone except the listed personas, which get their own. */
const only = (allowed: Partial<Record<PersonaKey, number>>, otherwise = 403): Record<PersonaKey, number> => ({ ...all(401, otherwise), ...allowed });
const OPS = { coordPeopleOps: 200, coordIt: 200, coordFacilities: 200, admin: 200 };
const VIEWERS = { employee: 200, manager: 200, coordPeopleOps: 200, coordIt: 200, coordFacilities: 200, admin: 200 };

const ROUTE_CASES: Record<RouteId, RouteCase> = {
  health: { path: "/api/health", expect: all(200) },
  me: { path: "/api/me", expect: all(401) },
  "me.checklist": { path: "/api/me/checklist", expect: only({ employee: 200 }) },
  "employees.list": { path: "/api/employees", expect: only({ manager: 200, otherManager: 200, ...OPS }) },
  "employees.get": { path: "/api/employees/E001", expect: only(VIEWERS) },
  // same value as the seed: an allowed caller applies a no-op correction
  "employees.patch": { path: "/api/employees/E001", opts: { body: { costCenter: "CC-1100" } }, expect: only({ coordPeopleOps: 200, admin: 200 }) },
  // the first allowed start creates the instance, the second converges (202 both)
  "cases.start": { path: "/api/cases/E140/start", opts: { body: {} }, expect: only({ coordPeopleOps: 202, admin: 202 }) },
  "cases.get": { path: "/api/cases/E001", expect: only(VIEWERS) },
  "cases.audit": { path: "/api/cases/E001/audit", expect: only(VIEWERS) },
  "cases.integrations": { path: "/api/cases/E001/integrations", expect: only(OPS) },
  // it_provisioning is owned by IT and not blocked: the owner reaches the guarded 409
  "cases.retry": { path: "/api/cases/E001/stages/it_provisioning/retry", opts: { body: {} }, expect: only({ coordIt: 409, admin: 409 }) },
  "cases.scan": { path: "/api/cases/E001/scan", opts: { body: {} }, expect: only(OPS) },
  "cases.restart": { path: "/api/cases/E001/restart", opts: { body: { reason: "matrix" } }, expect: only({ admin: 409 }) },
  "cases.terminate": { path: "/api/cases/E001/terminate", opts: { body: { reason: "matrix" } }, expect: only({ admin: 409 }) },
  "tasks.complete": { path: "/api/tasks/chk:E001:w4/complete", opts: { body: {} }, expect: only({ employee: 409, admin: 409 }) },
  "approvals.list": { path: "/api/approvals", expect: only({ manager: 200, otherManager: 200, coordPeopleOps: 200, admin: 200 }) },
  "approvals.decision": {
    path: "/api/approvals/apr:E001:manager_approval:1/decision",
    opts: { body: { decision: "approve" } },
    expect: only({ manager: 409, admin: 409 }),
  },
  "approvals.resubmit": { path: "/api/approvals/apr:E001:manager_approval:1/resubmit", opts: { body: { note: "matrix" } }, expect: only({ coordPeopleOps: 409, admin: 409 }) },
  "blockers.list": { path: "/api/blockers", expect: only(OPS) },
  "blockers.resolve": { path: "/api/blockers/blk:fixture/resolve", opts: { body: { resolution: "matrix" } }, expect: only({ coordIt: 409, admin: 409 }) },
  "followups.list": { path: "/api/followups", expect: only(OPS) },
  "dashboard.summary": { path: "/api/dashboard/summary", expect: only(OPS) },
  "integrations.health": { path: "/api/integrations/health", expect: only(OPS) },
  "audit.list": { path: "/api/audit", expect: only({ admin: 200 }) },
};

describe("route registry x roles", () => {
  it("has an authorization case for every registered route", () => {
    expect(Object.keys(ROUTE_CASES).sort()).toEqual(API_ROUTES.map((r) => r.id).sort());
  });

  for (const route of API_ROUTES) {
    it(`${route.method} ${route.path}`, async () => {
      const rc = ROUTE_CASES[route.id];
      for (const [persona, status] of Object.entries(rc.expect) as Array<[PersonaKey, number]>) {
        const as = persona === "anon" ? undefined : ids[persona];
        const res = await call(rc.path, { ...rc.opts, method: route.method, ...(as ? { as } : {}) });
        expect(res.status, `${persona} -> ${route.method} ${rc.path}`).toBe(status);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Pure policy functions against PERMISSION_MATRIX, with ownership and
// department variants.
// ---------------------------------------------------------------------------
const P = (role: Role, extra: Partial<Principal> = {}): Principal => ({ email: `${role}@x.test`, role, displayName: role, ...extra });
const employee = P("employee", { employeeId: "E001" });
const otherEmployee = P("employee", { employeeId: "E002" });
const manager = P("manager", { staffId: "M01" });
const otherManager = P("manager", { staffId: "M02" });
const coord = (department: Department) => P("coordinator", { staffId: "C0x", department });
const admin = P("admin", { staffId: "A01" });
const caseE001 = { employeeId: "E001", managerId: "M01" };

describe("policy functions implement the capability matrix", () => {
  it("covers every capability for exactly the 4 roles", () => {
    for (const cap of CAPABILITIES) expect(Object.keys(PERMISSION_MATRIX[cap]).sort()).toEqual([...ROLES].sort());
  });

  it("view case: own, direct reports, all, all", () => {
    expect(canViewCase(employee, caseE001)).toBe(true);
    expect(canViewCase(otherEmployee, caseE001)).toBe(false);
    expect(canViewCase(manager, caseE001)).toBe(true);
    expect(canViewCase(otherManager, caseE001)).toBe(false);
    expect(canViewCase(coord("it"), caseE001)).toBe(true);
    expect(canViewCase(admin, caseE001)).toBe(true);
  });

  it("complete checklist task: own employee and admin only; follow-ups by owning department and admin", () => {
    const chk = { employeeId: "E001", kind: "checklist" as const, assignee: "employee" as const };
    expect(canCompleteTask(employee, chk)).toBe(true);
    expect(canCompleteTask(otherEmployee, chk)).toBe(false);
    expect(canCompleteTask(manager, chk)).toBe(false);
    expect(canCompleteTask(coord("people_ops"), chk)).toBe(false);
    expect(canCompleteTask(admin, chk)).toBe(true);
    const fu = { employeeId: "E001", kind: "followup" as const, assignee: "it" as const };
    expect(canCompleteTask(coord("it"), fu)).toBe(true);
    expect(canCompleteTask(coord("facilities"), fu)).toBe(false);
    expect(canCompleteTask(employee, fu)).toBe(false);
    expect(canCompleteTask(manager, fu)).toBe(false);
    expect(canCompleteTask(admin, fu)).toBe(true);
  });

  it("start case: People Ops coordinators and admins", () => {
    expect([employee, manager, coord("people_ops"), coord("it"), coord("facilities"), admin].map(canStartCase)).toEqual([
      false,
      false,
      true,
      false,
      false,
      true,
    ]);
  });

  it("decide manager approval: the assigned manager, or an admin on behalf", () => {
    const a = { checkpoint: "manager_approval" as const, approverStaffId: "M01" };
    expect(canDecideApproval(manager, a)).toEqual({ allowed: true });
    expect(canDecideApproval(otherManager, a).allowed).toBe(false);
    expect(canDecideApproval(employee, a).allowed).toBe(false);
    expect(canDecideApproval(coord("people_ops"), a).allowed).toBe(false);
    expect(canDecideApproval(admin, a)).toEqual({ allowed: true, onBehalfOf: "M01" });
  });

  it("decide closeout: People Ops coordinators, or an admin on behalf", () => {
    const a = { checkpoint: "closeout" as const, approverStaffId: null };
    expect(canDecideApproval(coord("people_ops"), a)).toEqual({ allowed: true });
    expect(canDecideApproval(coord("it"), a).allowed).toBe(false);
    expect(canDecideApproval(manager, a).allowed).toBe(false);
    expect(canDecideApproval(employee, a).allowed).toBe(false);
    expect(canDecideApproval(admin, a)).toEqual({ allowed: true, onBehalfOf: "people_ops" });
  });

  it("resubmit: People Ops coordinators and admins", () => {
    expect([employee, manager, coord("people_ops"), coord("it"), admin].map(canResubmit)).toEqual([false, false, true, false, true]);
  });

  it("work follow-ups and blockers: own department; admin all", () => {
    expect(canWorkDepartment(coord("facilities"), "facilities")).toBe(true);
    expect(canWorkDepartment(coord("facilities"), "it")).toBe(false);
    expect(canWorkDepartment(admin, "it")).toBe(true);
    expect(canWorkDepartment(manager, "people_ops")).toBe(false);
    expect(canWorkDepartment(employee, "people_ops")).toBe(false);
  });

  it("retry stage: the owning department; admin all", () => {
    expect(canRetryStage(coord("it"), "it")).toBe(true);
    expect(canRetryStage(coord("people_ops"), "it")).toBe(false);
    expect(canRetryStage(admin, "facilities")).toBe(true);
    expect(canRetryStage(manager, "it")).toBe(false);
    expect(canRetryStage(employee, "it")).toBe(false);
  });

  it("fix profile field: the field owner department; admin all", () => {
    expect(canFixField(coord("people_ops"), "costCenter")).toBe(true);
    expect(canFixField(coord("it"), "costCenter")).toBe(false);
    expect(canFixField(coord("it"), "licenseBundle")).toBe(true);
    expect(canFixField(coord("facilities"), "photoOnFile")).toBe(true);
    expect(canFixField(admin, "photoOnFile")).toBe(true);
    expect(canFixField(manager, "costCenter")).toBe(false);
  });

  it("restart or terminate: admin only; dashboard: coordinators and admins", () => {
    expect([employee, manager, coord("people_ops"), admin].map(canRestartOrTerminate)).toEqual([false, false, false, true]);
    expect([employee, manager, coord("it"), admin].map(canViewDashboard)).toEqual([false, false, true, true]);
  });

  it("subscriptions: CASE_AGENT own, reports, coordinators, admins; OPS_HUB_AGENT coordinators and admins", () => {
    expect(canSubscribe(employee, "CASE_AGENT", "E001", caseE001)).toBe(true);
    expect(canSubscribe(otherEmployee, "CASE_AGENT", "E001", caseE001)).toBe(false);
    expect(canSubscribe(manager, "CASE_AGENT", "E001", caseE001)).toBe(true);
    expect(canSubscribe(otherManager, "CASE_AGENT", "E001", caseE001)).toBe(false);
    expect(canSubscribe(coord("it"), "CASE_AGENT", "E001", caseE001)).toBe(true);
    expect(canSubscribe(admin, "CASE_AGENT", "E001", caseE001)).toBe(true);
    expect(canSubscribe(admin, "CASE_AGENT", "E999x", caseE001)).toBe(false);
    expect(canSubscribe(admin, "CASE_AGENT", "E001", undefined)).toBe(false);
    expect(canSubscribe(employee, "OPS_HUB_AGENT", "global")).toBe(false);
    expect(canSubscribe(manager, "OPS_HUB_AGENT", "global")).toBe(false);
    expect(canSubscribe(coord("facilities"), "OPS_HUB_AGENT", "global")).toBe(true);
    expect(canSubscribe(admin, "OPS_HUB_AGENT", "global")).toBe(true);
    expect(canSubscribe(admin, "OPS_HUB_AGENT", "other")).toBe(false);
    expect(canSubscribe(admin, "SOMETHING_ELSE", "global")).toBe(false);
  });
});

describe("exactly four roles", () => {
  it("in ROLES, the D1 CHECK on app_users.role, and the permission matrix", async () => {
    expect(ROLES).toEqual(["employee", "manager", "coordinator", "admin"]);
    const row = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE name = 'app_users'").first<{ sql: string }>();
    const m = /role IN \(([^)]*)\)/.exec(row!.sql);
    const checkRoles = m![1]!.split(",").map((s) => s.trim().replace(/'/g, ""));
    expect(checkRoles.sort()).toEqual([...ROLES].sort());
    const matrixRoles = new Set(Object.values(PERMISSION_MATRIX).flatMap((r) => Object.keys(r)));
    expect([...matrixRoles].sort()).toEqual([...ROLES].sort());
  });
});

describe("principal loading fails closed on inconsistent accounts", () => {
  beforeAll(async () => {
    // app_users.role is not tied to staff.kind by the schema; these accounts pass every CHECK
    await env.DB.batch([
      env.DB.prepare("INSERT INTO staff (id, email, display_name, kind, department, org_unit) VALUES ('PX1', 'px1@onboardflow.test', 'Fixture Admin Row', 'admin', NULL, NULL)"),
      env.DB.prepare("INSERT INTO staff (id, email, display_name, kind, department, org_unit) VALUES ('PX2', 'px2@onboardflow.test', 'Fixture Manager Row', 'manager', NULL, 'Engineering')"),
      env.DB.prepare("INSERT INTO app_users (email, role, staff_id) VALUES ('px1@onboardflow.test', 'coordinator', 'PX1')"),
      env.DB.prepare("INSERT INTO app_users (email, role, staff_id) VALUES ('px2@onboardflow.test', 'admin', 'PX2')"),
    ]);
  });

  it("refuses a coordinator account whose staff row has no department, instead of showing every department's queue", async () => {
    for (const path of ["/api/blockers?status=all", "/api/followups?status=all", "/api/me"]) {
      const r = await call(path, { as: "px1@onboardflow.test" });
      expect(r.status, path).toBe(403);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("not_provisioned");
    }
  });

  it("refuses a role that does not match the staff row's kind", async () => {
    expect((await call("/api/audit", { as: "px2@onboardflow.test" })).status).toBe(403);
  });

  it("still loads consistent accounts", async () => {
    expect((await call("/api/blockers", { as: "C03" })).status).toBe(200);
    expect((await call("/api/audit", { as: "A01" })).status).toBe(200);
  });
});
