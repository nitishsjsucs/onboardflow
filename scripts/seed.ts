// Writes seed/seed.sql and seed/manifest.json from the pure generator.
//   node scripts/seed.ts                         regenerate the committed seed
//   node scripts/seed.ts --check                 fail if the committed files differ (CI)
//   node scripts/seed.ts --anchor 2027-03-01 --out seed/seed.demo.sql   demo seed with shifted dates
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  DEFAULT_ANCHOR,
  DEFAULT_SEED,
  DEFAULT_VERSION,
  datasetCounts,
  generateDataset,
  jointCounts,
} from "../src/shared/synthetic/generate.ts";
import { datasetToSql } from "../src/shared/synthetic/to-sql.ts";

export function buildSeed(seed = DEFAULT_SEED, anchor = DEFAULT_ANCHOR, version = DEFAULT_VERSION) {
  const dataset = generateDataset(seed, anchor, version);
  const sql = datasetToSql(dataset);
  const sha256 = createHash("sha256").update(sql).digest("hex");
  const manifest = {
    seed,
    anchor,
    version,
    counts: datasetCounts(dataset),
    jointCounts: jointCounts(dataset),
    sha256,
  };
  return { sql, manifest: JSON.stringify(manifest, null, 2) + "\n", sha256 };
}

function main() {
  const { values } = parseArgs({
    options: {
      check: { type: "boolean", default: false },
      anchor: { type: "string", default: DEFAULT_ANCHOR },
      seed: { type: "string", default: String(DEFAULT_SEED) },
      out: { type: "string" },
    },
  });
  const anchor = values.anchor ?? DEFAULT_ANCHOR;
  const { sql, manifest, sha256 } = buildSeed(Number(values.seed), anchor);
  const isDefault = anchor === DEFAULT_ANCHOR && Number(values.seed) === DEFAULT_SEED;
  const out = values.out ?? (isDefault ? "seed/seed.sql" : undefined);
  if (!out) {
    console.error("a non-default --anchor or --seed needs --out (for example seed/seed.demo.sql)");
    process.exit(2);
  }

  if (values.check) {
    const sqlOk = readFileSync(out, "utf8") === sql;
    const manifestOk = readFileSync("seed/manifest.json", "utf8") === manifest;
    if (!sqlOk || !manifestOk) {
      console.error(`seed:check failed: ${!sqlOk ? out : ""} ${!manifestOk ? "seed/manifest.json" : ""} differ from the generator`);
      process.exit(1);
    }
    console.log(`seed:check ok (sha256 ${sha256})`);
    return;
  }

  writeFileSync(out, sql);
  if (out === "seed/seed.sql") writeFileSync("seed/manifest.json", manifest);
  console.log(`wrote ${out} (sha256 ${sha256})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
