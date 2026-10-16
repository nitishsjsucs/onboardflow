// Department queue: one item per open blocker, with its follow-up task, a
// plain title, a link to the case, the stage's current state and the next
// action for its kind. Coordinators see their own department (the API forces
// it); admins can pick one. Filters live in the URL. The list refreshes when
// the ops hub publishes a new version, without polling.
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { BlockerView, MeDto, TaskView } from "../../shared/api.ts";
import { BLOCKER_KINDS, type BlockerKind, isOneOf } from "../../shared/domain.ts";
import { DEPARTMENTS, type Department } from "../../shared/roles.ts";
import { STAGE_BY_ID } from "../../shared/stages.ts";
import { useItemAction } from "../api/item-action.ts";
import { keys, useCompleteTask, useOpenBlockers, useOpenFollowups, useResolveBlocker, useRetryStage } from "../api/queries.ts";
import { can, useSession } from "../auth/session.tsx";
import { ActionMessage } from "../components/ActionMessage.tsx";
import { blockerDetail, blockerTitle, DEPARTMENT_NAMES, FIELD_LABELS, isFixableField, KIND_NAMES, queueOrder, relativeTime, stageState } from "../components/blocker-text.ts";
import { DataIssueFix } from "../components/DataIssueFix.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { QueryState } from "../components/QueryState.tsx";
import { TaskList } from "../components/TaskList.tsx";
import { useDocumentTitle } from "../hooks/useDocumentTitle.ts";
import { useHubLive } from "../live/useHubLive.ts";

export function approvalAnchor(approvalId: string): string {
  return `/approvals#approval-${encodeURIComponent(approvalId)}`;
}

/** The DOM id of a queue item, so another item can move focus to it. */
export function queueItemId(blockerId: string): string {
  return `queue-item-${blockerId}`;
}

const stageKey = (b: Pick<BlockerView, "employeeId" | "stageId">) => `${b.employeeId}:${b.stageId}`;

/**
 * An open data issue on the same stage as this outage or stall: the agents leave an outage blocker open
 * when the retry then hits a rejected value, so the stage is blocked on that value, and a Retry from the
 * outage item would spend a recovery round on it. `shown`: the data issue is in the list on screen.
 */
export type PendingFix = { issue: BlockerView; shown: boolean };

function PendingFixNote({ b, fix }: { b: BlockerView; fix: PendingFix }) {
  const field = isFixableField(fix.issue.detail.field) ? FIELD_LABELS[fix.issue.detail.field] : "rejected value";
  return (
    <>
      <span className="muted">Blocked on the {field} now: fix it, then retry from that item.</span>
      {fix.shown ? (
        <button
          type="button"
          aria-label={`Go to the ${field} fix for ${b.employeeName}`}
          onClick={() => {
            const item = document.getElementById(queueItemId(fix.issue.id));
            item?.scrollIntoView?.({ block: "center" });
            item?.querySelector<HTMLElement>(".title")?.focus();
          }}
        >
          Go to the {field} fix
        </button>
      ) : (
        <Link className="button-link" to={`/cases/${b.employeeId}`} aria-label={`Fix it on the case page for ${b.employeeName}`}>
          Fix it on the case page
        </Link>
      )}
    </>
  );
}

function FollowUpLine({ task, owner, employeeName }: { task: TaskView; owner: string; employeeName: string }) {
  const { me } = useSession();
  const hintId = useId();
  const done = useItemAction(useCompleteTask(), () => `Follow-up done: ${task.title}`);
  return (
    <div className="followup-line">
      <span>
        <span className="muted">Follow-up:</span> {task.title}
      </span>
      {can.workDepartment(me, owner) && !done.success ? (
        <span className="row">
          <button type="button" aria-label={`Mark follow-up done for ${employeeName}: ${task.title}`} aria-describedby={hintId} disabled={done.pending} onClick={() => void done.run({ taskId: task.id })}>
            Mark follow-up done
          </button>
          <span id={hintId} className="muted hint">
            Marks your follow-up task done; it does not unblock the stage.
          </span>
        </span>
      ) : null}
      <ActionMessage error={done.error} success={done.success} context={{ action: "mark the follow-up done", subject: "this follow-up" }} />
    </div>
  );
}

