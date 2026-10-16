import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmployeeSummary } from "../../src/shared/api.ts";
import { localToday } from "../../src/web/components/dates.ts";
import { caseNow, myPendingByEmployee } from "../../src/web/components/TeamList.tsx";
import { CasesPage, startsSoonNotReady } from "../../src/web/pages/CasesPage.tsx";
import { approval, employee } from "./fixtures.ts";
import { mockFetch, PERSONAS, renderWith, type MockResponse } from "./harness.tsx";

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const inDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return localToday(d);
};

// M01's team, as in the demo state
const VAL = employee("E140", "Val Everly", { caseStatus: "awaiting_approval", currentStage: "manager_approval", startDate: inDays(38) });
const ELLIOT = employee("E103", "Elliot Okonkwo", { caseStatus: "awaiting_approval", currentStage: "closeout", startDate: inDays(80) });
const ARJUN = employee("E002", "Arjun Greystone", { caseStatus: "in_progress", currentStage: "paperwork", startDate: inDays(45) });
const CASEY = employee("E042", "Casey Tamsin", { caseStatus: "in_progress", currentStage: "paperwork", startDate: inDays(38) });
const MATEO = employee("E065", "Mateo Jarrow", { caseStatus: "complete", currentStage: "closeout", startDate: inDays(17) });
const RAVEL = employee("E057", "Logan Ravel", { caseStatus: "blocked", currentStage: "it_provisioning", openBlockers: 1, startDate: inDays(10) });
const TEAM = [ELLIOT, ARJUN, CASEY, MATEO, RAVEL, VAL];
const VAL_APPROVAL = approval({ id: "apr:E140:manager_approval:1", employeeId: "E140", employeeName: "Val Everly", approverStaffId: "M01" });

function serve(items: EmployeeSummary[], approvals: () => MockResponse = () => ({ body: { items: [VAL_APPROVAL], nextCursor: null } })) {
  return mockFetch((url) => {
    if (url.startsWith("/api/approvals")) return approvals();
    return { body: { items, nextCursor: null } };
  });
}
const rows = () => within(screen.getByRole("list", { name: "your direct reports" })).getAllByRole("listitem");

