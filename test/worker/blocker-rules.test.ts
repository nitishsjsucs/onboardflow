import { describe, expect, it } from "vitest";
import { detectBlockers, nudgeTargets, ownerFor, resolvedBlockers, type ScanSnapshot } from "../../src/worker/agents/blocker-rules.ts";
import { STAGE_IDS, type StageId } from "../../src/shared/stages.ts";

const T0 = Date.parse("2026-11-01T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function snap(over: Partial<ScanSnapshot> = {}, stages: Partial<Record<StageId, Partial<ScanSnapshot["stages"][number]>>> = {}): ScanSnapshot {
  return {
    employeeId: "E001",
    employeeName: "Test Person",
    caseStatus: "in_progress",
    stages: STAGE_IDS.map((id) => ({ id, status: "pending", round: 1, blockedReason: null, lastWakeAt: null, ...(stages[id] ?? {}) })),
    approvals: [],
    openChecklist: [],
    checklistProgress: [],
    provisioning: [],
    successes: [],
    openBlockers: [],
    ...over,
  };
}

describe("detectBlockers: the six kinds", () => {
  it("integration_outage from a retryable block, owned by the system's department", () => {
    const s = snap({}, { it_provisioning: { status: "blocked", blockedReason: { class: "retryable", system: "it", operation: "it.order-device", httpStatus: 503, round: 1 } } });
    expect(detectBlockers(s, T0)).toEqual([
      expect.objectContaining({ kind: "integration_outage", stageId: "it_provisioning", subject: "it.order-device", ownerDepartment: "it", severity: "high", dedupeKey: "E001:integration_outage:it_provisioning:it.order-device" }),
    ]);
    const hr = snap({}, { intake: { status: "blocked", blockedReason: { class: "retryable", system: "hr", operation: "hr.create-worker", round: 1 } } });
    expect(detectBlockers(hr, T0)[0]?.ownerDepartment).toBe("people_ops");
  });

  it("data_issue from a fatal 4xx, owned by the field owner", () => {
    for (const [field, owner, op, stage] of [
      ["costCenter", "people_ops", "hr.create-worker", "intake"],
      ["licenseBundle", "it", "it.assign-licenses", "it_provisioning"],
      ["photoOnFile", "facilities", "facilities.issue-badge", "facilities_setup"],
    ] as const) {
      const s = snap({}, { [stage]: { status: "blocked", blockedReason: { class: "fatal", operation: op, httpStatus: 422, field, round: 1 } } });
      expect(detectBlockers(s, T0)).toEqual([expect.objectContaining({ kind: "data_issue", ownerDepartment: owner, subject: op })]);
    }
    // an unknown field falls back to the system owner
    expect(ownerFor("data_issue", { class: "fatal", operation: "facilities.issue-badge", field: "sessionDate" })).toBe("facilities");
  });

  it("provisioning_stalled from a stalled poll", () => {
    const s = snap({}, { facilities_setup: { status: "blocked", blockedReason: { class: "stalled", operation: "facilities.issue-badge", system: "facilities", round: 1 } } });
    expect(detectBlockers(s, T0)).toEqual([expect.objectContaining({ kind: "provisioning_stalled", ownerDepartment: "facilities", severity: "medium" })]);
  });

  it("approval_overdue only once the due time passed (simulated clock), owned by People Ops", () => {
    const s = snap(
      { approvals: [{ id: "apr:E001:manager_approval:1", stageId: "manager_approval", checkpoint: "manager_approval", round: 1, status: "pending", dueAt: iso(T0 + 48 * 3600_000) }] },
      { manager_approval: { status: "awaiting_approval" } },
    );
    expect(detectBlockers(s, T0)).toEqual([]);
    expect(detectBlockers(s, T0 + 49 * 3600_000)).toEqual([expect.objectContaining({ kind: "approval_overdue", subject: "apr:E001:manager_approval:1", ownerDepartment: "people_ops" })]);
  });

  it("employee_task_overdue for a waiting stage with overdue open tasks, one blocker per stage", () => {
    const s = snap(
      {
        openChecklist: [
          { id: "chk:E001:w4", stageId: "paperwork", dueAt: iso(T0 - 1000) },
          { id: "chk:E001:offer_docs", stageId: "paperwork", dueAt: iso(T0 - 5000) },
          { id: "chk:E001:meet_buddy", stageId: "orientation", dueAt: iso(T0 + 1000) },
        ],
      },
      { paperwork: { status: "waiting_on_employee" } },
    );
    expect(detectBlockers(s, T0)).toEqual([
      expect.objectContaining({ kind: "employee_task_overdue", stageId: "paperwork", subject: "checklist:paperwork", ownerDepartment: "people_ops", detail: { taskIds: ["chk:E001:offer_docs", "chk:E001:w4"], count: 2 } }),
    ]);
    // not waiting on the employee: no blocker
    expect(detectBlockers(snap({ openChecklist: s.openChecklist }, { paperwork: { status: "active" } }), T0)).toEqual([]);
  });

  it("approval_rejected for a stage in revision_requested, keyed by the rejected approval", () => {
    const s = snap(
      { approvals: [{ id: "apr:E001:closeout:2", stageId: "closeout", checkpoint: "closeout", round: 2, status: "rejected", dueAt: iso(T0) }] },
      { closeout: { status: "revision_requested", round: 2 } },
    );
    expect(detectBlockers(s, T0)).toEqual([expect.objectContaining({ kind: "approval_rejected", subject: "apr:E001:closeout:2", ownerDepartment: "people_ops" })]);
  });

  it("finds nothing for finished or not started cases", () => {
    const blocked = { it_provisioning: { status: "blocked", blockedReason: { class: "retryable" as const, operation: "it.order-device" as const, round: 1 } } };
    expect(detectBlockers(snap({ caseStatus: "complete" }, blocked), T0)).toEqual([]);
    expect(detectBlockers(snap({ caseStatus: "failed" }, blocked), T0)).toEqual([]);
    expect(detectBlockers(snap({ caseStatus: "not_started" }, blocked), T0)).toEqual([]);
  });
});

