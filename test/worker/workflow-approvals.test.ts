import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  cmdFor,
  completeEmployeeTasks,
  decide,
  driveThroughManagerApproval,
  fastWorkflows,
  finishFromOrientation,
  managerOf,
  rpc,
  stageRow,
  startCase,
  waitForCase,
  waitForStage,
} from "../helpers/workflow.ts";

const DB = env.DB;
const approvals = async (employeeId: string) =>
  (await DB.prepare("SELECT id, round, status, decided_on_behalf_of FROM approvals WHERE employee_id = ? ORDER BY checkpoint, round").bind(employeeId).all()).results;

async function toManagerApproval(employeeId: string) {
  await startCase(employeeId);
  await waitForStage(employeeId, "paperwork", "waiting_on_employee");
  await completeEmployeeTasks(employeeId, "paperwork");
  await waitForStage(employeeId, "manager_approval", "awaiting_approval");
}

describe("approval checkpoints", () => {
  it("pauses at manager approval; reject -> revision_requested -> resubmit -> round 2 approved -> completes", async () => {
    const intro = await fastWorkflows();
    try {
      await toManagerApproval("E100");
      const manager = await managerOf("E100");
      expect((await decide("E100", "manager_approval", "reject", manager)).status).toBe(200);
      await waitForStage("E100", "manager_approval", "revision_requested");
      expect((await DB.prepare("SELECT status FROM cases WHERE employee_id = 'E100'").first())).toEqual({ status: "blocked" });
      const agent = await rpc("E100");
      // resubmitting a round that is not the rejected one is refused
      expect((await agent.resubmitApproval("apr:E100:manager_approval:1", await cmdFor("C01"), "revised")).status).toBe(202);
      expect((await agent.resubmitApproval("apr:E100:manager_approval:1", await cmdFor("C01"), "again")).status).toBe(409);
      expect((await decide("E100", "manager_approval", "approve", manager, { round: 2 })).status).toBe(200);
      expect((await finishFromOrientation("E100")).status).toBe("complete");
      expect(await approvals("E100")).toEqual([
        { id: "apr:E100:closeout:1", round: 1, status: "approved", decided_on_behalf_of: null },
        { id: "apr:E100:manager_approval:1", round: 1, status: "rejected", decided_on_behalf_of: null },
        { id: "apr:E100:manager_approval:2", round: 2, status: "approved", decided_on_behalf_of: null },
      ]);
      expect((await stageRow("E100", "manager_approval"))!.round).toBe(2);
      const resub = await DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE employee_id = 'E100' AND action IN ('approval.resubmitted','approval.resubmit_rejected') GROUP BY action ORDER BY action").all<{ n: number }>();
      expect(resub.results.map((r) => r.n)).toEqual([1, 1]);
    } finally {
      await intro.dispose();
    }
  });

  it("ends the case as approval_rejected_final on the third rejection", async () => {
    const intro = await fastWorkflows();
    try {
      await toManagerApproval("E101");
      const manager = await managerOf("E101");
      const agent = await rpc("E101");
      for (let round = 1; round <= 3; round++) {
        expect((await decide("E101", "manager_approval", "reject", manager, { round })).status).toBe(200);
        if (round < 3) {
          await waitForStage("E101", "manager_approval", "revision_requested");
          expect((await agent.resubmitApproval(`apr:E101:manager_approval:${round}`, await cmdFor("C02"))).status).toBe(202);
        }
      }
      const failed = await waitForCase("E101", "failed");
      expect(failed.failure_reason).toBe("approval_rejected_final");
      expect((await approvals("E101")).map((a) => (a as { status: string }).status)).toEqual(["rejected", "rejected", "rejected"]);
    } finally {
      await intro.dispose();
    }
  });

  it("answers a duplicate decision with 409 and approval.decision_conflict, never a second approval.approved", async () => {
    const intro = await fastWorkflows();
    try {
      await toManagerApproval("E102");
      const manager = await managerOf("E102");
      const agent = await rpc("E102");
      const id = "apr:E102:manager_approval:1";
      const first = await agent.decideApproval(id, { decision: "approve" }, await cmdFor(manager));
      const second = await agent.decideApproval(id, { decision: "approve" }, await cmdFor(manager));
      expect([first.status, second.status]).toEqual([200, 409]);
      const counts = await DB.prepare("SELECT action, COUNT(*) AS n FROM audit_events WHERE entity_id = ? GROUP BY action ORDER BY action").bind(id).all();
      expect(counts.results).toEqual([
        { action: "approval.approved", n: 1 },
        { action: "approval.decision_conflict", n: 1 },
        { action: "approval.requested", n: 1 },
      ]);
      await agent.terminateCase("cleanup", await cmdFor("A01"));
    } finally {
      await intro.dispose();
    }
  });

  it("records an admin decision on behalf of the manager, and closeout rejection -> resubmit -> approval", async () => {
    const intro = await fastWorkflows();
    try {
      await toManagerApproval("E103");
      const manager = await managerOf("E103");
      await decide("E103", "manager_approval", "approve", "A01", { onBehalfOf: manager });
      const row = await DB.prepare("SELECT decided_by, decided_on_behalf_of FROM approvals WHERE id = 'apr:E103:manager_approval:1'").first<{ decided_by: string; decided_on_behalf_of: string }>();
      expect(row!.decided_on_behalf_of).toBe(manager);
      expect(row!.decided_by).toMatch(/^a01\./);
      const audit = await DB.prepare("SELECT actor_role, detail_json FROM audit_events WHERE action = 'approval.approved' AND entity_id = 'apr:E103:manager_approval:1'").first<{ actor_role: string; detail_json: string }>();
      expect(audit!.actor_role).toBe("admin");
      expect(JSON.parse(audit!.detail_json)).toMatchObject({ onBehalfOf: manager });

      await waitForStage("E103", "orientation", "waiting_on_employee");
      await completeEmployeeTasks("E103", "orientation");
      expect((await decide("E103", "closeout", "reject", "C01")).status).toBe(200);
      await waitForStage("E103", "closeout", "revision_requested");
      expect((await (await rpc("E103")).resubmitApproval("apr:E103:closeout:1", await cmdFor("C01"), "fixed")).status).toBe(202);
      expect((await decide("E103", "closeout", "approve", "C02", { round: 2 })).status).toBe(200);
      expect((await waitForCase("E103", ["complete", "failed"])).status).toBe("complete");
    } finally {
      await intro.dispose();
    }
  });

  it("does not start provisioning before the manager decides", async () => {
    const intro = await fastWorkflows();
    try {
      await driveThroughManagerApproval("E104");
      // driveThroughManagerApproval approved; provisioning follows
      await waitForStage("E104", "it_provisioning", ["active", "complete"]);
      const before = await DB.prepare("SELECT MIN(created_at) AS t FROM integration_calls WHERE employee_id = 'E104' AND operation LIKE 'it.%'").first<{ t: string }>();
      const decided = await DB.prepare("SELECT decided_at FROM approvals WHERE id = 'apr:E104:manager_approval:1'").first<{ decided_at: string }>();
      expect(Date.parse(before!.t)).toBeGreaterThanOrEqual(Date.parse(decided!.decided_at));
      await (await rpc("E104")).terminateCase("cleanup", await cmdFor("A01"));
    } finally {
      await intro.dispose();
    }
  });
});
