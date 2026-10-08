// Dev-only identity stand-in (SPEC Section 10.2). /dev/login mints an RS256 JWT
// with the same claim shape Cloudflare Access uses and sets CF_Authorization;
// the request middleware then verifies it with the same verifyAccessJwt as
// production, against the local JWKS. Mounted only when AUTH_MODE=dev, and the
// app's host guard limits it to localhost.
import { Hono } from "hono";
import { importJWK, SignJWT } from "jose";
import { z } from "zod";
import { auditIds } from "../../shared/ids.ts";
import type { Role } from "../../shared/roles.ts";
import { auditInsert } from "../db/audit.ts";
import { apiError, type AppEnv } from "../http.ts";
import { devCookie } from "./csrf.ts";
import { loadPrincipal } from "./middleware.ts";

export const DEV_TOKEN_TTL_S = 8 * 60 * 60;

export type Persona = { email: string; role: Role; label: string };

export async function listPersonas(db: D1Database): Promise<Persona[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM (
         SELECT u.email, u.role, 'Employee: ' || e.first_name || ' ' || e.last_name || ' (' || e.id || ', ' || e.org_unit || ')' AS label, e.id AS k
           FROM app_users u JOIN employees e ON e.id = u.employee_id
          WHERE u.active = 1 ORDER BY e.id LIMIT 3)
       UNION ALL SELECT * FROM (
         SELECT u.email, u.role, 'Manager: ' || s.display_name || ' (' || s.id || ', ' || s.org_unit || ')' AS label, s.id AS k
           FROM app_users u JOIN staff s ON s.id = u.staff_id
          WHERE u.active = 1 AND u.role = 'manager' ORDER BY s.id LIMIT 3)
       UNION ALL SELECT * FROM (
         SELECT u.email, u.role, 'Coordinator: ' || s.display_name || ' (' || s.department || ')' AS label, s.id AS k
           FROM app_users u JOIN staff s ON s.id = u.staff_id
          WHERE u.active = 1 AND u.role = 'coordinator'
            AND s.id IN (SELECT MIN(id) FROM staff WHERE kind = 'coordinator' GROUP BY department)
          ORDER BY s.id LIMIT 3)
       UNION ALL SELECT * FROM (
         SELECT u.email, u.role, 'Admin: ' || s.display_name || ' (' || s.id || ')' AS label, s.id AS k
           FROM app_users u JOIN staff s ON s.id = u.staff_id
          WHERE u.active = 1 AND u.role = 'admin' ORDER BY s.id LIMIT 3)`,
    )
    .all<{ email: string; role: Role; label: string }>();
  return rows.results.map(({ email, role, label }) => ({ email, role, label }));
}

export async function mintDevToken(
  signingJwk: Record<string, unknown>,
  claims: { email: string; issuer: string; audience: string; nowS: number; ttlS?: number },
): Promise<string> {
  const key = await importJWK(signingJwk, "RS256");
  return new SignJWT({ email: claims.email })
    .setProtectedHeader({ alg: "RS256", kid: "dev-1", typ: "JWT" })
    .setSubject(`dev:${claims.email}`)
    .setIssuer(claims.issuer)
    .setAudience(claims.audience)
    .setIssuedAt(claims.nowS)
    .setExpirationTime(claims.nowS + (claims.ttlS ?? DEV_TOKEN_TTL_S))
    .sign(key);
}

const LoginBody = z.object({ email: z.string().email().max(320) });

export function devRoutes() {
  const dev = new Hono<AppEnv>();

  dev.get("/personas", async (c) => c.json(await listPersonas(c.env.DB)));

  dev.post("/login", async (c) => {
    const config = c.get("config");
    if (!config.dev?.signingJwk) {
      return apiError(c, 500, "dev_signing_key_missing", "DEV_ACCESS_SIGNING_JWK is not set; run npm run dev:keys");
    }
    const parsed = LoginBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 400, "invalid_request", "body must be { email }");
    const email = parsed.data.email.toLowerCase();
    const principal = await loadPrincipal(c.env.DB, email);
    if (!principal) return apiError(c, 403, "not_provisioned", "this email has no OnboardFlow account");

    // Token lifetimes use the real clock: jose verifies exp against Date.now().
    const token = await mintDevToken(config.dev.signingJwk as Record<string, unknown>, {
      email,
      issuer: config.dev.issuer,
      audience: config.dev.audience,
      nowS: Math.floor(Date.now() / 1000),
    });
    const requestId = c.get("requestId");
    await auditInsert(c.env.DB, {
      id: auditIds.user(requestId, "dev.login"),
      occurredAt: c.get("clock").nowIso(),
      actorType: "user",
      actorId: email,
      actorRole: principal.role,
      action: "dev.login",
      entityType: "app_user",
      entityId: email,
      requestId,
    }).run();
    const secure = new URL(c.req.url).protocol === "https:";
    c.header("Set-Cookie", devCookie(token, secure));
    return c.json({ token });
  });

  dev.post("/logout", (c) => {
    const secure = new URL(c.req.url).protocol === "https:";
    c.header("Set-Cookie", devCookie("", secure, 0));
    return c.json({ ok: true });
  });

  return dev;
}
