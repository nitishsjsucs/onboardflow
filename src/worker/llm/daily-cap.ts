// Daily cap on LLM calls (LLM_DAILY_DRAFT_LIMIT). Workers AI's free allocation
// is 10,000 neurons per UTC day for the whole account, shared with other apps,
// and on the Workers Free plan calls beyond it fail. Each call first claims one
// unit of the day's budget in D1 (an atomic upsert guarded by the limit); once
// the day is used up the call is not made, and the drafter falls back to its
// template like after any provider error.
import type { CompleteJsonRequest, CompleteJsonResponse, LlmProvider } from "./provider.ts";

export class DailyLimitReached extends Error {
  constructor(limit: number) {
    super(`daily LLM draft limit reached (${limit} per UTC day)`);
    this.name = "DailyLimitReached";
  }
}

/** UTC calendar day of an instant, YYYY-MM-DD (the day Workers AI's free allocation resets on). */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Claims one call from the day's budget; false when the limit is reached (nothing is written then). */
export async function claimDailyDraft(db: D1Database, limit: number, at: Date): Promise<boolean> {
  if (limit <= 0) return false;
  const row = await db
    .prepare(
      `INSERT INTO llm_daily_usage (day, drafts) VALUES (?, 1)
       ON CONFLICT(day) DO UPDATE SET drafts = drafts + 1 WHERE drafts < ?
       RETURNING drafts`,
    )
    .bind(utcDay(at), limit)
    .first<{ drafts: number }>();
  return row !== null;
}

export class DailyCappedProvider implements LlmProvider {
  readonly id: string;
  readonly #inner: LlmProvider;
  readonly #db: D1Database;
  readonly #limit: number;
  readonly #now: () => Date;

  constructor(inner: LlmProvider, db: D1Database, limit: number, now: () => Date = () => new Date()) {
    this.#inner = inner;
    this.#db = db;
    this.#limit = limit;
    this.#now = now;
    this.id = inner.id;
  }

  async completeJson(req: CompleteJsonRequest): Promise<CompleteJsonResponse> {
    if (!(await claimDailyDraft(this.#db, this.#limit, this.#now()))) throw new DailyLimitReached(this.#limit);
    return this.#inner.completeJson(req);
  }
}
