// Integrations: health of the simulated systems over a time window, and the
// call log of one case (every attempt, outcome, latency and idempotency key).
// The window and the case id live in the URL (?window=&case=), so reload,
// Back and a shared link show the same view.
import { useSearchParams } from "react-router";
import { isOneOf } from "../../shared/domain.ts";
import { useCaseIntegrations, useIntegrationHealth } from "../api/queries.ts";
import { ActionButton } from "../components/ActionButton.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { IntegrationHealthTable } from "../components/IntegrationHealthTable.tsx";
import { QueryError, QueryState } from "../components/QueryState.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { useDocumentTitle } from "../hooks/useDocumentTitle.ts";

const WINDOWS = ["1h", "24h", "7d", "all"] as const;
const DEFAULT_WINDOW = "24h";

export function IntegrationsPage() {
  useDocumentTitle("Integrations");
  const [params, setParams] = useSearchParams();
  const windowParam = params.get("window");
  const window = isOneOf(WINDOWS, windowParam) ? windowParam : DEFAULT_WINDOW;
  const caseId = params.get("case") ?? "";
  /** Typing the case id replaces the history entry; choosing a window adds one. */
  const setFilter = (key: "window" | "case", value: string, replace = false) => {
    const next = new URLSearchParams(params);
    if (value && !(key === "window" && value === DEFAULT_WINDOW)) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace });
  };
  const health = useIntegrationHealth(window);
  const wanted = caseId.trim().toUpperCase();
  const log = useCaseIntegrations(wanted);
  const calls = (log.data?.pages ?? []).flatMap((p) => p.items);
  const valid = /^E\d{3}$/.test(wanted);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Integrations</h1>
          <div className="sub">HR, IT and Facilities are simulated systems inside this Worker. Every call is logged and audited.</div>
        </div>
        <select aria-label="window" value={window} onChange={(e) => setFilter("window", e.target.value)}>
          {WINDOWS.map((w) => (
            <option key={w} value={w}>
              {w === "all" ? "all time" : `last ${w}`}
            </option>
          ))}
        </select>
      </div>
      <section className="card" aria-label="health">
        <h2>Health</h2>
        <QueryState query={health} what="the integration health">
          {() => <IntegrationHealthTable health={health.data!} />}
        </QueryState>
      </section>
      <section className="card" aria-label="call log">
        <h2>Call log</h2>
        <input aria-label="case id" placeholder="Case id, for example E042" value={caseId} onChange={(e) => setFilter("case", e.target.value, true)} />
        {valid && log.isError && log.data === undefined ? (
          <QueryError error={log.error} what={`the calls of ${wanted}`} notFound={<p style={{ margin: 0 }}>No case {wanted}.</p>} onRetry={log.refetch} busy={log.isFetching} />
        ) : valid && log.data === undefined ? (
          <p className="muted" role="status">
            Loading the calls of {wanted}...
          </p>
        ) : calls.length === 0 ? (
          <EmptyState>{valid ? "No calls for this case yet." : "Enter a case id, for example E042, to see its calls."}</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="list">
              <thead>
                <tr>
                  <th>Step</th>
                  <th>Attempt</th>
                  <th>HTTP</th>
                  <th>Outcome</th>
                  <th>Latency</th>
                  <th>Idempotency-Key</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((c) => (
                  <tr key={c.id} data-testid="call">
                    <td className="mono">
                      run {c.runNo}, {c.stepName}
                    </td>
                    <td>{c.attempt}</td>
                    <td>{c.httpStatus ?? "none"}</td>
                    <td>
                      <StatusBadge status={c.outcome === "ok" || c.outcome === "replayed" ? (c.outcome === "ok" ? "complete" : "verified") : "blocked"} /> {c.outcome}
                    </td>
                    <td>{c.latencyMs} ms</td>
                    <td className="mono">{c.idempotencyKey ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {log.hasNextPage ? (
          <ActionButton onClick={() => void log.fetchNextPage()} busy={log.isFetchingNextPage}>
            {log.isFetchingNextPage ? "Loading..." : "Load more"}
          </ActionButton>
        ) : null}
      </section>
    </>
  );
}