describe("caseNow", () => {
  it("says what each case status waits on, at representative stages", () => {
    const mine = VAL_APPROVAL;
    const at = (caseStatus: EmployeeSummary["caseStatus"], currentStage: EmployeeSummary["currentStage"]) => ({ caseStatus, currentStage });
    expect(caseNow(at("awaiting_approval", "manager_approval"), mine)).toMatchObject({ state: "you", text: "Waiting on you", decideHref: "/approvals#approval-apr%3AE140%3Amanager_approval%3A1" });
    expect(caseNow(at("awaiting_approval", "manager_approval"), undefined)).toMatchObject({ state: "decision", text: "Waiting on a decision", decideHref: null });
    expect(caseNow(at("awaiting_approval", "closeout"), undefined).text).toBe("People Ops sign-off");
    expect(caseNow(at("blocked", "manager_approval"), undefined).text).toBe("Revision requested: People Ops revises and resubmits");
    expect(caseNow(at("blocked", "it_provisioning"), undefined).text).toBe("Blocked: IT on it");
    // the owner of the blocker the stage is blocked by, as the case page names it; without one, the stage's owners
    expect(caseNow({ ...at("blocked", "provisioning_verification"), blockerOwner: "people_ops" }, undefined).text).toBe("Blocked: People Ops on it");
    expect(caseNow({ ...at("blocked", "it_provisioning"), blockerOwner: "people_ops" }, undefined).text).toBe("Blocked: People Ops on it");
    expect(caseNow({ ...at("blocked", "provisioning_verification"), blockerOwner: null }, undefined).text).toBe("Blocked: People Ops, IT or Facilities on it");
    expect(caseNow(at("in_progress", "paperwork"), undefined).text).toBe("The employee's checklist");
    expect(caseNow(at("in_progress", "orientation"), undefined).text).toBe("The employee's checklist");
    for (const s of ["intake", "it_provisioning", "facilities_setup", "provisioning_verification"] as const) expect(caseNow(at("in_progress", s), undefined).text).toBe("Running (automated)");
    expect(caseNow(at("not_started", null), undefined).text).toBe("Not started: People Ops starts it");
    expect(caseNow(at("complete", "closeout"), undefined).text).toBe("Complete");
    expect(caseNow(at("failed", "intake"), undefined).text).toBe("Failed: an admin can restart it");
    // when the approvals could not load, "you" cannot be told apart
    expect(caseNow(at("awaiting_approval", "manager_approval"), mine, false).text).toBe("Waiting on a decision");
  });

  it("counts an approval as the manager's own only when its approver is that manager", () => {
    expect(myPendingByEmployee([VAL_APPROVAL], PERSONAS.manager!).get("E140")?.id).toBe(VAL_APPROVAL.id);
    expect(myPendingByEmployee([{ ...VAL_APPROVAL, approverStaffId: "M02" }], PERSONAS.manager!).size).toBe(0);
    expect(myPendingByEmployee([{ ...VAL_APPROVAL, status: "approved" }], PERSONAS.manager!).size).toBe(0);
    expect(myPendingByEmployee([{ ...VAL_APPROVAL, checkpoint: "closeout" }], PERSONAS.manager!).size).toBe(0);
  });

  it("finds reports who start within 30 days and are not ready", () => {
    const today = localToday();
    expect(startsSoonNotReady(RAVEL, today)).toBe(true);
    expect(startsSoonNotReady(MATEO, today)).toBe(false); // complete
    expect(startsSoonNotReady(VAL, today)).toBe(false); // 38 days away
    expect(startsSoonNotReady(employee("E1", "A B", { caseStatus: "in_progress", currentStage: "orientation", startDate: inDays(5) }), today)).toBe(false); // ready
    expect(startsSoonNotReady(employee("E2", "C D", { caseStatus: "not_started", startDate: inDays(30) }), today)).toBe(true);
    expect(startsSoonNotReady(employee("E3", "E F", { caseStatus: "in_progress", currentStage: "paperwork", startDate: inDays(-2) }), today)).toBe(true);
  });
});

