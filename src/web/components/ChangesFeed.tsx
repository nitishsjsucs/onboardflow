// "What changed": the latest case events as plain sentences, newest first. It
// replaces the raw recent-activity list (action codes, employee ids, actor
// ids, mostly integration calls and provisioning polls) on the dashboard, the
// admin's home page, and shows a live demo's actions as they land.
import { useId, useState } from "react";
import { Link } from "react-router";
import type { ChangeItem } from "../../shared/api.ts";
import type { FailureReason } from "../../shared/domain.ts";
import { STAGE_BY_ID } from "../../shared/stages.ts";
import { capitalize } from "./actor-text.ts";
import { KIND_NAMES, OPERATION_TEXT, readableMessage, relativeTime, SYSTEM_NAMES } from "./blocker-text.ts";
import { formatInstant } from "./dates.ts";
import { EmptyState } from "./EmptyState.tsx";

export const SHOWN_AT_FIRST = 8;

const FAILURE_WORDS: Record<FailureReason, string> = {
  terminated: "terminated by an admin",
  approval_rejected_final: "the request was rejected in its last round",
  recovery_rounds_exhausted: "the stage ran out of recovery rounds",
  wait_budget_exhausted: "it waited longer than the workflow allows",
  workflow_error: "a workflow error",
};

const checkpointName = (c: string | undefined) => (c === "closeout" ? "People Ops sign-off" : "Manager approval");

/** Why a stage blocked: "IT (simulated) could not create the account", or what a simulated system rejected. */
function blockedCause(d: ChangeItem["detail"]): string {
  const system = d.system ? SYSTEM_NAMES[d.system] : "A simulated system";
  const status = d.httpStatus;
  const rejected = status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
  if (rejected) return `${system} (simulated) rejected the request${d.message ? `: ${readableMessage(d.message)}` : ""}`;
  return `${system} (simulated) could not ${(d.operation && OPERATION_TEXT[d.operation]) || "complete a step"}`;
}

/** The sentence around the employee's name: `${lead} ${name}${tail}`. */
export function changeSentence(item: ChangeItem): { lead: string; tail: string } {
  const d = item.detail;
  const stage = item.stageId ? STAGE_BY_ID[item.stageId].name : null;
  switch (item.action) {
    case "case.started":
      return { lead: "Onboarding started for", tail: "" };
    case "case.completed":
      return { lead: "Onboarding complete for", tail: "" };
    case "case.failed":
      return { lead: "Onboarding failed for", tail: d.failureReason ? `: ${FAILURE_WORDS[d.failureReason]}` : "" };
    case "stage.blocked":
      return { lead: `${stage ?? "A stage"} blocked for`, tail: `: ${blockedCause(d)}` };
    case "stage.retry_requested":
      return { lead: `Retry requested for ${stage ?? "a stage"} for`, tail: item.round ? `: round ${item.round}` : "" };
    case "blocker.opened":
      if (d.kind === "employee_task_overdue") return { lead: "Checklist tasks overdue for", tail: "" };
      if (d.kind === "approval_rejected") return { lead: `${checkpointName(d.checkpoint)} sent back to People Ops for`, tail: ": revise and resubmit" };
      return { lead: `${checkpointName(d.checkpoint)} overdue for`, tail: "" };
    case "blocker.auto_resolved":
      return { lead: `${d.kind ? KIND_NAMES[d.kind] : "Blocker"} cleared for`, tail: stage ? ` (${stage})` : "" };
    case "approval.approved":
      return { lead: `${checkpointName(d.checkpoint)} approved for`, tail: d.onBehalfOf ? ": decided by an admin on behalf" : "" };
    case "approval.rejected":
      return { lead: `${checkpointName(d.checkpoint)} rejected for`, tail: d.onBehalfOf ? ": decided by an admin on behalf" : "" };
    case "approval.resubmitted":
      return { lead: `${checkpointName(d.checkpoint)} resubmitted for`, tail: item.round ? `: round ${item.round}` : "" };
  }
}

/** The whole sentence as text. */
export function changeText(item: ChangeItem): string {
  const s = changeSentence(item);
  return `${capitalize(s.lead)} ${item.employeeName}${s.tail}`;
}

function Change({ item, now }: { item: ChangeItem; now: number }) {
  const s = changeSentence(item);
  return (
    <li>
      <time dateTime={item.occurredAt} className="muted" title={new Date(item.occurredAt).toLocaleString()}>
        {relativeTime(item.occurredAt, now)}, {formatInstant(item.occurredAt)}
      </time>
      <span>
        {capitalize(s.lead)} <Link to={`/cases/${item.employeeId}`}>{item.employeeName}</Link>
        {s.tail}
      </span>
    </li>
  );
}

/** The feed's list; the page owns loading and errors. */
export function ChangesFeed({ items, stale = false, now = Date.now() }: { items: ChangeItem[]; stale?: boolean; now?: number }) {
  const [all, setAll] = useState(false);
  const listId = useId();
  if (items.length === 0) return <EmptyState>No changes yet.</EmptyState>;
  const shown = all ? items : items.slice(0, SHOWN_AT_FIRST);
  return (
    <div className={stale ? "stale" : undefined}>
      <ol className="timeline changes" id={listId} aria-label="latest changes, newest first">
        {shown.map((i) => (
          <Change key={i.seq} item={i} now={now} />
        ))}
      </ol>
      {items.length > SHOWN_AT_FIRST ? (
        <button type="button" aria-expanded={all} aria-controls={listId} onClick={() => setAll((v) => !v)} style={{ marginTop: 8 }}>
          {all ? "Show fewer" : `Show more (${items.length - SHOWN_AT_FIRST})`}
        </button>
      ) : null}
    </div>
  );
}
