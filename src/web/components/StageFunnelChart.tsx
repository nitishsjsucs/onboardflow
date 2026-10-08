// Hand-built SVG funnel: one horizontal stacked bar per stage (no chart library).
import type { StageRollup } from "../../shared/agent-state.ts";
import { STAGE_BY_ID } from "../../shared/stages.ts";

const SEGMENTS = [
  { key: "complete", label: "complete", color: "var(--ok)" },
  { key: "active", label: "active", color: "var(--info)" },
  { key: "waiting", label: "waiting on employee", color: "var(--warn)" },
  { key: "awaitingApproval", label: "awaiting approval", color: "var(--accent)" },
  { key: "blocked", label: "blocked", color: "var(--bad)" },
] as const;

export function StageFunnelChart({ stages, total }: { stages: StageRollup[]; total: number }) {
  const rowH = 26;
  const labelW = 210;
  const width = 640;
  const barW = width - labelW - 40;
  const height = stages.length * rowH + 30;
  const scale = (n: number) => (total > 0 ? (n / total) * barW : 0);
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label="cases per stage">
        {stages.map((s, i) => {
          let x = labelW;
          const y = i * rowH + 4;
          const def = STAGE_BY_ID[s.stage];
          return (
            <g key={s.stage} data-testid={`funnel-${s.stage}`}>
              <text x={0} y={y + 14} fontSize={12} fill="var(--text)">
                {def.ordinal}. {def.name.length > 30 ? `${def.name.slice(0, 29)}...` : def.name}
              </text>
              <rect x={labelW} y={y} width={barW} height={rowH - 8} fill="var(--idle-bg)" rx={3} />
              {SEGMENTS.map((seg) => {
                const n = s[seg.key];
                const w = scale(n);
                const rect = n > 0 ? <rect key={seg.key} x={x} y={y} width={w} height={rowH - 8} fill={seg.color} rx={2}><title>{`${n} ${seg.label}`}</title></rect> : null;
                x += w;
                return rect;
              })}
              <text x={width - 34} y={y + 14} fontSize={12} fill="var(--muted)">
                {s.active + s.waiting + s.awaitingApproval + s.blocked}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="row muted" style={{ fontSize: "0.8rem" }}>
        {SEGMENTS.map((seg) => (
          <span key={seg.key} className="row" style={{ gap: 4 }}>
            <span style={{ width: 10, height: 10, background: seg.color, display: "inline-block", borderRadius: 2 }} />
            {seg.label}
          </span>
        ))}
        <span>Right column: cases currently in the stage.</span>
      </figcaption>
    </figure>
  );
}
