// Async resource state machines of the simulated systems. Each GET poll
// advances a resource by one transition unless a `stall` fault is active.
import type { ResourceType, SystemId } from "../../shared/domain.ts";

export const LIFECYCLES: Partial<Record<ResourceType, readonly string[]>> = {
  it_device: ["ordered", "processing", "shipped", "delivered"],
  fac_badge: ["requested", "printed", "active"],
};

/** Status after one more poll. Document verification completes on the 2nd poll. */
export function nextStatus(type: ResourceType, status: string, pollsBefore: number): string {
  if (type === "hr_documents") return pollsBefore + 1 >= 2 ? "verified" : "pending";
  const life = LIFECYCLES[type];
  if (!life) return status;
  const i = life.indexOf(status);
  return i >= 0 && i < life.length - 1 ? (life[i + 1] as string) : status;
}

export function isPolledType(type: ResourceType): boolean {
  return type === "hr_documents" || type === "it_device" || type === "fac_badge";
}

export type SimResourceRow = {
  system: SystemId;
  id: string;
  resource_type: ResourceType;
  employee_ref: string;
  status: string;
  polls: number;
  data_json: string;
};

export function loadResource(db: D1Database, system: SystemId, id: string): Promise<SimResourceRow | null> {
  return db
    .prepare(
      "SELECT system, id, resource_type, employee_ref, status, polls, data_json FROM sim_resources WHERE system = ? AND id = ?",
    )
    .bind(system, id)
    .first<SimResourceRow>();
}

export function findByEmployee(
  db: D1Database,
  system: SystemId,
  type: ResourceType,
  employeeRef: string,
): Promise<SimResourceRow | null> {
  return db
    .prepare(
      `SELECT system, id, resource_type, employee_ref, status, polls, data_json FROM sim_resources
        WHERE system = ? AND resource_type = ? AND employee_ref = ? ORDER BY created_at DESC, id LIMIT 1`,
    )
    .bind(system, type, employeeRef)
    .first<SimResourceRow>();
}

export function newResourceId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function insertResource(
  db: D1Database,
  r: { system: SystemId; id: string; type: ResourceType; employeeRef: string; status: string; data: unknown; now: string },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO sim_resources (system, id, resource_type, employee_ref, status, polls, data_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    )
    .bind(r.system, r.id, r.type, r.employeeRef, r.status, JSON.stringify(r.data), r.now, r.now);
}

export function ledgerInsert(
  db: D1Database,
  e: { system: SystemId; operation: string; employeeRef: string; resourceId: string; key: string | null; now: string },
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO sim_side_effects (system, operation, employee_ref, resource_id, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(e.system, e.operation, e.employeeRef, e.resourceId, e.key, e.now);
}
