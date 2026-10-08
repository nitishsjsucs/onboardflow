// Mints Access-shaped RS256 tokens with the per-run test key that
// vitest.config.ts passes as the DEV_ACCESS_SIGNING_JWK binding.
import { env } from "cloudflare:workers";
import { importJWK, SignJWT, type JWK } from "jose";

export type TokenOverrides = {
  issuer?: string;
  audience?: string;
  /** seconds from now; negative means already expired */
  expiresInS?: number;
  kid?: string;
  signingJwk?: JWK;
  claims?: Record<string, unknown>;
};

export async function mintAccessToken(email: string, o: TokenOverrides = {}): Promise<string> {
  const jwk = o.signingJwk ?? (JSON.parse(env.DEV_ACCESS_SIGNING_JWK ?? "{}") as JWK);
  const key = await importJWK(jwk, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email, ...o.claims })
    .setProtectedHeader({ alg: "RS256", kid: o.kid ?? "dev-1", typ: "JWT" })
    .setSubject(`test:${email}`)
    .setIssuer(o.issuer ?? env.DEV_ISSUER ?? "http://localhost/dev-access")
    .setAudience(o.audience ?? env.DEV_AUDIENCE ?? "onboardflow-dev")
    .setIssuedAt(now - 5)
    .setExpirationTime(now + (o.expiresInS ?? 3600))
    .sign(key);
}

/** Email of an employee (E001) or staff member (M01, C01, A01). */
export async function emailOf(id: string): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT email FROM employees WHERE id = ?1 UNION ALL SELECT email FROM staff WHERE id = ?1",
  )
    .bind(id)
    .first<{ email: string }>();
  if (!row) throw new Error(`no person with id ${id}`);
  return row.email;
}
