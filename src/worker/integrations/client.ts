// IntegrationClient: the only way workflow steps talk to the (simulated)
// enterprise systems. Each call sends the Idempotency-Key, enforces
// INTEGRATION_TIMEOUT_MS with AbortSignal.timeout, classifies the response
// (SPEC 8.3 table), and writes one integration_calls row plus one
// integration.call audit row per attempt, in one batch, before returning or
// throwing. Calls go over HTTP through the loopback exports.default.fetch
// (ADR 0005) unless SIM_BASE_URL points elsewhere.
import { exports } from "cloudflare:workers";
import type { z } from "zod";
import type { IntegrationOutcome, SystemId } from "../../shared/domain.ts";
import { auditIds, integrationCallId } from "../../shared/ids.ts";
import { OPERATIONS, type OperationId } from "../../shared/stages.ts";
import type { AppConfig } from "../config.ts";
import { auditInsert } from "../db/audit.ts";
import type { Clock } from "../db/clock.ts";
import { ConflictError, fatalIntegrationError, RetryableIntegrationError } from "./errors.ts";

export type Fetcher = (req: Request) => Promise<Response>;

export type CallScope = {
  employeeId: string;
  instanceId: string;
  runNo: number;
  stepName: string;
  /** WorkflowStepContext.attempt (1-based) */
  attempt: number;
};

export type CallSpec<T> = {
  operation: OperationId;
  path: string;
  body?: unknown;
  idempotencyKey?: string;
  schema: z.ZodType<T>;
  /** Distinguishes several HTTP calls inside one step attempt (desk conflict alternates). */
  subAttempt?: number;
};

export type CallResult<T> = { data: T; status: number; replayed: boolean; latencyMs: number };

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function loopbackFetch(req: Request): Promise<Response> {
  return exports.default.fetch(req);
}

export class IntegrationClient {
  readonly #db: D1Database;
  readonly #config: AppConfig;
  readonly #clock: Clock;
  readonly #scope: CallScope;
  readonly #fetch: Fetcher;

  constructor(db: D1Database, config: AppConfig, clock: Clock, scope: CallScope, fetcher?: Fetcher) {
    this.#db = db;
    this.#config = config;
    this.#clock = clock;
    this.#scope = scope;
    this.#fetch = fetcher ?? (config.simBaseUrl === "http://localhost" ? loopbackFetch : (r) => fetch(r));
  }

  async call<T>(spec: CallSpec<T>): Promise<CallResult<T>> {
    const op = OPERATIONS[spec.operation];
    const url = `${this.#config.simBaseUrl}/sim/${op.system}${spec.path}`;
    const headers: Record<string, string> = { "X-Sim-Api-Key": this.#config.simApiKey, Accept: "application/json" };
    if (spec.idempotencyKey) headers["Idempotency-Key"] = spec.idempotencyKey;
    if (spec.body !== undefined) headers["Content-Type"] = "application/json";

    const started = Date.now();
    let res: Response | null = null;
    let networkError: unknown = null;
    try {
      res = await this.#fetch(
        new Request(url, {
          method: op.method,
          headers,
          ...(spec.body !== undefined ? { body: JSON.stringify(spec.body) } : {}),
          signal: AbortSignal.timeout(this.#config.integrationTimeoutMs),
        }),
      );
    } catch (err) {
      networkError = err;
    }

    let outcome: IntegrationOutcome;
    let error: Error | null = null;
    let retryAfterMs: number | null = null;
    let data: T | undefined;
    let text = "";
    if (!res) {
      const timedOut = networkError instanceof Error && (networkError.name === "TimeoutError" || /timed? ?out|abort/i.test(networkError.message));
      outcome = timedOut ? "timeout" : "retryable_error";
      error = new RetryableIntegrationError(outcome, spec.operation, null, timedOut ? `no response within ${this.#config.integrationTimeoutMs} ms` : String(networkError));
    } else {
      text = await res.text().catch(() => "");
      if (res.ok) {
        const parsed = spec.schema.safeParse(safeJson(text));
        if (parsed.success) {
          data = parsed.data;
          outcome = res.headers.get("Idempotent-Replayed") === "true" ? "replayed" : "ok";
        } else {
          outcome = "malformed";
          error = new RetryableIntegrationError("malformed", spec.operation, res.status, "response failed schema validation");
        }
      } else if (RETRYABLE_STATUS.has(res.status)) {
        outcome = "retryable_error";
        if (res.status === 429) retryAfterMs = parseRetryAfter(res.headers);
        error = new RetryableIntegrationError("retryable_error", spec.operation, res.status, errorCode(text), retryAfterMs);
      } else if (res.status === 409 && spec.operation === "facilities.assign-workspace") {
        outcome = "conflict";
        const pref = (spec.body as { preference?: string } | undefined)?.preference ?? "unknown";
        error = new ConflictError(spec.operation, pref, errorCode(text));
      } else {
        outcome = "fatal_error";
        error = fatalIntegrationError(spec.operation, res.status, errorField(text), errorCode(text));
      }
    }
    const latencyMs = Date.now() - started;
    await this.#log(spec, op.system, op.method, url, res?.status ?? null, outcome, retryAfterMs, latencyMs, error?.message ?? null);
    if (error) throw error;
    return { data: data as T, status: res!.status, replayed: outcome === "replayed", latencyMs };
  }

  async #log(
    spec: CallSpec<unknown>,
    system: SystemId,
    method: string,
    url: string,
    httpStatus: number | null,
    outcome: IntegrationOutcome,
    retryAfterMs: number | null,
    latencyMs: number,
    error: string | null,
  ): Promise<void> {
    const s = this.#scope;
    const step = spec.subAttempt && spec.subAttempt > 1 ? `${s.stepName}~${spec.subAttempt}` : s.stepName;
    const id = integrationCallId(s.instanceId, s.runNo, step, s.attempt);
    const now = this.#clock.nowIso();
    const path = new URL(url).pathname;
    await this.#db.batch([
      this.#db
        .prepare(
          `INSERT OR IGNORE INTO integration_calls (id, employee_id, workflow_instance_id, run_no, step_name, system, operation, method, path,
             idempotency_key, attempt, http_status, outcome, retry_after_ms, latency_ms, error, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(id, s.employeeId, s.instanceId, s.runNo, step, system, spec.operation, method, path, spec.idempotencyKey ?? null, s.attempt, httpStatus, outcome, retryAfterMs, latencyMs, error, now),
      auditInsert(this.#db, {
        id: auditIds.integration(id),
        occurredAt: now,
        actorType: "workflow",
        actorId: s.instanceId,
        action: "integration.call",
        entityType: "integration_call",
        entityId: id,
        employeeId: s.employeeId,
        runNo: s.runNo,
        detail: { operation: spec.operation, attempt: s.attempt, httpStatus, outcome, latencyMs },
      }),
    ]);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorCode(text: string): string {
  const j = safeJson(text) as { error?: { code?: string; message?: string } } | undefined;
  return j?.error ? `${j.error.code ?? "error"}: ${j.error.message ?? ""}`.trim() : text.slice(0, 200);
}

function errorField(text: string): string | null {
  const j = safeJson(text) as { error?: { field?: string } } | undefined;
  return j?.error?.field ?? null;
}

export function parseRetryAfter(h: Headers): number | null {
  const ms = h.get("retry-after-ms");
  if (ms && /^\d+$/.test(ms)) return Number(ms);
  const s = h.get("Retry-After");
  if (s && /^\d+$/.test(s)) return Number(s) * 1000;
  if (s) {
    const at = Date.parse(s);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }
  return null;
}
