// Case detail: stages, provisioning per simulated system, tasks, approvals,
// blockers (with retry for permitted roles), the audit trail, and admin
// controls. Live CaseAgent state refreshes the view.
import { useState } from "react";
import { useParams } from "react-router";
import { useAdminCaseAction, useCase, useCaseAudit, useRetryStage } from "../api/queries.ts";
import { can, useSession } from "../auth/session.tsx";
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
  const retry = useRetryStage();
  const restart = useAdminCaseAction("restart");
  const terminate = useAdminCaseAction("terminate");
  const [reason, setReason] = useState("");

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
            return (
              <div key={s.id} className="row" style={{ marginTop: 8 }}>
                <span>
                  {s.name} is blocked{s.blockedReason?.message ? `: ${String(s.blockedReason.message)}` : ""}.
                </span>
                {can.retry(me, owner) ? (
                  <button type="button" className="primary" disabled={retry.isPending} onClick={() => retry.mutate({ employeeId: id, stageId: s.id })}>
                    Retry {s.name}
                  </button>
                ) : null}
              </div>
            );
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

      {can.restartOrTerminate(me) ? (
        <section className="card" aria-label="admin controls">
          <h2>Admin controls</h2>
          <div className="row">
            <input aria-label="admin reason" placeholder="Reason (audited)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button type="button" disabled={!reason || restart.isPending} onClick={() => restart.mutate({ employeeId: id, reason })}>
              Restart workflow
            </button>
            <button type="button" className="danger" disabled={!reason || terminate.isPending} onClick={() => terminate.mutate({ employeeId: id, reason })}>
              Terminate
            </button>
          </div>
        </section>
      ) : null}

      <section className="card" aria-label="audit trail section">
        <h2>Audit trail</h2>
        <AuditTimeline
          events={(audit.data?.pages ?? []).flatMap((p) => p.items)}
          hasMore={!!audit.hasNextPage}
          onMore={() => void audit.fetchNextPage()}
          loadingMore={audit.isFetchingNextPage}
        />
      </section>
      {[retry.error, restart.error, terminate.error].filter(Boolean).map((e, i) => (
        <p key={i} className="error">
          {(e as Error).message}
        </p>
      ))}
    </>
  );
}
