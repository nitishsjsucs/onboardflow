import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api } from "../helpers/api.ts";
import { clearFaults, setFault } from "../helpers/sims.ts";
import {
  cmdFor,
  completeEmployeeTasks,
  decide,
  driveThroughManagerApproval,
  fastWorkflows,
  finishFromOrientation,
  managerOf,
  rpc,
  sleep,
  stageRow,
  startCase,
  waitFor,
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
      const blocker = await waitFor(
        () => DB.prepare("SELECT id, owner_department, subject FROM blockers WHERE employee_id = 'E100' AND kind = 'approval_rejected'").first<{ id: string; owner_department: string; subject: string }>(),
        { what: "approval_rejected blocker" },
      );
      expect(blocker).toMatchObject({ owner_department: "people_ops", subject: "apr:E100:manager_approval:1" });
      const fu = await DB.prepare("SELECT title, assignee FROM tasks WHERE blocker_id = ?").bind(blocker.id).first<{ title: string; assignee: string }>();
      expect(fu!.assignee).toBe("people_ops");
      expect(fu!.title).toMatch(/^Revise and resubmit/);
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
      expect(await DB.prepare("SELECT status FROM blockers WHERE employee_id = 'E100' AND kind = 'approval_rejected'").first()).toEqual({ status: "resolved" });
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

  it("gives closeout's activation its full recovery rounds when the sign-off took two rounds", async () => {
    const intro = await fastWorkflows();
    try {
      await setFault({ system: "hr", operation: "activate-worker", employeeRef: "E106", fault: "fail_503" });
      await toManagerApproval("E106");
      expect((await decide("E106", "manager_approval", "approve", await managerOf("E106"))).status).toBe(200);
      await waitForStage("E106", "orientation", "waiting_on_employee");
      await completeEmployeeTasks("E106", "orientation");
      expect((await decide("E106", "closeout", "reject", "C01")).status).toBe(200);
      await waitForStage("E106", "closeout", "revision_requested");
      expect((await (await rpc("E106")).resubmitApproval("apr:E106:closeout:1", await cmdFor("C01"), "fixed")).status).toBe(202);
      expect((await decide("E106", "closeout", "approve", "C01", { round: 2 })).status).toBe(200);
      // activation rounds count from the approval round (2): rounds 2, 3 and 4 block, and the case is still alive
      for (const round of [2, 3, 4]) {
        await waitFor(async () => {
          const s = await stageRow("E106", "closeout");
          return (s?.status === "blocked" && s.round === round) || null;
        }, { what: `closeout blocked in round ${round}` });
        if (round < 4) expect((await (await rpc("E106")).retryStage("closeout", await cmdFor("C01"))).status).toBe(202);
      }
      expect((await DB.prepare("SELECT status FROM cases WHERE employee_id = 'E106'").first<{ status: string }>())!.status).toBe("blocked");
      await clearFaults("E106");
      expect((await (await rpc("E106")).retryStage("closeout", await cmdFor("C01"))).status).toBe(202);
      expect((await waitForCase("E106", ["complete", "failed"])).status).toBe("complete");
      expect(await stageRow("E106", "closeout")).toMatchObject({ status: "complete", round: 5 });
      expect((await approvals("E106")).filter((a) => (a as { id: string }).id.includes("closeout")).length).toBe(2);
    } finally {
      await intro.dispose();
    }
  });

  it("does not start provisioning before the manager decides", async () => {
    const intro = await fastWorkflows();
    try {
      await toManagerApproval("E104");
      // paused at the checkpoint: give the workflow well over one bounded wait (1 s in tests) to move on wrongly
      await sleep(2500);
      const early = await DB.prepare("SELECT COUNT(*) AS n FROM integration_calls WHERE employee_id = 'E104' AND operation LIKE 'it.%'").first<{ n: number }>();
      expect(early!.n).toBe(0);
      expect((await stageRow("E104", "it_provisioning"))!.status).toBe("pending");
      expect((await stageRow("E104", "manager_approval"))!.status).toBe("awaiting_approval");

      expect((await decide("E104", "manager_approval", "approve", await managerOf("E104"))).status).toBe(200);
      const first = await waitFor(
        () => DB.prepare("SELECT created_at, latency_ms FROM integration_calls WHERE employee_id = 'E104' AND operation LIKE 'it.%' ORDER BY created_at LIMIT 1").first<{ created_at: string; latency_ms: number }>(),
        { what: "E104 first IT call" },
      );
      const decided = await DB.prepare("SELECT decided_at FROM approvals WHERE id = 'apr:E104:manager_approval:1'").first<{ decided_at: string | null }>();
      expect(decided?.decided_at).toBeTruthy();
      // a call row is written when the call returns, so compare the call's start (created_at - latency) with the decision
      expect(Date.parse(first.created_at) - first.latency_ms).toBeGreaterThanOrEqual(Date.parse(decided!.decided_at!));
      await (await rpc("E104")).terminateCase("cleanup", await cmdFor("A01"));
    } finally {
      await intro.dispose();
    }
  });

  it("locks the license bundle once the manager's approval is requested, except to correct an open data issue", async () => {
    const intro = await fastWorkflows();
    const fix = (value: string) => api("/api/employees/E105", { as: "C03", method: "PATCH", body: { licenseBundle: value } });
    try {
      // before any approval request the IT coordinator may change it (here to a bundle the IT system will reject)
      expect((await fix("contractor-basic")).status).toBe(200);
      await toManagerApproval("E105");
      const locked = await fix("ft-engineering");
      expect(locked.status).toBe(409);
      expect(locked.body.error.code).toBe("field_locked_by_approval");

      expect((await decide("E105", "manager_approval", "approve", await managerOf("E105"))).status).toBe(200);
      expect((await fix("ft-engineering")).status).toBe(409);
      // the IT system rejects the approved bundle; the scan opens a data_issue blocker on it, and only then may it be corrected
      await waitForStage("E105", "it_provisioning", "blocked");
      await (await rpc("E105")).scanNow(await cmdFor("A01"));
      await waitFor(() => DB.prepare("SELECT 1 AS ok FROM blockers WHERE employee_id = 'E105' AND kind = 'data_issue' AND status = 'open'").first(), { what: "E105 data issue" });
      expect((await fix("ft-standard")).status).toBe(200);
      expect((await api("/api/cases/E105/stages/it_provisioning/retry", { as: "C03", body: {} })).status).toBe(202);
      await waitForStage("E105", "it_provisioning", "complete");
      await waitFor(() => DB.prepare("SELECT 1 AS ok FROM blockers WHERE employee_id = 'E105' AND kind = 'data_issue' AND status <> 'open'").first(), { what: "E105 data issue resolved" });
      expect((await fix("ft-engineering")).status).toBe(409);

      const corrected = await DB.prepare("SELECT detail_json FROM audit_events WHERE employee_id = 'E105' AND action = 'employee.field_corrected' ORDER BY seq").all<{ detail_json: string }>();
      expect(corrected.results.map((r) => (JSON.parse(r.detail_json) as { after: string }).after)).toEqual(["contractor-basic", "ft-standard"]);
      await (await rpc("E105")).terminateCase("cleanup", await cmdFor("A01"));
    } finally {
      await intro.dispose();
    }
  });
});
