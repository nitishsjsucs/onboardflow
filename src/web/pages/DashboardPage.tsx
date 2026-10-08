// Live dashboard: the OpsHubAgent state over a read-only WebSocket, with the
// /api/dashboard/summary snapshot as the fallback until the first frame.
import type { HubState } from "../../shared/agent-state.ts";
import { useDashboardSummary } from "../api/queries.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { KpiTile } from "../components/KpiTile.tsx";
import { LiveIndicator } from "../components/LiveIndicator.tsx";
import { StageFunnelChart } from "../components/StageFunnelChart.tsx";
import { label } from "../components/StatusBadge.tsx";
import { useHubLive } from "../live/useHubLive.ts";

function Breakdown({ title, data }: { title: string; data: Record<string, number> }) {
  return (
    <section className="card" aria-label={title}>
      <h2>{title}</h2>
      <table className="list">
        <tbody>
          {Object.entries(data).map(([k, v]) => (
            <tr key={k} data-testid={`${title}-${k}`}>
              <td>{label(k)}</td>
              <td style={{ textAlign: "right" }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function DashboardView({ hub }: { hub: HubState }) {
  const total = Object.values(hub.totals).reduce((a, b) => a + b, 0);
  return (
    <>
      <div className="grid four">
        <KpiTile label="In progress" value={hub.totals.in_progress} tone="info" />
        <KpiTile label="Blocked" value={hub.totals.blocked} tone="bad" />
        <KpiTile label="Awaiting approval" value={hub.totals.awaiting_approval} tone="warn" />
        <KpiTile label="Complete" value={hub.totals.complete} tone="ok" />
      </div>
      <p className="muted">
        {total} cases: {hub.totals.not_started} not started, {hub.totals.failed} failed.
      </p>
      <section className="card" aria-label="stage funnel">
        <h2>Cases by stage</h2>
        <StageFunnelChart stages={hub.byStage} total={Math.max(1, total - hub.totals.not_started)} />
      </section>
      <div className="grid two">
        <Breakdown title="Open blockers by kind" data={hub.blockersOpen.byKind} />
        <Breakdown title="Open blockers by department" data={hub.blockersOpen.byDepartment} />
      </div>
      <div className="grid two">
        <section className="card" aria-label="approvals">
          <h2>Approvals</h2>
          <p data-testid="approvals-pending">
            <strong>{hub.approvalsPending.count}</strong> pending, <strong>{hub.approvalsPending.overdue}</strong> overdue
          </p>
          <h2>System incidents</h2>
          {hub.systemIncidents.length === 0 ? (
            <EmptyState>No incidents (3 or more cases blocked on one simulated system within 15 minutes).</EmptyState>
          ) : (
            <ul className="tasks">
              {hub.systemIncidents.map((i) => (
                <li key={i.system}>
                  <span>
                    <span className="badge bad">{i.system}</span> {i.casesAffected} cases since {new Date(i.openedAt).toLocaleTimeString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <h2>Integration health (simulated systems)</h2>
          <table className="list">
            <thead>
              <tr>
                <th>System</th>
                <th>Calls</th>
                <th>OK</th>
                <th>Retried</th>
                <th>Replayed</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(hub.integrationHealth).map(([sys, h]) => (
                <tr key={sys}>
                  <td>{sys}</td>
                  <td>{h.calls}</td>
                  <td>{h.ok}</td>
                  <td>{h.retried}</td>
                  <td>{h.replayed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card" aria-label="recent activity">
          <h2>Recent activity</h2>
          <ol className="timeline">
            {hub.recentActivity.slice(0, 15).map((a) => (
              <li key={a.seq}>
                <time className="muted">{new Date(a.occurredAt).toLocaleTimeString()}</time>
                <span>
                  <strong>{a.action}</strong> {a.employeeId ?? ""} <span className="muted">by {a.actorId}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>
      <p className="muted" style={{ fontSize: "0.8rem" }}>
        Reconciled {hub.reconciledAt ? new Date(hub.reconciledAt).toLocaleTimeString() : "never"} (version {hub.version}, audit seq {hub.asOfSeq}).
      </p>
    </>
  );
}

export function DashboardPage() {
  const live = useHubLive();
  const fallback = useDashboardSummary(!live.state);
  const hub = live.state ?? fallback.data ?? null;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Onboarding dashboard</h1>
          <div className="sub">All synthetic cases. HR, IT and Facilities are simulated systems.</div>
        </div>
        <LiveIndicator status={live.status} />
      </div>
      {hub ? <DashboardView hub={hub} /> : <p className="muted">Loading...</p>}
    </>
  );
}
