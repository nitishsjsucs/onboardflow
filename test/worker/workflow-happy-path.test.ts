import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { FIRST_ROUND_OPERATIONS, OPERATIONS } from "../../src/shared/stages.ts";
import { ledger } from "../helpers/sims.ts";
import { auditActions, caseAgent, driveHappyPath, driveHappyPathViaApi, fastWorkflows } from "../helpers/workflow.ts";

describe("happy path through CaseAgent RPC", () => {
  it("runs all 8 stages to complete with one side effect per operation and every action audited", async () => {
    const intro = await fastWorkflows();
    try {
      const done = await driveHappyPath("E060");
      expect(done.status).toBe("complete");
    } finally {
      await intro.dispose();
    }
    const stages = await env.DB.prepare("SELECT stage_id, status FROM case_stages WHERE employee_id = 'E060'").all<{ status: string }>();
    expect(stages.results.every((s) => s.status === "complete")).toBe(true);

    // exactly one side effect per POST operation
    const posts = FIRST_ROUND_OPERATIONS.filter((op) => OPERATIONS[op].method === "POST");
    const effects = await ledger({ employeeRef: "E060" });
    expect(effects.map((e) => `${e.system}.${e.operation}`).sort()).toEqual([...posts].sort());

    // provisioning tracked to terminal status
    const prov = await env.DB.prepare("SELECT resource, status FROM provisioning_items WHERE employee_id = 'E060' ORDER BY resource").all<{ resource: string; status: string }>();
    expect(Object.fromEntries(prov.results.map((p) => [p.resource, p.status]))).toMatchObject({
      hr_worker: "active",
      hr_documents: "verified",
      it_device: "delivered",
      fac_badge: "active",
      hr_orientation: "enrolled",
    });

    // every integration call, task completion, decision and stage transition has its audit row
    const audit = await auditActions("E060");
    const count = (a: string) => audit.filter((x) => x.action === a).length;
    const calls = await env.DB.prepare("SELECT COUNT(*) AS n FROM integration_calls WHERE employee_id = 'E060'").first<{ n: number }>();
    expect(count("integration.call")).toBe(calls!.n);
    expect(count("task.created")).toBe(10);
    expect(count("task.completed")).toBe(10);
    expect(count("approval.requested")).toBe(2);
    expect(count("approval.approved")).toBe(2);
    expect(count("stage.started")).toBe(8);
    expect(count("stage.completed")).toBe(8);
    expect(count("case.started")).toBe(1);
    expect(count("case.completed")).toBe(1);
    expect(count("case.failed")).toBe(0);

    const state = await (await caseAgent("E060")).getSnapshot();
    expect(state.status).toBe("complete");
    expect(state.stages.map((s) => s.status)).toEqual(Array(8).fill("complete"));
  });
});

describe("happy path through the REST API", () => {
  it("completes a privileged engineer's onboarding driven by the four personas over HTTP", async () => {
    const priv = await env.DB.prepare("SELECT id FROM employees WHERE needs_privileged_access = 1 AND id > 'E060' ORDER BY id LIMIT 1").first<{ id: string }>();
    const id = priv!.id;
    const intro = await fastWorkflows();
    try {
      expect((await driveHappyPathViaApi(id)).status).toBe("complete");
    } finally {
      await intro.dispose();
    }
    const lic = await env.DB.prepare("SELECT data_json FROM sim_resources WHERE system = 'it' AND resource_type = 'it_licenses' AND employee_ref = ?").bind(id).first<{ data_json: string }>();
    expect(JSON.parse(lic!.data_json)).toMatchObject({ privileged: true });
    const audit = await auditActions(id);
    const userActions = audit.filter((a) => a.id.startsWith("usr:")).map((a) => a.action);
    expect(userActions.filter((a) => a === "task.completed")).toHaveLength(10);
    expect(userActions.filter((a) => a === "approval.approved")).toHaveLength(2);
    expect(userActions).toContain("case.started");
  });
});
