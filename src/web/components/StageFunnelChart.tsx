// Where open cases are waiting now, per stage, on one shared scale, with who
// has to act. Answers the admin's and the coordinators' first dashboard
// question: which stage holds work, and whose move is it?
//
// Each row is three lines: the stage name with who acts and a muted count of
// cases that finished the stage, a stacked bar of the cases open in the stage
// (blocked, waiting on a person, running), and the counts as links to the
// matching case lists. Bar length is the stage's open cases over the largest
// stage's, so a stage holding 3 blocked cases reads as a short bar, not a
// sliver beside the finished ones. Finished cases are text, not ink.
//
// The bars are decoration for sighted readers (aria-hidden): every number is
// text, every state has an icon and a word, and "Show as table" swaps in a
// captioned table with the same links. HTML, no chart library.
import { useId, useState } from "react";
import { Link } from "react-router";
import type { StageRollup } from "../../shared/agent-state.ts";
import { STAGE_BY_ID, type StageId } from "../../shared/stages.ts";
import { type Actor, blockedOwnersAt, waitingStatusAt } from "../../shared/who-acts.ts";
import { departmentsText } from "./actor-text.ts";
import { EmptyState } from "./EmptyState.tsx";
import { type StateGlyph, StateIcon } from "./StateIcon.tsx";

export type ChartSegment = "blocked" | "waiting" | "running";

export const SEGMENT_LEGEND: ReadonlyArray<{ key: ChartSegment; label: string; glyph: StateGlyph }> = [
  { key: "blocked", label: "Blocked", glyph: "cross" },
  { key: "waiting", label: "Waiting on a person", glyph: "pause" },
  { key: "running", label: "Running", glyph: "play" },
];

/** One non-zero state of a stage: its count, words, who acts (each actor on cases of its own), where its link goes. */
export type StageState = { segment: ChartSegment; n: number; text: string; actors: Actor[]; href: string; glyph: StateGlyph };

export type StageRow = {
  stage: StageId;
  name: string;
  open: number;
  done: number;
  states: StageState[];
  /** "IT acts", "managers act", "People Ops and IT act", "People Ops, IT or Facilities acts", "running" or "" (no open case). */
  who: string;
};

const casesAt = (stage: StageId, status: string) => `/cases?stage=${stage}&status=${status}`;

/** Who a state waits on, for the dashboard (many cases, so "managers"). */
function whoName(a: Actor): string | null {
  switch (a.kind) {
    case "employee":
      return "the employee";
    case "manager":
      return "managers";
    case "department":
      return departmentsText(a.departments);
    default:
      return null;
  }
}

