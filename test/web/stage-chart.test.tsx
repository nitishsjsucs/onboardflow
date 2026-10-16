import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { StageRollup } from "../../src/shared/agent-state.ts";
import { STAGE_IDS, type StageId } from "../../src/shared/stages.ts";
import { segmentWidths, StageFunnelChart, stageRow } from "../../src/web/components/StageFunnelChart.tsx";
import { PERSONAS, renderWith } from "./harness.tsx";

afterEach(cleanup);

const none = { people_ops: 0, it: 0, facilities: 0 };
const zero = (stage: StageId): StageRollup => ({ stage, active: 0, waiting: 0, blocked: 0, awaitingApproval: 0, complete: 0, blockedBy: none });

/**
 * The demo-drive mix: 24 at each human checkpoint, 3 blocked at each automated stage by a simulated outage of the
 * system the stage calls (at the cross-system check, HR's get-worker: People Ops' blockers).
 */
function demo(over: Partial<Record<StageId, Partial<StageRollup>>> = {}): StageRollup[] {
  const base: Record<StageId, Partial<StageRollup>> = {
    intake: { blocked: 3, complete: 147, blockedBy: { ...none, people_ops: 3 } },
    paperwork: { waiting: 24, complete: 120 },
    manager_approval: { awaitingApproval: 24, complete: 96 },
    it_provisioning: { blocked: 3, complete: 93, blockedBy: { ...none, it: 3 } },
    facilities_setup: { blocked: 3, complete: 90, blockedBy: { ...none, facilities: 3 } },
    provisioning_verification: { blocked: 3, complete: 90, blockedBy: { ...none, people_ops: 3 } },
    orientation: { waiting: 24, complete: 66 },
    closeout: { awaitingApproval: 24, complete: 42 },
  };
  return STAGE_IDS.map((s) => ({ ...zero(s), ...base[s], ...over[s] }));
}

function renderChart(stages: StageRollup[], opts: { complete?: number; stale?: boolean } = {}) {
  return renderWith(<StageFunnelChart stages={stages} complete={opts.complete ?? 42} stale={opts.stale ?? false} />, { me: PERSONAS.admin!, path: "/dashboard" });
}

const row = (stage: StageId) => screen.getByTestId(`funnel-${stage}`);
const widths = (stage: StageId) => [...row(stage).querySelectorAll<HTMLElement>(".chart-bar .seg")].map((s) => s.style.width);

