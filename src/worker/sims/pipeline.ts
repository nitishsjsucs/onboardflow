// The fixed request pipeline every simulated system runs (SPEC Section 9.1).
// The order decides what a retry sees:
//   1 auth, 2 Idempotency-Key, 3 pre-execution faults, 4 replay,
//   5 genuine validation, 6 atomic execute, 7 post-execution fault.
// Step 6 is one DB.batch holding the sim_idempotency row (its primary key is
// the lock), the resource change and the side-effect ledger row, so a request
// cancelled mid-flight committed all three rows or none, and a concurrent
// request with the same key that loses the primary key race replays the
// winner's stored response.
import type { Context } from "hono";
import type { z } from "zod";
import type { ResourceType, SystemId } from "../../shared/domain.ts";
import type { AppConfig } from "../config.ts";
import type { AppEnv } from "../http.ts";
import { fingerprint, isIdempotencyKeyConflict, lookupStored, REPLAYED_HEADER, type StoredResponse } from "./idempotency.ts";
import { isPolledType, ledgerInsert, loadResource, nextStatus, type SimResourceRow } from "./resources.ts";

export const SIM_KEY_HEADER = "X-Sim-Api-Key";

export type SimCtx = {
  db: D1Database;
  config: AppConfig;
  system: SystemId;
  operation: string;
  params: Record<string, string>;
  now: string;
  path: string;
};

export type SimReply = { status: number; body: unknown; headers?: Record<string, string> };

export type Executed = {
  status: number;
  body: Record<string, unknown>;
  resourceId: string;
  employeeRef: string;
  statements: D1PreparedStatement[];
};

export type PostOp<B> = {
  method: "POST";
  system: SystemId;
  operation: string;
  path: string;
  schema: z.ZodType<B>;
  /** Employee the call concerns; used to match fault plans and to write the ledger. */
  employeeRef(ctx: SimCtx, body: B): Promise<string | null>;
  /** Genuine validation (404, 409, 422). Never stored, so a fixed request succeeds with the same key. */
  validate(ctx: SimCtx, body: B): Promise<SimReply | null>;
  execute(ctx: SimCtx, body: B): Promise<Executed>;
};

export type GetOp = {
  method: "GET";
  system: SystemId;
  operation: string;
  path: string;
  resourceTypes: readonly ResourceType[];
  respond(ctx: SimCtx, row: SimResourceRow): Promise<SimReply> | SimReply;
};

export type AnyOp = PostOp<any> | GetOp;

/** Fault hooks (SPEC 9.1 steps 3 and 7, and `stall` for polling). */
export type FaultHooks = {
  pre(ctx: SimCtx, employeeRef: string | null): Promise<SimReply | null>;
  post(ctx: SimCtx, employeeRef: string | null): Promise<SimReply | null>;
  stalled(ctx: SimCtx, employeeRef: string | null): Promise<boolean>;
};

export const NO_FAULTS: FaultHooks = {
  pre: async () => null,
  post: async () => null,
  stalled: async () => false,
};

export function simError(status: number, code: string, message: string, extra: Record<string, unknown> = {}): SimReply {
  return { status, body: { error: { code, message, ...extra } } };
}

function reply(c: Context<AppEnv>, r: SimReply): Response {
  return new Response(JSON.stringify(r.body), {
    status: r.status,
    headers: { "Content-Type": "application/json", ...(r.headers ?? {}) },
  });
}

async function replayOrReuse(stored: StoredResponse, fp: string): Promise<SimReply> {
  if (stored.request_fingerprint !== fp) {
    return simError(422, "idempotency_key_reuse", "Idempotency-Key was used with a different request");
  }
  return { status: stored.status_code, body: JSON.parse(stored.response_json), headers: { [REPLAYED_HEADER]: "true" } };
}

function ctxFor(c: Context<AppEnv>, op: AnyOp): SimCtx {
  return {
    db: c.env.DB,
    config: c.get("config"),
    system: op.system,
    operation: op.operation,
    params: c.req.param() as Record<string, string>,
    now: new Date().toISOString(),
    path: new URL(c.req.url).pathname,
  };
}

/**
 * Compares a presented secret with the expected one in constant time: both are hashed to 32 bytes
 * first, so neither the content nor the length of the expected key leaks through timing.
 */
