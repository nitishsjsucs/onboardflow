// Readiness by start week: will the next cohorts be set up by their first day?
// People Ops plans start dates, IT and Facilities prepare accounts, devices,
// desks and badges for them, and the admin watches all of it; none of them
// had a view of who starts soon and is not set up yet.
//
// One row per start week (soonest first, after a row for people who already
// started and are not finished): the week, how far away it is and how many
// start; a stacked bar on one shared scale (the busiest week is the longest);
// and the counts as text. A week within 21 days with anyone not ready gets a
// "4 not ready" flag at the end of its bar. Counts whose class maps to one
// case status (blocked, not started, failed) link to that list for the week,
// and the week's label links to everyone starting that week, so every link
// opens a list that matches its number. The window runs from today to the
// day before its end, so the first week counts only its days from today
// ("This week, from today") and the last only its days before the end
// ("Week of Mon Jan 4 to Thu Jan 7"): their labels and links say so.
import { type ReactNode, useId } from "react";
import { Link } from "react-router";
import type { StartReadinessDto } from "../../shared/api.ts";
import { addDays } from "../../shared/readiness.ts";
import { countdownWords, daysUntil, formatDay } from "./dates.ts";
import { EmptyState } from "./EmptyState.tsx";
import { type StateGlyph, StateIcon } from "./StateIcon.tsx";

type Counts = StartReadinessDto["weeks"][number];
type CountKey = "blocked" | "failed" | "waiting" | "inSetup" | "notStarted" | "ready";

/** The segments of a bar, in order: what needs attention first, ready last. */
export const READINESS_LEGEND: ReadonlyArray<{ key: "bad" | "waiting" | "setup" | "notStarted" | "ready"; label: string; glyph: StateGlyph; parts: CountKey[] }> = [
  { key: "bad", label: "Blocked or failed", glyph: "cross", parts: ["blocked", "failed"] },
  { key: "waiting", label: "Waiting on a person", glyph: "pause", parts: ["waiting"] },
  { key: "setup", label: "In setup", glyph: "play", parts: ["inSetup"] },
  { key: "notStarted", label: "Not started", glyph: "circle", parts: ["notStarted"] },
  { key: "ready", label: "Ready", glyph: "check", parts: ["ready"] },
];

const WORDS: Record<CountKey, string> = { blocked: "blocked", failed: "failed", waiting: "waiting on a person", inSetup: "in setup", notStarted: "not started", ready: "ready" };
/** The case status whose list matches a count exactly (the others have no single status). */
const STATUS_OF: Partial<Record<CountKey, string>> = { blocked: "blocked", notStarted: "not_started", failed: "failed" };
const COUNT_ORDER: CountKey[] = ["blocked", "failed", "waiting", "inSetup", "notStarted", "ready"];
export const FLAG_WITHIN_DAYS = 21;

export type ReadinessRowModel = {
  key: string;
  /**
   * "Week of Mon Nov 2, in 17 days, 15 people", "This week, from today (Fri Oct 16), 2 people",
   * "Week of Mon Jan 4 to Thu Jan 7, in 80 days, 15 people" or "Already started, not finished, 3 people"
   */
  label: string;
  /** The week's whole list (null for the already-started row, which no single filter matches). */
  labelHref: string | null;
  counts: Counts | Omit<Counts, "weekStart">;
  /** "4 not ready", for a week within 21 days (or already started) with anyone not ready. */
  flag: string | null;
  /** Count words with their links: "1 blocked", "5 in setup". */
  parts: Array<{ key: CountKey; text: string; href: string | null }>;
  empty: boolean;
};

const people = (n: number) => (n === 1 ? "1 person" : `${n} people`);

function listHref(range: { from?: string; to: string }, status?: string): string {
  const p = new URLSearchParams();
  if (status) p.set("status", status);
  if (range.from) p.set("startFrom", range.from);
  p.set("startTo", range.to);
  return `/cases?${p.toString()}`;
}

