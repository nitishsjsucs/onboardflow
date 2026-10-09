import { describe, expect, it, vi } from "vitest";
import type { BlockerCandidate } from "../../src/worker/agents/blocker-rules.ts";
import { FollowUpDrafter, templateDraft } from "../../src/worker/agents/followups.ts";
import { OpenAiCompatibleProvider, stripThink } from "../../src/worker/llm/openai-compatible.ts";
import { createLlmProvider } from "../../src/worker/llm/provider.ts";
import { StubLlmProvider } from "../../src/worker/llm/stub.ts";
import { parseConfig } from "../../src/worker/config.ts";
import { env } from "cloudflare:workers";

const candidate: BlockerCandidate = {
  kind: "data_issue",
  stageId: "intake",
  subject: "hr.create-worker",
  dedupeKey: "E001:data_issue:intake:hr.create-worker",
  ownerDepartment: "people_ops",
  severity: "high",
  detail: { class: "fatal", system: "hr", operation: "hr.create-worker", httpStatus: 422, field: "costCenter", message: "costCenter must match CC-####" },
};

describe("stub provider", () => {
  it("is deterministic and keeps rule-decided facts", async () => {
    const d = new FollowUpDrafter(new StubLlmProvider());
    const a = await d.draft(candidate, { employeeName: "Avery Abara" });
    const b = await d.draft(candidate, { employeeName: "Avery Abara" });
    expect(a).toEqual({ ...b, latencyMs: a.latencyMs });
    expect(a.draftedBy).toBe("stub");
    expect(a.suggestedCategory).toBe("data_issue");
    expect(a.title).toBe(templateDraft(candidate, "Avery Abara").title);
    expect(a.title.length).toBeLessThanOrEqual(80);
    expect(a.description).toContain("costCenter");
  });

  it("is the default provider", () => {
    expect(createLlmProvider(parseConfig(env), env).id).toBe("stub");
  });
});

