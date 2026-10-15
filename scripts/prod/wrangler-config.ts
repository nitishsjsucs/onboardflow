// Reads and edits the production values of wrangler.jsonc in place, keeping
// its comments and layout (jsonc-parser edits only the value it changes).
import { applyEdits, modify, parse } from "jsonc-parser";

export const PLACEHOLDER_DB_ID = "REPLACE-after-wrangler-d1-create";
export const PLACEHOLDER_AUD = "REPLACE-with-access-aud-tag";

const DB_ID_PATH = ["env", "production", "d1_databases", 0, "database_id"];
const AUD_PATH = ["env", "production", "vars", "POLICY_AUD"];

type Prod = {
  vars?: Record<string, string>;
  d1_databases?: Array<{ database_name?: string; database_id?: string }>;
  workflows?: Array<{ name?: string }>;
};

export type ProductionValues = {
  databaseName: string | null;
  databaseId: string | null;
  policyAud: string | null;
  teamDomain: string | null;
  workflowName: string | null;
  llmProvider: string | null;
  llmModel: string | null;
  llmDailyDraftLimit: number | null;
};

export function productionValues(text: string): ProductionValues {
  const prod = ((parse(text) as { env?: { production?: Prod } }).env?.production ?? {}) as Prod;
  const v = prod.vars ?? {};
  const real = (s: string | undefined) => (s && !s.includes("REPLACE") ? s : null);
  return {
    databaseName: prod.d1_databases?.[0]?.database_name ?? null,
    databaseId: real(prod.d1_databases?.[0]?.database_id),
    policyAud: real(v.POLICY_AUD),
    teamDomain: real(v.TEAM_DOMAIN),
    workflowName: prod.workflows?.[0]?.name ?? null,
    llmProvider: v.LLM_PROVIDER ?? null,
    llmModel: v.LLM_MODEL ?? null,
    llmDailyDraftLimit: v.LLM_DAILY_DRAFT_LIMIT !== undefined ? Number(v.LLM_DAILY_DRAFT_LIMIT) : null,
  };
}

function set(text: string, path: Array<string | number>, value: string): string {
  return applyEdits(text, modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
}

export function withDatabaseId(text: string, id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`not a D1 database id: ${id}`);
  return set(text, DB_ID_PATH, id);
}

export function withPolicyAud(text: string, aud: string): string {
  if (!/^[0-9a-f]{32,128}$/.test(aud)) throw new Error("not an Access AUD tag");
  return set(text, AUD_PATH, aud);
}
