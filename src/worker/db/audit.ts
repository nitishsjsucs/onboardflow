// Audit statement builders. Every audit row is written in the same DB.batch as
// the mutation it describes. Guarded forms (`INSERT ... SELECT ... WHERE [NOT]
// EXISTS`) commit the row only when the stamped mutation took effect (ADR 0008).
// Ids are deterministic (src/shared/ids.ts) and inserts use OR IGNORE, so a
// re-executed step or replayed request never writes a second row.
import type { ActorType, AuditAction } from "../../shared/domain.ts";

export type AuditInput = {
  id: string;
  occurredAt: string;
  actorType: ActorType;
  actorId: string;
  actorRole?: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  employeeId?: string | null;
  stageId?: string | null;
  runNo?: number | null;
  round?: number | null;
  requestId?: string | null;
  detail?: Record<string, unknown>;
};

/** A SQL predicate with its bind values, e.g. an EXISTS check on a mutation stamp. */
export type Condition = { sql: string; binds: unknown[] };

const COLUMNS =
  "id, occurred_at, actor_type, actor_id, actor_role, action, entity_type, entity_id, employee_id, stage_id, run_no, round, request_id, detail_json";

function values(a: AuditInput): unknown[] {
  return [
    a.id,
    a.occurredAt,
    a.actorType,
    a.actorId,
    a.actorRole ?? null,
    a.action,
    a.entityType,
    a.entityId,
    a.employeeId ?? null,
    a.stageId ?? null,
    a.runNo ?? null,
    a.round ?? null,
    a.requestId ?? null,
    JSON.stringify(a.detail ?? {}),
  ];
}

/** Unconditional audit insert. */
export function auditInsert(db: D1Database, a: AuditInput): D1PreparedStatement {
  return db
    .prepare(`INSERT OR IGNORE INTO audit_events (${COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(...values(a));
}

/** Audit insert that commits only when `when` holds at that point of the batch. */
export function auditInsertWhen(db: D1Database, a: AuditInput, when: Condition): D1PreparedStatement {
  return db
    .prepare(`INSERT OR IGNORE INTO audit_events (${COLUMNS}) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${when.sql}`)
    .bind(...values(a), ...when.binds);
}

/** `EXISTS (SELECT 1 FROM <table> WHERE <where> AND last_mutation_id = ?)` */
export function stamped(table: string, where: string, binds: unknown[], stamp: string): Condition {
  return {
    sql: `EXISTS (SELECT 1 FROM ${table} WHERE ${where} AND last_mutation_id = ?)`,
    binds: [...binds, stamp],
  };
}

/** Negation of `stamped`. */
export function notStamped(table: string, where: string, binds: unknown[], stamp: string): Condition {
  return {
    sql: `NOT EXISTS (SELECT 1 FROM ${table} WHERE ${where} AND last_mutation_id = ?)`,
    binds: [...binds, stamp],
  };
}
