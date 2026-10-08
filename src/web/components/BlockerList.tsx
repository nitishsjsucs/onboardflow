import type { ReactNode } from "react";
import type { BlockerView } from "../../shared/api.ts";
import { EmptyState } from "./EmptyState.tsx";
import { label } from "./StatusBadge.tsx";

export function BlockerList({ blockers, actions }: { blockers: BlockerView[]; actions?: (b: BlockerView) => ReactNode }) {
  if (blockers.length === 0) return <EmptyState>No blockers.</EmptyState>;
  return (
    <ul className="tasks">
      {blockers.map((b) => (
        <li key={b.id} data-testid={`blocker-${b.kind}`}>
          <div>
            <div className="title">
              <span className={`badge ${b.severity === "high" ? "bad" : "warn"}`}>{label(b.kind)}</span> {b.employeeName} ({b.employeeId}), {label(b.stageId)}
            </div>
            <div className="muted">
              Owner: {label(b.ownerDepartment)}. Subject: <span className="mono">{b.subject}</span>. Detected {new Date(b.detectedAt).toLocaleString()}.
              {b.status === "resolved" ? ` Resolved: ${b.resolution ?? ""}` : ""}
            </div>
          </div>
          {actions ? <div className="row">{actions(b)}</div> : null}
        </li>
      ))}
    </ul>
  );
}
