// The rule engine behind the coordination agents (ADR 0004): pure functions
// over a D1 snapshot of one case. It decides which blockers exist, who owns
// them, when they auto-resolve, and which waiting stages deserve a nudge.
// No LLM is involved in any of these decisions.
import type { BlockerKind, Checkpoint, ResourceType, Severity, SystemId } from "../../shared/domain.ts";
import { FIXABLE_FIELDS } from "../../shared/domain.ts";
import { blockerDedupeKey } from "../../shared/ids.ts";
import { type Department, FIELD_OWNER, FIXED_BLOCKER_OWNER, SYSTEM_OWNER } from "../../shared/roles.ts";
import { OPERATIONS, type OperationId, POLL_TERMINAL, type StageId } from "../../shared/stages.ts";

export type BlockedReasonJson = {
  class?: "retryable" | "fatal" | "conflict" | "stalled" | "unknown";
  outcome?: string;
  system?: SystemId;
  operation?: OperationId;
  httpStatus?: number | null;
  field?: string;
  message?: string;
  round?: number;
};

export type ScanSnapshot = {
  employeeId: string;
  employeeName: string;
  caseStatus: string;
  stages: Array<{ id: StageId; status: string; round: number; blockedReason: BlockedReasonJson | null; lastWakeAt: string | null }>;
  approvals: Array<{ id: string; stageId: StageId; checkpoint: Checkpoint; round: number; status: "pending" | "approved" | "rejected"; dueAt: string }>;
  /** Open employee checklist tasks. */
  openChecklist: Array<{ id: string; stageId: StageId; dueAt: string | null }>;
  /** Employee checklist task counts per stage (total and done), for the nudge rule. */
  checklistProgress: Array<{ stageId: StageId; total: number; done: number }>;
  provisioning: Array<{ resource: ResourceType; status: string }>;
  /** Successful (ok or replayed) integration calls, per operation, latest time. */
  successes: Array<{ operation: string; lastAt: string }>;
  openBlockers: Array<{ id: string; kind: BlockerKind; stageId: StageId; subject: string; dedupeKey: string; detectedAt: string; detail: Record<string, unknown> }>;
};

export type BlockerCandidate = {
  kind: BlockerKind;
  stageId: StageId;
  subject: string;
  dedupeKey: string;
  ownerDepartment: Department;
  severity: Severity;
  detail: Record<string, unknown>;
};

export type Resolution = { blockerId: string; kind: BlockerKind; reason: string };

function isFixable(field: string | undefined): field is (typeof FIXABLE_FIELDS)[number] {
  return !!field && (FIXABLE_FIELDS as readonly string[]).includes(field);
}

export function ownerFor(kind: BlockerKind, reason?: BlockedReasonJson | null): Department {
  const fixed = FIXED_BLOCKER_OWNER[kind];
  if (fixed) return fixed;
  if (kind === "data_issue" && isFixable(reason?.field)) return FIELD_OWNER[reason.field];
  const system = reason?.system ?? (reason?.operation ? OPERATIONS[reason.operation]?.system : undefined);
  return system ? SYSTEM_OWNER[system] : "people_ops";
}

function kindForBlockedStage(r: BlockedReasonJson): BlockerKind {
  if (r.class === "fatal") return "data_issue";
  if (r.class === "stalled") return "provisioning_stalled";
  return "integration_outage";
}

const SEVERITY: Record<BlockerKind, Severity> = {
  integration_outage: "high",
  data_issue: "high",
  provisioning_stalled: "medium",
  approval_overdue: "medium",
  employee_task_overdue: "low",
  approval_rejected: "medium",
};

function candidate(s: ScanSnapshot, kind: BlockerKind, stageId: StageId, subject: string, detail: Record<string, unknown>, reason?: BlockedReasonJson | null): BlockerCandidate {
  return {
    kind,
    stageId,
    subject,
    dedupeKey: blockerDedupeKey(s.employeeId, kind, stageId, subject),
    ownerDepartment: ownerFor(kind, reason),
    severity: SEVERITY[kind],
    detail,
  };
}