describe("My team (managers)", () => {
  it("puts the report waiting on you first, then the soonest start dates, with a Decide link", async () => {
    serve(TEAM);
    renderWith(<CasesPage />, { me: PERSONAS.manager!, path: "/cases" });
    await screen.findByRole("list", { name: "your direct reports" });
    await waitFor(() => expect(rows()[0]!.dataset.testid).toBe("team-E140"));
    expect(rows().map((r) => r.dataset.testid)).toEqual(["team-E140", "team-E057", "team-E065", "team-E042", "team-E002", "team-E103"]);
    const val = rows()[0]!;
    expect(within(val).getByRole("link", { name: "Val Everly" }).getAttribute("href")).toBe("/cases/E140");
    expect(within(val).getByRole("link", { name: "Decide for Val Everly" }).getAttribute("href")).toBe("/approvals#approval-apr%3AE140%3Amanager_approval%3A1");
    // the row's text carries the stage number and name, and who acts; the strip is decoration
    expect(val.textContent).toContain("Stage 3 of 8: Manager approval of equipment and access");
    expect(val.textContent).toContain("Waiting on you");
    expect(val.textContent).toContain("in 38 days");
    const strip = val.querySelector(".strip")!;
    expect(strip.getAttribute("aria-hidden")).toBe("true");
    expect(strip.querySelectorAll(".strip-pip")).toHaveLength(8);
    expect(strip.querySelectorAll(".strip-pip.done")).toHaveLength(2);
    expect(strip.querySelectorAll(".strip-pip.current")).toHaveLength(1);
    expect(within(screen.getByTestId("team-E103")).getByText("People Ops sign-off")).toBeTruthy();
    expect(within(screen.getByTestId("team-E002")).getByText("The employee's checklist")).toBeTruthy();
    expect(within(screen.getByTestId("team-E057")).getByText("Blocked: IT on it")).toBeTruthy();
    expect(screen.getByTestId("team-E057").textContent).toContain("(1 open blocker)");
    // the manager's table is gone
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("after a rejection the report reads revision requested and is no longer first", async () => {
    serve([...TEAM.filter((e) => e.id !== "E140"), { ...VAL, caseStatus: "blocked" }], () => ({ body: { items: [], nextCursor: null } }));
    renderWith(<CasesPage />, { me: PERSONAS.manager!, path: "/cases" });
    await screen.findByRole("list", { name: "your direct reports" });
    expect(within(screen.getByTestId("team-E140")).getByText("Revision requested: People Ops revises and resubmits")).toBeTruthy();
    expect(rows()[0]!.dataset.testid).toBe("team-E057");
  });

  it("filters to reports starting within 30 days and not ready, kept in the URL", async () => {
    serve(TEAM);
    const { router } = renderWith(<CasesPage />, { me: PERSONAS.manager!, path: "/cases" });
    await screen.findByRole("list", { name: "your direct reports" });
    const chip = screen.getByRole("button", { name: "Starts within 30 days, not ready" });
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(chip);
    await waitFor(() => expect(router.state.location.search).toBe("?soon=1"));
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(rows().map((r) => r.dataset.testid)).toEqual(["team-E057"]);
    expect(screen.getByText(/; 1 start within 30 days, not ready/)).toBeTruthy();
    fireEvent.click(chip);
    await waitFor(() => expect(router.state.location.search).toBe(""));
    expect(rows()).toHaveLength(6);
    cleanup();
    // a reload with the chip on keeps it
    serve(TEAM);
    renderWith(<CasesPage />, { me: PERSONAS.manager!, path: "/cases?soon=1" });
    await screen.findByRole("list", { name: "your direct reports" });
    expect(rows()).toHaveLength(1);
  });

  it("says when nobody matches, and when the team is empty", async () => {
    serve([MATEO]);
    renderWith(<CasesPage />, { me: PERSONAS.manager!, path: "/cases?soon=1" });
    expect(await screen.findByText("Nobody on your team starts within 30 days without being ready.")).toBeTruthy();
    cleanup();
    serve([]);
    renderWith(<CasesPage />, { me: PERSONAS.manager!, path: "/cases" });
    expect(await screen.findByText("No matching employees.")).toBeTruthy();
  });

  it("still lists the team when the approvals cannot load, and says why rows read 'Waiting on a decision'", async () => {
    let n = 0;
    serve(TEAM, () => (++n === 1 ? { status: 503, body: { error: { code: "unavailable", message: "try later", requestId: "r-3" } } } : { body: { items: [VAL_APPROVAL], nextCursor: null } }));
    renderWith(<CasesPage />, { me: PERSONAS.manager!, path: "/cases" });
    const note = await screen.findByText(/Could not load your pending approvals/);
    expect(within(screen.getByTestId("team-E140")).getByText("Waiting on a decision")).toBeTruthy();
    expect(within(screen.getByTestId("team-E140")).queryByRole("link", { name: /^Decide/ })).toBeNull();
    fireEvent.click(within(note.closest("p")!).getByRole("button", { name: "Try again" }));
    expect(await within(screen.getByTestId("team-E140")).findByText("Waiting on you")).toBeTruthy();
  });

  it("keeps the table for coordinators and admins, and never asks them for approvals here", async () => {
    const calls = serve(TEAM);
    renderWith(<CasesPage />, { me: PERSONAS.peopleOps!, path: "/cases" });
    expect(await screen.findByRole("table")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "your direct reports" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Starts within 30 days/ })).toBeNull();
    expect(calls.some((c) => c.url.startsWith("/api/approvals"))).toBe(false);
  });
});
