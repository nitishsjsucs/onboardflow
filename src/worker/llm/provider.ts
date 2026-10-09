// LLM provider seam (SPEC Section 14). The LLM never decides anything: rules
// pick the blocker kind, owner and workflow behavior (ADR 0004). A provider
// only drafts follow-up text, and any failure falls back to a template.
import type { AppConfig } from "../config.ts";
import { OpenAiCompatibleProvider } from "./openai-compatible.ts";
import { StubLlmProvider } from "./stub.ts";
import { type AiBinding, WorkersAiProvider } from "./workers-ai.ts";

export type CompleteJsonRequest = {
  system: string;
  user: string;
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
};

export type CompleteJsonResponse = {
  text: string;
  latencyMs: number;
  usage?: { promptTokens: number; completionTokens: number };
};

export interface LlmProvider {
  /** "stub" | "openai:<model>" | "workers-ai:<model>" */
  readonly id: string;
  completeJson(req: CompleteJsonRequest): Promise<CompleteJsonResponse>;
}

export class ProviderUnavailable implements LlmProvider {
  readonly id: string;
  readonly #reason: string;
  constructor(id: string, reason: string) {
    this.id = id;
    this.#reason = reason;
  }
  async completeJson(): Promise<CompleteJsonResponse> {
    throw new Error(this.#reason);
  }
}

export function createLlmProvider(config: AppConfig, env: Env, fetcher?: typeof fetch): LlmProvider {
  switch (config.llm.provider) {
    case "stub":
      return new StubLlmProvider();
    case "openai":
      return new OpenAiCompatibleProvider({
        baseUrl: config.llm.baseUrl ?? "http://127.0.0.1:8080/v1",
        model: config.llm.model,
        ...(config.llm.apiKey ? { apiKey: config.llm.apiKey } : {}),
        ...(fetcher ? { fetcher } : {}),
      });
    case "workers-ai": {
      const ai = (env as Env & { AI?: AiBinding }).AI;
      if (!ai) return new ProviderUnavailable(`workers-ai:${config.llm.model}`, "the AI binding is not configured (it exists only in env.production)");
      return new WorkersAiProvider(ai, config.llm.model, config.llm.gatewayId);
    }
  }
}
