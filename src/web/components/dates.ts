// Dates in words for the web client.
//
// Date-only values (YYYY-MM-DD, such as a start date) are calendar days, not
// instants: they are read from their parts, so no time zone moves them a day.
// Instants (ISO timestamps: due times, stage starts, detections) are shown in
// the viewer's local time. Names are written out in English, like the rest of
// the interface, so a date reads the same in every browser.
import { dayIndex } from "../../shared/readiness.ts";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
const short = (s: string) => s.slice(0, 3);
const pad = (n: number) => String(n).padStart(2, "0");

/** A date-only value (YYYY-MM-DD) in the local format, without the UTC shift new Date() would add. */
export function formatDate(v: unknown): string {
  const s = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString();
  const t = Date.parse(s);
  return /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(t) ? new Date(t).toLocaleDateString() : s;
}

/** The viewer's calendar date (YYYY-MM-DD). */
export function localToday(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The viewer's calendar date of an instant, or null when it is not one. */
export function localDateOf(iso: string): string | null {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : localToday(new Date(t));
}

/** Calendar days from `today` to a date-only value: 0 today, 1 tomorrow, -2 two days ago. */
export function daysUntil(dateOnly: string, today: string = localToday()): number | null {
  const a = dayIndex(dateOnly);
  const b = dayIndex(today);
  return a === null || b === null ? null : a - b;
}

/** "today", "tomorrow", "in 17 days", "1 day ago", "3 days ago". */
export function countdownWords(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days > 1) return `in ${days} days`;
  return days === -1 ? "1 day ago" : `${-days} days ago`;
}

/** Countdown words to a date-only value ("" when it is not one). */
export function countdownTo(dateOnly: string, today: string = localToday()): string {
  const d = daysUntil(dateOnly, today);
  return d === null ? "" : countdownWords(d);
}

/**
 * A date-only value in words: "Mon Nov 2" (short) or "Monday, November 2" (long). Not a date: the value as is.
 */
export function formatDay(dateOnly: string, style: "short" | "long" = "short"): string {
  const d = dayIndex(dateOnly);
  if (d === null) return dateOnly;
  const date = new Date(d * 86_400_000);
  const weekday = WEEKDAYS[date.getUTCDay()]!;
  const month = MONTHS[date.getUTCMonth()]!;
  return style === "long" ? `${weekday}, ${month} ${date.getUTCDate()}` : `${short(weekday)} ${short(month)} ${date.getUTCDate()}`;
}

/** An instant's local day: "Oct 8". */
export function formatInstantDay(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  return `${short(MONTHS[d.getMonth()]!)} ${d.getDate()}`;
}

/** An instant in local time: "Oct 8, 12:00". */
export function formatInstant(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  return `${short(MONTHS[d.getMonth()]!)} ${d.getDate()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** How long ago an instant was, in whole local calendar days: "today", "1 day", "8 days". */
export function daysSince(iso: string, now: Date = new Date()): string {
  const from = localDateOf(iso);
  const d = from === null ? null : daysUntil(localToday(now), from);
  if (d === null || d <= 0) return "today";
  return d === 1 ? "1 day" : `${d} days`;
}
