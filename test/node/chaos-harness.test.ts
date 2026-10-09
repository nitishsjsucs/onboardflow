import { afterEach, describe, expect, it } from "vitest";
import { Harness } from "../../eval/harness/actions.ts";
import { control, type HarnessHealth } from "../../eval/harness/chaos.ts";
import type { EvalRun } from "../../eval/harness/metrics.ts";
import { renderResults } from "../../eval/harness/report.ts";
import { generateDataset } from "../../src/shared/synthetic/generate.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Fake server: /dev/login hands out a token; every other request gets the next scripted reply and its Idempotency-Key is recorded. */
function fakeServer(replies: Array<{ status: number; body: string }>) {
  const keys: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/dev/login")) return new Response(JSON.stringify({ token: "t" }), { status: 200 });
    keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
    const next = replies.shift() ?? { status: 500, body: "Error: Network connection lost." };
    return new Response(next.body, { status: next.status });
  }) as typeof fetch;
  const harness = new Harness("http://fake.test", generateDataset());
  // isolate control()'s own retry loop from the HTTP layer's transport retries (tested in eval-actions.test.ts)
  harness.transportDeadlineMs = 0;
  return { keys, harness };
}
const health = (): HarnessHealth => ({ controlRetries: 0, controlFailures: 0, botRequestErrors: 0, transportRetries: 0, transportFailures: 0 });

describe("chaos orchestrator control calls", () => {
  it("retry a runtime 500 and an in-progress 409 with the same Idempotency-Key until the hook answers", async () => {
    const { keys, harness } = fakeServer([
      { status: 500, body: "Error: Network connection lost.\n    at entry.worker.js" },
      { status: 409, body: JSON.stringify({ error: { code: "idempotency_in_progress", message: "in progress" } }) },
      { status: 200, body: JSON.stringify({ cleared: 2 }) },
    ]);
    const h = health();
    const r = await control(harness, "admin@x", h, "DELETE", "/api/dev/faults?ids=173,174");
    expect(r.status).toBe(200);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(h).toMatchObject({ controlRetries: 2, controlFailures: 0, botRequestErrors: 0 });
  });

  it("does not retry an answer from the app (a 4xx other than in-progress) and counts it as a control failure", async () => {
    const { keys, harness } = fakeServer([{ status: 422, body: JSON.stringify({ error: { code: "validation_failed", message: "bad" } }) }]);
    const h = health();
    await expect(control(harness, "admin@x", h, "POST", "/api/dev/faults", {})).rejects.toThrow("HTTP 422 validation_failed");
    expect(keys).toHaveLength(1);
    expect(h.controlFailures).toBe(1);
  });

  it("gives up after its deadline and counts the control failure", async () => {
    const { harness } = fakeServer([]);
    const h = health();
    await expect(control(harness, "admin@x", h, "POST", "/api/dev/clock/advance", { ms: 1 }, [200], 100)).rejects.toThrow(/gave up after 2 attempts/);
    expect(h).toMatchObject({ controlRetries: 1, controlFailures: 1, botRequestErrors: 0 });
  });

  it("accepts the caller's success statuses (a case start answers 202)", async () => {
    const { harness } = fakeServer([{ status: 202, body: JSON.stringify({ instanceId: "onb-E001-1", created: true }) }]);
    const r = await control(harness, "po@x", health(), "POST", "/api/cases/E001/start", {}, [202]);
    expect(r.body).toEqual({ instanceId: "onb-E001-1", created: true });
  });
});

describe("chaos results rendering", () => {
  const seedRow = (harness?: { controlRetries: number; controlFailures: number; botRequestErrors: number; transportRetries?: number }) =>
    renderResults([
      {
        runId: "r",
        startedAt: "2026-10-08T00:00:00.000Z",
        gitSha: "abcdef0",
        mode: "chaos",
        llmProvider: "stub",
        seeds: [3],
        environment: { runtime: "local wrangler dev (Miniflare/workerd)" },
        config: { concurrency: 10 },
        totals: { startedCases: 60, scenarios: 60, completed: 0, completionRate: 0, passed: 0, passRate: 0 },
        byCategory: {},
        chaos: { perSeed: [{ seed: 3, completed: 0, cases: 60, failures: { case_failed: 5, bot_patience: 0, deadline: 55 }, ...(harness ? { harness } : {}) }], meanCompletion: 0, minCompletion: 0, maxCompletion: 0 },
        integration: { calls: 0, retriedCalls: 0, replays: 0, duplicateSideEffects: 0 },
        followups: { llmSchemaValidRate: null },
        regression: { audit: { coverage: 1 }, hubConsistency: { matchesReconcile: true } },
        timing: { scenarioP50Ms: 0, scenarioP95Ms: 0, totalMs: 0 },
      } as unknown as EvalRun,
    ])
      .split("\n")
      .find((l) => l.startsWith("| Seed 3 |"));

  it("flags a seed whose schedule was not fully applied, and shows the harness counters", () => {
    expect(seedRow({ controlRetries: 4, controlFailures: 1, botRequestErrors: 13 })).toBe(
      "| Seed 3 | 0/60; not completed: 5 failed, 0 bot patience, 55 deadline; harness: 4 control retries, 13 bot request errors, **1 control actions failed (schedule not fully applied)** |",
    );
    expect(seedRow({ controlRetries: 0, controlFailures: 0, botRequestErrors: 0 })).toBe(
      "| Seed 3 | 0/60; not completed: 5 failed, 0 bot patience, 55 deadline; harness: 0 control retries, 0 bot request errors |",
    );
  });

  it("shows transport retries when the seed recorded them", () => {
    expect(seedRow({ transportRetries: 7, controlRetries: 0, controlFailures: 0, botRequestErrors: 0 })).toBe(
      "| Seed 3 | 0/60; not completed: 5 failed, 0 bot patience, 55 deadline; harness: 7 transport retries, 0 control retries, 0 bot request errors |",
    );
  });

  it("renders runs recorded before the counters existed without them", () => {
    expect(seedRow()).toBe("| Seed 3 | 0/60; not completed: 5 failed, 0 bot patience, 55 deadline |");
  });
});
