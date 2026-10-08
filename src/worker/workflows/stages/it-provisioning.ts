// Stage 4: IT account, licenses (privileged only if the manager approved it), device order polled to delivery.
import type { RunCtx } from "../run-context.ts";
import { runOp } from "../stage-runner.ts";

export async function runItProvisioning(ctx: RunCtx): Promise<void> {
  await runOp(ctx, "it_provisioning", "it.create-account");
  await runOp(ctx, "it_provisioning", "it.assign-licenses");
  await runOp(ctx, "it_provisioning", "it.order-device");
}
