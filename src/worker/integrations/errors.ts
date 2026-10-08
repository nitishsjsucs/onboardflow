// Integration error classes and their string encodings. Only an error's
// message is guaranteed to cross a Workflow step boundary (a caught step error
// stringifies as "Error: NonRetryableError: <message>"), so classification
// reads tagged message prefixes, never instanceof:
//   retryable:<class> <op> http=<n> retry-after-ms=<n>: <detail>
//   fatal:<op> http=<n> field=<field>: <detail>
//   conflict:<op> preference=<p>: <detail>
//   stalled:<op> resource=<type> polls=<n>: <detail>
import { NonRetryableError } from "cloudflare:workflows";
import type { IntegrationOutcome, SystemId } from "../../shared/domain.ts";

export type FailureClass = "retryable" | "fatal" | "conflict" | "stalled";

export class RetryableIntegrationError extends Error {
  constructor(outcome: IntegrationOutcome, operation: string, httpStatus: number | null, detail: string, retryAfterMs?: number | null) {
    super(
      `retryable:${outcome} ${operation} http=${httpStatus ?? "none"}${retryAfterMs != null ? ` retry-after-ms=${retryAfterMs}` : ""}: ${detail}`,
    );
    this.name = "RetryableIntegrationError";
  }
}

export class ConflictError extends Error {
  constructor(operation: string, preference: string, detail: string) {
    super(`conflict:${operation} preference=${preference}: ${detail}`);
    this.name = "ConflictError";
  }
}

export class StalledError extends Error {
  constructor(operation: string, resource: string, polls: number) {
    super(`stalled:${operation} resource=${resource} polls=${polls}: resource did not reach its terminal status`);
    this.name = "StalledError";
  }
}

/** A genuine 4xx: retrying the same request cannot help, so skip the step's remaining retries. */
export function fatalIntegrationError(operation: string, httpStatus: number, field: string | null, detail: string): NonRetryableError {
  return new NonRetryableError(`fatal:${operation} http=${httpStatus}${field ? ` field=${field}` : ""}: ${detail}`);
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** The local engine aborts with "Aborting engine: ..." on restart, terminate, pause and delete. */
export function isEngineAbort(err: unknown): boolean {
  let m = errorMessage(err).trimStart();
  while (m.startsWith("Error: ")) m = m.slice(7);
  return m.startsWith("Aborting engine:");
}

/** Never swallow an engine abort: it must propagate so the engine can stop the run. */
export function rethrowIfEngineAbort(err: unknown): void {
  if (isEngineAbort(err)) throw err;
}

export type BlockedReason = {
  class: FailureClass | "unknown";
  outcome?: string;
  system?: SystemId;
  operation?: string;
  httpStatus?: number | null;
  field?: string;
  retryAfterMs?: number;
  message: string;
};

/** Parses a (possibly re-wrapped) integration error message into a blocked reason. */
export function classifyFailure(err: unknown): BlockedReason {
  const msg = errorMessage(err);
  const opOf = (op: string | undefined) => {
    const system = op?.split(".")[0];
    return system === "hr" || system === "it" || system === "facilities" ? { system: system as SystemId, operation: op } : op ? { operation: op } : {};
  };
  let m = /retryable:(\w+) (\S+) http=(\S+)(?: retry-after-ms=(\d+))?: ?(.*)$/s.exec(msg);
  if (m) {
    return {
      class: "retryable",
      outcome: m[1],
      ...opOf(m[2]),
      httpStatus: m[3] === "none" ? null : Number(m[3]),
      ...(m[4] ? { retryAfterMs: Number(m[4]) } : {}),
      message: m[5] ?? msg,
    };
  }
  m = /fatal:(\S+) http=(\d+)(?: field=(\S+))?: ?(.*)$/s.exec(msg);
  if (m) return { class: "fatal", ...opOf(m[1]), httpStatus: Number(m[2]), ...(m[3] ? { field: m[3] } : {}), message: m[4] ?? msg };
  m = /stalled:(\S+) resource=(\S+) polls=(\d+): ?(.*)$/s.exec(msg);
  if (m) return { class: "stalled", ...opOf(m[1]), message: m[4] ?? msg };
  m = /conflict:(\S+) preference=(\S+): ?(.*)$/s.exec(msg);
  if (m) return { class: "conflict", ...opOf(m[1]), message: m[3] ?? msg };
  return { class: "unknown", message: msg };
}

/** Retry-After carried in the message (only the message survives the step boundary). */
export function retryAfterFrom(message: string): number {
  const m = /retry-after-ms=(\d+)/.exec(message);
  return m ? Number(m[1]) : 0;
}
