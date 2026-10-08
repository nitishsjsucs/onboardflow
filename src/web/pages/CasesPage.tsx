// Cases: filterable table. Managers see only their direct reports.
import { useState } from "react";
import { Link } from "react-router";
import { CASE_STATUSES } from "../../shared/domain.ts";
import { STAGES } from "../../shared/stages.ts";
import { useEmployees, useStartCase } from "../api/queries.ts";
import { can, useSession } from "../auth/session.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { label, StatusBadge } from "../components/StatusBadge.tsx";

export function CasesPage() {
  const { me } = useSession();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [stage, setStage] = useState("");
  const list = useEmployees({ q, status, stage });
  const start = useStartCase();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{me?.role === "manager" ? "My team" : "Cases"}</h1>
          <div className="sub">{list.data ? `${list.data.items.length}${list.data.nextCursor ? "+" : ""} employees` : " "}</div>
        </div>
        <div className="row">
          <input aria-label="search" placeholder="Search name, email or id" value={q} onChange={(e) => setQ(e.target.value)} />
          <select aria-label="status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any status</option>
            {CASE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
          <select aria-label="stage" value={stage} onChange={(e) => setStage(e.target.value)}>
            <option value="">Any stage</option>
            {STAGES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {list.data && list.data.items.length === 0 ? <EmptyState>No matching employees.</EmptyState> : null}
      <div className="card table-wrap">
        <table className="list">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Org unit</th>
              <th>Start</th>
              <th>Status</th>
              <th>Stage</th>
              <th>Blockers</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(list.data?.items ?? []).map((e) => (
              <tr key={e.id}>
                <td>
                  <Link to={`/cases/${e.id}`}>{e.name}</Link>
                  <div className="muted mono">{e.id}</div>
                </td>
                <td>
                  {e.orgUnit}
                  <div className="muted">{label(e.employmentType)}, {e.workMode}</div>
                </td>
                <td>{e.startDate}</td>
                <td>
                  <StatusBadge status={e.caseStatus} />
                </td>
                <td>{e.currentStage ? label(e.currentStage) : "none"}</td>
                <td>{e.openBlockers > 0 ? <span className="badge bad">{e.openBlockers}</span> : "0"}</td>
                <td>
                  {e.caseStatus === "not_started" && can.startCase(me) ? (
                    <button type="button" disabled={start.isPending} onClick={() => start.mutate({ employeeId: e.id })}>
                      Start
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {start.error ? <p className="error">{(start.error as Error).message}</p> : null}
    </>
  );
}
