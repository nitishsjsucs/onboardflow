// A People Ops sign-off as one compact row: who, when they start, the SLA,
// and Approve or Reject (with a required reason). Every closeout request is
// the same ("All stages before sign-off are complete" plus the start date),
// so the full card repeated that text 24 times in the demo; the row keeps
// what tells sign-offs apart. Decisions go through the same hook as the
// card (useApprovalDecision), so the outcome, focus and "Already decided"
// behave identically.
import { useId, useState } from "react";
import { Link } from "react-router";
import type { ApprovalView } from "../../shared/api.ts";
import { ActionButton } from "./ActionButton.tsx";
import { ActionMessage } from "./ActionMessage.tsx";
import { slaText, useApprovalDecision } from "./ApprovalCard.tsx";
import { countdownTo, daysUntil, formatDay, localToday } from "./dates.ts";
import { StatusBadge } from "./StatusBadge.tsx";
import { useFocusRequest } from "../hooks/useFocus.ts";

/** The start date a closeout request carries (approval-loop.ts), or null. */
export function requestStartDate(a: ApprovalView): string | null {
  return typeof a.request.startDate === "string" ? a.request.startDate : null;
}

export function ApprovalRow({ approval, onSettled, describedBy, today = localToday() }: { approval: ApprovalView; onSettled?: (a: ApprovalView) => void; describedBy?: string; today?: string }) {
  const { a, decide, outcome, decided, decidedElsewhere, onDecide } = useApprovalDecision(approval, onSettled);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const reasonId = useId();
  const opener = useFocusRequest<HTMLButtonElement>();
  const name = a.employeeName;
  const start = requestStartDate(a);
  const days = start ? daysUntil(start, today) : null;
  const open = a.status === "pending" && !decided;
  const overdue = Date.parse(a.dueAt) < Date.now();
  return (
    <li className="approval-row" id={`approval-${a.id}`} tabIndex={-1} aria-label={`Sign-off for ${name}`}>
      <div className="approval-row-main">
        <span>
          <Link to={`/cases/${a.employeeId}`}>{name}</Link> <span className="muted mono">{a.employeeId}</span>
        </span>
        {start ? (
          <span className="muted">
            {days !== null && days < 0 ? "started" : "starts"} {formatDay(start)}, {countdownTo(start, today)}
          </span>
        ) : null}
        {open ? <span className={`badge${overdue ? " bad" : ""}`}>{slaText(a.dueAt)}</span> : decidedElsewhere ? null : <StatusBadge status={a.status} />}
      </div>
      {open && !rejecting ? (
        <div className="item-actions">
          <ActionButton className="primary" aria-label={`Approve sign-off for ${name}`} aria-describedby={describedBy} busy={decide.pending} onClick={() => void onDecide({ decision: "approve" })}>
            Approve
          </ActionButton>
          <button type="button" ref={opener.ref} aria-label={`Reject: sign-off for ${name}`} aria-describedby={describedBy} disabled={decide.pending} onClick={() => setRejecting(true)}>
            Reject...
          </button>
        </div>
      ) : null}
      {open && rejecting ? (
        <form
          className="reject-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim()) void onDecide({ decision: "reject", reason: reason.trim() });
          }}
        >
          <label htmlFor={reasonId}>Why reject {name}&apos;s sign-off? (required)</label>
          <input id={reasonId} required value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          <div className="row">
            <ActionButton type="submit" className="danger" aria-label={`Reject sign-off for ${name}`} aria-describedby={describedBy} disabled={!reason.trim()} busy={decide.pending}>
              Reject sign-off
            </ActionButton>
            <button
              type="button"
              disabled={decide.pending}
              onClick={() => {
                setRejecting(false);
                opener.request();
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      {a.reason && !open ? <p className="muted small">Reason: {a.reason}</p> : null}
      <ActionMessage ref={outcome.ref} error={decide.error} success={decide.success} context={{ action: `decide the sign-off for ${name}`, subject: "this approval" }} />
    </li>
  );
}
