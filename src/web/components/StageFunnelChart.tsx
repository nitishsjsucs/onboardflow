// Cases per stage as HTML rows (no chart library): the stage name and the
// number of cases in it on one line, then a stacked bar with percentage
// widths. Every count is real text (each segment carries a visually hidden
// "<n> <label>"), so labels render at body size on a phone and screen
// readers read the numbers.
import { Link } from "react-router";
import type { StageRollup } from "../../shared/agent-state.ts";
import { STAGE_BY_ID } from "../../shared/stages.ts";

const SEGMENTS = [
  { key: "complete", label: "complete", color: "var(--ok)" },
  { key: "active", label: "active", color: "var(--info)" },
  { key: "waiting", label: "waiting on employee", color: "var(--warn)" },
  { key: "awaitingApproval", label: "awaiting approval", color: "var(--accent)" },
  { key: "blocked", label: "blocked", color: "var(--bad)" },
] as const;

/** `linkTo(stage)` makes each stage name a link (the dashboard links to the cases at that stage). */
export function StageFunnelChart({ stages, total, linkTo }: { stages: StageRollup[]; total: number; linkTo?: (stage: string) => string }) {
  const pct = (n: number) => (total > 0 ? Math.min(100, (n / total) * 100) : 0);
  return (
    <figure style={{ margin: 0 }}>
      <ol className="funnel" aria-label="cases per stage">
        {stages.map((s) => {
          const def = STAGE_BY_ID[s.stage];
          const inStage = s.active + s.waiting + s.awaitingApproval + s.blocked;
          const name = `${def.ordinal}. ${def.name}`;
          return (
            <li key={s.stage} data-testid={`funnel-${s.stage}`}>
              <div className="funnel-head">
                {linkTo ? (
                  <Link to={linkTo(s.stage)} aria-label={`${name}: ${inStage} in stage. Show them`}>
                    {name}
                  </Link>
                ) : (
                  <span>{name}</span>
                )}
                <span className="funnel-count">{inStage} in stage</span>
              </div>
              <div className="funnel-bar">
                {SEGMENTS.map((seg) => {
                  const n = s[seg.key];
                  return n > 0 ? (
                    <span key={seg.key} className="seg" style={{ width: `${pct(n)}%`, background: seg.color }} title={`${n} ${seg.label}`}>
                      <span className="visually-hidden">
                        {n} {seg.label}
                      </span>
                    </span>
                  ) : null;
                })}
              </div>
            </li>
          );
        })}
      </ol>
      <figcaption className="row muted" style={{ fontSize: "0.8rem", marginTop: 8 }}>
        {SEGMENTS.map((seg) => (
          <span key={seg.key} className="row" style={{ gap: 4 }}>
            <span style={{ width: 10, height: 10, background: seg.color, display: "inline-block", borderRadius: 2 }} />
            {seg.label}
          </span>
        ))}
        <span>Bar widths are shares of all started cases.</span>
      </figcaption>
    </figure>
  );
}
