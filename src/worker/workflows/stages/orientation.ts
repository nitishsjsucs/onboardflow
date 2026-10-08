// Stage 7: enroll in orientation, then wait until the employee finishes the day-one tasks.
import { awaitGate } from "../gates.ts";
import type { RunCtx } from "../run-context.ts";
import { runOp } from "../stage-runner.ts";

export async function runOrientation(ctx: RunCtx): Promise<void> {
  await runOp(ctx, "orientation", "hr.enroll-orientation");
  await awaitGate(ctx, { stage: "orientation", label: "tasks", round: ctx.stageRound.orientation, spec: { kind: "tasks", stage: "orientation" } });
}
