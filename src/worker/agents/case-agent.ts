// CaseAgent: one Agents SDK Durable Object per employee (name = employee id).
// It owns the commands that change a case (each one guarded D1 batch, ADR
// 0008), sends wake-ups to the workflow after commit (best effort, ADR 0002),
// keeps a read-only live projection of the case for WebSocket subscribers
// (ADR 0006), and reacts to workflow callbacks. Domain truth stays in D1
// (ADR 0001). Decisions come from deterministic rules, not from an LLM.
import { Agent } from "agents";
import type { CaseState } from "../../shared/agent-state.ts";
import { emptyCaseState } from "../../shared/agent-state.ts";
import type { EmployeeProfileDto } from "../../shared/api.ts";
import type { FixableField, WakeReason } from "../../shared/domain.ts";
import { auditIds, instanceId as buildInstanceId, userStamp } from "../../shared/ids.ts";
import { type StageId } from "../../shared/stages.ts";
import { parseConfig } from "../config.ts";
import { auditInsertWhen, type AuditInput, stamped } from "../db/audit.ts";
import { loadClock, type Clock } from "../db/clock.ts";
import { runGuarded } from "../db/guarded.ts";
import { getApproval, getBlocker, getEmployee, getTask, toApprovalView, toBlockerView, toTaskView } from "../db/repo.ts";
import type { Principal } from "../http.ts";
import { errorMessage, isEngineAbort } from "../integrations/errors.ts";
import { projectCase } from "./projection.ts";
import { Serial } from "./serial.ts";
import { SdkWorkflowControl, type WorkflowControl } from "./workflow-control.ts";

export type Cmd = { actor: Principal; requestId: string; idem: { actorEmail: string; key: string } | null };
// Bodies are plain JSON objects (they cross the DO RPC boundary and are stored as idempotent responses).
// biome-ignore lint: any keeps RPC stub typing serializable
export type CommandResult<T extends object = Record<string, any>> = { status: number; body: T };
export type Decision = { decision: "approve" | "reject"; reason?: string | undefined; privilegedAccessApproved?: boolean | undefined; onBehalfOf?: string | undefined };
export type ScanResult = { opened: number; autoResolved: number; nudged: number };

const WORKFLOW = "ONBOARDING_WORKFLOW" as const;

export const FIELD_COLUMNS: Record<FixableField, "cost_center" | "license_bundle" | "photo_on_file"> = {
  costCenter: "cost_center",
  licenseBundle: "license_bundle",
  photoOnFile: "photo_on_file",
};

function errorBody(code: string, message: string, requestId: string) {
  return { error: { code, message, requestId } };
}

type WorkflowEvent = { kind?: string; stage?: string; round?: number };

export class CaseAgent extends Agent<Env, CaseState> {
  override initialState: CaseState = emptyCaseState("");
  readonly #serial = new Serial();

  /** Replaceable in tests (for example to inject a restart refusal). */
  control: WorkflowControl = new SdkWorkflowControl(
    {
      runWorkflow: (name, params, options) => this.runWorkflow(name, params, options),
      restartWorkflow: (id) => this.restartWorkflow(id),
      terminateWorkflow: (id) => this.terminateWorkflow(id),
      getWorkflow: (id) => this.getWorkflow(id),
    },
    this.env.ONBOARDING_WORKFLOW,
  );

