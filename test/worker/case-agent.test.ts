import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { projectCase } from "../../src/worker/agents/projection.ts";
import type { CaseAgent } from "../../src/worker/agents/case-agent.ts";
import type { WorkflowControl } from "../../src/worker/agents/workflow-control.ts";
import { FollowUpDrafter } from "../../src/worker/agents/followups.ts";
import { StubLlmProvider } from "../../src/worker/llm/stub.ts";
import { blockerDedupeKey, blockerId } from "../../src/shared/ids.ts";
import { caseAgent, cmdFor } from "../helpers/workflow.ts";

const DB = env.DB;
const count = async (sql: string, ...binds: unknown[]) => (await DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;

/** A control that records calls and never runs a real workflow. */
function fakeControl(over: Partial<WorkflowControl> = {}): WorkflowControl & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    ensureInstance: async (id) => {
      calls.push(`ensure:${id}`);
      return { created: true };
    },
    restart: async (id) => {
      calls.push(`restart:${id}`);
      return "sdk";
    },
    terminate: async (id) => {
      calls.push(`terminate:${id}`);
    },
    status: async () => "running",
    ...over,
  };
}

async function withControl(employeeId: string, control: WorkflowControl) {
  const stub = await caseAgent(employeeId);
  await runInDurableObject(stub, (agent: CaseAgent) => {
    agent.control = control;
  });
  return stub;
}

describe("startCase", () => {
  it("lets two concurrent starts create one instance and one case.started row, with the same instanceId", async () => {
    const stub = await caseAgent("E040");
    const [a, b] = await Promise.all([stub.startCase(await cmdFor("C01")), stub.startCase(await cmdFor("C02"))]);
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(a.body.instanceId).toBe("onb-E040-1");
    expect(b.body.instanceId).toBe("onb-E040-1");
    expect([a.body.created, b.body.created].filter(Boolean)).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'case.started' AND entity_id = 'E040'")).toBe(1);
    const tracked = await runInDurableObject(stub, (agent: CaseAgent) => agent.getWorkflows({}).workflows.map((w) => w.workflowId));
    expect(tracked).toEqual(["onb-E040-1"]);
    const status = await (await env.ONBOARDING_WORKFLOW.get("onb-E040-1")).status();
    expect(["queued", "running", "complete"]).toContain(status.status);
  });

  it("converges after a failed create: a retry creates the instance", async () => {
    let fail = true;
    const inner = fakeControl();
    const stub = await withControl("E041", {
      ...inner,
      ensureInstance: async (id, emp) => {
        if (fail) {
          fail = false;
          throw new Error("simulated create failure");
        }
        return inner.ensureInstance(id, emp);
      },
    });
    const failed = await stub.startCase(await cmdFor("C01"));
    expect(failed.status).toBe(503);
    expect(await count("SELECT COUNT(*) AS n FROM cases WHERE employee_id = 'E041' AND workflow_instance_id = 'onb-E041-1'")).toBe(1);
    const retry = await stub.startCase(await cmdFor("C01"));
    expect(retry).toEqual({ status: 202, body: { instanceId: "onb-E041-1", created: true } });
    expect(inner.calls).toEqual(["ensure:onb-E041-1"]);
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'case.started' AND entity_id = 'E041'")).toBe(1);
  });

  it("projects the case from D1 and arms the scan schedule", async () => {
    const stub = await withControl("E042", fakeControl());
    await stub.startCase(await cmdFor("A01"));
    const state = await stub.getSnapshot();
    const fromD1 = await projectCase(DB, "E042", null, state.projectedAt);
    // asOfSeq is the global audit high-water mark; other cases may have advanced it since the refresh
    expect({ ...state, workflow: { ...state.workflow, status: null }, asOfSeq: 0 }).toEqual({ ...fromD1, asOfSeq: 0 });
    expect(state.asOfSeq).toBeLessThanOrEqual(fromD1!.asOfSeq);
    expect(state.stages).toHaveLength(8);
    expect(state.status).toBe("in_progress");
    const schedules = await runInDurableObject(stub, async (agent: CaseAgent) => (await agent.listSchedules({ type: "interval" })).map((s) => s.callback));
    expect(schedules).toEqual(["scheduledScan"]);
    // the scheduled scan runs on the alarm
    expect(await runDurableObjectAlarm(stub)).toBe(true);
  });
});

