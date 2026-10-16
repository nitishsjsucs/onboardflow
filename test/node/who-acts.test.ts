import { describe, expect, it } from "vitest";
import { STAGE_STATUSES } from "../../src/shared/domain.ts";
import { STAGE_IDS } from "../../src/shared/stages.ts";
import { stageActor, stageBlockedOwners, waitingStatusAt } from "../../src/shared/who-acts.ts";

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
