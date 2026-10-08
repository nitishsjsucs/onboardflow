import type { TaskView } from "../../shared/api.ts";
import { EmptyState } from "./EmptyState.tsx";
import { StatusBadge } from "./StatusBadge.tsx";

export function TaskList({ tasks, onComplete, busyId }: { tasks: TaskView[]; onComplete?: (t: TaskView) => void; busyId?: string | null }) {
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
            {onComplete && t.status === "open" ? (
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
