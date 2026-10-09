// The employee's own onboarding: stage stepper, progress, what is next,
// checklist grouped by stage, and blockers that affect them.
import type { ChecklistDto, TaskView } from "../../shared/api.ts";
import { STAGES } from "../../shared/stages.ts";
import { useChecklist, useCompleteTask } from "../api/queries.ts";
import { useSession } from "../auth/session.tsx";
import { BlockerList } from "../components/BlockerList.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { LiveIndicator } from "../components/LiveIndicator.tsx";
import { StageStepper } from "../components/StageStepper.tsx";
import { label, StatusBadge } from "../components/StatusBadge.tsx";
import { TaskList } from "../components/TaskList.tsx";
import { useCaseLive } from "../live/useCaseLive.ts";

function whatIsNext(data: ChecklistDto): string {
  if (data.caseStatus === "complete") return "You are all set. Welcome aboard!";
  if (data.caseStatus === "not_started") return "Your onboarding has not started yet. People Operations will start it soon.";
  const open = data.tasks.filter((t) => t.status === "open");
  const current = data.stages.find((s) => s.status !== "complete" && s.status !== "pending");
  if (current?.status === "waiting_on_employee" && open.length > 0) return `Finish your ${current.name.toLowerCase()} tasks: ${open.filter((t) => t.stageId === current.id).length} left.`;
  if (current) return `${current.name}: ${label(current.status)}. Nothing is needed from you right now.`;
  return "Nothing is needed from you right now.";
}

function Live({ employeeId }: { employeeId: string }) {
  const { status } = useCaseLive(employeeId);
  return <LiveIndicator status={status} />;
}

export function EmployeePortalPage() {
  const { me } = useSession();
  const q = useChecklist(!!me?.employeeId);
  const complete = useCompleteTask();

  if (!me?.employeeId) return <EmptyState>This page is for employees.</EmptyState>;
  if (q.isLoading) return <p className="muted">Loading your onboarding...</p>;
  if (q.error || !q.data) return <p className="error">Could not load your checklist.</p>;
  const data = q.data;
  const done = data.stages.filter((s) => s.status === "complete").length;

  // one Idempotency-Key per task, reused if the same completion is retried (api/action-keys.ts)
  const onComplete = (t: TaskView) => complete.mutate({ taskId: t.id });

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
      <div className="card">
        <StageStepper stages={data.stages} />
        <div style={{ marginTop: 12 }} className="progress" aria-label={`${done} of 8 stages complete`}>
          <div style={{ width: `${(done / 8) * 100}%` }} />
        </div>
        <p data-testid="what-next" style={{ marginBottom: 0 }}>
          <strong>What is next:</strong> {whatIsNext(data)}
        </p>
      </div>
      {data.blockers.length > 0 ? (
        <div className="card">
          <h2>Blockers affecting you</h2>
          <BlockerList blockers={data.blockers} />
        </div>
      ) : null}
      {STAGES.filter((s) => data.tasks.some((t) => t.stageId === s.id)).map((s) => (
        <section className="card" key={s.id} aria-label={`${s.name} checklist`}>
          <h3>
            Stage {s.ordinal}: {s.name}
          </h3>
          <TaskList tasks={data.tasks.filter((t) => t.stageId === s.id)} onComplete={onComplete} busyId={complete.isPending ? (complete.variables?.taskId ?? null) : null} />
        </section>
      ))}
      {complete.error ? <p className="error">{(complete.error as Error).message}</p> : null}
    </>
  );
}
