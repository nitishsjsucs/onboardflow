import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { setFault } from "../helpers/sims.ts";
import { calls, caseAgent, cmdFor, driveThroughManagerApproval, fastWorkflows, finishFromOrientation, waitForStage } from "../helpers/workflow.ts";

describe("step retries", () => {
  it("retries 503 x2 and completes on the 3rd attempt without a blocker", async () => {
    const intro = await fastWorkflows();
    try {
      await setFault({ system: "it", operation: "order-device", employeeRef: "E080", fault: "fail_503", remaining: 2 });
      await driveThroughManagerApproval("E080");
      expect((await finishFromOrientation("E080")).status).toBe("complete");
      const order = await calls("E080", "it.order-device");
      expect(order.map((c) => [c.attempt, c.outcome])).toEqual([
        [1, "retryable_error"],
        [2, "retryable_error"],
        [3, "ok"],
      ]);
      expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE employee_id = 'E080' AND action = 'stage.blocked'").first<{ n: number }>())!.n).toBe(0);
    } finally {
      await intro.dispose();
    }
  });

  it("waits at least Retry-After between 429 attempts (real retry delays)", async () => {
    const intro = await fastWorkflows({ retryDelays: false });
    try {
      await setFault({ system: "hr", operation: "create-worker", employeeRef: "E081", fault: "rate_limit_429", remaining: 2, params: { retryAfterMs: 300 } });
      const stub = await caseAgent("E081");
      await stub.startCase(await cmdFor("C01"));
      await waitForStage("E081", "paperwork", ["active", "waiting_on_employee"]);
      const c = await calls("E081", "hr.create-worker");
      expect(c.map((x) => [x.attempt, x.outcome, x.http_status])).toEqual([
        [1, "retryable_error", 429],
        [2, "retryable_error", 429],
        [3, "ok", 201],
      ]);
      const t = c.map((x) => Date.parse(x.created_at));
      expect(t[1]! - t[0]!).toBeGreaterThanOrEqual(290);
      expect(t[2]! - t[1]!).toBeGreaterThanOrEqual(290);
      const retryAfter = await env.DB.prepare("SELECT retry_after_ms FROM integration_calls WHERE employee_id = 'E081' AND attempt = 1").first();
      expect(retryAfter).toEqual({ retry_after_ms: 300 });
      await stub.terminateCase("cleanup", await cmdFor("A01"));
    } finally {
      await intro.dispose();
    }
  });

  it("blocks the stage once the retry budget is spent (1 + RETRY_LIMIT attempts)", async () => {
    const intro = await fastWorkflows();
    try {
      await setFault({ system: "it", operation: "order-device", employeeRef: "E082", fault: "fail_503" });
      await driveThroughManagerApproval("E082");
      const blocked = await waitForStage("E082", "it_provisioning", "blocked");
      expect(JSON.parse(blocked.blocked_reason_json!)).toMatchObject({ class: "retryable", operation: "it.order-device", system: "it", httpStatus: 503, round: 1 });
      expect((await calls("E082", "it.order-device")).map((c) => c.attempt)).toEqual([1, 2, 3, 4, 5]);
      const kase = await env.DB.prepare("SELECT status FROM cases WHERE employee_id = 'E082'").first();
      expect(kase).toEqual({ status: "blocked" });
      await (await caseAgent("E082")).terminateCase("cleanup", await cmdFor("A01"));
    } finally {
      await intro.dispose();
    }
  });
});
