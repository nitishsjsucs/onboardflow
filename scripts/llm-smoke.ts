// End-to-end check of the OpenAI-compatible LLM path used for follow-up
// wording: posts one draft request with response_format.json_schema and
// thinking disabled, validates the answer with the same schema the drafter
// uses, and prints the latency. Default target: llama-server on 8110.
//   node scripts/llm-smoke.ts [baseUrl] [model]
import { fileURLToPath } from "node:url";
import { DRAFT_JSON_SCHEMA, DraftSchema } from "../src/shared/followup-draft.ts";

export async function smoke(baseUrl: string, model: string) {
  // the same request shape as src/worker/llm/openai-compatible.ts
  const started = Date.now();
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      model,
      temperature: 0,
      seed: 7,
      max_tokens: 300,
      response_format: { type: "json_schema", json_schema: { name: "follow_up", schema: DRAFT_JSON_SCHEMA } },
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        { role: "system", content: "You draft concise, factual follow-up tasks for employee onboarding. Never invent facts." },
        { role: "user", content: [
      "Write a short follow-up task for an onboarding coordinator.",
      "Department: people_ops. Blocker kind (decided by rules): data_issue. Stage: intake.",
      'Facts: {"system":"hr","operation":"hr.create-worker","httpStatus":422,"field":"costCenter","message":"costCenter must match CC-####"}',
      "Return JSON with title (<= 80 chars), description (<= 600 chars) and suggestedCategory (one blocker kind).",
        ].join("\n") },
      ],
    }),
  });
  if (!res.ok) return { ok: false, latencyMs: Date.now() - started, text: await res.text(), issues: [`HTTP ${res.status}`] };
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = (body.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, latencyMs: Date.now() - started, text, issues: ["not JSON"] };
  }
  const parsed = DraftSchema.safeParse(json);
  return { ok: parsed.success, latencyMs: Date.now() - started, text, issues: parsed.success ? [] : parsed.error.issues.map((i) => i.message) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const baseUrl = process.argv[2] ?? "http://127.0.0.1:8110/v1";
  const model = process.argv[3] ?? "qwen3-1.7b";
  const r = await smoke(baseUrl, model);
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
