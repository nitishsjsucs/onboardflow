import type { IntegrationHealth } from "../../shared/agent-state.ts";

const NAMES: Record<string, string> = { hr: "HR", it: "IT", facilities: "Facilities" };

/** Per-system call statistics for the simulated systems. */
export function IntegrationHealthTable({ health }: { health: Record<string, IntegrationHealth> }) {
  return (
    <div className="table-wrap">
      <table className="list" aria-label="integration health">
        <thead>
          <tr>
            <th>System</th>
            <th>Calls</th>
            <th>OK</th>
            <th>Retried</th>
            <th>Replayed</th>
            <th>Success rate</th>
            <th>Last error</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(health).map(([sys, h]) => (
            <tr key={sys} data-testid={`health-${sys}`}>
              <td>
                {NAMES[sys] ?? sys} <span className="simulated">simulated</span>
              </td>
              <td>{h.calls}</td>
              <td>{h.ok}</td>
              <td>{h.retried}</td>
              <td>{h.replayed}</td>
              <td>{h.calls === 0 ? "n/a" : `${(((h.ok + h.replayed) / h.calls) * 100).toFixed(1)}%`}</td>
              <td>{h.lastErrorAt ? new Date(h.lastErrorAt).toLocaleString() : "none"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
