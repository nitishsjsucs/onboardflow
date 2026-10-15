// Verifies a Cloudflare Access JWT (Cf-Access-Jwt-Assertion or the
// CF_Authorization cookie): RS256 only, issuer and audience enforced, and the
// exp and iat claims required (jose checks exp only when present, so a
// token without one would never expire). The dev stand-in tokens minted by /dev/login use the same claim
// shape and go through this exact function with a local key source.
//
// The identity is the email claim of a user login. An Access service token (Service Auth policy, used by
// the production verification script) carries no email: Access signs it with an empty sub and the token's
// Client ID as common_name. That becomes the identity `service-token:<client id>`, which can never equal an
// email (it has no @) and grants nothing until an app_users row with that identity exists.
import { jwtVerify, type JWTVerifyGetKey } from "jose";

export type AccessClaims = {
  /** The email of a user login, or `service-token:<client id>` for an Access service token. */
  email: string;
  sub: string;
  /** expiry, seconds since the epoch */
  exp: number;
  kind: "user" | "service";
};

export const SERVICE_TOKEN_PREFIX = "service-token:";
const CLIENT_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** The app_users identity of an Access service token, from its Client ID (the JWT's common_name). */
export function serviceTokenIdentity(clientId: string): string {
  return `${SERVICE_TOKEN_PREFIX}${clientId.toLowerCase()}`;
}

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
      requiredClaims: ["exp", "iat"],
    }));
  } catch (err) {
    throw new AccessTokenError(err instanceof Error ? err.message : String(err));
  }
  if (typeof payload.exp !== "number") throw new AccessTokenError("token has no numeric exp claim");
  const email = payload.email;
  if (typeof email === "string" && email.length > 0) {
    return { email: email.toLowerCase(), sub: typeof payload.sub === "string" ? payload.sub : "", exp: payload.exp, kind: "user" };
  }
  // Access service token: no email, sub is the empty string, common_name is the Client ID.
  const clientId = payload.common_name;
  if (email === undefined && payload.sub === "" && typeof clientId === "string" && CLIENT_ID.test(clientId)) {
    return { email: serviceTokenIdentity(clientId), sub: "", exp: payload.exp, kind: "service" };
  }
  throw new AccessTokenError("token has no email claim");
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
