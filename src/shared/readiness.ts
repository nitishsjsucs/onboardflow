// Readiness for day one, by start week. The dashboard's readiness card (and a
// manager's "starts soon, not ready" filter) ask one question per case: will
// this person be set up by their first day? A case counts as ready once it is
// complete or has reached orientation (the cross-system provisioning check is
// complete by then), unless it is blocked.
//
// Dates here are date-only strings (YYYY-MM-DD). They are calendar days, not
// instants, so all arithmetic is done in UTC on the string's parts and never
// through a local Date, which would move a day across time zones.
import type { CaseStatus, StageStatus } from "./domain.ts";
import type { StageId } from "./stages.ts";

export const READINESS_CLASSES = ["ready", "blocked", "waiting", "in_setup", "not_started", "failed"] as const;
export type ReadinessClass = (typeof READINESS_CLASSES)[number];

/** Response keys of each class. */
export const READINESS_KEYS = { ready: "ready", blocked: "blocked", waiting: "waiting", in_setup: "inSetup", not_started: "notStarted", failed: "failed" } as const satisfies Record<ReadinessClass, string>;
export type ReadinessCounts = { total: number; ready: number; blocked: number; waiting: number; inSetup: number; notStarted: number; failed: number };

const READY_STAGES: ReadonlySet<string> = new Set<StageId>(["orientation", "closeout"]);

/**
 * One case's class. Blocked comes before ready, so the blocked count always equals the case list filtered
 * by status=blocked (a case blocked at closeout, or a sign-off sent back for revision, is blocked).
 */
export function readinessClass(caseStatus: CaseStatus, currentStage: StageId | null, currentStageStatus: StageStatus | null): ReadinessClass {
  switch (caseStatus) {
    case "complete":
      return "ready";
    case "failed":
      return "failed";
    case "not_started":
      return "not_started";
    case "blocked":
      return "blocked";
    default:
      break;
  }
  if (currentStage && READY_STAGES.has(currentStage)) return "ready";
  if (caseStatus === "awaiting_approval" || currentStageStatus === "waiting_on_employee") return "waiting";
  return "in_setup";
}

const DAY_MS = 86_400_000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days since 1970-01-01 of a YYYY-MM-DD string, or null when it is not one. */
export function dayIndex(dateOnly: string): number | null {
  const m = DATE_ONLY.exec(dateOnly);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const back = new Date(t);
  // reject 2026-02-31 and the like, which Date.UTC would roll over
  if (back.getUTCFullYear() !== Number(m[1]) || back.getUTCMonth() !== Number(m[2]) - 1 || back.getUTCDate() !== Number(m[3])) return null;
  return t / DAY_MS;
}

export function fromDayIndex(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(dateOnly: string, days: number): string {
  const d = dayIndex(dateOnly);
  if (d === null) throw new Error(`not a date: ${dateOnly}`);
  return fromDayIndex(d + days);
}

/** The Monday of the week a YYYY-MM-DD date falls in. */
export function weekStart(dateOnly: string): string {
  const d = dayIndex(dateOnly);
  if (d === null) throw new Error(`not a date: ${dateOnly}`);
  // 1970-01-01 was a Thursday: (d + 3) % 7 is 0 on Mondays
  return fromDayIndex(d - ((d + 3) % 7));
}

export function emptyCounts(): ReadinessCounts {
  return { total: 0, ready: 0, blocked: 0, waiting: 0, inSetup: 0, notStarted: 0, failed: 0 };
}

export type ReadinessRow = { startDate: string; caseStatus: CaseStatus; currentStage: StageId | null; stageStatus: StageStatus | null; n: number };
export type StartReadiness = { asOf: string; weeks: Array<ReadinessCounts & { weekStart: string }>; alreadyStarted: ReadinessCounts | null };

/**
 * The window a request covers: from `today` up to (not including) `end`, `weeks` x 7 days later. The weeks
 * listed are every Monday from the one of today's week to the one of the window's last day, so a window
 * that starts mid-week lists one more week than `weeks` (its first week only from today on).
 */
export function readinessWindow(today: string, weeks: number): { end: string; mondays: string[] } {
  const end = addDays(today, weeks * 7);
  const mondays: string[] = [];
  for (let m = weekStart(today); m < end; m = addDays(m, 7)) mondays.push(m);
  return { end, mondays };
}

/**
 * Buckets grouped rows (start date, case status, current stage and its status, count) by start week. Start
 * dates before `today` that are not complete go to `alreadyStarted` (null when there are none); dates from
 * `end` on are ignored. Weeks with no start dates are listed with total 0.
 */
export function bucketReadiness(rows: readonly ReadinessRow[], today: string, weeks: number): StartReadiness {
  const { end, mondays } = readinessWindow(today, weeks);
  const byWeek = new Map(mondays.map((m) => [m, emptyCounts()]));
  let already: ReadinessCounts | null = null;
  for (const r of rows) {
    if (dayIndex(r.startDate) === null || r.startDate >= end) continue;
    const cls = readinessClass(r.caseStatus, r.currentStage, r.stageStatus);
    let target: ReadinessCounts | undefined;
    if (r.startDate < today) {
      if (r.caseStatus === "complete") continue;
      already ??= emptyCounts();
      target = already;
    } else {
      target = byWeek.get(weekStart(r.startDate));
    }
    if (!target) continue;
    target.total += r.n;
    target[READINESS_KEYS[cls]] += r.n;
  }
  return { asOf: today, weeks: mondays.map((m) => ({ weekStart: m, ...byWeek.get(m)! })), alreadyStarted: already };
}
