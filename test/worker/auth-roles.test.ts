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
  const e = await env.DB.prepare("SELECT manager_id FROM employees WHERE id = 'E001'").first<{ manager_id: string }>();
  ids.manager = e!.manager_id;
  const other = await env.DB.prepare("SELECT id FROM staff WHERE kind = 'manager' AND id <> ? ORDER BY id LIMIT 1")
    .bind(ids.manager)
    .first<{ id: string }>();
  ids.otherManager = other!.id;
});

// ---------------------------------------------------------------------------
// Route registry x personas. Every route in API_ROUTES must have a case here,
// so a new route cannot land without its authorization expectations.
// ---------------------------------------------------------------------------
type RouteCase = { path: string; opts?: Omit<CallOptions, "as">; expect: Record<PersonaKey, number> };
const ok = (anon: number, status = 200): Record<PersonaKey, number> => ({
  anon,
  employee: status,
  manager: status,
  otherManager: status,
  coordPeopleOps: status,
  coordIt: status,
  coordFacilities: status,
  admin: status,
});

const ROUTE_CASES: Record<RouteId, RouteCase> = {
  health: { path: "/api/health", expect: ok(200) },
  me: { path: "/api/me", expect: ok(401) },
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
