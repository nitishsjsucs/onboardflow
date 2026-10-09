// Audit explorer (admin): the append-only audit log, newest first, filterable
// by action, actor and case.
import { useState } from "react";
import { AUDIT_ACTIONS } from "../../shared/domain.ts";
import { useAuditExplorer } from "../api/queries.ts";
import { AuditTimeline } from "../components/AuditTimeline.tsx";

export function AuditPage() {
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const q = useAuditExplorer({ action, actor: actor.trim(), employeeId: employeeId.trim().toUpperCase() });
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <div className="sub">Append-only. Every user, agent and workflow action, newest first.</div>
        </div>
        <div className="row">
          <select aria-label="action" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">Any action</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <input aria-label="actor" placeholder="Actor (email, agent or instance)" value={actor} onChange={(e) => setActor(e.target.value)} />
          <input aria-label="case" placeholder="Case id" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} />
        </div>
      </div>
      <section className="card">
        <AuditTimeline
          events={(q.data?.pages ?? []).flatMap((p) => p.items)}
          hasMore={!!q.hasNextPage}
          onMore={() => void q.fetchNextPage()}
          loadingMore={q.isFetchingNextPage}
        />
      </section>
    </>
  );
}
