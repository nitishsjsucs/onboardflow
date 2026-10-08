// Department queue: follow-ups the agents created and open blockers, with
// retry, resolve and data fixes. Coordinators see their own department.
import { useState } from "react";
import type { BlockerView } from "../../shared/api.ts";
import { useBlockers, useCompleteFollowup, useFixField, useFollowups, useResolveBlocker, useRetryStage } from "../api/queries.ts";
import { can, useSession } from "../auth/session.tsx";
import { BlockerList } from "../components/BlockerList.tsx";
import { label } from "../components/StatusBadge.tsx";
import { TaskList } from "../components/TaskList.tsx";

const FIXABLE = ["costCenter", "licenseBundle", "photoOnFile"] as const;
type Fixable = (typeof FIXABLE)[number];

function FieldFix({ blocker, onFix }: { blocker: BlockerView; onFix: (field: Fixable, value: string | boolean) => void }) {
  const field = blocker.detail.field as Fixable | undefined;
  const [value, setValue] = useState("");
  if (!field || !(FIXABLE as readonly string[]).includes(field)) return null;
  if (field === "photoOnFile") {
    return (
      <button type="button" onClick={() => onFix(field, true)}>
        Mark photo on file
      </button>
    );
  }
  return (
    <span className="row">
      <input aria-label={`new ${field}`} placeholder={field === "costCenter" ? "CC-1234" : "ft-standard"} value={value} onChange={(e) => setValue(e.target.value)} />
      <button type="button" disabled={!value} onClick={() => onFix(field, value)}>
        Fix {label(field)}
      </button>
    </span>
  );
}

export function QueuePage() {
  const { me } = useSession();
  const followups = useFollowups();
  const blockers = useBlockers("open");
  const retry = useRetryStage();
  const resolve = useResolveBlocker();
  const fix = useFixField();
  const done = useCompleteFollowup();
  const dept = me?.role === "coordinator" ? label(me.department ?? "") : "all departments";
  const errors = [retry.error, resolve.error, fix.error, done.error].filter(Boolean) as Error[];
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
        <BlockerList
          blockers={blockers.data?.items ?? []}
          actions={(b) => (
            <>
              {can.fixField(me, (b.detail.field as Fixable) ?? "costCenter") && b.kind === "data_issue" ? (
                <FieldFix blocker={b} onFix={(field, value) => fix.mutate({ employeeId: b.employeeId, field, value })} />
              ) : null}
              {can.retry(me, b.ownerDepartment) && b.kind !== "approval_overdue" && b.kind !== "employee_task_overdue" && b.kind !== "approval_rejected" ? (
                <button type="button" className="primary" onClick={() => retry.mutate({ employeeId: b.employeeId, stageId: b.stageId })}>
                  Retry stage
                </button>
              ) : null}
              {can.workDepartment(me, b.ownerDepartment) ? (
                <button type="button" onClick={() => resolve.mutate({ blockerId: b.id, resolution: "resolved from the queue" })}>
                  Resolve
                </button>
              ) : null}
            </>
          )}
        />
      </section>
      <section className="card" aria-label="follow-ups">
        <h2>Follow-ups</h2>
        <TaskList tasks={followups.data?.items ?? []} onComplete={(t) => done.mutate({ taskId: t.id })} />
      </section>
      {errors.map((e, i) => (
        <p key={i} className="error">
          {e.message}
        </p>
      ))}
    </>
  );
}
