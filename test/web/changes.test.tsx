import { act, cleanup, fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubState } from "../../src/shared/agent-state.ts";
import type { ChangeItem } from "../../src/shared/api.ts";
import { STAGE_IDS } from "../../src/shared/stages.ts";
import { changeText, SHOWN_AT_FIRST } from "../../src/web/components/ChangesFeed.tsx";
import { useThrottledCallback } from "../../src/web/hooks/useThrottledCallback.ts";
import { DashboardPage } from "../../src/web/pages/DashboardPage.tsx";
import { readiness } from "./fixtures.ts";
import { mockFetch, PERSONAS, renderWith, type MockResponse } from "./harness.tsx";

const hub: HubState = {
  totals: { not_started: 0, in_progress: 1, blocked: 0, awaiting_approval: 0, complete: 0, failed: 0 },
  byStage: STAGE_IDS.map((stage) => ({ stage, active: stage === "intake" ? 1 : 0, waiting: 0, blocked: 0, awaitingApproval: 0, complete: 0 })),
  blockersOpen: {
    byKind: { integration_outage: 0, data_issue: 0, provisioning_stalled: 0, approval_overdue: 0, employee_task_overdue: 0, approval_rejected: 0 },
    byDepartment: { people_ops: 0, it: 0, facilities: 0 },
  },
  approvalsPending: { count: 0, overdue: 0 },
  integrationHealth: {
    hr: { calls: 0, ok: 0, retried: 0, replayed: 0, lastErrorAt: null },
    it: { calls: 0, ok: 0, retried: 0, replayed: 0, lastErrorAt: null },
    facilities: { calls: 0, ok: 0, retried: 0, replayed: 0, lastErrorAt: null },
  },
  systemIncidents: [],
  recentActivity: [{ seq: 5, occurredAt: "2026-10-08T12:00:00.000Z", action: "integration.call", employeeId: "E042", actorId: "onb-E042-1" }],
  asOfSeq: 5,
  reconciledAt: "2026-10-16T10:00:00.000Z",
  version: 1,
};

