// Live dashboard: the OpsHubAgent state over a read-only WebSocket, with the
// /api/dashboard/summary snapshot as the fallback until the first frame.
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Link } from "react-router";
import type { HubState } from "../../shared/agent-state.ts";
import type { MeDto } from "../../shared/api.ts";
import { BLOCKER_KINDS, isOneOf } from "../../shared/domain.ts";
import { FIXED_BLOCKER_OWNER } from "../../shared/roles.ts";
import { DASHBOARD_CARD_STALE_MS, useDashboardSummary, useStartReadiness } from "../api/queries.ts";
import { useSession } from "../auth/session.tsx";
import { DEPARTMENT_NAMES } from "../components/blocker-text.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { KpiTile } from "../components/KpiTile.tsx";
import { LiveIndicator } from "../components/LiveIndicator.tsx";
import { QueryState } from "../components/QueryState.tsx";
import { hasStartDates, ReadinessChart, ReadinessFigure } from "../components/ReadinessChart.tsx";
import { StageFunnelChart } from "../components/StageFunnelChart.tsx";
import { label } from "../components/StatusBadge.tsx";
import { useHubLive } from "../live/useHubLive.ts";
import { useDocumentTitle } from "../hooks/useDocumentTitle.ts";
import { useThrottledCallback } from "../hooks/useThrottledCallback.ts";

/** A table of counts; with `linkTo`, a row's name links to the list behind it (no link where it returns null). */
function Breakdown({ title, data, linkTo, children }: { title: string; data: Record<string, number>; linkTo?: (key: string) => string | null; children?: ReactNode }) {
  return (
    <section className="card" aria-label={title}>
      <h2>{title}</h2>
      <table className="list">
        <tbody>
          {Object.entries(data).map(([k, v]) => {
            const to = linkTo?.(k);
            return (
              <tr key={k} data-testid={`${title}-${k}`}>
                <td>{to ? <Link to={to}>{label(k)}</Link> : label(k)}</td>
                <td style={{ textAlign: "right" }}>{v}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {children}
    </section>
  );
}

export const READINESS_WEEKS = 12;

/** Readiness by start week, with its own loading and error states inside the card. */
function ReadinessCard({ stale }: { stale: boolean }) {
  const q = useStartReadiness(READINESS_WEEKS);
  const [asTable, setAsTable] = useState(false);
  return (
    <section className="card" aria-label="readiness by start week">
      <ReadinessFigure canToggle={q.data !== undefined && hasStartDates(q.data)} asTable={asTable} onToggle={() => setAsTable((v) => !v)}>
        <QueryState query={q} what="readiness by start week">
          {() => <ReadinessChart data={q.data!} asTable={asTable} weeks={READINESS_WEEKS} stale={stale || q.isFetching} />}
        </QueryState>
      </ReadinessFigure>
    </section>
  );
}

/** Refetches the dashboard's aggregate cards (not the hub, which arrives live). */
function useRefreshCards() {
  const qc = useQueryClient();
  return () => Promise.all([["readiness"], ["changes"]].map((k) => qc.invalidateQueries({ queryKey: k })));
}

/**
 * Where a blocker kind's count links. The counts cover every department. An admin's queue shows them all; a
 * coordinator's queue is fixed to their own department, so a kind links only when all of its blockers are
 * that department's (approval and checklist kinds are People Ops'); the others would open an empty list.
 */
function kindLink(me: MeDto | null): ((kind: string) => string | null) | undefined {
  if (me?.role === "admin") return (k) => `/queue?kind=${k}`;
  const own = me?.role === "coordinator" ? me.department : undefined;
  if (!own) return undefined;
  return (k) => (isOneOf(BLOCKER_KINDS, k) && FIXED_BLOCKER_OWNER[k] === own ? `/queue?kind=${k}` : null);
}

export function DashboardView({ hub, me, stale = false }: { hub: HubState; me: MeDto | null; stale?: boolean }) {
  const total = Object.values(hub.totals).reduce((a, b) => a + b, 0);
  const isAdmin = me?.role === "admin";
  const ownDepartment = me?.role === "coordinator" && me.department ? DEPARTMENT_NAMES[me.department] : null;
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
        {/* a stage's open cases are started cases that have not finished; a completed case keeps its last stage, so its links filter by status */}
        <StageFunnelChart stages={hub.byStage} complete={hub.totals.complete} stale={stale} />
      </section>
      <ReadinessCard stale={stale} />
      <div className="grid two">
        <Breakdown title="Open blockers by kind" data={hub.blockersOpen.byKind} linkTo={kindLink(me)}>
          {ownDepartment ? (
            <p className="muted small" style={{ marginBottom: 0 }}>
              Counts cover every department. <Link to="/queue">Your queue</Link> lists {ownDepartment}&apos;s.
            </p>
          ) : null}
        </Breakdown>
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
  const refreshCards = useRefreshCards();
  // a new hub version means some case changed: refresh the aggregate cards, at most once a minute (no polling)
  const onVersion = useThrottledCallback(() => void refreshCards(), DASHBOARD_CARD_STALE_MS);
  const live = useHubLive({ onVersion });
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
          <button
            type="button"
            onClick={() => {
              void fallback.refetch();
              void refreshCards();
            }}
            disabled={fallback.isFetching}
          >
            {fallback.isFetching ? "Refreshing..." : "Refresh"}
          </button>
        </p>
      ) : null}
      {hub ? (
        <DashboardView hub={hub} me={me} stale={paused} />
      ) : (
        <QueryState query={fallback} what="the dashboard">
          {() => null}
        </QueryState>
      )}
    </>
  );
}
