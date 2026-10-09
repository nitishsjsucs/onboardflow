import { existsSync, readFileSync } from "node:fs";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { generateDevSecrets } from "./scripts/dev-keys.ts";
import { WORKER_TEST_VARS } from "./test/setup/worker-vars.ts";

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
                  ...WORKER_TEST_VARS,
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
