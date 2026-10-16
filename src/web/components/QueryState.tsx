// Loading, error and refresh states of one query, so no page shows an empty
// table or a bare "Could not load" when a request fails. A 404 or 403 shows
// the page's own explanation; a network failure or 5xx shows what happened
// with a Try again button; a failed background refresh keeps the earlier data
// on screen with a warning.
import type { ReactNode } from "react";
import { ApiError } from "../api/client.ts";
import { describeError } from "../api/errors.ts";

export type QueryLike = { data: unknown; isError: boolean; error: unknown; isFetching?: boolean; refetch: () => unknown };

function retryable(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status === 0 || error.status >= 500 || error.code === "non_json_response";
}

export function QueryError({ error, what, notFound, forbidden, onRetry, busy }: { error: unknown; what: string; notFound?: ReactNode; forbidden?: ReactNode; onRetry: () => unknown; busy?: boolean }) {
  if (error instanceof ApiError && error.status === 404 && notFound) {
    return (
      <div className="card notice" role="alert">
        {notFound}
      </div>
    );
  }
  if (error instanceof ApiError && error.status === 403 && forbidden) {
    return (
      <div className="card notice" role="alert">
        {forbidden}
      </div>
    );
  }
  const d = describeError(error, { subject: what });
  return (
    <div className="card notice error" role="alert">
      <p style={{ margin: 0 }}>
        Could not load {what}. {d.message}
        {d.next && !retryable(error) ? ` ${d.next}` : ""}
      </p>
      {retryable(error) ? (
        <button type="button" onClick={() => void onRetry()} disabled={busy} style={{ marginTop: 8 }}>
          {busy ? "Trying again..." : "Try again"}
        </button>
      ) : null}
      {d.requestId ? <span className="request-id mono">Request id {d.requestId}</span> : null}
    </div>
  );
}

export function QueryState({
  query,
  what,
  notFound,
  forbidden,
  children,
}: {
  query: QueryLike;
  /** Names what loads, for "Loading the cases..." and "Could not load the cases." */
  what: string;
  notFound?: ReactNode;
  forbidden?: ReactNode;
  children: () => ReactNode;
}) {
  if (query.data === undefined) {
    if (query.isError) return <QueryError error={query.error} what={what} notFound={notFound} forbidden={forbidden} onRetry={query.refetch} busy={query.isFetching} />;
    return (
      <p className="muted" role="status">
        Loading {what}...
      </p>
    );
  }
  return (
    <>
      {query.isError ? (
        <p className="refresh-warning" role="status">
          Could not refresh; showing earlier data.{" "}
          <button type="button" onClick={() => void query.refetch()} disabled={query.isFetching}>
            Try again
          </button>
        </p>
      ) : null}
      {children()}
    </>
  );
}
