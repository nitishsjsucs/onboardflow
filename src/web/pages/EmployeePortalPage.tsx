// The employee's own onboarding: stage stepper, progress, what is next,
// checklist grouped by stage, and blockers that affect them.
import type { ChecklistDto } from "../../shared/api.ts";
import { STAGES } from "../../shared/stages.ts";
import { useChecklist } from "../api/queries.ts";
import { useSession } from "../auth/session.tsx";
import { EmployeeNotices } from "../components/EmployeeNotices.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { LiveIndicator } from "../components/LiveIndicator.tsx";
import { QueryError } from "../components/QueryState.tsx";
import { StageStepper } from "../components/StageStepper.tsx";
import { label, StatusBadge } from "../components/StatusBadge.tsx";
import { isOverdue, overdueTaskIds, TaskList } from "../components/TaskList.tsx";
import { useCaseLive } from "../live/useCaseLive.ts";
import { useDocumentTitle } from "../hooks/useDocumentTitle.ts";

function notStartedStages(data: ChecklistDto): Set<string> {
  return new Set(data.stages.filter((s) => s.status === "pending").map((s) => s.id));
}

function whatIsNext(data: ChecklistDto): string {
  if (data.caseStatus === "complete") return "You are all set. Welcome aboard!";
  if (data.caseStatus === "not_started") return "Your onboarding has not started yet. People Operations will start it soon.";
  const ids = overdueTaskIds(data.blockers);
  const notStarted = notStartedStages(data);
  const open = data.tasks.filter((t) => t.status === "open");
  const overdue = open.filter((t) => isOverdue(t, ids, notStarted)).length;
  const late = overdue > 0 ? `, ${overdue} overdue` : "";
  const current = data.stages.find((s) => s.status !== "complete" && s.status !== "pending");
  if (current?.status === "waiting_on_employee" && open.length > 0) return `Finish your ${current.name.toLowerCase()} tasks: ${open.filter((t) => t.stageId === current.id).length} left${late}.`;
  if (current) return `${current.name}: ${label(current.status)}. Nothing is needed from you right now${overdue > 0 ? `, apart from ${overdue} overdue task${overdue === 1 ? "" : "s"}` : ""}.`;
  return "Nothing is needed from you right now.";
}

function Live({ employeeId }: { employeeId: string }) {
  const { status } = useCaseLive(employeeId);
  return <LiveIndicator status={status} />;
}

export function EmployeePortalPage() {
  useDocumentTitle("My onboarding");
  const { me } = useSession();
  const q = useChecklist(!!me?.employeeId);

  if (!me?.employeeId) return <EmptyState>This page is for employees.</EmptyState>;
  if (q.data === undefined) {
    if (q.isError) return <QueryError error={q.error} what="your onboarding" onRetry={q.refetch} busy={q.isFetching} />;
    return (
      <p className="muted" role="status">
        Loading your onboarding...
      </p>
    );
  }
  const data = q.data;
  const done = data.stages.filter((s) => s.status === "complete").length;
  const notStarted = notStartedStages(data);
  const overdueIds = overdueTaskIds(data.blockers);
  const stale = q.isError;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Welcome, {me.displayName}</h1>
          <div className="sub">
            Onboarding <StatusBadge status={data.caseStatus} />
          </div>
        </div>
        <Live employeeId={me.employeeId} />
      </div>
      {stale ? (
        <p className="refresh-warning" role="status">
          Could not refresh; showing earlier data.{" "}
          <button type="button" onClick={() => void q.refetch()} disabled={q.isFetching}>
            Try again
          </button>
        </p>
      ) : null}
      <div className="card">
        <StageStepper stages={data.stages} />
        <div style={{ marginTop: 12 }} className="progress" role="progressbar" aria-label="Stages complete" aria-valuemin={0} aria-valuemax={8} aria-valuenow={done} aria-valuetext={`${done} of 8 stages complete`}>
          <div style={{ width: `${(done / 8) * 100}%` }} />
        </div>
        <p data-testid="what-next" style={{ marginBottom: 0 }}>
          <strong>What is next:</strong> {whatIsNext(data)}
        </p>
      </div>
      <EmployeeNotices blockers={data.blockers} />
      {STAGES.filter((s) => data.tasks.some((t) => t.stageId === s.id)).map((s) => (
        <section className="card" key={s.id} aria-label={`${s.name} checklist`}>
          <h3>
            Stage {s.ordinal}: {s.name}
          </h3>
          {/* each row sends its own completion, with one Idempotency-Key per task (api/action-keys.ts) */}
          <TaskList tasks={data.tasks.filter((t) => t.stageId === s.id)} completable notStartedStages={notStarted} overdueIds={overdueIds} />
        </section>
      ))}
    </>
  );
}
