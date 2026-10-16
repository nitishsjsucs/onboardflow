import type { BlockerView } from "../../shared/api.ts";
import { STAGE_BY_ID } from "../../shared/stages.ts";
import { blockerDetail, blockerTitle, DEPARTMENT_NAMES, relativeTime, stageState } from "./blocker-text.ts";
import { EmptyState } from "./EmptyState.tsx";

/** Blockers of one case for staff (case detail): plain titles, the stage's state, the owner and the age. */
export function BlockerList({ blockers }: { blockers: BlockerView[] }) {
  if (blockers.length === 0) return <EmptyState>No blockers.</EmptyState>;
  return (
    <ul className="tasks">
      {blockers.map((b) => {
        const state = stageState(b);
        const detail = blockerDetail(b);
        return (
          <li key={b.id} data-testid={`blocker-${b.kind}`}>
            <div className="item-main">
              <div className="title">
                <span className={`badge ${b.severity === "high" ? "bad" : "warn"}`}>{b.severity}</span> {blockerTitle(b)}
              </div>
              <div className="muted">
                {STAGE_BY_ID[b.stageId].name}
                {state ? `: ${state}` : ""}. {detail ? `${detail} ` : ""}Owner {DEPARTMENT_NAMES[b.ownerDepartment]},{" "}
                <time dateTime={b.detectedAt} title={new Date(b.detectedAt).toLocaleString()}>
                  detected {relativeTime(b.detectedAt)}
                </time>
                .{b.status === "resolved" ? ` Resolved: ${b.resolution ?? ""}` : ""}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
