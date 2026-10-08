// Workflow and agent helpers for worker tests.
import { introspectWorkflow, type WorkflowIntrospector } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import type { Cmd } from "../../src/worker/agents/case-agent.ts";
import { loadPrincipal } from "../../src/worker/auth/middleware.ts";
import { emailOf } from "./auth.ts";

export function caseAgent(employeeId: string) {
  return getAgentByName(env.CASE_AGENT, employeeId);
}

/** A command envelope as the API layer builds it, for a person id (E001, M01, C01, A01). */
export async function cmdFor(personId: string, key: string | null = null): Promise<Cmd> {
  const email = await emailOf(personId);
  const actor = await loadPrincipal(env.DB, email);
  if (!actor) throw new Error(`no principal for ${personId}`);
  return { actor, requestId: crypto.randomUUID(), idem: key ? { actorEmail: email, key } : null };
}

/**
 * Opens a Workflow introspection session that disables sleeps and retry delays
 * for every instance created afterwards (including the SDK's internal
 * __agent_* steps, which otherwise use the platform default retry policy).
 */
export async function fastWorkflows(opts: { retryDelays?: boolean } = {}): Promise<WorkflowIntrospector> {
  const intro = await introspectWorkflow(env.ONBOARDING_WORKFLOW);
  await intro.modifyAll(async (m) => {
    await m.disableSleeps();
    if (opts.retryDelays !== false) await m.disableRetryDelays();
  });
  return intro;
}

export async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Polls `fn` until it returns a truthy value or the deadline passes. */
export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, opts: { timeoutMs?: number; intervalMs?: number; what?: string } = {}): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${opts.what ?? "condition"}`);
    await sleep(opts.intervalMs ?? 50);
  }
}
