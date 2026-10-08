// Stage 6: cross-system check that HR, IT and Facilities agree the employee is provisioned.
import type { RunCtx } from "../run-context.ts";
import { runOp } from "../stage-runner.ts";

export async function runProvisioningVerification(ctx: RunCtx): Promise<void> {
  await runOp(ctx, "provisioning_verification", "hr.get-worker");
  await runOp(ctx, "provisioning_verification", "it.get-account");
  await runOp(ctx, "provisioning_verification", "facilities.get-badge");
}
