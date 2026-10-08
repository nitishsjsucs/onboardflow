// API idempotency store (SPEC Section 9). Every /api mutation needs an
// Idempotency-Key. The first request claims the key with a `pending` row; the
// final response is stored in the same batch as the mutation (guarded.ts), so
// a client retry after any later failure replays instead of conflicting. A
// handler that fails before its batch commits (5xx) releases the claim so a
// retry re-executes; every command converges, so that is safe.
import { canonicalJson, sha256Hex } from "../sims/idempotency.ts";

export const IN_PROGRESS_TTL_MS = 60_000;

export type ClaimResult =
  | { kind: "claimed" }
  | { kind: "replay"; status: number; body: unknown }
  | { kind: "in_progress" }
  | { kind: "reuse" };

type Row = { request_hash: string; state: "pending" | "complete"; status: number | null; response_json: string | null; created_at: string };

export function requestHash(method: string, route: string, body: unknown): Promise<string> {
  return sha256Hex(`${method.toUpperCase()} ${route}\n${canonicalJson(body ?? null)}`);
}

export async function claimIdempotency(
  db: D1Database,
  c: { actorEmail: string; key: string; route: string; requestHash: string; nowMs?: number },
): Promise<ClaimResult> {
  const nowMs = c.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const ins = await db
    .prepare(
      `INSERT INTO api_idempotency (actor_email, key, route, request_hash, state, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?) ON CONFLICT (actor_email, key) DO NOTHING`,
    )
    .bind(c.actorEmail, c.key, c.route, c.requestHash, now)
    .run();
  if (ins.meta.changes === 1) return { kind: "claimed" };

  const row = await db
    .prepare("SELECT request_hash, state, status, response_json, created_at FROM api_idempotency WHERE actor_email = ? AND key = ?")
    .bind(c.actorEmail, c.key)
    .first<Row>();
  if (!row) return claimIdempotency(db, c); // released between our insert and read: try again
  if (row.request_hash !== c.requestHash) return { kind: "reuse" };
  if (row.state === "complete") return { kind: "replay", status: row.status ?? 200, body: JSON.parse(row.response_json ?? "null") };
  if (nowMs - Date.parse(row.created_at) < IN_PROGRESS_TTL_MS) return { kind: "in_progress" };
  // Abandoned claim: take it over with a guarded UPDATE so only one taker wins.
  const took = await db
    .prepare("UPDATE api_idempotency SET created_at = ? WHERE actor_email = ? AND key = ? AND state = 'pending' AND created_at = ?")
    .bind(now, c.actorEmail, c.key, row.created_at)
    .run();
  return took.meta.changes === 1 ? { kind: "claimed" } : { kind: "in_progress" };
}

/** Releases a pending claim (the handler failed before committing). A completed row is kept. */
export async function releaseIdempotency(db: D1Database, actorEmail: string, key: string): Promise<void> {
  await db.prepare("DELETE FROM api_idempotency WHERE actor_email = ? AND key = ? AND state = 'pending'").bind(actorEmail, key).run();
}

/** Stores a response for a route whose handler did not store one in its own batch. No-op if already complete. */
export async function completeIdempotency(db: D1Database, actorEmail: string, key: string, status: number, body: unknown): Promise<void> {
  await db
    .prepare("UPDATE api_idempotency SET state = 'complete', status = ?, response_json = ? WHERE actor_email = ? AND key = ? AND state = 'pending'")
    .bind(status, JSON.stringify(body), actorEmail, key)
    .run();
}
