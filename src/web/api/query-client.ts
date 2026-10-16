// The app's TanStack QueryClient. A 4xx answer is final (403, 404 and 409 do
// not change on a retry), so queries retry only network failures, unreadable
// answers and 5xx, at most twice. Mutations never retry on their own: a user
// action is retried by the user, with the same Idempotency-Key (action-keys.ts).
import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./client.ts";

export const MAX_QUERY_RETRIES = 2;

/** TanStack's retry predicate: failureCount is 0 when the first failure is judged. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status > 0 && error.status < 500 && error.code !== "non_json_response") return false;
  return failureCount < MAX_QUERY_RETRIES;
}

export function createQueryClient(opts: { retryDelay?: number } = {}): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        refetchOnWindowFocus: false,
        retry: shouldRetryQuery,
        ...(opts.retryDelay !== undefined ? { retryDelay: opts.retryDelay } : {}),
      },
      mutations: { retry: false },
    },
  });
}
