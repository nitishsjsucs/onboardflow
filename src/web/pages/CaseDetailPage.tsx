// Case detail: stages, provisioning per simulated system, tasks, approvals,
// blockers (with retry for permitted roles), the audit trail, and admin
// controls. Live CaseAgent state refreshes the view.
import { useState } from "react";
import { useParams } from "react-router";
import type { StageView } from "../../shared/api.ts";
import { useItemAction } from "../api/item-action.ts";
import { useAdminCaseAction, useCase, useCaseAudit, useRetryStage } from "../api/queries.ts";
import { can, useSession } from "../auth/session.tsx";
import { ActionMessage } from "../components/ActionMessage.tsx";
import { AuditTimeline } from "../components/AuditTimeline.tsx";
import { BlockerList } from "../components/BlockerList.tsx";
import { LiveIndicator } from "../components/LiveIndicator.tsx";
import { ProvisioningTracker } from "../components/ProvisioningTracker.tsx";
import { StageStepper } from "../components/StageStepper.tsx";
import { label, StatusBadge } from "../components/StatusBadge.tsx";
import { TaskList } from "../components/TaskList.tsx";
import { useCaseLive } from "../live/useCaseLive.ts";

function LiveCase({ id }: { id: string }) {
  const { status } = useCaseLive(id);
  return <LiveIndicator status={status} />;
}

export function CaseDetailPage() {
  const { id = "" } = useParams();
  const { me } = useSession();
  const q = useCase(id);
  const audit = useCaseAudit(id);

  if (q.isLoading) return <p className="muted">Loading case...</p>;
  if (q.error || !q.data) return <p className="error">Could not load this case.</p>;
  const d = q.data;
  const openBlockers = d.blockers.filter((b) => b.status === "open");
  const blockedStages = d.stages.filter((s) => s.status === "blocked");

  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {d.employee.firstName} {d.employee.lastName} <span className="muted mono">{d.employee.id}</span>
          </h1>
          <div className="sub">
            {d.employee.jobTitle}, {d.employee.orgUnit}. Starts {d.employee.startDate}. Manager {d.employee.managerName}.{" "}
            <StatusBadge status={d.case.status} />
            {d.case.failureReason ? ` (${label(d.case.failureReason)})` : ""}
          </div>
          <div className="muted mono">
            {d.case.workflowInstanceId ?? "not started"}, run {d.case.runNo}
          </div>
        </div>
        <LiveCase id={id} />
      </div>

      <section className="card">
        <StageStepper stages={d.stages} />
      </section>

      {blockedStages.length > 0 || openBlockers.length > 0 ? (
        <section className="card" aria-label="blockers">
          <h2>Blockers</h2>
          <BlockerList blockers={openBlockers} />
          {blockedStages.map((s) => {
            const owner = openBlockers.find((b) => b.stageId === s.id)?.ownerDepartment ?? (s.owner === "manager" ? "people_ops" : s.owner);
            return <BlockedStageRow key={s.id} employeeId={id} employeeName={`${d.employee.firstName} ${d.employee.lastName}`} stage={s} canRetry={can.retry(me, owner)} />;
          })}
        </section>
      ) : null}

      <div className="grid two">
        <section className="card" aria-label="provisioning">
          <h2>Provisioning</h2>
          <ProvisioningTracker items={d.provisioning} />
        </section>
        <section className="card" aria-label="approvals">
          <h2>Approvals</h2>
          <ul className="tasks">
            {d.approvals.map((a) => (
              <li key={a.id}>
                <span>
                  {label(a.checkpoint)}, round {a.round}
                  {a.decidedOnBehalfOf ? ` (decided on behalf of ${a.decidedOnBehalfOf})` : ""}
                </span>
                <StatusBadge status={a.status} />
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="card" aria-label="tasks">
        <h2>Tasks</h2>
        <TaskList tasks={d.tasks} />
      </section>

      {can.restartOrTerminate(me) ? <AdminControls employeeId={id} /> : null}

      <section className="card" aria-label="audit trail section">
        <h2>Audit trail</h2>
        <AuditTimeline
          events={(audit.data?.pages ?? []).flatMap((p) => p.items)}
          hasMore={!!audit.hasNextPage}
          onMore={() => void audit.fetchNextPage()}
          loadingMore={audit.isFetchingNextPage}
        />
      </section>
    </>
  );
}

function BlockedStageRow({ employeeId, employeeName, stage: s, canRetry }: { employeeId: string; employeeName: string; stage: StageView; canRetry: boolean }) {
  const retry = useItemAction(useRetryStage(), (r) => `Retry requested for ${s.name}: round ${r.round} running`);
  return (
    <div className="blocked-stage">
      <div className="row" style={{ marginTop: 8 }}>
        <span>
          {s.name} is blocked{s.blockedReason?.message ? `: ${String(s.blockedReason.message)}` : ""}.
        </span>
        {canRetry ? (
          <button type="button" className="primary" aria-label={`Retry ${s.name} for ${employeeName}`} disabled={retry.pending} onClick={() => void retry.run({ employeeId, stageId: s.id })}>
            Retry {s.name}
          </button>
        ) : null}
      </div>
      <ActionMessage error={retry.error} success={retry.success} context={{ action: `retry ${s.name}`, subject: s.name }} />
    </div>
  );
}

function AdminControls({ employeeId }: { employeeId: string }) {
  const [reason, setReason] = useState("");
  const restart = useItemAction(useAdminCaseAction("restart"), (r) => `Restarted: run ${r.runNo ?? ""}`.trim());
  const terminate = useItemAction(useAdminCaseAction("terminate"), () => "Terminated");
  const busy = restart.pending || terminate.pending;
  return (
    <section className="card" aria-label="admin controls">
      <h2>Admin controls</h2>
      <div className="row">
        <input aria-label="admin reason" placeholder="Reason (audited)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button type="button" disabled={!reason || busy} onClick={() => void restart.run({ employeeId, reason })}>
          Restart workflow
        </button>
        <button type="button" className="danger" disabled={!reason || busy} onClick={() => void terminate.run({ employeeId, reason })}>
          Terminate
        </button>
      </div>
      <ActionMessage error={restart.error} success={restart.success} context={{ action: "restart the workflow" }} />
      <ActionMessage error={terminate.error} success={terminate.success} context={{ action: "terminate the case" }} />
    </section>
  );
}