  override async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS scan_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      candidates INTEGER NOT NULL DEFAULT 0,
      opened INTEGER NOT NULL DEFAULT 0,
      resolved INTEGER NOT NULL DEFAULT 0,
      nudged INTEGER NOT NULL DEFAULT 0,
      wake_failures INTEGER NOT NULL DEFAULT 0,
      error TEXT
    )`;
  }

  // Live state is a read-only subscription (ADR 0006).
  override shouldConnectionBeReadonly(): boolean {
    return true;
  }

  override validateStateChange(_next: CaseState, source: unknown): void {
    if (source !== "server") throw new Error("CaseAgent state is read-only for clients");
  }

  get config() {
    return parseConfig(this.env);
  }

  protected clock(): Promise<Clock> {
    return loadClock(this.config, this.env.DB);
  }

  get employeeId(): string {
    return this.name;
  }

  // ---------------------------------------------------------------------------
  // Commands (DO RPC from the Hono routes). Each is one guarded D1 batch.
  // ---------------------------------------------------------------------------

  async startCase(cmd: Cmd): Promise<CommandResult<{ instanceId: string; created: boolean }>> {
    const db = this.env.DB;
    const id = this.employeeId;
    const clock = await this.clock();
    const now = clock.nowIso();
    const row = await db.prepare("SELECT workflow_instance_id, revision FROM cases WHERE employee_id = ?").bind(id).first<{ workflow_instance_id: string | null; revision: number }>();
    if (!row) return { status: 404, body: errorBody("not_found", "no case for this employee", cmd.requestId) as never };

    let instanceId = row.workflow_instance_id;
    if (!instanceId) {
      const candidate = buildInstanceId(id, row.revision);
      const stamp = userStamp(cmd.requestId);
      const { applied } = await runGuarded({
        db,
        mutation: db
          .prepare(
            `UPDATE cases SET workflow_instance_id = ?, status = 'in_progress', started_at = ?, updated_at = ?, last_mutation_id = ?
              WHERE employee_id = ? AND workflow_instance_id IS NULL`,
          )
          .bind(candidate, now, now, stamp, id),
        applied: stamped("cases", "employee_id = ?", [id], stamp),
        onApplied: (when) => [
          auditInsertWhen(db, this.#userAudit(cmd, now, "case.started", "case", id, { instanceId: candidate }), when),
        ],
      });
      instanceId = applied
        ? candidate
        : ((await db.prepare("SELECT workflow_instance_id FROM cases WHERE employee_id = ?").bind(id).first<{ workflow_instance_id: string }>())?.workflow_instance_id ?? candidate);
    }

    // Every call converges: create (or confirm) the instance, arm the scan, refresh.
    // A failed create is reported as 503 (the API releases the Idempotency-Key on 5xx),
    // so a retry, with the same key or a new one, creates the instance.
    let ensured: { created: boolean };
    try {
      ensured = await this.control.ensureInstance(instanceId, id);
    } catch (err) {
      if (isEngineAbort(err)) throw err;
      console.error(`ensureInstance ${instanceId}: ${errorMessage(err)}`);
      return { status: 503, body: errorBody("workflow_create_failed", "the workflow could not be created yet; retry", cmd.requestId) as never };
    }
    await this.scheduleEvery(this.config.blockerScanIntervalS, "scheduledScan");
    await this.refresh();
    // `created` reports whether this call created the workflow instance.
    return { status: 202, body: { instanceId, created: ensured.created } };
  }

  async completeTask(taskId: string, cmd: Cmd, note?: string): Promise<CommandResult> {
    const db = this.env.DB;
    const now = (await this.clock()).nowIso();
    const task = await getTask(db, taskId);
    if (!task || task.employee_id !== this.employeeId) return { status: 404, body: errorBody("not_found", "unknown task", cmd.requestId) };
    const stamp = userStamp(cmd.requestId);
    const applied = stamped("tasks", "id = ?", [taskId], stamp);
    const action = task.kind === "followup" ? "followup.completed" : "task.completed";
    const okBody = toTaskView({ ...task, status: "done", completed_at: now, completed_by: cmd.actor.email });
    const conflictBody = errorBody("task_not_open", `task is ${task.status}`, cmd.requestId);
    const result = await runGuarded({
      db,
      mutation: db
        .prepare("UPDATE tasks SET status = 'done', completed_at = ?, completed_by = ?, last_mutation_id = ? WHERE id = ? AND status = 'open'")
        .bind(now, cmd.actor.email, stamp, taskId),
      applied,
      onApplied: (when) => [
        ...(task.template_key === "badge_photo"
          ? [
              db
                .prepare(`UPDATE employees SET photo_on_file = 1, updated_at = ?, last_mutation_id = ? WHERE id = ? AND ${when.sql}`)
                .bind(now, stamp, task.employee_id, ...when.binds),
            ]
          : []),
        auditInsertWhen(db, this.#userAudit(cmd, now, action, "task", taskId, { note: note ?? null, kind: task.kind }, task.stage_id), when),
      ],
      onConflict: (when) => [auditInsertWhen(db, this.#userAudit(cmd, now, "task.completion_conflict", "task", taskId, { status: task.status }, task.stage_id), when)],
      ...(cmd.idem ? { idempotency: { ...cmd.idem, ok: { status: 200, body: okBody }, conflict: { status: 409, body: conflictBody } } } : {}),
    });
    if (result.applied && task.kind === "checklist") {
      const open = await db
        .prepare("SELECT COUNT(*) AS n FROM tasks WHERE employee_id = ? AND stage_id = ? AND kind = 'checklist' AND assignee = 'employee' AND status <> 'done'")
        .bind(task.employee_id, task.stage_id)
        .first<{ n: number }>();
      if ((open?.n ?? 1) === 0) await this.wake(task.stage_id as StageId, "tasks_done", taskId);
    }
    await this.refresh();
    return result.applied ? { status: 200, body: okBody } : { status: 409, body: conflictBody };
  }

  async decideApproval(approvalId: string, decision: Decision, cmd: Cmd): Promise<CommandResult> {
    const db = this.env.DB;
    const now = (await this.clock()).nowIso();
    const approval = await getApproval(db, approvalId);
    if (!approval || approval.employee_id !== this.employeeId) return { status: 404, body: errorBody("not_found", "unknown approval", cmd.requestId) };
    const status = decision.decision === "approve" ? "approved" : "rejected";
    const request = JSON.parse(approval.request_json) as { needsPrivilegedAccess?: boolean };
    const needsPriv = approval.checkpoint === "manager_approval" && request.needsPrivilegedAccess === true;
    const priv = status === "approved" && needsPriv ? (decision.privilegedAccessApproved ? 1 : 0) : null;
    const stamp = userStamp(cmd.requestId);
    const okBody = toApprovalView({
      ...approval,
      status,
      decided_at: now,
      decided_by: cmd.actor.email,
      decided_on_behalf_of: decision.onBehalfOf ?? null,
      reason: decision.reason ?? null,
      privileged_access_approved: priv,
    });
    const conflictBody = errorBody("approval_not_pending", `approval is ${approval.status}`, cmd.requestId);
    const detail = { decision: status, reason: decision.reason ?? null, onBehalfOf: decision.onBehalfOf ?? null, privilegedAccessApproved: priv };
    const result = await runGuarded({
      db,
      mutation: db
        .prepare(
          `UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, decided_on_behalf_of = ?, reason = ?, privileged_access_approved = ?, last_mutation_id = ?
            WHERE id = ? AND status = 'pending'`,
        )
        .bind(status, now, cmd.actor.email, decision.onBehalfOf ?? null, decision.reason ?? null, priv, stamp, approvalId),
      applied: stamped("approvals", "id = ?", [approvalId], stamp),
      onApplied: (when) => [
        auditInsertWhen(db, { ...this.#userAudit(cmd, now, status === "approved" ? "approval.approved" : "approval.rejected", "approval", approvalId, detail, approval.stage_id), round: approval.round }, when),
      ],
      onConflict: (when) => [
        auditInsertWhen(db, { ...this.#userAudit(cmd, now, "approval.decision_conflict", "approval", approvalId, { attempted: status, current: approval.status }, approval.stage_id), round: approval.round }, when),
      ],
      ...(cmd.idem ? { idempotency: { ...cmd.idem, ok: { status: 200, body: okBody }, conflict: { status: 409, body: conflictBody } } } : {}),
    });
    if (result.applied) await this.wake(approval.stage_id as StageId, "approval_decided", approvalId);
    await this.refresh();
    return result.applied ? { status: 200, body: okBody } : { status: 409, body: conflictBody };
  }

  async resubmitApproval(approvalId: string, cmd: Cmd, note?: string): Promise<CommandResult> {
    const db = this.env.DB;
    const now = (await this.clock()).nowIso();
    const approval = await getApproval(db, approvalId);
    if (!approval || approval.employee_id !== this.employeeId) return { status: 404, body: errorBody("not_found", "unknown approval", cmd.requestId) };
    const stamp = userStamp(cmd.requestId);
    const newRound = approval.round + 1;
    const conflictBody = errorBody("not_revision_requested", "the stage is not awaiting a resubmission for this round", cmd.requestId);
    const result = await runGuarded({
      db,
      mutation: db
        .prepare(
          `UPDATE case_stages SET status = 'awaiting_approval', round = round + 1, updated_at = ?, last_mutation_id = ?
            WHERE employee_id = ? AND stage_id = ? AND status = 'revision_requested' AND round = ?`,
        )
        .bind(now, stamp, approval.employee_id, approval.stage_id, approval.round),
      applied: stamped("case_stages", "employee_id = ? AND stage_id = ?", [approval.employee_id, approval.stage_id], stamp),
      onApplied: (when) => [
        db.prepare(`UPDATE cases SET status = 'awaiting_approval', updated_at = ? WHERE employee_id = ? AND status NOT IN ('complete','failed') AND ${when.sql}`).bind(now, approval.employee_id, ...when.binds),
        auditInsertWhen(db, { ...this.#userAudit(cmd, now, "approval.resubmitted", "approval", approvalId, { note: note ?? null, newRound }, approval.stage_id), round: newRound }, when),
      ],
      onConflict: (when) => [
        auditInsertWhen(db, { ...this.#userAudit(cmd, now, "approval.resubmit_rejected", "approval", approvalId, {}, approval.stage_id), round: approval.round }, when),
      ],
      ...(cmd.idem ? { idempotency: { ...cmd.idem, ok: { status: 202, body: { round: newRound } }, conflict: { status: 409, body: conflictBody } } } : {}),
    });
    if (result.applied) await this.wake(approval.stage_id as StageId, "resubmitted", approvalId);
    await this.refresh();
    return result.applied ? { status: 202, body: { round: newRound } } : { status: 409, body: conflictBody };
  }

  async retryStage(stageId: StageId, cmd: Cmd, note?: string): Promise<CommandResult> {
    const db = this.env.DB;
    const id = this.employeeId;
    const now = (await this.clock()).nowIso();
    const st = await db.prepare("SELECT status, round FROM case_stages WHERE employee_id = ? AND stage_id = ?").bind(id, stageId).first<{ status: string; round: number }>();
    if (!st) return { status: 404, body: errorBody("not_found", "unknown stage", cmd.requestId) };
    const stamp = userStamp(cmd.requestId);
    const newRound = st.round + 1;
    const conflictBody = errorBody("stage_not_blocked", `stage is ${st.status}`, cmd.requestId);
    const result = await runGuarded({
      db,
      mutation: db
        .prepare(
          `UPDATE case_stages SET status = 'active', round = round + 1, updated_at = ?, last_mutation_id = ?
            WHERE employee_id = ? AND stage_id = ? AND status = 'blocked' AND round = ?`,
        )
        .bind(now, stamp, id, stageId, st.round),
      applied: stamped("case_stages", "employee_id = ? AND stage_id = ?", [id, stageId], stamp),
      onApplied: (when) => [
        db.prepare(`UPDATE cases SET status = 'in_progress', updated_at = ? WHERE employee_id = ? AND status = 'blocked' AND ${when.sql}`).bind(now, id, ...when.binds),
        auditInsertWhen(db, { ...this.#userAudit(cmd, now, "stage.retry_requested", "stage", `${id}:${stageId}`, { note: note ?? null, newRound }, stageId), round: newRound }, when),
      ],
      onConflict: (when) => [
        auditInsertWhen(db, { ...this.#userAudit(cmd, now, "stage.retry_rejected", "stage", `${id}:${stageId}`, { status: st.status }, stageId), round: st.round }, when),
      ],
      ...(cmd.idem ? { idempotency: { ...cmd.idem, ok: { status: 202, body: { round: newRound } }, conflict: { status: 409, body: conflictBody } } } : {}),
    });
    if (result.applied) await this.wake(stageId, "retry_requested");
    await this.refresh();
    return result.applied ? { status: 202, body: { round: newRound } } : { status: 409, body: conflictBody };
  }

  async fixField(field: FixableField, value: string | boolean, cmd: Cmd): Promise<CommandResult> {
    const db = this.env.DB;
    const id = this.employeeId;
    const now = (await this.clock()).nowIso();
    const before = await getEmployee(db, id);
    if (!before) return { status: 404, body: errorBody("not_found", "unknown employee", cmd.requestId) };
    const col = FIELD_COLUMNS[field];
    const beforeValue = before[field];
    const sqlValue = typeof value === "boolean" ? (value ? 1 : 0) : value;
    const sqlBefore = typeof beforeValue === "boolean" ? (beforeValue ? 1 : 0) : beforeValue;
    const stamp = userStamp(cmd.requestId);
    const after: EmployeeProfileDto = { ...before, [field]: value } as EmployeeProfileDto;
    const conflictBody = errorBody("field_changed", "the field changed concurrently; reload and retry", cmd.requestId);
    const result = await runGuarded({
      db,
      mutation: db
        .prepare(`UPDATE employees SET ${col} = ?, updated_at = ?, last_mutation_id = ? WHERE id = ? AND ${col} = ?`)
        .bind(sqlValue, now, stamp, id, sqlBefore),
      applied: stamped("employees", "id = ?", [id], stamp),
      onApplied: (when) => [
        auditInsertWhen(db, this.#userAudit(cmd, now, "employee.field_corrected", "employee", id, { field, before: beforeValue, after: value }), when),
      ],
      ...(cmd.idem ? { idempotency: { ...cmd.idem, ok: { status: 200, body: after }, conflict: { status: 409, body: conflictBody } } } : {}),
    });
    await this.refresh();
    return result.applied ? { status: 200, body: after } : { status: 409, body: conflictBody };
  }

  async resolveBlocker(blockerId: string, resolution: string, cmd: Cmd): Promise<CommandResult> {
    const db = this.env.DB;
    const now = (await this.clock()).nowIso();
    const blocker = await getBlocker(db, blockerId);
    if (!blocker || blocker.employee_id !== this.employeeId) return { status: 404, body: errorBody("not_found", "unknown blocker", cmd.requestId) };
    const stamp = userStamp(cmd.requestId);
    const okBody = toBlockerView({ ...blocker, status: "resolved", resolved_at: now, resolved_by: cmd.actor.email, resolution });
    const conflictBody = errorBody("blocker_not_open", `blocker is ${blocker.status}`, cmd.requestId);
    const result = await runGuarded({
      db,
      mutation: db
        .prepare("UPDATE blockers SET status = 'resolved', resolved_at = ?, resolved_by = ?, resolution = ?, last_mutation_id = ? WHERE id = ? AND status = 'open'")
        .bind(now, cmd.actor.email, resolution, stamp, blockerId),
      applied: stamped("blockers", "id = ?", [blockerId], stamp),
      onApplied: (when) => [
        db.prepare(`UPDATE tasks SET status = 'cancelled', last_mutation_id = ? WHERE blocker_id = ? AND status = 'open' AND ${when.sql}`).bind(stamp, blockerId, ...when.binds),
        auditInsertWhen(db, this.#userAudit(cmd, now, "blocker.resolved", "blocker", blockerId, { resolution, kind: blocker.kind }, blocker.stage_id), when),
      ],
      ...(cmd.idem ? { idempotency: { ...cmd.idem, ok: { status: 200, body: okBody }, conflict: { status: 409, body: conflictBody } } } : {}),
    });
    await this.refresh();
    return result.applied ? { status: 200, body: okBody } : { status: 409, body: conflictBody };
  }

  async restartCase(reason: string, cmd: Cmd): Promise<CommandResult> {
    const db = this.env.DB;
    const id = this.employeeId;
    const now = (await this.clock()).nowIso();
    const c = await db.prepare("SELECT workflow_instance_id, run_no FROM cases WHERE employee_id = ?").bind(id).first<{ workflow_instance_id: string | null; run_no: number }>();
    if (!c) return { status: 404, body: errorBody("not_found", "no case", cmd.requestId) };
    if (!c.workflow_instance_id) return { status: 409, body: errorBody("not_started", "the case has not started", cmd.requestId) };
    const stamp = userStamp(cmd.requestId);
    const runNo = c.run_no + 1;
    const conflictBody = errorBody("restart_conflict", "the case changed concurrently", cmd.requestId);
    const result = await runGuarded({
      db,
      mutation: db
        .prepare(
          `UPDATE cases SET run_no = run_no + 1, status = 'in_progress', failure_reason = NULL, completed_at = NULL, updated_at = ?, last_mutation_id = ?
            WHERE employee_id = ? AND run_no = ? AND workflow_instance_id IS NOT NULL`,
        )
        .bind(now, stamp, id, c.run_no),
      applied: stamped("cases", "employee_id = ?", [id], stamp),
      onApplied: (when) => [
        // A failed stage gets another go on the new run; complete stages stay complete.
        db.prepare(`UPDATE case_stages SET status = 'active', updated_at = ? WHERE employee_id = ? AND status = 'failed' AND ${when.sql}`).bind(now, id, ...when.binds),
        auditInsertWhen(db, { ...this.#userAudit(cmd, now, "case.restarted", "case", id, { reason, instanceId: c.workflow_instance_id }), runNo }, when),
      ],
    });
    if (!result.applied) return { status: 409, body: conflictBody };

    let instanceId = c.workflow_instance_id;
    try {
      await this.control.restart(instanceId);
    } catch (err) {
      if (isEngineAbort(err)) throw err;
      instanceId = await this.#newRevision(instanceId, cmd, errorMessage(err));
    }
    await this.scheduleEvery(this.config.blockerScanIntervalS, "scheduledScan");
    await this.refresh();
    return { status: 202, body: { runNo, instanceId } };
  }

  /** Restart refused by the platform: create a new instance id (revision + 1). Operations replay by key. */
  async #newRevision(oldInstanceId: string, cmd: Cmd, cause: string): Promise<string> {
    const db = this.env.DB;
    const id = this.employeeId;
    const now = (await this.clock()).nowIso();
    const row = await db.prepare("SELECT revision FROM cases WHERE employee_id = ?").bind(id).first<{ revision: number }>();
    const revision = (row?.revision ?? 1) + 1;
    const next = buildInstanceId(id, revision);
    const stamp = `${userStamp(cmd.requestId)}:revision`;
    const { applied } = await runGuarded({
      db,
      mutation: db
        .prepare("UPDATE cases SET revision = revision + 1, workflow_instance_id = ?, updated_at = ?, last_mutation_id = ? WHERE employee_id = ? AND workflow_instance_id = ?")
        .bind(next, now, stamp, id, oldInstanceId),
      applied: stamped("cases", "employee_id = ?", [id], stamp),
      onApplied: (when) => [
        auditInsertWhen(db, this.#userAudit(cmd, now, "case.revision_created", "case", id, { from: oldInstanceId, to: next, cause }), when),
      ],
    });
    const current = applied
      ? next
      : ((await db.prepare("SELECT workflow_instance_id FROM cases WHERE employee_id = ?").bind(id).first<{ workflow_instance_id: string }>())?.workflow_instance_id ?? next);
    await this.control.ensureInstance(current, id);
    return current;
  }

  async terminateCase(reason: string, cmd: Cmd): Promise<CommandResult> {
    const db = this.env.DB;
    const id = this.employeeId;
    const now = (await this.clock()).nowIso();
    const c = await db.prepare("SELECT workflow_instance_id, status FROM cases WHERE employee_id = ?").bind(id).first<{ workflow_instance_id: string | null; status: string }>();
    if (!c) return { status: 404, body: errorBody("not_found", "no case", cmd.requestId) };
    const stamp = userStamp(cmd.requestId);
    const okBody = { status: "failed", failureReason: "terminated" };
    const conflictBody = errorBody("case_finished", `case is ${c.status}`, cmd.requestId);
    const result = await runGuarded({
      db,
      mutation: db
        .prepare(
          `UPDATE cases SET status = 'failed', failure_reason = 'terminated', updated_at = ?, last_mutation_id = ?
            WHERE employee_id = ? AND status NOT IN ('complete','failed') AND workflow_instance_id IS NOT NULL`,
        )
        .bind(now, stamp, id),
      applied: stamped("cases", "employee_id = ?", [id], stamp),
      onApplied: (when) => [auditInsertWhen(db, this.#userAudit(cmd, now, "case.terminated", "case", id, { reason }), when)],
      ...(cmd.idem ? { idempotency: { ...cmd.idem, ok: { status: 202, body: okBody }, conflict: { status: 409, body: conflictBody } } } : {}),
    });
    if (result.applied && c.workflow_instance_id) {
      try {
        await this.control.terminate(c.workflow_instance_id);
      } catch (err) {
        console.warn(`terminate ${c.workflow_instance_id}: ${errorMessage(err)}`);
      }
    }
    await this.refresh();
    return result.applied ? { status: 202, body: okBody } : { status: 409, body: conflictBody };
  }

  async scanNow(_cmd: Cmd): Promise<CommandResult<ScanResult>> {
    return { status: 200, body: await this.scanBlockers() };
  }

  // ---------------------------------------------------------------------------
  // Wake-ups, scans, projection
  // ---------------------------------------------------------------------------

  /** Best-effort wake-up after commit. Never throws; gates re-check D1 either way (ADR 0002). */
  async wake(stage: StageId, reason: WakeReason, ref?: string): Promise<boolean> {
    try {
      const row = await this.env.DB.prepare(
        "SELECT c.workflow_instance_id, cs.round FROM cases c JOIN case_stages cs ON cs.employee_id = c.employee_id WHERE c.employee_id = ? AND cs.stage_id = ?",
      )
        .bind(this.employeeId, stage)
        .first<{ workflow_instance_id: string | null; round: number }>();
      if (!row?.workflow_instance_id) return false;
      await this.sendWorkflowEvent(WORKFLOW, row.workflow_instance_id, {
        type: `wake_${stage}`,
        payload: { round: row.round, reason, ...(ref ? { ref } : {}) },
      });
      const now = (await this.clock()).nowIso();
      await this.env.DB.prepare("UPDATE case_stages SET last_wake_at = ? WHERE employee_id = ? AND stage_id = ?").bind(now, this.employeeId, stage).run();
      return true;
    } catch (err) {
      console.warn(`wake ${this.employeeId}/${stage} failed: ${errorMessage(err)}`);
      this.#recordWakeFailure();
      return false;
    }
  }

  #recordWakeFailure() {
    try {
      const now = new Date().toISOString();
      this.sql`INSERT INTO scan_runs (started_at, finished_at, wake_failures) VALUES (${now}, ${now}, 1)`;
    } catch {
      // observability only
    }
  }

  /** Blocker detection and follow-ups arrive with the rule engine; until then a scan only refreshes. */
  async scanBlockers(): Promise<ScanResult> {
    return this.#serial.run(async () => {
      await this.#refreshNow();
      return { opened: 0, autoResolved: 0, nudged: 0 };
    });
  }

  async scheduledScan(): Promise<void> {
    try {
      await this.scanBlockers();
      const c = await this.env.DB.prepare("SELECT status FROM cases WHERE employee_id = ?").bind(this.employeeId).first<{ status: string }>();
      if (c && (c.status === "complete" || c.status === "failed")) await this.#cancelScanSchedule();
    } catch (err) {
      console.error(`scheduled scan ${this.employeeId}: ${errorMessage(err)}`);
    }
  }

  async #cancelScanSchedule(): Promise<number> {
    let n = 0;
    for (const s of await this.listSchedules({ type: "interval" })) {
      if (s.callback === "scheduledScan" && (await this.cancelSchedule(s.id))) n++;
    }
    return n;
  }

  /** Recompute CaseState from D1 (serialized). */
  refresh(): Promise<CaseState> {
    return this.#serial.run(() => this.#refreshNow());
  }

  async #refreshNow(): Promise<CaseState> {
    const c = await this.env.DB.prepare("SELECT workflow_instance_id FROM cases WHERE employee_id = ?").bind(this.employeeId).first<{ workflow_instance_id: string | null }>();
    const wfStatus = c?.workflow_instance_id ? ((this.getWorkflow(c.workflow_instance_id) as { status?: string } | undefined)?.status ?? null) : null;
    const next = await projectCase(this.env.DB, this.employeeId, wfStatus, new Date().toISOString());
    if (next) this.applyProjection(next);
    return this.state;
  }

  /** Applies a projection unless it is older than the current state (monotonic asOfSeq). */
  applyProjection(next: CaseState): boolean {
    const current = this.state;
    if (current && current.employeeId === next.employeeId && next.asOfSeq < current.asOfSeq) return false;
    this.setState(next);
    return true;
  }

  getSnapshot(): CaseState {
    return this.state;
  }

  async currentInstanceId(): Promise<string | null> {
    const c = await this.env.DB.prepare("SELECT workflow_instance_id FROM cases WHERE employee_id = ?").bind(this.employeeId).first<{ workflow_instance_id: string | null }>();
    return c?.workflow_instance_id ?? null;
  }

  /** Eval hook: drop the object (SPEC 9); the next call re-wakes it with persisted state intact. */
  devEvict(): void {
    this.ctx.abort("eval-evict");
  }

  // ---------------------------------------------------------------------------
  // Workflow callbacks (SDK). None of these may throw: an exception in an SDK
  // callback step runs under the platform default retry policy.
  // ---------------------------------------------------------------------------

  override async onWorkflowEvent(_name: string, instanceId: string, event: unknown): Promise<void> {
    try {
      if (instanceId !== (await this.currentInstanceId())) return;
      const e = (event ?? {}) as WorkflowEvent;
      if (e.kind === "stage_blocked" || e.kind === "stage_completed" || e.kind === "revision_requested") {
        await this.scanBlockers();
      } else {
        await this.refresh();
      }
    } catch (err) {
      console.error(`onWorkflowEvent ${this.employeeId}: ${errorMessage(err)}`);
      try {
        await this.schedule(1, "scheduledScan");
      } catch {
        // nothing else to do
      }
    }
  }

  override async onWorkflowProgress(_name: string, instanceId: string, _progress: unknown): Promise<void> {
    try {
      if (instanceId !== (await this.currentInstanceId())) return;
      await this.refresh();
    } catch (err) {
      console.error(`onWorkflowProgress ${this.employeeId}: ${errorMessage(err)}`);
    }
  }

  override async onWorkflowComplete(_name: string, instanceId: string): Promise<void> {
    try {
      if (instanceId !== (await this.currentInstanceId())) return;
      await this.refresh();
      await this.#cancelScanSchedule();
    } catch (err) {
      console.error(`onWorkflowComplete ${this.employeeId}: ${errorMessage(err)}`);
    }
  }

  override async onWorkflowError(_name: string, instanceId: string, error: string): Promise<void> {
    try {
      if (instanceId !== (await this.currentInstanceId())) return;
      // The local engine aborts with "Aborting engine: ..." on restart, terminate,
      // pause and delete; AgentWorkflow forwards those unfiltered. Not a failure.
      if (isEngineAbort(error)) return;
      await this.schedule(5, "confirmWorkflowFailure", { instanceId, error });
    } catch (err) {
      console.error(`onWorkflowError ${this.employeeId}: ${errorMessage(err)}`);
    }
  }

  /** Marks the case failed only if the platform confirms the instance errored. */
  async confirmWorkflowFailure(payload: { instanceId: string; error: string }): Promise<void> {
    await this.#serial.run(async () => {
      try {
        if (payload.instanceId !== (await this.currentInstanceId())) return;
        const status = await this.control.status(payload.instanceId);
        if (status !== "errored") return;
        const db = this.env.DB;
        const now = (await this.clock()).nowIso();
        const stamp = `ag:${this.employeeId}:confirm-failure:${payload.instanceId}:${now}`;
        await runGuarded({
          db,
          mutation: db
            .prepare("UPDATE cases SET status = 'failed', failure_reason = 'workflow_error', updated_at = ?, last_mutation_id = ? WHERE employee_id = ? AND status NOT IN ('complete','failed')")
            .bind(now, stamp, this.employeeId),
          applied: stamped("cases", "employee_id = ?", [this.employeeId], stamp),
          onApplied: (when) => [
            auditInsertWhen(
              db,
              {
                id: auditIds.agent(this.employeeId, "case.failed", `${payload.instanceId}:${now}`),
                occurredAt: now,
                actorType: "agent",
                actorId: `case-agent/${this.employeeId}`,
                action: "case.failed",
                entityType: "case",
                entityId: this.employeeId,
                employeeId: this.employeeId,
                detail: { failureReason: "workflow_error", error: payload.error.slice(0, 500), instanceId: payload.instanceId },
              },
              when,
            ),
          ],
        });
        await this.#refreshNow();
      } catch (err) {
        console.error(`confirmWorkflowFailure ${this.employeeId}: ${errorMessage(err)}`);
      }
    });
  }

  // ---------------------------------------------------------------------------

  #userAudit(cmd: Cmd, now: string, action: AuditInput["action"], entityType: string, entityId: string, detail: Record<string, unknown>, stageId?: string): AuditInput {
    return {
      id: auditIds.user(cmd.requestId, action),
      occurredAt: now,
      actorType: "user",
      actorId: cmd.actor.email,
      actorRole: cmd.actor.role,
      action,
      entityType,
      entityId,
      employeeId: this.employeeId,
      stageId: stageId ?? null,
      requestId: cmd.requestId,
      detail,
    };
  }
}