function ResolveForm({ b, title, onCancel }: { b: BlockerView; title: string; onCancel: () => void }) {
  const [reason, setReason] = useState("");
  const inputId = useId();
  const warnId = useId();
  const resolve = useItemAction(useResolveBlocker(), () => `Resolved: ${title} for ${b.employeeName}`);
  return (
    <form
      className="resolve-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim()) void resolve.run({ blockerId: b.id, resolution: reason.trim() });
      }}
    >
      <label htmlFor={inputId}>Reason for resolving</label>
      <input id={inputId} required aria-describedby={warnId} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      <p id={warnId} className="hint warn-text">
        This closes the blocker only. If the condition still holds, the agents open it again.
      </p>
      <div className="row">
        <button type="submit" disabled={!reason.trim() || resolve.pending}>
          Resolve blocker
        </button>
        <button type="button" onClick={onCancel} disabled={resolve.pending}>
          Cancel
        </button>
      </div>
      <ActionMessage error={resolve.error} success={resolve.success} context={{ action: "resolve this blocker", subject: "this blocker" }} />
    </form>
  );
}

function KindActions({ b, me, stage, pendingFix }: { b: BlockerView; me: MeDto | null; stage: string; pendingFix: PendingFix | undefined }) {
  const retry = useItemAction(useRetryStage(), (r) => `Retry requested for ${stage}: round ${r.round} running`);
  const d = b.detail;
  const approvalId = typeof d.approvalId === "string" ? d.approvalId : null;
  switch (b.kind) {
    case "integration_outage":
    case "provisioning_stalled": {
      if (!can.retry(me, b.ownerDepartment) || (b.stageStatus !== null && b.stageStatus !== "blocked" && b.stageStatus !== "active")) return null;
      if (pendingFix) return <PendingFixNote b={b} fix={pendingFix} />;
      const running = b.stageStatus === "active";
      // the accessible name starts with the visible label (WCAG 2.5.3), then names the subject
      const text = running ? "Retry running" : "Retry stage";
      return (
        <>
          <button type="button" className="primary" aria-label={`${text}: ${stage} for ${b.employeeName}`} disabled={retry.pending || running} onClick={() => void retry.run({ employeeId: b.employeeId, stageId: b.stageId })}>
            {text}
          </button>
          <ActionMessage error={retry.error} success={retry.success} context={{ action: `retry ${stage}`, subject: stage }} />
        </>
      );
    }
    case "approval_rejected":
      return approvalId && can.resubmit(me) ? (
        <Link className="button-link primary" to={approvalAnchor(approvalId)} aria-label={`Resubmit in Approvals for ${b.employeeName}`}>
          Resubmit in Approvals
        </Link>
      ) : null;
    case "approval_overdue":
      if (d.checkpoint === "closeout") {
        return approvalId ? (
          <Link className="button-link" to={approvalAnchor(approvalId)} aria-label={`Decide in Approvals: sign-off for ${b.employeeName}`}>
            Decide in Approvals
          </Link>
        ) : null;
      }
      return (
        <>
          <span className="muted">Waiting on the hiring manager</span>
          {me?.role === "admin" && approvalId ? (
            <Link className="button-link" to={approvalAnchor(approvalId)} aria-label={`Decide on behalf of the manager for ${b.employeeName}`}>
              Decide on behalf
            </Link>
          ) : null}
        </>
      );
    default:
      return null;
  }
}