/** All blockers that should be open right now (the caller skips ones already open). */
export function detectBlockers(s: ScanSnapshot, nowMs: number): BlockerCandidate[] {
  const out: BlockerCandidate[] = [];
  if (s.caseStatus === "complete" || s.caseStatus === "failed" || s.caseStatus === "not_started") return out;

  for (const st of s.stages) {
    if (st.status === "blocked" && st.blockedReason) {
      const r = st.blockedReason;
      const kind = kindForBlockedStage(r);
      out.push(candidate(s, kind, st.id, r.operation ?? "unknown", { ...r }, r));
    }
    if (st.status === "revision_requested") {
      const rejected = s.approvals
        .filter((a) => a.stageId === st.id && a.status === "rejected" && a.round === st.round)
        .sort((a, b) => b.round - a.round)[0];
      if (rejected) out.push(candidate(s, "approval_rejected", st.id, rejected.id, { approvalId: rejected.id, checkpoint: rejected.checkpoint, round: rejected.round }));
    }
    if (st.status === "waiting_on_employee") {
      const overdue = s.openChecklist.filter((t) => t.stageId === st.id && t.dueAt !== null && Date.parse(t.dueAt) < nowMs);
      if (overdue.length > 0) {
        out.push(candidate(s, "employee_task_overdue", st.id, `checklist:${st.id}`, { taskIds: overdue.map((t) => t.id).sort(), count: overdue.length }));
      }
    }
  }
  for (const a of s.approvals) {
    if (a.status === "pending" && Date.parse(a.dueAt) < nowMs) {
      out.push(candidate(s, "approval_overdue", a.stageId, a.id, { approvalId: a.id, checkpoint: a.checkpoint, round: a.round, dueAt: a.dueAt }));
    }
  }
  return out;
}

/** Open blockers whose condition has cleared. */
export function resolvedBlockers(s: ScanSnapshot, nowMs: number): Resolution[] {
  const out: Resolution[] = [];
  const stage = (id: StageId) => s.stages.find((x) => x.id === id);
  for (const b of s.openBlockers) {
    const st = stage(b.stageId);
    const stageDone = st?.status === "complete";
    let reason: string | null = null;
    switch (b.kind) {
      case "integration_outage":
      case "data_issue": {
        const ok = s.successes.find((x) => x.operation === b.subject && Date.parse(x.lastAt) > Date.parse(b.detectedAt));
        if (stageDone) reason = "stage completed";
        else if (ok) reason = `${b.subject} succeeded after the blocker opened`;
        break;
      }
      case "provisioning_stalled": {
        const op = OPERATIONS[b.subject as OperationId];
        const terminal = op ? POLL_TERMINAL[op.resource] : undefined;
        const item = op ? s.provisioning.find((p) => p.resource === op.resource) : undefined;
        if (stageDone) reason = "stage completed";
        else if (terminal && item?.status === terminal) reason = `${op?.resource} reached ${terminal}`;
        break;
      }
      case "approval_overdue": {
        const a = s.approvals.find((x) => x.id === b.subject);
        if (!a || a.status !== "pending") reason = "approval decided";
        break;
      }
      case "employee_task_overdue": {
        const overdue = s.openChecklist.some((t) => t.stageId === b.stageId && t.dueAt !== null && Date.parse(t.dueAt) < nowMs);
        if (!overdue) reason = "overdue tasks completed";
        break;
      }
      case "approval_rejected": {
        const round = Number((b.detail as { round?: number }).round ?? 0);
        if (!st || st.status !== "revision_requested" || st.round > round) reason = "resubmitted";
        break;
      }
    }
    if (reason) out.push({ blockerId: b.id, kind: b.kind, reason });
  }
  return out;
}

/**
 * Stages whose gate is satisfied in D1 while the workflow may still be waiting
 * for a wake-up (a lost or wiped event), and whose last wake-up is older than
 * NUDGE_AFTER_S. Sending one more wake-up is harmless: gates re-check D1.
 */
export function nudgeTargets(s: ScanSnapshot, nowMs: number, nudgeAfterS: number): StageId[] {
  const out: StageId[] = [];
  for (const st of s.stages) {
    const stale = !st.lastWakeAt || nowMs - Date.parse(st.lastWakeAt) >= nudgeAfterS * 1000;
    if (!stale) continue;
    let open = false;
    if (st.status === "waiting_on_employee") {
      const p = s.checklistProgress.find((x) => x.stageId === st.id);
      open = !!p && p.total > 0 && p.done === p.total;
    } else if (st.status === "awaiting_approval") {
      const latest = s.approvals.filter((a) => a.stageId === st.id).sort((a, b) => b.round - a.round)[0];
      // decided, or resubmitted (round advanced past the latest approval)
      open = !!latest && (latest.status !== "pending" || st.round > latest.round);
    } else if (st.status === "active" && st.blockedReason?.round !== undefined) {
      // retried (round advanced past the blocked round) and not yet blocked again or completed
      open = st.round > st.blockedReason.round;
    }
    if (open) out.push(st.id);
  }
  return out;
}
