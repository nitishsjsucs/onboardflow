// Statement builders for opening and resolving blockers. A blocker and its
// follow-up task are written in one batch: the blocker with INSERT OR IGNORE
// (the partial unique index admits one open blocker per dedupe key) and the
// follow-up and audits behind EXISTS on the new blocker id, so a blocker that
// lost to the index produces no follow-up and no foreign key error.
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
};

export function blockerExists(blockerId: string): Condition {
  return { sql: "EXISTS (SELECT 1 FROM blockers WHERE id = ?)", binds: [blockerId] };
}

export function openBlockerStatements(
  db: D1Database,
  b: NewBlocker,
  f: NewFollowUp,
  actor: { type: "agent" | "workflow" | "system"; id: string },
): D1PreparedStatement[] {
  const when = blockerExists(b.id);
  const taskId = followUpTaskId(b.id);
  return [
    db
      .prepare(
        `INSERT OR IGNORE INTO blockers (id, employee_id, stage_id, kind, severity, owner_department, subject, dedupe_key, status, detail_json, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .bind(b.id, b.employeeId, b.stageId, b.kind, b.severity, b.ownerDepartment, b.subject, b.dedupeKey, JSON.stringify(b.detail), b.detectedAt),
    db
      .prepare(
        `INSERT OR IGNORE INTO tasks (id, employee_id, stage_id, kind, assignee, title, description, status, due_at, blocker_id, drafted_by, llm_suggested_category, created_at)
         SELECT ?, ?, ?, 'followup', ?, ?, ?, 'open', ?, ?, ?, ?, ? WHERE ${when.sql}`,
      )
      .bind(taskId, b.employeeId, b.stageId, f.assignee, f.title, f.description, f.dueAt, b.id, f.draftedBy, f.llmSuggestedCategory, b.detectedAt, ...when.binds),
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
      when,
    ),
    auditInsertWhen(
      db,
      {
        id: auditIds.agent(b.employeeId, "followup.created", taskId),
        occurredAt: b.detectedAt,
        actorType: actor.type,
        actorId: actor.id,
        action: "followup.created",
        entityType: "task",
        entityId: taskId,
        employeeId: b.employeeId,
        stageId: b.stageId,
        detail: { blockerId: b.id, assignee: f.assignee, draftedBy: f.draftedBy },
      },
      { sql: "EXISTS (SELECT 1 FROM tasks WHERE id = ?)", binds: [taskId] },
    ),
  ];
}
