export function KpiTile({ label, value, tone }: { label: string; value: number; tone?: "ok" | "warn" | "bad" | "info" }) {
  return (
    <div className="card kpi" data-testid={`kpi-${label}`}>
      <div className="value" style={tone ? { color: `var(--${tone})` } : undefined}>
        {value}
      </div>
      <div className="label">{label}</div>
    </div>
  );
}
