import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { app } from "../../src/worker/app.ts";
import { clearFaults, faultRemaining, ledger, setFault, sim, simJson, workerAndAccount, workerBody } from "../helpers/sims.ts";

const badge = (ref: string) => ({ employeeRef: ref, photoOnFile: true, accessLevel: "standard" });

describe("pre-execution faults (no side effect)", () => {
  it("fail_503 with remaining 2 fails twice, then the call executes", async () => {
    const id = await setFault({ system: "hr", operation: "create-worker", employeeRef: "Q001", fault: "fail_503", remaining: 2 });
    const k = "Q001:hr.create-worker";
    expect((await sim("/hr/v1/workers", { body: workerBody("Q001"), key: k })).status).toBe(503);
    expect((await sim("/hr/v1/workers", { body: workerBody("Q001"), key: k })).status).toBe(503);
    expect(await ledger({ employeeRef: "Q001" })).toHaveLength(0);
    expect((await sim("/hr/v1/workers", { body: workerBody("Q001"), key: k })).status).toBe(201);
    expect(await ledger({ employeeRef: "Q001" })).toHaveLength(1);
    expect(await faultRemaining(id)).toBe(0);
  });

  it("fail_503 with remaining NULL is a sustained outage until cleared", async () => {
    await setFault({ system: "it", operation: "create-account", employeeRef: "Q002", fault: "fail_503" });
    const body = { employeeRef: "Q002", upn: "q002@corp.test", displayName: "Q" };
    for (let i = 0; i < 6; i++) expect((await sim("/it/v1/accounts", { body, key: "Q002:a" })).status).toBe(503);
    expect(await clearFaults("Q002")).toBe(1);
    expect((await sim("/it/v1/accounts", { body, key: "Q002:a" })).status).toBe(201);
  });

  it("rate_limit_429 carries Retry-After and retry-after-ms", async () => {
    await setFault({ system: "facilities", operation: "issue-badge", employeeRef: "Q003", fault: "rate_limit_429", remaining: 1, params: { retryAfterMs: 300 } });
    const res = await sim("/facilities/v1/badges", { body: badge("Q003"), key: "Q003:b" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after-ms")).toBe("300");
    expect(res.headers.get("Retry-After")).toBe("1");
    expect(await ledger({ employeeRef: "Q003" })).toHaveLength(0);
    expect((await sim("/facilities/v1/badges", { body: badge("Q003"), key: "Q003:b" })).status).toBe(202);
  });

  it("timeout holds the request past the client timeout and has no side effect", async () => {
    const id = await setFault({ system: "facilities", operation: "issue-badge", employeeRef: "Q004", fault: "timeout", remaining: 1 });
    const started = Date.now();
    const err = await sim("/facilities/v1/badges", { body: badge("Q004"), key: "Q004:b", signal: AbortSignal.timeout(300) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await faultRemaining(id)).toBe(0);
    expect(await ledger({ employeeRef: "Q004" })).toHaveLength(0);
    expect((await sim("/facilities/v1/badges", { body: badge("Q004"), key: "Q004:b" })).status).toBe(202);
  });

  it("timeout answers 504 after 2 x INTEGRATION_TIMEOUT_MS when nobody aborts", async () => {
    await setFault({ system: "hr", operation: "create-worker", employeeRef: "Q005", fault: "timeout", remaining: 1 });
    const ctx = createExecutionContext();
    const started = Date.now();
    // a shorter integration timeout keeps this test fast; the fault waits 2x it
    const res = await app.fetch(
      new Request("http://localhost/sim/hr/v1/workers", {
        method: "POST",
        headers: { "X-Sim-Api-Key": env.SIM_API_KEY, "Idempotency-Key": "Q005:w", "Content-Type": "application/json" },
        body: JSON.stringify(workerBody("Q005")),
      }),
      { ...env, INTEGRATION_TIMEOUT_MS: "150" } as Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(504);
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    expect(await ledger({ employeeRef: "Q005" })).toHaveLength(0);
  });

  it("malformed answers 200 with a body that fails the client schema, and no side effect", async () => {
    await setFault({ system: "hr", operation: "create-worker", employeeRef: "Q006", fault: "malformed", remaining: 1 });
    const r = await simJson<Record<string, unknown>>("/hr/v1/workers", { body: workerBody("Q006"), key: "Q006:w" });
    expect(r.status).toBe(200);
    expect(r.body.id).toBeUndefined();
    expect(await ledger({ employeeRef: "Q006" })).toHaveLength(0);
  });

  it("conflict_409 rejects the requested workspace preference", async () => {
    await setFault({ system: "facilities", operation: "assign-workspace", employeeRef: "Q007", fault: "conflict_409", remaining: 1 });
    const body = { employeeRef: "Q007", workMode: "onsite", site: "New York", preference: "team-neighborhood" };
    const r = await simJson<{ error: { code: string } }>("/facilities/v1/workspace-assignments", { body, key: "Q007:ws" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("desk_conflict");
    expect(await ledger({ employeeRef: "Q007" })).toHaveLength(0);
    const alt = await simJson("/facilities/v1/workspace-assignments", { body: { ...body, preference: "quiet-zone" }, key: "Q007:ws" });
    expect(alt.status).toBe(201);
  });

  it("pre-faults fire even when the key is already stored", async () => {
    const k = "Q008:hr.create-worker";
    expect((await sim("/hr/v1/workers", { body: workerBody("Q008"), key: k })).status).toBe(201);
    await setFault({ system: "hr", operation: "create-worker", employeeRef: "Q008", fault: "fail_503", remaining: 1 });
    expect((await sim("/hr/v1/workers", { body: workerBody("Q008"), key: k })).status).toBe(503);
    const replay = await simJson("/hr/v1/workers", { body: workerBody("Q008"), key: k });
    expect(replay.replayed).toBe(true);
    expect(await ledger({ employeeRef: "Q008" })).toHaveLength(1);
  });

  it("only matches its own employee unless employeeRef is NULL", async () => {
    await setFault({ system: "hr", operation: "create-worker", employeeRef: "Q009", fault: "fail_503" });
    expect((await sim("/hr/v1/workers", { body: workerBody("Q010"), key: "Q010:w" })).status).toBe(201);
    await setFault({ system: "hr", operation: "create-worker", employeeRef: null, fault: "fail_503", remaining: 1 });
    expect((await sim("/hr/v1/workers", { body: workerBody("Q011"), key: "Q011:w" })).status).toBe(503);
    await clearFaults();
  });
});

describe("lost_response (post-execution)", () => {
  it("commits exactly one side effect, returns 500, and later attempts replay", async () => {
    const id = await setFault({ system: "it", operation: "order-device", employeeRef: "Q020", fault: "lost_response" });
    const { accountId } = await workerAndAccount("Q020");
    const body = { accountId, profile: "standard", shipTo: "Austin" };
    const k = "Q020:it.order-device";
    const first = await sim("/it/v1/device-orders", { body, key: k });
    expect(first.status).toBe(500);
    expect(await ledger({ employeeRef: "Q020", operation: "order-device" })).toHaveLength(1);
    // the plan is still active (remaining NULL), yet a replay never reaches the post phase
    const second = await simJson<{ status: string }>("/it/v1/device-orders", { body, key: k });
    expect(second.status).toBe(202);
    expect(second.replayed).toBe(true);
    expect(await ledger({ employeeRef: "Q020", operation: "order-device" })).toHaveLength(1);
    expect(await faultRemaining(id)).toBeNull();
  });
});

describe("stall (polling)", () => {
  it("keeps an async resource from advancing until cleared", async () => {
    const { accountId } = await workerAndAccount("Q030");
    const order = await simJson<{ id: string }>("/it/v1/device-orders", { body: { accountId, profile: "standard", shipTo: "Austin" }, key: "Q030:o" });
    await setFault({ system: "it", operation: "get-device-order", employeeRef: "Q030", fault: "stall" });
    for (let i = 0; i < 4; i++) expect((await simJson(`/it/v1/device-orders/${order.body.id}`)).body).toMatchObject({ status: "ordered" });
    await clearFaults("Q030");
    expect((await simJson(`/it/v1/device-orders/${order.body.id}`)).body).toMatchObject({ status: "processing" });
  });
});

describe("/sim/admin", () => {
  it("exists only with AUTH_MODE=dev and EVAL_HOOKS=on, and needs the sim key", async () => {
    const ctx = createExecutionContext();
    const off = await app.fetch(
      new Request("http://localhost/sim/admin/ledger", { headers: { "X-Sim-Api-Key": env.SIM_API_KEY } }),
      { ...env, EVAL_HOOKS: "off" } as Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(off.status).toBe(404);
    expect((await sim("/admin/ledger", { apiKey: "wrong" })).status).toBe(401);
    expect((await sim("/admin/ledger")).status).toBe(200);
  });
});
