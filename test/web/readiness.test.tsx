import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubState } from "../../src/shared/agent-state.ts";
import type { CaseStatus, StageStatus } from "../../src/shared/domain.ts";
import { bucketReadiness } from "../../src/shared/readiness.ts";
import { STAGE_IDS, type StageId } from "../../src/shared/stages.ts";
import { localToday } from "../../src/web/components/dates.ts";
import { readinessRows } from "../../src/web/components/ReadinessChart.tsx";
import { DashboardPage } from "../../src/web/pages/DashboardPage.tsx";
import { readiness } from "./fixtures.ts";
import { mockFetch, PERSONAS, renderWith, type MockResponse } from "./harness.tsx";

const hub: HubState = {
  totals: { not_started: 0, in_progress: 10, blocked: 1, awaiting_approval: 3, complete: 6, failed: 0 },
  byStage: STAGE_IDS.map((stage) => ({ stage, active: 0, waiting: 0, blocked: 0, awaitingApproval: 0, complete: 0 })),
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
  recentActivity: [],
  asOfSeq: 1,
  reconciledAt: "2026-10-16T10:00:00.000Z",
  version: 1,
};

const live = vi.hoisted(() => ({ value: { state: null as unknown, status: "connected" as string } }));
vi.mock("../../src/web/live/useHubLive.ts", () => ({ useHubLive: () => live.value }));

afterEach(cleanup);
beforeEach(() => {
  live.value = { state: hub, status: "connected" };
});

function serve(readinessAnswer: () => MockResponse | Promise<MockResponse>) {
  return mockFetch((url) => {
    if (url.startsWith("/api/dashboard/start-readiness")) return readinessAnswer();
    if (url.startsWith("/api/dashboard/changes")) return { body: { items: [] } };
    return { body: hub };
  });
}

const card = () => screen.getByRole("region", { name: "readiness by start week" });
const week = (key: string) => within(card()).getByTestId(`week-${key}`);

