// call(path, opts): drives the real Worker through exports.default.fetch at
// http://localhost. Mutations get Origin, X-OnboardFlow and an Idempotency-Key
// by default, exactly like the SPA client; tests opt out to probe the guards.
import { exports } from "cloudflare:workers";
import { emailOf, mintAccessToken } from "./auth.ts";

export const BASE = "http://localhost";

export type CallOptions = {
  /** person id (E001, M01, C01, A01) or an email; omitted = unauthenticated */
  as?: string;
  method?: string;
  body?: unknown;
  /** null = omit the header; undefined = fresh UUID on mutations */
  idempotencyKey?: string | null;
  /** null = omit; undefined = http://localhost on mutations */
  origin?: string | null;
  /** false = omit X-OnboardFlow on mutations */
  csrf?: boolean;
  token?: string;
  headers?: Record<string, string>;
};

export async function tokenFor(as: string): Promise<string> {
  const email = as.includes("@") ? as : await emailOf(as);
  return mintAccessToken(email);
}

export async function call(path: string, o: CallOptions = {}): Promise<Response> {
  const method = o.method ?? (o.body !== undefined ? "POST" : "GET");
  const headers = new Headers(o.headers);
  const token = o.token ?? (o.as ? await tokenFor(o.as) : undefined);
  if (token) headers.set("Cf-Access-Jwt-Assertion", token);
  const mutation = method !== "GET" && method !== "HEAD";
  if (mutation) {
    if (o.origin !== null) headers.set("Origin", o.origin ?? BASE);
    if (o.csrf !== false) headers.set("X-OnboardFlow", "1");
    if (o.idempotencyKey !== null && path.startsWith("/api/")) {
      headers.set("Idempotency-Key", o.idempotencyKey ?? crypto.randomUUID());
    }
  }
  let body: string | undefined;
  if (o.body !== undefined) {
    body = JSON.stringify(o.body);
    headers.set("Content-Type", "application/json");
  }
  return exports.default.fetch(new Request(`${BASE}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) }));
}

export async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
