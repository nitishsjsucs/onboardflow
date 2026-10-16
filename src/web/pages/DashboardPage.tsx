// Live dashboard: the OpsHubAgent state over a read-only WebSocket, with the
// /api/dashboard/summary snapshot as the fallback until the first frame.
import { Link } from "react-router";
import type { HubState } from "../../shared/agent-state.ts";
import { useDashboardSummary } from "../api/queries.ts";
import { useSession } from "../auth/session.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { KpiTile } from "../components/KpiTile.tsx";
import { LiveIndicator } from "../components/LiveIndicator.tsx";
import { QueryState } from "../components/QueryState.tsx";
import { StageFunnelChart } from "../components/StageFunnelChart.tsx";
import { label } from "../components/StatusBadge.tsx";
import { useHubLive } from "../live/useHubLive.ts";
import { useDocumentTitle } from "../hooks/useDocumentTitle.ts";

/** A table of counts; with `linkTo`, each row's name links to the list behind it. */
function Breakdown({ title, data, linkTo }: { title: string; data: Record<string, number>; linkTo?: (key: string) => string }) {
  return (
    <section className="card" aria-label={title}>
      <h2>{title}</h2>
      <table className="list">
        <tbody>
          {Object.entries(data).map(([k, v]) => (
            <tr key={k} data-testid={`${title}-${k}`}>
              <td>{linkTo ? <Link to={linkTo(k)}>{label(k)}</Link> : label(k)}</td>
              <td style={{ textAlign: "right" }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function DashboardView({ hub, isAdmin = false }: { hub: HubState; isAdmin?: boolean }) {
  const total = Object.values(hub.totals).reduce((a, b) => a + b, 0);
  return (
    <>
      <div className="grid four">
        <KpiTile label="In progress" value={hub.totals.in_progress} tone="info" to="/cases?status=in_progress" />
        <KpiTile label="Blocked" value={hub.totals.blocked} tone="bad" to="/cases?status=blocked" />
        <KpiTile label="Awaiting approval" value={hub.totals.awaiting_approval} tone="warn" to="/cases?status=awaiting_approval" />
        <KpiTile label="Complete" value={hub.totals.complete} tone="ok" to="/cases?status=complete" />
      </div>
      <p className="muted">
        {total} cases: {hub.totals.not_started} not started, {hub.totals.failed} failed.
      </p>
      <section className="card" aria-label="stage funnel">
        <h2>Cases by stage</h2>
        <StageFunnelChart stages={hub.byStage} total={Math.max(1, total - hub.totals.not_started)} linkTo={(stage) => `/cases?stage=${stage}`} />
      </section>
      <div className="grid two">
        <Breakdown title="Open blockers by kind" data={hub.blockersOpen.byKind} linkTo={(k) => `/queue?kind=${k}`} />
        {/* a coordinator's queue is fixed to their own department, so only admins get these links */}
        <Breakdown title="Open blockers by department" data={hub.blockersOpen.byDepartment} {...(isAdmin ? { linkTo: (d: string) => `/queue?department=${d}` } : {})} />
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
          <div className="table-wrap">
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
          </div>
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

/** The fresher of the live frame and the snapshot (by reconcile time). */
function freshest(live: HubState | null, snapshot: HubState | undefined): HubState | null {
  if (!live) return snapshot ?? null;
  if (!snapshot) return live;
  return Date.parse(snapshot.reconciledAt) > Date.parse(live.reconciledAt) ? snapshot : live;
}

export function DashboardPage() {
  useDocumentTitle("Dashboard");
  const { me } = useSession();
  const live = useHubLive();
  // the snapshot (GET /api/dashboard/summary, about 1,400 D1 rows) is read once, or again only on Refresh: no polling
  const fallback = useDashboardSummary(!live.state);
  const hub = freshest(live.state, fallback.data);
  const paused = live.status === "offline" || live.status === "reconnecting";
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Onboarding dashboard</h1>
          <div className="sub">All synthetic cases. HR, IT and Facilities are simulated systems.</div>
        </div>
        <LiveIndicator status={live.status} />
      </div>
      {hub && paused ? (
        <p className="refresh-warning" role="status">
          Live updates paused; showing data from {new Date(hub.reconciledAt).toLocaleTimeString()}.{" "}
          <button type="button" onClick={() => void fallback.refetch()} disabled={fallback.isFetching}>
            {fallback.isFetching ? "Refreshing..." : "Refresh"}
          </button>
        </p>
      ) : null}
      {hub ? (
        <DashboardView hub={hub} isAdmin={me?.role === "admin"} />
      ) : (
        <QueryState query={fallback} what="the dashboard">
          {() => null}
        </QueryState>
      )}
    </>
  );
}
