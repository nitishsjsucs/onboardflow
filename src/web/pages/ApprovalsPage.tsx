// Approvals: pending checkpoint cards for the approver (manager, People Ops,
// admin on behalf), plus rejected requests People Ops can revise and resubmit.
import type { ApprovalView } from "../../shared/api.ts";
import { useApprovals } from "../api/queries.ts";
import { can, useSession } from "../auth/session.tsx";
import { ApprovalCard } from "../components/ApprovalCard.tsx";
import { EmptyState } from "../components/EmptyState.tsx";

export function ApprovalsPage() {
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
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Approvals</h1>
          <div className="sub">Equipment and access requests (manager) and People Ops sign-off. Admins decide on behalf, and it is audited.</div>
        </div>
      </div>
      {pending.isLoading ? <p className="muted">Loading...</p> : null}
      {pending.data && pending.data.items.length === 0 ? <EmptyState>Nothing waiting for a decision.</EmptyState> : null}
      {(pending.data?.items ?? []).map((a) => (
        <ApprovalCard key={a.id} approval={a} canDecide={canDecide(a)} canResubmit={false} />
      ))}
      {showRejected && toResubmit.length > 0 ? (
        <>
          <h2 style={{ marginTop: 24 }}>Revision requested</h2>
          {toResubmit.map((a) => (
            <ApprovalCard key={a.id} approval={a} canDecide={false} canResubmit />
          ))}
        </>
      ) : null}
    </>
  );
}
