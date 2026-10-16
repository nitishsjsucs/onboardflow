// Department queue: follow-ups the agents created and open blockers, with
// retry, resolve and data fixes. Coordinators see their own department.
import { useState } from "react";
import type { BlockerView, MeDto } from "../../shared/api.ts";
import { STAGE_BY_ID } from "../../shared/stages.ts";
import { useItemAction } from "../api/item-action.ts";
import { useBlockers, useFixField, useFollowups, useResolveBlocker, useRetryStage } from "../api/queries.ts";
import { can, useSession } from "../auth/session.tsx";
import { ActionMessage } from "../components/ActionMessage.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { label } from "../components/StatusBadge.tsx";
import { TaskList } from "../components/TaskList.tsx";

const FIXABLE = ["costCenter", "licenseBundle", "photoOnFile"] as const;
type Fixable = (typeof FIXABLE)[number];

function FieldFix({ blocker }: { blocker: BlockerView }) {
  const field = blocker.detail.field as Fixable | undefined;
  const [value, setValue] = useState("");
  const fix = useItemAction(useFixField(), () => `Saved the ${label(field ?? "")} for ${blocker.employeeName}`);
  if (!field || !(FIXABLE as readonly string[]).includes(field)) return null;
  return (
    <div>
      {field === "photoOnFile" ? (
        <button type="button" disabled={fix.pending} onClick={() => void fix.run({ employeeId: blocker.employeeId, field, value: true })}>
          Mark photo on file
        </button>
      ) : (
        <span className="row">
          <input aria-label={`new ${field}`} placeholder={field === "costCenter" ? "CC-1234" : "ft-standard"} value={value} onChange={(e) => setValue(e.target.value)} />
          <button type="button" disabled={!value || fix.pending} onClick={() => void fix.run({ employeeId: blocker.employeeId, field, value })}>
            Fix {label(field)}
          </button>
        </span>
      )}
      <ActionMessage error={fix.error} success={fix.success} context={{ action: `fix the ${label(field)}`, subject: `employee ${blocker.employeeId}` }} />
    </div>
  );
}

function BlockerRow({ b, me }: { b: BlockerView; me: MeDto | null }) {
  const stage = STAGE_BY_ID[b.stageId].name;
  const retry = useItemAction(useRetryStage(), (r) => `Retry requested for ${stage}: round ${r.round} running`);
  const resolve = useItemAction(useResolveBlocker(), () => `Resolved: ${label(b.kind)} for ${b.employeeName}`);
  return (
    <li data-testid={`blocker-${b.kind}`}>
      <div className="item-main">
        <div className="title">
          <span className={`badge ${b.severity === "high" ? "bad" : "warn"}`}>{label(b.kind)}</span> {b.employeeName} ({b.employeeId}), {stage}
        </div>
        <div className="muted">
          Owner: {label(b.ownerDepartment)}. Detected {new Date(b.detectedAt).toLocaleString()}.
        </div>
      </div>
      <div className="item-actions">
        {can.fixField(me, (b.detail.field as Fixable) ?? "costCenter") && b.kind === "data_issue" ? <FieldFix blocker={b} /> : null}
        {can.retry(me, b.ownerDepartment) && b.kind !== "approval_overdue" && b.kind !== "employee_task_overdue" && b.kind !== "approval_rejected" ? (
          <button type="button" className="primary" aria-label={`Retry ${stage} for ${b.employeeName}`} disabled={retry.pending} onClick={() => void retry.run({ employeeId: b.employeeId, stageId: b.stageId })}>
            Retry stage
          </button>
        ) : null}
        {can.workDepartment(me, b.ownerDepartment) ? (
          <button type="button" aria-label={`Resolve ${label(b.kind)} for ${b.employeeName}`} disabled={resolve.pending} onClick={() => void resolve.run({ blockerId: b.id, resolution: "resolved from the queue" })}>
            Resolve
          </button>
        ) : null}
      </div>
      <ActionMessage error={retry.error} success={retry.success} context={{ action: `retry ${stage}`, subject: stage }} />
      <ActionMessage error={resolve.error} success={resolve.success} context={{ action: "resolve this blocker", subject: "this blocker" }} />
    </li>
  );
}

export function QueuePage() {
  const { me } = useSession();
  const followups = useFollowups();
  const blockers = useBlockers("open");
  const dept = me?.role === "coordinator" ? label(me.department ?? "") : "all departments";
  const items = blockers.data?.items ?? [];
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Queue</h1>
          <div className="sub">Follow-ups and blockers for {dept}. Blockers come from rules; the follow-up text may be drafted by the configured provider.</div>
        </div>
      </div>
      <section className="card" aria-label="open blockers">
        <h2>Open blockers</h2>
        {items.length === 0 ? (
          <EmptyState>No blockers.</EmptyState>
        ) : (
          <ul className="tasks">
            {items.map((b) => (
              <BlockerRow key={b.id} b={b} me={me} />
            ))}
          </ul>
        )}
      </section>
      <section className="card" aria-label="follow-ups">
        <h2>Follow-ups</h2>
        <TaskList tasks={followups.data?.items ?? []} completable doneLabel="Mark follow-up done" />
      </section>
    </>
  );
}
