// Helpers for driving the simulated systems directly in tests.
import { env, exports } from "cloudflare:workers";

export type SimCall = { method?: "GET" | "POST"; body?: unknown; key?: string | null; apiKey?: string | null; signal?: AbortSignal };

export async function sim(path: string, o: SimCall = {}): Promise<Response> {
  const method = o.method ?? (o.body !== undefined ? "POST" : "GET");
  const headers = new Headers({ "Content-Type": "application/json" });
  if (o.apiKey !== null) headers.set("X-Sim-Api-Key", o.apiKey ?? env.SIM_API_KEY);
  if (o.key) headers.set("Idempotency-Key", o.key);
  return exports.default.fetch(
    new Request(`http://localhost/sim${path}`, {
      method,
      headers,
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
    }),
  );
}

export async function simJson<T = Record<string, unknown>>(path: string, o: SimCall = {}): Promise<{ status: number; body: T; replayed: boolean }> {
  const res = await sim(path, o);
  return { status: res.status, body: (await res.json()) as T, replayed: res.headers.get("Idempotent-Replayed") === "true" };
}

export async function ledger(filter: { system?: string; operation?: string; employeeRef?: string } = {}) {
  const where: string[] = [];
  const binds: string[] = [];
  for (const [col, v] of [
    ["system", filter.system],
    ["operation", filter.operation],
    ["employee_ref", filter.employeeRef],
  ] as const) {
    if (v !== undefined) {
      where.push(`${col} = ?`);
      binds.push(v);
    }
  }
  const sql = `SELECT system, operation, employee_ref, resource_id, idempotency_key FROM sim_side_effects${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY seq`;
  return (await env.DB.prepare(sql).bind(...binds).all<{ system: string; operation: string; employee_ref: string; resource_id: string; idempotency_key: string | null }>()).results;
}

export function workerBody(employeeRef: string, over: Record<string, unknown> = {}) {
  return {
    employeeRef,
    legalName: `Test ${employeeRef}`,
    email: `${employeeRef.toLowerCase()}@onboardflow.test`,
    startDate: "2026-11-02",
    costCenter: "CC-1100",
    orgUnit: "Engineering",
    employmentType: "full_time",
    ...over,
  };
}

/** Creates an HR worker and an IT account for `employeeRef`; returns their ids. */
export async function workerAndAccount(employeeRef: string, employmentType = "full_time") {
  const w = await simJson<{ id: string }>("/hr/v1/workers", { body: workerBody(employeeRef, { employmentType }), key: `${employeeRef}:hr.create-worker` });
  const a = await simJson<{ id: string }>("/it/v1/accounts", {
    body: { employeeRef, upn: `${employeeRef.toLowerCase()}@corp.test`, displayName: employeeRef },
    key: `${employeeRef}:it.create-account`,
  });
  return { workerId: w.body.id, accountId: a.body.id };
}
