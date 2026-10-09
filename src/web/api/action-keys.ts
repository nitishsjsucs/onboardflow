// One Idempotency-Key per user action, shared by every page (SPEC 17: the
// client reuses the key when the same action is retried). An action is its
// name plus its input, so retrying the same click (same task, same reason)
// sends the same key and gets the stored answer instead of a second
// execution, while an edited request gets a new key. The key is kept only
// while the outcome is unknown: a network error, an unparsable answer, a 5xx
// (the server released the key, so a retry executes once) or 409
// idempotency_in_progress (the first request is still running). Any other
// answer is final, and the next click is a new action with a new key, so a
// 409 for a stage that was not blocked yet is not replayed forever.
import { ApiError, newIdempotencyKey } from "./client.ts";

/** True when a retry must reuse the key because the server's answer is not known to be final. */
export function outcomeUnknown(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true;
  return err.status >= 500 || (err.status === 409 && err.code === "idempotency_in_progress");
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    return `{${entries
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** The identity of a user action: its name and its input (any `key` field excluded). */
export function actionId(name: string, input: object): string {
  const { key: _key, ...rest } = input as Record<string, unknown>;
  return `${name}:${canonical(rest)}`;
}

export class ActionKeys {
  readonly #keys = new Map<string, string>();

  /** The key for this action: the pending one if an earlier attempt's outcome is unknown, else a new one. */
  keyFor(action: string): string {
    let key = this.#keys.get(action);
    if (!key) {
      key = newIdempotencyKey();
      this.#keys.set(action, key);
    }
    return key;
  }

  /** Called with the attempt's error (null on success): forgets the key once the answer is final. */
  settle(action: string, err: unknown): void {
    if (err === null || !outcomeUnknown(err)) this.#keys.delete(action);
  }

  get pending(): number {
    return this.#keys.size;
  }
}

/** The app-wide store (module scope, so a retry after navigating between pages still reuses the key). */
export const actionKeys = new ActionKeys();
