// My team, for managers: one row per direct report with an 8-stage strip, who
// acts now, and the days to the start date, so a manager sees at a glance
// which report waits on them and who starts soon without being set up.
//
// Everything comes from what the page already loads: the employees list
// (case status, current stage, start date, open blockers) and the manager's
// own pending approvals (the same query, and cache entry, as Approvals). The
// list carries no stage status, so at paperwork or orientation the row names
// the stage's gate ("the employee's checklist") rather than claiming a wait.
// For a blocked case it carries the owner of the blocker the stage is blocked
// by, so the row names the department the case page names.
import { Link } from "react-router";
import type { ApprovalView, EmployeeSummary, MeDto } from "../../shared/api.ts";
import { STAGE_BY_ID, STAGES } from "../../shared/stages.ts";
import { stageActor } from "../../shared/who-acts.ts";
import { actorName } from "./actor-text.ts";
import { countdownTo, daysUntil, formatDay, localToday } from "./dates.ts";
import { approvalAnchor } from "./links.ts";
import { type StateGlyph, StateIcon } from "./StateIcon.tsx";

export type NowState = "you" | "decision" | "signoff" | "revision" | "blocked" | "checklist" | "running" | "not_started" | "complete" | "failed";

export type CaseNow = {
  state: NowState;
  /** "Waiting on you", "People Ops sign-off", "Blocked: IT on it" */
  text: string;
  glyph: StateGlyph;
  /** The strip's current pip: which chart state it takes. */
  tone: "blocked" | "waiting" | "running" | "done" | "none";
  /** Waiting on this manager's own pending approval: the Approvals card or row to decide it in. */
  decideHref: string | null;
};

const EMPLOYEE_GATE = new Set(["paperwork", "orientation"]);

/**
 * What a report's case waits on now, from the list row and the manager's own pending approvals (by employee).
 * `approvalsKnown`: false when the approvals request failed, so "waiting on you" cannot be told apart.
 */
export function caseNow(e: Pick<EmployeeSummary, "caseStatus" | "currentStage"> & Partial<Pick<EmployeeSummary, "blockerOwner">>, myPending: ApprovalView | undefined, approvalsKnown = true): CaseNow {
  const stage = e.currentStage;
  switch (e.caseStatus) {
    case "not_started":
      return { state: "not_started", text: "Not started: People Ops starts it", glyph: "circle", tone: "none", decideHref: null };
    case "complete":
      return { state: "complete", text: "Complete", glyph: "check", tone: "done", decideHref: null };
    case "failed":
      return { state: "failed", text: "Failed: an admin can restart it", glyph: "cross", tone: "blocked", decideHref: null };
    case "awaiting_approval":
      if (stage === "closeout") return { state: "signoff", text: "People Ops sign-off", glyph: "pause", tone: "waiting", decideHref: null };
      if (myPending && approvalsKnown) return { state: "you", text: "Waiting on you", glyph: "pause", tone: "waiting", decideHref: approvalAnchor(myPending.id) };
      return { state: "decision", text: "Waiting on a decision", glyph: "pause", tone: "waiting", decideHref: null };
    case "blocked":
      if (stage === "manager_approval") return { state: "revision", text: "Revision requested: People Ops revises and resubmits", glyph: "pause", tone: "waiting", decideHref: null };
      return { state: "blocked", text: `Blocked: ${stage ? actorName(stageActor(stage, "blocked", e.blockerOwner)) : "People Ops"} on it`, glyph: "cross", tone: "blocked", decideHref: null };
    case "in_progress":
      if (stage && EMPLOYEE_GATE.has(stage)) return { state: "checklist", text: "The employee's checklist", glyph: "clock", tone: "waiting", decideHref: null };
      return { state: "running", text: "Running (automated)", glyph: "play", tone: "running", decideHref: null };
  }
}

/** Waiting on you first, then the soonest start date, then the id. */
export function teamOrder(a: { e: EmployeeSummary; now: CaseNow }, b: { e: EmployeeSummary; now: CaseNow }): number {
  const you = Number(b.now.state === "you") - Number(a.now.state === "you");
  return you || a.e.startDate.localeCompare(b.e.startDate) || a.e.id.localeCompare(b.e.id);
}

/** The manager's own pending manager approvals, by employee. */
export function myPendingByEmployee(approvals: readonly ApprovalView[], me: MeDto | null): Map<string, ApprovalView> {
  const out = new Map<string, ApprovalView>();
  for (const a of approvals) if (a.status === "pending" && a.checkpoint === "manager_approval" && !!me?.staffId && a.approverStaffId === me.staffId) out.set(a.employeeId, a);
  return out;
}

function Strip({ e, now }: { e: EmployeeSummary; now: CaseNow }) {
  const current = e.currentStage ? STAGE_BY_ID[e.currentStage].ordinal : 0;
  return (
    <span className="strip" aria-hidden="true">
      {STAGES.map((s) => {
        const done = now.state === "complete" || s.ordinal < current;
        const isCurrent = now.state !== "complete" && s.ordinal === current;
        return (
          <span key={s.id} className={`strip-pip${done ? " done" : ""}${isCurrent ? ` current seg-${now.tone === "none" ? "waiting" : now.tone}` : ""}`}>
            {isCurrent ? <StateIcon glyph={now.glyph} size={10} /> : null}
          </span>
        );
      })}
    </span>
  );
}

export function TeamRow({ e, now, today }: { e: EmployeeSummary; now: CaseNow; today: string }) {
  const stage = e.currentStage ? STAGE_BY_ID[e.currentStage] : null;
  const days = daysUntil(e.startDate, today);
  return (
    <li className="team-row" data-testid={`team-${e.id}`}>
      <div className="team-head">
        <span>
          <Link to={`/cases/${e.id}`}>{e.name}</Link> <span className="muted mono">{e.id}</span>
        </span>
        <span className="muted">
          {days !== null && days < 0 ? "started" : "starts"} {formatDay(e.startDate)}, {countdownTo(e.startDate, today)}
        </span>
      </div>
      <Strip e={e} now={now} />
      <div className="team-now">
        <span>{now.state === "complete" ? "All 8 stages done" : stage ? `Stage ${stage.ordinal} of 8: ${stage.name}` : "No stage yet"}</span>
        <span className="team-state">
          <StateIcon glyph={now.glyph} /> <strong>{now.text}</strong>
          {now.state === "blocked" && e.openBlockers > 0 ? <span className="muted"> ({e.openBlockers === 1 ? "1 open blocker" : `${e.openBlockers} open blockers`})</span> : null}
          {now.decideHref ? (
            <>
              {" "}
              <Link className="button-link primary" to={now.decideHref} aria-label={`Decide for ${e.name}`}>
                Decide
              </Link>
            </>
          ) : null}
        </span>
      </div>
    </li>
  );
}

export function TeamList({ items, me, approvals, approvalsFailed, now = new Date() }: { items: EmployeeSummary[]; me: MeDto | null; approvals: readonly ApprovalView[]; approvalsFailed: boolean; now?: Date }) {
  const mine = myPendingByEmployee(approvals, me);
  const today = localToday(now);
  const rows = items.map((e) => ({ e, now: caseNow(e, mine.get(e.id), !approvalsFailed) })).sort(teamOrder);
  return (
    <ul className="team-list" aria-label="your direct reports">
      {rows.map((r) => (
        <TeamRow key={r.e.id} e={r.e} now={r.now} today={today} />
      ))}
    </ul>
  );
}
