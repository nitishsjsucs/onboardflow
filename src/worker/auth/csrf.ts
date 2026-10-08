// Cross-site request defenses (SPEC Section 10.4). Every non-GET, non-HEAD
// request under /api and /dev must carry an Origin equal to the request's own
// origin and the custom header X-OnboardFlow: 1. A plain HTML form cannot set a
// custom header, and a cross-origin fetch with one fails its preflight because
// the Worker never sends CORS headers.
import type { MiddlewareHandler } from "hono";
import { apiError, type AppEnv } from "../http.ts";

export const CSRF_HEADER = "X-OnboardFlow";

export function sameOriginProblem(req: Request): { code: "bad_origin" | "csrf_header_missing"; message: string } | null {
  const origin = req.headers.get("Origin");
  if (!origin || origin !== new URL(req.url).origin) {
    return { code: "bad_origin", message: "Origin header missing or not this site" };
  }
  if (req.headers.get(CSRF_HEADER) !== "1") {
    return { code: "csrf_header_missing", message: `${CSRF_HEADER}: 1 header required` };
  }
  return null;
}

export const requireSameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD") return next();
  const problem = sameOriginProblem(c.req.raw);
  if (problem) return apiError(c, 403, problem.code, problem.message);
  return next();
};

export const DEV_COOKIE_MAX_AGE_S = 8 * 60 * 60;

/** Dev cookie: HttpOnly; SameSite=Strict; Path=/; Max-Age=28800, plus Secure on https. */
export function devCookie(token: string, secure: boolean, maxAge = DEV_COOKIE_MAX_AGE_S): string {
  return `CF_Authorization=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
