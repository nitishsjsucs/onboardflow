import { Link } from "react-router";

/** A headline number; with `to`, the whole tile links to the list behind it. */
export function KpiTile({ label, value, tone, to }: { label: string; value: number; tone?: "ok" | "warn" | "bad" | "info"; to?: string }) {
  const body = (
    <>
      <div className="value" style={tone ? { color: `var(--${tone})` } : undefined}>
        {value}
      </div>
      <div className="label">{label}</div>
    </>
  );
  return to ? (
    <Link className="card kpi kpi-link" to={to} data-testid={`kpi-${label}`} aria-label={`${label}: ${value} cases. Show them`}>
      {body}
    </Link>
  ) : (
    <div className="card kpi" data-testid={`kpi-${label}`}>
      {body}
    </div>
  );
}
