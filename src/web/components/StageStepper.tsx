import type { StageStatus } from "../../shared/domain.ts";
import { STAGES, type StageId } from "../../shared/stages.ts";
import { label } from "./StatusBadge.tsx";

export type StepperStage = { id: StageId; status: StageStatus; round?: number };

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
            </div>
          </li>
        );
      })}
    </ol>
  );
}
