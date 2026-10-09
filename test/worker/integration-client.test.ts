import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseConfig } from "../../src/worker/config.ts";
import { SystemClock } from "../../src/worker/db/clock.ts";
import { getEmployee } from "../../src/worker/db/repo.ts";
import { type CallScope, type Fetcher, IntegrationClient, parseRetryAfter } from "../../src/worker/integrations/client.ts";
import {
  classifyFailure,
  errorMessage,
  isEngineAbort,
  rethrowIfEngineAbort,
  retryAfterFrom,
} from "../../src/worker/integrations/errors.ts";
import { assignWorkspace, preferenceOrder } from "../../src/worker/integrations/facilities.ts";
import { createWorker } from "../../src/worker/integrations/hr.ts";
import { setFault } from "../helpers/sims.ts";

const Schema = z.object({ id: z.string(), status: z.string() });
const config = parseConfig(env);
let n = 0;
const scope = (employeeId = "E010", attempt = 1): CallScope => ({
  employeeId,
  instanceId: `onb-${employeeId}-1`,
  runNo: 1,
  stepName: `test.step-${++n}`,
  attempt,
});

function fake(status: number, body: unknown, headers: Record<string, string> = {}): Fetcher {
  return async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

async function outcomeOf(fetcher: Fetcher, operation: "hr.create-worker" | "facilities.assign-workspace" = "hr.create-worker") {
  const s = scope();
  const client = new IntegrationClient(env.DB, config, new SystemClock(), s, fetcher);
  let error: unknown = null;
  try {
    await client.call({ operation, path: "/v1/x", body: { preference: "quiet-zone" }, idempotencyKey: "k", schema: Schema });
  } catch (e) {
    error = e;
  }
  const row = await env.DB.prepare("SELECT outcome, http_status, retry_after_ms FROM integration_calls WHERE step_name = ?")
    .bind(s.stepName)
    .first<{ outcome: string; http_status: number | null; retry_after_ms: number | null }>();
  return { error, row, scope: s };
}

describe("classification", () => {
  it("2xx with a valid body is ok, and Idempotent-Replayed marks replays", async () => {
    expect((await outcomeOf(fake(201, { id: "a", status: "x" }))).row?.outcome).toBe("ok");
    expect((await outcomeOf(fake(201, { id: "a", status: "x" }, { "Idempotent-Replayed": "true" }))).row?.outcome).toBe("replayed");
  });

  it("2xx with a body that fails the schema is malformed and retryable", async () => {
    const r = await outcomeOf(fake(200, { ok: "maybe" }));
    expect(r.row?.outcome).toBe("malformed");
    expect(errorMessage(r.error)).toMatch(/^retryable:malformed hr\.create-worker http=200/);
    expect((await outcomeOf(fake(200, "<html>"))).row?.outcome).toBe("malformed");
  });

  it.each([408, 425, 429, 500, 502, 503, 504])("%i is retryable_error", async (status) => {
    const r = await outcomeOf(fake(status, { error: { code: "x" } }));
    expect(r.row).toMatchObject({ outcome: "retryable_error", http_status: status });
    expect(classifyFailure(r.error)).toMatchObject({ class: "retryable", system: "hr", operation: "hr.create-worker", httpStatus: status });
  });

  it("a network error is retryable_error", async () => {
    const r = await outcomeOf(async () => {
      throw new TypeError("connection reset");
    });
    expect(r.row).toMatchObject({ outcome: "retryable_error", http_status: null });
  });

  it("409 on facilities.assign-workspace is a conflict; other 4xx are fatal NonRetryableErrors", async () => {
    const conflict = await outcomeOf(fake(409, { error: { code: "desk_conflict" } }), "facilities.assign-workspace");
    expect(conflict.row?.outcome).toBe("conflict");
    expect(classifyFailure(conflict.error).class).toBe("conflict");
    const r = await outcomeOf(fake(422, { error: { code: "validation_failed", field: "costCenter", message: "bad" } }));
    expect(r.row).toMatchObject({ outcome: "fatal_error", http_status: 422 });
    expect((r.error as Error).name).toBe("NonRetryableError");
    expect(classifyFailure(r.error)).toMatchObject({ class: "fatal", field: "costCenter", httpStatus: 422 });
    // the same message after crossing a step boundary
    expect(classifyFailure(`Error: NonRetryableError: ${errorMessage(r.error)}`)).toMatchObject({ class: "fatal", field: "costCenter" });
    expect((await outcomeOf(fake(409, { error: {} }))).row?.outcome).toBe("fatal_error");
    expect((await outcomeOf(fake(404, { error: {} }))).row?.outcome).toBe("fatal_error");
  });
});

describe("engine aborts", () => {
  it("are recognised with or without Error: prefixes and rethrown untouched", () => {
    for (const m of ["Aborting engine: User called restart", "Error: Aborting engine: terminate", "Error: Error: Aborting engine: pause"]) {
      expect(isEngineAbort(new Error(m))).toBe(true);
      expect(() => rethrowIfEngineAbort(new Error(m))).toThrow(m);
    }
    expect(isEngineAbort(new Error("retryable:timeout x http=none: Aborting engine: no"))).toBe(false);
    expect(() => rethrowIfEngineAbort(new Error("retryable:..."))).not.toThrow();
  });
});

describe("Retry-After", () => {
  it("is parsed from retry-after-ms, seconds, or an HTTP date, and carried in the message", async () => {
    expect(parseRetryAfter(new Headers({ "retry-after-ms": "300", "Retry-After": "1" }))).toBe(300);
    expect(parseRetryAfter(new Headers({ "Retry-After": "2" }))).toBe(2000);
    const at = new Date(Date.now() + 5000).toUTCString();
    expect(parseRetryAfter(new Headers({ "Retry-After": at }))).toBeGreaterThan(3000);
    expect(parseRetryAfter(new Headers())).toBeNull();
    const r = await outcomeOf(fake(429, { error: { code: "rate_limited" } }, { "retry-after-ms": "250" }));
    expect(r.row).toMatchObject({ outcome: "retryable_error", retry_after_ms: 250 });
    expect(retryAfterFrom(errorMessage(r.error))).toBe(250);
    expect(retryAfterFrom(`Error: ${errorMessage(r.error)}`)).toBe(250);
    expect(retryAfterFrom("no hint")).toBe(0);
  });
});

describe("against the simulated systems over loopback", () => {
  it("enforces INTEGRATION_TIMEOUT_MS with AbortSignal.timeout", async () => {
    await setFault({ system: "hr", operation: "create-worker", employeeRef: "E011", fault: "timeout", remaining: 1 });
    const fast = { ...config, integrationTimeoutMs: 250 };
    const s = scope("E011");
    const client = new IntegrationClient(env.DB, fast, new SystemClock(), s);
    const e = (await getEmployee(env.DB, "E011"))!;
    const started = Date.now();
    const err = await createWorker(client, e).catch((x: unknown) => x);
    expect(Date.now() - started).toBeLessThan(450);
    expect(classifyFailure(err)).toMatchObject({ class: "retryable", outcome: "timeout" });
    const row = await env.DB.prepare("SELECT outcome FROM integration_calls WHERE step_name = ?").bind(s.stepName).first();
    expect(row).toEqual({ outcome: "timeout" });
    // the next attempt (fault consumed) succeeds with the same key
    const ok = await createWorker(new IntegrationClient(env.DB, fast, new SystemClock(), { ...s, attempt: 2 }), e);
    expect(ok.status).toBe(201);
  });

  it("writes exactly one integration_calls row and one integration.call audit row per attempt", async () => {
    await setFault({ system: "hr", operation: "create-worker", employeeRef: "E012", fault: "fail_503", remaining: 2 });
    const e = (await getEmployee(env.DB, "E012"))!;
    const base = scope("E012");
    for (let attempt = 1; attempt <= 3; attempt++) {
      await createWorker(new IntegrationClient(env.DB, config, new SystemClock(), { ...base, attempt }), e).catch(() => undefined);
    }
    const calls = await env.DB.prepare("SELECT id, attempt, outcome FROM integration_calls WHERE employee_id = 'E012' ORDER BY attempt").all<{ id: string; attempt: number; outcome: string }>();
    expect(calls.results.map((c) => [c.attempt, c.outcome])).toEqual([
      [1, "retryable_error"],
      [2, "retryable_error"],
      [3, "ok"],
    ]);
    expect(calls.results[0]!.id).toBe(`onb-E012-1:1:${base.stepName}:1`);
    const audits = await env.DB.prepare("SELECT id, entity_id FROM audit_events WHERE action = 'integration.call' AND employee_id = 'E012' ORDER BY seq").all<{ id: string; entity_id: string }>();
    expect(audits.results.map((a) => a.entity_id)).toEqual(calls.results.map((c) => c.id));
    expect(audits.results.map((a) => a.id)).toEqual(calls.results.map((c) => `ic:${c.id}`));
  });

  it("tries the next workspace preference after a desk conflict, inside one attempt", async () => {
    await setFault({ system: "facilities", operation: "assign-workspace", employeeRef: "E013", fault: "conflict_409", remaining: 1 });
    const e = (await getEmployee(env.DB, "E013"))!;
    const s = scope("E013");
    const r = await assignWorkspace(new IntegrationClient(env.DB, config, new SystemClock(), s), e);
    expect(r.preferencesTried).toBe(2);
    const rows = await env.DB.prepare("SELECT outcome FROM integration_calls WHERE employee_id = 'E013' ORDER BY created_at, id").all<{ outcome: string }>();
    expect(rows.results.map((x) => x.outcome)).toEqual(["conflict", "ok"]);
  });

  it("re-executes a conflict-moved assignment by replaying the stored preference, never a second desk", async () => {
    await setFault({ system: "facilities", operation: "assign-workspace", employeeRef: "E014", fault: "conflict_409", remaining: 1 });
    const e = (await getEmployee(env.DB, "E014"))!;
    const first = await assignWorkspace(new IntegrationClient(env.DB, config, new SystemClock(), scope("E014")), e);
    expect(first).toMatchObject({ preference: "quiet-zone", preferencesTried: 2, replayed: false });

    // a re-execution that does not know the stored preference: preference 1 gets 422 key reuse, preference 2 replays
    const blind = scope("E014");
    const again = await assignWorkspace(new IntegrationClient(env.DB, config, new SystemClock(), blind), e);
    expect(again).toMatchObject({ preference: "quiet-zone", replayed: true, data: first.data });
    const blindRows = await env.DB.prepare("SELECT outcome, http_status FROM integration_calls WHERE step_name LIKE ? ORDER BY id").bind(`${blind.stepName}%`).all<{ outcome: string; http_status: number }>();
    expect(blindRows.results).toEqual([
      { outcome: "fatal_error", http_status: 422 },
      { outcome: "replayed", http_status: 201 },
    ]);

    // the workflow passes the stored preference, so the replay is the first call
    const informed = scope("E014");
    const direct = await assignWorkspace(new IntegrationClient(env.DB, config, new SystemClock(), informed), e, { startWith: "quiet-zone" });
    expect(direct).toMatchObject({ preference: "quiet-zone", preferencesTried: 1, replayed: true, data: first.data });
    const ledgerRows = await env.DB.prepare("SELECT COUNT(*) AS n FROM sim_side_effects WHERE employee_ref = 'E014' AND operation = 'assign-workspace'").first<{ n: number }>();
    expect(ledgerRows!.n).toBe(1);
  });

  it("orders workspace preferences with the stored one first", () => {
    expect(preferenceOrder(null)).toEqual(["team-neighborhood", "quiet-zone", "any-available"]);
    expect(preferenceOrder("any-available")).toEqual(["any-available", "team-neighborhood", "quiet-zone"]);
    expect(preferenceOrder("unknown")).toEqual(["team-neighborhood", "quiet-zone", "any-available"]);
  });
});
