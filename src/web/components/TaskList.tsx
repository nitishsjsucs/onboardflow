import type { TaskView } from "../../shared/api.ts";
import { useItemAction } from "../api/item-action.ts";
import { useCompleteTask } from "../api/queries.ts";
import { ActionMessage } from "./ActionMessage.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { StatusBadge } from "./StatusBadge.tsx";

export type TaskListProps = {
  tasks: TaskView[];
  /** Shows a done button on open tasks (each row sends its own completion). */
  completable?: boolean;
  /** Visible text of the done button; its accessible name adds the task title. */
  doneLabel?: string;
  /** The tasks' stage has not started, so they cannot be completed yet (the server refuses with 409 stage_not_started). */
  notStarted?: boolean;
};

/** A list of checklist tasks or follow-ups. */
export function TaskList({ tasks, completable, doneLabel = "Mark done", notStarted }: TaskListProps) {
  if (tasks.length === 0) return <EmptyState>No tasks.</EmptyState>;
  return (
    <ul className="tasks">
      {tasks.map((t) => (completable ? <CompletableTask key={t.id} task={t} doneLabel={doneLabel} notStarted={!!notStarted} /> : <TaskRow key={t.id} task={t} />))}
    </ul>
  );
}

function TaskText({ task: t }: { task: TaskView }) {
  return (
    <div className="item-main">
      <div className="title">{t.title}</div>
      <div className="muted">
        {t.description}
        {t.dueAt ? ` Due ${new Date(t.dueAt).toLocaleDateString()}.` : ""}
      </div>
    </div>
  );
}

function TaskRow({ task: t }: { task: TaskView }) {
  return (
    <li className={t.status}>
      <TaskText task={t} />
      <div className="item-actions">
        <StatusBadge status={t.status} />
      </div>
    </li>
  );
}

function CompletableTask({ task: t, doneLabel, notStarted }: { task: TaskView; doneLabel: string; notStarted: boolean }) {
  const complete = useItemAction(useCompleteTask(), () => `Marked done: ${t.title}`);
  const open = t.status === "open";
  return (
    <li className={t.status}>
      <TaskText task={t} />
      <div className="item-actions">
        <StatusBadge status={t.status} />
        {open && notStarted ? <span className="muted">Opens when this stage starts.</span> : null}
        {open && !notStarted ? (
          <button type="button" className="primary" aria-label={`${doneLabel}: ${t.title}`} disabled={complete.pending} onClick={() => void complete.run({ taskId: t.id })}>
            {doneLabel}
          </button>
        ) : null}
      </div>
      <ActionMessage error={complete.error} success={complete.success} context={{ action: `mark "${t.title}" done` }} />
    </li>
  );
}
