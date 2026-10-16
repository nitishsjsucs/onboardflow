// Approvals: pending checkpoint cards for the approver (manager, People Ops,
// admin on behalf), plus rejected requests People Ops can revise and resubmit.
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
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Approvals</h1>
          <div className="sub">Equipment and access requests (manager) and People Ops sign-off. Admins decide on behalf, and it is audited.</div>
        </div>
      </div>
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
