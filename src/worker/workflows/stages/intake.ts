// Stage 1: create the employee checklist (D1) and the HR worker record.
import { checklistTaskId } from "../../../shared/ids.ts";
import { TASK_TEMPLATES } from "../../../shared/stages.ts";
import { auditInsertWhen, stamped } from "../../db/audit.ts";
import { getEmployee } from "../../db/repo.ts";
import { CHECK_STEP } from "../retry-policy.ts";
import { type RunCtx, writer } from "../run-context.ts";
import { runOp } from "../stage-runner.ts";

const DAY_MS = 86_400_000;

async function createChecklist(ctx: RunCtx, stepName: string): Promise<{ created: number }> {
  const w = await writer(ctx, stepName);
  const e = await getEmployee(w.db, ctx.employeeId);
  if (!e) throw new Error(`employee ${ctx.employeeId} not found`);
  const start = Date.parse(`${e.startDate}T17:00:00.000Z`);
  const statements: D1PreparedStatement[] = [];
  for (const t of TASK_TEMPLATES) {
    const id = checklistTaskId(ctx.employeeId, t.key);
    statements.push(
      w.db
        .prepare(
          `INSERT OR IGNORE INTO tasks (id, employee_id, stage_id, kind, template_key, assignee, title, description, status, due_at, drafted_by, last_mutation_id, created_at)
           VALUES (?, ?, ?, 'checklist', ?, ?, ?, ?, 'open', ?, 'template', ?, ?)`,
        )
        .bind(id, ctx.employeeId, t.stageId, t.key, t.assignee, t.title, t.description, new Date(start + t.dueOffsetDays * DAY_MS).toISOString(), w.stamp, w.now),
      auditInsertWhen(w.db, w.audit("task.created", "task", id, { id, stageId: t.stageId, detail: { template: t.key } }), stamped("tasks", "id = ?", [id], w.stamp)),
    );
  }
  const results = await w.db.batch(statements);
  return { created: results.filter((r, i) => i % 2 === 0 && r.meta.changes > 0).length };
}

export async function runIntake(ctx: RunCtx): Promise<void> {
  const name = "intake.create-checklist";
  await ctx.step.do(name, CHECK_STEP, () => createChecklist(ctx, name));
  await runOp(ctx, "intake", "hr.create-worker");
}
