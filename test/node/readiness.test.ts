import { describe, expect, it } from "vitest";
import { addDays, bucketReadiness, dayIndex, readinessClass, readinessWindow, weekStart, type ReadinessRow } from "../../src/shared/readiness.ts";

describe("readinessClass", () => {
  it("classes every case status", () => {
    expect(readinessClass("complete", "closeout", "complete")).toBe("ready");
    expect(readinessClass("failed", "it_provisioning", "failed")).toBe("failed");
    expect(readinessClass("not_started", null, null)).toBe("not_started");
    expect(readinessClass("blocked", "it_provisioning", "blocked")).toBe("blocked");
    expect(readinessClass("awaiting_approval", "manager_approval", "awaiting_approval")).toBe("waiting");
    expect(readinessClass("in_progress", "paperwork", "waiting_on_employee")).toBe("waiting");
    expect(readinessClass("in_progress", "it_provisioning", "active")).toBe("in_setup");
    expect(readinessClass("in_progress", "intake", "active")).toBe("in_setup");
  });

  it("counts a case from orientation on as ready, unless it is blocked", () => {
    expect(readinessClass("in_progress", "orientation", "waiting_on_employee")).toBe("ready");
    expect(readinessClass("awaiting_approval", "closeout", "awaiting_approval")).toBe("ready");
    // a blocked case is blocked wherever it is, so the count matches /cases?status=blocked
    expect(readinessClass("blocked", "closeout", "revision_requested")).toBe("blocked");
    expect(readinessClass("blocked", "orientation", "blocked")).toBe("blocked");
  });

  it("without the stage status (a list row), an open case before orientation is in setup or waiting", () => {
    expect(readinessClass("in_progress", "paperwork", null)).toBe("in_setup");
    expect(readinessClass("awaiting_approval", "manager_approval", null)).toBe("waiting");
  });
});

describe("date-only arithmetic", () => {
  it("finds the Monday of a week, from a Monday, a Sunday and across a year boundary", () => {
    expect(weekStart("2026-11-02")).toBe("2026-11-02"); // a Monday
    expect(weekStart("2026-11-08")).toBe("2026-11-02"); // the Sunday after it
    expect(weekStart("2026-10-16")).toBe("2026-10-12"); // a Friday
    expect(weekStart("2027-01-01")).toBe("2026-12-28"); // a Friday in the next year
    expect(weekStart("2027-01-03")).toBe("2026-12-28");
  });

  it("adds days in UTC from the string's parts and rejects what is not a date", () => {
    expect(addDays("2026-12-28", 7)).toBe("2027-01-04");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09"); // a DST change in the US does not move it
    expect(dayIndex("2026-02-31")).toBeNull();
    expect(dayIndex("Nov 2")).toBeNull();
  });

  it("lists every Monday from today's week to the window's last day", () => {
    expect(readinessWindow("2026-10-16", 2)).toEqual({ end: "2026-10-30", mondays: ["2026-10-12", "2026-10-19", "2026-10-26"] });
    expect(readinessWindow("2026-10-12", 2)).toEqual({ end: "2026-10-26", mondays: ["2026-10-12", "2026-10-19"] });
  });
});

describe("bucketReadiness", () => {
  const row = (startDate: string, caseStatus: ReadinessRow["caseStatus"], currentStage: ReadinessRow["currentStage"], stageStatus: ReadinessRow["stageStatus"], n: number): ReadinessRow => ({
    startDate,
    caseStatus,
    currentStage,
    stageStatus,
    n,
  });

  it("buckets past, near, far and out-of-window dates, and lists empty weeks", () => {
    const r = bucketReadiness(
      [
        row("2026-10-01", "in_progress", "orientation", "waiting_on_employee", 2), // already started, ready
        row("2026-10-05", "blocked", "it_provisioning", "blocked", 1), // already started, blocked
        row("2026-10-05", "complete", "closeout", "complete", 4), // started and finished: left out
        row("2026-10-16", "not_started", null, null, 1), // today: this week
        row("2026-10-21", "in_progress", "paperwork", "waiting_on_employee", 3),
        row("2026-10-25", "in_progress", "facilities_setup", "active", 1), // a Sunday: still the week of Oct 19
        row("2026-10-25", "complete", "closeout", "complete", 2),
        row("2026-10-29", "failed", "intake", "failed", 1), // last day of the window
        row("2026-10-30", "blocked", "intake", "blocked", 9), // past the window
        row("bogus", "blocked", "intake", "blocked", 9),
      ],
      "2026-10-16",
      2,
    );
    expect(r.asOf).toBe("2026-10-16");
    expect(r.alreadyStarted).toEqual({ total: 3, ready: 2, blocked: 1, waiting: 0, inSetup: 0, notStarted: 0, failed: 0 });
    expect(r.weeks).toEqual([
      { weekStart: "2026-10-12", total: 1, ready: 0, blocked: 0, waiting: 0, inSetup: 0, notStarted: 1, failed: 0 },
      { weekStart: "2026-10-19", total: 6, ready: 2, blocked: 0, waiting: 3, inSetup: 1, notStarted: 0, failed: 0 },
      { weekStart: "2026-10-26", total: 1, ready: 0, blocked: 0, waiting: 0, inSetup: 0, notStarted: 0, failed: 1 },
    ]);
  });

  it("returns null for alreadyStarted and zeroed weeks when nothing matches", () => {
    const r = bucketReadiness([], "2026-10-12", 1);
    expect(r.alreadyStarted).toBeNull();
    expect(r.weeks).toEqual([{ weekStart: "2026-10-12", total: 0, ready: 0, blocked: 0, waiting: 0, inSetup: 0, notStarted: 0, failed: 0 }]);
  });
});