export async function secretMatches(presented: string | undefined | null, expected: string): Promise<boolean> {
  if (typeof presented !== "string" || presented.length === 0 || expected.length === 0) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(presented)), crypto.subtle.digest("SHA-256", enc.encode(expected))]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function authorized(c: Context<AppEnv>): Promise<boolean> {
  return secretMatches(c.req.header(SIM_KEY_HEADER), c.get("config").simApiKey);
}

export async function runPost<B>(c: Context<AppEnv>, op: PostOp<B>, faults: FaultHooks): Promise<Response> {
  // 1. auth
  if (!(await authorized(c))) return reply(c, simError(401, "unauthorized", `${SIM_KEY_HEADER} missing or wrong`));
  const ctx = ctxFor(c, op);
  const keysOn = ctx.config.idempotencyKeys;

  // 2. key
  const key = keysOn ? (c.req.header("Idempotency-Key") ?? null) : null;
  if (keysOn && !key) return reply(c, simError(400, "idempotency_key_required", "Idempotency-Key header required"));

  const raw = await c.req.json().catch(() => undefined);
  const parsed = op.schema.safeParse(raw);
  if (!parsed.success) return reply(c, simError(400, "invalid_request", parsed.error.issues.map((i) => i.message).join("; ")));
  const body = parsed.data;
  const employeeRef = await op.employeeRef(ctx, body);

  // 3. pre-execution faults: in front of the application, fire whether or not the key is stored
  const pre = await faults.pre(ctx, employeeRef);
  if (pre) return reply(c, pre);

  // 4. replay
  const fp = await fingerprint("POST", ctx.path, raw);
  if (key) {
    const stored = await lookupStored(ctx.db, op.system, key);
    if (stored) return reply(c, await replayOrReuse(stored, fp));
  }

  // 5. genuine validation (never stored)
  const invalid = await op.validate(ctx, body);
  if (invalid) return reply(c, invalid);

  // 6. atomic execute
  const ex = await op.execute(ctx, body);
  const statements: D1PreparedStatement[] = [];
  if (key) {
    statements.push(
      ctx.db
        .prepare(
          `INSERT INTO sim_idempotency (system, idempotency_key, request_fingerprint, status_code, response_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(op.system, key, fp, ex.status, JSON.stringify(ex.body), ctx.now),
    );
  }
  statements.push(...ex.statements);
  statements.push(
    ledgerInsert(ctx.db, {
      system: op.system,
      operation: op.operation,
      employeeRef: ex.employeeRef,
      resourceId: ex.resourceId,
      key,
      now: ctx.now,
    }),
  );
  try {
    await ctx.db.batch(statements);
  } catch (err) {
    if (key && isIdempotencyKeyConflict(err)) {
      // A concurrent request with the same key committed first: replay its response.
      const stored = await lookupStored(ctx.db, op.system, key);
      if (stored) return reply(c, await replayOrReuse(stored, fp));
    }
    throw err;
  }

  // 7. post-execution fault (lost_response): only reachable on first execution, after the commit
  const post = await faults.post(ctx, employeeRef ?? ex.employeeRef);
  if (post) return reply(c, post);

  return reply(c, { status: ex.status, body: ex.body });
}

export async function runGet(c: Context<AppEnv>, op: GetOp, faults: FaultHooks): Promise<Response> {
  if (!(await authorized(c))) return reply(c, simError(401, "unauthorized", `${SIM_KEY_HEADER} missing or wrong`));
  const ctx = ctxFor(c, op);
  let row = await loadResource(ctx.db, op.system, ctx.params.id ?? "");
  if (!row || !op.resourceTypes.includes(row.resource_type)) return reply(c, simError(404, "not_found", "unknown resource"));

  const pre = await faults.pre(ctx, row.employee_ref);
  if (pre) return reply(c, pre);

  if (isPolledType(row.resource_type) && !(await faults.stalled(ctx, row.employee_ref))) {
    const next = nextStatus(row.resource_type, row.status, row.polls);
    const updated = await ctx.db
      .prepare(
        `UPDATE sim_resources SET status = ?, polls = polls + 1, updated_at = ?
          WHERE system = ? AND id = ? AND polls = ? RETURNING system, id, resource_type, employee_ref, status, polls, data_json`,
      )
      .bind(next, ctx.now, op.system, row.id, row.polls)
      .first<SimResourceRow>();
    row = updated ?? (await loadResource(ctx.db, op.system, row.id)) ?? row;
  }
  return reply(c, await op.respond(ctx, row));
}
