// Approvals: pending checkpoint cards for the approver (manager, People Ops,
// admin on behalf), plus rejected requests People Ops can revise and resubmit.
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import type { ApprovalView } from "../../shared/api.ts";
import { useApprovals } from "../api/queries.ts";
import { can, useSession } from "../auth/session.tsx";
import { ApprovalCard } from "../components/ApprovalCard.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { QueryState } from "../components/QueryState.tsx";
import { useDocumentTitle } from "../hooks/useDocumentTitle.ts";

export function ApprovalsPage() {
  useDocumentTitle("Approvals");
  const { me } = useSession();
  const pending = useApprovals("pending");
  const showRejected = can.resubmit(me);
  const rejected = useApprovals("rejected", showRejected);
  const canDecide = (a: ApprovalView) =>
    !!me &&
    (me.role === "admin" ||
      (a.checkpoint === "manager_approval" && me.role === "manager" && me.staffId === a.approverStaffId) ||
      (a.checkpoint === "closeout" && me.role === "coordinator" && me.department === "people_ops"));

  const toResubmit = (rejected.data?.items ?? []).filter((a) => a.resubmittable);
  // /approvals#approval-<id> (from a queue item): scroll that card into view and focus it once the lists are in
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
        {() =>
          pending.data!.items.length === 0 ? (
            <EmptyState>Nothing waiting for a decision.</EmptyState>
          ) : (
            pending.data!.items.map((a) => <ApprovalCard key={a.id} approval={a} canDecide={canDecide(a)} canResubmit={false} />)
          )
        }
      </QueryState>
      {showRejected ? (
        <QueryState query={rejected} what="the requests waiting for a revision">
          {() =>
            toResubmit.length > 0 ? (
              <>
                <h2 style={{ marginTop: 24 }}>Revision requested</h2>
                {toResubmit.map((a) => (
                  <ApprovalCard key={a.id} approval={a} canDecide={false} canResubmit />
                ))}
              </>
            ) : null
          }
        </QueryState>
      ) : null}
    </>
  );
}
