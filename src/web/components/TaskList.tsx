import type { BlockerView, TaskView } from "../../shared/api.ts";
import { isStageId, STAGE_BY_ID } from "../../shared/stages.ts";
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
  /** Stages that have not started: their tasks cannot be completed yet (the server refuses with 409 stage_not_started). */
  notStartedStages?: ReadonlySet<string>;
  /** Task ids an open employee_task_overdue blocker lists (judged on the server's clock). */
  overdueIds?: ReadonlySet<string>;
};

/** Ids of the tasks the open employee_task_overdue blockers list. */
export function overdueTaskIds(blockers: BlockerView[]): Set<string> {
  const ids = new Set<string>();
  for (const b of blockers) {
    if (b.kind !== "employee_task_overdue" || b.status !== "open" || !Array.isArray(b.detail.taskIds)) continue;
    for (const id of b.detail.taskIds) if (typeof id === "string") ids.add(id);
  }
  return ids;
}

/** An open task of a started stage that a blocker lists as overdue, or whose due date has passed. */
export function isOverdue(t: TaskView, overdueIds: ReadonlySet<string> = new Set(), notStartedStages: ReadonlySet<string> = new Set(), now = Date.now()): boolean {
  if (t.status !== "open" || notStartedStages.has(t.stageId)) return false;
  return overdueIds.has(t.id) || (t.dueAt !== null && Date.parse(t.dueAt) < now);
}

/** A list of checklist tasks or follow-ups. */
export function TaskList({ tasks, completable, doneLabel = "Mark done", notStartedStages, overdueIds }: TaskListProps) {
  if (tasks.length === 0) return <EmptyState>No tasks.</EmptyState>;
  return (
    <ul className="tasks">
      {tasks.map((t) => {
        const notStarted = t.status === "open" && !!notStartedStages?.has(t.stageId);
        const overdue = isOverdue(t, overdueIds, notStartedStages);
        return completable ? (
          <CompletableTask key={t.id} task={t} doneLabel={doneLabel} notStarted={notStarted} overdue={overdue} />
        ) : (
          <TaskRow key={t.id} task={t} notStarted={notStarted} overdue={overdue} />
        );
      })}
    </ul>
  );
}

function TaskText({ task: t, notStarted }: { task: TaskView; notStarted: boolean }) {
  return (
    <div className="item-main">
      <div className="title">{t.title}</div>
      <div className="muted">
        {t.description}
        {t.dueAt ? ` Due ${new Date(t.dueAt).toLocaleDateString()}.` : ""}
        {notStarted && isStageId(t.stageId) ? ` Opens when ${STAGE_BY_ID[t.stageId].name} starts.` : ""}
      </div>
    </div>
  );
}

function TaskBadge({ task: t, notStarted, overdue }: { task: TaskView; notStarted: boolean; overdue: boolean }) {
  if (notStarted) return <span className="badge">Not open yet</span>;
  if (overdue) return <span className="badge bad">Overdue</span>;
  return <StatusBadge status={t.status} />;
}

function TaskRow({ task: t, notStarted, overdue }: { task: TaskView; notStarted: boolean; overdue: boolean }) {
  return (
    <li className={t.status}>
      <TaskText task={t} notStarted={notStarted} />
      <div className="item-actions">
        <TaskBadge task={t} notStarted={notStarted} overdue={overdue} />
      </div>
    </li>
  );
}

function CompletableTask({ task: t, doneLabel, notStarted, overdue }: { task: TaskView; doneLabel: string; notStarted: boolean; overdue: boolean }) {
  const complete = useItemAction(useCompleteTask(), () => `Marked done: ${t.title}`);
  return (
    <li className={t.status}>
      <TaskText task={t} notStarted={notStarted} />
      <div className="item-actions">
        <TaskBadge task={t} notStarted={notStarted} overdue={overdue} />
        {t.status === "open" && !notStarted ? (
          <button type="button" className="primary" aria-label={`${doneLabel}: ${t.title}`} disabled={complete.pending} onClick={() => void complete.run({ taskId: t.id })}>
            {doneLabel}
          </button>
        ) : null}
      </div>
      <ActionMessage error={complete.error} success={complete.success} context={{ action: `mark "${t.title}" done` }} />
    </li>
  );
}
