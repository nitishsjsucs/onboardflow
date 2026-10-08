import { describe, expect, it } from "vitest";
import {
  CHAOS,
  chaosSchedule,
  coordinatorDecision,
  correctionFor,
  employeePlan,
  FAULTABLE,
  managerPlan,
  newMemory,
} from "../../eval/harness/policies.ts";
import { SCENARIOS } from "../../eval/scenarios/index.ts";
import { generateDataset } from "../../src/shared/synthetic/generate.ts";

const dataset = generateDataset();
const employees = SCENARIOS.map((s) => dataset.employees.find((e) => e.id === s.employeeId)!).map((e) => ({ id: e.id, employmentType: e.employmentType, orgUnit: e.orgUnit }));
const outage = { id: "blk:1", kind: "integration_outage" as const, detail: { operation: "it.order-device" } };

describe("seeded fault schedule", () => {
  it("is deterministic per seed and differs between seeds", () => {
    expect(chaosSchedule(1, employees)).toEqual(chaosSchedule(1, employees));
    expect(JSON.stringify(chaosSchedule(1, employees))).not.toBe(JSON.stringify(chaosSchedule(2, employees)));
  });

  it("draws faults from the committed table with the documented ranges", () => {
    for (const seed of CHAOS.seeds) {
      const s = chaosSchedule(seed, employees);
      // about 30% of the 60 x 9 (employee, operation) pairs
      expect(s.faults.length).toBeGreaterThan(60 * 9 * 0.2);
      expect(s.faults.length).toBeLessThan(60 * 9 * 0.4);
      for (const f of s.faults) {
        if (f.fault === "fail_503") expect(f.remaining).toBeGreaterThanOrEqual(1), expect(f.remaining).toBeLessThanOrEqual(8);
        if (f.fault === "rate_limit_429") expect(f.params?.retryAfterMs).toBeGreaterThanOrEqual(50);
        if (f.fault === "lost_response") expect(f.remaining).toBe(1);
        if (f.fault === "stall") {
          expect(f.remaining).toBeNull();
          expect(f.clearAfterMs).toBeGreaterThanOrEqual(5000);
          expect(f.clearAfterMs).toBeLessThanOrEqual(30_000);
          expect(FAULTABLE.find((x) => x.opId === f.opId && "stallOp" in x)).toBeTruthy();
        }
      }
      expect(s.outages.length).toBeLessThanOrEqual(6);
      for (const o of s.outages) {
        expect(o.durationMs).toBeGreaterThanOrEqual(10_000);
        expect(o.durationMs).toBeLessThanOrEqual(60_000);
      }
      expect(s.clockJumpAtMs).toBeGreaterThanOrEqual(5000);
    }
  });

  it("includes faults beyond the retry budget (fail_503 x5 or more) across the seeds", () => {
    const beyond = CHAOS.seeds.flatMap((seed) => chaosSchedule(seed, employees).faults).filter((f) => f.fault === "fail_503" && (f.remaining ?? 0) >= 5);
    expect(beyond.length).toBeGreaterThan(0);
  });

  it("corrupts validated fields with values the systems reject", () => {
    const all = CHAOS.seeds.flatMap((seed) => chaosSchedule(seed, employees).corruptions);
    for (const c of all) {
      if (c.field === "costCenter") expect(c.value).not.toMatch(/^CC-\d{4}$/);
      if (c.field === "photoOnFile") expect(c.when).toBe("after_paperwork");
    }
  });
});

describe("persona plans", () => {
  it("are deterministic per seed and employee, within the documented ranges", () => {
    expect(employeePlan(3, "E010")).toEqual(employeePlan(3, "E010"));
    expect(managerPlan(3, "E010")).toEqual(managerPlan(3, "E010"));
    for (const e of employees) {
      const p = employeePlan(1, e.id);
      expect(p.delayMs.paperwork).toBeGreaterThanOrEqual(200);
      expect(p.delayMs.paperwork).toBeLessThanOrEqual(3000);
      const m = managerPlan(1, e.id);
      expect(m.rejectFirst && m.neverRespond).toBe(false);
    }
  });
});

