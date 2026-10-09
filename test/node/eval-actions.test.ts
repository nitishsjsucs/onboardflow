import { afterEach, describe, expect, it } from "vitest";
import { ALL_ACTIONS_SUPPORTED, executeAction, Harness, parseBody, type ScenarioRun, SUPPORTED_ACTIONS, UnknownActionError } from "../../eval/harness/actions.ts";
import { runScenario } from "../../eval/harness/run.ts";
import { SCENARIOS } from "../../eval/scenarios/index.ts";
import type { Action, Scenario } from "../../eval/scenarios/types.ts";
import { generateDataset } from "../../src/shared/synthetic/generate.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function kinds(actions: Action[]): string[] {
  return actions.flatMap((a) => (a.do === "duplicate" ? [a.do, ...kinds([a.action])] : a.do === "concurrent" ? [a.do, ...kinds(a.actions)] : [a.do]));
}

describe("action interpreter", () => {
  it("is exhaustive over the Action union (compile-time never check)", () => {
    expect(ALL_ACTIONS_SUPPORTED).toBe(true);
    expect(new Set(SUPPORTED_ACTIONS).size).toBe(SUPPORTED_ACTIONS.length);
  });

  it("supports every action the catalog uses", () => {
    const used = new Set(SCENARIOS.flatMap((s) => kinds(s.script)));
    for (const k of used) expect(SUPPORTED_ACTIONS as readonly string[]).toContain(k);
  });

  it("throws unknown_action for an action it does not know, before touching the network", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network must not be used");
    }) as typeof fetch;
    const h = new Harness("http://localhost:1", generateDataset());
    const run: ScenarioRun = { h, scenario: SCENARIOS[0]!, employeeId: "E001", notes: [], keys: { kind: "fresh" }, duplicatePass: false };
    await expect(executeAction(run, { do: "teleport" } as unknown as Action)).rejects.toThrow(UnknownActionError);
    await expect(executeAction(run, { do: "teleport" } as unknown as Action)).rejects.toThrow(/unknown_action: teleport/);
  });

  it("fails a scenario containing an unknown action with unknown_action instead of skipping it", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;
    const h = new Harness("http://localhost:1", generateDataset());
    const scenario: Scenario = {
      id: "X01",
      category: "onboarding",
      title: "contains an unknown action",
      employeeId: "E001",
      archetype: {},
      setup: [],
      script: [{ do: "start" }, { do: "teleport" } as unknown as Action],
      expect: { terminal: "complete" },
    };
    // "start" would hit the network first; put the unknown action first to keep the test offline
    scenario.script.reverse();
    const r = await runScenario(h, scenario, new Set());
    expect(r.passed).toBe(false);
    expect(r.failureReason).toBe("unknown_action");
    expect(r.failures.join(" ")).toContain("unknown_action: teleport");
  }, 10_000);
});

describe("response bodies", () => {
  it("parses JSON and reports a non-JSON body with the request and status", () => {
    expect(parseBody("GET", "/api/x", 200, '{"a":1}')).toEqual({ a: 1 });
    expect(parseBody("GET", "/api/x", 204, "")).toBeNull();
    expect(() => parseBody("POST", "/api/tasks/t1/complete", 500, "Error: Network connection lost.\n    at entry.worker.js:1")).toThrow(
      "POST /api/tasks/t1/complete: HTTP 500 with a non-JSON body: Error: Network connection lost.",
    );
  });
});

describe("transport retries", () => {
  function server(replies: Array<{ status: number; body: string } | "network">) {
    const seen: Array<{ path: string; key: string | null }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/dev/login") return new Response(JSON.stringify({ token: "t" }), { status: 200 });
      seen.push({ path: url.pathname, key: new Headers(init?.headers).get("Idempotency-Key") });
      const next = replies.shift() ?? { status: 200, body: "{}" };
      if (next === "network") throw new TypeError("fetch failed");
      return new Response(next.body, { status: next.status });
    }) as typeof fetch;
    return { seen, h: new Harness("http://fake.test", generateDataset()) };
  }
  const dropped = { status: 500, body: "Error: Network connection lost.\n    at entry.worker.js" };

  it("retries a dropped connection and a network error with the same Idempotency-Key, and counts them", async () => {
    const { seen, h } = server([dropped, "network", { status: 200, body: '{"ok":true}' }]);
    const r = await h.request("e@x", "POST", "/api/tasks/t1/complete", {});
    expect(r).toMatchObject({ status: 200, body: { ok: true } });
    expect(seen).toHaveLength(3);
    expect(new Set(seen.map((x) => x.key)).size).toBe(1);
    expect(h.transport).toEqual({ retries: 2, failures: 0 });
  });

  it("retries idempotency_in_progress only after a transport retry", async () => {
    const inProgress = { status: 409, body: JSON.stringify({ error: { code: "idempotency_in_progress", message: "x" } }) };
    const first = server([dropped, inProgress, { status: 200, body: "{}" }]);
    expect((await first.h.request("e@x", "POST", "/api/x", {})).status).toBe(200);
    expect(first.h.transport.retries).toBe(2);
    const direct = server([inProgress]);
    expect((await direct.h.request("e@x", "POST", "/api/x", {})).status).toBe(409);
    expect(direct.h.transport.retries).toBe(0);
  });

  it("never retries an answer from the app, including its own JSON 500", async () => {
    const { seen, h } = server([{ status: 500, body: JSON.stringify({ error: { code: "internal_error", message: "boom" } }) }]);
    const r = await h.request("e@x", "POST", "/api/x", {});
    expect(r.status).toBe(500);
    expect(seen).toHaveLength(1);
    expect(h.transport).toEqual({ retries: 0, failures: 0 });
  });

  it("gives up at its deadline, counts the failure and reports the body", async () => {
    const { h } = server([dropped, dropped, dropped]);
    h.transportDeadlineMs = 100;
    await expect(h.request("e@x", "POST", "/api/x", {})).rejects.toThrow("HTTP 500 with a non-JSON body: Error: Network connection lost.");
    expect(h.transport.failures).toBe(1);
  });
});
