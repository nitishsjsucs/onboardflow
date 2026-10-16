// Guided fix for a data issue: a simulated system rejected a profile field, the
// stage is blocked, and every Retry spends one of the stage's recovery rounds
// (the workflow fails the case once they run out). So the row shows what was
// rejected and the current value, accepts only a value the simulated system
// would take (the same COST_CENTER_PATTERN and ALLOWED_BUNDLES it uses), and
// offers Retry as the primary action only once the field looks valid.
//
// Validation is client-side only, on purpose: the API still accepts any cost
// center (eval scenario R09 PATCHes "CC 1100" and expects another data issue
// round). The fix and the retry stay two calls, each with its own key.
import { type Ref, useId, useRef, useState } from "react";
import type { EmployeeProfileDto, MeDto } from "../../shared/api.ts";
import { ALLOWED_BUNDLES, COST_CENTER_PATTERN, type FixableField, type LicenseBundle } from "../../shared/domain.ts";
import { STAGE_BY_ID, type StageId } from "../../shared/stages.ts";
import { type ItemAction, useItemAction } from "../api/item-action.ts";
import { useEmployeeProfile, useFixField, useRetryStage } from "../api/queries.ts";
import { can } from "../auth/session.tsx";
import { useFocusRequest } from "../hooks/useFocus.ts";
import { ActionButton } from "./ActionButton.tsx";
import { ActionMessage } from "./ActionMessage.tsx";
import { FIELD_LABELS, isFixableField, SYSTEM_NAMES } from "./blocker-text.ts";
import { label } from "./StatusBadge.tsx";

/** Whether the profile's value would pass the simulated system's check. */
export function fieldLooksValid(field: FixableField, p: EmployeeProfileDto): boolean {
  if (field === "costCenter") return COST_CENTER_PATTERN.test(p.costCenter);
  if (field === "licenseBundle") return ALLOWED_BUNDLES[p.employmentType].includes(p.licenseBundle);
  return p.photoOnFile;
}

function currentValue(field: FixableField, p: EmployeeProfileDto): string {
  if (field === "photoOnFile") return p.photoOnFile ? "on file" : "missing";
  return field === "costCenter" ? p.costCenter : p.licenseBundle;
}

export type DataIssueFixProps = {
  me: MeDto | null;
  employeeId: string;
  employeeName: string;
  stageId: StageId;
  /** The department that owns the blocker (who may retry the stage). */
  owner: string;
  /** blocker.detail or the stage's blocked reason: { field, system, message }. */
  detail: Record<string, unknown>;
  /** The stage is running again (a retry is in flight on the server), so Retry would answer 409. */
  retryRunning?: boolean;
};

export function DataIssueFix({ me, employeeId, employeeName, stageId, owner, detail, retryRunning }: DataIssueFixProps) {
  const field = isFixableField(detail.field) ? detail.field : null;
  const mayFix = !!field && can.fixField(me, field);
  const mayRetry = can.retry(me, owner);
  const profile = useEmployeeProfile(employeeId, !!field && (mayFix || mayRetry));
  const stage = STAGE_BY_ID[stageId].name;
  const fix = useItemAction(useFixField(), (_r, v) => `Saved the ${FIELD_LABELS[v.field]} for ${employeeName}`);
  const retry = useItemAction(useRetryStage(), (r) => `Retry requested for ${stage}: round ${r.round} running`);
  const hintId = useId();
  // after a saved fix, the next step is Retry: focus goes to it (or to the confirmation when this user may not retry)
  const next = useFocusRequest<HTMLButtonElement>();
  const fixMessage = useRef<HTMLDivElement>(null);
  if (!field || (!mayFix && !mayRetry)) return null;
  const fieldLabel = FIELD_LABELS[field];
  const system = SYSTEM_NAMES[String(detail.system ?? "")] ?? "A simulated system";
  const p = profile.data;
  const saved = fix.success !== null;
  const looksValid = saved || (p ? fieldLooksValid(field, p) : false);
  const message = typeof detail.message === "string" && detail.message ? detail.message : null;
  return (
    <div className="data-fix">
      <p className="data-fix-reason">
        {system} (simulated) rejected the {fieldLabel}
        {message ? `: ${message}` : "."}
      </p>
      <p className="muted" style={{ margin: "2px 0 8px" }}>
        {p ? (
          <>
            Current value: <span className="mono">{currentValue(field, p)}</span>
          </>
        ) : profile.isError ? (
          "Could not load the current value."
        ) : (
          "Loading the current value..."
        )}
      </p>
      {mayFix ? (
        <FieldForm
          field={field}
          profile={p}
          employeeId={employeeId}
          employeeName={employeeName}
          fix={fix}
          showSuccess={!mayRetry}
          messageRef={fixMessage}
          onFixed={() => next.request({ target: () => next.ref.current ?? fixMessage.current })}
        />
      ) : null}
      {mayRetry ? (
        <div className="data-fix-retry">
          {looksValid ? (
            <>
              <p style={{ margin: "8px 0 4px" }}>
                {saved ? "Saved." : `The ${fieldLabel} now looks valid.`} Retry {stage} now?
              </p>
              <ActionButton
                ref={next.ref}
                className="primary"
                aria-label={retryRunning ? `Retry running: ${stage} for ${employeeName}` : `Retry ${stage} now for ${employeeName}`}
                busy={retry.pending || retryRunning}
                onClick={() => void retry.run({ employeeId, stageId })}
              >
                {retryRunning ? "Retry running" : `Retry ${stage} now`}
              </ActionButton>
            </>
          ) : (
            <>
              <ActionButton
                aria-label={retryRunning ? `Retry running: ${stage} for ${employeeName}` : `Retry ${stage} for ${employeeName}`}
                aria-describedby={hintId}
                busy={retry.pending || retryRunning}
                onClick={() => void retry.run({ employeeId, stageId })}
              >
                {retryRunning ? "Retry running" : `Retry ${stage}`}
              </ActionButton>
              <p id={hintId} className="muted hint">
                Fix the {fieldLabel} first, or the retry fails again and uses one of this stage's recovery rounds.
              </p>
            </>
          )}
          <ActionMessage error={retry.error} success={retry.success} context={{ action: `retry ${stage}`, subject: stage }} />
        </div>
      ) : null}
    </div>
  );
}

