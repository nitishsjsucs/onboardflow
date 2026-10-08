import { existsSync, readFileSync } from "node:fs";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { generateDevSecrets } from "./scripts/dev-keys.ts";

/** The generated seed has one statement per chunk, each ending in ";" at end of line. */
function splitSql(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter((s) => s.length > 0);
}

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  const seedStatements = existsSync("seed/seed.sql") ? splitSql(readFileSync("seed/seed.sql", "utf8")) : [];
  const secrets = await generateDevSecrets("test-sim-key");

  return {
    test: {
      passWithNoTests: true,
      projects: [
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  TEST_SEED: seedStatements,
                  DEV_ACCESS_JWKS: secrets.DEV_ACCESS_JWKS,
                  DEV_ACCESS_SIGNING_JWK: secrets.DEV_ACCESS_SIGNING_JWK,
                  SIM_API_KEY: secrets.SIM_API_KEY,
                  EVAL_HOOKS: "on",
                  SIM_CLOCK: "on",
                  RETRY_BASE_DELAY_MS: "10",
                  POLL_INTERVAL_MS: "10",
                  INTEGRATION_TIMEOUT_MS: "2000",
                  GATE_WAIT_TIMEOUT_MS: "1000",
                  NUDGE_AFTER_S: "1",
                  HUB_DEBOUNCE_S: "1",
                  BLOCKER_SCAN_INTERVAL_S: "3600",
                },
              },
            }),
          ],
          test: {
            name: "worker",
            include: ["test/worker/**/*.test.ts"],
            setupFiles: ["test/setup/apply-migrations.ts"],
            fileParallelism: false,
            testTimeout: 60_000,
          },
        },
        {
          test: { name: "node", include: ["test/node/**/*.test.ts"], environment: "node" },
        },
        {
          plugins: [react()],
          test: { name: "web", include: ["test/web/**/*.test.tsx"], environment: "happy-dom" },
        },
      ],
    },
  };
});
