// Approvals: pending checkpoint items for the approver (manager, People Ops,
// admin on behalf), plus rejected requests People Ops can revise and resubmit.
// Manager approvals are full cards (each request differs). People Ops
// sign-offs are compact rows under a summary line, sorted by start date by
// default and grouped by how soon the person starts; admins see both, in two
// sections. An item someone acted on stays on screen with its outcome after
// the list refetches, so a confirmation ("Approved. IT provisioning starts
// next.") or "Already decided" is not swept away with it.
import { useEffect, useId, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import type { ApprovalView, MeDto } from "../../shared/api.ts";
import { isOneOf } from "../../shared/domain.ts";
import { useApprovals } from "../api/queries.ts";
import { can, useSession } from "../auth/session.tsx";
import { ApprovalCard } from "../components/ApprovalCard.tsx";
import { ApprovalRow, requestStartDate } from "../components/ApprovalRow.tsx";
import { daysUntil, localToday } from "../components/dates.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { QueryState } from "../components/QueryState.tsx";
import { useDocumentTitle } from "../hooks/useDocumentTitle.ts";

/** The fresh list plus the items acted on here that left it, in the server's order (by id). */
function withKept(items: ApprovalView[], kept: Record<string, ApprovalView>): ApprovalView[] {
  const ids = new Set(items.map((a) => a.id));
  return [...items, ...Object.values(kept).filter((a) => !ids.has(a.id))].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

export const SIGNOFF_SORTS = ["start", "overdue", "name"] as const;
export type SignoffSort = (typeof SIGNOFF_SORTS)[number];
const SORT_LABELS: Record<SignoffSort, string> = { start: "Start date, soonest first", overdue: "Most overdue first", name: "Name" };

export const SOON_DAYS = 14;
export const LATER_DAYS = 42;
export const START_GROUPS = ["Already started", "Starts within 2 weeks", "In 2 to 6 weeks", "Later"] as const;

/** Which start group a sign-off falls in: already started, within 14 days (today included), 15 to 42 days, later. */
export function startGroup(a: ApprovalView, today: string): (typeof START_GROUPS)[number] {
  const start = requestStartDate(a);
  const days = start ? daysUntil(start, today) : null;
  if (days === null || days > LATER_DAYS) return "Later";
  if (days < 0) return "Already started";
  return days <= SOON_DAYS ? "Starts within 2 weeks" : "In 2 to 6 weeks";
}

export function sortSignoffs(items: readonly ApprovalView[], sort: SignoffSort): ApprovalView[] {
  const byStart = (a: ApprovalView, b: ApprovalView) => (requestStartDate(a) ?? "9999").localeCompare(requestStartDate(b) ?? "9999") || a.id.localeCompare(b.id);
  const cmp: Record<SignoffSort, (a: ApprovalView, b: ApprovalView) => number> = {
    start: byStart,
    overdue: (a, b) => a.dueAt.localeCompare(b.dueAt) || byStart(a, b),
    name: (a, b) => a.employeeName.localeCompare(b.employeeName) || a.id.localeCompare(b.id),
  };
  return [...items].sort(cmp[sort]);
}

/** "24 sign-offs waiting, 24 overdue, 0 start within 2 weeks" (pending ones only). */
export function signoffSummary(items: readonly ApprovalView[], today: string, now = Date.now()): string {
  const waiting = items.filter((a) => a.status === "pending");
  const overdue = waiting.filter((a) => Date.parse(a.dueAt) < now).length;
  const soon = waiting.filter((a) => {
    const start = requestStartDate(a);
    const d = start ? daysUntil(start, today) : null;
    return d !== null && d >= 0 && d <= SOON_DAYS;
  }).length;
  return `${waiting.length} sign-off${waiting.length === 1 ? "" : "s"} waiting, ${overdue} overdue, ${soon} start${soon === 1 ? "s" : ""} within 2 weeks`;
}

function Signoffs({ items, me, onSettled }: { items: ApprovalView[]; me: MeDto | null; onSettled: (a: ApprovalView) => void }) {
  const [params, setParams] = useSearchParams();
  const sortParam = params.get("sort");
  const sort: SignoffSort = isOneOf(SIGNOFF_SORTS, sortParam) ? sortParam : "start";
  const noticeId = useId();
  const sortId = useId();
  const today = localToday();
  const sorted = sortSignoffs(items, sort);
  const setSort = (v: SignoffSort) => {
    const next = new URLSearchParams(params);
    if (v === "start") next.delete("sort");
    else next.set("sort", v);
    setParams(next, { replace: true, preventScrollReset: true });
  };
  const describedBy = me?.role === "admin" ? noticeId : undefined;
  const list = (rows: ApprovalView[]) => (
    <ul className="approval-rows">
      {rows.map((a) => (
        <ApprovalRow key={a.id} approval={a} onSettled={onSettled} describedBy={describedBy} today={today} />
      ))}
    </ul>
  );
  return (
    <section className="card" aria-labelledby={`${sortId}-title`}>
      <h2 id={`${sortId}-title`}>People Ops sign-offs</h2>
      <p className="signoff-summary" data-testid="signoff-summary">
        {signoffSummary(items, today)}
      </p>
      {me?.role === "admin" ? (
        <p id={noticeId} className="notice on-behalf">
          You are deciding these on behalf of People Ops. Each decision is audited.
        </p>
      ) : null}
      <div className="row" style={{ margin: "8px 0" }}>
        <label htmlFor={sortId}>Sort</label>
        <select id={sortId} value={sort} onChange={(e) => setSort(e.target.value as SignoffSort)}>
          {SIGNOFF_SORTS.map((s) => (
            <option key={s} value={s}>
              {SORT_LABELS[s]}
            </option>
          ))}
        </select>
      </div>
      {sort === "start"
        ? START_GROUPS.map((g) => {
            const rows = sorted.filter((a) => startGroup(a, today) === g);
            return rows.length > 0 ? (
              <div key={g} className="start-group">
                <h3>
                  {g} ({rows.length})
                </h3>
                {list(rows)}
              </div>
            ) : null;
          })
        : list(sorted)}
    </section>
  );
}

export function ApprovalsPage() {
  useDocumentTitle("Approvals");
  const { me } = useSession();
  const pending = useApprovals("pending");
  const showRejected = can.resubmit(me);
  const rejected = useApprovals("rejected", showRejected);
  const [keptPending, setKeptPending] = useState<Record<string, ApprovalView>>({});
  const [keptRevision, setKeptRevision] = useState<Record<string, ApprovalView>>({});
  const canDecide = (a: ApprovalView) =>
    !!me &&
    (me.role === "admin" ||
      (a.checkpoint === "manager_approval" && me.role === "manager" && me.staffId === a.approverStaffId) ||
      (a.checkpoint === "closeout" && me.role === "coordinator" && me.department === "people_ops"));
  // People Ops and admins decide sign-offs as compact rows; a manager never has one
  const signoffsAsRows = me?.role === "admin" || (me?.role === "coordinator" && me.department === "people_ops");
  const keepPending = (x: ApprovalView) => setKeptPending((k) => ({ ...k, [x.id]: x }));

  const toResubmit = withKept(
    (rejected.data?.items ?? []).filter((a) => a.resubmittable),
    keptRevision,
  );
  // /approvals#approval-<id> (from a queue item or a case page): scroll that item into view and focus it once the lists are in
  const location = useLocation();
  const ready = pending.data !== undefined && (!showRejected || rejected.data !== undefined);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!ready || !location.hash.startsWith("#approval-")) return;
    const el = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    setMissing(!el);
    if (el) {
      el.scrollIntoView?.({ block: "center" });
      el.focus();
    }
  }, [ready, location.hash]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Approvals</h1>
          <div className="sub">Equipment and access requests (manager) and People Ops sign-off. Admins decide on behalf, and it is audited.</div>
        </div>
      </div>
      {missing ? (
        <p className="notice card" role="status">
          That request is not waiting here any more; it may have been decided or resubmitted already.
        </p>
      ) : null}
      <QueryState query={pending} what="the approvals">
        {() => {
          const items = withKept(pending.data!.items, keptPending);
          if (items.length === 0) return <EmptyState>Nothing waiting for a decision.</EmptyState>;
          const cards = signoffsAsRows ? items.filter((a) => a.checkpoint !== "closeout") : items;
          const rows = signoffsAsRows ? items.filter((a) => a.checkpoint === "closeout") : [];
          return (
            <>
              {cards.length > 0 ? (
                <>
                  {me?.role === "admin" ? <h2>Manager approvals</h2> : null}
                  {cards.map((a) => (
                    <ApprovalCard key={a.id} approval={a} me={me} canDecide={canDecide(a)} canResubmit={false} onSettled={keepPending} />
                  ))}
                </>
              ) : null}
              {rows.length > 0 ? <Signoffs items={rows} me={me} onSettled={keepPending} /> : null}
            </>
          );
        }}
      </QueryState>
      {showRejected ? (
        <QueryState query={rejected} what="the requests waiting for a revision">
          {() =>
            toResubmit.length > 0 ? (
              <>
                <h2 style={{ marginTop: 24 }}>Revision requested</h2>
                {toResubmit.map((a) => (
                  <ApprovalCard key={a.id} approval={a} me={me} canDecide={false} canResubmit onSettled={(x) => setKeptRevision((k) => ({ ...k, [x.id]: x }))} />
                ))}
              </>
            ) : null
          }
        </QueryState>
      ) : null}
    </>
  );
}
