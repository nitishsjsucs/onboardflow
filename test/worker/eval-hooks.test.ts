import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { app } from "../../src/worker/app.ts";
import { api } from "../helpers/api.ts";
import { mintAccessToken, emailOf } from "../helpers/auth.ts";
import { caseAgent, fastWorkflows, waitForStage } from "../helpers/workflow.ts";

const DB = env.DB;

describe("eval hooks", () => {
  it("evicts a CaseAgent: 202, and it re-wakes with its state intact", async () => {
    const intro = await fastWorkflows();
    try {
      expect((await api("/api/cases/E030/start", { as: "C01", body: {} })).status).toBe(202);
      await waitForStage("E030", "paperwork", "waiting_on_employee");
      const before = await (await caseAgent("E030")).getSnapshot();
      const r = await api("/api/dev/agents/case/E030/evict", { as: "A01", body: {} });
      expect(r).toMatchObject({ status: 202, body: { evicted: true } });
      const after = await (await caseAgent("E030")).getSnapshot();
      expect(after.employeeId).toBe("E030");
      expect(after.stages).toEqual(before.stages);
      expect(after.workflow.instanceId).toBe("onb-E030-1");
      // the employee's checklist and live state still answer after the eviction
      expect((await api("/api/me/checklist", { as: "E030" })).status).toBe(200);
      expect((await DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'eval.agent_evicted' AND entity_id = 'E030'").first<{ n: number }>())!.n).toBe(1);
      expect((await api("/api/cases/E030/terminate", { as: "A01", body: { reason: "hook test" } })).status).toBe(202);
    } finally {
      await intro.dispose();
    }
  });

  it("evicts the hub: 202, and the next reconcile restores exact counts", async () => {
    const hub = await getAgentByName(env.OPS_HUB_AGENT, "global");
    await hub.reconcile();
    expect((await api("/api/dev/agents/hub/global/evict", { as: "A01", body: {} })).status).toBe(202);
    const state = await (await getAgentByName(env.OPS_HUB_AGENT, "global")).reconcile();
    const summary = await api("/api/dashboard/summary", { as: "A01" });
    expect(state.totals).toEqual(summary.body.totals);
    const snap = await api("/api/dev/eval/hub", { as: "A01" });
    expect(snap.status).toBe(200);
    expect(snap.body.totals).toEqual(summary.body.totals);
  });

  it("sets and clears fault plans, advances the simulated clock, corrupts a field", async () => {
    const f = await api("/api/dev/faults", { as: "A01", body: { system: "it", operation: "order-device", employeeRef: "E031", fault: "fail_503", remaining: 2 } });
    expect(f.status).toBe(200);
    expect(await DB.prepare("SELECT fault, remaining FROM sim_fault_plans WHERE id = ?").bind(f.body.id).first()).toEqual({ fault: "fail_503", remaining: 2 });
    expect((await api("/api/dev/faults?employeeRef=E031", { as: "A01", method: "DELETE" })).body).toEqual({ cleared: 1 });

    const before = (await env.DB.prepare("SELECT offset_ms FROM sim_clock WHERE id = 1").first<{ offset_ms: number }>())!.offset_ms;
    const clock = await api("/api/dev/clock/advance", { as: "A01", body: { ms: 49 * 3600_000 } });
    expect(clock.body).toEqual({ offsetMs: before + 49 * 3600_000 });
    // the same key replays instead of advancing twice
    const k = crypto.randomUUID();
    const once = await api("/api/dev/clock/advance", { as: "A01", body: { ms: 1000 }, idempotencyKey: k });
    const again = await api("/api/dev/clock/advance", { as: "A01", body: { ms: 1000 }, idempotencyKey: k });
    expect(again.body).toEqual(once.body);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");

    const corrupt = await api("/api/dev/employees/E031/corrupt", { as: "A01", method: "PATCH", body: { field: "costCenter", value: "NOT-A-CC" } });
    expect(corrupt.status).toBe(200);
    expect(corrupt.body.costCenter).toBe("NOT-A-CC");
    const photo = await api("/api/dev/employees/E031/corrupt", { as: "A01", method: "PATCH", body: { field: "photoOnFile", value: 0 } });
    expect(photo.body.photoOnFile).toBe(false);
  });

  it("dumps a full case snapshot", async () => {
    const s = await api("/api/dev/eval/snapshot/E030", { as: "A01" });
    expect(s.status).toBe(200);
    expect(Object.keys(s.body).sort()).toEqual(["approvals", "audit", "blockers", "case", "employeeId", "integrationCalls", "ledger", "provisioning", "stages", "tasks"].sort());
    expect(s.body.stages).toHaveLength(8);
    expect(s.body.ledger.length).toBeGreaterThan(0);
    expect(s.body.audit.length).toBeGreaterThan(0);
  });

  it("is admin only", async () => {
    expect((await api("/api/dev/eval/hub", { as: "C01" })).status).toBe(403);
    expect((await api("/api/dev/faults", { as: "C01", body: { system: "it", operation: "order-device", fault: "fail_503" } })).status).toBe(403);
  });

  it("returns 404 for every hook when EVAL_HOOKS=off", async () => {
    const token = await mintAccessToken(await emailOf("A01"));
    const call = async (path: string, method = "GET", body?: unknown) => {
      const ctx = createExecutionContext();
      const res = await app.fetch(
        new Request(`http://localhost${path}`, {
          method,
          headers: { "Cf-Access-Jwt-Assertion": token, Origin: "http://localhost", "X-OnboardFlow": "1", "Idempotency-Key": crypto.randomUUID(), "Content-Type": "application/json" },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
        { ...env, EVAL_HOOKS: "off" } as Env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return res.status;
    };
    expect(await call("/api/dev/eval/hub")).toBe(404);
    expect(await call("/api/dev/eval/snapshot/E030")).toBe(404);
    expect(await call("/api/dev/faults", "POST", { system: "it", operation: "x", fault: "fail_503" })).toBe(404);
    expect(await call("/api/dev/faults", "DELETE")).toBe(404);
    expect(await call("/api/dev/clock/advance", "POST", { ms: 1 })).toBe(404);
    expect(await call("/api/dev/employees/E030/corrupt", "PATCH", { field: "costCenter", value: "x" })).toBe(404);
    expect(await call("/api/dev/agents/case/E030/evict", "POST", {})).toBe(404);
    expect(await call("/sim/admin/ledger")).toBe(404);
  });
});

describe("eviction while a workflow is running", () => {
  it("does not strand the workflow: callbacks re-resolve the CaseAgent and the case completes", async () => {
    const { driveThroughManagerApproval, finishFromOrientation } = await import("../helpers/workflow.ts");
    const intro = await fastWorkflows();
    try {
      await driveThroughManagerApproval("E032");
      expect((await api("/api/dev/agents/case/E032/evict", { as: "A01", body: {} })).status).toBe(202);
      expect((await finishFromOrientation("E032")).status).toBe("complete");
      const state = await (await caseAgent("E032")).getSnapshot();
      expect(state.status).toBe("complete");
    } finally {
      await intro.dispose();
    }
  });
});