const live = vi.hoisted(() => ({ value: { state: null as unknown, status: "connected" as string }, onVersion: undefined as undefined | ((v: number) => void) }));
vi.mock("../../src/web/live/useHubLive.ts", () => ({
  useHubLive: (opts?: { onVersion?: (v: number) => void }) => {
    live.onVersion = opts?.onVersion;
    return live.value;
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  cleanup();
});
beforeEach(() => {
  live.value = { state: hub, status: "connected" };
});

let seq = 100;
function change(action: ChangeItem["action"], over: Partial<ChangeItem> = {}): ChangeItem {
  seq--;
  return { seq, occurredAt: "2026-10-08T12:00:00.000Z", action, employeeId: "E057", employeeName: "Logan Ravel", stageId: null, round: null, actorType: "workflow", detail: {}, ...over };
}

function serve(changes: () => MockResponse | Promise<MockResponse>) {
  return mockFetch((url) => {
    if (url.startsWith("/api/dashboard/changes")) return changes();
    if (url.startsWith("/api/dashboard/start-readiness")) return { body: readiness() };
    return { body: hub };
  });
}
const card = () => screen.getByRole("region", { name: "What changed" });

describe("changeText", () => {
  it("says each kind of change in a plain sentence", () => {
    expect(changeText(change("case.started"))).toBe("Onboarding started for Logan Ravel");
    expect(changeText(change("case.completed"))).toBe("Onboarding complete for Logan Ravel");
    expect(changeText(change("case.failed", { detail: { failureReason: "recovery_rounds_exhausted" } }))).toBe("Onboarding failed for Logan Ravel: the stage ran out of recovery rounds");
    expect(changeText(change("stage.blocked", { stageId: "it_provisioning", detail: { system: "it", operation: "it.create-account", httpStatus: 503 } }))).toBe(
      "IT provisioning blocked for Logan Ravel: IT (simulated) could not create the account",
    );
    expect(changeText(change("stage.blocked", { stageId: "intake", detail: { system: "hr", operation: "hr.create-worker", httpStatus: 422, message: "costCenter must match CC-####" } }))).toBe(
      "Pre-boarding intake blocked for Logan Ravel: HR (simulated) rejected the request: cost center must match CC-####",
    );
    expect(changeText(change("stage.retry_requested", { stageId: "it_provisioning", round: 2 }))).toBe("Retry requested for IT provisioning for Logan Ravel: round 2");
    expect(changeText(change("blocker.opened", { detail: { kind: "approval_overdue", checkpoint: "manager_approval" } }))).toBe("Manager approval overdue for Logan Ravel");
    expect(changeText(change("blocker.opened", { detail: { kind: "approval_overdue", checkpoint: "closeout" } }))).toBe("People Ops sign-off overdue for Logan Ravel");
    expect(changeText(change("blocker.opened", { detail: { kind: "employee_task_overdue" } }))).toBe("Checklist tasks overdue for Logan Ravel");
    expect(changeText(change("blocker.opened", { detail: { kind: "approval_rejected", checkpoint: "manager_approval" } }))).toBe("Manager approval sent back to People Ops for Logan Ravel: revise and resubmit");
    expect(changeText(change("blocker.auto_resolved", { stageId: "it_provisioning", detail: { kind: "integration_outage" } }))).toBe("Integration outage cleared for Logan Ravel (IT provisioning)");
    expect(changeText(change("approval.approved", { detail: { checkpoint: "manager_approval" } }))).toBe("Manager approval approved for Logan Ravel");
    expect(changeText(change("approval.approved", { detail: { checkpoint: "closeout", onBehalfOf: "people_ops" } }))).toBe("People Ops sign-off approved for Logan Ravel: decided by an admin on behalf");
    expect(changeText(change("approval.rejected", { detail: { checkpoint: "manager_approval" } }))).toBe("Manager approval rejected for Logan Ravel");
    expect(changeText(change("approval.resubmitted", { round: 2, detail: { checkpoint: "manager_approval" } }))).toBe("Manager approval resubmitted for Logan Ravel: round 2");
  });
});

describe("What changed (dashboard card)", () => {
  it("lists sentences newest first, links each name to its case, and shows relative and absolute time", async () => {
    const items = [change("stage.retry_requested", { stageId: "it_provisioning", round: 2, occurredAt: new Date(Date.now() - 5 * 60_000).toISOString() }), change("case.started", { employeeId: "E003", employeeName: "Wren Abara" })];
    const calls = serve(() => ({ body: { items } }));
    renderWith(<DashboardPage />, { me: PERSONAS.admin!, path: "/dashboard" });
    const list = await within(card()).findByRole("list", { name: "latest changes, newest first" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows[0]!.textContent).toMatch(/^5 min ago, .*Retry requested for IT provisioning for Logan Ravel: round 2$/);
    expect(within(rows[0]!).getByRole("link", { name: "Logan Ravel" }).getAttribute("href")).toBe("/cases/E057");
    expect(rows[0]!.querySelector("time")!.getAttribute("dateTime")).toBe(items[0]!.occurredAt);
    expect(within(rows[1]!).getByRole("link", { name: "Wren Abara" }).getAttribute("href")).toBe("/cases/E003");
    expect(calls.find((c) => c.url.startsWith("/api/dashboard/changes"))!.url).toBe("/api/dashboard/changes?limit=15");
    // the raw recent activity is gone
    expect(screen.queryByText("integration.call")).toBeNull();
  });

  it("shows the first 8, then the rest on Show more", async () => {
    const items = Array.from({ length: 12 }, () => change("case.started"));
    serve(() => ({ body: { items } }));
    renderWith(<DashboardPage />, { me: PERSONAS.peopleOps!, path: "/dashboard" });
    const list = await within(card()).findByRole("list", { name: "latest changes, newest first" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(SHOWN_AT_FIRST);
    const more = within(card()).getByRole("button", { name: "Show more (4)" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(more.getAttribute("aria-controls")).toBe(list.id);
    fireEvent.click(more);
    expect(within(list).getAllByRole("listitem")).toHaveLength(12);
    expect(within(card()).getByRole("button", { name: "Show fewer" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("says when there is nothing yet, and explains a failure with Try again", async () => {
    serve(() => ({ body: { items: [] } }));
    renderWith(<DashboardPage />, { me: PERSONAS.admin!, path: "/dashboard" });
    expect(await within(card()).findByText("No changes yet.")).toBeTruthy();
    cleanup();
    let n = 0;
    serve(() => (++n === 1 ? { status: 500, body: { error: { code: "internal_error", message: "internal error", requestId: "r-7" } } } : { body: { items: [change("case.completed")] } }));
    renderWith(<DashboardPage />, { me: PERSONAS.admin!, path: "/dashboard" });
    const alert = await within(card()).findByRole("alert");
    expect(alert.textContent).toContain("Could not load the latest changes.");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await within(card()).findByText(/Onboarding complete for/)).toBeTruthy();
  });

  it("refetches the cards on a new hub version at most once a minute", async () => {
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    const calls = serve(() => ({ body: { items: [] } }));
    renderWith(<DashboardPage />, { me: PERSONAS.admin!, path: "/dashboard" });
    await within(card()).findByText("No changes yet.");
    const fetches = (path: string) => calls.filter((c) => c.url.startsWith(path)).length;
    expect(fetches("/api/dashboard/changes")).toBe(1);
    expect(live.onVersion).toBeTypeOf("function");
    // a minute after the page loaded: the first new version refetches both cards at once
    now.mockReturnValue(t0 + 61_000);
    act(() => live.onVersion!(2));
    await waitFor(() => expect(fetches("/api/dashboard/changes")).toBe(2));
    await waitFor(() => expect(fetches("/api/dashboard/start-readiness")).toBe(2));
    // the next versions inside that minute wait for its end
    now.mockReturnValue(t0 + 62_000);
    act(() => live.onVersion!(3));
    act(() => live.onVersion!(4));
    await new Promise((r) => setTimeout(r, 30));
    expect(fetches("/api/dashboard/changes")).toBe(2);
  });
});

describe("useThrottledCallback", () => {
  it("runs at most once per window, and runs a call made inside the window when it ends", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const { result, unmount } = renderHook(() => useThrottledCallback(fn, 1000));
    // the window starts at mount
    result.current();
    result.current();
    expect(fn).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    result.current();
    expect(fn).toHaveBeenCalledTimes(2);
    result.current();
    vi.advanceTimersByTime(999);
    expect(fn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(3);
    result.current();
    unmount();
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
