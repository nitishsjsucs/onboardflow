// The case page's first sentence: what the case is waiting on and who has to
// act, since when, when the employee starts, and how far it got. Managers,
// coordinators and admins open case pages to answer exactly that, and before
// this the answer was spread over a status badge, a raw ISO start date and
// blocker text further down. Built from CaseDetail alone: no extra request.
import type { CaseDetail, MeDto } from "../../shared/api.ts";
import type { FailureReason } from "../../shared/domain.ts";
import { STAGE_BY_ID } from "../../shared/stages.ts";
import { stageActor } from "../../shared/who-acts.ts";
import { actorName } from "./actor-text.ts";
import { blockerTitle, readableMessage } from "./blocker-text.ts";
import { countdownWords, daysSince, daysUntil, formatDay, formatInstantDay, localToday } from "./dates.ts";
import { approvalAnchor } from "./links.ts";
import { isOverdue, overdueTaskIds } from "./TaskList.tsx";

export type CaseSentence = {
  /** Sentences, in reading order: what and who, since when, the start date, progress. */
  parts: string[];
  /** The one link for a viewer who can act: decide, decide on behalf, or open in Approvals. */
  action: { text: string; href: string } | null;
};

const REQUEST = { manager_approval: "the equipment and access request", closeout: "the sign-off request" } as const;

function failureWords(reason: FailureReason | null, stageName: string | null): string {
  switch (reason) {
    case "terminated":
      return "an admin terminated it";
    case "approval_rejected_final":
      return "the request was rejected in its last approval round";
    case "recovery_rounds_exhausted":
      return `${stageName ?? "a stage"} ran out of recovery rounds`;
    case "wait_budget_exhausted":
      return "it waited longer than the workflow allows";
    default:
      return "a workflow error";
  }
}

/** "Starts Monday, November 23 (in 38 days).", "Starts today, Monday, November 2.", "Started Monday, November 2 (14 days ago)." */
export function startWords(startDate: string, today: string): string {
  const days = daysUntil(startDate, today);
  const day = formatDay(startDate, "long");
  if (days === null) return `Starts ${startDate}.`;
  if (days === 0) return `Starts today, ${day}.`;
  return days > 0 ? `Starts ${day} (${countdownWords(days)}).` : `Started ${day} (${countdownWords(days)}).`;
}

export function caseSentence(d: CaseDetail, me: MeDto | null, now: Date = new Date()): CaseSentence {
  const today = localToday(now);
  const start = startWords(d.employee.startDate, today);
  const done = d.stages.filter((s) => s.status === "complete").length;
  const progress = `${done} of ${d.stages.length} stages done.`;
  const c = d.case;
  const cur = d.stages.find((s) => s.id === c.currentStage) ?? null;
  if (c.status === "not_started") return { parts: ["Onboarding has not started: People Ops starts it.", start], action: null };
  if (c.status === "complete") return { parts: [`Completed${c.completedAt ? ` ${formatInstantDay(c.completedAt)}` : ""}.`, start, progress], action: null };
  if (c.status === "failed") return { parts: [`Onboarding failed: ${failureWords(c.failureReason, cur?.name ?? null)}. An admin can restart it.`, start, progress], action: null };
  if (!cur) return { parts: [start, progress], action: null };

  const openBlockers = d.blockers.filter((b) => b.status === "open" && b.stageId === cur.id);
  // an outage blocker can stay open beside the data issue a later retry hit: the data issue is what blocks now
  const blocker = openBlockers.find((b) => b.kind === "data_issue") ?? openBlockers[0] ?? null;
  const isMe = (staffId: string | null | undefined) => !!me?.staffId && me.staffId === staffId;
  const peopleOps = me?.role === "coordinator" && me.department === "people_ops";
  let what: string;
  let since = cur.startedAt ? `In this stage since ${formatInstantDay(cur.startedAt)} (${daysSince(cur.startedAt, now)}).` : null;
  let action: CaseSentence["action"] = null;
  switch (cur.status) {
    case "awaiting_approval": {
      const pending = d.approvals.find((a) => a.status === "pending" && a.stageId === cur.id) ?? null;
      if (cur.id === "manager_approval") {
        const mine = isMe(pending?.approverStaffId ?? d.employee.managerId) && me?.role === "manager";
        what = `Waiting on ${mine ? "you" : `${d.employee.managerName} (hiring manager)`} to decide ${REQUEST.manager_approval}.`;
        if (pending && mine) action = { text: "Decide in Approvals", href: approvalAnchor(pending.id) };
      } else {
        what = "Waiting on People Ops to sign off.";
        if (pending && peopleOps) action = { text: "Open in Approvals", href: approvalAnchor(pending.id) };
      }
      if (pending && me?.role === "admin") action = { text: "Decide on behalf", href: approvalAnchor(pending.id) };
      break;
    }
    case "revision_requested": {
      const checkpoint = cur.id === "closeout" ? "closeout" : "manager_approval";
      what = `Waiting on People Ops to revise and resubmit ${REQUEST[checkpoint]} (round ${cur.round} was rejected).`;
      const rejected = d.approvals.find((a) => a.status === "rejected" && a.stageId === cur.id && a.round === cur.round);
      if (rejected && (peopleOps || me?.role === "admin")) action = { text: "Open in Approvals", href: approvalAnchor(rejected.id) };
      break;
    }
    case "blocked": {
      const who = actorName(stageActor(cur.id, "blocked", blocker?.ownerDepartment));
      const message = typeof cur.blockedReason?.message === "string" ? readableMessage(cur.blockedReason.message) : "";
      what = blocker ? `Blocked: ${blockerTitle(blocker)}; ${who} is on it.` : `Blocked${message ? `: ${message}` : ""}; ${who} is on it.`;
      if (blocker) since = `Blocked since ${formatInstantDay(blocker.detectedAt)} (${daysSince(blocker.detectedAt, now)}).`;
      break;
    }
    case "waiting_on_employee": {
      const notStarted = new Set(d.stages.filter((s) => s.status === "pending").map((s) => s.id));
      const open = d.tasks.filter((t) => t.kind === "checklist" && t.stageId === cur.id && t.status === "open");
      const overdue = open.filter((t) => isOverdue(t, overdueTaskIds(d.blockers), notStarted, now.getTime())).length;
      const who = me?.role === "employee" && me.employeeId === d.employee.id ? "you" : "the employee";
      what = `Waiting on ${who}: ${open.length} checklist task${open.length === 1 ? "" : "s"} open${overdue > 0 ? `, ${overdue} overdue` : ""}.`;
      break;
    }
    case "active":
      what = `Running ${STAGE_BY_ID[cur.id].name}.`;
      break;
    default:
      what = `${STAGE_BY_ID[cur.id].name}: ${cur.status.replace(/_/g, " ")}.`;
  }
  return { parts: [what, ...(since ? [since] : []), start, progress], action };
}