describe("coordinator bot", () => {
  it("decides from the blocker, its own memory and the time only (pure)", () => {
    const m = newMemory(0);
    expect(coordinatorDecision(outage, m, 999, { photoDelayMs: 0 })).toEqual({ kind: "wait" });
    expect(coordinatorDecision(outage, m, 1000, { photoDelayMs: 0 })).toEqual({ kind: "retry" });
    expect(coordinatorDecision(outage, { ...m }, 1000, { photoDelayMs: 0 })).toEqual(coordinatorDecision(outage, { ...m }, 1000, { photoDelayMs: 0 }));
  });

  it("backs off 1, 2, 4 s and gives up after 3 retries (patience)", () => {
    expect(coordinatorDecision(outage, { ...newMemory(0), retries: 1, lastRetryMs: 10_000 }, 11_999, { photoDelayMs: 0 })).toEqual({ kind: "wait" });
    expect(coordinatorDecision(outage, { ...newMemory(0), retries: 1, lastRetryMs: 10_000 }, 12_000, { photoDelayMs: 0 })).toEqual({ kind: "retry" });
    expect(coordinatorDecision(outage, { ...newMemory(0), retries: 2, lastRetryMs: 10_000 }, 13_999, { photoDelayMs: 0 })).toEqual({ kind: "wait" });
    expect(coordinatorDecision(outage, { ...newMemory(0), retries: 2, lastRetryMs: 10_000 }, 14_000, { photoDelayMs: 0 })).toEqual({ kind: "retry" });
    expect(coordinatorDecision(outage, { ...newMemory(0), retries: 3, lastRetryMs: 10_000 }, 99_000, { photoDelayMs: 0 })).toEqual({ kind: "give_up" });
    expect(coordinatorDecision(outage, { ...newMemory(0), retries: 3, gaveUp: true }, 99_000, { photoDelayMs: 0 })).toEqual({ kind: "ignore" });
  });

  it("fixes a data issue with the documented correction before retrying", () => {
    const dataIssue = { id: "blk:2", kind: "data_issue" as const, detail: { field: "costCenter" } };
    expect(coordinatorDecision(dataIssue, newMemory(0), 0, { photoDelayMs: 0, correction: "CC-1100" })).toEqual({ kind: "fix", field: "costCenter", value: "CC-1100" });
    expect(coordinatorDecision(dataIssue, { ...newMemory(0), fixed: true }, 1000, { photoDelayMs: 0 })).toEqual({ kind: "retry" });
    const photo = { id: "blk:3", kind: "data_issue" as const, detail: { field: "photoOnFile" } };
    expect(coordinatorDecision(photo, newMemory(0), 0, { photoDelayMs: 5000 })).toEqual({ kind: "request_photo" });
    expect(coordinatorDecision(photo, { ...newMemory(0), photoRequestedMs: 0 }, 4999, { photoDelayMs: 5000 })).toEqual({ kind: "wait" });
    expect(coordinatorDecision(photo, { ...newMemory(0), photoRequestedMs: 0 }, 5000, { photoDelayMs: 5000 })).toEqual({ kind: "fix", field: "photoOnFile", value: true });
  });

  it("leaves other blocker kinds to their personas", () => {
    for (const kind of ["approval_overdue", "employee_task_overdue", "approval_rejected"] as const) {
      expect(coordinatorDecision({ id: "x", kind, detail: {} }, newMemory(0), 10_000, { photoDelayMs: 0 })).toEqual({ kind: "ignore" });
    }
  });

  it("corrects with the modal org-unit cost center and the license policy table", () => {
    expect(correctionFor("costCenter", { employmentType: "full_time", orgUnit: "Sales" }, ["CC-2100", "CC-2100", "CC-9999"])).toBe("CC-2100");
    expect(correctionFor("costCenter", { employmentType: "full_time", orgUnit: "Sales" }, ["CC-2", "CC-1"])).toBe("CC-1");
    expect(correctionFor("licenseBundle", { employmentType: "full_time", orgUnit: "Engineering" }, [])).toBe("ft-engineering");
    expect(correctionFor("licenseBundle", { employmentType: "full_time", orgUnit: "Sales" }, [])).toBe("ft-standard");
    expect(correctionFor("licenseBundle", { employmentType: "contractor", orgUnit: "Sales" }, [])).toBe("contractor-basic");
    expect(correctionFor("licenseBundle", { employmentType: "intern", orgUnit: "Sales" }, [])).toBe("intern-basic");
  });
});
