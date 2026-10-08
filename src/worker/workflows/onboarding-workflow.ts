// OnboardingWorkflow: the durable eight-stage run for one employee (SPEC 8.3).
// Control flow outside steps depends only on step results (cached on replay)
// and counters derived from them, so it is deterministic; this matters because
// the SDK's step.sendEvent / reportComplete are durable steps with
// counter-based names. Every wait is a D1 gate (gates.ts); every integration
// call goes through runOp (stage-runner.ts); every write is a guarded,
// audited batch (run-context.ts).
import { getAgentByName } from "agents";
import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep, WorkflowCallback } from "agents/workflows";
import { STAGE_IDS, STAGES, type StageId } from "../../shared/stages.ts";
import type { CaseAgent } from "../agents/case-agent.ts";
import { parseConfig } from "../config.ts";
import { errorMessage } from "../integrations/errors.ts";
import { CHECK_STEP } from "./retry-policy.ts";
import { completeCase, completeStage, type RunCtx, type RunLimits, type StageProgress, startStage } from "./run-context.ts";
import { runCloseout } from "./stages/closeout.ts";
import { runFacilitiesSetup } from "./stages/facilities-setup.ts";
import { runIntake } from "./stages/intake.ts";
import { runItProvisioning } from "./stages/it-provisioning.ts";
import { runManagerApproval } from "./stages/manager-approval.ts";
import { runOrientation } from "./stages/orientation.ts";
import { runPaperwork } from "./stages/paperwork.ts";
import { runProvisioningVerification } from "./stages/provisioning-verification.ts";

export type OnboardingParams = {
  employeeId: string;
  /** Test and eval only: tighter loop bounds. Honored only when EVAL_HOOKS=on. */
  limits?: Partial<RunLimits>;
};

export type { StageProgress };

const STAGE_BODIES: Record<StageId, (ctx: RunCtx) => Promise<void>> = {
  intake: runIntake,
  paperwork: runPaperwork,
  manager_approval: runManagerApproval,
  it_provisioning: runItProvisioning,
  facilities_setup: runFacilitiesSetup,
  provisioning_verification: runProvisioningVerification,
  orientation: runOrientation,
  closeout: runCloseout,
};

type Begin = { runNo: number; revision: number; rounds: Record<StageId, number>; statuses: Record<StageId, string> };

async function readBegin(db: D1Database, employeeId: string): Promise<Begin> {
  const [c, stages] = await db.batch([
    db.prepare("SELECT run_no, revision FROM cases WHERE employee_id = ?").bind(employeeId),
    db.prepare("SELECT stage_id, round, status FROM case_stages WHERE employee_id = ?").bind(employeeId),
  ]);
  const kase = c?.results[0] as { run_no: number; revision: number } | undefined;
  if (!kase) throw new Error(`no case for ${employeeId}`);
  const rounds = Object.fromEntries(STAGE_IDS.map((s) => [s, 1])) as Record<StageId, number>;
  const statuses = Object.fromEntries(STAGE_IDS.map((s) => [s, "pending"])) as Record<StageId, string>;
  for (const r of (stages?.results ?? []) as Array<{ stage_id: StageId; round: number; status: string }>) {
    rounds[r.stage_id] = r.round;
    statuses[r.stage_id] = r.status;
  }
  return { runNo: kase.run_no, revision: kase.revision, rounds, statuses };
}

export class OnboardingWorkflow extends AgentWorkflow<CaseAgent, OnboardingParams, StageProgress> {
  #employeeId: string | null = null;

  /**
   * Callbacks to the CaseAgent (sendEvent, reportProgress, reportComplete) go
   * through the stub AgentWorkflow resolved when the run began. If the agent
   * object was reset since (an eviction, a deploy), that stub stays broken and
   * the SDK's callback step would retry it under the platform default policy
   * for minutes. Re-resolve the agent by name and retry once; if that fails
   * too, give up quietly: callbacks only refresh a projection that the agent's
   * scheduled scan also refreshes, and gates never depend on them (ADR 0002).
   */
  protected override async notifyAgent(callback: WorkflowCallback): Promise<void> {
    try {
      await super.notifyAgent(callback);
    } catch (first) {
      if (!this.#employeeId) throw first;
      try {
        const fresh = await getAgentByName(this.env.CASE_AGENT, this.#employeeId);
        await fresh._workflow_handleCallback(callback);
      } catch (second) {
        console.warn(`workflow callback ${callback.type} for ${this.#employeeId} dropped: ${errorMessage(second)}`);
      }
    }
  }

  override async run(event: AgentWorkflowEvent<OnboardingParams>, step: AgentWorkflowStep) {
    const cfg = parseConfig(this.env);
    const employeeId = event.payload.employeeId;
    this.#employeeId = employeeId;
    // After a restart this is a fresh read: the engine wiped the step history.
    const begin = await step.do("run.begin", CHECK_STEP, () => readBegin(this.env.DB, employeeId));
    const limits: RunLimits = {
      waitBudget: cfg.gates.waitBudget,
      maxStageRounds: cfg.gates.maxStageRounds,
      maxRecoveryRounds: cfg.gates.maxRecoveryRounds,
      maxApprovalRounds: cfg.gates.maxApprovalRounds,
      pollMax: cfg.poll.max,
      ...(cfg.evalHooks ? (event.payload.limits ?? {}) : {}),
    };
    const ctx: RunCtx = {
      step,
      env: this.env,
      cfg,
      employeeId,
      instanceId: event.instanceId,
      runNo: begin.runNo,
      stageRound: { ...begin.rounds },
      limits,
      waitsLeft: limits.waitBudget,
      recoveriesLeft: limits.maxRecoveryRounds,
      report: async (p) => {
        try {
          await this.reportProgress(p);
        } catch (err) {
          console.warn(`reportProgress ${employeeId}: ${errorMessage(err)}`);
        }
      },
    };

    for (const s of STAGES) {
      const startName = `${s.id}.start`;
      await step.do(startName, CHECK_STEP, () => startStage(ctx, s.id, startName));
      await step.sendEvent({ kind: "stage_started", stage: s.id });
      await STAGE_BODIES[s.id](ctx);
      const completeName = `${s.id}.complete`;
      await step.do(completeName, CHECK_STEP, () => completeStage(ctx, s.id, completeName));
      await step.sendEvent({ kind: "stage_completed", stage: s.id });
    }
    await step.do("case.complete", CHECK_STEP, () => completeCase(ctx, "case.complete"));
    await step.reportComplete({ employeeId, stages: STAGES.length });
    return { employeeId, stages: STAGES.length, runNo: begin.runNo };
  }
}
