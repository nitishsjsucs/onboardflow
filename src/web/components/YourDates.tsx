// The employee's dates: the first day, what is due next (or overdue), and
// every task date in order, with the first day as a milestone and a "Today"
// marker between past and future. /me is the new hire's home page, often on a
// phone; it listed tasks by stage and never said when they start.
//
// Task due times are instants (17:00 UTC); they are grouped by the viewer's
// local calendar day. The start date is a calendar day (date-only). Each task
// links to its row in the checklist below and moves focus there.
import type { TaskView } from "../../shared/api.ts";
import { STAGE_BY_ID } from "../../shared/stages.ts";
import { countdownTo, countdownWords, daysUntil, formatDay, localDateOf } from "./dates.ts";
import { type StateGlyph, StateIcon } from "./StateIcon.tsx";
import { isOverdue, taskRowId } from "./TaskList.tsx";

export type TaskState = "done" | "overdue" | "not_open" | "open";
export type DatedTask = { task: TaskView; state: TaskState; word: string; glyph: StateGlyph };
export type TimelineEntry = { kind: "today"; date: string } | { kind: "day"; date: string; firstDay: boolean; tasks: DatedTask[] };

export function taskState(t: TaskView, notStarted: ReadonlySet<string>, overdueIds: ReadonlySet<string>, now: number): DatedTask {
  if (t.status === "done") return { task: t, state: "done", word: "Done", glyph: "check" };
  if (notStarted.has(t.stageId)) return { task: t, state: "not_open", word: `Opens when ${STAGE_BY_ID[t.stageId].name} starts`, glyph: "circle" };
  if (isOverdue(t, overdueIds, notStarted, now)) return { task: t, state: "overdue", word: "Overdue", glyph: "alert" };
  return { task: t, state: "open", word: "Open", glyph: "clock" };
}

/**
 * Days in order, each with its tasks (by local due day), the first day as its own day (holding the tasks due
 * then), and a Today marker before the first day that is today or later. Cancelled tasks are left out.
 */
export function datesTimeline(tasks: readonly TaskView[], startDate: string | null, notStarted: ReadonlySet<string>, overdueIds: ReadonlySet<string>, today: string, now: number): TimelineEntry[] {
  const days = new Map<string, DatedTask[]>();
  for (const t of tasks) {
    if (t.status === "cancelled" || !t.dueAt) continue;
    const day = localDateOf(t.dueAt);
    if (!day) continue;
    days.set(day, [...(days.get(day) ?? []), taskState(t, notStarted, overdueIds, now)]);
  }
  if (startDate && !days.has(startDate)) days.set(startDate, []);
  const out: TimelineEntry[] = [];
  let marked = false;
  for (const date of [...days.keys()].sort()) {
    if (!marked && date >= today) {
      out.push({ kind: "today", date: today });
      marked = true;
    }
    const list = days.get(date)!.sort((a, b) => (a.task.dueAt ?? "").localeCompare(b.task.dueAt ?? "") || a.task.title.localeCompare(b.task.title));
    out.push({ kind: "day", date, firstDay: date === startDate, tasks: list });
  }
  if (!marked && out.length > 0) out.push({ kind: "today", date: today });
  return out;
}

/** The lines under the welcome: the first day, the overdue tasks (first), and what is due next. */
export function keyDates(tasks: readonly TaskView[], startDate: string | null, notStarted: ReadonlySet<string>, overdueIds: ReadonlySet<string>, today: string, now: number): string[] {
  const lines: string[] = [];
  if (startDate) lines.push(`Your first day: ${formatDay(startDate, "long")} (${countdownTo(startDate, today)}).`);
  const dated = tasks.filter((t) => t.status === "open" && t.dueAt).map((t) => taskState(t, notStarted, overdueIds, now));
  const byDue = (a: DatedTask, b: DatedTask) => a.task.dueAt!.localeCompare(b.task.dueAt!);
  const overdue = dated.filter((d) => d.state === "overdue").sort(byDue);
  if (overdue.length > 0) {
    const oldest = overdue[0]!.task;
    const day = localDateOf(oldest.dueAt!)!;
    lines.push(`${overdue.length === 1 ? "1 task overdue" : `${overdue.length} tasks overdue`}; the oldest is ${oldest.title}, due ${formatDay(day, "long")} (${countdownWords(daysUntil(day, today) ?? 0)}).`);
  }
  const next = dated.filter((d) => d.state === "open").sort(byDue)[0];
  if (next) {
    const day = localDateOf(next.task.dueAt!)!;
    lines.push(`Next due: ${next.task.title}, ${formatDay(day, "long")} (${countdownTo(day, today)}).`);
  }
  return lines;
}

function focusTask(taskId: string) {
  const row = document.getElementById(taskRowId(taskId));
  row?.scrollIntoView?.({ block: "center" });
  row?.querySelector<HTMLElement>(".title")?.focus();
}

export function YourDates({ entries, today }: { entries: TimelineEntry[]; today: string }) {
  return (
    <ol className="your-dates" aria-label="your dates, in order">
      {entries.map((e) =>
        e.kind === "today" ? (
          <li key="today" className="today-marker">
            <time dateTime={e.date}>Today, {formatDay(e.date)}</time>
          </li>
        ) : (
          <li key={e.date} className={`date-group${e.firstDay ? " first-day" : ""}`}>
            <div className="date-head">
              <time dateTime={e.date}>{e.firstDay ? `First day: ${formatDay(e.date)}` : formatDay(e.date)}</time>
              <span className="muted"> {countdownTo(e.date, today)}</span>
            </div>
            {e.tasks.length > 0 ? (
              <ul className="date-tasks">
                {e.tasks.map((d) => (
                  <li key={d.task.id} className={d.state}>
                    <a
                      href={`#${taskRowId(d.task.id)}`}
                      onClick={(ev) => {
                        ev.preventDefault();
                        focusTask(d.task.id);
                      }}
                    >
                      {d.task.title}
                    </a>
                    <span className="date-state">
                      <StateIcon glyph={d.glyph} /> {d.word}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ),
      )}
    </ol>
  );
}
