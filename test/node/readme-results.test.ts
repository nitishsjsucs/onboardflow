import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { latestRuns, readmeBlock, renderBlock } from "../../scripts/results-to-readme.ts";

const readme = readFileSync("README.md", "utf8");

describe("README Results", () => {
  it("equals the rendering of eval/results/latest-*.json", () => {
    expect(readmeBlock(readme)).toBe(renderBlock(latestRuns()));
  });

  it("fails when a number is edited by hand", () => {
    const runs = latestRuns();
    if (runs.length === 0) return;
    const block = readmeBlock(readme);
    const edited = block.replace(/\| Cases started \| (\d+) \|/, (_m, n: string) => `| Cases started | ${Number(n) + 1} |`);
    expect(edited).not.toBe(block);
    expect(edited).not.toBe(renderBlock(runs));
  });

  it("only reports runs recorded by this repository's harness, with their command and date", () => {
    for (const run of latestRuns()) {
      expect(run.environment.runtime).toBe("local wrangler dev (Miniflare/workerd)");
      expect(readmeBlock(readme)).toContain(`run ${run.startedAt.slice(0, 10)}`);
    }
  });
});
