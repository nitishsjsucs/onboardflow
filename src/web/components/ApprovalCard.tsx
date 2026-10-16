// One approval checkpoint: what was requested, the SLA, the round history,
// and the decision (or, for People Ops, the resubmission of a rejected
// request). Each card sends its own decision with its own pending state and
// messages. A privileged-access request needs an explicit choice before
// Approve: a manager who did not notice a checkbox used to decline it silently.
import { useId, useState } from "react";
import { Link } from "react-router";
import type { ApprovalView, MeDto } from "../../shared/api.ts";
import { ApiError } from "../api/client.ts";
import { useItemAction } from "../api/item-action.ts";
import { useDecide, useResubmit } from "../api/queries.ts";
import { useFocusRequest } from "../hooks/useFocus.ts";
import { ActionButton } from "./ActionButton.tsx";
import { ActionMessage } from "./ActionMessage.tsx";
import { label, StatusBadge } from "./StatusBadge.tsx";

/** "Due in 5 h", "Due in 3 days" (from 48 h), "Overdue by 5 days". */
export function slaText(dueAt: string, now = Date.now()): string {
  const ms = Date.parse(dueAt) - now;
  const h = Math.abs(ms) / 3_600_000;
  const amount = h >= 48 ? `${Math.round(h / 24)} days` : h < 1 ? "less than 1 h" : `${Math.round(h)} h`;
  return ms >= 0 ? `Due in ${amount}` : `Overdue by ${amount}`;
}

/** A date-only value (YYYY-MM-DD) in the local format, without the UTC shift new Date() would add. */
export function formatDate(v: unknown): string {
  const s = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString();
  const t = Date.parse(s);
  return /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(t) ? new Date(t).toLocaleDateString() : s;
}

const REQUEST_FIELDS: Record<string, { label: string; format?: (v: unknown) => string }> = {
  equipmentProfile: { label: "Equipment profile", format: (v) => label(String(v)) },
  licenseBundle: { label: "License bundle" },
  needsPrivilegedAccess: { label: "Privileged access", format: (v) => (v === true ? "Requested" : "Not requested") },
  workMode: { label: "Work mode", format: (v) => label(String(v)) },
  site: { label: "Site" },
  startDate: { label: "Start date", format: formatDate },
  summary: { label: "Summary" },
};

function requestRows(request: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(request).map(([k, v]) => {
    const known = REQUEST_FIELDS[k];
    if (known) return [known.label, known.format ? known.format(v) : String(v)];
    const name = k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
    return [name[0]!.toUpperCase() + name.slice(1), formatDate(v)];
  });
}

const isCode = (e: unknown, code: string) => e instanceof ApiError && e.code === code;

export type ApprovalCardProps = {
  approval: ApprovalView;
  me: MeDto | null;
  canDecide: boolean;
  canResubmit: boolean;
  /** Called once this card's request is settled (decided, already decided, or resubmitted), so the page keeps it on screen. */
  onSettled?: (a: ApprovalView) => void;
};