describe("readiness rows (data mapping)", () => {
  it("labels each week with its countdown and size, links the week to its list, and flags near weeks that are not ready", () => {
    const rows = readinessRows(readiness());
    // today is Friday Oct 16: the current week counts only from today
    expect(rows.map((r) => r.label)).toEqual(["This week, from today (Fri Oct 16)", "Week of Mon Oct 19, in 3 days", "Week of Mon Nov 2, in 17 days, 15 people", "Week of Mon Nov 9, in 24 days, 10 people"]);
    expect(rows.map((r) => r.empty)).toEqual([true, true, false, false]);
    expect(rows[2]!.labelHref).toBe("/cases?startFrom=2026-11-02&startTo=2026-11-08");
    // within 21 days and 9 of 15 not ready: flagged; 24 days away: not flagged, even with 8 of 10 not ready
    expect(rows[2]!.flag).toBe("9 not ready");
    expect(rows[3]!.flag).toBeNull();
    expect(rows[2]!.parts.map((p) => p.text)).toEqual(["1 blocked", "3 waiting on a person", "5 in setup", "6 ready"]);
    // only counts with one matching case status link, so each list matches its number
    expect(rows[2]!.parts.map((p) => p.href)).toEqual(["/cases?status=blocked&startFrom=2026-11-02&startTo=2026-11-08", null, null, null]);
    expect(rows[3]!.parts.map((p) => [p.text, p.href])).toEqual([
      ["1 failed", "/cases?status=failed&startFrom=2026-11-09&startTo=2026-11-15"],
      ["7 not started", "/cases?status=not_started&startFrom=2026-11-09&startTo=2026-11-15"],
      ["2 ready", null],
    ]);
  });

  it("links a partial first or last week to exactly the days it counts, mid-week and with start dates on any weekday", () => {
    // one entry per person: Friday Oct 16 is today, and a 2-week window ends before Friday Oct 30
    const persons: Array<[string, CaseStatus, StageId | null, StageStatus | null]> = [
      ["2026-10-12", "complete", "closeout", "complete"], // started and finished: in no row
      ["2026-10-13", "in_progress", "paperwork", "waiting_on_employee"], // started Tuesday, not finished
      ["2026-10-14", "blocked", "it_provisioning", "blocked"], // started Wednesday, blocked
      ["2026-10-16", "not_started", null, null], // today
      ["2026-10-17", "blocked", "it_provisioning", "blocked"], // Saturday
      ["2026-10-17", "complete", "closeout", "complete"],
      ["2026-10-21", "blocked", "intake", "blocked"], // Wednesday
      ["2026-10-29", "failed", "intake", "failed"], // Thursday, the window's last day
      ["2026-10-31", "blocked", "intake", "blocked"], // Saturday after the window
    ];
    const data = bucketReadiness(
      persons.map(([startDate, caseStatus, currentStage, stageStatus]) => ({ startDate, caseStatus, currentStage, stageStatus, n: 1 })),
      "2026-10-16",
      2,
    );
    expect(data.end).toBe("2026-10-30");
    const rows = readinessRows(data);
    expect(rows.map((r) => [r.label, r.labelHref])).toEqual([
      ["Already started, not finished, 2 people", null],
      ["This week, from today (Fri Oct 16), 3 people", "/cases?startFrom=2026-10-16&startTo=2026-10-18"],
      ["Week of Mon Oct 19, in 3 days, 1 person", "/cases?startFrom=2026-10-19&startTo=2026-10-25"],
      ["Week of Mon Oct 26 to Thu Oct 29, in 10 days, 1 person", "/cases?startFrom=2026-10-26&startTo=2026-10-29"],
    ]);
    expect(rows[1]!.parts.map((p) => [p.text, p.href])).toEqual([
      ["1 blocked", "/cases?status=blocked&startFrom=2026-10-16&startTo=2026-10-18"],
      ["1 not started", "/cases?status=not_started&startFrom=2026-10-16&startTo=2026-10-18"],
      ["1 ready", null],
    ]);
    expect(rows[3]!.parts.map((p) => p.href)).toEqual(["/cases?status=failed&startFrom=2026-10-26&startTo=2026-10-29"]);
    // every link opens a list (as /api/employees filters it) whose length is the number it stands for
    const listed = (href: string) => {
      const q = new URL(href, "http://localhost").searchParams;
      return persons.filter(([start, status]) => (!q.get("status") || status === q.get("status")) && (!q.get("startFrom") || start >= q.get("startFrom")!) && start <= q.get("startTo")!).length;
    };
    for (const r of rows) {
      if (r.labelHref) expect(listed(r.labelHref), r.label).toBe(r.counts.total);
      for (const p of r.parts) if (p.href) expect(listed(p.href), `${r.label}: ${p.text}`).toBe(Number(p.text.split(" ")[0]));
    }
  });

  it("puts people who started and are not finished first, with links up to yesterday", () => {
    const rows = readinessRows(readiness({ alreadyStarted: { total: 3, ready: 1, blocked: 2, waiting: 0, inSetup: 0, notStarted: 0, failed: 0 } }));
    expect(rows[0]!.label).toBe("Already started, not finished, 3 people");
    expect(rows[0]!.labelHref).toBeNull();
    expect(rows[0]!.flag).toBe("2 not ready");
    expect(rows[0]!.parts[0]).toEqual({ key: "blocked", text: "2 blocked", href: "/cases?status=blocked&startTo=2026-10-15" });
  });
});

