// Department queue: follow-ups the agents created and open blockers, with
// retry, resolve and data fixes. Coordinators see their own department.
import type { BlockerView, MeDto } from "../../shared/api.ts";
import { STAGE_BY_ID } from "../../shared/stages.ts";
import { useItemAction } from "../api/item-action.ts";
import { useBlockers, useFollowups, useResolveBlocker, useRetryStage } from "../api/queries.ts";
import { can, useSession } from "../auth/session.tsx";
import { ActionMessage } from "../components/ActionMessage.tsx";
import { DataIssueFix } from "../components/DataIssueFix.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { QueryState } from "../components/QueryState.tsx";
import { label } from "../components/StatusBadge.tsx";
import { TaskList } from "../components/TaskList.tsx";
import { useDocumentTitle } from "../hooks/useDocumentTitle.ts";

function BlockerRow({ b, me }: { b: BlockerView; me: MeDto | null }) {
  const stage = STAGE_BY_ID[b.stageId].name;
  const retry = useItemAction(useRetryStage(), (r) => `Retry requested for ${stage}: round ${r.round} running`);
  const resolve = useItemAction(useResolveBlocker(), () => `Resolved: ${label(b.kind)} for ${b.employeeName}`);
  return (
    <li data-testid={`blocker-${b.kind}`}>
      <div className="item-main">
        <div className="title">
          <span className={`badge ${b.severity === "high" ? "bad" : "warn"}`}>{label(b.kind)}</span> {b.employeeName} ({b.employeeId}), {stage}
        </div>
        <div className="muted">
          Owner: {label(b.ownerDepartment)}. Detected {new Date(b.detectedAt).toLocaleString()}.
        </div>
      </div>
      <div className="item-actions">
        {can.retry(me, b.ownerDepartment) && (b.kind === "integration_outage" || b.kind === "provisioning_stalled") ? (
          <button type="button" className="primary" aria-label={`Retry ${stage} for ${b.employeeName}`} disabled={retry.pending} onClick={() => void retry.run({ employeeId: b.employeeId, stageId: b.stageId })}>
            Retry stage
          </button>
        ) : null}
        {can.workDepartment(me, b.ownerDepartment) ? (
          <button type="button" aria-label={`Resolve ${label(b.kind)} for ${b.employeeName}`} disabled={resolve.pending} onClick={() => void resolve.run({ blockerId: b.id, resolution: "resolved from the queue" })}>
            Resolve
          </button>
        ) : null}
      </div>
      {b.kind === "data_issue" ? <DataIssueFix me={me} employeeId={b.employeeId} employeeName={b.employeeName} stageId={b.stageId} owner={b.ownerDepartment} detail={b.detail} /> : null}
      <ActionMessage error={retry.error} success={retry.success} context={{ action: `retry ${stage}`, subject: stage }} />
      <ActionMessage error={resolve.error} success={resolve.success} context={{ action: "resolve this blocker", subject: "this blocker" }} />
    </li>
  );
}

export function QueuePage() {
  useDocumentTitle("Queue");
  const { me } = useSession();
  const followups = useFollowups();
  const blockers = useBlockers("open");
  const dept = me?.role === "coordinator" ? label(me.department ?? "") : "all departments";
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Queue</h1>
          <div className="sub">Follow-ups and blockers for {dept}. Blockers come from rules; the follow-up text may be drafted by the configured provider.</div>
        </div>
      </div>
      <section className="card" aria-label="open blockers">
        <h2>Open blockers</h2>
        <QueryState query={blockers} what="the open blockers">
          {() =>
            blockers.data!.items.length === 0 ? (
              <EmptyState>No blockers.</EmptyState>
            ) : (
              <ul className="tasks">
                {blockers.data!.items.map((b) => (
                  <BlockerRow key={b.id} b={b} me={me} />
                ))}
              </ul>
            )
          }
        </QueryState>
      </section>
      <section className="card" aria-label="follow-ups">
        <h2>Follow-ups</h2>
        <QueryState query={followups} what="the follow-ups">
          {() => <TaskList tasks={followups.data!.items} completable doneLabel="Mark follow-up done" />}
        </QueryState>
      </section>
    </>
  );
}
