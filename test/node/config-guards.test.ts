import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import { checkWranglerConfig, findPlaceholders } from "../../scripts/predeploy-check.ts";
import { PLACEHOLDER_AUD, PLACEHOLDER_DB_ID, productionValues } from "../../scripts/prod/wrangler-config.ts";
import { committedConfig, preSetupConfig } from "./pre-setup-config.ts";

const cfg = parse(committedConfig) as {
  compatibility_date: string;
  compatibility_flags: string[];
  secrets: { required: string[] };
  vars: Record<string, string>;
  env: { production: { secrets: { required: string[] }; vars: Record<string, string> } };
};
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };

describe("wrangler.jsonc guards", () => {
  it("runs production with Access auth, hooks and the simulated clock off, idempotency keys on", () => {
    const v = cfg.env.production.vars;
    expect(v.AUTH_MODE).toBe("access");
    expect(v.EVAL_HOOKS).toBe("off");
    expect(v.SIM_CLOCK).toBe("off");
    expect(v.IDEMPOTENCY_KEYS).toBe("on");
  });

  it("drafts follow-up wording with Workers AI in production, capped per UTC day and without an AI Gateway", () => {
    const v = cfg.env.production.vars;
    expect(v.LLM_PROVIDER).toBe("workers-ai");
    expect(Number(v.LLM_DAILY_DRAFT_LIMIT)).toBeGreaterThan(0);
    expect(Number(v.LLM_DAILY_DRAFT_LIMIT)).toBeLessThanOrEqual(25);
    // a named gateway must be created before use; the cap, not a gateway, bounds the neurons
    expect(v.AI_GATEWAY_ID).toBeUndefined();
    expect(cfg.vars.LLM_PROVIDER).toBe("stub");
  });

  it("requires SIM_API_KEY in production and carries no DEV_* settings there", () => {
    expect(cfg.env.production.secrets.required).toContain("SIM_API_KEY");
    expect(Object.keys(cfg.env.production.vars).filter((k) => k.startsWith("DEV_"))).toEqual([]);
    expect(cfg.env.production.secrets.required.filter((k) => k.startsWith("DEV_"))).toEqual([]);
  });

  it("lists the three dev secrets at the top level (so typegen does not depend on a local .dev.vars)", () => {
    expect([...cfg.secrets.required].sort()).toEqual(["DEV_ACCESS_JWKS", "DEV_ACCESS_SIGNING_JWK", "SIM_API_KEY"]);
    expect(cfg.vars.AUTH_MODE).toBe("dev");
  });

  it("uses a compatibility date with ctx.exports on by default (>= 2025-11-17) and nodejs_compat", () => {
    expect(cfg.compatibility_date >= "2025-11-17").toBe(true);
    expect(cfg.compatibility_flags).toContain("nodejs_compat");
  });

  it("generates and checks types with identical arguments (the header embeds the command line)", () => {
    expect(pkg.scripts["typegen:check"]).toBe(`${pkg.scripts.typegen} --check`);
  });

  it("serves production only on the workers.dev hostname the Access application covers (no preview URLs)", () => {
    const prod = cfg.env.production as unknown as { workers_dev?: boolean; preview_urls?: boolean; vars: Record<string, string> };
    expect(prod.workers_dev).toBe(true);
    expect(prod.preview_urls).toBe(false);
    expect(prod.vars.TEAM_DOMAIN).toBe("https://old-truth-a7dc.cloudflareaccess.com");
  });

  it("deploys only after predeploy-check", () => {
    expect(pkg.scripts.deploy?.startsWith("node scripts/predeploy-check.ts && ")).toBe(true);
  });
});

describe("predeploy-check", () => {
  // the config as it is before a setup run: the committed file with both placeholders back
  const text = preSetupConfig;
  const filled = (t: string) => t.replace("REPLACE-with-access-aud-tag", "0123abcd").replace("REPLACE-after-wrangler-d1-create", "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b");

  it("starts these checks from the pre-setup config, with both placeholders in place", () => {
    expect(text).toContain(`"database_id": "${PLACEHOLDER_DB_ID}"`);
    expect(text).toContain(`"POLICY_AUD": "${PLACEHOLDER_AUD}"`);
  });

  it("rejects the REPLACE placeholders of a config the setup script has not filled in yet (the IDs it creates)", () => {
    expect(checkWranglerConfig(text).sort()).toEqual(["env.production.d1_databases[0].database_id", "env.production.vars.POLICY_AUD"]);
  });

  it("accepts the committed config, which carries the database id and AUD the setup wrote", () => {
    const v = productionValues(committedConfig);
    expect(v.databaseId).toMatch(/^[0-9a-f-]{36}$/);
    expect(v.policyAud).toMatch(/^[0-9a-f]{32,128}$/);
    expect(checkWranglerConfig(committedConfig)).toEqual([]);
  });

  it("passes once every placeholder is replaced", () => {
    expect(checkWranglerConfig(filled(text))).toEqual([]);
    expect(findPlaceholders({ a: ["x", { b: "REPLACE" }] })).toEqual(["env.production.a[1].b"]);
  });

  it("lets only the AUD wait for the bootstrap deploy, which fails closed until it is set", () => {
    const withDb = text.replace("REPLACE-after-wrangler-d1-create", "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b");
    expect(checkWranglerConfig(withDb)).toEqual(["env.production.vars.POLICY_AUD"]);
    expect(checkWranglerConfig(withDb, { bootstrap: true })).toEqual([]);
    expect(checkWranglerConfig(text, { bootstrap: true })).toEqual(["env.production.d1_databases[0].database_id"]);
  });

  it("refuses preview URLs, a malformed database id or team domain, hooks on, and an uncapped LLM", () => {
    const f = filled(text);
    expect(checkWranglerConfig(f.replace('"preview_urls": false', '"preview_urls": true'))).toEqual(["env.production.preview_urls must be false"]);
    expect(checkWranglerConfig(f.replace("6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b", "1111-2222"))).toEqual(["env.production.d1_databases[0].database_id is not a D1 database UUID"]);
    expect(checkWranglerConfig(f.replace("https://old-truth-a7dc.cloudflareaccess.com", "http://old-truth-a7dc.example"))[0]).toMatch(/TEAM_DOMAIN/);
    expect(checkWranglerConfig(f.replace('"EVAL_HOOKS": "off",\n        // Follow-up', '"EVAL_HOOKS": "on",\n        // Follow-up'))).toEqual(["env.production.vars.EVAL_HOOKS must be off"]);
    expect(checkWranglerConfig(f.replace('"LLM_DAILY_DRAFT_LIMIT": "20",', ""))[0]).toMatch(/LLM_DAILY_DRAFT_LIMIT must cap/);
  });
});
