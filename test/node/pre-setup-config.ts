// wrangler.jsonc as committed, and as it was before any setup run. Since 03decf7 the committed file
// carries the production D1 id and Access AUD that scripts/prod/setup.ts wrote; tests of the setup's
// edits and of predeploy-check's placeholder rules start from the same file with both placeholders back.
import { readFileSync } from "node:fs";
import { PLACEHOLDER_AUD, PLACEHOLDER_DB_ID, productionValues } from "../../scripts/prod/wrangler-config.ts";

export const committedConfig = readFileSync("wrangler.jsonc", "utf8");

export function withPlaceholders(text: string): string {
  const v = productionValues(text);
  let out = text;
  if (v.databaseId) out = out.replace(`"database_id": "${v.databaseId}"`, `"database_id": "${PLACEHOLDER_DB_ID}"`);
  if (v.policyAud) out = out.replace(`"POLICY_AUD": "${v.policyAud}"`, `"POLICY_AUD": "${PLACEHOLDER_AUD}"`);
  return out;
}

export const preSetupConfig = withPlaceholders(committedConfig);
