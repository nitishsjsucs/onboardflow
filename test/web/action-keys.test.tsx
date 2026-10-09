import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionKeys, actionId, outcomeUnknown } from "../../src/web/api/action-keys.ts";
import { ApiError } from "../../src/web/api/client.ts";
import { CaseDetailPage } from "../../src/web/pages/CaseDetailPage.tsx";
import { QueuePage } from "../../src/web/pages/QueuePage.tsx";
import { caseDetail } from "./fixtures.ts";
import { mockFetch, PERSONAS, renderWith } from "./harness.tsx";

vi.mock("../../src/web/live/useCaseLive.ts", () => ({ useCaseLive: () => ({ state: null, status: "connected" }) }));

afterEach(cleanup);

const routes = [{ path: "/cases/:id", element: <CaseDetailPage /> }];
const posts = (calls: ReturnType<typeof mockFetch>) => calls.filter((c) => c.method === "POST");

describe("Idempotency-Key per user action", () => {
  it("keeps the key while the outcome is unknown and forgets it once the answer is final", () => {
    const k = new ActionKeys();
    const a = actionId("restart", { employeeId: "E042", reason: "stuck" });
    const first = k.keyFor(a);
    for (const unknown of [new TypeError("Failed to fetch"), new SyntaxError("Unexpected token <"), new ApiError(503, "workflow_create_failed", "x", null), new ApiError(409, "idempotency_in_progress", "x", null)]) {
      expect(outcomeUnknown(unknown)).toBe(true);
      k.settle(a, unknown);
      expect(k.keyFor(a)).toBe(first);
    }
    k.settle(a, new ApiError(409, "restart_conflict", "x", null));
    const second = k.keyFor(a);
    expect(second).not.toBe(first);
    k.settle(a, null);
    expect(k.keyFor(a)).not.toBe(second);
    // a different input is a different action; key order and an explicit key field do not matter
    expect(actionId("restart", { reason: "stuck", employeeId: "E042", key: "x" })).toBe(a);
    expect(actionId("restart", { employeeId: "E042", reason: "other" })).not.toBe(a);
  });

  it("reuses the key when a restart is retried after a lost response, then starts a new action", async () => {
    let fail = true;
    const calls = mockFetch((url, method) => {
      if (method === "POST") {
        if (fail) {
          fail = false;
          throw new TypeError("Failed to fetch");
        }
        return { status: 202, body: { runNo: 2, instanceId: "onb-E001-1" } };
      }
      if (url.includes("/audit")) return { body: { items: [], nextCursor: null } };
      return { body: caseDetail(null) };
    });
    renderWith(null, { me: PERSONAS.admin!, path: "/cases/E001", routes });
    const controls = await screen.findByRole("region", { name: "admin controls" });
    fireEvent.change(within(controls).getByLabelText("admin reason"), { target: { value: "stuck" } });
    const restart = within(controls).getByRole("button", { name: "Restart workflow" }) as HTMLButtonElement;
    fireEvent.click(restart);
    await screen.findByText(/Failed to fetch/);
    await waitFor(() => expect(restart.disabled).toBe(false));
    fireEvent.click(restart);
    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    const [a, b] = posts(calls);
    expect(a!.headers["Idempotency-Key"]).toBeTruthy();
    expect(b!.headers["Idempotency-Key"]).toBe(a!.headers["Idempotency-Key"]);
    // the 202 settled it: the next restart is a new action with a new key
    await waitFor(() => expect(restart.disabled).toBe(false));
    fireEvent.click(restart);
    await waitFor(() => expect(posts(calls)).toHaveLength(3));
    expect(posts(calls)[2]!.headers["Idempotency-Key"]).not.toBe(a!.headers["Idempotency-Key"]);
  });

  it("does not replay a final 409: a retry after the stage blocks gets a new key, and the queue button waits while pending", async () => {
    let release: (() => void) | null = null;
    let answer: { status: number; body: unknown } = { status: 409, body: { error: { code: "stage_not_blocked", message: "stage is active", requestId: "r1" } } };
    const blocker = {
      id: "blk:E001:it",
      employeeId: "E001",
      employeeName: "Avery Abara",
      stageId: "it_provisioning",
      kind: "integration_outage",
      severity: "high",
      ownerDepartment: "it",
      subject: "it.order-device",
      status: "open",
      detail: { system: "it" },
      detectedAt: "2026-10-08T10:00:00.000Z",
      resolvedAt: null,
      resolvedBy: null,
      resolution: null,
      followUpTaskId: null,
    };
    const calls = mockFetch(async (url, method) => {
      if (method === "POST") {
        await new Promise<void>((r) => {
          release = r;
        });
        return answer;
      }
      if (url.startsWith("/api/blockers")) return { body: { items: [blocker], nextCursor: null } };
      return { body: { items: [], nextCursor: null } };
    });
    renderWith(<QueuePage />, { me: PERSONAS.it!, path: "/queue" });
    const retry = (await screen.findByRole("button", { name: "Retry stage" })) as HTMLButtonElement;
    fireEvent.click(retry);
    await waitFor(() => expect(retry.disabled).toBe(true));
    fireEvent.click(retry);
    (release as unknown as () => void)();
    await screen.findByText("stage is active");
    await waitFor(() => expect(retry.disabled).toBe(false));
    expect(posts(calls)).toHaveLength(1);
    answer = { status: 202, body: { round: 2 } };
    fireEvent.click(retry);
    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    (release as unknown as () => void)();
    const [first, second] = posts(calls);
    expect(second!.headers["Idempotency-Key"]).not.toBe(first!.headers["Idempotency-Key"]);
  });
});
