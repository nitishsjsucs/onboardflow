import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import { checkWranglerConfig, findPlaceholders } from "../../scripts/predeploy-check.ts";

const text = readFileSync("wrangler.jsonc", "utf8");
const cfg = parse(text) as {
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
    expect(v.LLM_PROVIDER).toBe("stub");
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

  it("deploys only after predeploy-check", () => {
    expect(pkg.scripts.deploy?.startsWith("node scripts/predeploy-check.ts && ")).toBe(true);
  });
});

describe("predeploy-check", () => {
  it("rejects the REPLACE placeholders still in the committed config", () => {
    expect(checkWranglerConfig(text).sort()).toEqual([
      "env.production.d1_databases[0].database_id",
      "env.production.vars.POLICY_AUD",
      "env.production.vars.TEAM_DOMAIN",
    ]);
  });

  it("passes once every placeholder is replaced", () => {
    const filled = text
      .replace("https://REPLACE-team.cloudflareaccess.com", "https://acme.cloudflareaccess.com")
      .replace("REPLACE-with-access-aud-tag", "0123abcd")
      .replace("REPLACE-after-wrangler-d1-create", "1111-2222");
    expect(checkWranglerConfig(filled)).toEqual([]);
    expect(findPlaceholders({ a: ["x", { b: "REPLACE" }] })).toEqual(["env.production.a[1].b"]);
  });
});