function partsFor(c: Omit<Counts, "weekStart">, range: { from?: string; to: string }): ReadinessRowModel["parts"] {
  return COUNT_ORDER.filter((k) => c[k] > 0).map((k) => {
    const status = STATUS_OF[k];
    return { key: k, text: `${c[k]} ${WORDS[k]}`, href: status ? listHref(range, status) : null };
  });
}

/** Maps the response to rows: the already-started row first (when there is one), then one per week. */
export function readinessRows(data: StartReadinessDto): ReadinessRowModel[] {
  const rows: ReadinessRowModel[] = [];
  const a = data.alreadyStarted;
  if (a && a.total > 0) {
    const range = { to: addDays(data.asOf, -1) };
    rows.push({ key: "already", label: `Already started, not finished, ${people(a.total)}`, labelHref: null, counts: a, flag: a.total > a.ready ? `${a.total - a.ready} not ready` : null, parts: partsFor(a, range), empty: false });
  }
  const lastDay = addDays(data.end, -1);
  for (const w of data.weeks) {
    const days = daysUntil(w.weekStart, data.asOf) ?? 0;
    const sunday = addDays(w.weekStart, 6);
    // the days of this week the counts cover: from today, and up to the window's last day
    const range = { from: w.weekStart < data.asOf ? data.asOf : w.weekStart, to: sunday > lastDay ? lastDay : sunday };
    const week =
      range.from !== w.weekStart
        ? `This week, from today (${formatDay(range.from)})`
        : `Week of ${formatDay(w.weekStart)}${range.to !== sunday ? ` to ${formatDay(range.to)}` : ""}, ${days <= 0 ? "this week" : countdownWords(days)}`;
    const notReady = w.total - w.ready;
    rows.push({
      key: w.weekStart,
      label: `${week}${w.total > 0 ? `, ${people(w.total)}` : ""}`,
      labelHref: w.total > 0 ? listHref(range) : null,
      counts: w,
      flag: w.total > 0 && notReady > 0 && days <= FLAG_WITHIN_DAYS ? `${notReady} not ready` : null,
      parts: partsFor(w, range),
      empty: w.total === 0,
    });
  }
  return rows;
}

/** Whether anyone starts in the window (or started and is not finished). */
export function hasStartDates(data: StartReadinessDto): boolean {
  return (data.alreadyStarted?.total ?? 0) > 0 || data.weeks.some((w) => w.total > 0);
}

function Legend() {
  return (
    <ul className="chart-legend" aria-label="Legend">
      {READINESS_LEGEND.map((l) => (
        <li key={l.key}>
          <span className={`swatch rd-${l.key}`} aria-hidden="true" />
          <StateIcon glyph={l.glyph} />
          {l.label}
        </li>
      ))}
    </ul>
  );
}

function Bar({ row, max }: { row: ReadinessRowModel; max: number }) {
  const segs = READINESS_LEGEND.map((l) => ({ key: l.key, label: l.label, n: l.parts.reduce((a, k) => a + row.counts[k], 0) })).filter((s) => s.n > 0);
  // 2 px surface gaps come out of the segments' own widths, so the bar keeps its length on the shared scale
  const gapShare = segs.length > 1 ? (2 * (segs.length - 1)) / segs.length : 0;
  return (
    <div className="readiness-bar-line">
      {segs.map((s, i) => (
        <span
          key={s.key}
          aria-hidden="true"
          className={`seg rd-${s.key}${i === segs.length - 1 ? " last" : ""}`}
          style={{ width: `calc(${((s.n / Math.max(1, max)) * 100).toFixed(3)}% - ${gapShare.toFixed(2)}px)` }}
          title={`${s.n} ${s.label.toLowerCase()}`}
        />
      ))}
    </div>
  );
}

/** "4 not ready": after the bar on a wide screen, beside the label on a phone (one element, placed by CSS grid). */
function Flag({ row }: { row: ReadinessRowModel }) {
  return row.flag ? (
    <span className="readiness-flag">
      <StateIcon glyph="alert" /> {row.flag}
    </span>
  ) : null;
}

function Parts({ row }: { row: ReadinessRowModel }) {
  return (
    <div className="readiness-counts">
      {row.parts.map((p, i) => (
        <span key={p.key}>
          {i > 0 ? ", " : null}
          {p.href ? (
            <Link to={p.href} aria-label={`${p.text}: ${row.label}. Show them`}>
              {p.text}
            </Link>
          ) : (
            p.text
          )}
        </span>
      ))}
    </div>
  );
}