describe("projection guard and lifecycle", () => {
  it("never lets an older asOfSeq overwrite newer state", async () => {
    const stub = await withControl("E043", fakeControl());
    await stub.refresh();
    const result = await runInDurableObject(stub, (agent: CaseAgent) => {
      const s = agent.state;
      const newer = agent.applyProjection({ ...s, asOfSeq: s.asOfSeq + 100, displayName: "newer" });
      const older = agent.applyProjection({ ...s, asOfSeq: s.asOfSeq + 50, displayName: "older" });
      return { newer, older, name: agent.state.displayName };
    });
    expect(result).toEqual({ newer: true, older: false, name: "newer" });
  });

  it("ignores Aborting engine errors and stale instance ids; confirms real failures through status()", async () => {
    const control = fakeControl({ status: async () => "errored" });
    const stub = await withControl("E044", control);
    await stub.startCase(await cmdFor("C01"));
    const scheduleCount = (agent: CaseAgent) => agent.listSchedules({ type: "delayed" }).then((s) => s.filter((x) => x.callback === "confirmWorkflowFailure").length);
    await runInDurableObject(stub, async (agent: CaseAgent) => {
      await agent.onWorkflowError("ONBOARDING_WORKFLOW", "onb-E044-1", "Aborting engine: User called restart");
      await agent.onWorkflowError("ONBOARDING_WORKFLOW", "onb-E044-1", "Error: Aborting engine: terminate");
      await agent.onWorkflowError("ONBOARDING_WORKFLOW", "onb-OTHER-1", "boom");
      expect(await scheduleCount(agent)).toBe(0);
    });
    expect(await count("SELECT COUNT(*) AS n FROM cases WHERE employee_id = 'E044' AND status = 'in_progress'")).toBe(1);

    await runInDurableObject(stub, async (agent: CaseAgent) => {
      await agent.onWorkflowError("ONBOARDING_WORKFLOW", "onb-E044-1", "real failure");
      expect(await scheduleCount(agent)).toBe(1);
      await agent.confirmWorkflowFailure({ instanceId: "onb-E044-1", error: "real failure" });
    });
    expect(await DB.prepare("SELECT status, failure_reason FROM cases WHERE employee_id = 'E044'").first()).toEqual({ status: "failed", failure_reason: "workflow_error" });
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'case.failed' AND employee_id = 'E044'")).toBe(1);
  });

  it("does not fail the case when the instance is running again (restart in flight)", async () => {
    const stub = await withControl("E045", fakeControl({ status: async () => "running" }));
    await stub.startCase(await cmdFor("C01"));
    await runInDurableObject(stub, (agent: CaseAgent) => agent.confirmWorkflowFailure({ instanceId: "onb-E045-1", error: "x" }));
    expect(await count("SELECT COUNT(*) AS n FROM cases WHERE employee_id = 'E045' AND status = 'in_progress'")).toBe(1);
  });

  it("cancels the scan schedule when the workflow completes", async () => {
    const stub = await withControl("E046", fakeControl());
    await stub.startCase(await cmdFor("C01"));
    const callbacks = () => runInDurableObject(stub, async (agent: CaseAgent) => (await agent.listSchedules({ type: "interval" })).map((s) => s.callback));
    expect(await callbacks()).toEqual(["scheduledScan"]);
    await runInDurableObject(stub, (agent: CaseAgent) => agent.onWorkflowComplete("ONBOARDING_WORKFLOW", "onb-OTHER-9"));
    expect(await callbacks()).toEqual(["scheduledScan"]);
    await runInDurableObject(stub, (agent: CaseAgent) => agent.onWorkflowComplete("ONBOARDING_WORKFLOW", "onb-E046-1"));
    expect(await callbacks()).toEqual([]);
  });

  it("keeps its state across eviction", async () => {
    const stub = await withControl("E047", fakeControl());
    await stub.startCase(await cmdFor("C01"));
    const before = await stub.getSnapshot();
    await evictDurableObject(stub);
    const after = await (await caseAgent("E047")).getSnapshot();
    expect(after).toEqual(before);
  });

  it("rejects client state writes and marks connections read-only", async () => {
    const stub = await caseAgent("E048");
    await runInDurableObject(stub, (agent: CaseAgent) => {
      expect(() => agent.validateStateChange(agent.state, {} as never)).toThrow(/read-only/);
      expect(() => agent.validateStateChange(agent.state, "server")).not.toThrow();
      expect(agent.shouldConnectionBeReadonly()).toBe(true);
    });
  });
});

