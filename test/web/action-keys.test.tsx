import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionKeys, actionId, outcomeUnknown } from "../../src/web/api/action-keys.ts";
import { ApiError } from "../../src/web/api/client.ts";
import { CaseDetailPage } from "../../src/web/pages/CaseDetailPage.tsx";
import { QueuePage } from "../../src/web/pages/QueuePage.tsx";
import { blocker, caseDetail } from "./fixtures.ts";
import { announced, mockFetch, PERSONAS, renderWith } from "./harness.tsx";

vi.mock("../../src/web/live/useCaseLive.ts", () => ({ useCaseLive: () => ({ state: null, status: "connected" }) }));
vi.mock("../../src/web/live/useHubLive.ts", () => ({ useHubLive: () => ({ state: null, status: "connected" }) }));

afterEach(cleanup);

const routes = [{ path: "/cases/:id", element: <CaseDetailPage /> }];
const posts = (calls: ReturnType<typeof mockFetch>) => calls.filter((c) => c.method === "POST");

describe("Idempotency-Key per user action", () => {
  it("keeps the key while the outcome is unknown and forgets it once the answer is final", () => {
    const k = new ActionKeys();
    const a = actionId("restart", { employeeId: "E042", reason: "stuck" });
    const first = k.keyFor(a);
    for (const unknown of [
      new TypeError("Failed to fetch"),
      new SyntaxError("Unexpected token <"),
      new ApiError(503, "workflow_create_failed", "x", null),
      new ApiError(409, "idempotency_in_progress", "x", null),
      new ApiError(0, "network", "Failed to fetch", null),
      new ApiError(200, "non_json_response", "x", null),
      new ApiError(502, "non_json_response", "x", null),
    ]) {
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
    const reason = within(controls).getByLabelText("Reason (audited)") as HTMLInputElement;
    fireEvent.change(reason, { target: { value: "stuck after the IT outage" } });
    const restart = within(controls).getByRole("button", { name: "Restart workflow" }) as HTMLButtonElement;
    const confirmRestart = async () => {
      await waitFor(() => expect(restart.disabled).toBe(false));
      fireEvent.click(restart);
      fireEvent.click(within(controls).getByRole("button", { name: "Confirm restart" }));
    };
    await confirmRestart();
    expect((await within(controls).findByRole("alert")).textContent).toMatch(/Could not reach OnboardFlow\. .*Trying again is safe: it is sent as the same action\./);
    expect(screen.queryByText(/Failed to fetch/)).toBeNull();
    // the outcome is unknown: the reason stays, so trying again is the same action
    expect(reason.value).toBe("stuck after the IT outage");
    await confirmRestart();
    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    const [a, b] = posts(calls);
    expect(a!.headers["Idempotency-Key"]).toBeTruthy();
    expect(b!.headers["Idempotency-Key"]).toBe(a!.headers["Idempotency-Key"]);
    // the 202 settled it and cleared the reason: the next restart is a new action with a new key
    await within(controls).findByText("Restarted: run 2");
    expect(reason.value).toBe("");
    fireEvent.change(reason, { target: { value: "stuck after the IT outage" } });
    await confirmRestart();
    await waitFor(() => expect(posts(calls)).toHaveLength(3));
    expect(posts(calls)[2]!.headers["Idempotency-Key"]).not.toBe(a!.headers["Idempotency-Key"]);
  });

  it("does not replay a final 409: a retry after the stage blocks gets a new key, and the queue button waits while pending", async () => {
    let release: (() => void) | null = null;
    let answer: { status: number; body: unknown } = { status: 409, body: { error: { code: "stage_not_blocked", message: "stage is active", requestId: "r1" } } };
    const calls = mockFetch(async (url, method) => {
      if (method === "POST") {
        await new Promise<void>((r) => {
          release = r;
        });
        return answer;
      }
      if (url.startsWith("/api/blockers")) return { body: { items: [blocker()], nextCursor: null } };
      return { body: { items: [], nextCursor: null } };
    });
    renderWith(<QueuePage />, { me: PERSONAS.it!, path: "/queue" });
    const retry = (await screen.findByRole("button", { name: "Retry IT provisioning for Avery Abara" })) as HTMLButtonElement;
    const row = retry.closest("li")!;
    fireEvent.click(retry);
    await waitFor(() => expect(retry.disabled).toBe(true));
    fireEvent.click(retry);
    (release as unknown as () => void)();
    // the conflict is explained inside the blocker's row, not at the end of the page
    const alert = await within(row as HTMLElement).findByRole("alert");
    expect(alert.textContent).toContain("IT provisioning is not blocked right now (active), so there is nothing to retry.");
    expect(alert.textContent).toContain("Request id r1");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    await waitFor(() => expect(retry.disabled).toBe(false));
    expect(posts(calls)).toHaveLength(1);
    answer = { status: 202, body: { round: 3 } };
    fireEvent.click(retry);
    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    (release as unknown as () => void)();
    const [first, second] = posts(calls);
    expect(second!.headers["Idempotency-Key"]).not.toBe(first!.headers["Idempotency-Key"]);
    // the next success clears the error, and the row and the live region both name the new round
    await within(row as HTMLElement).findByText("Retry requested for IT provisioning: round 3 running");
    expect(within(row as HTMLElement).queryByRole("alert")).toBeNull();
    await waitFor(() => expect(announced()).toBe("Retry requested for IT provisioning: round 3 running"));
  });

  it("explains a plain-text 500 inside the row and reuses the key on the next click", async () => {
    let n = 0;
    const calls = mockFetch((url, method) => {
      if (method === "POST") return ++n === 1 ? { status: 500, raw: "Internal Server Error" } : { status: 202, body: { round: 2 } };
      if (url.startsWith("/api/blockers")) return { body: { items: [blocker()], nextCursor: null } };
      return { body: { items: [], nextCursor: null } };
    });
    renderWith(<QueuePage />, { me: PERSONAS.it!, path: "/queue" });
    const retry = (await screen.findByRole("button", { name: "Retry IT provisioning for Avery Abara" })) as HTMLButtonElement;
    fireEvent.click(retry);
    const alert = await within(retry.closest("li") as HTMLElement).findByRole("alert");
    expect(alert.textContent).toContain("The server sent an answer OnboardFlow could not read (HTTP 500).");
    expect(alert.textContent).toContain("It may not have gone through. Trying again is safe: it is sent as the same action.");
    expect(alert.textContent).not.toMatch(/JSON|Unexpected token|SyntaxError/);
    await waitFor(() => expect(retry.disabled).toBe(false));
    fireEvent.click(retry);
    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    expect(posts(calls)[1]!.headers["Idempotency-Key"]).toBe(posts(calls)[0]!.headers["Idempotency-Key"]);
  });

  it("treats a 2xx with an unparsable body as an unknown outcome: the next click reuses the key", async () => {
    let n = 0;
    const calls = mockFetch((url, method) => {
      if (method === "POST") return ++n === 1 ? { status: 200, raw: "{\"round\": 2" } : { status: 202, body: { round: 2 } };
      if (url.startsWith("/api/blockers")) return { body: { items: [blocker()], nextCursor: null } };
      return { body: { items: [], nextCursor: null } };
    });
    renderWith(<QueuePage />, { me: PERSONAS.it!, path: "/queue" });
    const retry = (await screen.findByRole("button", { name: "Retry IT provisioning for Avery Abara" })) as HTMLButtonElement;
    fireEvent.click(retry);
    expect((await screen.findByRole("alert")).textContent).toContain("(HTTP 200)");
    await waitFor(() => expect(retry.disabled).toBe(false));
    fireEvent.click(retry);
    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    expect(posts(calls)[1]!.headers["Idempotency-Key"]).toBe(posts(calls)[0]!.headers["Idempotency-Key"]);
  });

  it("disables only the row whose action is in flight", async () => {
    let release: (() => void) | null = null;
    mockFetch(async (url, method) => {
      if (method === "POST") {
        await new Promise<void>((r) => {
          release = r;
        });
        return { status: 202, body: { round: 2 } };
      }
      if (url.startsWith("/api/blockers")) return { body: { items: [blocker(), blocker({ id: "blk:E002:it", employeeId: "E002", employeeName: "Blake Brennick" })], nextCursor: null } };
      return { body: { items: [], nextCursor: null } };
    });
    renderWith(<QueuePage />, { me: PERSONAS.it!, path: "/queue" });
    const a = (await screen.findByRole("button", { name: "Retry IT provisioning for Avery Abara" })) as HTMLButtonElement;
    const b = screen.getByRole("button", { name: "Retry IT provisioning for Blake Brennick" }) as HTMLButtonElement;
    fireEvent.click(a);
    await waitFor(() => expect(a.disabled).toBe(true));
    expect(b.disabled).toBe(false);
    (release as unknown as () => void)();
    await waitFor(() => expect(a.disabled).toBe(false));
  });
});