export function ApprovalCard({ approval: a, me, canDecide, canResubmit, onSettled }: ApprovalCardProps) {
  const [reason, setReason] = useState("");
  const [privileged, setPrivileged] = useState<boolean | null>(null);
  const [note, setNote] = useState("");
  const ids = { reason: useId(), note: useId(), privHint: useId() };
  const nextStep = a.checkpoint === "manager_approval" ? "IT provisioning starts next." : "Onboarding finishes once HR (simulated) activates the worker.";
  const decide = useItemAction(useDecide(), (_r, v) => (v.decision === "approve" ? `Approved. ${nextStep}` : "Rejected. People Ops can revise and resubmit it."));
  const resubmit = useItemAction(useResubmit(), (r) => `Resubmitted: round ${r.round} sent for approval`);
  // a decision removes the buttons that had focus: the card's outcome takes it instead
  const decideOutcome = useFocusRequest<HTMLDivElement>();
  const resubmitOutcome = useFocusRequest<HTMLDivElement>();
  const busy = decide.pending || resubmit.pending;
  const who = `${label(a.checkpoint)} for ${a.employeeName}`;
  const needsPriv = a.request.needsPrivilegedAccess === true && a.checkpoint === "manager_approval";
  const decided = decide.success !== null || isCode(decide.error, "approval_not_pending");
  const resubmitted = resubmit.success !== null || isCode(resubmit.error, "not_revision_requested");

  async function onDecide(d: { decision: "approve" | "reject"; reason?: string; privilegedAccessApproved?: boolean }) {
    await decide.run({ approvalId: a.id, ...d });
    onSettled?.(a);
    decideOutcome.request({ onlyIfLost: true });
  }
  async function onResubmit() {
    await resubmit.run({ approvalId: a.id, note: note.trim() });
    onSettled?.(a);
    resubmitOutcome.request({ onlyIfLost: true });
  }

  return (
    <article className="card" id={`approval-${a.id}`} tabIndex={-1} aria-label={who}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>
          {label(a.checkpoint)}: <Link to={`/cases/${a.employeeId}`}>{a.employeeName}</Link> <span className="muted mono">{a.employeeId}</span>
        </strong>
        <span className="row">
          {a.round > 1 ? <span className="badge info">round {a.round}</span> : null}
          <StatusBadge status={a.status} />
        </span>
      </div>
      <dl className="request-fields">
        {requestRows(a.request).map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {a.status === "pending" ? <p className="muted">{slaText(a.dueAt)}</p> : null}
      {a.previousRound ? (
        <div className="round-history">
          <p>
            Round {a.previousRound.round} rejected{a.previousRound.reason ? `: ${a.previousRound.reason}` : "."}
          </p>
          {a.previousRound.note ? <p>People Ops note: {a.previousRound.note}</p> : null}
        </div>
      ) : null}
      {a.reason ? <p>Reason: {a.reason}</p> : null}
      {a.status === "pending" && canDecide && !decided ? (
        <div className="grid" style={{ gap: 8 }}>
          {me?.role === "admin" ? (
            <p className="notice on-behalf">{a.checkpoint === "manager_approval" ? `You are deciding on behalf of the hiring manager (${a.approverStaffId ?? "unassigned"}).` : "You are deciding on behalf of People Ops."} The decision is audited.</p>
          ) : null}
          {needsPriv ? (
            <fieldset className="priv">
              <legend>Privileged access was requested</legend>
              <label>
                <input type="radio" name={`priv-${a.id}`} checked={privileged === true} onChange={() => setPrivileged(true)} /> Grant privileged access
              </label>
              <label>
                <input type="radio" name={`priv-${a.id}`} checked={privileged === false} onChange={() => setPrivileged(false)} /> Approve without privileged access
              </label>
            </fieldset>
          ) : null}
          <div>
            <label htmlFor={ids.reason}>Reason</label>
            <input id={ids.reason} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Required to reject, optional to approve" style={{ width: "100%" }} />
          </div>
          <div className="row">
            <ActionButton
              className="primary"
              aria-label={`Approve ${who}`}
              aria-describedby={needsPriv && privileged === null ? ids.privHint : undefined}
              disabled={needsPriv && privileged === null}
              busy={busy}
              onClick={() => void onDecide({ decision: "approve", ...(reason.trim() ? { reason: reason.trim() } : {}), ...(needsPriv ? { privilegedAccessApproved: privileged === true } : {}) })}
            >
              Approve
            </ActionButton>
            <ActionButton className="danger" aria-label={`Reject ${who}`} disabled={reason.trim().length === 0} busy={busy} onClick={() => void onDecide({ decision: "reject", reason: reason.trim() })}>
              Reject
            </ActionButton>
            {needsPriv && privileged === null ? (
              <span id={ids.privHint} className="muted hint">
                Choose whether to grant privileged access before approving.
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      {a.resubmittable && canResubmit && !resubmitted ? (
        <div className="grid" style={{ gap: 4 }}>
          <label htmlFor={ids.note}>What changed (sent to the approver with the resubmission)</label>
          <div className="row">
            <input id={ids.note} value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: "1 1 220px" }} />
            <ActionButton className="primary" aria-label={`Resubmit ${who}`} disabled={note.trim().length === 0} busy={busy} onClick={() => void onResubmit()}>
              Resubmit
            </ActionButton>
          </div>
        </div>
      ) : null}
      <ActionMessage ref={decideOutcome.ref} error={decide.error} success={decide.success} context={{ action: `decide the ${who}`, subject: "this approval" }} />
      <ActionMessage ref={resubmitOutcome.ref} error={resubmit.error} success={resubmit.success} context={{ action: `resubmit the ${who}`, subject: "this approval" }} />
    </article>
  );
}
