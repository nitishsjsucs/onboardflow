import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CaseAgent } from "../../src/worker/agents/case-agent.ts";
import { clearFaults, ledger, setFault } from "../helpers/sims.ts";
import {
  calls,
  caseAgent,
  caseRow,
  cmdFor,
  completeEmployeeTasks,
  decide,
  driveThroughManagerApproval,
  fastWorkflows,
  finishFromOrientation,
  retry,
  rpc,
  waitFor,
  waitForCase,
  waitForStage,
} from "../helpers/workflow.ts";

const DB = env.DB;

/** One ledger row per POST operation, the invariant restarts must keep. */
async function expectOneSideEffectEach(employeeId: string) {
  const rows = await ledger({ employeeRef: employeeId });
  const byOp = new Map<string, number>();
  for (const r of rows) byOp.set(`${r.system}.${r.operation}`, (byOp.get(`${r.system}.${r.operation}`) ?? 0) + 1);
  for (const [op, n] of byOp) expect(n, op).toBe(1);
  return rows.length;
}

async function stageRowOf(employeeId: string, stage: string) {
  return (await DB.prepare("SELECT status, round FROM case_stages WHERE employee_id = ? AND stage_id = ?").bind(employeeId, stage).first<{ status: string; round: number }>())!;
}

async function gateChecks(employeeId: string, runNo: number) {
  const rows = await DB.prepare("SELECT stage_id, detail_json FROM audit_events WHERE employee_id = ? AND action = 'stage.gate_passed' AND run_no = ? ORDER BY seq")
    .bind(employeeId, runNo)
    .all<{ stage_id: string; detail_json: string }>();
  return rows.results.map((r) => ({ stage: r.stage_id, ...(JSON.parse(r.detail_json) as { gate: string; checks: number }) }));
}

async function blockedAudits(employeeId: string, runNo: number) {
  const rows = await DB.prepare("SELECT stage_id FROM audit_events WHERE employee_id = ? AND action = 'stage.blocked' AND run_no = ? ORDER BY seq")
    .bind(employeeId, runNo)
    .all<{ stage_id: string }>();
  return rows.results.map((r) => r.stage_id);
}

