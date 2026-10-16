// Typed fetch wrapper for the OnboardFlow API. Every mutation carries
// X-OnboardFlow: 1 and an Idempotency-Key (one per user action, reused when
// that action is retried); the browser sends the Access (or dev) cookie.
//
// Every failure is an ApiError, so pages can describe it (errors.ts):
// - a fetch that never got an answer (offline, DNS, a cross-origin redirect
//   from an expired Access session) is ApiError(0, "network");
// - an answer whose body is not JSON (a proxy's HTML 502, a garbled 200) is
//   ApiError(status, "non_json_response"), even for a 2xx, because the
//   outcome of a mutation is then unknown (action-keys.ts keeps its key);
// - an AbortError is rethrown unchanged, so query cancellation still works.
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  constructor(status: number, code: string, message: string, requestId: string | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** Reuse the same key when retrying the same user action. */
  idempotencyKey?: string;
  signal?: AbortSignal;
};

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function isAbortError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";
}

function networkError(e: unknown): ApiError {
  return new ApiError(0, "network", e instanceof Error ? e.message : String(e), null);
}

export async function apiFetch<T>(path: string, o: RequestOptions = {}): Promise<T> {
  const method = o.method ?? (o.body !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") {
    headers["X-OnboardFlow"] = "1";
    headers["Idempotency-Key"] = o.idempotencyKey ?? newIdempotencyKey();
  }
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  let text: string;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
    });
    text = await res.text();
  } catch (e) {
    if (isAbortError(e)) throw e;
    throw networkError(e);
  }
  const headerRequestId = res.headers.get("X-Request-Id");
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      throw new ApiError(res.status, "non_json_response", `HTTP ${res.status}: the response was not JSON`, headerRequestId);
    }
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; requestId?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? "http_error", err?.message ?? `HTTP ${res.status}`, err?.requestId ?? headerRequestId);
  }
  return data as T;
}
