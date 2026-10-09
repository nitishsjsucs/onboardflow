import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../../src/worker/app.ts";
import { call, json } from "../helpers/api.ts";
import { emailOf, mintAccessToken } from "../helpers/auth.ts";

const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

async function me(token: string | undefined, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  if (token) headers["Cf-Access-Jwt-Assertion"] = token;
  return call("/api/me", { headers });
}

async function appFetch(url: string, init: RequestInit, envOverride: Record<string, unknown>) {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(url, init), { ...env, ...envOverride } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

afterEach(() => vi.restoreAllMocks());

describe("dev key source (same verifier as production)", () => {
  it("accepts a valid token and returns the principal", async () => {
    const email = await emailOf("E001");
    const res = await me(await mintAccessToken(email));
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ email, role: "employee", employeeId: "E001" });
  });

  it("returns coordinator department and staff id", async () => {
    const res = await me(await mintAccessToken(await emailOf("C03")));
    expect(await json(res)).toMatchObject({ role: "coordinator", staffId: "C03", department: "it" });
  });

  it("rejects a missing token with 401", async () => {
    const res = await me(undefined);
    expect(res.status).toBe(401);
    expect(await json(res)).toMatchObject({ error: { code: "unauthenticated" } });
  });

  it("rejects expired, wrong-audience and wrong-issuer tokens with 401", async () => {
    const email = await emailOf("E001");
    expect((await me(await mintAccessToken(email, { expiresInS: -60 }))).status).toBe(401);
    expect((await me(await mintAccessToken(email, { audience: "someone-else" }))).status).toBe(401);
    expect((await me(await mintAccessToken(email, { issuer: "https://evil.example" }))).status).toBe(401);
  });

  it("rejects tokens without exp, iat or email with 401", async () => {
    const email = await emailOf("E001");
    const key = await importJWK(JSON.parse(env.DEV_ACCESS_SIGNING_JWK ?? "{}") as JWK, "RS256");
    const now = Math.floor(Date.now() / 1000);
    const sign = (claims: Record<string, unknown>) =>
      new SignJWT({ iss: env.DEV_ISSUER, aud: env.DEV_AUDIENCE, ...claims }).setProtectedHeader({ alg: "RS256", kid: "dev-1", typ: "JWT" }).sign(key);
    // the same key and claims with all three present are accepted, so each refusal is about the missing claim
    expect((await me(await sign({ email, iat: now, exp: now + 600 }))).status).toBe(200);
    for (const claims of [{ email, iat: now }, { email, exp: now + 600 }, { iat: now, exp: now + 600 }]) {
      const res = await me(await sign(claims));
      expect(res.status, JSON.stringify(Object.keys(claims))).toBe(401);
    }
  });

  it("rejects HS256 and alg none tokens with 401", async () => {
    const email = await emailOf("E001");
    const now = Math.floor(Date.now() / 1000);
    const claims = { email, iss: env.DEV_ISSUER, aud: env.DEV_AUDIENCE, iat: now, exp: now + 600 };
    const hs = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", kid: "dev-1" })
      .sign(new TextEncoder().encode("a-shared-secret-that-is-long-enough-for-hs256"));
    expect((await me(hs)).status).toBe(401);
    const none = `${b64url({ alg: "none", typ: "JWT" })}.${b64url(claims)}.`;
    expect((await me(none)).status).toBe(401);
  });

  it("rejects a token signed by an unknown key id with 401", async () => {
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk = (await exportJWK(privateKey)) as JWK;
    const token = await mintAccessToken(await emailOf("E001"), { kid: "attacker-1", signingJwk: jwk });
    expect((await me(token)).status).toBe(401);
    // the same foreign key presenting the trusted kid fails signature verification
    const forged = await mintAccessToken(await emailOf("E001"), { signingJwk: jwk });
    expect((await me(forged)).status).toBe(401);
  });

  it("falls back to the CF_Authorization cookie", async () => {
    const token = await mintAccessToken(await emailOf("M01"));
    const res = await me(undefined, { Cookie: `theme=dark; CF_Authorization=${token}` });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ role: "manager", staffId: "M01" });
  });

  it("answers 403 not_provisioned for an unknown email and audits auth.denied", async () => {
    const res = await me(await mintAccessToken("stranger@onboardflow.test"));
    expect(res.status).toBe(403);
    const body = await json<{ error: { code: string; requestId: string } }>(res);
    expect(body.error.code).toBe("not_provisioned");
    const row = await env.DB.prepare("SELECT * FROM audit_events WHERE action = 'auth.denied' AND request_id = ?")
      .bind(body.error.requestId)
      .first<{ actor_id: string; entity_id: string }>();
    expect(row).toMatchObject({ actor_id: "stranger@onboardflow.test", entity_id: "stranger@onboardflow.test" });
  });
});

describe("production key source (AUTH_MODE=access)", () => {
  it("fetches ${TEAM_DOMAIN}/cdn-cgi/access/certs and enforces POLICY_AUD and issuer", async () => {
    const teamDomain = "https://unit-test-team.cloudflareaccess.com";
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const pub = { ...(await exportJWK(publicKey)), kid: "access-1", alg: "RS256", use: "sig" };
    const priv = { ...(await exportJWK(privateKey)), kid: "access-1" } as JWK;
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === `${teamDomain}/cdn-cgi/access/certs`) return Response.json({ keys: [pub] });
      return realFetch(input, init);
    });
    const override = { AUTH_MODE: "access", TEAM_DOMAIN: teamDomain, POLICY_AUD: "aud-tag-123" };
    const email = await emailOf("A01");
    const good = await mintAccessToken(email, { signingJwk: priv, kid: "access-1", issuer: teamDomain, audience: "aud-tag-123" });
    const ok = await appFetch("http://localhost/api/me", { headers: { "Cf-Access-Jwt-Assertion": good } }, override);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ role: "admin" });
    expect(spy.mock.calls.some(([u]) => String(u instanceof Request ? u.url : u) === `${teamDomain}/cdn-cgi/access/certs`)).toBe(true);

    const wrongAud = await mintAccessToken(email, { signingJwk: priv, kid: "access-1", issuer: teamDomain, audience: "aud-other" });
    expect((await appFetch("http://localhost/api/me", { headers: { "Cf-Access-Jwt-Assertion": wrongAud } }, override)).status).toBe(401);
    const wrongIss = await mintAccessToken(email, { signingJwk: priv, kid: "access-1", issuer: "https://other.cloudflareaccess.com", audience: "aud-tag-123" });
    expect((await appFetch("http://localhost/api/me", { headers: { "Cf-Access-Jwt-Assertion": wrongIss } }, override)).status).toBe(401);
    // a dev-signed token is worthless in production mode
    const devToken = await mintAccessToken(email, { issuer: teamDomain, audience: "aud-tag-123" });
    expect((await appFetch("http://localhost/api/me", { headers: { "Cf-Access-Jwt-Assertion": devToken } }, override)).status).toBe(401);
  });

  it("fails closed with config_placeholder while REPLACE values remain", async () => {
    const res = await appFetch(
      "http://localhost/api/me",
      {},
      { AUTH_MODE: "access", TEAM_DOMAIN: "https://REPLACE-team.cloudflareaccess.com", POLICY_AUD: "REPLACE-with-access-aud-tag" },
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: "config_placeholder" } });
  });

  it("fails closed when Access settings are missing", async () => {
    const res = await appFetch("http://localhost/api/health", {}, { AUTH_MODE: "access", TEAM_DOMAIN: undefined, POLICY_AUD: undefined });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: "config_invalid" } });
  });
});