describe("Readiness by start week (dashboard card)", () => {
  it("draws every week on one shared scale, with counts as text and the bars hidden from assistive technology", async () => {
    const calls = serve(() => ({ body: readiness() }));
    renderWith(<DashboardPage />, { me: PERSONAS.peopleOps!, path: "/dashboard" });
    await within(card()).findByText("Week of Mon Nov 2, in 17 days, 15 people");
    // the viewer's calendar date, so the countdowns match the case page, My team and Approvals
    expect(calls.find((c) => c.url.startsWith("/api/dashboard/start-readiness"))!.url).toBe(`/api/dashboard/start-readiness?weeks=12&today=${localToday()}`);
    expect(within(card()).getByRole("figure", { name: "Readiness by start week" })).toBeTruthy();
    const nov2 = week("2026-11-02");
    // 15 is the busiest week: 1 blocked of 15 is 6.667% of the line, less its share of the 2 px gaps
    const segs = [...nov2.querySelectorAll<HTMLElement>(".seg")];
    expect(segs.map((s) => s.className.replace(/ last$/, ""))).toEqual(["seg rd-bad", "seg rd-waiting", "seg rd-setup", "seg rd-ready"]);
    expect(segs[0]!.style.width).toBe("calc(6.667% - 1.50px)");
    expect(segs.every((s) => s.getAttribute("aria-hidden") === "true")).toBe(true);
    const nov9 = [...week("2026-11-09").querySelectorAll<HTMLElement>(".seg")];
    expect(nov9.map((s) => s.className.replace(/ last$/, ""))).toEqual(["seg rd-bad", "seg rd-notStarted", "seg rd-ready"]);
    expect(nov9[1]!.style.width).toBe(`calc(${((7 / 15) * 100).toFixed(3)}% - 1.33px)`);
    // the row's text carries every count, and the flag is text
    expect(nov2.textContent).toContain("1 blocked, 3 waiting on a person, 5 in setup, 6 ready");
    expect(within(nov2).getByText(/9 not ready/)).toBeTruthy();
    // the flag is its own grid cell beside the bar, not part of it, so the bar keeps the shared scale and a phone can move the flag up
    expect([...nov2.children].map((c) => c.className)).toEqual(["stage-row-head", "readiness-bar-line", "readiness-flag", "readiness-counts"]);
    expect(within(week("2026-11-09")).queryByText(/not ready/)).toBeNull();
    // empty weeks are one muted line
    expect(week("2026-10-19").textContent).toBe("Week of Mon Oct 19, in 3 days: no start dates");
    expect(within(card()).getByRole("link", { name: /^1 blocked: Week of Mon Nov 2/ }).getAttribute("href")).toBe("/cases?status=blocked&startFrom=2026-11-02&startTo=2026-11-08");
    expect(within(card()).getByRole("link", { name: /^Week of Mon Nov 2, in 17 days, 15 people/ }).getAttribute("href")).toBe("/cases?startFrom=2026-11-02&startTo=2026-11-08");
    expect(within(card()).getByText(/^Ready for day one:/)).toBeTruthy();
  });

  it("has a legend with a swatch, an icon and a word for each class", async () => {
    serve(() => ({ body: readiness() }));
    renderWith(<DashboardPage />, { me: PERSONAS.admin!, path: "/dashboard" });
    const legend = await within(card()).findByRole("list", { name: "Legend" });
    expect(within(legend).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Blocked or failed", "Waiting on a person", "In setup", "Not started", "Ready"]);
    expect(legend.querySelectorAll(".swatch")).toHaveLength(5);
    expect(legend.querySelectorAll("svg.state-icon")).toHaveLength(5);
  });

  it("shows a captioned table instead of the bars on request", async () => {
    serve(() => ({ body: readiness() }));
    renderWith(<DashboardPage />, { me: PERSONAS.admin!, path: "/dashboard" });
    const toggle = await within(card()).findByRole("button", { name: "Show as table" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    const table = within(card()).getByRole("table", { name: "People starting each week, by readiness for day one" });
    const nov2 = within(table).getByRole("row", { name: /Week of Mon Nov 2/ });
    expect([...nov2.querySelectorAll("td")].map((td) => td.textContent)).toEqual(["15", "1", "0", "3", "5", "0", "6"]);
    expect(within(nov2).getByRole("link", { name: /^1 blocked/ }).getAttribute("href")).toBe("/cases?status=blocked&startFrom=2026-11-02&startTo=2026-11-08");
  });

  it("says when nobody starts in the window", async () => {
    serve(() => ({ body: readiness({ weeks: readiness().weeks.slice(0, 2) }) }));
    renderWith(<DashboardPage />, { me: PERSONAS.admin!, path: "/dashboard" });
    expect(await within(card()).findByText("No start dates in the next 12 weeks.")).toBeTruthy();
    expect(within(card()).queryByRole("button", { name: "Show as table" })).toBeNull();
  });

  it("shows loading, then a failure with Try again that fetches again", async () => {
    let n = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    serve(async () => {
      n++;
      if (n === 1) {
        await gate;
        return { status: 503, body: { error: { code: "unavailable", message: "try later", requestId: "r-1" } } };
      }
      return { body: readiness() };
    });
    renderWith(<DashboardPage />, { me: PERSONAS.admin!, path: "/dashboard" });
    expect(within(card()).getByText("Loading readiness by start week...")).toBeTruthy();
    release();
    const alert = await within(card()).findByRole("alert");
    expect(alert.textContent).toContain("Could not load readiness by start week.");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await within(card()).findByText("Week of Mon Nov 2, in 17 days, 15 people");
    expect(n).toBe(2);
  });

  it("dims the last frame while a refresh is in flight", async () => {
    serve(() => ({ body: readiness() }));
    const { client } = renderWith(<DashboardPage />, { me: PERSONAS.admin!, path: "/dashboard" });
    await within(card()).findByText("Week of Mon Nov 2, in 17 days, 15 people");
    expect(card().querySelector(".chart.stale")).toBeNull();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    serve(async () => {
      await gate;
      return { body: readiness() };
    });
    void client.invalidateQueries({ queryKey: ["readiness"] });
    await waitFor(() => expect(card().querySelector(".stage-chart")?.closest(".chart.stale")).toBeTruthy());
    release();
    await waitFor(() => expect(card().querySelector(".stage-chart")?.closest(".chart.stale")).toBeNull());
  });
});
