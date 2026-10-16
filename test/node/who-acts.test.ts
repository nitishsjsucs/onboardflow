import { describe, expect, it } from "vitest";
import { STAGE_STATUSES } from "../../src/shared/domain.ts";
import { STAGE_IDS } from "../../src/shared/stages.ts";
import { blockedOwnersAt, blockingBlocker, stageActor, stageBlockedOwners, waitingStatusAt } from "../../src/shared/who-acts.ts";

describe("stageBlockedOwners", () => {
  it("names the departments that own the simulated systems each stage calls", () => {
    expect(Object.fromEntries(STAGE_IDS.map((s) => [s, stageBlockedOwners(s)]))).toEqual({
      intake: ["people_ops"],
      paperwork: ["people_ops"],
      // the checkpoint calls no system: a revision there is People Ops'
      manager_approval: ["people_ops"],
      it_provisioning: ["it"],
      facilities_setup: ["facilities"],
      provisioning_verification: ["people_ops", "it", "facilities"],
      orientation: ["people_ops"],
      closeout: ["people_ops"],
    });
  });
});

describe("stageActor", () => {
  it("maps every stage status at a stage of each gate type", () => {
    // auto (an operation stage), employee_tasks, approval (manager), approval (People Ops)
    const table = Object.fromEntries(
      (["it_provisioning", "paperwork", "manager_approval", "closeout"] as const).map((stage) => [stage, Object.fromEntries(STAGE_STATUSES.map((st) => [st, stageActor(stage, st)]))]),
    );
    expect(table.it_provisioning).toEqual({
      pending: { kind: "nobody" },
      active: { kind: "workflow" },
      waiting_on_employee: { kind: "employee" },
      awaiting_approval: { kind: "department", departments: ["people_ops"] },
      revision_requested: { kind: "department", departments: ["people_ops"] },
      blocked: { kind: "department", departments: ["it"] },
      complete: { kind: "nobody" },
      failed: { kind: "admin" },
    });
    expect(table.paperwork!.waiting_on_employee).toEqual({ kind: "employee" });
    expect(table.paperwork!.blocked).toEqual({ kind: "department", departments: ["people_ops"] });
    expect(table.manager_approval!.awaiting_approval).toEqual({ kind: "manager" });
    expect(table.manager_approval!.revision_requested).toEqual({ kind: "department", departments: ["people_ops"] });
    expect(table.closeout!.awaiting_approval).toEqual({ kind: "department", departments: ["people_ops"] });
    expect(table.closeout!.revision_requested).toEqual({ kind: "department", departments: ["people_ops"] });
  });

  it("prefers the open blocker's owner over the stage's default", () => {
    expect(stageActor("provisioning_verification", "blocked")).toEqual({ kind: "department", departments: ["people_ops", "it", "facilities"] });
    expect(stageActor("provisioning_verification", "blocked", "people_ops")).toEqual({ kind: "department", departments: ["people_ops"] });
    expect(stageActor("it_provisioning", "blocked", null)).toEqual({ kind: "department", departments: ["it"] });
  });

  it("reads the hub's waiting count as a revision at checkpoints and the employee's checklist elsewhere", () => {
    expect(waitingStatusAt("manager_approval")).toBe("revision_requested");
    expect(waitingStatusAt("closeout")).toBe("revision_requested");
    expect(waitingStatusAt("paperwork")).toBe("waiting_on_employee");
    expect(waitingStatusAt("orientation")).toBe("waiting_on_employee");
  });
});

describe("blockingBlocker", () => {
  const b = (id: string, kind: "integration_outage" | "data_issue" | "employee_task_overdue", detectedAt: string) => ({ id, kind, detectedAt });

  it("picks a data issue first, else the earliest detected, then the lowest id", () => {
    const outage = b("blk:E046:integration_outage:x:1", "integration_outage", "2026-10-08T10:00:00.000Z");
    const later = b("blk:E046:employee_task_overdue:x:2", "employee_task_overdue", "2026-10-08T11:00:00.000Z");
    const data = b("blk:E046:data_issue:x:3", "data_issue", "2026-10-08T12:00:00.000Z");
    expect(blockingBlocker([later, outage])).toBe(outage);
    expect(blockingBlocker([outage, later, data])).toBe(data);
    // same time: by id, in byte order as SQLite compares them ("B" sorts before "a")
    const upper = b("blk:B", "integration_outage", outage.detectedAt);
    const lower = b("blk:a", "integration_outage", outage.detectedAt);
    expect(blockingBlocker([lower, upper])).toBe(upper);
    expect(blockingBlocker([])).toBeNull();
  });
});

describe("blockedOwnersAt", () => {
  it("names the owners of the blockers when every blocked case has one, each acting on its own cases", () => {
    // the demo's cross-system check: 3 cases held by an HR get-worker outage, so People Ops acts
    expect(blockedOwnersAt("provisioning_verification", 3, { people_ops: 3, it: 0, facilities: 0 })).toEqual({ departments: ["people_ops"], exact: true });
    expect(blockedOwnersAt("it_provisioning", 3, { people_ops: 1, it: 2, facilities: 0 })).toEqual({ departments: ["people_ops", "it"], exact: true });
  });

  it("falls back to the stage's structural owners while a blocked case has no open blocker, or the hub state predates the counts", () => {
    expect(blockedOwnersAt("provisioning_verification", 3, undefined)).toEqual({ departments: ["people_ops", "it", "facilities"], exact: false });
    expect(blockedOwnersAt("it_provisioning", 2, { people_ops: 0, it: 0, facilities: 0 })).toEqual({ departments: ["it"], exact: false });
    // one of three has no blocker yet: the known owner and the stage's owners, "one of them"
    expect(blockedOwnersAt("it_provisioning", 3, { people_ops: 2, it: 0, facilities: 0 })).toEqual({ departments: ["people_ops", "it"], exact: false });
  });
});
