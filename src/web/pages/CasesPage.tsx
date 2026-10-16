// Cases: filterable table. Managers see only their direct reports. Filters
// live in the URL (?q=&status=&stage=), so reload, back and links from the
// dashboard keep them; the search waits until typing stops. Load more follows
// the API's cursor, 100 employees at a time.
import { Link, useSearchParams } from "react-router";
import type { EmployeeSummary, MeDto } from "../../shared/api.ts";
import { CASE_STATUSES, isOneOf } from "../../shared/domain.ts";
import { STAGE_IDS, STAGES } from "../../shared/stages.ts";
import { useItemAction } from "../api/item-action.ts";
import { useEmployees, useStartCase } from "../api/queries.ts";
import { can, useSession } from "../auth/session.tsx";
import { ActionMessage } from "../components/ActionMessage.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { QueryState } from "../components/QueryState.tsx";
import { label, StatusBadge } from "../components/StatusBadge.tsx";
import { useDebouncedValue } from "../hooks/useDebouncedValue.ts";
import { useDocumentTitle } from "../hooks/useDocumentTitle.ts";

export const SEARCH_DEBOUNCE_MS = 250;

const COLUMNS = ["Employee", "Org unit", "Start", "Status", "Stage", "Blockers", "Action"] as const;

export function CasesPage() {
  const { me } = useSession();
  useDocumentTitle(me?.role === "manager" ? "My team" : "Cases");
  const [params, setParams] = useSearchParams();
  const qParam = params.get("q") ?? "";
  const statusParam = params.get("status");
  const stageParam = params.get("stage");
  const status = isOneOf(CASE_STATUSES, statusParam) ? statusParam : "";
  const stage = isOneOf(STAGE_IDS, stageParam) ? stageParam : "";
  const q = useDebouncedValue(qParam.trim(), SEARCH_DEBOUNCE_MS);
  const list = useEmployees({ q, status, stage });
  const items = (list.data?.pages ?? []).flatMap((p) => p.items);

  /** Typing replaces the history entry; choosing a filter adds one, so Back restores the previous filter. */
  const setFilter = (key: "q" | "status" | "stage", value: string, replace = false) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace });
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{me?.role === "manager" ? "My team" : "Cases"}</h1>
          <div className="sub" aria-live="polite">
            {list.data ? (list.hasNextPage ? `Showing ${items.length}; more available` : `${items.length} employee${items.length === 1 ? "" : "s"}`) : " "}
          </div>
        </div>
        <div className="row filters">
          <input aria-label="search" type="search" placeholder="Search name, email or id" value={qParam} onChange={(e) => setFilter("q", e.target.value, true)} />
          <select aria-label="status" value={status} onChange={(e) => setFilter("status", e.target.value)}>
            <option value="">Any status</option>
            {CASE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
          <select aria-label="stage" value={stage} onChange={(e) => setFilter("stage", e.target.value)}>
            <option value="">Any stage</option>
            {STAGES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <QueryState query={list} what="the cases">
        {() =>
          items.length === 0 ? (
            <EmptyState>No matching employees.</EmptyState>
          ) : (
            <>
              <div className="card table-wrap">
                <table className="list stack">
                  <thead>
                    <tr>
                      {COLUMNS.map((c) => (
                        <th key={c}>{c === "Action" ? <span className="visually-hidden">{c}</span> : c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((e) => (
                      <CaseRow key={e.id} e={e} me={me} />
                    ))}
                  </tbody>
                </table>
              </div>
              {list.hasNextPage ? (
                <button type="button" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
                  {list.isFetchingNextPage ? "Loading..." : "Load more"}
                </button>
              ) : null}
            </>
          )
        }
      </QueryState>
    </>
  );
}

function CaseRow({ e, me }: { e: EmployeeSummary; me: MeDto | null }) {
  const start = useItemAction(useStartCase(), () => `Onboarding started for ${e.name}`);
  const startable = e.caseStatus === "not_started" && can.startCase(me);
  return (
    <tr>
      <td data-label={COLUMNS[0]}>
        <Link to={`/cases/${e.id}`}>{e.name}</Link>
        <div className="muted mono">{e.id}</div>
      </td>
      <td data-label={COLUMNS[1]}>
        {e.orgUnit}
        <div className="muted">
          {label(e.employmentType)}, {e.workMode}
        </div>
      </td>
      <td data-label={COLUMNS[2]}>{e.startDate}</td>
      <td data-label={COLUMNS[3]}>
        <StatusBadge status={e.caseStatus} />
      </td>
      <td data-label={COLUMNS[4]}>{e.currentStage ? label(e.currentStage) : "none"}</td>
      <td data-label={COLUMNS[5]}>{e.openBlockers > 0 ? <span className="badge bad">{e.openBlockers}</span> : "0"}</td>
      <td data-label={COLUMNS[6]} className={startable || start.success || start.error ? "" : "empty-cell"}>
        {startable ? (
          <button type="button" aria-label={`Start onboarding for ${e.name}`} disabled={start.pending} onClick={() => void start.run({ employeeId: e.id })}>
            Start
          </button>
        ) : null}
        <ActionMessage error={start.error} success={start.success} context={{ action: `start onboarding for ${e.name}`, subject: `employee ${e.id}` }} />
      </td>
    </tr>
  );
}