function FieldForm({
  field,
  profile: p,
  employeeId,
  employeeName,
  fix,
  showSuccess,
  messageRef,
  onFixed,
}: {
  field: FixableField;
  profile: EmployeeProfileDto | undefined;
  employeeId: string;
  employeeName: string;
  fix: ItemAction<{ employeeId: string; field: FixableField; value: string | boolean }, EmployeeProfileDto>;
  /** Show the save confirmation here (when there is no retry prompt to carry it). */
  showSuccess: boolean;
  messageRef: Ref<HTMLDivElement>;
  /** Called after a fix was saved. */
  onFixed: () => void;
}) {
  const [value, setValue] = useState("");
  const inputId = useId();
  const hintId = useId();
  const context = { action: `fix the ${FIELD_LABELS[field]} for ${employeeName}`, subject: `the ${FIELD_LABELS[field]}` };
  const save = async (v: string | boolean) => {
    if (await fix.run({ employeeId, field, value: v })) onFixed();
  };
  if (field === "photoOnFile") {
    const onFile = fix.success !== null || p?.photoOnFile === true;
    return (
      <div className="data-fix-form">
        {onFile ? (
          <span className="badge ok">Photo on file</span>
        ) : (
          <ActionButton aria-label={`Mark photo on file for ${employeeName}`} busy={fix.pending} onClick={() => void save(true)}>
            Mark photo on file
          </ActionButton>
        )}
        <ActionMessage ref={messageRef} error={fix.error} success={showSuccess ? fix.success : null} context={context} />
      </div>
    );
  }
  if (field === "costCenter") {
    const trimmed = value.trim();
    const valid = COST_CENTER_PATTERN.test(trimmed) && trimmed !== p?.costCenter;
    return (
      <form
        className="data-fix-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void save(trimmed);
        }}
      >
        <label htmlFor={inputId}>New cost center</label>
        <div className="row">
          <input id={inputId} aria-describedby={hintId} value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" spellCheck={false} />
          <ActionButton type="submit" disabled={!valid} busy={fix.pending}>
            Fix cost center
          </ActionButton>
        </div>
        <span id={hintId} className="muted hint">
          CC- followed by 4 digits, for example CC-1100
        </span>
        <ActionMessage ref={messageRef} error={fix.error} success={showSuccess ? fix.success : null} context={context} />
      </form>
    );
  }
  // licenseBundle: only the bundles the simulated IT system accepts for this employment type, minus the rejected one
  const options: LicenseBundle[] = p ? ALLOWED_BUNDLES[p.employmentType].filter((b) => b !== p.licenseBundle) : [];
  return (
    <form
      className="data-fix-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (value) void save(value);
      }}
    >
      <label htmlFor={inputId}>New license bundle</label>
      <div className="row">
        <select id={inputId} aria-describedby={hintId} value={value} onChange={(e) => setValue(e.target.value)} disabled={!p}>
          <option value="">Choose a bundle</option>
          {options.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <ActionButton type="submit" disabled={!value} busy={fix.pending}>
          Fix license bundle
        </ActionButton>
      </div>
      <span id={hintId} className="muted hint">
        {p ? (options.length > 0 ? `Bundles IT (simulated) accepts for a ${label(p.employmentType)} employee.` : `No other bundle is allowed for a ${label(p.employmentType)} employee.`) : "Loading the allowed bundles..."}
      </span>
      <ActionMessage ref={messageRef} error={fix.error} success={showSuccess ? fix.success : null} context={context} />
    </form>
  );
}
