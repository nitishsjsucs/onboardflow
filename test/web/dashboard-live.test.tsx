import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubState } from "../../src/shared/agent-state.ts";
import { STAGE_BY_ID, STAGE_IDS } from "../../src/shared/stages.ts";
import { DashboardPage } from "../../src/web/pages/DashboardPage.tsx";
import { readiness } from "./fixtures.ts";
import { mockFetch, PERSONAS, renderWith } from "./harness.tsx";

/** The summary for /api/dashboard/summary, and the aggregate cards' own answers. */
const serve = (summary: () => HubState) => (url: string) =>
  url.startsWith("/api/dashboard/start-readiness") ? { body: readiness() } : url.startsWith("/api/dashboard/changes") ? { body: { items: [] } } : { body: summary() };
const summaries = (calls: Array<{ url: string }>) => calls.filter((c) => c.url === "/api/dashboard/summary");

const hub: HubState = {
  totals: { not_started: 100, in_progress: 21, blocked: 4, awaiting_approval: 7, complete: 17, failed: 1 },
  byStage: STAGE_IDS.map((stage, i) => ({ stage, active: i === 3 ? 5 : 1, waiting: i === 1 ? 6 : 0, blocked: i === 3 ? 3 : 0, awaitingApproval: i === 2 ? 4 : 0, complete: 40 - i * 3 })),
  blockersOpen: {
    byKind: { integration_outage: 3, data_issue: 1, provisioning_stalled: 0, approval_overdue: 2, employee_task_overdue: 0, approval_rejected: 1 },
    byDepartment: { people_ops: 4, it: 3, facilities: 0 },
  },
  approvalsPending: { count: 9, overdue: 2 },
  integrationHealth: {
    hr: { calls: 120, ok: 118, retried: 2, replayed: 0, lastErrorAt: null },
    it: { calls: 200, ok: 180, retried: 15, replayed: 5, lastErrorAt: "2026-10-08T10:00:00.000Z" },
    facilities: { calls: 90, ok: 90, retried: 0, replayed: 0, lastErrorAt: null },
  },
  systemIncidents: [{ system: "it", openedAt: "2026-10-08T10:00:00.000Z", casesAffected: 3 }],
  recentActivity: [{ seq: 99, occurredAt: "2026-10-08T10:01:00.000Z", action: "stage.blocked", employeeId: "E042", actorId: "onb-E042-1" }],
  asOfSeq: 99,
  reconciledAt: "2026-10-08T10:01:01.000Z",
  version: 12,
};

const live = vi.hoisted(() => ({ value: { state: null as unknown, status: "connected" as string } }));
vi.mock("../../src/web/live/useHubLive.ts", () => ({ useHubLive: () => live.value }));

afterEach(cleanup);
beforeEach(() => {
  live.value = { state: hub, status: "connected" };
});

