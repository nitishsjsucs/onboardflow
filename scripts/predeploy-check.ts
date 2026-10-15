// Refuses to deploy a production configuration that is incomplete or unsafe.
// wrangler deploy --dry-run accepts all of these, for example a placeholder
// D1 database_id. Run by `npm run deploy` and by scripts/prod/setup.ts.
//
//   node scripts/predeploy-check.ts [wrangler.jsonc] [--bootstrap]
//
// --bootstrap is the first deploy of scripts/prod/setup.ts, made before the
// Access application exists: only POLICY_AUD may still be the placeholder, and
// the Worker then fails closed (every route answers 500 config_placeholder).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";

export const AUD_PATH = "env.production.vars.POLICY_AUD";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function findPlaceholders(value: unknown, path = "env.production"): string[] {
  if (typeof value === "string") return value.includes("REPLACE") ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => findPlaceholders(v, `${path}[${i}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => findPlaceholders(v, `${path}.${k}`));
  return [];
}

type Production = {
  workers_dev?: boolean;
  preview_urls?: boolean;
  vars?: Record<string, string>;
  d1_databases?: Array<{ database_id?: string }>;
};

/** Problems that block a production deploy (empty when it may go ahead). */
export function checkWranglerConfig(text: string, opts: { bootstrap?: boolean } = {}): string[] {
  const cfg = parse(text) as { env?: { production?: Production } };
  const prod = cfg.env?.production;
  if (!prod) return ["env.production is missing"];
  const problems = findPlaceholders(prod).filter((p) => !(opts.bootstrap && p === AUD_PATH));
  const v = prod.vars ?? {};
  const dbId = prod.d1_databases?.[0]?.database_id ?? "";
  if (!dbId.includes("REPLACE") && !UUID.test(dbId)) problems.push("env.production.d1_databases[0].database_id is not a D1 database UUID");
  const team = v.TEAM_DOMAIN ?? "";
  if (!team.includes("REPLACE") && !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(team)) problems.push("env.production.vars.TEAM_DOMAIN must be https://<team>.cloudflareaccess.com");
  if (v.AUTH_MODE !== "access") problems.push("env.production.vars.AUTH_MODE must be access");
  if (v.EVAL_HOOKS !== "off") problems.push("env.production.vars.EVAL_HOOKS must be off");
  if (v.SIM_CLOCK !== "off") problems.push("env.production.vars.SIM_CLOCK must be off");
  // the Access application protects one hostname; preview URLs would be others
  if (prod.preview_urls !== false) problems.push("env.production.preview_urls must be false");
  if (v.LLM_PROVIDER && v.LLM_PROVIDER !== "stub" && !/^\d+$/.test(v.LLM_DAILY_DRAFT_LIMIT ?? "")) {
    problems.push("env.production.vars.LLM_DAILY_DRAFT_LIMIT must cap a real LLM provider (Workers AI neurons are shared by the account)");
  }
  return problems;
}

function main() {
  const args = process.argv.slice(2);
  const bootstrap = args.includes("--bootstrap");
  const file = args.find((a) => !a.startsWith("--")) ?? "wrangler.jsonc";
  const problems = checkWranglerConfig(readFileSync(file, "utf8"), { bootstrap });
  if (problems.length > 0) {
    console.error("predeploy-check: fix these before deploying (README, Production setup):");
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(bootstrap ? "predeploy-check: ok for the bootstrap deploy (the Worker fails closed until POLICY_AUD is set)" : "predeploy-check: ok");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
