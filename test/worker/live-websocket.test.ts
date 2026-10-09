import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CaseState } from "../../src/shared/agent-state.ts";
import { env } from "cloudflare:workers";
import { call, tokenFor } from "../helpers/api.ts";
import { emailOf, mintAccessToken } from "../helpers/auth.ts";
import { managerOf } from "../helpers/workflow.ts";

type Msg = { type: string; state?: unknown; error?: string; agent?: string; name?: string };

async function connect(path: string, as: string, origin: string | null = "http://localhost", extra: Record<string, string> = {}, token?: string) {
  const headers: Record<string, string> = { ...extra, Upgrade: "websocket", "Cf-Access-Jwt-Assertion": token ?? (await tokenFor(as)) };
  if (origin) headers.Origin = origin;
  const res = await exports.default.fetch(new Request(`http://localhost${path}`, { headers }));
  const ws = res.webSocket;
  const messages: Msg[] = [];
  let closeCode: number | null = null;
  if (ws) {
    ws.accept();
    ws.addEventListener("message", (e) => {
      messages.push(JSON.parse(String(e.data)) as Msg);
    });
    ws.addEventListener("close", (e) => {
      closeCode = e.code;
    });
  }
  return { status: res.status, ws, messages, closeCode: () => closeCode };
}

async function closedWith(c: { closeCode: () => number | null }, ms = 10_000): Promise<number> {
  const end = Date.now() + ms;
  for (;;) {
    const code = c.closeCode();
    if (code !== null) return code;
    if (Date.now() > end) throw new Error("socket still open");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function until(messages: Msg[], pred: (m: Msg) => boolean, ms = 5000): Promise<Msg> {
  const end = Date.now() + ms;
  for (;;) {
    const hit = messages.find(pred);
    if (hit) return hit;
    if (Date.now() > end) throw new Error(`no matching message in ${JSON.stringify(messages.map((m) => m.type))}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("live WebSocket subscriptions", () => {
  it("lets an employee subscribe to their own case: 101, identity, then state", async () => {
    const c = await connect("/agents/case-agent/E130", "E130");
    expect(c.status).toBe(101);
    await until(c.messages, (m) => m.type === "cf_agent_identity");
    const state = await until(c.messages, (m) => m.type === "cf_agent_state");
    expect(state.state).toBeDefined();
    c.ws?.close();
  });

  it("refuses another employee, foreign origins and missing origins, but admits the manager", async () => {
    expect((await connect("/agents/case-agent/E130", "E131")).status).toBe(403);
    expect((await connect("/agents/case-agent/E130", "E130", "https://evil.example")).status).toBe(403);
    expect((await connect("/agents/case-agent/E130", "E130", null)).status).toBe(403);
    const m = await connect("/agents/case-agent/E130", await managerOf("E130"));
    expect(m.status).toBe(101);
    m.ws?.close();
    const coord = await connect("/agents/case-agent/E130", "C05");
    expect(coord.status).toBe(101);
    coord.ws?.close();
  });

  it("limits the hub to coordinators and admins", async () => {
    expect((await connect("/agents/ops-hub-agent/global", "E130")).status).toBe(403);
    expect((await connect("/agents/ops-hub-agent/global", await managerOf("E130"))).status).toBe(403);
    const c = await connect("/agents/ops-hub-agent/global", "C03");
    expect(c.status).toBe(101);
    c.ws?.close();
    expect((await connect("/agents/ops-hub-agent/other", "A01")).status).toBe(403);
  });

  it("refuses invalid or unknown names, so no arbitrary Durable Object is created", async () => {
    expect((await connect("/agents/case-agent/E999x", "A01")).status).toBe(403);
    expect((await connect("/agents/case-agent/E999", "A01")).status).toBe(403);
  });

  it("refuses sub-agent paths, so a case subscription never reaches another agent or a new facet", async () => {
    // E130 may subscribe to their own case, but nothing below it
    expect((await connect("/agents/case-agent/E130/sub/ops-hub-agent/global", "E130")).status).toBe(403);
    expect((await connect("/agents/case-agent/E130/sub/ops-hub-agent/attacker-chosen-1", "E130")).status).toBe(403);
    expect((await connect("/agents/case-agent/E130/sub/case-agent/E131", "E130")).status).toBe(403);
    expect((await connect("/agents/ops-hub-agent/global/sub/case-agent/E130", "A01")).status).toBe(403);
    expect((await connect("/agents/case-agent/E130/extra", "E130")).status).toBe(403);
  });

  it("ignores a forged sub-agent header: the socket stays on the requested case", async () => {
    const c = await connect("/agents/case-agent/E130", "E130", "http://localhost", {
      "x-cf-agents-subagent-url": "http://localhost/agents/case-agent/E130/sub/ops-hub-agent/hdr-facet",
      "x-agents-lifecycle-props": "e30",
    });
    expect(c.status).toBe(101);
    const identity = await until(c.messages, (m) => m.type === "cf_agent_identity");
    expect({ agent: identity.agent, name: identity.name }).toEqual({ agent: "case-agent", name: "E130" });
    c.ws?.close();
  });

  it("refuses sub-agent facets inside the agents themselves", async () => {
    for (const [ns, name] of [
      [env.CASE_AGENT, "E130"],
      [env.OPS_HUB_AGENT, "global"],
    ] as const) {
      const stub = ns.get(ns.idFromName(name));
      const res = await stub.fetch(new Request(`http://localhost/agents/x/${name}/sub/ops-hub-agent/direct`, { headers: { Upgrade: "websocket" } }));
      // the SDK upgrades a refused sub-agent socket only to close it with 4000 + status
      const ws = res.webSocket!;
      const messages: Msg[] = [];
      const closed = new Promise<number>((resolve) => ws.addEventListener("close", (e) => resolve(e.code)));
      ws.addEventListener("message", (e) => messages.push(JSON.parse(String(e.data)) as Msg));
      ws.accept();
      expect(await closed).toBe(4404);
      expect(messages.filter((m) => m.type === "cf_agent_identity")).toEqual([]);
    }
  });

  it("refuses non-upgrade requests and unauthenticated upgrades", async () => {
    const plain = await exports.default.fetch(new Request("http://localhost/agents/case-agent/E130", { headers: { "Cf-Access-Jwt-Assertion": await tokenFor("A01") } }));
    expect(plain.status).toBe(403);
    const anon = await exports.default.fetch(new Request("http://localhost/agents/case-agent/E130", { headers: { Upgrade: "websocket", Origin: "http://localhost" } }));
    expect(anon.status).toBe(401);
  });

  it("pushes a new state frame after a task completion and rejects client state writes", async () => {
    const c = await connect("/agents/case-agent/E132", "E132");
    expect(c.status).toBe(101);
    await until(c.messages, (m) => m.type === "cf_agent_state");
    // give the case one open employee task and let the agent project it (a scan refreshes the state)
    await env.DB.prepare(
      "INSERT INTO tasks (id, employee_id, stage_id, kind, template_key, assignee, title, description, status, created_at) VALUES ('chk:E132:w4','E132','paperwork','checklist','w4','employee','W-4','d','open',?)",
    )
      .bind(new Date().toISOString())
      .run();
    expect((await call("/api/cases/E132/scan", { as: "A01", body: {} })).status).toBe(200);
    const open = (await until(c.messages, (m) => m.type === "cf_agent_state" && (m.state as CaseState).openTasks.employee === 1)).state as CaseState;
    const before = c.messages.length;
    // the employee completes the task through the API; the agent pushes the new projection
    const done = await call("/api/tasks/chk:E132:w4/complete", { as: "E132", body: {} });
    expect(done.status).toBe(200);
    // poll the live list from the index reached before the completion, so a frame that arrives late is still seen
    const pushed = await until(c.messages, (m) => c.messages.indexOf(m) >= before && m.type === "cf_agent_state" && (m.state as CaseState).openTasks.employee === 0);
    const next = pushed.state as CaseState;
    expect(next.employeeId).toBe("E132");
    expect(next.asOfSeq).toBeGreaterThan(open.asOfSeq);
    // a client write is refused
    c.ws?.send(JSON.stringify({ type: "cf_agent_state", state: { employeeId: "E132", status: "complete" } }));
    const err = await until(c.messages, (m) => m.type === "cf_agent_state_error");
    expect(err.type).toBe("cf_agent_state_error");
    c.ws?.close();
  });

  it("closes a case subscription once the account is deactivated, before pushing new state", async () => {
    const c = await connect("/agents/case-agent/E133", "C06");
    expect(c.status).toBe(101);
    await until(c.messages, (m) => m.type === "cf_agent_state");
    await env.DB.prepare("UPDATE app_users SET active = 0 WHERE email = ?").bind(await emailOf("C06")).run();
    const frames = c.messages.filter((m) => m.type === "cf_agent_state").length;
    // any change to the case refreshes its state; the agent re-checks subscribers first
    expect((await call("/api/cases/E133/scan", { as: "A01", body: {} })).status).toBe(200);
    expect(await closedWith(c)).toBe(4403);
    expect(c.messages.filter((m) => m.type === "cf_agent_state")).toHaveLength(frames);
    await env.DB.prepare("UPDATE app_users SET active = 1 WHERE email = ?").bind(await emailOf("C06")).run();
  });

  it("closes a subscription whose Access token expired", async () => {
    const token = await mintAccessToken(await emailOf("E134"), { expiresInS: 2 });
    const c = await connect("/agents/case-agent/E134", "E134", "http://localhost", {}, token);
    expect(c.status).toBe(101);
    await until(c.messages, (m) => m.type === "cf_agent_state");
    await new Promise((r) => setTimeout(r, 2500));
    expect((await call("/api/cases/E134/scan", { as: "A01", body: {} })).status).toBe(200);
    expect(await closedWith(c)).toBe(4401);
  });

  it("closes a dashboard subscription when the coordinator loses the role, and keeps the others", async () => {
    const stays = await connect("/agents/ops-hub-agent/global", "A02");
    const goes = await connect("/agents/ops-hub-agent/global", "C04");
    expect([stays.status, goes.status]).toEqual([101, 101]);
    await until(goes.messages, (m) => m.type === "cf_agent_state");
    // a coordinator demoted to a role without dashboard access (the staff row changes with it)
    await env.DB.batch([
      env.DB.prepare("UPDATE staff SET kind = 'manager', department = NULL WHERE id = 'C04'"),
      env.DB.prepare("UPDATE app_users SET role = 'manager' WHERE staff_id = 'C04'"),
    ]);
    // a case change makes the hub reconcile (debounced), which re-checks subscribers before pushing
    expect((await call("/api/cases/E135/scan", { as: "A01", body: {} })).status).toBe(200);
    expect(await closedWith(goes)).toBe(4403);
    expect(stays.closeCode()).toBeNull();
    stays.ws?.close();
  });
});