/** "A", "A and B", "A, B and C". */
function andList(names: readonly string[]): string {
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Maps one hub rollup row to the chart's states (the hub folds revision_requested into `waiting`). */
export function stageRow(s: StageRollup): StageRow {
  const def = STAGE_BY_ID[s.stage];
  const states: StageState[] = [];
  if (s.blocked > 0) {
    // the owners of the blockers these cases are blocked by, each acting on its own cases, as the case page names
    // them; while a blocker is not open yet, one of the stage's structural owners ("People Ops, IT or Facilities")
    const owners = blockedOwnersAt(s.stage, s.blocked, s.blockedBy);
    const actors: Actor[] = owners.exact ? owners.departments.map((d) => ({ kind: "department", departments: [d] })) : [{ kind: "department", departments: owners.departments }];
    states.push({ segment: "blocked", n: s.blocked, text: `${s.blocked} blocked`, actors, href: casesAt(s.stage, "blocked"), glyph: "cross" });
  }
  if (s.waiting > 0) {
    states.push(
      waitingStatusAt(s.stage) === "revision_requested"
        ? // a revision's case status is blocked; the count names who acts, since the row may also wait on managers
          {
            segment: "waiting",
            n: s.waiting,
            text: `${s.waiting} ${s.waiting === 1 ? "revision" : "revisions"} requested, People Ops acts`,
            actors: [{ kind: "department", departments: ["people_ops"] }],
            href: casesAt(s.stage, "blocked"),
            glyph: "pause",
          }
        : { segment: "waiting", n: s.waiting, text: `${s.waiting} waiting on the employee`, actors: [{ kind: "employee" }], href: casesAt(s.stage, "in_progress"), glyph: "clock" },
    );
  }
  if (s.awaitingApproval > 0) {
    const byManager = def.checkpoint === "manager_approval";
    states.push({
      segment: "waiting",
      n: s.awaitingApproval,
      text: `${s.awaitingApproval} waiting on a decision by ${byManager ? "managers" : "People Ops"}`,
      actors: [byManager ? { kind: "manager" } : { kind: "department", departments: ["people_ops"] }],
      href: casesAt(s.stage, "awaiting_approval"),
      glyph: "pause",
    });
  }
  if (s.active > 0) states.push({ segment: "running", n: s.active, text: `${s.active} running`, actors: [{ kind: "workflow" }], href: casesAt(s.stage, "in_progress"), glyph: "play" });

  const names = [...new Set(states.flatMap((x) => x.actors.map(whoName)).filter((x): x is string => x !== null))];
  const plural = names.length > 1 || names[0] === "managers";
  const who = names.length > 0 ? `${andList(names)} ${plural ? "act" : "acts"}` : states.length > 0 ? "running" : "";
  const open = s.blocked + s.waiting + s.awaitingApproval + s.active;
  return { stage: s.stage, name: `${def.ordinal}. ${def.name}`, open, done: s.complete, states, who };
}

/** Each segment's width as a share of the largest stage's open cases (never below 1, so an empty chart has no NaN). */
export function segmentWidths(row: StageRow, maxOpen: number): Array<{ segment: ChartSegment; pct: number; n: number }> {
  const scale = Math.max(1, maxOpen);
  return SEGMENT_LEGEND.map(({ key }) => {
    const n = row.states.filter((x) => x.segment === key).reduce((a, x) => a + x.n, 0);
    return { segment: key, n, pct: (n / scale) * 100 };
  }).filter((x) => x.n > 0);
}

function Legend() {
  return (
    <ul className="chart-legend" aria-label="Legend">
      {SEGMENT_LEGEND.map((l) => (
        <li key={l.key}>
          <span className={`swatch seg-${l.key}`} aria-hidden="true" />
          <StateIcon glyph={l.glyph} />
          {l.label}
        </li>
      ))}
    </ul>
  );
}

function Bar({ row, maxOpen }: { row: StageRow; maxOpen: number }) {
  const segs = segmentWidths(row, maxOpen);
  if (segs.length === 0) return <div className="chart-bar" aria-hidden="true" />;
  // 2 px surface gaps between segments come out of the segments' own widths, so the bar keeps its length
  const gapShare = (2 * (segs.length - 1)) / segs.length;
  return (
    <div className="chart-bar" aria-hidden="true">
      {segs.map((s) => (
        <span key={s.segment} className={`seg seg-${s.segment}`} style={{ width: `calc(${s.pct.toFixed(3)}% - ${gapShare.toFixed(2)}px)` }} title={`${s.n} ${SEGMENT_LEGEND.find((l) => l.key === s.segment)!.label.toLowerCase()}`} />
      ))}
    </div>
  );
}

function StateLink({ s, stageName }: { s: StageState; stageName: string }) {
  return (
    <Link to={s.href} aria-label={`${s.text} at ${stageName}: show them`}>
      {s.text}
    </Link>
  );
}

function ChartTable({ rows, captionId }: { rows: StageRow[]; captionId: string }) {
  const cell = (r: StageRow, seg: ChartSegment) => {
    const parts = r.states.filter((x) => x.segment === seg);
    if (parts.length === 0) return "0";
    return parts.map((s, i) => (
      <span key={s.text}>
        {i > 0 ? ", " : null}
        <StateLink s={s} stageName={STAGE_BY_ID[r.stage].name} />
      </span>
    ));
  };
  return (
    <div className="table-wrap">
      <table className="list chart-table" aria-describedby={captionId}>
        <caption>Open cases by stage and state</caption>
        <thead>
          <tr>
            <th scope="col">Stage</th>
            <th scope="col">Blocked</th>
            <th scope="col">Waiting on a person</th>
            <th scope="col">Running</th>
            <th scope="col">Done</th>
            <th scope="col">Who acts</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.stage}>
              <th scope="row">
                <Link to={casesAt(r.stage, "open")}>{r.name}</Link>
              </th>
              <td>{cell(r, "blocked")}</td>
              <td>{cell(r, "waiting")}</td>
              <td>{cell(r, "running")}</td>
              <td>{r.done}</td>
              <td>{r.who || "nobody"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The stage chart. `complete`: cases that finished onboarding (for the empty state). `stale`: live updates
 * are paused, so the last frame stays on screen at reduced opacity.
 */
export function StageFunnelChart({ stages, complete, stale = false }: { stages: StageRollup[]; complete: number; stale?: boolean }) {
  const [asTable, setAsTable] = useState(false);
  const captionId = useId();
  const titleId = useId();
  const rows = stages.map(stageRow);
  const maxOpen = Math.max(1, ...rows.map((r) => r.open));
  const anyOpen = rows.some((r) => r.open > 0);
  return (
    <figure className={`chart${stale ? " stale" : ""}`} aria-labelledby={titleId} style={{ margin: 0 }}>
      <div className="chart-head">
        <h2 id={titleId}>Where open cases are waiting</h2>
        {anyOpen ? (
          <button type="button" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
            Show as table
          </button>
        ) : null}
      </div>
      {!anyOpen ? (
        <EmptyState>No open cases. {complete} complete.</EmptyState>
      ) : asTable ? (
        <ChartTable rows={rows} captionId={captionId} />
      ) : (
        <>
          <Legend />
          <ol className="stage-chart" aria-label="cases per stage">
            {rows.map((r) => (
              <li key={r.stage} data-testid={`funnel-${r.stage}`} className="stage-row">
                <div className="stage-row-head">
                  <span>
                    <Link to={casesAt(r.stage, "open")} aria-label={`${r.name}: ${r.open} open. Show them`}>
                      {r.name}
                    </Link>
                    {r.who ? <span className="who">: {r.who}</span> : null}
                  </span>
                  <span className="muted done">{r.done} done</span>
                </div>
                <Bar row={r} maxOpen={maxOpen} />
                <div className="stage-counts">
                  {r.states.length === 0 ? (
                    <span className="muted">No open cases</span>
                  ) : (
                    r.states.map((s) => (
                      <span key={s.text} className="count">
                        <StateIcon glyph={s.glyph} /> <StateLink s={s} stageName={STAGE_BY_ID[r.stage].name} />
                      </span>
                    ))
                  )}
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
      <figcaption id={captionId} className="muted small" style={{ marginTop: 8 }}>
        Bar length: open cases in the stage now; finished cases are counted as text.
      </figcaption>
    </figure>
  );
}
