import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import type { CaseAgent } from "../agents/case-agent.ts";

export type OnboardingParams = { employeeId: string };

/** Durable eight-stage onboarding run. Minimal until the workflow commits. */
export class OnboardingWorkflow extends AgentWorkflow<CaseAgent, OnboardingParams> {
  override async run(event: AgentWorkflowEvent<OnboardingParams>, _step: AgentWorkflowStep) {
    return { employeeId: event.payload.employeeId };
  }
}
