// FollowUpDrafter: writes the title and description of the follow-up task for
// a blocker. Rules already decided the kind, owner department and severity;
// the LLM (when enabled) only drafts wording and suggests a category that is
// stored and compared, never acted on (ADR 0004). Any failure, timeout or
// schema violation falls back to the deterministic template.
import { z } from "zod";
import { BLOCKER_KINDS, type BlockerKind } from "../../shared/domain.ts";
import { STAGE_BY_ID } from "../../shared/stages.ts";
import { errorMessage } from "../integrations/errors.ts";
import type { LlmProvider } from "../llm/provider.ts";
import type { BlockerCandidate } from "./blocker-rules.ts";

export type Draft = {
  title: string;
  description: string;
  draftedBy: string;
  suggestedCategory: BlockerKind | null;
  latencyMs: number | null;
  error?: string;
};

export const DraftSchema = z.object({
  title: z.string().min(3).max(80),
  description: z.string().min(3).max(600),
  suggestedCategory: z.enum(BLOCKER_KINDS),
});

export const DRAFT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "description", "suggestedCategory"],
  properties: {
    title: { type: "string", maxLength: 80 },
    description: { type: "string", maxLength: 600 },
    suggestedCategory: { type: "string", enum: [...BLOCKER_KINDS] },
  },
};

const SYSTEM_NAMES = { hr: "HR", it: "IT", facilities: "Facilities" } as const;

/** The deterministic template text for a blocker. */
export function templateDraft(c: BlockerCandidate, employeeName: string): { title: string; description: string } {
  const d = c.detail as { system?: keyof typeof SYSTEM_NAMES; operation?: string; httpStatus?: number | null; field?: string; message?: string; checkpoint?: string; count?: number; dueAt?: string };
  const stage = STAGE_BY_ID[c.stageId].name;
  const sys = d.system ? `${SYSTEM_NAMES[d.system]} (simulated)` : "the simulated system";
  const t = (s: string) => s.slice(0, 80);
  switch (c.kind) {
    case "integration_outage":
      return {
        title: t(`Restore ${d.operation ?? "integration"} for ${employeeName}`),
        description: `${sys} kept failing ${d.operation ?? "a call"} (last status ${d.httpStatus ?? "none"}) after every automatic retry. Confirm the system is healthy, then retry the ${stage} stage.`,
      };
    case "data_issue":
      return {
        title: t(`Fix ${d.field ?? "profile data"} for ${employeeName}`),
        description: `${sys} rejected ${d.operation ?? "a call"} with ${d.httpStatus ?? "an error"}${d.message ? ` (${d.message})` : ""}. Correct ${d.field ?? "the rejected field"} in the employee profile, then retry the ${stage} stage.`,
      };
    case "provisioning_stalled":
      return {
        title: t(`Chase stalled ${d.operation ?? "provisioning"} for ${employeeName}`),
        description: `The ${d.operation ?? "provisioning"} request in ${sys} stopped advancing. Check the order with the vendor queue, then retry the ${stage} stage; the original order is replayed, not placed again.`,
      };
    case "approval_overdue":
      return {
        title: t(`Chase overdue ${d.checkpoint ?? "approval"} for ${employeeName}`),
        description: `The ${d.checkpoint ?? "approval"} request passed its due time (${d.dueAt ?? "SLA"}). Ask the approver to decide, or have an admin decide on their behalf.`,
      };
    case "employee_task_overdue":
      return {
        title: t(`Remind ${employeeName} about ${d.count ?? "overdue"} overdue tasks`),
        description: `${employeeName} has ${d.count ?? "some"} overdue checklist tasks in ${stage}. Reach out and help them finish; the workflow continues as soon as the tasks are done.`,
      };
    case "approval_rejected":
      return {
        title: t(`Revise and resubmit ${d.checkpoint ?? "the request"} for ${employeeName}`),
        description: `The ${d.checkpoint ?? "approval"} request was rejected. Address the reviewer's reason, then resubmit it for the next round.`,
      };
  }
}

export class FollowUpDrafter {
  readonly #provider: LlmProvider;
  readonly #timeoutMs: number;

  constructor(provider: LlmProvider, timeoutMs = 8000) {
    this.#provider = provider;
    this.#timeoutMs = timeoutMs;
  }

  get providerId(): string {
    return this.#provider.id;
  }

  async draft(c: BlockerCandidate, ctx: { employeeName: string }): Promise<Draft> {
    const template = templateDraft(c, ctx.employeeName);
    const user = [
      "Write a short follow-up task for an onboarding coordinator.",
      `Department: ${c.ownerDepartment}. Blocker kind (decided by rules): ${c.kind}. Stage: ${c.stageId}.`,
      `Facts: ${JSON.stringify(c.detail)}`,
      "Return JSON with title (<= 80 chars), description (<= 600 chars) and suggestedCategory (one blocker kind).",
      JSON.stringify({ kind: c.kind, title: template.title, description: template.description, dedupeKey: c.dedupeKey }),
    ].join("\n");
    try {
      const r = await this.#provider.completeJson({
        system: "You draft concise, factual follow-up tasks for employee onboarding. Never invent facts.",
        user,
        schemaName: "follow_up",
        jsonSchema: DRAFT_JSON_SCHEMA,
        maxTokens: 300,
        temperature: 0,
        timeoutMs: this.#timeoutMs,
      });
      const parsed = DraftSchema.safeParse(JSON.parse(r.text));
      if (!parsed.success) throw new Error(`draft failed schema: ${parsed.error.issues[0]?.message ?? "invalid"}`);
      return {
        title: parsed.data.title,
        description: parsed.data.description,
        draftedBy: this.#provider.id === "stub" ? "stub" : `llm:${this.#provider.id}`,
        suggestedCategory: parsed.data.suggestedCategory,
        latencyMs: r.latencyMs,
      };
    } catch (err) {
      return { ...template, draftedBy: "template", suggestedCategory: null, latencyMs: null, error: errorMessage(err) };
    }
  }
}
