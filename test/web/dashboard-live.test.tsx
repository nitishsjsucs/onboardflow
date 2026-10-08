import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubState } from "../../src/shared/agent-state.ts";
import { STAGE_IDS } from "../../src/shared/stages.ts";
import { DashboardPage } from "../../src/web/pages/DashboardPage.tsx";
import { mockFetch, PERSONAS, renderWith } from "./harness.tsx";

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

vi.mock("../../src/web/live/useHubLive.ts", () => ({ useHubLive: () => ({ state: hub, status: "connected" }) }));

afterEach(cleanup);

describe("DashboardPage with live hub state", () => {
  it("renders KPI tiles, the 8-bar funnel, blockers by kind and department, approvals pending and overdue", () => {
    const calls = mockFetch(() => ({ body: hub }));
    renderWith(<DashboardPage />, { me: PERSONAS.it!, path: "/dashboard" });
    expect(screen.getByTestId("kpi-In progress").textContent).toContain("21");
    expect(screen.getByTestId("kpi-Blocked").textContent).toContain("4");
    expect(screen.getByTestId("kpi-Awaiting approval").textContent).toContain("7");
    expect(screen.getByTestId("kpi-Complete").textContent).toContain("17");
    const funnel = screen.getByRole("img", { name: "cases per stage" });
    expect(STAGE_IDS.map((s) => funnel.querySelector(`[data-testid="funnel-${s}"]`) !== null)).toEqual(Array(8).fill(true));
    const byKind = screen.getByRole("region", { name: "Open blockers by kind" });
    expect(within(byKind).getByTestId("Open blockers by kind-integration_outage").textContent).toContain("3");
    expect(within(byKind).getByTestId("Open blockers by kind-approval_overdue").textContent).toContain("2");
    expect(screen.getByTestId("Open blockers by department-people_ops").textContent).toContain("4");
    expect(screen.getByTestId("approvals-pending").textContent).toBe("9 pending, 2 overdue");
    expect(screen.getByText(/3 cases since/)).toBeTruthy();
    expect(screen.getByRole("status", { name: /Live/ })).toBeTruthy();
    // live state present: no fallback fetch
    expect(calls).toHaveLength(0);
  });
});
