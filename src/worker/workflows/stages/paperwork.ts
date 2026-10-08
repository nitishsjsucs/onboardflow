// Stage 2: wait until the employee has finished every paperwork task (D1 gate),
// then start HR document verification and poll it until verified.
import { awaitGate } from "../gates.ts";
import type { RunCtx } from "../run-context.ts";
import { runOp } from "../stage-runner.ts";

export async function runPaperwork(ctx: RunCtx): Promise<void> {
  await awaitGate(ctx, { stage: "paperwork", label: "tasks", round: ctx.stageRound.paperwork, spec: { kind: "tasks", stage: "paperwork" } });
  await runOp(ctx, "paperwork", "hr.start-document-verification");
}
