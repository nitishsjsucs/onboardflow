import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { clearFaults, ledger, setFault } from "../helpers/sims.ts";
import {
  waitFor,
  calls,
  caseRow,
  cmdFor,
  driveThroughManagerApproval,
  fastWorkflows,
  finishFromOrientation,
  retry,
  rpc,
  stageRow,
  startCase,
  waitForCase,
  waitForStage,
} from "../helpers/workflow.ts";

const DB = env.DB;

async function blockerOf(employeeId: string, kind: string) {
  return waitFor(
    () => DB.prepare("SELECT id, kind, owner_department, status, stage_id FROM blockers WHERE employee_id = ? AND kind = ?").bind(employeeId, kind).first<{ id: string; owner_department: string; status: string; stage_id: string }>(),
    { what: `${employeeId} ${kind} blocker` },
  );
}

async function followUpOf(blockerId: string) {
  return DB.prepare("SELECT assignee, status FROM tasks WHERE blocker_id = ?").bind(blockerId).first<{ assignee: string; status: string }>();
}

describe("recovery rounds", () => {
  it("recovers from an outage beyond the retry budget: blocked -> fault cleared -> retry -> completes", async () => {
    const intro = await fastWorkflows();
    try {
      await setFault({ system: "it", operation: "order-device", employeeRef: "E090", fault: "fail_503" });
      await driveThroughManagerApproval("E090");
      await waitForStage("E090", "it_provisioning", "blocked");
      const blocker = await blockerOf("E090", "integration_outage");
      expect(blocker).toMatchObject({ owner_department: "it", stage_id: "it_provisioning", status: "open" });
      expect(await followUpOf(blocker.id)).toEqual({ assignee: "it", status: "open" });
      await clearFaults("E090");
      const r = await retry("E090", "it_provisioning", "C03");
      expect(r).toEqual({ status: 202, body: { round: 2 } });
      expect((await finishFromOrientation("E090")).status).toBe("complete");
      expect((await stageRow("E090", "it_provisioning"))!.round).toBe(2);
      expect(await ledger({ employeeRef: "E090", operation: "order-device" })).toHaveLength(1);
      expect(await DB.prepare("SELECT status, resolved_by FROM blockers WHERE id = ?").bind(blocker.id).first()).toEqual({ status: "resolved", resolved_by: "case-agent/E090" });
      const order = await calls("E090", "it.order-device");
      expect(order.filter((c) => c.step_name === "it_provisioning.it.order-device#r1")).toHaveLength(5);
      expect(order.filter((c) => c.step_name === "it_provisioning.it.order-device#r2").map((c) => c.outcome)).toEqual(["ok"]);
    } finally {
      await intro.dispose();
    }
  });

  it("recovers from a genuine 422: data issue -> field fixed -> retry -> round 2 completes", async () => {
    const intro = await fastWorkflows();
    try {
      await DB.prepare("UPDATE employees SET cost_center = 'CC-BAD' WHERE id = 'E091'").run();
      await startCase("E091");
      const blocked = await waitForStage("E091", "intake", "blocked");
      expect(JSON.parse(blocked.blocked_reason_json!)).toMatchObject({ class: "fatal", field: "costCenter", httpStatus: 422, operation: "hr.create-worker" });
      // a NonRetryableError skips the remaining retries
      expect((await calls("E091", "hr.create-worker")).map((c) => c.outcome)).toEqual(["fatal_error"]);
      const blocker = await blockerOf("E091", "data_issue");
      expect(blocker.owner_department).toBe("people_ops");
      expect(await followUpOf(blocker.id)).toEqual({ assignee: "people_ops", status: "open" });
      const agent = await rpc("E091");
      expect((await agent.fixField("costCenter", "CC-1100", await cmdFor("C01"))).status).toBe(200);
      expect((await retry("E091", "intake", "C01")).status).toBe(202);
      await waitForStage("E091", "paperwork", "waiting_on_employee");
      expect((await stageRow("E091", "intake"))).toMatchObject({ status: "complete", round: 2 });
      await agent.terminateCase("cleanup", await cmdFor("A01"));
    } finally {
      await intro.dispose();
    }
  });

  it("recovers from a stalled device order: blocked as stalled -> retry replays the order (ledger 1) -> completes", async () => {
    const intro = await fastWorkflows();
    try {
      await setFault({ system: "it", operation: "get-device-order", employeeRef: "E092", fault: "stall" });
      await driveThroughManagerApproval("E092");
      const blocked = await waitForStage("E092", "it_provisioning", "blocked");
      expect(JSON.parse(blocked.blocked_reason_json!)).toMatchObject({ class: "stalled", operation: "it.order-device" });
      const blocker = await blockerOf("E092", "provisioning_stalled");
      expect(blocker.owner_department).toBe("it");
      const polls = await calls("E092", "it.get-device-order");
      expect(polls).toHaveLength(12); // POLL_MAX
      await clearFaults("E092");
      expect((await retry("E092", "it_provisioning", "C03")).status).toBe(202);
      expect((await finishFromOrientation("E092")).status).toBe("complete");
      const orders = await calls("E092", "it.order-device");
      expect(orders.map((c) => c.outcome)).toEqual(["ok", "replayed"]);
      expect(await ledger({ employeeRef: "E092", operation: "order-device" })).toHaveLength(1);
      expect(await DB.prepare("SELECT status FROM provisioning_items WHERE employee_id = 'E092' AND resource = 'it_device'").first()).toEqual({ status: "delivered" });
      expect(await DB.prepare("SELECT status FROM blockers WHERE id = ?").bind(blocker.id).first()).toEqual({ status: "resolved" });
    } finally {
      await intro.dispose();
    }
  });

  it("fails the case with recovery_rounds_exhausted when the stage keeps failing", async () => {
    const intro = await fastWorkflows();
    try {
      await setFault({ system: "it", operation: "create-account", employeeRef: "E093", fault: "fail_503" });
      await driveThroughManagerApproval("E093", { maxStageRounds: 2 });
      await waitForStage("E093", "it_provisioning", "blocked");
      expect((await retry("E093", "it_provisioning", "C03")).status).toBe(202);
      const failed = await waitForCase("E093", "failed");
      expect(failed.failure_reason).toBe("recovery_rounds_exhausted");
      expect((await stageRow("E093", "it_provisioning"))).toMatchObject({ status: "failed", round: 2 });
      expect((await DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE employee_id = 'E093' AND action = 'case.failed'").first<{ n: number }>())!.n).toBe(1);
      expect((await caseRow("E093"))!.status).toBe("failed");
    } finally {
      await intro.dispose();
    }
  });
});