describe("StageFunnelChart (where open cases are waiting)", () => {
  it("draws each stage's open cases on one shared scale: the largest stage is a full bar", () => {
    renderChart(demo());
    // 24 of 24 is the full length; 3 of 24 is an eighth of it, so a blocked stage is never a sliver
    expect(widths("paperwork")).toEqual(["calc(100.000% - 0.00px)"]);
    expect(widths("it_provisioning")).toEqual(["calc(12.500% - 0.00px)"]);
    expect(widths("intake")).toEqual(["calc(12.500% - 0.00px)"]);
    // finished cases are text, not ink
    expect(within(row("closeout")).getByText("42 done")).toBeTruthy();
    expect(row("closeout").querySelectorAll(".seg")).toHaveLength(1);
  });

  it("splits a mixed stage into blocked, waiting and running, with the 2 px gaps taken from the segments", () => {
    const stages = demo({ it_provisioning: { blocked: 1, active: 2 } });
    const r = stageRow(stages[3]!);
    expect(segmentWidths(r, 24)).toEqual([
      { segment: "blocked", n: 1, pct: (1 / 24) * 100 },
      { segment: "running", n: 2, pct: (2 / 24) * 100 },
    ]);
    renderChart(stages);
    expect(widths("it_provisioning")).toEqual(["calc(4.167% - 1.00px)", "calc(8.333% - 1.00px)"]);
    // a single blocked case still prints its count
    expect(within(row("it_provisioning")).getByRole("link", { name: /^1 blocked/ })).toBeTruthy();
  });

  it("names who acts: the owner of each blocked case's blocker, the employee, managers, People Ops", () => {
    renderChart(demo());
    expect(within(row("it_provisioning")).getByText(": IT acts")).toBeTruthy();
    expect(within(row("facilities_setup")).getByText(": Facilities acts")).toBeTruthy();
    expect(within(row("intake")).getByText(": People Ops acts")).toBeTruthy();
    // the cross-system check calls all three systems; these 3 cases wait on People Ops' blockers, as their case pages say
    expect(within(row("provisioning_verification")).getByText(": People Ops acts")).toBeTruthy();
    expect(within(row("paperwork")).getByText(": the employee acts")).toBeTruthy();
    expect(within(row("orientation")).getByText(": the employee acts")).toBeTruthy();
    expect(within(row("manager_approval")).getByText(": managers act")).toBeTruthy();
    expect(within(row("manager_approval")).getByRole("link", { name: /^24 waiting on a decision by managers/ })).toBeTruthy();
    expect(within(row("closeout")).getByText(": People Ops acts")).toBeTruthy();
    expect(within(row("closeout")).getByRole("link", { name: /^24 waiting on a decision by People Ops/ })).toBeTruthy();
  });

  it("names every department with blocked cases of its own, and falls back to the stage's owners while a blocker is not open yet", () => {
    renderChart(
      demo({
        provisioning_verification: { blocked: 3, blockedBy: { people_ops: 1, it: 1, facilities: 1 } },
        it_provisioning: { blocked: 3, blockedBy: { ...none, people_ops: 1, it: 2 } },
        facilities_setup: { blocked: 3, blockedBy: { ...none, facilities: 2 } },
      }),
    );
    expect(within(row("provisioning_verification")).getByText(": People Ops, IT and Facilities act")).toBeTruthy();
    expect(within(row("it_provisioning")).getByText(": People Ops and IT act")).toBeTruthy();
    // 2 of 3 known: the third is one of the stage's owners, and Facilities owns the only system it calls
    expect(within(row("facilities_setup")).getByText(": Facilities acts")).toBeTruthy();
    cleanup();
    // a hub state saved by an earlier build has no counts: "one of them", as a case page without a blocker says
    renderChart(demo().map(({ blockedBy: _b, ...r }) => r));
    expect(within(row("provisioning_verification")).getByText(": People Ops, IT or Facilities acts")).toBeTruthy();
    expect(within(row("it_provisioning")).getByText(": IT acts")).toBeTruthy();
  });

  it("reads the hub's waiting count as a revision at a checkpoint (People Ops acts) and as the employee's checklist elsewhere", () => {
    renderChart(demo({ manager_approval: { awaitingApproval: 23, waiting: 1 }, closeout: { awaitingApproval: 0, waiting: 2 } }));
    const ma = row("manager_approval");
    expect(within(ma).getByRole("link", { name: /^1 revision requested, People Ops acts/ }).getAttribute("href")).toBe("/cases?stage=manager_approval&status=blocked");
    expect(within(ma).getByText(": People Ops and managers act")).toBeTruthy();
    expect(within(ma).getByRole("link", { name: /^23 waiting on a decision by managers/ })).toBeTruthy();
    expect(within(row("closeout")).getByRole("link", { name: /^2 revisions requested, People Ops acts/ })).toBeTruthy();
    expect(within(row("closeout")).getByText(": People Ops acts")).toBeTruthy();
    expect(within(row("paperwork")).getByRole("link", { name: /^24 waiting on the employee/ }).getAttribute("href")).toBe("/cases?stage=paperwork&status=in_progress");
  });

  it("links every count to the matching case list, with names that start with the visible text", () => {
    renderChart(demo({ it_provisioning: { blocked: 3, active: 1 } }));
    const links = screen.getAllByRole("link");
    for (const l of links) expect(l.getAttribute("aria-label") ?? l.textContent).toMatch(new RegExp(`^${l.textContent!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    const href = (stage: StageId, name: RegExp) => within(row(stage)).getByRole("link", { name }).getAttribute("href");
    expect(href("it_provisioning", /^3 blocked/)).toBe("/cases?stage=it_provisioning&status=blocked");
    expect(href("it_provisioning", /^1 running/)).toBe("/cases?stage=it_provisioning&status=in_progress");
    expect(href("manager_approval", /^24 waiting on a decision/)).toBe("/cases?stage=manager_approval&status=awaiting_approval");
    expect(href("orientation", /^24 waiting on the employee/)).toBe("/cases?stage=orientation&status=in_progress");
    expect(href("it_provisioning", /^4\. IT provisioning/)).toBe("/cases?stage=it_provisioning&status=open");
  });

  it("has a legend with a swatch, an icon and a word per state, and keeps the bars out of the accessibility tree", () => {
    renderChart(demo());
    const legend = screen.getByRole("list", { name: "Legend" });
    expect(within(legend).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Blocked", "Waiting on a person", "Running"]);
    expect(legend.querySelectorAll(".swatch")).toHaveLength(3);
    expect(legend.querySelectorAll("svg.state-icon")).toHaveLength(3);
    expect([...document.querySelectorAll(".chart-bar")].every((b) => b.getAttribute("aria-hidden") === "true")).toBe(true);
    // every count carries an icon beside its words
    expect(row("it_provisioning").querySelectorAll(".stage-counts svg.state-icon")).toHaveLength(1);
    expect(screen.getByText("Bar length: open cases in the stage now; finished cases are counted as text.")).toBeTruthy();
  });

  it("swaps the bars for a captioned table with the same links", () => {
    renderChart(demo());
    const toggle = screen.getByRole("button", { name: "Show as table" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    const table = screen.getByRole("table", { name: "Open cases by stage and state" });
    expect(screen.queryByRole("list", { name: "cases per stage" })).toBeNull();
    const it = within(table).getByRole("row", { name: /4\. IT provisioning/ });
    expect(within(it).getByRole("link", { name: /^3 blocked/ }).getAttribute("href")).toBe("/cases?stage=it_provisioning&status=blocked");
    expect(it.textContent).toContain("IT acts");
    expect(within(table).getByRole("row", { name: /3\. Manager approval/ }).textContent).toContain("24 waiting on a decision by managers");
    fireEvent.click(toggle);
    expect(screen.getByRole("list", { name: "cases per stage" })).toBeTruthy();
  });

  it("says so when no case is open, and keeps the last frame at reduced opacity while paused", () => {
    renderChart(STAGE_IDS.map((s) => ({ ...zero(s), complete: 150 })), { complete: 150 });
    expect(screen.getByText("No open cases. 150 complete.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show as table" })).toBeNull();
    cleanup();
    renderChart(demo(), { stale: true });
    expect(screen.getByRole("figure", { name: "Where open cases are waiting" }).classList.contains("stale")).toBe(true);
    cleanup();
    renderChart(demo());
    expect(screen.getByRole("figure", { name: "Where open cases are waiting" }).classList.contains("stale")).toBe(false);
  });
});
