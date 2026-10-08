// OpenAI-compatible chat completions provider (for example llama-server with
// Qwen3-1.7B locally). Structured output via response_format.json_schema,
// thinking disabled through chat_template_kwargs, <think> blocks stripped,
// and a hard timeout. Used only to draft follow-up text.
import type { CompleteJsonRequest, CompleteJsonResponse, LlmProvider } from "./provider.ts";

export type OpenAiOptions = { baseUrl: string; model: string; apiKey?: string; fetcher?: typeof fetch };

export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id: string;
  readonly #opts: OpenAiOptions;

  constructor(opts: OpenAiOptions) {
    this.#opts = opts;
    this.id = `openai:${opts.model}`;
  }

  async completeJson(req: CompleteJsonRequest): Promise<CompleteJsonResponse> {
    const started = Date.now();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.#opts.apiKey) headers.Authorization = `Bearer ${this.#opts.apiKey}`;
    const doFetch = this.#opts.fetcher ?? fetch;
    const res = await doFetch(`${this.#opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.#opts.model,
        temperature: req.temperature,
        seed: 7,
        max_tokens: req.maxTokens,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        response_format: { type: "json_schema", json_schema: { name: req.schemaName, schema: req.jsonSchema } },
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(req.timeoutMs),
    });
    if (!res.ok) throw new Error(`llm http ${res.status}`);
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("llm response has no message content");
    return {
      text: stripThink(content),
      latencyMs: Date.now() - started,
      ...(body.usage ? { usage: { promptTokens: body.usage.prompt_tokens ?? 0, completionTokens: body.usage.completion_tokens ?? 0 } } : {}),
    };
  }
}
