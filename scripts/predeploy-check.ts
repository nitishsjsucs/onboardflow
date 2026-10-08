// Refuses to deploy while any value under env.production in wrangler.jsonc
// still contains a REPLACE placeholder (wrangler deploy --dry-run accepts
// them, for example the D1 database_id). Run by `npm run deploy`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";

export function findPlaceholders(value: unknown, path = "env.production"): string[] {
  if (typeof value === "string") return value.includes("REPLACE") ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => findPlaceholders(v, `${path}[${i}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => findPlaceholders(v, `${path}.${k}`));
  return [];
}

export function checkWranglerConfig(text: string): string[] {
  const cfg = parse(text) as { env?: { production?: unknown } };
  if (!cfg.env?.production) return ["env.production is missing"];
  return findPlaceholders(cfg.env.production);
}

function main() {
  const problems = checkWranglerConfig(readFileSync(process.argv[2] ?? "wrangler.jsonc", "utf8"));
  if (problems.length > 0) {
    console.error("predeploy-check: replace these placeholders before deploying (see README, Deploy):");
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log("predeploy-check: ok");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
