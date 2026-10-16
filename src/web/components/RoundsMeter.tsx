// The rounds readout next to a Retry: the sentence first (a Retry button
// points at it with aria-describedby), then one pip per allowed round, filled
// for used rounds in neutral ink, outlined for the rest, the final one outlined
// in --bad and labelled "last". The pips are decoration (aria-hidden).
//
// AttemptsPanel: "Show attempts" fetches the case's call log only when opened
// and shows the latest round's attempts of this stage, failures as a cross
// and the word, with a link to the full log.
import { useEffect, useId, useState } from "react";
import { Link } from "react-router";
import { useCaseIntegrations } from "../api/queries.ts";
import { QueryError } from "./QueryState.tsx";
import { attemptsSentence, isFailure, OUTCOME_WORDS, type RoundsReadout, stageAttempts } from "./rounds.ts";
import { StateIcon } from "./StateIcon.tsx";

export function RoundsMeter({ readout, id }: { readout: RoundsReadout; id: string }) {
  return (
    <div className="rounds">
      <span id={id} className="rounds-text">
        {readout.text}
      </span>
      <span className="pips" aria-hidden="true">
        {Array.from({ length: readout.max }, (_, i) => (
          <span key={i} className={`pip${i < readout.used ? " used" : ""}${i === readout.max - 1 ? " last" : ""}`} />
        ))}
        <span className="pip-label">last</span>
      </span>
    </div>
  );
}

export const ATTEMPT_PAGE_SIZE = 100;
export const MAX_ATTEMPT_PAGES = 5;

/** Show attempts (a disclosure): nothing is fetched until it is opened. */
export function AttemptsPanel({ employeeId, employeeName, stageId, stageName, maxRecoveryRounds }: { employeeId: string; employeeName: string; stageId: string; stageName: string; maxRecoveryRounds?: number | undefined }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const q = useCaseIntegrations(employeeId, { pageSize: ATTEMPT_PAGE_SIZE, enabled: open });
  const pages = q.data?.pages.length ?? 0;
  // the log is oldest first: follow it to the end, at most five pages (500 calls)
  useEffect(() => {
    if (open && q.hasNextPage && !q.isFetchingNextPage && !q.isError && pages < MAX_ATTEMPT_PAGES) void q.fetchNextPage();
  }, [open, q.hasNextPage, q.isFetchingNextPage, q.isError, pages]);
  const calls = (q.data?.pages ?? []).flatMap((p) => p.items);
  const truncated = pages >= MAX_ATTEMPT_PAGES && q.hasNextPage;
  const loading = q.data === undefined || (q.hasNextPage && pages < MAX_ATTEMPT_PAGES && !q.isError);
  const latest = loading ? null : stageAttempts(calls, stageId);
  return (
    <div className="attempts">
      <button type="button" aria-expanded={open} aria-controls={panelId} aria-label={`${open ? "Hide attempts" : "Show attempts"}: ${stageName} for ${employeeName}`} onClick={() => setOpen((v) => !v)}>
        {open ? "Hide attempts" : "Show attempts"}
      </button>
      <div id={panelId} hidden={!open} className="attempts-panel">
        {!open ? null : q.isError && q.data === undefined ? (
          <QueryError error={q.error} what="the attempts" onRetry={q.refetch} busy={q.isFetching} />
        ) : loading ? (
          <p className="muted" role="status">
            Loading the attempts...
          </p>
        ) : !latest ? (
          <p className="muted">No calls recorded for this stage.</p>
        ) : (
          <>
            <p className="attempts-sentence">{attemptsSentence(latest.round, latest.calls)}</p>
            <ol className="attempt-list" aria-label={`Round ${latest.round} attempts`}>
              {latest.calls.map((c, i) => (
                <li key={c.id} className={isFailure(c) ? "failed" : "ok"}>
                  <StateIcon glyph={isFailure(c) ? "cross" : "check"} /> {i + 1}: {OUTCOME_WORDS[c.outcome]}
                  {c.httpStatus ? <span className="muted"> {c.httpStatus}</span> : null}
                </li>
              ))}
            </ol>
          </>
        )}
        {open ? (
          <p className="muted small" style={{ margin: "6px 0 0" }}>
            {truncated ? "Showing the first 500 calls. " : ""}
            {maxRecoveryRounds ? `A case also allows at most ${maxRecoveryRounds} recovery rounds per run across all stages. ` : ""}
            <Link to={`/integrations?case=${encodeURIComponent(employeeId)}&window=all`}>Full call log</Link>
          </p>
        ) : null}
      </div>
    </div>
  );
}