describe("OpenAI-compatible provider", () => {
  function fakeFetch(content: string, status = 200) {
    return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }), { status }),
    );
  }

  it("sends response_format.json_schema, enable_thinking=false, temperature 0 and seed 7, and strips <think>", async () => {
    const f = fakeFetch('<think>internal</think>{"title":"Fix cost center for Avery","description":"Correct it and retry.","suggestedCategory":"data_issue"}');
    const p = new OpenAiCompatibleProvider({ baseUrl: "http://127.0.0.1:8110/v1/", model: "qwen3-1.7b", apiKey: "k", fetcher: f as unknown as typeof fetch });
    const d = await new FollowUpDrafter(p).draft(candidate, { employeeName: "Avery" });
    expect(d).toMatchObject({ title: "Fix cost center for Avery", draftedBy: "llm:openai:qwen3-1.7b", suggestedCategory: "data_issue" });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8110/v1/chat/completions");
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({
      model: "qwen3-1.7b",
      temperature: 0,
      seed: 7,
      response_format: { type: "json_schema", json_schema: { name: "follow_up" } },
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(body.response_format.json_schema.schema.required).toEqual(["title", "description", "suggestedCategory"]);
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(stripThink("<think>a\nb</think>\n{}")).toBe("{}");
  });

  it("falls back to the template on invalid JSON, schema violations, HTTP errors and timeouts", async () => {
    const tpl = templateDraft(candidate, "Avery");
    for (const f of [
      fakeFetch("not json"),
      fakeFetch('{"title":"x","description":"y","suggestedCategory":"made_up"}'),
      fakeFetch("{}", 500),
    ]) {
      const d = await new FollowUpDrafter(new OpenAiCompatibleProvider({ baseUrl: "http://llm", model: "m", fetcher: f as unknown as typeof fetch })).draft(candidate, { employeeName: "Avery" });
      expect(d).toMatchObject({ title: tpl.title, description: tpl.description, draftedBy: "template", suggestedCategory: null });
    }
    const hang = vi.fn((_u: string | URL | Request, init?: RequestInit) => new Promise<Response>((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const slow = new FollowUpDrafter(new OpenAiCompatibleProvider({ baseUrl: "http://llm", model: "m", fetcher: hang as unknown as typeof fetch }), 50);
    const started = Date.now();
    const d = await slow.draft(candidate, { employeeName: "Avery" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(d.draftedBy).toBe("template");
  });

  it("is selected with LLM_PROVIDER=openai", () => {
    const cfg = parseConfig({ ...env, LLM_PROVIDER: "openai", LLM_BASE_URL: "http://127.0.0.1:8110/v1" } as Env);
    expect(createLlmProvider(cfg, env).id).toBe("openai:qwen3-1.7b");
  });
});

describe("Workers AI provider (fake binding)", () => {
  it("calls env.AI.run(model, { messages, response_format }, { gateway: { id } }) and reads the chat output", async () => {
    const { WorkersAiProvider } = await import("../../src/worker/llm/workers-ai.ts");
    const run = vi.fn(async () => ({ choices: [{ message: { content: '{"title":"Fix the cost center","description":"Correct it and retry.","suggestedCategory":"data_issue"}' } }] }));
    const p = new WorkersAiProvider({ run }, "@cf/qwen/qwen3-30b-a3b-fp8", "onboardflow");
    const d = await new FollowUpDrafter(p).draft(candidate, { employeeName: "Avery" });
    expect(d).toMatchObject({ title: "Fix the cost center", draftedBy: "llm:workers-ai:@cf/qwen/qwen3-30b-a3b-fp8", suggestedCategory: "data_issue" });
    const [model, inputs, options] = run.mock.calls[0] as unknown as [string, { messages: unknown[]; response_format: { type: string; json_schema: { name: string } }; max_tokens: number }, { gateway: { id: string } }];
    expect(model).toBe("@cf/qwen/qwen3-30b-a3b-fp8");
    expect(inputs.messages).toHaveLength(2);
    expect(inputs.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "follow_up" } });
    expect(options).toEqual({ gateway: { id: "onboardflow" } });
  });

  it("accepts a plain string response, and falls back to the template on failure", async () => {
    const { WorkersAiProvider } = await import("../../src/worker/llm/workers-ai.ts");
    const ok = new WorkersAiProvider({ run: async () => ({ response: '{"title":"Fix it now","description":"Do the fix.","suggestedCategory":"data_issue"}' }) }, "m");
    expect((await ok.completeJson({ system: "s", user: "u", schemaName: "x", jsonSchema: {}, maxTokens: 10, temperature: 0, timeoutMs: 1000 })).text).toContain("Fix it now");
    const broken = new WorkersAiProvider({ run: async () => { throw new Error("gateway down"); } }, "m");
    expect((await new FollowUpDrafter(broken).draft(candidate, { employeeName: "Avery" })).draftedBy).toBe("template");
  });

  it("is selected with LLM_PROVIDER=workers-ai only when the AI binding exists", async () => {
    const { WorkersAiProvider } = await import("../../src/worker/llm/workers-ai.ts");
    const cfg = parseConfig({ ...env, LLM_PROVIDER: "workers-ai" } as Env);
    const missing = createLlmProvider(cfg, env);
    expect(missing).not.toBeInstanceOf(WorkersAiProvider);
    await expect(missing.completeJson({ system: "s", user: "u", schemaName: "x", jsonSchema: {}, maxTokens: 10, temperature: 0, timeoutMs: 100 })).rejects.toThrow(/AI binding/);
    const withAi = createLlmProvider(cfg, { ...env, AI: { run: async () => ({}) } } as unknown as Env);
    expect(withAi).toBeInstanceOf(WorkersAiProvider);
    expect(withAi.id).toBe("workers-ai:qwen3-1.7b");
  });
});
