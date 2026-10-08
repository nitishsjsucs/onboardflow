// Step configurations derived from AppConfig (SPEC 8.3). Retry-After travels
// in the error message (retry-after-ms=NNN) because only the message is
// guaranteed to cross the step boundary; the dynamic delay honors it.
import type { AppConfig } from "../config.ts";
import { retryAfterFrom } from "../integrations/errors.ts";

export const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;

export function retryDelayMs(cfg: Pick<AppConfig, "retry">, attempt: number, message: string): number {
  const exponential = cfg.retry.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(Math.max(exponential, retryAfterFrom(message)), MAX_RETRY_DELAY_MS);
}

/** Integration steps: RETRY_LIMIT retries, exponential backoff, Retry-After aware. */
export function retryPolicy(cfg: AppConfig) {
  return {
    retries: {
      limit: cfg.retry.limit,
      backoff: "exponential" as const,
      delay: ({ ctx, error }: { ctx: { attempt: number }; error: Error }) => retryDelayMs(cfg, ctx.attempt, error?.message ?? ""),
    },
    timeout: "2 minutes" as const,
  };
}

/** Gate checks and bookkeeping steps (D1 only). */
export const CHECK_STEP = { retries: { limit: 3, delay: 200, backoff: "constant" as const }, timeout: "30 seconds" as const };