describe("guarded commands", () => {
  it("retryStage on a stage that is not blocked returns 409, audits stage.retry_rejected and sends no wake-up", async () => {
    const control = fakeControl();
    const stub = await withControl("E049", control);
    await stub.startCase(await cmdFor("C01"));
    const r = await stub.retryStage("it_provisioning", await cmdFor("C03"));
    expect(r.status).toBe(409);
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'stage.retry_rejected' AND employee_id = 'E049'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM case_stages WHERE employee_id = 'E049' AND last_wake_at IS NOT NULL")).toBe(0);
  });

  it("retryStage on a blocked stage advances the round once", async () => {
    const stub = await withControl("E050", fakeControl());
    await stub.startCase(await cmdFor("C01"));
    await DB.prepare("UPDATE case_stages SET status = 'blocked' WHERE employee_id = 'E050' AND stage_id = 'it_provisioning'").run();
    const [c3, c4] = [await cmdFor("C03"), await cmdFor("C04")];
    const pa: Promise<{ status: number }> = stub.retryStage("it_provisioning", c3);
    const pb: Promise<{ status: number }> = stub.retryStage("it_provisioning", c4);
    const [a, b] = await Promise.all([pa, pb]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    expect(await DB.prepare("SELECT status, round FROM case_stages WHERE employee_id = 'E050' AND stage_id = 'it_provisioning'").first()).toEqual({ status: "active", round: 2 });
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'stage.retry_requested' AND employee_id = 'E050'")).toBe(1);
  });

  it("completing the badge_photo task sets photo_on_file; a second completion conflicts", async () => {
    const stub = await withControl("E051", fakeControl());
    await DB.prepare(
      "INSERT INTO tasks (id, employee_id, stage_id, kind, template_key, assignee, title, description, status, created_at) VALUES ('chk:E051:badge_photo','E051','paperwork','checklist','badge_photo','employee','Upload','d','open',?)",
    )
      .bind(new Date().toISOString())
      .run();
    const ok = await stub.completeTask("chk:E051:badge_photo", await cmdFor("E051"));
    expect(ok.status).toBe(200);
    expect(await DB.prepare("SELECT photo_on_file FROM employees WHERE id = 'E051'").first()).toEqual({ photo_on_file: 1 });
    const again = await stub.completeTask("chk:E051:badge_photo", await cmdFor("E051"));
    expect(again.status).toBe(409);
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'task.completed' AND entity_id = 'chk:E051:badge_photo'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'task.completion_conflict' AND entity_id = 'chk:E051:badge_photo'")).toBe(1);
  });

  it("fixField records before and after; terminate then terminate again conflicts", async () => {
    const control = fakeControl();
    const stub = await withControl("E052", control);
    await stub.startCase(await cmdFor("C01"));
    const fixed = await stub.fixField("costCenter", "CC-9999", await cmdFor("C01"));
    expect(fixed.status).toBe(200);
    const audit = await DB.prepare("SELECT detail_json FROM audit_events WHERE action = 'employee.field_corrected' AND entity_id = 'E052'").first<{ detail_json: string }>();
    expect(JSON.parse(audit!.detail_json)).toMatchObject({ field: "costCenter", after: "CC-9999" });
    expect((await stub.terminateCase("test", await cmdFor("A01"))).status).toBe(202);
    expect((await stub.terminateCase("test", await cmdFor("A01"))).status).toBe(409);
    expect(control.calls).toContain("terminate:onb-E052-1");
    expect(await DB.prepare("SELECT status, failure_reason FROM cases WHERE employee_id = 'E052'").first()).toEqual({ status: "failed", failure_reason: "terminated" });
  });

  it("restart falls back to a new revision when the platform refuses", async () => {
    const control = fakeControl({
      restart: async () => {
        throw new Error("instance.cannot_restart");
      },
    });
    const stub = await withControl("E053", control);
    await stub.startCase(await cmdFor("C01"));
    const r = await stub.restartCase("test fallback", await cmdFor("A01"));
    expect(r).toEqual({ status: 202, body: { runNo: 2, instanceId: "onb-E053-2" } });
    expect(await DB.prepare("SELECT revision, run_no, workflow_instance_id FROM cases WHERE employee_id = 'E053'").first()).toEqual({
      revision: 2,
      run_no: 2,
      workflow_instance_id: "onb-E053-2",
    });
    expect(control.calls).toContain("ensure:onb-E053-2");
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'case.revision_created' AND employee_id = 'E053'")).toBe(1);
  });
});

describe("blocker scans", () => {
  async function blockStage(employeeId: string, stage: string, reason: Record<string, unknown>) {
    const stub = await withControl(employeeId, fakeControl());
    await stub.startCase(await cmdFor("C01"));
    await DB.prepare("UPDATE case_stages SET status = 'blocked', blocked_reason_json = ? WHERE employee_id = ? AND stage_id = ?")
      .bind(JSON.stringify({ round: 1, ...reason }), employeeId, stage)
      .run();
    return stub;
  }

  it("opens a blocker and a follow-up for the owning department once; a second scan opens nothing new", async () => {
    const stub = await blockStage("E054", "it_provisioning", { class: "retryable", system: "it", operation: "it.order-device", httpStatus: 503 });
    expect(await stub.scanBlockers()).toEqual({ opened: 1, autoResolved: 0, nudged: 0 });
    expect(await stub.scanBlockers()).toEqual({ opened: 0, autoResolved: 0, nudged: 0 });
    const blockers = await DB.prepare("SELECT id, kind, owner_department, status FROM blockers WHERE employee_id = 'E054'").all<{ id: string }>();
    expect(blockers.results).toEqual([expect.objectContaining({ kind: "integration_outage", owner_department: "it", status: "open" })]);
    const fu = await DB.prepare("SELECT id, assignee, kind, status, drafted_by, llm_suggested_category FROM tasks WHERE blocker_id = ?").bind(blockers.results[0]!.id).first();
    expect(fu).toEqual({ id: `fu:${blockers.results[0]!.id}`, assignee: "it", kind: "followup", status: "open", drafted_by: "stub", llm_suggested_category: "integration_outage" });
    const audits = await DB.prepare("SELECT action FROM audit_events WHERE employee_id = 'E054' AND action IN ('blocker.opened','followup.created') ORDER BY seq").all<{ action: string }>();
    expect(audits.results.map((a) => a.action)).toEqual(["blocker.opened", "followup.created"]);
    const state = await stub.getSnapshot();
    expect(state.openBlockers).toHaveLength(1);
    expect(state.openTasks.departments.it).toBe(1);
  });

  it("routes data issues to the field owner", async () => {
    const stub = await blockStage("E055", "facilities_setup", { class: "fatal", system: "facilities", operation: "facilities.issue-badge", httpStatus: 422, field: "photoOnFile" });
    await stub.scanBlockers();
    expect(await DB.prepare("SELECT kind, owner_department FROM blockers WHERE employee_id = 'E055'").first()).toEqual({ kind: "data_issue", owner_department: "facilities" });
    expect(await DB.prepare("SELECT assignee FROM tasks WHERE employee_id = 'E055' AND kind = 'followup'").first()).toEqual({ assignee: "facilities" });
  });

  it("serializes interleaved scans (slow drafter): no duplicate blocker or follow-up, no errors", async () => {
    const stub = await blockStage("E056", "intake", { class: "fatal", system: "hr", operation: "hr.create-worker", httpStatus: 422, field: "costCenter" });
    await runInDurableObject(stub, (agent: CaseAgent) => {
      const inner = new StubLlmProvider();
      agent.drafter = new FollowUpDrafter({
        id: "stub",
        completeJson: async (req) => {
          await new Promise((r) => setTimeout(r, 150));
          return inner.completeJson(req);
        },
      });
    });
    const results = await Promise.all([stub.scanBlockers(), stub.scanBlockers(), stub.scanBlockers()]);
    expect(results.map((r) => r.opened).reduce((a, b) => a + b, 0)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM blockers WHERE employee_id = 'E056'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM tasks WHERE employee_id = 'E056' AND kind = 'followup'")).toBe(1);
    const runs = await runInDurableObject(stub, (agent: CaseAgent) => agent.scanRuns());
    expect(runs.filter((r) => r.error !== null)).toEqual([]);
  });

  it("opens the blocker before it drafts the follow-up, and writes the follow-up once the draft returns (held drafter)", async () => {
    const stub = await blockStage("E057", "it_provisioning", LICENSE_REJECTED);
    const held = await holdDrafter(stub);
    try {
      const scan = stub.scanBlockers();
      await held.started;
      // the scan is suspended inside its LLM call: the blocker is already in D1, its follow-up is not
      expect(await DB.prepare("SELECT kind, status, json_extract(detail_json, '$.field') AS field FROM blockers WHERE employee_id = 'E057'").all()).toMatchObject({
        results: [{ kind: "data_issue", status: "open", field: "licenseBundle" }],
      });
      expect(await count("SELECT COUNT(*) AS n FROM tasks WHERE employee_id = 'E057' AND kind = 'followup'")).toBe(0);
      held.release();
      expect(await scan).toEqual({ opened: 1, autoResolved: 0, nudged: 0 });
    } finally {
      held.release();
    }
    const blocker = (await DB.prepare("SELECT id FROM blockers WHERE employee_id = 'E057'").first<{ id: string }>())!;
    expect(await DB.prepare("SELECT assignee, status, drafted_by FROM tasks WHERE blocker_id = ?").bind(blocker.id).first()).toEqual({ assignee: "it", status: "open", drafted_by: "stub" });
    const audits = await DB.prepare("SELECT action, detail_json FROM audit_events WHERE employee_id = 'E057' AND action IN ('blocker.opened','followup.created') ORDER BY seq").all<{ action: string; detail_json: string }>();
    expect(audits.results.map((a) => a.action)).toEqual(["blocker.opened", "followup.created"]);
    expect(JSON.parse(audits.results[1]!.detail_json)).toMatchObject({ blockerId: blocker.id, draftedBy: "stub", llm: { provider: "stub", error: null } });
  });

  it("writes no follow-up for a blocker resolved while its draft was pending", async () => {
    const stub = await blockStage("E058", "it_provisioning", LICENSE_REJECTED);
    const held = await holdDrafter(stub);
    try {
      const scan = stub.scanBlockers();
      await held.started;
      const blocker = await DB.prepare("SELECT id FROM blockers WHERE employee_id = 'E058' AND status = 'open'").first<{ id: string }>();
      expect(blocker).not.toBeNull();
      // a coordinator's resolution commits while the draft is pending (the row resolveBlocker writes)
      await DB.prepare("UPDATE blockers SET status = 'resolved', resolved_at = ?, resolved_by = 'it.coordinator@onboardflow.test', resolution = 'fixed by hand' WHERE id = ? AND status = 'open'")
        .bind("2026-10-08T12:00:01.000Z", blocker!.id)
        .run();
      held.release();
      expect((await scan).opened).toBe(1);
    } finally {
      held.release();
    }
    expect(await count("SELECT COUNT(*) AS n FROM tasks WHERE employee_id = 'E058' AND kind = 'followup'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE employee_id = 'E058' AND action = 'followup.created'")).toBe(0);
    // a fresh stub: after awaiting promises the agent resolved, this test runs in the agent's I/O context
    const runs = await runInDurableObject(await caseAgent("E058"), (agent: CaseAgent) => agent.scanRuns());
    expect(runs.filter((r) => r.error !== null)).toEqual([]);
  });

  it("gives an open blocker that has no follow-up (a scan cut off between its writes) its follow-up on the next scan", async () => {
    const stub = await blockStage("E059", "it_provisioning", { class: "retryable", system: "it", operation: "it.order-device", httpStatus: 503 });
    const dedupeKey = blockerDedupeKey("E059", "integration_outage", "it_provisioning", "it.order-device");
    const id = blockerId(dedupeKey, Date.parse("2026-10-08T12:00:00.000Z"));
    await DB.prepare(
      `INSERT INTO blockers (id, employee_id, stage_id, kind, severity, owner_department, subject, dedupe_key, status, detail_json, detected_at)
       VALUES (?, 'E059', 'it_provisioning', 'integration_outage', 'high', 'it', 'it.order-device', ?, 'open', ?, '2026-10-08T12:00:00.000Z')`,
    )
      .bind(id, dedupeKey, JSON.stringify({ class: "retryable", system: "it", operation: "it.order-device", httpStatus: 503, round: 1 }))
      .run();
    expect(await stub.scanBlockers()).toEqual({ opened: 0, autoResolved: 0, nudged: 0 });
    expect(await DB.prepare("SELECT id, assignee, status, drafted_by, due_at FROM tasks WHERE blocker_id = ?").bind(id).first()).toEqual({
      id: `fu:${id}`,
      assignee: "it",
      status: "open",
      drafted_by: "stub",
      due_at: "2026-10-09T12:00:00.000Z",
    });
    expect(await count("SELECT COUNT(*) AS n FROM audit_events WHERE employee_id = 'E059' AND action = 'followup.created'")).toBe(1);
    // and only once
    await stub.scanBlockers();
    expect(await count("SELECT COUNT(*) AS n FROM tasks WHERE employee_id = 'E059' AND kind = 'followup'")).toBe(1);
  });
});

/** The reason the workflow records when the simulated IT system rejects the license bundle (F6). */
const LICENSE_REJECTED = { class: "fatal", system: "it", operation: "it.assign-licenses", httpStatus: 422, field: "licenseBundle", message: "validation_failed" };

/** Replaces the agent's drafter with one that signals when a draft starts and returns only once released. */
async function holdDrafter(stub: Awaited<ReturnType<typeof caseAgent>>) {
  let release!: () => void;
  let markStarted!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    markStarted = r;
  });
  await runInDurableObject(stub, (agent: CaseAgent) => {
    const inner = new StubLlmProvider();
    agent.drafter = new FollowUpDrafter({
      id: "stub",
      completeJson: async (req) => {
        markStarted();
        await gate;
        return inner.completeJson(req);
      },
    });
  });
  return { started, release };
}

