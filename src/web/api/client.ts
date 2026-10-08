// Typed fetch wrapper for the OnboardFlow API. Every mutation carries
// X-OnboardFlow: 1 and an Idempotency-Key (one per user action, reused when
// that action is retried); the browser sends the Access (or dev) cookie.
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

export async function apiFetch<T>(path: string, o: RequestOptions = {}): Promise<T> {
  const method = o.method ?? (o.body !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") {
    headers["X-OnboardFlow"] = "1";
    headers["Idempotency-Key"] = o.idempotencyKey ?? newIdempotencyKey();
  }
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; requestId?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? "http_error", err?.message ?? `HTTP ${res.status}`, err?.requestId ?? res.headers.get("X-Request-Id"));
  }
  return data as T;
}
