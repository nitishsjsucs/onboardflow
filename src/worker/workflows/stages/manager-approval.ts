// Stage 3: the employee's manager approves equipment, licenses and privileged access.
import { approvalLoop } from "../approval-loop.ts";
import type { RunCtx } from "../run-context.ts";

export async function runManagerApproval(ctx: RunCtx): Promise<void> {
  await approvalLoop(ctx, "manager_approval", "manager_approval");
}