describe("license bundle lock after the manager's approval is requested", () => {
  async function approved(employeeId: string, manager: string) {
    await DB.prepare(
      `INSERT INTO approvals (id, employee_id, stage_id, checkpoint, round, approver_role, approver_staff_id, status, request_json, requested_at, due_at, decided_at, decided_by)
       VALUES (?, ?, 'manager_approval', 'manager_approval', 1, 'manager', ?, 'approved', '{}', '2026-10-08T12:00:00.000Z', '2026-10-10T12:00:00.000Z', '2026-10-08T12:01:00.000Z', 'manager@onboardflow.test')`,
    )
      .bind(`apr:${employeeId}:manager_approval:1`, employeeId, manager)
      .run();
  }
  async function blockOn(employeeId: string, stage: string, reason: Record<string, unknown>) {
    await DB.prepare("UPDATE case_stages SET status = 'blocked', blocked_reason_json = ? WHERE employee_id = ? AND stage_id = ?")
      .bind(JSON.stringify({ round: 1, ...reason }), employeeId, stage)
      .run();
  }

  it("opens as soon as the IT stage is blocked on the bundle, before any scan has opened the blocker", async () => {
    const stub = await withControl("E060", fakeControl());
    await stub.startCase(await cmdFor("C01"));
    await approved("E060", "M01");
    const locked: { status: number; body: unknown } = await stub.fixField("licenseBundle", "ft-engineering", await cmdFor("C03"));
    expect(locked).toMatchObject({ status: 409, body: { error: { code: "field_locked_by_approval" } } });
    await blockOn("E060", "it_provisioning", LICENSE_REJECTED);
    expect(await count("SELECT COUNT(*) AS n FROM blockers WHERE employee_id = 'E060'")).toBe(0);
    const fixed: { status: number; body: unknown } = await stub.fixField("licenseBundle", "ft-engineering", await cmdFor("C03"));
    expect(fixed).toMatchObject({ status: 200, body: { licenseBundle: "ft-engineering" } });
  });

  it("stays closed while the case shows no data issue on the bundle", async () => {
    const stub = await withControl("E061", fakeControl());
    await stub.startCase(await cmdFor("C01"));
    await approved("E061", "M01");
    const attempt = async () => (await stub.fixField("licenseBundle", "ft-engineering", await cmdFor("C03"))).status;
    // an outage on the same stage, a data issue on another field, and a rejected bundle in an earlier round that was retried
    await blockOn("E061", "it_provisioning", { class: "retryable", system: "it", operation: "it.assign-licenses", httpStatus: 503 });
    expect(await attempt()).toBe(409);
    await blockOn("E061", "it_provisioning", { class: "fatal", system: "it", operation: "it.assign-licenses", httpStatus: 422, field: "privileged" });
    expect(await attempt()).toBe(409);
    await DB.prepare("UPDATE case_stages SET status = 'active', round = 2, blocked_reason_json = ? WHERE employee_id = 'E061' AND stage_id = 'it_provisioning'")
      .bind(JSON.stringify({ round: 1, ...LICENSE_REJECTED }))
      .run();
    expect(await attempt()).toBe(409);
  });
});
