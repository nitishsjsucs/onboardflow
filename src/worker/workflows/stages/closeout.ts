// Stage 8: People Ops sign-off, then activate the HR worker record.
import { approvalLoop } from "../approval-loop.ts";
import type { RunCtx } from "../run-context.ts";
import { runOp } from "../stage-runner.ts";

export async function runCloseout(ctx: RunCtx): Promise<void> {
  await approvalLoop(ctx, "closeout", "closeout");
  await runOp(ctx, "closeout", "hr.activate-worker");
}
