import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CaseState } from "../../src/shared/agent-state.ts";
import { tokenFor } from "../helpers/api.ts";
import { cmdFor, managerOf, rpc } from "../helpers/workflow.ts";

type Msg = { type: string; state?: unknown; error?: string };

async function connect(path: string, as: string, origin: string | null = "http://localhost") {
  const headers: Record<string, string> = { Upgrade: "websocket", "Cf-Access-Jwt-Assertion": await tokenFor(as) };
  if (origin) headers.Origin = origin;
  const res = await exports.default.fetch(new Request(`http://localhost${path}`, { headers }));
  const ws = res.webSocket;
  const messages: Msg[] = [];
  if (ws) {
    ws.accept();
    ws.addEventListener("message", (e) => messages.push(JSON.parse(String(e.data)) as Msg));
  }
  return { status: res.status, ws, messages };
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
    const before = c.messages.length;
    // a command changes D1 and the agent pushes the new projection
    const agent = await rpc("E132");
    await agent.fixField("costCenter", "CC-4242", await cmdFor("C01"));
    const pushed = await until(c.messages.slice(before), (m) => m.type === "cf_agent_state");
    expect((pushed.state as CaseState).employeeId).toBe("E132");
    // a client write is refused
    c.ws?.send(JSON.stringify({ type: "cf_agent_state", state: { employeeId: "E132", status: "complete" } }));
    const err = await until(c.messages, (m) => m.type === "cf_agent_state_error");
    expect(err.type).toBe("cf_agent_state_error");
    c.ws?.close();
  });
});
