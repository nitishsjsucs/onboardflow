import { describe, expect, it } from "vitest";
import { countdownTo, countdownWords, daysSince, daysUntil, formatDate, formatDay, formatInstant, formatInstantDay, localDateOf, localToday } from "../../src/web/components/dates.ts";

describe("dates in words", () => {
  it("counts down in calendar days: today, tomorrow, in N days, N days ago", () => {
    expect(countdownWords(0)).toBe("today");
    expect(countdownWords(1)).toBe("tomorrow");
    expect(countdownWords(17)).toBe("in 17 days");
    expect(countdownWords(-1)).toBe("1 day ago");
    expect(countdownWords(-14)).toBe("14 days ago");
    expect(daysUntil("2026-11-02", "2026-10-16")).toBe(17);
    expect(daysUntil("2026-10-02", "2026-10-16")).toBe(-14);
    expect(countdownTo("2027-01-04", "2026-12-28")).toBe("in 7 days");
    expect(countdownTo("not a date", "2026-10-16")).toBe("");
  });

  it("reads a date-only value from its parts, so no time zone moves it a day", () => {
    expect(formatDay("2026-11-02")).toBe("Mon Nov 2");
    expect(formatDay("2026-11-30", "long")).toBe("Monday, November 30");
    expect(formatDay("2027-01-04")).toBe("Mon Jan 4");
    expect(formatDay("bogus")).toBe("bogus");
    expect(formatDate("2026-11-02")).toBe(new Date(2026, 10, 2).toLocaleDateString());
  });

  it("shows instants in local time and finds their local calendar day", () => {
    const iso = new Date(2026, 9, 8, 12, 5).toISOString();
    expect(formatInstant(iso)).toBe("Oct 8, 12:05");
    expect(formatInstantDay(iso)).toBe("Oct 8");
    expect(localDateOf(iso)).toBe("2026-10-08");
    expect(localToday(new Date(2026, 0, 3, 23, 59))).toBe("2026-01-03");
    expect(daysSince(iso, new Date(2026, 9, 16, 9))).toBe("8 days");
    expect(daysSince(iso, new Date(2026, 9, 9, 1))).toBe("1 day");
    expect(daysSince(iso, new Date(2026, 9, 8, 23))).toBe("today");
  });
});
