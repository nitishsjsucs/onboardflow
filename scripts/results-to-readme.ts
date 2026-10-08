// Renders the README Results block from recorded eval runs only
// (eval/results/latest-*.json). `npm run results:readme` rewrites the block
// between the markers; readme-results.test.ts fails if they drift.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalRun } from "../eval/harness/metrics.ts";
import { renderResults } from "../eval/harness/report.ts";

export const START = "<!-- results:start -->";
export const END = "<!-- results:end -->";

export function latestRuns(dir = "eval/results"): EvalRun[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^latest-.*\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as EvalRun);
}

export function renderBlock(runs: EvalRun[]): string {
  const body = runs.length > 0 ? renderResults(runs) : "No eval results have been recorded yet.";
  return `${START}\n${body}\n${END}`;
}

export function readmeBlock(readme: string): string {
  const a = readme.indexOf(START);
  const b = readme.indexOf(END);
  if (a < 0 || b < a) throw new Error("README has no results markers");
  return readme.slice(a, b + END.length);
}

function main() {
  const readme = readFileSync("README.md", "utf8");
  const next = readme.replace(readmeBlock(readme), renderBlock(latestRuns()));
  writeFileSync("README.md", next);
  console.log("README results block updated from eval/results/latest-*.json");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
