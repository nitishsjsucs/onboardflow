// Guarded mutations (ADR 0008, SPEC 7.1). A state change that can lose a race
// is one `UPDATE ... WHERE <guard>` that stamps last_mutation_id with a
// per-request (or per-step) stamp. Everything that must only exist when the
// change took effect (success audit, follow-on rows, the stored API response)
// sits in the same DB.batch behind `WHERE EXISTS (<row carries the stamp>)`;
// the conflict audit and conflict response sit behind `NOT EXISTS`. A D1
// batch is one transaction, so nothing interleaves between the UPDATE and the
// checks, and a request that lost the race can never write a success audit.
import type { Condition } from "./audit.ts";

export type StoredReply = { status: number; body: unknown };

export type IdempotencyTarget = {
  actorEmail: string;
  key: string;
  ok: StoredReply;
  conflict: StoredReply;
};

export type GuardedSpec = {
  db: D1Database;
  /** The guarded UPDATE; it must set last_mutation_id to the stamp. Its meta.changes decides `applied`. */
  mutation: D1PreparedStatement;
  /** EXISTS predicate: the target row now carries this request's stamp. */
  applied: Condition;
  /** Statements that commit only if the mutation applied; build them with the given condition. */
  onApplied?: (when: Condition) => D1PreparedStatement[];
  /** Statements that commit only if it did not (conflict audit). */
  onConflict?: (when: Condition) => D1PreparedStatement[];
  /** Store the matching API response in the same transaction (SPEC 9). */
  idempotency?: IdempotencyTarget;
  /** Unconditional statements appended to the batch. */
  extra?: D1PreparedStatement[];
};

export function negate(c: Condition): Condition {
  return { sql: `NOT ${c.sql}`, binds: c.binds };
}

export function completeIdempotencyWhen(db: D1Database, t: { actorEmail: string; key: string }, reply: StoredReply, when: Condition): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE api_idempotency SET state = 'complete', status = ?, response_json = ?
        WHERE actor_email = ? AND key = ? AND state = 'pending' AND ${when.sql}`,
    )
    .bind(reply.status, JSON.stringify(reply.body), t.actorEmail, t.key, ...when.binds);
}

export async function runGuarded(spec: GuardedSpec): Promise<{ applied: boolean; results: D1Result[] }> {
  const { db } = spec;
  const notApplied = negate(spec.applied);
  const statements: D1PreparedStatement[] = [
    spec.mutation,
    ...(spec.onApplied?.(spec.applied) ?? []),
    ...(spec.onConflict?.(notApplied) ?? []),
  ];
  if (spec.idempotency) {
    const t = spec.idempotency;
    statements.push(completeIdempotencyWhen(db, t, t.ok, spec.applied));
    statements.push(completeIdempotencyWhen(db, t, t.conflict, notApplied));
  }
  statements.push(...(spec.extra ?? []));
  const results = await db.batch(statements);
  return { applied: (results[0]?.meta.changes ?? 0) > 0, results };
}

/**
 * Replaces a response this request already stored, for the one command whose final body is known only
 * after its batch (a restart that fell back to a new workflow revision). Guarded on the stored body,
 * so it never overwrites another response.
 */
export async function replaceStoredResponse(db: D1Database, t: { actorEmail: string; key: string }, from: StoredReply, to: StoredReply): Promise<boolean> {
  const r = await db
    .prepare("UPDATE api_idempotency SET status = ?, response_json = ? WHERE actor_email = ? AND key = ? AND state = 'complete' AND status = ? AND response_json = ?")
    .bind(to.status, JSON.stringify(to.body), t.actorEmail, t.key, from.status, JSON.stringify(from.body))
    .run();
  return r.meta.changes === 1;
}
