// Plain-language text for blockers in the queue: a title per kind built from
// the blocker's detail and the stage names (never the raw subject, approval id
// or operation id), the stage's current state, and relative ages. The agents'
// follow-up template text (src/worker/agents/followups.ts) is left alone: it
// feeds the LLM prompt and the measured draft metrics.
import type { BlockerView } from "../../shared/api.ts";
import type { BlockerKind, FixableField } from "../../shared/domain.ts";
import { FIXABLE_FIELDS } from "../../shared/domain.ts";
import type { Department } from "../../shared/roles.ts";

export const DEPARTMENT_NAMES: Record<Department, string> = { people_ops: "People Ops", it: "IT", facilities: "Facilities" };
export const SYSTEM_NAMES: Record<string, string> = { hr: "HR", it: "IT", facilities: "Facilities" };
export const FIELD_LABELS: Record<FixableField, string> = { costCenter: "cost center", licenseBundle: "license bundle", photoOnFile: "badge photo" };

export const KIND_NAMES: Record<BlockerKind, string> = {
  integration_outage: "Integration outage",
  data_issue: "Data issue",
  provisioning_stalled: "Provisioning stalled",
  approval_overdue: "Approval overdue",
  employee_task_overdue: "Employee task overdue",
  approval_rejected: "Approval rejected",
};

/** Blocker kinds that hold an operation stage, where Retry starts a new recovery round. */
export const RETRYABLE_KINDS: ReadonlySet<BlockerKind> = new Set(["integration_outage", "data_issue", "provisioning_stalled"]);

export const OPERATION_TEXT: Record<string, string> = {
  "hr.create-worker": "create the worker record",
  "hr.start-document-verification": "start document verification",
  "hr.get-document-verification": "check document verification",
  "hr.enroll-orientation": "enroll the employee in orientation",
  "hr.activate-worker": "activate the worker",
  "hr.get-worker": "check the worker record",
  "it.create-account": "create the account",
  "it.assign-licenses": "assign licenses",
  "it.order-device": "order the device",
  "it.get-device-order": "check the device order",
  "it.get-account": "check the account",
  "facilities.assign-workspace": "assign a workspace",
  "facilities.issue-badge": "issue the badge",
  "facilities.get-badge": "check the badge",
};

const STALLED_TEXT: Record<string, string> = {
  "hr.start-document-verification": "Document verification",
  "it.order-device": "Device order",
  "facilities.issue-badge": "Badge",
};

export function isFixableField(v: unknown): v is FixableField {
  return typeof v === "string" && (FIXABLE_FIELDS as readonly string[]).includes(v);
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function systemOf(b: BlockerView): string {
  const sys = typeof b.detail.system === "string" ? b.detail.system : b.subject.split(".")[0];
  return SYSTEM_NAMES[sys ?? ""] ?? "a simulated system";
}

/** "Cost center rejected by HR", "Manager approval overdue", "IT (simulated) could not order the device". */
export function blockerTitle(b: BlockerView): string {
  const d = b.detail;
  const system = systemOf(b);
  switch (b.kind) {
    case "integration_outage":
      return `${capitalize(system)} (simulated) could not ${OPERATION_TEXT[b.subject] ?? "complete a step"}`;
    case "data_issue":
      return isFixableField(d.field) ? `${capitalize(FIELD_LABELS[d.field])} rejected by ${system}` : `${capitalize(system)} rejected the request`;
    case "provisioning_stalled":
      return `${STALLED_TEXT[b.subject] ?? "Provisioning"} stalled in ${system} (simulated)`;
    case "approval_overdue":
      return d.checkpoint === "closeout" ? "People Ops sign-off overdue" : "Manager approval overdue";
    case "employee_task_overdue": {
      const n = Number(d.count ?? (Array.isArray(d.taskIds) ? d.taskIds.length : 0)) || 0;
      return `${n} checklist task${n === 1 ? "" : "s"} overdue`;
    }
    case "approval_rejected":
      return d.checkpoint === "closeout" ? "People Ops sign-off rejected: revise and resubmit" : "Manager approval rejected: revise and resubmit";
  }
}

/** A simulated system's message with field names in words ("costCenter must match" -> "cost center must match"). */
export function readableMessage(m: string): string {
  return m
    .replace(/\b(costCenter|licenseBundle|photoOnFile)\b/g, (f) => FIELD_LABELS[f as FixableField])
    .replace(/_/g, " ")
    .trim();
}

function shortDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** One line of detail under the title, or null. */
export function blockerDetail(b: BlockerView): string | null {
  const d = b.detail;
  switch (b.kind) {
    case "integration_outage":
    case "data_issue":
    case "provisioning_stalled":
      return typeof d.message === "string" && d.message ? capitalize(readableMessage(d.message)) : null;
    case "approval_overdue":
      return typeof d.dueAt === "string" ? `Was due ${shortDate(d.dueAt)}${d.round ? `, round ${String(d.round)}` : ""}.` : null;
    case "approval_rejected":
      return d.round ? `Round ${String(d.round)} was rejected; People Ops revises the request and resubmits it.` : null;
    case "employee_task_overdue":
      return "The employee has checklist tasks past their due date.";
  }
}

/** The sentence with a full stop at the end, unless it already ends with one (or ? or !). */
export function sentence(s: string): string {
  return /[.?!]$/.test(s) ? s : `${s}.`;
}

/** The blocked stage's state now: "Retry running, round 3", "Blocked after round 3". */
export function stageState(b: BlockerView): string | null {
  const r = b.stageRound;
  switch (b.stageStatus) {
    case "active":
      return RETRYABLE_KINDS.has(b.kind) ? `Retry running, round ${r}` : `Active, round ${r}`;
    case "blocked":
      return `Blocked after round ${r}`;
    case "awaiting_approval":
      return `Awaiting approval, round ${r}`;
    case "revision_requested":
      return `Revision requested, round ${r}`;
    case "waiting_on_employee":
      return "Waiting on the employee";
    case "complete":
      return "Stage complete";
    case "failed":
      return "Stage failed";
    case "pending":
      return "Not started";
    default:
      return null;
  }
}

/** "just now", "12 min ago", "2 h ago", "3 days ago". */
export function relativeTime(iso: string, now = Date.now()): string {
  const min = Math.round((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(min) || min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const;

/** High severity first, then the oldest first. */
export function queueOrder(a: BlockerView, b: BlockerView): number {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || Date.parse(a.detectedAt) - Date.parse(b.detectedAt) || (a.id < b.id ? -1 : 1);
}