function QueueItem({ b, followUp, me, pendingFix }: { b: BlockerView; followUp: TaskView | undefined; me: MeDto | null; pendingFix: PendingFix | undefined }) {
  const [resolving, setResolving] = useState(false);
  const titleId = useId();
  const stage = STAGE_BY_ID[b.stageId].name;
  const title = blockerTitle(b);
  const detail = blockerDetail(b);
  const state = stageState(b);
  const canResolve = b.kind !== "approval_rejected" && can.workDepartment(me, b.ownerDepartment);
  return (
    <li className="queue-item" id={queueItemId(b.id)} data-testid={`blocker-${b.kind}`} aria-labelledby={titleId}>
      <div className="item-main">
        <div className="title" id={titleId} tabIndex={-1}>
          <span className={`badge ${b.severity === "high" ? "bad" : b.severity === "medium" ? "warn" : ""}`}>{b.severity}</span> {title}
        </div>
        <div>
          <Link to={`/cases/${b.employeeId}`}>{b.employeeName}</Link> <span className="muted mono">{b.employeeId}</span>, {stage}
          {state ? <span className="stage-state">: {state}</span> : null}
        </div>
        {detail ? <div className="muted">{detail}</div> : null}
        <div className="muted small">
          {DEPARTMENT_NAMES[b.ownerDepartment]},{" "}
          <time dateTime={b.detectedAt} title={new Date(b.detectedAt).toLocaleString()}>
            detected {relativeTime(b.detectedAt)}
          </time>
        </div>
      </div>
      <div className="item-actions">
        <KindActions b={b} me={me} stage={stage} pendingFix={pendingFix} />
        {canResolve && !resolving ? (
          <button type="button" aria-label={`Resolve: ${title}, ${b.employeeName}`} onClick={() => setResolving(true)}>
            Resolve...
          </button>
        ) : null}
      </div>
      {b.kind === "data_issue" ? (
        <DataIssueFix me={me} employeeId={b.employeeId} employeeName={b.employeeName} stageId={b.stageId} owner={b.ownerDepartment} detail={b.detail} retryRunning={b.stageStatus === "active"} />
      ) : null}
      {resolving ? <ResolveForm b={b} title={title} onCancel={() => setResolving(false)} /> : null}
      {followUp ? <FollowUpLine task={followUp} owner={b.ownerDepartment} employeeName={b.employeeName} /> : null}
    </li>
  );
}