describe("auto-resolution", () => {
  const open = (kind: ScanSnapshot["openBlockers"][number]["kind"], stageId: StageId, subject: string, detail: Record<string, unknown> = {}) => ({
    id: `blk:${kind}`,
    kind,
    stageId,
    subject,
    dedupeKey: `E001:${kind}:${stageId}:${subject}`,
    detectedAt: iso(T0),
    detail,
  });

  it("resolves an integration blocker only after the operation succeeds (not when the follow-up is done or the stage is merely retried)", () => {
    const b = open("integration_outage", "it_provisioning", "it.order-device");
    const retried = snap({ openBlockers: [b] }, { it_provisioning: { status: "active", round: 2, blockedReason: { class: "retryable", operation: "it.order-device", round: 1 } } });
    expect(resolvedBlockers(retried, T0 + 10)).toEqual([]);
    const succeeded = { ...retried, successes: [{ operation: "it.order-device", lastAt: iso(T0 + 5) }] };
    expect(resolvedBlockers(succeeded, T0 + 10)).toEqual([{ blockerId: b.id, kind: "integration_outage", reason: expect.stringContaining("succeeded") }]);
    const earlier = { ...retried, successes: [{ operation: "it.order-device", lastAt: iso(T0 - 5) }] };
    expect(resolvedBlockers(earlier, T0 + 10)).toEqual([]);
  });

  it("resolves stalled provisioning when the resource is terminal, approvals when decided, overdue tasks when done, rejections when resubmitted", () => {
    const s = snap(
      {
        openBlockers: [
          open("provisioning_stalled", "it_provisioning", "it.order-device"),
          open("approval_overdue", "manager_approval", "apr:E001:manager_approval:1"),
          open("employee_task_overdue", "paperwork", "checklist:paperwork"),
          open("approval_rejected", "manager_approval", "apr:E001:manager_approval:1", { round: 1 }),
        ],
        provisioning: [{ resource: "it_device", status: "delivered" }],
        approvals: [{ id: "apr:E001:manager_approval:1", stageId: "manager_approval", checkpoint: "manager_approval", round: 1, status: "rejected", dueAt: iso(T0) }],
      },
      { manager_approval: { status: "awaiting_approval", round: 2 }, paperwork: { status: "waiting_on_employee" } },
    );
    expect(resolvedBlockers(s, T0).map((r) => r.kind).sort()).toEqual(["approval_overdue", "approval_rejected", "employee_task_overdue", "provisioning_stalled"]);
  });

  it("keeps blockers open while their condition holds", () => {
    const s = snap(
      {
        openBlockers: [open("approval_rejected", "closeout", "apr:E001:closeout:1", { round: 1 }), open("approval_overdue", "closeout", "apr:E001:closeout:2")],
        approvals: [{ id: "apr:E001:closeout:2", stageId: "closeout", checkpoint: "closeout", round: 2, status: "pending", dueAt: iso(T0 - 1) }],
      },
      { closeout: { status: "revision_requested", round: 1 } },
    );
    expect(resolvedBlockers(s, T0)).toEqual([]);
  });
});

describe("nudge predicate", () => {
  it("nudges waiting stages whose gate holds in D1 and whose last wake-up is stale", () => {
    const s = snap(
      {
        checklistProgress: [{ stageId: "paperwork", total: 6, done: 6 }],
        approvals: [{ id: "apr:E001:manager_approval:1", stageId: "manager_approval", checkpoint: "manager_approval", round: 1, status: "approved", dueAt: iso(T0) }],
      },
      {
        paperwork: { status: "waiting_on_employee", lastWakeAt: iso(T0 - 120_000) },
        manager_approval: { status: "awaiting_approval", lastWakeAt: null },
        it_provisioning: { status: "active", round: 2, blockedReason: { class: "retryable", round: 1 } },
      },
    );
    expect(nudgeTargets(s, T0, 60)).toEqual(["paperwork", "manager_approval", "it_provisioning"]);
  });

  it("does not nudge when the gate is closed or the last wake-up is recent", () => {
    const s = snap(
      {
        checklistProgress: [{ stageId: "paperwork", total: 6, done: 5 }],
        approvals: [{ id: "apr:E001:manager_approval:1", stageId: "manager_approval", checkpoint: "manager_approval", round: 1, status: "pending", dueAt: iso(T0) }],
      },
      {
        paperwork: { status: "waiting_on_employee" },
        manager_approval: { status: "awaiting_approval" },
        orientation: { status: "waiting_on_employee", lastWakeAt: iso(T0 - 10_000) },
        it_provisioning: { status: "blocked", round: 1, blockedReason: { class: "retryable", round: 1 } },
      },
    );
    expect(nudgeTargets({ ...s, checklistProgress: [...s.checklistProgress, { stageId: "orientation", total: 4, done: 4 }] }, T0, 60)).toEqual([]);
  });

  it("nudges a resubmitted checkpoint whose new approval is not requested yet", () => {
    const s = snap(
      { approvals: [{ id: "apr:E001:closeout:1", stageId: "closeout", checkpoint: "closeout", round: 1, status: "rejected", dueAt: iso(T0) }] },
      { closeout: { status: "awaiting_approval", round: 2 } },
    );
    expect(nudgeTargets(s, T0, 60)).toEqual(["closeout"]);
  });
});
