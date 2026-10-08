// Workflow control with fallbacks (SPEC Section 8.4). SDK methods first
// (they keep the Agent's cf_agents_workflows tracking table current), the raw
// Workflow binding when the SDK tracking row is missing (runWorkflow creates
// the instance before it inserts that row, so a crash between them leaves
// none). The new-revision fallback for a refused restart lives in CaseAgent,
// because it is a guarded D1 mutation.
import { errorMessage } from "../integrations/errors.ts";

export type InstanceStatusName = InstanceStatus["status"];

export interface WorkflowControl {
  /** Creates the instance; an existing instance counts as success (created: false). */
  ensureInstance(instanceId: string, employeeId: string): Promise<{ created: boolean }>;
  /** Restarts the instance; throws if both the SDK and the raw binding refuse. */
  restart(instanceId: string): Promise<"sdk" | "binding">;
  /** Terminates the instance; an already finished instance counts as success. */
  terminate(instanceId: string): Promise<void>;
  status(instanceId: string): Promise<InstanceStatusName>;
}

/** The subset of Agent methods the control needs (keeps this file free of the CaseAgent type). */
export type SdkWorkflowHost = {
  runWorkflow(name: "ONBOARDING_WORKFLOW", params: { employeeId: string }, options: { id: string; metadata: Record<string, unknown> }): Promise<string>;
  restartWorkflow(id: string): Promise<void>;
  terminateWorkflow(id: string): Promise<void>;
  getWorkflow(id: string): unknown;
};

export function isAlreadyExists(err: unknown): boolean {
  return /already_exists|already exists|already being tracked/i.test(errorMessage(err));
}

export function isCannotTerminate(err: unknown): boolean {
  return /cannot_terminate/i.test(errorMessage(err));
}

export class SdkWorkflowControl implements WorkflowControl {
  readonly #host: SdkWorkflowHost;
  readonly #binding: Workflow;

  constructor(host: SdkWorkflowHost, binding: Workflow) {
    this.#host = host;
    this.#binding = binding;
  }

  async ensureInstance(instanceId: string, employeeId: string) {
    try {
      await this.#host.runWorkflow("ONBOARDING_WORKFLOW", { employeeId }, { id: instanceId, metadata: { employeeId } });
      return { created: true };
    } catch (err) {
      if (isAlreadyExists(err)) return { created: false };
      throw err;
    }
  }

  async restart(instanceId: string): Promise<"sdk" | "binding"> {
    if (this.#host.getWorkflow(instanceId)) {
      try {
        await this.#host.restartWorkflow(instanceId);
        return "sdk";
      } catch (err) {
        console.warn(`sdk restart of ${instanceId} failed, trying the binding: ${errorMessage(err)}`);
      }
    }
    const instance = await this.#binding.get(instanceId);
    await instance.restart();
    return "binding";
  }

  async terminate(instanceId: string): Promise<void> {
    try {
      if (this.#host.getWorkflow(instanceId)) {
        await this.#host.terminateWorkflow(instanceId);
        return;
      }
    } catch (err) {
      if (isCannotTerminate(err)) return;
      console.warn(`sdk terminate of ${instanceId} failed, trying the binding: ${errorMessage(err)}`);
    }
    try {
      await (await this.#binding.get(instanceId)).terminate();
    } catch (err) {
      if (!isCannotTerminate(err)) throw err;
    }
  }

  async status(instanceId: string): Promise<InstanceStatusName> {
    return (await (await this.#binding.get(instanceId)).status()).status;
  }
}