describe("DashboardPage with live hub state", () => {
  it("renders KPI tiles, the 8-stage funnel, blockers by kind and department, approvals pending and overdue", () => {
    const calls = mockFetch(serve(() => hub));
    renderWith(<DashboardPage />, { me: PERSONAS.it!, path: "/dashboard" });
    expect(screen.getByTestId("kpi-In progress").textContent).toContain("21");
    expect(screen.getByTestId("kpi-Blocked").textContent).toContain("4");
    expect(screen.getByTestId("kpi-Awaiting approval").textContent).toContain("7");
    expect(screen.getByTestId("kpi-Complete").textContent).toContain("17");
    expect(screen.getByRole("figure", { name: "Where open cases are waiting" })).toBeTruthy();
    const funnel = screen.getByRole("list", { name: "cases per stage" });
    expect(STAGE_IDS.map((s) => funnel.querySelector(`[data-testid="funnel-${s}"]`) !== null)).toEqual(Array(8).fill(true));
    const byKind = screen.getByRole("region", { name: "Open blockers by kind" });
    expect(within(byKind).getByTestId("Open blockers by kind-integration_outage").textContent).toContain("3");
    expect(within(byKind).getByTestId("Open blockers by kind-approval_overdue").textContent).toContain("2");
    expect(screen.getByTestId("Open blockers by department-people_ops").textContent).toContain("4");
    expect(screen.getByTestId("approvals-pending").textContent).toBe("9 pending, 2 overdue");
    expect(screen.getByText(/3 cases since/)).toBeTruthy();
    expect(screen.getByRole("status", { name: /Live/ })).toBeTruthy();
    // live state present: no fallback fetch of the summary
    expect(summaries(calls)).toHaveLength(0);
  });

  it("shows each stage's label, who acts and its counts as text", () => {
    mockFetch(serve(() => hub));
    renderWith(<DashboardPage />, { me: PERSONAS.it!, path: "/dashboard" });
    const it = screen.getByTestId("funnel-it_provisioning");
    expect(within(it).getByText(`4. ${STAGE_BY_ID.it_provisioning.name}`)).toBeTruthy();
    expect(within(it).getByText(": IT acts")).toBeTruthy();
    expect(within(it).getByText("31 done")).toBeTruthy();
    expect(within(it).getByRole("link", { name: /^3 blocked/ })).toBeTruthy();
    expect(within(it).getByRole("link", { name: /^5 running/ })).toBeTruthy();
  });

  it("links the numbers to the lists behind them", () => {
    mockFetch(serve(() => hub));
    renderWith(<DashboardPage />, { me: PERSONAS.admin!, path: "/dashboard" });
    expect(screen.getByTestId("kpi-Blocked").getAttribute("href")).toBe("/cases?status=blocked");
    expect(screen.getByTestId("kpi-In progress").getAttribute("href")).toBe("/cases?status=in_progress");
    expect(screen.getByTestId("kpi-Awaiting approval").getAttribute("href")).toBe("/cases?status=awaiting_approval");
    expect(screen.getByTestId("kpi-Complete").getAttribute("href")).toBe("/cases?status=complete");
    // a stage name opens its open cases: a completed case keeps its last stage, so the link filters them out
    expect(within(screen.getByTestId("funnel-paperwork")).getByRole("link", { name: /^2\. / }).getAttribute("href")).toBe("/cases?stage=paperwork&status=open");
    expect(within(screen.getByTestId("funnel-closeout")).getByRole("link", { name: /^8\. / }).getAttribute("href")).toBe("/cases?stage=closeout&status=open");
    expect(within(screen.getByTestId("Open blockers by kind-approval_overdue")).getByRole("link").getAttribute("href")).toBe("/queue?kind=approval_overdue");
    expect(within(screen.getByTestId("Open blockers by department-it")).getByRole("link").getAttribute("href")).toBe("/queue?department=it");
  });

  it("links a coordinator only to kinds their own queue holds, and says the counts cover every department", () => {
    const kindHref = (k: string) => within(screen.getByTestId(`Open blockers by kind-${k}`)).queryByRole("link")?.getAttribute("href") ?? null;
    mockFetch(serve(() => hub));
    renderWith(<DashboardPage />, { me: PERSONAS.peopleOps!, path: "/dashboard" });
    expect(within(screen.getByTestId("Open blockers by department-it")).queryByRole("link")).toBeNull();
    // approval and checklist blockers are all People Ops': their counts match People Ops' queue
    expect(kindHref("approval_overdue")).toBe("/queue?kind=approval_overdue");
    expect(kindHref("approval_rejected")).toBe("/queue?kind=approval_rejected");
    // outages and data issues belong to several departments: a count of all of them would not match the list
    expect(kindHref("integration_outage")).toBeNull();
    expect(kindHref("data_issue")).toBeNull();
    const byKind = screen.getByRole("region", { name: "Open blockers by kind" });
    expect(within(byKind).getByText(/Counts cover every department\./).textContent).toBe("Counts cover every department. Your queue lists People Ops's.");
    expect(within(byKind).getByRole("link", { name: "Your queue" }).getAttribute("href")).toBe("/queue");
    cleanup();
    // an IT coordinator's queue never holds approval blockers: no link that would open an empty list
    mockFetch(serve(() => hub));
    renderWith(<DashboardPage />, { me: PERSONAS.it!, path: "/dashboard" });
    expect(kindHref("approval_overdue")).toBeNull();
    expect(kindHref("integration_outage")).toBeNull();
  });

  it("says live updates are paused when the socket is offline, and fetches the summary again only on Refresh", async () => {
    live.value = { state: null, status: "offline" };
    const fresher = { ...hub, totals: { ...hub.totals, blocked: 5 }, reconciledAt: "2026-10-08T10:05:00.000Z" };
    let n = 0;
    const calls = mockFetch(serve(() => (++n === 1 ? hub : fresher)));
    renderWith(<DashboardPage />, { me: PERSONAS.admin!, path: "/dashboard" });
    const paused = await screen.findByText(/Live updates paused; showing data from/);
    expect(screen.getByTestId("kpi-Blocked").textContent).toContain("4");
    await new Promise((r) => setTimeout(r, 50));
    expect(summaries(calls)).toHaveLength(1);
    const readinessCalls = () => calls.filter((c) => c.url.startsWith("/api/dashboard/start-readiness")).length;
    expect(readinessCalls()).toBe(1);
    fireEvent.click(within(paused).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByTestId("kpi-Blocked").textContent).toContain("5"));
    expect(summaries(calls)).toHaveLength(2);
    // Refresh also refetches the aggregate cards
    await waitFor(() => expect(readinessCalls()).toBe(2));
  });
});
