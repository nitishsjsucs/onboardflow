// Audit explorer (admin): the append-only audit log, newest first, filterable
// by action, actor and case. The filters live in the URL (?action=&actor=&case=),
// so reload, Back and a shared link show the same view; typed filters wait
// until typing stops.
import { useSearchParams } from "react-router";
import { AUDIT_ACTIONS, isOneOf } from "../../shared/domain.ts";
import { useAuditExplorer } from "../api/queries.ts";
import { AuditTimeline } from "../components/AuditTimeline.tsx";
import { QueryState } from "../components/QueryState.tsx";
import { useDebouncedValue } from "../hooks/useDebouncedValue.ts";
import { useDocumentTitle } from "../hooks/useDocumentTitle.ts";
import { SEARCH_DEBOUNCE_MS } from "./CasesPage.tsx";

export function AuditPage() {
  useDocumentTitle("Audit log");
  const [params, setParams] = useSearchParams();
  const actionParam = params.get("action");
  const action = isOneOf(AUDIT_ACTIONS, actionParam) ? actionParam : "";
  const actor = params.get("actor") ?? "";
  const employeeId = params.get("case") ?? "";
  /** Typing replaces the history entry; choosing an action adds one, so Back restores the previous filter. */
  const setFilter = (key: "action" | "actor" | "case", value: string, replace = false) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace });
  };
  const typedActor = useDebouncedValue(actor.trim(), SEARCH_DEBOUNCE_MS);
  const typedCase = useDebouncedValue(employeeId.trim().toUpperCase(), SEARCH_DEBOUNCE_MS);
  const q = useAuditExplorer({ action, actor: typedActor, employeeId: typedCase });
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <div className="sub">Append-only. Every user, agent and workflow action, newest first.</div>
        </div>
        <div className="row filters">
          <select aria-label="action" value={action} onChange={(e) => setFilter("action", e.target.value)}>
            <option value="">Any action</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <input aria-label="actor" placeholder="Actor (email, agent or instance)" value={actor} onChange={(e) => setFilter("actor", e.target.value, true)} />
          <input aria-label="case" placeholder="Case id" value={employeeId} onChange={(e) => setFilter("case", e.target.value, true)} />
        </div>
      </div>
      <section className="card">
        <QueryState query={q} what="the audit log">
          {() => (
            <AuditTimeline
              events={(q.data?.pages ?? []).flatMap((p) => p.items)}
              hasMore={!!q.hasNextPage}
              onMore={() => q.fetchNextPage()}
              loadingMore={q.isFetchingNextPage}
            />
          )}
        </QueryState>
      </section>
    </>
  );
}
