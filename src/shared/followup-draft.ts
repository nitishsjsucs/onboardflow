// The follow-up draft contract: what an LLM (or the stub) must return when it
// drafts a follow-up task. Shared by the worker's drafter and scripts/llm-smoke.ts.
import { z } from "zod";
import { BLOCKER_KINDS } from "./domain.ts";

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

