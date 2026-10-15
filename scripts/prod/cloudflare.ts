// Cloudflare REST and GraphQL calls for the Access setup and the analytics
// read-back, with an account API token from CF_API_TOKEN. The token is sent
// only to api.cloudflare.com and never printed: errors carry Cloudflare's
// error codes and messages, not request headers.
import { ALLOW_POLICY_NAME, ACCESS_APP_NAME, ACCESS_SESSION_DURATION, HOSTNAME, OTP_IDP_ID, SERVICE_POLICY_NAME } from "./settings.ts";

const API = "https://api.cloudflare.com/client/v4";

export class CloudflareApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CloudflareApiError";
    this.status = status;
  }
}

type Envelope<T> = { success: boolean; errors?: Array<{ code: number; message: string }>; result: T; result_info?: { page?: number; total_pages?: number } };

export class CloudflareApi {
  readonly #token: string;
  readonly #account: string;
  readonly #fetch: typeof fetch;

  constructor(token: string, accountId: string, fetcher: typeof fetch = fetch) {
    if (!token) throw new Error("CF_API_TOKEN is empty");
    this.#token = token;
    this.#account = accountId;
    this.#fetch = fetcher;
  }

  /** `path` is relative to /accounts/{account_id} unless it starts with /user or /graphql. */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = path.startsWith("/user") ? `${API}${path}` : `${API}/accounts/${this.#account}${path}`;
    const res = await this.#fetch(url, {
      method,
      headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let env: Envelope<T> | null = null;
    try {
      env = JSON.parse(text) as Envelope<T>;
    } catch {
      // not JSON
    }
    if (!res.ok || !env?.success) {
      const why = env?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") || text.slice(0, 200);
      throw new CloudflareApiError(res.status, `${method} ${path}: HTTP ${res.status} ${why}`);
    }
    return env.result;
  }

  /** Every page of a list endpoint. */
  async list<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= 50; page++) {
      const url = `${API}/accounts/${this.#account}${path}${path.includes("?") ? "&" : "?"}page=${page}&per_page=50`;
      const res = await this.#fetch(url, { headers: { Authorization: `Bearer ${this.#token}` } });
      const env = (await res.json()) as Envelope<T[]>;
      if (!res.ok || !env.success) throw new CloudflareApiError(res.status, `GET ${path}: HTTP ${res.status} ${env.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ?? ""}`);
      out.push(...(env.result ?? []));
      if (!env.result_info?.total_pages || page >= env.result_info.total_pages) break;
    }
    return out;
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.#fetch(`${API}/graphql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> | null };
    if (!res.ok || (body.errors && body.errors.length > 0) || !body.data) {
      throw new CloudflareApiError(res.status, `graphql: HTTP ${res.status} ${body.errors?.map((e) => e.message).join("; ") ?? ""}`);
    }
    return body.data;
  }

  /** Verifies the token (account-owned tokens first, then user tokens). */
  async verifyToken(): Promise<{ status: string; via: "account" | "user" }> {
    try {
      return { ...(await this.request<{ status: string }>("GET", "/tokens/verify")), via: "account" };
    } catch {
      return { ...(await this.request<{ status: string }>("GET", "/user/tokens/verify")), via: "user" };
    }
  }
}

// ---------------------------------------------------------------------------
// Access payloads (developers.cloudflare.com API reference: access/apps, access/policies, access/service_tokens)
// ---------------------------------------------------------------------------

export type AccessApp = {
  id: string;
  aud: string;
  name: string;
  domain?: string;
  type?: string;
  allowed_idps?: string[];
  auto_redirect_to_identity?: boolean;
  app_launcher_visible?: boolean;
  session_duration?: string;
  same_site_cookie_attribute?: string;
  http_only_cookie_attribute?: boolean;
  policies?: Array<{ id: string; precedence?: number; name?: string }>;
};
export type AccessPolicy = { id: string; name: string; decision: string; include: Array<Record<string, unknown>> };
export type ServiceToken = { id: string; name: string; client_id: string; client_secret?: string; expires_at?: string; duration?: string };

/** Reusable Allow policy: the owner and the persona emails (One-time PIN logins). */
export function allowPolicyBody(emails: readonly string[]): Record<string, unknown> {
  return { name: ALLOW_POLICY_NAME, decision: "allow", include: emails.map((email) => ({ email: { email } })), session_duration: ACCESS_SESSION_DURATION };
}

/** Reusable Service Auth policy: exactly the verification service token. */
export function servicePolicyBody(tokenId: string): Record<string, unknown> {
  return { name: SERVICE_POLICY_NAME, decision: "non_identity", include: [{ service_token: { token_id: tokenId } }] };
}

/**
 * Self-hosted (hostname) application for the Worker's workers.dev hostname. Hostname-based, not Worker-level:
 * Worker-level Access refuses WebSocket upgrades, and the live views are WebSockets (ADR 0003). Only the One-time
 * PIN provider, so login goes straight to it. The cookie is SameSite=Lax and HttpOnly (the SPA reads nothing from it).
 */
export function accessAppBody(policyIds: { allow: string; service: string }): Record<string, unknown> {
  return {
    name: ACCESS_APP_NAME,
    type: "self_hosted",
    domain: HOSTNAME,
    allowed_idps: [OTP_IDP_ID],
    auto_redirect_to_identity: true,
    app_launcher_visible: false,
    session_duration: ACCESS_SESSION_DURATION,
    same_site_cookie_attribute: "lax",
    http_only_cookie_attribute: true,
    policies: [
      { id: policyIds.allow, precedence: 1 },
      { id: policyIds.service, precedence: 2 },
    ],
  };
}

/** Fields of an existing application that differ from the desired body (empty: nothing to update). */
export function appDrift(current: AccessApp, desired: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, want] of Object.entries(desired)) {
    const have = (current as Record<string, unknown>)[k];
    if (k === "policies") {
      const ids = (have as AccessApp["policies"] | undefined)?.map((p) => p.id) ?? [];
      const wantIds = (want as Array<{ id: string }>).map((p) => p.id);
      if (ids.length !== wantIds.length || wantIds.some((id, i) => ids[i] !== id)) out.push(k);
    } else if (Array.isArray(want)) {
      if (JSON.stringify([...((have as unknown[]) ?? [])].sort()) !== JSON.stringify([...want].sort())) out.push(k);
    } else if (have !== want) {
      out.push(k);
    }
  }
  return out;
}

/** Fields of an existing reusable policy that differ from the desired body. */
export function policyDrift(current: AccessPolicy, desired: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (current.decision !== desired.decision) out.push("decision");
  const norm = (rules: unknown) => JSON.stringify(((rules as Array<Record<string, unknown>>) ?? []).map((r) => JSON.stringify(r)).sort());
  if (norm(current.include) !== norm(desired.include)) out.push("include");
  return out;
}
