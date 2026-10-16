import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChecklistDto, TaskView } from "../../src/shared/api.ts";
import { STAGES, type StageId } from "../../src/shared/stages.ts";
import { datesTimeline, keyDates } from "../../src/web/components/YourDates.tsx";
import { EmployeePortalPage } from "../../src/web/pages/EmployeePortalPage.tsx";
import { profile } from "./fixtures.ts";
import { mockFetch, PERSONAS, renderWith, type MockResponse } from "./harness.tsx";

vi.mock("../../src/web/live/useCaseLive.ts", () => ({ useCaseLive: () => ({ state: null, status: "connected" }) }));

// Fri Oct 16, 2026, local noon; E002 starts Mon Nov 30
const NOW = new Date(2026, 9, 16, 12);
const TODAY = "2026-10-16";
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

/** A task due at 17:00 UTC on a date, as the seed's templates are. */
function task(key: string, stageId: StageId, title: string, due: string, status: TaskView["status"] = "open"): TaskView {
  return {
    id: `chk:E002:${key}`,
    employeeId: "E002",
    stageId,
    kind: "checklist",
    templateKey: key,
    assignee: "employee",
    title,
    description: "d",
    status,
    dueAt: `${due}T17:00:00.000Z`,
    blockerId: null,
    draftedBy: "template",
    llmSuggestedCategory: null,
    createdAt: "2026-10-08T12:00:00.000Z",
    completedAt: null,
    completedBy: null,
  };
}

// E002's ten tasks in the demo state
const TASKS = [
  task("offer_docs", "paperwork", "Sign offer documents", "2026-11-16"),
  task("badge_photo", "paperwork", "Upload a badge photo", "2026-11-20"),
  task("i9_section1", "paperwork", "Complete Form I-9 Section 1", "2026-11-23"),
  task("w4", "paperwork", "Submit Form W-4", "2026-11-23"),
  task("direct_deposit", "paperwork", "Set up direct deposit", "2026-11-23"),
  task("emergency_contact", "paperwork", "Add an emergency contact", "2026-11-23"),
  task("enroll_mfa", "orientation", "Enroll in MFA", "2026-11-30"),
  task("attend_orientation", "orientation", "Attend orientation", "2026-12-01"),
  task("security_training", "orientation", "Complete security training", "2026-12-03"),
  task("meet_buddy", "orientation", "Meet your onboarding buddy", "2026-12-05"),
];
const ORIENTATION_PENDING = new Set(["orientation", "closeout"]);
const none = new Set<string>();

function checklist(tasks = TASKS, caseStatus: ChecklistDto["caseStatus"] = "in_progress"): ChecklistDto {
  return {
    caseStatus,
    stages: STAGES.map((s) => ({ id: s.id, ordinal: s.ordinal, name: s.name, owner: s.owner, status: s.id === "intake" ? "complete" : s.id === "paperwork" ? "waiting_on_employee" : "pending", round: 1, startedAt: null, completedAt: null, blockedReason: null })),
    tasks,
    blockers: [],
  };
}

function serve(data: ChecklistDto, profileAnswer: () => MockResponse = () => ({ body: profile({ id: "E002", startDate: "2026-11-30" }) })) {
  return mockFetch((url) => (url.startsWith("/api/employees/") ? profileAnswer() : { body: data }));
}

describe("the employee's dates (data)", () => {
  it("orders the dates, groups tasks due the same day, puts the first day between Nov 23 and Dec 1 with Enroll in MFA, and marks today", () => {
    const t = datesTimeline(TASKS, "2026-11-30", ORIENTATION_PENDING, none, TODAY, NOW.getTime());
    expect(t.map((e) => (e.kind === "today" ? `today ${e.date}` : `${e.firstDay ? "first " : ""}${e.date}: ${e.tasks.map((x) => x.task.title).join(" | ")}`))).toEqual([
      "today 2026-10-16",
      "2026-11-16: Sign offer documents",
      "2026-11-20: Upload a badge photo",
      "2026-11-23: Add an emergency contact | Complete Form I-9 Section 1 | Set up direct deposit | Submit Form W-4",
      "first 2026-11-30: Enroll in MFA",
      "2026-12-01: Attend orientation",
      "2026-12-03: Complete security training",
      "2026-12-05: Meet your onboarding buddy",
    ]);
  });

  it("puts the Today marker between past and future dates, and a first day with no task still shows", () => {
    const tasks = [task("a", "paperwork", "Past one", "2026-10-10", "done"), task("b", "paperwork", "Late one", "2026-10-12"), task("c", "paperwork", "Today one", "2026-10-16"), task("d", "paperwork", "Later", "2026-10-20")];
    const t = datesTimeline(tasks, "2026-11-02", none, none, TODAY, NOW.getTime());
    expect(t.map((e) => (e.kind === "today" ? "TODAY" : e.date))).toEqual(["2026-10-10", "2026-10-12", "TODAY", "2026-10-16", "2026-10-20", "2026-11-02"]);
    const last = t.at(-1)!;
    expect(last.kind === "day" && last.firstDay && last.tasks.length === 0).toBe(true);
    // every date in the past: the marker comes last
    expect(datesTimeline([task("a", "paperwork", "Past", "2026-10-01", "done")], null, none, none, TODAY, NOW.getTime()).map((e) => e.kind)).toEqual(["day", "today"]);
  });

  it("says each task's state in words: done, overdue, opens later, open", () => {
    const tasks = [task("a", "paperwork", "Done one", "2026-10-10", "done"), task("b", "paperwork", "Late one", "2026-10-12"), task("c", "orientation", "Later stage", "2026-12-01"), task("d", "paperwork", "Open one", "2026-10-20")];
    const words = datesTimeline(tasks, null, ORIENTATION_PENDING, none, TODAY, NOW.getTime()).flatMap((e) => (e.kind === "day" ? e.tasks.map((x) => `${x.task.title}: ${x.word}`) : []));
    expect(words).toEqual(["Done one: Done", "Late one: Overdue", "Open one: Open", "Later stage: Opens when Orientation and day one starts"]);
  });

  it("gives the first day, then overdue tasks first, then what is due next, with countdown words", () => {
    expect(keyDates(TASKS, "2026-11-30", ORIENTATION_PENDING, none, TODAY, NOW.getTime())).toEqual([
      "Your first day: Monday, November 30 (in 45 days).",
      "Next due: Sign offer documents, Monday, November 16 (in 31 days).",
    ]);
    const tasks = [task("a", "paperwork", "Sign offer documents", "2026-10-13"), task("b", "paperwork", "Submit Form W-4", "2026-10-15"), task("c", "paperwork", "Add an emergency contact", "2026-10-17")];
    expect(keyDates(tasks, "2026-10-16", none, none, TODAY, NOW.getTime())).toEqual([
      "Your first day: Friday, October 16 (today).",
      "2 tasks overdue; the oldest is Sign offer documents, due Tuesday, October 13 (3 days ago).",
      "Next due: Add an emergency contact, Saturday, October 17 (tomorrow).",
    ]);
    // without a start date (the profile did not load): no first-day line
    expect(keyDates([], null, none, none, TODAY, NOW.getTime())).toEqual([]);
  });
});

