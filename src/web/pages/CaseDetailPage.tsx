// Case detail: stages, provisioning per simulated system, tasks, approvals,
// blockers (with retry for permitted roles), the audit trail, and admin
// controls. Live CaseAgent state refreshes the view.
import { useState } from "react";
import { Link, useParams } from "react-router";
import type { CaseDetail, MeDto, StageView } from "../../shared/api.ts";
import { ApiError } from "../api/client.ts";
import { useItemAction } from "../api/item-action.ts";
import { useAdminCaseAction, useCase, useCaseAudit, useRetryStage } from "../api/queries.ts";
import { can, useSession } from "../auth/session.tsx";
import { ActionMessage } from "../components/ActionMessage.tsx";
import { AuditTimeline } from "../components/AuditTimeline.tsx";
import { BlockerList } from "../components/BlockerList.tsx";
import { DataIssueFix, isFixableField } from "../components/DataIssueFix.tsx";
import { LiveIndicator } from "../components/LiveIndicator.tsx";
import { QueryState } from "../components/QueryState.tsx";
import { ProvisioningTracker } from "../components/ProvisioningTracker.tsx";
import { StageStepper } from "../components/StageStepper.tsx";
import { label, StatusBadge } from "../components/StatusBadge.tsx";
import { TaskList } from "../components/TaskList.tsx";
import { useDocumentTitle } from "../hooks/useDocumentTitle.ts";
import { useCaseLive } from "../live/useCaseLive.ts";

function LiveCase({ id }: { id: string }) {
  const { status } = useCaseLive(id);
  return <LiveIndicator status={status} />;
}

/** Where "back" goes for this role: the cases list for staff, the portal for an employee. */
function listFor(me: MeDto | null): { to: string; text: string } {
  if (me?.role === "employee") return { to: "/me", text: "Back to my onboarding" };
  return { to: "/cases", text: me?.role === "manager" ? "Back to my team" : "Back to Cases" };
}

function forbiddenText(me: MeDto | null): string {
  if (me?.role === "manager") return "This case is not one of your direct reports.";
  if (me?.role === "employee") return "You can open only your own onboarding.";
  return "You do not have access to this case.";
}

export function CaseDetailPage() {
  const { id = "" } = useParams();
  const { me } = useSession();
  const q = useCase(id);
  const audit = useCaseAudit(id);
  const back = listFor(me);
  const notFound = q.error instanceof ApiError && q.error.status === 404;
  useDocumentTitle(q.data ? `${q.data.employee.firstName} ${q.data.employee.lastName}` : notFound ? `No case ${id}` : `Case ${id}`);

  return (
    <QueryState
      query={q}
      what="this case"
      notFound={
        <>
          <h1 tabIndex={-1}>No case {id}</h1>
          <p>
            There is no onboarding case with that id. <Link to={back.to}>{back.text}</Link>
          </p>
        </>
      }
      forbidden={
        <>
          <h1 tabIndex={-1}>Case {id}</h1>
          <p>
            {forbiddenText(me)} <Link to={back.to}>{back.text}</Link>
          </p>
        </>
      }
    >
      {() => <CaseView id={id} d={q.data!} me={me} audit={audit} />}
    </QueryState>
  );
}

function CaseView({ id, d, me, audit }: { id: string; d: CaseDetail; me: MeDto | null; audit: ReturnType<typeof useCaseAudit> }) {
  const openBlockers = d.blockers.filter((b) => b.status === "open");
  const blockedStages = d.stages.filter((s) => s.status === "blocked");

  return (
    <>
      <div className="page-head">
        <div>
          <h1 tabIndex={-1}>
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
            const blocker = openBlockers.find((b) => b.stageId === s.id);
            const owner = blocker?.ownerDepartment ?? (s.owner === "manager" ? "people_ops" : s.owner);
            const name = `${d.employee.firstName} ${d.employee.lastName}`;
            // a rejected field: guide the fix first, so a retry does not burn a recovery round on the same value
            const dataIssue = blocker?.kind === "data_issue" ? blocker.detail : s.blockedReason?.class === "fatal" && isFixableField(s.blockedReason.field) ? s.blockedReason : null;
            if (dataIssue) {
              return (
                <div key={s.id} className="blocked-stage">
                  <p style={{ margin: "8px 0 4px" }}>
                    <strong>{s.name} is blocked.</strong>
                  </p>
                  <DataIssueFix me={me} employeeId={id} employeeName={name} stageId={s.id} owner={owner} detail={dataIssue} />
                </div>
              );
            }
            return <BlockedStageRow key={s.id} employeeId={id} employeeName={name} stage={s} canRetry={can.retry(me, owner)} />;
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
        <QueryState query={audit} what="the audit trail">
          {() => (
            <AuditTimeline
              events={(audit.data?.pages ?? []).flatMap((p) => p.items)}
              hasMore={!!audit.hasNextPage}
              onMore={() => void audit.fetchNextPage()}
              loadingMore={audit.isFetchingNextPage}
            />
          )}
        </QueryState>
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
