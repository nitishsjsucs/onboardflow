// Stage 5: desk or remote kit (desk conflicts fall through to the next preference), badge polled to active.
import type { RunCtx } from "../run-context.ts";
import { runOp } from "../stage-runner.ts";

export async function runFacilitiesSetup(ctx: RunCtx): Promise<void> {
  await runOp(ctx, "facilities_setup", "facilities.assign-workspace");
  await runOp(ctx, "facilities_setup", "facilities.issue-badge");
}
