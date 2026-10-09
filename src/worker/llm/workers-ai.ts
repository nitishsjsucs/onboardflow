// Workers AI provider (production, optional; Tier 2). Calls the model through
// the AI binding and AI Gateway with a JSON schema response format. It runs
// only where the AI binding exists (env.production); locally the binding is
// absent and drafting uses the stub or an OpenAI-compatible server instead.
import type { CompleteJsonRequest, CompleteJsonResponse, LlmProvider } from "./provider.ts";
import { stripThink } from "./openai-compatible.ts";

export type AiBinding = { run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> };

function textOf(out: unknown): string {
  if (typeof out === "string") return out;
  const o = out as { response?: unknown; choices?: Array<{ message?: { content?: unknown } }> };
  const content = o?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (typeof o?.response === "string") return o.response;
  if (o?.response && typeof o.response === "object") return JSON.stringify(o.response);
  throw new Error("workers ai response has no text");
}

export class WorkersAiProvider implements LlmProvider {
  readonly id: string;
  readonly #ai: AiBinding;
  readonly #model: string;
  readonly #gatewayId: string | undefined;

  constructor(ai: AiBinding, model: string, gatewayId?: string) {
    this.#ai = ai;
    this.#model = model;
    this.#gatewayId = gatewayId;
    this.id = `workers-ai:${model}`;
  }

  async completeJson(req: CompleteJsonRequest): Promise<CompleteJsonResponse> {
    const started = Date.now();
    const call = this.#ai.run(
      this.#model,
      {
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        response_format: { type: "json_schema", json_schema: { name: req.schemaName, schema: req.jsonSchema } },
        max_tokens: req.maxTokens,
        temperature: req.temperature,
      },
      this.#gatewayId ? { gateway: { id: this.#gatewayId } } : {},
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`workers ai timed out after ${req.timeoutMs} ms`)), req.timeoutMs);
    });
    try {
      const out = await Promise.race([call, timeout]);
      return { text: stripThink(textOf(out)), latencyMs: Date.now() - started };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