function Label({ row }: { row: ReadinessRowModel }) {
  return row.labelHref ? (
    <Link to={row.labelHref} aria-label={`${row.label}. Show them`}>
      {row.label}
    </Link>
  ) : (
    <span>{row.label}</span>
  );
}

function ReadinessTable({ rows }: { rows: ReadinessRowModel[] }) {
  const cell = (r: ReadinessRowModel, k: CountKey) => {
    const p = r.parts.find((x) => x.key === k);
    return p?.href ? (
      <Link to={p.href} aria-label={`${r.counts[k]} ${WORDS[k]}: ${r.label}. Show them`}>
        {r.counts[k]}
      </Link>
    ) : (
      r.counts[k]
    );
  };
  return (
    <div className="table-wrap">
      <table className="list chart-table">
        <caption>People starting each week, by readiness for day one</caption>
        <thead>
          <tr>
            <th scope="col">Start week</th>
            <th scope="col">People</th>
            {COUNT_ORDER.map((k) => (
              <th key={k} scope="col">
                {WORDS[k][0]!.toUpperCase() + WORDS[k].slice(1)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row">
                <Label row={r} />
              </th>
              <td>{r.counts.total}</td>
              {COUNT_ORDER.map((k) => (
                <td key={k}>{cell(r, k)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The card's body (the page owns loading and errors). */
export function ReadinessChart({ data, asTable, stale = false, weeks }: { data: StartReadinessDto; asTable: boolean; stale?: boolean; weeks: number }) {
  const rows = readinessRows(data);
  const max = Math.max(1, ...rows.map((r) => r.counts.total));
  if (!hasStartDates(data)) return <EmptyState>No start dates in the next {weeks} weeks.</EmptyState>;
  return (
    <div className={`chart${stale ? " stale" : ""}`}>
      {asTable ? (
        <ReadinessTable rows={rows} />
      ) : (
        <>
          <Legend />
          <ol className="stage-chart readiness" aria-label="start weeks">
            {rows.map((r) =>
              r.empty ? (
                <li key={r.key} className="readiness-empty muted small" data-testid={`week-${r.key}`}>
                  {r.label}: no start dates
                </li>
              ) : (
                <li key={r.key} className="stage-row readiness-row" data-testid={`week-${r.key}`}>
                  <div className="stage-row-head">
                    <Label row={r} />
                  </div>
                  <Bar row={r} max={max} />
                  <Flag row={r} />
                  <Parts row={r} />
                </li>
              ),
            )}
          </ol>
        </>
      )}
    </div>
  );
}

export const READINESS_TITLE = "Readiness by start week";

/**
 * Title, table toggle and caption around the chart; `children` renders the body (or its loading and error states).
 * `titleId`: the id for its heading, so the card around it can take the heading as its name.
 */
export function ReadinessFigure({ children, canToggle, asTable, onToggle, titleId: givenTitleId }: { children: ReactNode; canToggle: boolean; asTable: boolean; onToggle: () => void; titleId?: string }) {
  const ownTitleId = useId();
  const titleId = givenTitleId ?? ownTitleId;
  return (
    <figure className="chart" aria-labelledby={titleId} style={{ margin: 0 }}>
      <div className="chart-head">
        <h2 id={titleId}>{READINESS_TITLE}</h2>
        {canToggle ? (
          // the name starts with the visible words and names the chart, since the stage chart has the same button
          <button type="button" aria-pressed={asTable} aria-label={`Show as table: ${READINESS_TITLE}`} onClick={onToggle}>
            Show as table
          </button>
        ) : null}
      </div>
      {children}
      <figcaption className="muted small" style={{ marginTop: 8 }}>
        Ready for day one: onboarding is complete, or the case has reached orientation and is not blocked, so accounts, devices, workspace and badge are set up and checked. Blocked includes requests sent back for revision. Bar length: people starting that week.
      </figcaption>
    </figure>
  );
}
