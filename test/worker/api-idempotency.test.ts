import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CaseAgent } from "../../src/worker/agents/case-agent.ts";
import { api } from "../helpers/api.ts";
import { setFault } from "../helpers/sims.ts";
import { caseAgent, fastWorkflows, managerOf, waitFor, waitForStage } from "../helpers/workflow.ts";

const DB = env.DB;
const auditCount = async (employeeId: string, action: string) =>
  (await DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE employee_id = ? AND action = ?").bind(employeeId, action).first<{ n: number }>())!.n;

async function twice(path: string, as: string, body: unknown, key: string) {
  const a = await api(path, { as, body, idempotencyKey: key });
  const b = await api(path, { as, body, idempotencyKey: key });
  expect(b.status).toBe(a.status);
  expect(b.body).toEqual(a.body);
  expect(a.headers.get("Idempotent-Replayed")).toBeNull();
  expect(b.headers.get("Idempotent-Replayed")).toBe("true");
  return a;
}

describe("Idempotency-Key on API mutations", () => {
  it("replays start, task completion, decision, resubmit and retry with one side effect and one audit row each", async () => {
    const intro = await fastWorkflows();
    try {
      const id = "E150";
      const start = await twice(`/api/cases/${id}/start`, "C01", {}, "k-start");
      expect(start).toMatchObject({ status: 202, body: { instanceId: `onb-${id}-1`, created: true } });
      expect(await auditCount(id, "case.started")).toBe(1);

      await waitForStage(id, "paperwork", "waiting_on_employee");
      const task = `chk:${id}:w4`;
      expect((await twice(`/api/tasks/${task}/complete`, id, {}, "k-task")).status).toBe(200);
      expect((await DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE entity_id = ? AND action = 'task.completed'").bind(task).first<{ n: number }>())!.n).toBe(1);
      expect((await DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE entity_id = ? AND action = 'task.completion_conflict'").bind(task).first<{ n: number }>())!.n).toBe(0);
      // a new key on the same, now done, task is a real conflict
      expect((await api(`/api/tasks/${task}/complete`, { as: id, body: {} })).status).toBe(409);

      for (const t of ["offer_docs", "i9_section1", "direct_deposit", "emergency_contact", "badge_photo"]) {
        expect((await api(`/api/tasks/chk:${id}:${t}/complete`, { as: id, body: {} })).status).toBe(200);
      }
      const manager = await managerOf(id);
      const apr = `apr:${id}:manager_approval:1`;
      await waitFor(() => DB.prepare("SELECT 1 AS ok FROM approvals WHERE id = ? AND status = 'pending'").bind(apr).first(), { what: "approval" });
      expect((await twice(`/api/approvals/${apr}/decision`, manager, { decision: "reject", reason: "wrong laptop" }, "k-decide")).status).toBe(200);
      expect(await auditCount(id, "approval.rejected")).toBe(1);
      expect(await auditCount(id, "approval.decision_conflict")).toBe(0);

      await waitForStage(id, "manager_approval", "revision_requested");
      expect((await twice(`/api/approvals/${apr}/resubmit`, "C01", { note: "fixed" }, "k-resubmit")).body).toEqual({ round: 2 });
      expect(await auditCount(id, "approval.resubmitted")).toBe(1);

      await setFault({ system: "it", operation: "create-account", employeeRef: id, fault: "fail_503" });
      const apr2 = `apr:${id}:manager_approval:2`;
      await waitFor(() => DB.prepare("SELECT 1 AS ok FROM approvals WHERE id = ? AND status = 'pending'").bind(apr2).first(), { what: "approval round 2" });
      expect((await api(`/api/approvals/${apr2}/decision`, { as: manager, body: { decision: "approve" } })).status).toBe(200);
      await waitForStage(id, "it_provisioning", "blocked");
      expect((await twice(`/api/cases/${id}/stages/it_provisioning/retry`, "C03", {}, "k-retry")).body).toEqual({ round: 2 });
      expect(await auditCount(id, "stage.retry_requested")).toBe(1);
      expect(await auditCount(id, "stage.retry_rejected")).toBe(0);
      await api(`/api/cases/${id}/terminate`, { as: "A01", body: { reason: "cleanup" } });
    } finally {
      await intro.dispose();
    }
  });

  it("never executes a concurrent duplicate twice: the loser sees idempotency_in_progress or the replay", async () => {
    const id = "E145";
    const results = await Promise.all([0, 1, 2].map(() => api(`/api/cases/${id}/terminate`, { as: "A01", body: { reason: "dup" }, idempotencyKey: "k-concurrent" })));
    const statuses = results.map((r) => r.status);
    // not started: the one execution is a clean 409; duplicates replay it or are told it is in flight
    expect(statuses.every((s) => s === 409)).toBe(true);
    const codes = results.map((r) => (r.body as { error: { code: string } }).error.code).sort();
    expect(codes.filter((c) => c === "case_finished").length + codes.filter((c) => c === "idempotency_in_progress").length).toBe(3);
    expect(results.filter((r) => r.headers.get("Idempotent-Replayed") === "true" || (r.body as { error: { code: string } }).error.code === "idempotency_in_progress").length).toBeGreaterThanOrEqual(2);
  });

  it("rejects the same key with a different body", async () => {
    await api("/api/cases/E146/scan", { as: "C01", body: {}, idempotencyKey: "k-reuse" });
    const reused = await api("/api/cases/E146/terminate", { as: "A01", body: { reason: "x" }, idempotencyKey: "k-reuse" });
    // keys are scoped per actor: A01 never used k-reuse, so this executes normally
    expect(reused.status).toBe(409);
    const sameActor = await api("/api/cases/E146/stages/intake/retry", { as: "C01", body: { note: "different" }, idempotencyKey: "k-reuse" });
    expect(sameActor.status).toBe(422);
    expect(sameActor.body).toMatchObject({ error: { code: "idempotency_key_reuse" } });
  });

  it("stores the restart response in its batch: a failure after the commit is retried later and a same-key retry replays", async () => {
    const intro = await fastWorkflows();
    try {
      const id = "E144";
      expect((await api(`/api/cases/${id}/start`, { as: "C01", body: {} })).status).toBe(202);
      await waitForStage(id, "paperwork", "waiting_on_employee");
      const stub = await caseAgent(id);
      await runInDurableObject(stub, (agent: CaseAgent) => {
        const real = agent.control;
        let failCreate = true;
        agent.control = {
          ensureInstance: async (instanceId, emp, limits) => {
            if (failCreate) {
              failCreate = false;
              throw new Error("simulated create outage after the revision commit");
            }
            return real.ensureInstance(instanceId, emp, limits);
          },
          restart: async () => {
            throw new Error("instance.cannot_restart: simulated platform refusal");
          },
          terminate: (instanceId) => real.terminate(instanceId),
          status: (instanceId) => real.status(instanceId),
        };
      });
      const first = await api(`/api/cases/${id}/restart`, { as: "A01", body: { reason: "operator restart" }, idempotencyKey: "k-restart" });
      expect(first).toMatchObject({ status: 202, body: { runNo: 2, instanceId: `onb-${id}-2` } });
      const second = await api(`/api/cases/${id}/restart`, { as: "A01", body: { reason: "operator restart" }, idempotencyKey: "k-restart" });
      expect(second.status).toBe(202);
      expect(second.headers.get("Idempotent-Replayed")).toBe("true");
      expect(second.body).toEqual(first.body);
      expect(await DB.prepare("SELECT run_no, revision, workflow_instance_id FROM cases WHERE employee_id = ?").bind(id).first()).toEqual({
        run_no: 2,
        revision: 2,
        workflow_instance_id: `onb-${id}-2`,
      });
      expect(await auditCount(id, "case.restarted")).toBe(1);
      expect(await auditCount(id, "case.revision_created")).toBe(1);
      // the scheduled retry creates the new revision's instance, which replays the case under run 2
      await waitFor(
        () => DB.prepare("SELECT 1 AS ok FROM integration_calls WHERE employee_id = ? AND run_no = 2").bind(id).first(),
        { what: "run 2 of the new revision", timeoutMs: 45_000 },
      );
      expect(await auditCount(id, "case.revision_created")).toBe(1);
      await api(`/api/cases/${id}/terminate`, { as: "A01", body: { reason: "cleanup" } });
    } finally {
      await intro.dispose();
    }
  });

  it("releases the key after a 5xx so a retry with the same key executes", async () => {
    const stub = await caseAgent("E147");
    let fail = true;
    await runInDurableObject(stub, (agent: CaseAgent) => {
      const real = agent.control;
      agent.control = {
        ...real,
        ensureInstance: async (id, emp, limits) => {
          if (fail) {
            fail = false;
            throw new Error("simulated create outage");
          }
          return { created: true };
        },
        restart: (id) => real.restart(id),
        terminate: (id) => real.terminate(id),
        status: (id) => real.status(id),
      };
    });
    const first = await api("/api/cases/E147/start", { as: "C01", body: {}, idempotencyKey: "k-5xx" });
    expect(first.status).toBe(503);
    const second = await api("/api/cases/E147/start", { as: "C01", body: {}, idempotencyKey: "k-5xx" });
    expect(second.status).toBe(202);
    expect(second.headers.get("Idempotent-Replayed")).toBeNull();
    expect(second.body).toEqual({ instanceId: "onb-E147-1", created: true });
    const third = await api("/api/cases/E147/start", { as: "C01", body: {}, idempotencyKey: "k-5xx" });
    expect(third.headers.get("Idempotent-Replayed")).toBe("true");
  });
});
