import type { TaskView } from "../../shared/api.ts";
import { EmptyState } from "./EmptyState.tsx";
import { StatusBadge } from "./StatusBadge.tsx";

/** `notStarted`: the tasks' stage has not started, so they cannot be completed yet (the server refuses with 409 stage_not_started). */
export function TaskList({ tasks, onComplete, busyId, notStarted }: { tasks: TaskView[]; onComplete?: (t: TaskView) => void; busyId?: string | null; notStarted?: boolean }) {
  if (tasks.length === 0) return <EmptyState>No tasks.</EmptyState>;
  return (
    <ul className="tasks">
      {tasks.map((t) => (
        <li key={t.id} className={t.status}>
          <div>
            <div className="title">{t.title}</div>
            <div className="muted">
              {t.description}
              {t.dueAt ? ` Due ${new Date(t.dueAt).toLocaleDateString()}.` : ""}
            </div>
          </div>
          <div className="row">
            <StatusBadge status={t.status} />
            {onComplete && t.status === "open" && notStarted ? <span className="muted">Opens when this stage starts.</span> : null}
            {onComplete && t.status === "open" && !notStarted ? (
              <button type="button" className="primary" disabled={busyId === t.id} onClick={() => onComplete(t)}>
                Mark done
              </button>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
