// Statement builders for opening blockers and their follow-up tasks. The
// CaseAgent scan writes them in two batches: first the blocker (INSERT OR
// IGNORE, since the partial unique index admits one open blocker per dedupe
// key) with its audit behind EXISTS on the new id, so a blocker that lost to
// the index is not audited; then, once the follow-up is drafted (an LLM call
// can take seconds), the follow-up and its audit behind EXISTS on the blocker
// still being open. The blocker therefore exists at every await of the
// drafting, and a blocker resolved meanwhile gets no follow-up.
import type { Assignee, BlockerKind, Severity } from "../../shared/domain.ts";
import { auditIds, followUpTaskId } from "../../shared/ids.ts";
import type { Department } from "../../shared/roles.ts";
import type { StageId } from "../../shared/stages.ts";
import { auditInsertWhen, type Condition } from "./audit.ts";

export type NewBlocker = {
  id: string;
  employeeId: string;
  stageId: StageId;
  kind: BlockerKind;
  severity: Severity;
  ownerDepartment: Department;
  subject: string;
  dedupeKey: string;
  detail: Record<string, unknown>;
  detectedAt: string;
};

export type NewFollowUp = {
  title: string;
  description: string;
  assignee: Assignee;
  dueAt: string | null;
  draftedBy: string;
  llmSuggestedCategory: string | null;
  /** Provider latency and outcome, kept in the followup.created audit for LLM metrics. */
  llm?: { provider: string; latencyMs: number | null; error: string | null; usage?: { promptTokens: number; completionTokens: number } };
};

export function blockerExists(blockerId: string): Condition {
  return { sql: "EXISTS (SELECT 1 FROM blockers WHERE id = ?)", binds: [blockerId] };
}

/** The blocker and its blocker.opened audit (one batch, before any drafting). */
export function openBlockerStatements(db: D1Database, b: NewBlocker, actor: { type: "agent" | "workflow" | "system"; id: string }): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT OR IGNORE INTO blockers (id, employee_id, stage_id, kind, severity, owner_department, subject, dedupe_key, status, detail_json, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .bind(b.id, b.employeeId, b.stageId, b.kind, b.severity, b.ownerDepartment, b.subject, b.dedupeKey, JSON.stringify(b.detail), b.detectedAt),
    auditInsertWhen(
      db,
      {
        id: auditIds.agent(b.employeeId, "blocker.opened", b.id),
        occurredAt: b.detectedAt,
        actorType: actor.type,
        actorId: actor.id,
        action: "blocker.opened",
        entityType: "blocker",
        entityId: b.id,
        employeeId: b.employeeId,
        stageId: b.stageId,
        detail: { kind: b.kind, ownerDepartment: b.ownerDepartment, subject: b.subject, severity: b.severity },
      },
      blockerExists(b.id),
    ),
  ];
}

/**
 * The follow-up task of an open blocker and its followup.created audit (one batch, after drafting).
 * Written only while the blocker is still open; the task id is derived from the blocker id, so a
 * second write for the same blocker changes nothing.
 */
export function followUpStatements(
  db: D1Database,
  b: { id: string; employeeId: string; stageId: StageId },
  f: NewFollowUp,
  actor: { type: "agent" | "workflow" | "system"; id: string },
  createdAt: string,
): D1PreparedStatement[] {
  const taskId = followUpTaskId(b.id);
  return [
    db
      .prepare(
        `INSERT OR IGNORE INTO tasks (id, employee_id, stage_id, kind, assignee, title, description, status, due_at, blocker_id, drafted_by, llm_suggested_category, created_at)
         SELECT ?, ?, ?, 'followup', ?, ?, ?, 'open', ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM blockers WHERE id = ? AND status = 'open')`,
      )
      .bind(taskId, b.employeeId, b.stageId, f.assignee, f.title, f.description, f.dueAt, b.id, f.draftedBy, f.llmSuggestedCategory, createdAt, b.id),
    auditInsertWhen(
      db,
      {
        id: auditIds.agent(b.employeeId, "followup.created", taskId),
        occurredAt: createdAt,
        actorType: actor.type,
        actorId: actor.id,
        action: "followup.created",
        entityType: "task",
        entityId: taskId,
        employeeId: b.employeeId,
        stageId: b.stageId,
        detail: { blockerId: b.id, assignee: f.assignee, draftedBy: f.draftedBy, ...(f.llm ? { llm: f.llm, suggestedCategory: f.llmSuggestedCategory } : {}) },
      },
      { sql: "EXISTS (SELECT 1 FROM tasks WHERE id = ?)", binds: [taskId] },
    ),
  ];
}