export function QueuePage() {
  useDocumentTitle("Queue");
  const { me } = useSession();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const kindParam = params.get("kind");
  const kind: BlockerKind | null = isOneOf(BLOCKER_KINDS, kindParam) ? kindParam : null;
  const deptParam = params.get("department");
  const department: Department | null = me?.role === "admin" && isOneOf(DEPARTMENTS, deptParam) ? deptParam : null;

  const all = useOpenBlockers({ department });
  const filtered = useOpenBlockers({ kind, department }, kind !== null);
  const list = kind ? filtered : all;
  const followups = useOpenFollowups(department);
  // the hub publishes a new version whenever a case changes: refetch the queue's lists then, no polling
  useHubLive({
    onVersion: () => {
      void qc.invalidateQueries({ queryKey: keys.blockers });
      void qc.invalidateQueries({ queryKey: keys.followups });
    },
  });

  const setFilter = (key: "kind" | "department", value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };

  const allItems = (all.data?.pages ?? []).flatMap((p) => p.items);
  const counts = new Map<string, number>();
  for (const b of allItems) counts.set(b.kind, (counts.get(b.kind) ?? 0) + 1);
  const items = [...(list.data?.pages ?? []).flatMap((p) => p.items)].sort(queueOrder);
  const tasks = (followups.data?.pages ?? []).flatMap((p) => p.items);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const attached = new Set(allItems.map((b) => b.followUpTaskId).filter((x): x is string => !!x));
  const orphans = tasks.filter((t) => !attached.has(t.id));
  // open data issues per stage, from everything loaded (a kind filter may hide them from the list)
  const shownIds = new Set(items.map((b) => b.id));
  const dataIssues = new Map<string, BlockerView>();
  for (const b of [...allItems, ...items]) if (b.kind === "data_issue") dataIssues.set(stageKey(b), b);
  const pendingFixFor = (b: BlockerView): PendingFix | undefined => {
    if (b.kind !== "integration_outage" && b.kind !== "provisioning_stalled") return undefined;
    const issue = dataIssues.get(stageKey(b));
    return issue ? { issue, shown: shownIds.has(issue.id) } : undefined;
  };
  const scope = me?.role === "coordinator" && me.department ? DEPARTMENT_NAMES[me.department] : department ? DEPARTMENT_NAMES[department] : "all departments";

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Queue</h1>
          <div className="sub">
            Open blockers for {scope}, each with its follow-up. Blockers come from rules; the follow-up text may be drafted by the configured provider.
          </div>
        </div>
        {me?.role === "admin" ? (
          <label className="row">
            <span>Department</span>
            <select value={department ?? ""} onChange={(e) => setFilter("department", e.target.value || null)}>
              <option value="">All departments</option>
              {DEPARTMENTS.map((d) => (
                <option key={d} value={d}>
                  {DEPARTMENT_NAMES[d]}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <div className="chips" role="group" aria-label="Filter by kind">
        <button type="button" className="chip" aria-pressed={kind === null} onClick={() => setFilter("kind", null)}>
          All <span className="count">{allItems.length}</span>
        </button>
        {BLOCKER_KINDS.filter((k) => (counts.get(k) ?? 0) > 0 || k === kind).map((k) => (
          <button key={k} type="button" className="chip" aria-pressed={kind === k} onClick={() => setFilter("kind", k)}>
            {KIND_NAMES[k]} <span className="count">{counts.get(k) ?? 0}</span>
          </button>
        ))}
        {all.hasNextPage ? <span className="muted small">Counts cover the blockers loaded so far.</span> : null}
      </div>
      <section className="card" aria-label="open blockers">
        <h2>Open blockers</h2>
        <QueryState query={list} what="the open blockers">
          {() =>
            items.length === 0 ? (
              <EmptyState>
                {kind ? (
                  <>
                    No open {KIND_NAMES[kind].toLowerCase()} blockers.{" "}
                    <button type="button" onClick={() => setFilter("kind", null)}>
                      Show all kinds
                    </button>
                  </>
                ) : (
                  `No open blockers for ${scope}.`
                )}
              </EmptyState>
            ) : (
              <>
                <ul className="tasks queue">
                  {items.map((b) => (
                    <QueueItem key={b.id} b={b} me={me} followUp={b.followUpTaskId ? byId.get(b.followUpTaskId) : undefined} pendingFix={pendingFixFor(b)} />
                  ))}
                </ul>
                {list.hasNextPage || followups.hasNextPage ? (
                  <button
                    type="button"
                    style={{ marginTop: 12 }}
                    disabled={list.isFetchingNextPage || followups.isFetchingNextPage}
                    onClick={() => {
                      if (list.hasNextPage) void list.fetchNextPage();
                      if (followups.hasNextPage) void followups.fetchNextPage();
                    }}
                  >
                    {list.isFetchingNextPage ? "Loading..." : `Showing ${items.length}; load more`}
                  </button>
                ) : null}
              </>
            )
          }
        </QueryState>
      </section>
      {kind === null ? (
        <section className="card" aria-label="other follow-ups">
          <h2>Other follow-ups</h2>
          <p className="muted small" style={{ marginTop: -8 }}>
            Follow-up tasks whose blocker is no longer open.
          </p>
          <QueryState query={followups} what="the follow-ups">
            {() => (orphans.length === 0 ? <EmptyState>None.</EmptyState> : <TaskList tasks={orphans} completable doneLabel="Mark follow-up done" />)}
          </QueryState>
        </section>
      ) : null}
    </>
  );
}
