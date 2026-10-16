import type { StageStatus } from "../../shared/domain.ts";
import { STAGES, type StageId } from "../../shared/stages.ts";
import { formatInstantDay } from "./dates.ts";
import { label } from "./StatusBadge.tsx";

export type StepperStage = { id: StageId; status: StageStatus; round?: number; startedAt?: string | null };

/** Statuses of a stage that is under way (not pending, complete or failed): these say since when. */
const UNDER_WAY: ReadonlySet<StageStatus> = new Set(["active", "waiting_on_employee", "awaiting_approval", "revision_requested", "blocked"]);

/** The eight onboarding stages with their live status. */
export function StageStepper({ stages }: { stages: StepperStage[] }) {
  const byId = new Map(stages.map((s) => [s.id, s]));
  return (
    <ol className="stepper" aria-label="onboarding stages">
      {STAGES.map((def) => {
        const s = byId.get(def.id);
        const status = s?.status ?? "pending";
        return (
          <li key={def.id} className={status} data-testid={`stage-${def.id}`} data-status={status}>
            <div className="n">
              {def.ordinal}. {def.name}
            </div>
            <div>
              {label(status)}
              {s?.round && s.round > 1 ? ` (round ${s.round})` : ""}
              {s?.startedAt && UNDER_WAY.has(status) ? `, since ${formatInstantDay(s.startedAt)}` : ""}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
