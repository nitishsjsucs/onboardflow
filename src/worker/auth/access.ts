// Verifies a Cloudflare Access JWT (Cf-Access-Jwt-Assertion or the
// CF_Authorization cookie): RS256 only, issuer and audience enforced, email
// required. The dev stand-in tokens minted by /dev/login use the same claim
// shape and go through this exact function with a local key source.
import { jwtVerify, type JWTVerifyGetKey } from "jose";

export type AccessClaims = { email: string; sub: string };

export class AccessTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessTokenError";
  }
}

export async function verifyAccessJwt(
  token: string,
  getKey: JWTVerifyGetKey,
  opts: { issuer: string; audience: string },
): Promise<AccessClaims> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, getKey, {
      issuer: opts.issuer,
      audience: opts.audience,
      algorithms: ["RS256"],
    }));
  } catch (err) {
    throw new AccessTokenError(err instanceof Error ? err.message : String(err));
  }
  const email = payload.email;
  if (typeof email !== "string" || email.length === 0) throw new AccessTokenError("token has no email claim");
  return { email: email.toLowerCase(), sub: typeof payload.sub === "string" ? payload.sub : "" };
}

export const ACCESS_HEADER = "Cf-Access-Jwt-Assertion";
export const ACCESS_COOKIE = "CF_Authorization";

export function readAccessToken(req: Request): string | null {
  const header = req.headers.get(ACCESS_HEADER);
  if (header) return header.trim();
  const cookie = req.headers.get("Cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === ACCESS_COOKIE) return v.join("=") || null;
  }
  return null;
}
