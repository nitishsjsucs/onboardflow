import { useState } from "react";
import type { ApprovalView } from "../../shared/api.ts";
import { useItemAction } from "../api/item-action.ts";
import { useDecide, useResubmit } from "../api/queries.ts";
import { ActionMessage } from "./ActionMessage.tsx";
import { label, StatusBadge } from "./StatusBadge.tsx";

function sla(dueAt: string, now = Date.now()): string {
  const ms = Date.parse(dueAt) - now;
  const h = Math.round(Math.abs(ms) / 3_600_000);
  return ms >= 0 ? `due in ${h} h` : `overdue by ${h} h`;
}

export type ApprovalCardProps = {
  approval: ApprovalView;
  canDecide: boolean;
  canResubmit: boolean;
};

export function ApprovalCard({ approval: a, canDecide, canResubmit }: ApprovalCardProps) {
  const [reason, setReason] = useState("");
  const [privileged, setPrivileged] = useState(false);
  const [note, setNote] = useState("");
  const decide = useItemAction(useDecide(), (_r, v) => (v.decision === "approve" ? "Approved." : "Rejected."));
  const resubmit = useItemAction(useResubmit(), (r) => `Resubmitted: round ${r.round} sent for approval`);
  const busy = decide.pending || resubmit.pending;
  const who = `${label(a.checkpoint)} for ${a.employeeName}`;
  const onDecide = (d: { decision: "approve" | "reject"; reason?: string; privilegedAccessApproved?: boolean }) => void decide.run({ approvalId: a.id, ...d });
  const onResubmit = (n: string) => void resubmit.run({ approvalId: a.id, note: n });
  const needsPriv = a.request.needsPrivilegedAccess === true && a.checkpoint === "manager_approval";
  return (
    <article className="card" aria-label={`${label(a.checkpoint)} for ${a.employeeName}`}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>
          {label(a.checkpoint)}: {a.employeeName} ({a.employeeId})
        </strong>
        <span className="row">
          {a.round > 1 ? <span className="badge info">round {a.round}</span> : null}
          <StatusBadge status={a.status} />
        </span>
      </div>
      <dl className="muted" style={{ margin: "8px 0", display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 12px" }}>
        {Object.entries(a.request).map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt>{label(k.replace(/([A-Z])/g, "_$1").toLowerCase())}</dt>
            <dd style={{ margin: 0 }}>{String(v)}</dd>
          </div>
        ))}
      </dl>
      {a.status === "pending" ? <p className="muted">{sla(a.dueAt)}</p> : null}
      {a.reason ? <p>Reason: {a.reason}</p> : null}
      {a.status === "pending" && canDecide ? (
        <div className="grid" style={{ gap: 8 }}>
          {needsPriv ? (
            <label className="row">
              <input type="checkbox" checked={privileged} onChange={(e) => setPrivileged(e.target.checked)} /> Approve privileged access
            </label>
          ) : null}
          <input aria-label="reason" placeholder="Reason (required to reject)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="row">
            <button type="button" className="primary" aria-label={`Approve ${who}`} disabled={busy} onClick={() => onDecide({ decision: "approve", ...(reason ? { reason } : {}), ...(needsPriv ? { privilegedAccessApproved: privileged } : {}) })}>
              Approve
            </button>
            <button type="button" className="danger" aria-label={`Reject ${who}`} disabled={busy || reason.trim().length === 0} onClick={() => onDecide({ decision: "reject", reason })}>
              Reject
            </button>
          </div>
        </div>
      ) : null}
      {a.resubmittable && canResubmit ? (
        <div className="row">
          <input aria-label="revision note" placeholder="What changed" value={note} onChange={(e) => setNote(e.target.value)} />
          <button type="button" className="primary" aria-label={`Resubmit ${who}`} disabled={busy || note.trim().length === 0} onClick={() => onResubmit(note)}>
            Resubmit
          </button>
        </div>
      ) : null}
      <ActionMessage error={decide.error} success={decide.success} context={{ action: `decide the ${who}`, subject: "this approval" }} />
      <ActionMessage error={resubmit.error} success={resubmit.success} context={{ action: `resubmit the ${who}`, subject: "this approval" }} />
    </article>
  );
}
