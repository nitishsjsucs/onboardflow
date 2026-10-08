import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { app } from "../../src/worker/app.ts";
import { emailOf, mintAccessToken } from "../helpers/auth.ts";

const ACCESS = { AUTH_MODE: "access", TEAM_DOMAIN: "https://guard-test.cloudflareaccess.com", POLICY_AUD: "aud-guard" };

async function appFetch(url: string, init: RequestInit = {}, override: Record<string, unknown> = {}) {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(url, init), { ...env, ...override } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const post = (origin: string, body: unknown) => ({
  method: "POST",
  headers: { Origin: origin, "X-OnboardFlow": "1", "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("dev routes exist only in dev mode", () => {
  it("returns 404 for /dev/* when AUTH_MODE=access", async () => {
    expect((await appFetch("http://localhost/dev/personas", {}, ACCESS)).status).toBe(404);
    const login = await appFetch("http://localhost/dev/login", post("http://localhost", { email: "x@onboardflow.test" }), ACCESS);
    expect(login.status).toBe(404);
    expect(login.headers.get("Set-Cookie")).toBeNull();
  });

  it("serves personas in dev mode: up to 3 per role", async () => {
    const res = await appFetch("http://localhost/dev/personas");
    expect(res.status).toBe(200);
    const personas = (await res.json()) as Array<{ role: string; email: string; label: string }>;
    const byRole = (r: string) => personas.filter((p) => p.role === r).length;
    expect(byRole("employee")).toBe(3);
    expect(byRole("manager")).toBe(3);
    expect(byRole("coordinator")).toBe(3); // one per department
    expect(byRole("admin")).toBe(2); // the seed has exactly 2 admins
  });
});

describe("dev auth is never served to a public host", () => {
  it("returns 500 dev_auth_on_public_host for /api, /agents and /dev", async () => {
    for (const path of ["/api/health", "/api/me", "/agents/case-agent/E001", "/dev/personas"]) {
      const res = await appFetch(`https://onboardflow.example.workers.dev${path}`);
      expect(res.status, path).toBe(500);
      expect(await res.json(), path).toMatchObject({ error: { code: "dev_auth_on_public_host" } });
    }
  });

  it("does not cover /sim/* or other paths", async () => {
    for (const path of ["/sim/hr/v1/workers/x", "/"]) {
      const res = await appFetch(`https://onboardflow.example.workers.dev${path}`);
      expect(res.status, path).not.toBe(500);
    }
  });

  it("accepts the loopback names", async () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect((await appFetch(`http://${host}/api/health`)).status, host).toBe(200);
    }
  });
});

describe("signing key is only needed by /dev/login", () => {
  it("returns dev_signing_key_missing from /dev/login while /api/me still works", async () => {
    const override = { DEV_ACCESS_SIGNING_JWK: undefined };
    const email = await emailOf("E003");
    const login = await appFetch("http://localhost/dev/login", post("http://localhost", { email }), override);
    expect(login.status).toBe(500);
    expect(await login.json()).toMatchObject({ error: { code: "dev_signing_key_missing" } });
    const me = await appFetch("http://localhost/api/me", { headers: { "Cf-Access-Jwt-Assertion": await mintAccessToken(email) } }, override);
    expect(me.status).toBe(200);
  });
});

describe("eval hooks exist only in dev mode", () => {
  it("returns 404 for /api/dev/* and /sim/admin/* when AUTH_MODE=access, before any authentication", async () => {
    for (const [path, method] of [
      ["/api/dev/eval/hub", "GET"],
      ["/api/dev/faults", "POST"],
      ["/api/dev/clock/advance", "POST"],
      ["/api/dev/agents/case/E001/evict", "POST"],
    ] as const) {
      const res = await appFetch(`http://localhost${path}`, method === "POST" ? post("http://localhost", {}) : {}, ACCESS);
      expect(res.status, path).toBe(404);
    }
    const sim = await appFetch("http://localhost/sim/admin/ledger", { headers: { "X-Sim-Api-Key": env.SIM_API_KEY } }, ACCESS);
    expect(sim.status).toBe(404);
  });
});
