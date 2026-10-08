// Deterministic stand-in provider: builds the JSON from the blocker fields in
// the prompt, with no network. The phrasing variant is chosen by a hash of
// the dedupe key so the same blocker always drafts the same text.
import type { CompleteJsonRequest, CompleteJsonResponse, LlmProvider } from "./provider.ts";

export type StubInput = { kind: string; title: string; description: string; dedupeKey: string };

export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const LEADS = ["Action needed:", "Please handle:", "Follow-up:"] as const;

export class StubLlmProvider implements LlmProvider {
  readonly id = "stub";

  async completeJson(req: CompleteJsonRequest): Promise<CompleteJsonResponse> {
    const started = Date.now();
    // The drafter embeds the template draft as JSON on the last line of the user prompt.
    const lastLine = req.user.trim().split("\n").pop() ?? "{}";
    const input = JSON.parse(lastLine) as StubInput;
    const lead = LEADS[fnv1a(input.dedupeKey) % LEADS.length] as string;
    const text = JSON.stringify({
      title: input.title.slice(0, 80),
      description: `${lead} ${input.description}`.slice(0, 600),
      suggestedCategory: input.kind,
    });
    return { text, latencyMs: Date.now() - started };
  }
}
