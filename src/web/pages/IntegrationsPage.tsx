// Integrations: health of the simulated systems over a time window, and the
// call log of one case (every attempt, outcome, latency and idempotency key).
import { useState } from "react";
import { useCaseIntegrations, useIntegrationHealth } from "../api/queries.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { IntegrationHealthTable } from "../components/IntegrationHealthTable.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";

const WINDOWS = ["1h", "24h", "7d", "all"] as const;

export function IntegrationsPage() {
  const [window, setWindow] = useState<(typeof WINDOWS)[number]>("24h");
  const [caseId, setCaseId] = useState("");
  const health = useIntegrationHealth(window);
  const log = useCaseIntegrations(caseId.trim().toUpperCase());
  const calls = (log.data?.pages ?? []).flatMap((p) => p.items);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Integrations</h1>
          <div className="sub">HR, IT and Facilities are simulated systems inside this Worker. Every call is logged and audited.</div>
        </div>
        <select aria-label="window" value={window} onChange={(e) => setWindow(e.target.value as (typeof WINDOWS)[number])}>
          {WINDOWS.map((w) => (
            <option key={w} value={w}>
              {w === "all" ? "all time" : `last ${w}`}
            </option>
          ))}
        </select>
      </div>
      <section className="card" aria-label="health">
        <h2>Health</h2>
        {health.data ? <IntegrationHealthTable health={health.data} /> : <p className="muted">Loading...</p>}
      </section>
      <section className="card" aria-label="call log">
        <h2>Call log</h2>
        <input aria-label="case id" placeholder="Case id, for example E042" value={caseId} onChange={(e) => setCaseId(e.target.value)} />
        {calls.length === 0 ? (
          <EmptyState>{/^E\d{3}$/i.test(caseId.trim()) ? "No calls for this case yet." : "Enter a case id to see its calls."}</EmptyState>
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
          <button type="button" onClick={() => void log.fetchNextPage()}>
            Load more
          </button>
        ) : null}
      </section>
    </>
  );
}
