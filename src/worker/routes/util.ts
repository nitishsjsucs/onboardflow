// Shared helpers for the /api route modules: body and query validation,
// keyset pagination, the CaseAgent RPC facade, and the Idempotency-Key
// wrapper every mutation runs through (SPEC Section 9).
import { getAgentByName } from "agents";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import { DEFAULT_PAGE } from "../../shared/api.ts";
import type { FixableField } from "../../shared/domain.ts";
import type { StageId } from "../../shared/stages.ts";
import type { Cmd, CommandResult, Decision, ScanResult } from "../agents/case-agent.ts";
import { claimIdempotency, completeIdempotency, releaseIdempotency, requestHash } from "../db/api-idempotency.ts";
import { apiError, type AppEnv } from "../http.ts";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";

/** Every /api mutation must carry an Idempotency-Key (400 otherwise). */
export const requireIdempotencyKey: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD") return next();
  const key = c.req.header(IDEMPOTENCY_HEADER);
  if (!key || key.length > 200) return apiError(c, 400, "idempotency_key_required", `${IDEMPOTENCY_HEADER} header required (at most 200 characters)`);
  return next();
};

export type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };

export async function body<T extends z.ZodTypeAny>(c: Context<AppEnv>, schema: T): Promise<Parsed<z.infer<T>>> {
  const text = await c.req.text();
  let raw: unknown = {};
  if (text.trim().length > 0) {
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, response: apiError(c, 400, "invalid_request", "body is not valid JSON") };
    }
  }
  const r = schema.safeParse(raw);
  if (!r.success) return { ok: false, response: apiError(c, 400, "invalid_request", r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")) };
  return { ok: true, value: r.data };
}

export function query<T extends z.ZodTypeAny>(c: Context<AppEnv>, schema: T): Parsed<z.infer<T>> {
  const r = schema.safeParse(c.req.query());
  if (!r.success) return { ok: false, response: apiError(c, 400, "invalid_request", r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")) };
  return { ok: true, value: r.data };
}

export function encodeCursor(v: string | number): string {
  return btoa(JSON.stringify(v)).replace(/=+$/, "");
}

export function decodeCursor<T extends string | number>(cursor: string | undefined): T | null {
  if (!cursor) return null;
  try {
    return JSON.parse(atob(cursor)) as T;
  } catch {
    return null;
  }
}

/** Slices limit+1 rows into a page; `key` extracts the cursor value of the last item. */
export function toPage<R, T>(rows: R[], limit: number, map: (r: R) => T, key: (r: R) => string | number) {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items: items.map(map), nextCursor: rows.length > limit && last !== undefined ? encodeCursor(key(last)) : null };
}

export function pageLimit(limit: number | undefined): number {
  return limit ?? DEFAULT_PAGE;
}

type Result = CommandResult<Record<string, any>>;

/** The CaseAgent RPC surface with plain types. */
export type CaseAgentRpc = {
  startCase(cmd: Cmd): Promise<Result>;
  completeTask(taskId: string, cmd: Cmd, note?: string): Promise<Result>;
  decideApproval(id: string, d: Decision, cmd: Cmd): Promise<Result>;
  resubmitApproval(id: string, cmd: Cmd, note?: string): Promise<Result>;
  retryStage(stage: StageId, cmd: Cmd, note?: string): Promise<Result>;
  fixField(field: FixableField, value: string | boolean, cmd: Cmd): Promise<Result>;
  resolveBlocker(id: string, resolution: string, cmd: Cmd): Promise<Result>;
  restartCase(reason: string, cmd: Cmd): Promise<Result>;
  terminateCase(reason: string, cmd: Cmd): Promise<Result>;
  scanNow(cmd: Cmd): Promise<CommandResult<ScanResult>>;
};

export async function caseAgent(env: Env, employeeId: string): Promise<CaseAgentRpc> {
  return (await getAgentByName(env.CASE_AGENT, employeeId)) as unknown as CaseAgentRpc;
}

/**
 * Runs a mutation under the request's Idempotency-Key: claim, replay a stored
 * response (Idempotent-Replayed: true), refuse a key in flight (409) or reused
 * with another body (422), and release the claim when the handler fails with
 * a 5xx so a retry re-executes. Guarded commands store their response in their
 * own batch; anything still pending afterwards is stored here.
 */
export async function idempotent(c: Context<AppEnv>, reqBody: unknown, run: (cmd: Cmd) => Promise<{ status: number; body: unknown }>): Promise<Response> {
  const principal = c.get("principal");
  const key = c.req.header(IDEMPOTENCY_HEADER) ?? "";
  const path = new URL(c.req.url).pathname;
  const hash = await requestHash(c.req.method, path, reqBody);
  const claim = await claimIdempotency(c.env.DB, { actorEmail: principal.email, key, route: `${c.req.method} ${path}`, requestHash: hash });
  if (claim.kind === "replay") return c.json(claim.body as object, claim.status as ContentfulStatusCode, { "Idempotent-Replayed": "true" });
  if (claim.kind === "in_progress") return apiError(c, 409, "idempotency_in_progress", "a request with this Idempotency-Key is in progress", { "Retry-After": "1" });
  if (claim.kind === "reuse") return apiError(c, 422, "idempotency_key_reuse", "this Idempotency-Key was used with a different request");

  const idem = { actorEmail: principal.email, key };
  let result: { status: number; body: unknown };
  try {
    result = await run({ actor: principal, requestId: c.get("requestId"), idem });
  } catch (err) {
    await releaseIdempotency(c.env.DB, idem.actorEmail, idem.key);
    throw err;
  }
  if (result.status >= 500) await releaseIdempotency(c.env.DB, idem.actorEmail, idem.key);
  else await completeIdempotency(c.env.DB, idem.actorEmail, idem.key, result.status, result.body);
  return c.json(result.body as object, result.status as ContentfulStatusCode);
}

export async function caseRef(db: D1Database, employeeId: string) {
  const r = await db.prepare("SELECT id, manager_id FROM employees WHERE id = ?").bind(employeeId).first<{ id: string; manager_id: string }>();
  return r ? { employeeId: r.id, managerId: r.manager_id } : null;
}
