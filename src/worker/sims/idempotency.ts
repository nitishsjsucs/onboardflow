// Idempotency for the simulated systems: request fingerprints, replay lookup,
// and recognising a lost race on the sim_idempotency primary key.
import type { SystemId } from "../../shared/domain.ts";

export const REPLAYED_HEADER = "Idempotent-Replayed";

/** JSON with object keys sorted recursively, so equal bodies hash equally. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(",")}}`;
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** sha256(method + path + canonical JSON body) */
export function fingerprint(method: string, path: string, body: unknown): Promise<string> {
  return sha256Hex(`${method.toUpperCase()} ${path}\n${canonicalJson(body)}`);
}

export type StoredResponse = { request_fingerprint: string; status_code: number; response_json: string };

export function lookupStored(db: D1Database, system: SystemId, key: string): Promise<StoredResponse | null> {
  return db
    .prepare(
      "SELECT request_fingerprint, status_code, response_json FROM sim_idempotency WHERE system = ? AND idempotency_key = ?",
    )
    .bind(system, key)
    .first<StoredResponse>();
}

export function isIdempotencyKeyConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed: sim_idempotency\./.test(msg);
}