describe("My onboarding: dates", () => {
  it("shows the first day and the next due task under the welcome, and every date in order", async () => {
    serve(checklist());
    renderWith(<EmployeePortalPage />, { me: { ...PERSONAS.employee!, employeeId: "E002" }, path: "/me" });
    const key = await screen.findByRole("list", { name: "your key dates" });
    await waitFor(() => expect(within(key).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Your first day: Monday, November 30 (in 45 days).", "Next due: Sign offer documents, Monday, November 16 (in 31 days)."]));
    const dates = screen.getByRole("list", { name: "your dates, in order" });
    const groups = [...dates.children] as HTMLElement[];
    expect(groups[0]!.textContent).toBe("Today, Fri Oct 16");
    const firstDay = groups.find((g) => g.classList.contains("first-day"))!;
    expect(firstDay.querySelector("time")!.textContent).toBe("First day: Mon Nov 30");
    expect(firstDay.querySelector("time")!.getAttribute("dateTime")).toBe("2026-11-30");
    expect(within(firstDay).getByRole("link", { name: "Enroll in MFA" })).toBeTruthy();
    expect(within(firstDay).getByText(/Opens when Orientation and day one starts/)).toBeTruthy();
    // between the Nov 23 and Dec 1 groups
    const at = (date: string) => groups.findIndex((g) => g.querySelector("time")?.getAttribute("dateTime") === date);
    expect(at("2026-11-23")).toBeLessThan(groups.indexOf(firstDay));
    expect(at("2026-12-01")).toBeGreaterThan(groups.indexOf(firstDay));
  });

  it("moves focus to the task's row in the checklist when its date item is activated", async () => {
    serve(checklist());
    renderWith(<EmployeePortalPage />, { me: { ...PERSONAS.employee!, employeeId: "E002" }, path: "/me" });
    const dates = await screen.findByRole("list", { name: "your dates, in order" });
    const link = within(dates).getByRole("link", { name: "Submit Form W-4" });
    expect(link.getAttribute("href")).toBe("#task-chk:E002:w4");
    fireEvent.click(link);
    const row = document.getElementById("task-chk:E002:w4")!;
    expect(row.closest("section")!.getAttribute("aria-label")).toBe("Paperwork and verification checklist");
    expect(document.activeElement).toBe(row.querySelector(".title"));
  });

  it("leaves the first day out when the profile cannot load, and the checklist still works", async () => {
    const calls = serve(checklist(), () => ({ status: 500, body: { error: { code: "internal_error", message: "internal error", requestId: "r-1" } } }));
    renderWith(<EmployeePortalPage />, { me: { ...PERSONAS.employee!, employeeId: "E002" }, path: "/me" });
    const key = await screen.findByRole("list", { name: "your key dates" });
    await waitFor(() => expect(calls.some((c) => c.url.startsWith("/api/employees/"))).toBe(true));
    expect(within(key).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Next due: Sign offer documents, Monday, November 16 (in 31 days)."]);
    expect(document.querySelector(".first-day")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    const paperwork = screen.getByRole("region", { name: "Paperwork and verification checklist" });
    expect(within(paperwork).getByRole("button", { name: "Mark done: Submit Form W-4" })).toBeTruthy();
  });

  it("before onboarding starts: the first day, and when the tasks appear", async () => {
    serve(checklist([], "not_started"));
    renderWith(<EmployeePortalPage />, { me: { ...PERSONAS.employee!, employeeId: "E002" }, path: "/me" });
    const key = await screen.findByRole("list", { name: "your key dates" });
    await waitFor(() => expect(within(key).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Your first day: Monday, November 30 (in 45 days).", "Your tasks appear once People Ops starts your onboarding."]));
    expect(screen.queryByRole("list", { name: "your dates, in order" })).toBeNull();
  });
});
