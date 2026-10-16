// Case detail: stages, provisioning per simulated system, tasks, approvals,
// blockers (with retry for permitted roles), the audit trail, and admin
// controls. Live CaseAgent state refreshes the view.
import { useId, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import type { CaseDetail, MeDto, StageView } from "../../shared/api.ts";
import { ApiError } from "../api/client.ts";
import { useItemAction } from "../api/item-action.ts";
import { useAdminCaseAction, useCase, useCaseAudit, useRetryStage } from "../api/queries.ts";
import { can, useSession } from "../auth/session.tsx";
import { ActionButton } from "../components/ActionButton.tsx";
import { ActionMessage } from "../components/ActionMessage.tsx";
import { AuditTimeline } from "../components/AuditTimeline.tsx";
import { BlockerList } from "../components/BlockerList.tsx";
import { isFixableField } from "../components/blocker-text.ts";
import { DataIssueFix } from "../components/DataIssueFix.tsx";
import { LiveIndicator } from "../components/LiveIndicator.tsx";
import { QueryState } from "../components/QueryState.tsx";
import { ProvisioningTracker } from "../components/ProvisioningTracker.tsx";
import { StageStepper } from "../components/StageStepper.tsx";
import { label, StatusBadge } from "../components/StatusBadge.tsx";
import { overdueTaskIds, TaskList } from "../components/TaskList.tsx";
import { useDocumentTitle } from "../hooks/useDocumentTitle.ts";
import { useFocusRequest, useFocusRescue } from "../hooks/useFocus.ts";
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
  // a retried stage leaves the blocked list on the next refresh: focus moves to the section's heading,
  // or to the page heading when the section goes away
  const blockersHeading = useRef<HTMLHeadingElement>(null);
  const pageHeading = useRef<HTMLHeadingElement>(null);
  const rescue = useFocusRescue(
    blockedStages.map((s) => s.id),
    () => blockersHeading.current ?? pageHeading.current,
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1 tabIndex={-1} ref={pageHeading}>
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
        <section className="card" aria-label="blockers" {...rescue}>
          <h2 ref={blockersHeading} tabIndex={-1}>
            Blockers
          </h2>
          <BlockerList blockers={openBlockers} />
          {blockedStages.map((s) => {
            // an outage blocker can stay open beside the data issue a later retry hit: the data issue is what blocks the stage now
            const blocker = openBlockers.find((b) => b.stageId === s.id && b.kind === "data_issue") ?? openBlockers.find((b) => b.stageId === s.id);
            const owner = blocker?.ownerDepartment ?? (s.owner === "manager" ? "people_ops" : s.owner);
            const name = `${d.employee.firstName} ${d.employee.lastName}`;
            // a rejected field: guide the fix first, so a retry does not burn a recovery round on the same value
            const dataIssue = blocker?.kind === "data_issue" ? blocker.detail : s.blockedReason?.class === "fatal" && isFixableField(s.blockedReason.field) ? s.blockedReason : null;
            if (dataIssue) {
              return (
                <div key={s.id} className="blocked-stage" data-focus-item={s.id}>
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
        <TaskList tasks={d.tasks} notStartedStages={new Set(d.stages.filter((s) => s.status === "pending").map((s) => s.id))} overdueIds={overdueTaskIds(openBlockers)} />
      </section>

      {can.restartOrTerminate(me) ? <AdminControls employeeId={id} employeeName={`${d.employee.firstName} ${d.employee.lastName}`} c={d.case} /> : null}

      <section className="card" aria-label="audit trail section">
        <h2>Audit trail</h2>
        <QueryState query={audit} what="the audit trail">
          {() => (
            <AuditTimeline
              events={(audit.data?.pages ?? []).flatMap((p) => p.items)}
              hasMore={!!audit.hasNextPage}
              onMore={() => audit.fetchNextPage()}
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
    <div className="blocked-stage" data-focus-item={s.id}>
      <div className="row" style={{ marginTop: 8 }}>
        <span>
          {s.name} is blocked{s.blockedReason?.message ? `: ${String(s.blockedReason.message)}` : ""}.
        </span>
        {canRetry ? (
          <ActionButton className="primary" aria-label={`Retry ${s.name} for ${employeeName}`} busy={retry.pending} onClick={() => void retry.run({ employeeId, stageId: s.id })}>
            Retry {s.name}
          </ActionButton>
        ) : null}
      </div>
      <ActionMessage error={retry.error} success={retry.success} context={{ action: `retry ${s.name}`, subject: s.name }} />
    </div>
  );
}

export const MIN_ADMIN_REASON = 10;

/**
 * Restart and terminate, for admins. Each opens a confirm step that names the employee and the effect, and
 * nothing is sent before Confirm. The controls are disabled, with the reason, where the server would refuse
 * (409 case_finished or not_started). The reason is cleared only after a success: after an unknown outcome
 * it stays, so trying again is the same action with the same Idempotency-Key.
 */
function AdminControls({ employeeId, employeeName, c }: { employeeId: string; employeeName: string; c: CaseDetail["case"] }) {
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState<"restart" | "terminate" | null>(null);
  const ids = { reason: useId(), hint: useId() };
  const restart = useItemAction(useAdminCaseAction("restart"), (r) => `Restarted: run ${r.runNo ?? c.runNo + 1}`);
  const terminate = useItemAction(useAdminCaseAction("terminate"), () => `Terminated ${employeeName}'s onboarding`);
  const busy = restart.pending || terminate.pending;
  // Focus: opening the step moves it to the prompt (so it is read out, and Tab reaches Confirm next), Cancel
  // returns it to the button that opened the step, and the result takes it once the step closes.
  const prompt = useFocusRequest<HTMLParagraphElement>();
  const opener = { restart: useFocusRequest<HTMLButtonElement>(), terminate: useFocusRequest<HTMLButtonElement>() };
  const outcome = { restart: useFocusRequest<HTMLDivElement>(), terminate: useFocusRequest<HTMLDivElement>() };
  const open = (kind: "restart" | "terminate") => {
    setConfirming(kind);
    prompt.request();
  };
  const cancel = () => {
    const kind = confirming;
    setConfirming(null);
    if (kind) opener[kind].request();
  };
  const started = c.workflowInstanceId !== null;
  const ended = c.status === "complete" || c.status === "failed";
  const trimmed = reason.trim();
  const reasonOk = trimmed.length >= MIN_ADMIN_REASON;
  const notStarted = "The case has not started.";
  const endedText = `This case already ended: ${label(c.status)}${c.failureReason ? ` (${label(c.failureReason)})` : ""}.`;

  async function confirm() {
    const kind = confirming;
    // the reason is locked while the step is open; check it again anyway, so Confirm never sends a short one
    if (!kind || !reasonOk) return;
    const action = kind === "restart" ? restart : terminate;
    (kind === "restart" ? terminate : restart).reset();
    // the step stays open, with Confirm focused and busy, until the server answers
    const r = await action.run({ employeeId, reason: trimmed });
    setConfirming(null);
    if (r !== undefined) setReason("");
    outcome[kind].request();
  }

  return (
    <section className="card" aria-label="admin controls">
      <h2>Admin controls</h2>
      <label htmlFor={ids.reason}>Reason (audited)</label>
      <input id={ids.reason} aria-describedby={ids.hint} value={reason} onChange={(e) => setReason(e.target.value)} readOnly={confirming !== null} disabled={busy} style={{ width: "100%", maxWidth: 520 }} />
      <p id={ids.hint} className="muted hint">
        At least {MIN_ADMIN_REASON} characters; it is stored with the action in the audit trail.{confirming ? " Cancel to change it." : ""}
      </p>
      <div className="row" style={{ marginTop: 8 }}>
        <button type="button" ref={opener.restart.ref} disabled={!started || !reasonOk || busy || confirming !== null} onClick={() => open("restart")}>
          Restart workflow
        </button>
        <button type="button" ref={opener.terminate.ref} className="danger" disabled={!started || ended || !reasonOk || busy || confirming !== null} onClick={() => open("terminate")}>
          Terminate
        </button>
      </div>
      {!started ? <p className="muted">{notStarted}</p> : ended ? <p className="muted">{endedText} Terminate is not available.</p> : null}
      {confirming ? (
        <div className="confirm" role="group" aria-label={confirming === "restart" ? "Confirm restart" : "Confirm terminate"}>
          <p ref={prompt.ref} tabIndex={-1}>
            {confirming === "restart"
              ? `Restart ${employeeName}'s workflow as run ${c.runNo + 1}? Reason: ${trimmed}`
              : `Terminate ${employeeName}'s onboarding? The case ends as failed (terminated). This cannot be undone. Reason: ${trimmed}`}
          </p>
          <div className="row">
            <ActionButton className={confirming === "terminate" ? "danger" : "primary"} busy={busy} onClick={() => void confirm()}>
              {busy ? (confirming === "restart" ? "Restarting..." : "Terminating...") : confirming === "restart" ? "Confirm restart" : "Confirm terminate"}
            </ActionButton>
            <button type="button" onClick={cancel} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      <ActionMessage ref={outcome.restart.ref} error={restart.error} success={restart.success} context={{ action: "restart the workflow" }} />
      <ActionMessage ref={outcome.terminate.ref} error={terminate.error} success={terminate.success} context={{ action: "terminate the case" }} />
    </section>
  );
}