describe("restart", () => {
  it("restarts mid IT provisioning: run_no 2, replays without new side effects, earlier gates pass on the first check, completes", async () => {
    const intro = await fastWorkflows();
    try {
      await setFault({ system: "it", operation: "order-device", employeeRef: "E110", fault: "fail_503" });
      await driveThroughManagerApproval("E110");
      await waitForStage("E110", "it_provisioning", "blocked");
      const ledgerBefore = await expectOneSideEffectEach("E110");

      const agent = await rpc("E110");
      const r = await agent.restartCase("operator restart", await cmdFor("A01"));
      expect(r).toEqual({ status: 202, body: { runNo: 2, instanceId: "onb-E110-1" } });
      // run 2 replays intake to manager approval with every gate passing on its first check
      await waitFor(async () => (await gateChecks("E110", 2)).length >= 2 || null, { what: "run 2 gates" });
      expect(await gateChecks("E110", 2)).toEqual([
        { stage: "paperwork", gate: "tasks", kind: "tasks", checks: 1 },
        { stage: "manager_approval", gate: "decision", kind: "decision", checks: 1 },
      ]);
      // run 2 exhausts its attempts and blocks the stage again before the outage ends,
      // so the retry below cannot race an attempt of run 2 that is still in flight
      await waitFor(async () => (await blockedAudits("E110", 2)).includes("it_provisioning") || null, { what: "run 2 blocks it_provisioning" });
      expect((await calls("E110", "it.order-device")).filter((c) => c.run_no === 2)).toHaveLength(5);
      expect(await expectOneSideEffectEach("E110")).toBe(ledgerBefore);

      await clearFaults("E110");
      await waitForStage("E110", "it_provisioning", "blocked");
      expect((await retry("E110", "it_provisioning", "C03")).status).toBe(202);
      expect((await finishFromOrientation("E110")).status).toBe("complete");
      await expectOneSideEffectEach("E110");
      const replays = (await calls("E110")).filter((c) => c.run_no === 2 && c.outcome === "replayed").map((c) => c.operation);
      expect(replays).toEqual(expect.arrayContaining(["hr.create-worker", "hr.start-document-verification", "it.create-account", "it.assign-licenses"]));
      expect((await DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE employee_id = 'E110' AND action = 'case.failed'").first<{ n: number }>())!.n).toBe(0);
      expect((await caseRow("E110"))!.run_no).toBe(2);
    } finally {
      await intro.dispose();
    }
  });

  it("restarts after both task gates and approval 1: each passes with checks 1 in run 2, no case.failed, schedule re-armed", async () => {
    const intro = await fastWorkflows();
    try {
      await driveThroughManagerApproval("E111");
      await waitForStage("E111", "orientation", "waiting_on_employee");
      await completeEmployeeTasks("E111", "orientation");
      await waitForStage("E111", "closeout", "awaiting_approval");

      const agent = await rpc("E111");
      expect((await agent.restartCase("operator restart", await cmdFor("A01"))).status).toBe(202);
      await waitFor(async () => (await gateChecks("E111", 2)).length >= 3 || null, { what: "run 2 gates" });
      expect(await gateChecks("E111", 2)).toEqual([
        { stage: "paperwork", gate: "tasks", kind: "tasks", checks: 1 },
        { stage: "manager_approval", gate: "decision", kind: "decision", checks: 1 },
        { stage: "orientation", gate: "tasks", kind: "tasks", checks: 1 },
      ]);
      // the closeout request is honored from D1, not duplicated
      await decide("E111", "closeout", "approve", "C01");
      expect((await waitForCase("E111", ["complete", "failed"])).status).toBe("complete");
      expect((await DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE employee_id = 'E111'").first<{ n: number }>())!.n).toBe(2);
      expect((await DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE employee_id = 'E111' AND action = 'approval.requested'").first<{ n: number }>())!.n).toBe(2);
      expect((await DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE employee_id = 'E111' AND action = 'case.failed'").first<{ n: number }>())!.n).toBe(0);
      await expectOneSideEffectEach("E111");
    } finally {
      await intro.dispose();
    }
  });

  it("re-arms the scan schedule on restart", async () => {
    const intro = await fastWorkflows();
    try {
      await driveThroughManagerApproval("E112");
      await waitForStage("E112", "orientation", "waiting_on_employee");
      const stub = await caseAgent("E112");
      await runInDurableObject(stub, async (agent: CaseAgent) => {
        for (const s of await agent.listSchedules({ type: "interval" })) await agent.cancelSchedule(s.id);
      });
      expect((await (await rpc("E112")).restartCase("re-arm", await cmdFor("A01"))).status).toBe(202);
      const callbacks = await runInDurableObject(stub, async (agent: CaseAgent) => (await agent.listSchedules({ type: "interval" })).map((s) => s.callback));
      expect(callbacks).toEqual(["scheduledScan"]);
      await (await rpc("E112")).terminateCase("cleanup", await cmdFor("A01"));
    } finally {
      await intro.dispose();
    }
  });

  it("terminate, then restart: completes without duplicate side effects", async () => {
    const intro = await fastWorkflows();
    try {
      await driveThroughManagerApproval("E113");
      await waitForStage("E113", "orientation", "waiting_on_employee");
      const agent = await rpc("E113");
      expect((await agent.terminateCase("operator stop", await cmdFor("A01"))).status).toBe(202);
      expect(await caseRow("E113")).toMatchObject({ status: "failed", failure_reason: "terminated" });
      const status = await (await env.ONBOARDING_WORKFLOW.get("onb-E113-1")).status();
      expect(status.status).toBe("terminated");
      const before = await expectOneSideEffectEach("E113");

      expect((await agent.restartCase("resume after stop", await cmdFor("A01"))).status).toBe(202);
      expect((await finishFromOrientation("E113")).status).toBe("complete");
      expect(await expectOneSideEffectEach("E113")).toBe(before + 1); // + hr.activate-worker
      expect(await caseRow("E113")).toMatchObject({ status: "complete", failure_reason: null, run_no: 2 });
    } finally {
      await intro.dispose();
    }
  });

  it("falls back to a new revision (onb-<id>-2) when the platform refuses to restart, with zero new side effects", async () => {
    const intro = await fastWorkflows();
    try {
      await driveThroughManagerApproval("E114");
      await waitForStage("E114", "orientation", "waiting_on_employee");
      const agent = await rpc("E114");
      await agent.terminateCase("operator stop", await cmdFor("A01"));
      const before = await expectOneSideEffectEach("E114");
      const stub = await caseAgent("E114");
      await runInDurableObject(stub, (a: CaseAgent) => {
        const real = a.control;
        a.control = {
          ensureInstance: (id, emp, limits) => real.ensureInstance(id, emp, limits),
          restart: async () => {
            throw new Error("instance.cannot_restart: simulated platform refusal");
          },
          terminate: (id) => real.terminate(id),
          status: (id) => real.status(id),
        };
      });
      expect(await agent.restartCase("resume", await cmdFor("A01"))).toEqual({ status: 202, body: { runNo: 2, instanceId: "onb-E114-2" } });
      expect(await caseRow("E114")).toMatchObject({ revision: 2, workflow_instance_id: "onb-E114-2" });
      await waitFor(async () => (await calls("E114")).some((c) => c.step_name.startsWith("intake") && c.run_no === 2) || null, { what: "new instance replay" });
      expect(await expectOneSideEffectEach("E114")).toBe(before);
      expect((await finishFromOrientation("E114")).status).toBe("complete");
      expect(await expectOneSideEffectEach("E114")).toBe(before + 1);
      expect((await DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE employee_id = 'E114' AND action = 'case.revision_created'").first<{ n: number }>())!.n).toBe(1);
    } finally {
      await intro.dispose();
    }
  });
  it("restart during an outage: a replay that fails on a completed stage blocks it, a coordinator retries, the case completes", async () => {
    const intro = await fastWorkflows();
    try {
      await driveThroughManagerApproval("E116");
      await waitForStage("E116", "orientation", "waiting_on_employee");
      const before = await expectOneSideEffectEach("E116");
      expect((await stageRowOf("E116", "intake")).status).toBe("complete");

      // HR goes down, then an admin restarts: run 2 replays intake's create-worker into the outage
      await setFault({ system: "hr", operation: "create-worker", employeeRef: "E116", fault: "fail_503" });
      expect((await (await rpc("E116")).restartCase("operator restart", await cmdFor("A01"))).status).toBe(202);
      await waitFor(async () => (await blockedAudits("E116", 2)).includes("intake") || null, { what: "run 2 blocks intake" });
      expect(await stageRowOf("E116", "intake")).toMatchObject({ status: "blocked", round: 1 });
      expect((await caseRow("E116"))!.status).toBe("blocked");
      // the scan opens a blocker that People Ops owns
      await (await rpc("E116")).scanNow(await cmdFor("A01"));
      const blocker = await DB.prepare("SELECT kind, owner_department FROM blockers WHERE employee_id = 'E116' AND stage_id = 'intake' AND status = 'open'").first<{
        kind: string;
        owner_department: string;
      }>();
      expect(blocker).toEqual({ kind: "integration_outage", owner_department: "people_ops" });

      await clearFaults("E116");
      expect((await retry("E116", "intake", "C01")).status).toBe(202);
      expect((await finishFromOrientation("E116")).status).toBe("complete");
      expect(await stageRowOf("E116", "intake")).toMatchObject({ status: "complete", round: 2 });
      expect(await expectOneSideEffectEach("E116")).toBe(before + 1); // + hr.activate-worker
      expect((await DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE employee_id = 'E116' AND action = 'case.failed'").first<{ n: number }>())!.n).toBe(0);
    } finally {
      await intro.dispose();
    }
  });

  it("restart after a desk conflict: the stored workspace preference is replayed, one assignment", async () => {
    const intro = await fastWorkflows();
    try {
      await setFault({ system: "facilities", operation: "assign-workspace", employeeRef: "E115", fault: "conflict_409", remaining: 1 });
      await driveThroughManagerApproval("E115");
      await waitForStage("E115", "orientation", "waiting_on_employee");
      const run1 = (await calls("E115", "facilities.assign-workspace")).map((c) => c.outcome);
      expect(run1).toEqual(["conflict", "ok"]);

      expect((await (await rpc("E115")).restartCase("operator restart", await cmdFor("A01"))).status).toBe(202);
      expect((await finishFromOrientation("E115")).status).toBe("complete");
      const run2 = (await calls("E115", "facilities.assign-workspace")).filter((c) => c.run_no === 2).map((c) => c.outcome);
      expect(run2).toEqual(["replayed"]);
      expect(await ledger({ employeeRef: "E115", system: "facilities", operation: "assign-workspace" })).toHaveLength(1);
      await expectOneSideEffectEach("E115");
    } finally {
      await intro.dispose();
    }
  });
});
