import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { HubState } from "../../src/shared/agent-state.ts";
import type { OpsHubAgent } from "../../src/worker/agents/ops-hub-agent.ts";
import { computeHubDomain } from "../../src/worker/agents/projection.ts";
import { api } from "../helpers/api.ts";
import { waitFor } from "../helpers/workflow.ts";

const DB = env.DB;
const hub = () => getAgentByName(env.OPS_HUB_AGENT, "global");

function domainOf(s: HubState) {
  const { asOfSeq: _a, reconciledAt: _r, version: _v, ...domain } = s;
  return domain;
}

async function fresh() {
  return (await computeHubDomain(DB, new Date().toISOString())).domain;
}

describe("OpsHubAgent", () => {
  it("debounces an out-of-order burst of caseChanged into one reconcile whose domain fields equal a fresh D1 read", async () => {
    const stub = await hub();
    // some real activity to aggregate
    await DB.batch([
      DB.prepare("UPDATE cases SET status = 'in_progress', workflow_instance_id = 'onb-E120-1' WHERE employee_id = 'E120'"),
      DB.prepare("UPDATE case_stages SET status = 'active' WHERE employee_id = 'E120' AND stage_id = 'intake'"),
      DB.prepare("UPDATE cases SET status = 'blocked', workflow_instance_id = 'onb-E121-1' WHERE employee_id = 'E121'"),
      DB.prepare("UPDATE case_stages SET status = 'blocked' WHERE employee_id = 'E121' AND stage_id = 'it_provisioning'"),
    ]);
    for (const [id, seq] of [["E121", 9], ["E120", 3], ["E121", 7], ["E120", 12], ["E122", 1]] as const) await stub.caseChanged(id, seq);
    const meta = await runInDurableObject(stub, (a: OpsHubAgent) => a.meta());
    expect(meta).toEqual({ dirty: 1, debounce_pending: 1 });
    // the debounced reconcile fires on the Agent's alarm after HUB_DEBOUNCE_S (1 s in tests)
    const state = await waitFor(async () => {
      const s = await stub.getSnapshot();
      return s.version >= 1 ? s : null;
    }, { timeoutMs: 10_000, what: "debounced reconcile" });
    expect(domainOf(state)).toEqual(await fresh());
    // the same comparison over HTTP: the live hub equals /api/dashboard/summary
    const summary = await api<HubState>("/api/dashboard/summary", { as: "C01" });
    expect(summary.status).toBe(200);
    expect(domainOf(state)).toEqual(domainOf(summary.body));
    expect(Object.values(state.totals).reduce((a, b) => a + b, 0)).toBe(150);
    expect(state.totals.blocked).toBe(1);
    expect(state.byStage).toHaveLength(8);
    expect(state.byStage.find((b) => b.stage === "it_provisioning")?.blocked).toBe(1);
    expect(await runInDurableObject(stub, (a: OpsHubAgent) => a.meta())).toEqual({ dirty: 0, debounce_pending: 0 });
  });

  it("detects a system incident when 3 cases are blocked on one system within 15 minutes", async () => {
    const now = new Date().toISOString();
    for (const id of ["E123", "E124", "E125"]) {
      await DB.prepare(
        `INSERT INTO blockers (id, employee_id, stage_id, kind, severity, owner_department, subject, dedupe_key, status, detail_json, detected_at)
         VALUES (?, ?, 'it_provisioning', 'integration_outage', 'high', 'it', 'it.order-device', ?, 'open', '{"system":"it"}', ?)`,
      )
        .bind(`blk:${id}`, id, `${id}:integration_outage:it_provisioning:it.order-device`, now)
        .run();
    }
    const state = await (await hub()).reconcile();
    expect(state.systemIncidents).toEqual([{ system: "it", openedAt: now, casesAffected: 3 }]);
    expect(state.blockersOpen.byKind.integration_outage).toBe(3);
    expect(state.blockersOpen.byDepartment.it).toBe(3);
  });

  it("never lets an older read overwrite newer state, and survives eviction (next reconcile equals a fresh read)", async () => {
    const stub = await hub();
    const before = await stub.reconcile();
    await runInDurableObject(stub, (a: OpsHubAgent) => {
      a.setState({ ...a.state, asOfSeq: a.state.asOfSeq + 1000, version: 99 });
    });
    const unchanged = await stub.reconcile();
    expect(unchanged.version).toBe(99);
    await runInDurableObject(stub, (a: OpsHubAgent) => {
      a.setState({ ...a.state, asOfSeq: before.asOfSeq });
    });
    await evictDurableObject(stub);
    const after = await (await hub()).reconcile();
    expect(domainOf(after)).toEqual(await fresh());
    expect(after.version).toBeGreaterThan(99);
  });

  it("is read-only for clients", async () => {
    await runInDurableObject(await hub(), (a: OpsHubAgent) => {
      expect(() => a.validateStateChange(a.state, {} as never)).toThrow(/read-only/);
      expect(a.shouldConnectionBeReadonly()).toBe(true);
    });
  });
});
