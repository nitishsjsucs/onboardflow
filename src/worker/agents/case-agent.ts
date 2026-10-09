// CaseAgent: one Agents SDK Durable Object per employee (name = employee id).
// It owns the commands that change a case (each one guarded D1 batch, ADR
// 0008), sends wake-ups to the workflow after commit (best effort, ADR 0002),
// keeps a read-only live projection of the case for WebSocket subscribers
// (ADR 0006), and reacts to workflow callbacks. Domain truth stays in D1
// (ADR 0001). Decisions come from deterministic rules, not from an LLM.
import { Agent, type Connection, type ConnectionContext, getAgentByName } from "agents";
import type { CaseState } from "../../shared/agent-state.ts";
import { emptyCaseState } from "../../shared/agent-state.ts";
import type { EmployeeProfileDto } from "../../shared/api.ts";
import type { FixableField, WakeReason } from "../../shared/domain.ts";
import { auditIds, blockerId, instanceId as buildInstanceId, userStamp } from "../../shared/ids.ts";
import { type StageId } from "../../shared/stages.ts";
import { parseConfig } from "../config.ts";
import { auditInsertWhen, type AuditInput, stamped } from "../db/audit.ts";
import { openBlockerStatements } from "../db/blockers.ts";
import { loadClock, type Clock } from "../db/clock.ts";
import { replaceStoredResponse, runGuarded } from "../db/guarded.ts";
import { getApproval, getBlocker, getEmployee, getTask, toApprovalView, toBlockerView, toTaskView } from "../db/repo.ts";
import type { Principal } from "../http.ts";
import { canSubscribe } from "../auth/policy.ts";
import { errorMessage, isEngineAbort } from "../integrations/errors.ts";
import { createLlmProvider } from "../llm/provider.ts";
import { detectBlockers, nudgeTargets, resolvedBlockers } from "./blocker-rules.ts";
import { FollowUpDrafter } from "./followups.ts";
import { HUB_NAME } from "./ops-hub-agent.ts";
import { loadScanSnapshot, projectCase } from "./projection.ts";
import { Serial } from "./serial.ts";
import { rememberSubscriber, revokeStaleSubscriptions } from "./subscriptions.ts";
import { SdkWorkflowControl, type WorkflowControl } from "./workflow-control.ts";

export type Cmd = { actor: Principal; requestId: string; idem: { actorEmail: string; key: string } | null };
// Bodies are plain JSON objects (they cross the DO RPC boundary and are stored as idempotent responses).
// biome-ignore lint: any keeps RPC stub typing serializable
export type CommandResult<T extends object = Record<string, any>> = { status: number; body: T };
export type Decision = { decision: "approve" | "reject"; reason?: string | undefined; privilegedAccessApproved?: boolean | undefined; onBehalfOf?: string | undefined };
export type ScanResult = { opened: number; autoResolved: number; nudged: number };

const WORKFLOW = "ONBOARDING_WORKFLOW" as const;
/** A restart whose workflow control failed after its commit is retried after 2, 4, 8, 16 and 32 s. */
const RESTART_RETRY_BASE_S = 2;
const RESTART_RETRY_ATTEMPTS = 5;
type RestartRetry = { runNo: number; fromInstanceId: string; actor: Principal; requestId: string; attempt: number };

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

  // Remember who subscribed, so later state pushes can re-check them (agents/subscriptions.ts).
  override onConnect(connection: Connection, ctx: ConnectionContext): void {
    rememberSubscriber(connection, ctx.request);
  }

  /** Closes live subscriptions whose session expired or whose account may no longer see this case. */
  async revokeStaleSubscriptions(): Promise<number> {
    const connections = [...this.getConnections()];
    if (connections.length === 0) return 0;
    const ref = await this.env.DB.prepare("SELECT id, manager_id FROM employees WHERE id = ?").bind(this.employeeId).first<{ id: string; manager_id: string }>();
    return revokeStaleSubscriptions(connections, this.env.DB, Date.now(), (p) => ref !== null && canSubscribe(p, "CASE_AGENT", this.employeeId, { employeeId: ref.id, managerId: ref.manager_id }));
  }

  // OnboardFlow uses no sub-agents: refuse every `/sub/<class>/<name>` facet
  // request, so no client can create a facet (defense in depth behind the
  // path check in routes/agents.ts).
  override async onBeforeSubAgent(): Promise<Response> {
    return new Response("Not found", { status: 404 });
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

  /** `limits` (tighter workflow loop bounds) is honored by the workflow only when EVAL_HOOKS=on. */
  async startCase(cmd: Cmd, limits?: Record<string, number>): Promise<CommandResult<{ instanceId: string; created: boolean }>> {
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
      ensured = await this.control.ensureInstance(instanceId, id, limits);
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
    // The manager approves a request that names the license bundle (approvals.request_json), and the IT step
    // provisions the bundle on the employee row. Once that approval has been requested, the bundle may change
    // only as the correction of an open data_issue blocker on it (the simulated IT system rejected the value);
    // any other change would provision something the manager never saw. Checked inside the guarded UPDATE.
    const approvedGuard =
      field === "licenseBundle"
        ? {
            sql: ` AND (NOT EXISTS (SELECT 1 FROM approvals WHERE employee_id = ? AND checkpoint = 'manager_approval')
                    OR EXISTS (SELECT 1 FROM blockers WHERE employee_id = ? AND kind = 'data_issue' AND status = 'open' AND json_extract(detail_json, '$.field') = 'licenseBundle'))`,
            binds: [id, id],
          }
        : { sql: "", binds: [] };
    if (approvedGuard.sql) {
      const locked = await db
        .prepare(`SELECT 1 AS locked WHERE NOT (1 = 1${approvedGuard.sql})`)
        .bind(...approvedGuard.binds)
        .first<{ locked: number }>();
      if (locked) {
        const lockedBody = errorBody("field_locked_by_approval", "the license bundle was part of the manager's approval request; it can change only to correct an open data issue", cmd.requestId);
        return { status: 409, body: lockedBody };
      }
    }
    const result = await runGuarded({
      db,
      mutation: db
        .prepare(`UPDATE employees SET ${col} = ?, updated_at = ?, last_mutation_id = ? WHERE id = ? AND ${col} = ?${approvedGuard.sql}`)
        .bind(sqlValue, now, stamp, id, sqlBefore, ...approvedGuard.binds),
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
    const c = await db
      .prepare("SELECT workflow_instance_id, run_no, status, failure_reason FROM cases WHERE employee_id = ?")
      .bind(id)
      .first<{ workflow_instance_id: string | null; run_no: number; status: string; failure_reason: string | null }>();
    if (!c) return { status: 404, body: errorBody("not_found", "no case", cmd.requestId) };
    if (!c.workflow_instance_id) return { status: 409, body: errorBody("not_started", "the case has not started", cmd.requestId) };
    const stamp = userStamp(cmd.requestId);
    const runNo = c.run_no + 1;
    const conflictBody = errorBody("restart_conflict", "the case changed concurrently", cmd.requestId);
    // A case that ended on its final approval rejection is restarted into one more approval round:
    // the rejected round stays rejected, so re-running it would only fail the case again (SPEC 6.1).
    const reopen =
      c.status === "failed" && c.failure_reason === "approval_rejected_final"
        ? await db
            .prepare("SELECT stage_id, round FROM case_stages WHERE employee_id = ? AND status = 'failed' AND stage_id IN ('manager_approval','closeout')")
            .bind(id)
            .first<{ stage_id: StageId; round: number }>()
        : null;
    // The response is stored in the restart's own batch (SPEC 9), so a retry with the same key replays
    // it instead of restarting a second time. Workflow control runs after the commit and converges.
    const okBody = { runNo, instanceId: c.workflow_instance_id };
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
        ...(reopen
          ? [
              db
                .prepare(
                  `UPDATE case_stages SET round = round + 1, status = 'active', updated_at = ?
                    WHERE employee_id = ? AND stage_id = ? AND round = ? AND status = 'failed'
                      AND EXISTS (SELECT 1 FROM approvals WHERE employee_id = ? AND stage_id = ? AND round = ? AND status = 'rejected') AND ${when.sql}`,
                )
                .bind(now, id, reopen.stage_id, reopen.round, id, reopen.stage_id, reopen.round, ...when.binds),
            ]
          : []),
        // A failed stage gets another go on the new run; complete stages stay complete.
        db.prepare(`UPDATE case_stages SET status = 'active', updated_at = ? WHERE employee_id = ? AND status = 'failed' AND ${when.sql}`).bind(now, id, ...when.binds),
        auditInsertWhen(
          db,
          {
            ...this.#userAudit(cmd, now, "case.restarted", "case", id, {
              reason,
              instanceId: c.workflow_instance_id,
              ...(reopen ? { reopenedApproval: { stageId: reopen.stage_id, round: reopen.round + 1 } } : {}),
            }),
            runNo,
          },
          when,
        ),
      ],
      ...(cmd.idem ? { idempotency: { ...cmd.idem, ok: { status: 202, body: okBody }, conflict: { status: 409, body: conflictBody } } } : {}),
    });
    if (!result.applied) return { status: 409, body: conflictBody };

    const instanceId = await this.#applyRestart(c.workflow_instance_id, runNo, cmd);
    if (instanceId !== okBody.instanceId && cmd.idem) {
      // The platform refused the restart and a new revision took over: replay the instance that runs.
      await replaceStoredResponse(db, cmd.idem, { status: 202, body: okBody }, { status: 202, body: { runNo, instanceId } }).catch((err: unknown) =>
        console.warn(`restart ${id}: stored response not updated: ${errorMessage(err)}`),
      );
    }
    await this.scheduleEvery(this.config.blockerScanIntervalS, "scheduledScan");
    await this.refresh();
    return { status: 202, body: { runNo, instanceId } };
  }

  /**
   * Workflow control after a committed restart. Never throws (except an engine abort): a failure is
   * logged and retried by convergeRestart on a schedule, because the restart is already committed
   * and its response stored, so the API must not release the key and let a retry restart twice.
   */
  async #applyRestart(fromInstanceId: string, runNo: number, cmd: Cmd): Promise<string> {
    try {
      await this.control.restart(fromInstanceId);
      return fromInstanceId;
    } catch (err) {
      if (isEngineAbort(err)) throw err;
      try {
        return await this.#newRevision(fromInstanceId, cmd, errorMessage(err));
      } catch (second) {
        if (isEngineAbort(second)) throw second;
        console.error(`restart ${this.employeeId} run ${runNo}: ${errorMessage(second)}; retrying on a schedule`);
        await this.#scheduleRestartRetry({ runNo, fromInstanceId, actor: cmd.actor, requestId: cmd.requestId, attempt: 1 });
        return (await this.currentInstanceId()) ?? fromInstanceId;
      }
    }
  }

  async #scheduleRestartRetry(p: RestartRetry): Promise<void> {
    await this.schedule(RESTART_RETRY_BASE_S * 2 ** (p.attempt - 1), "convergeRestart", p);
  }

  /**
   * Scheduled: finishes a committed restart whose workflow control failed. Does nothing once the case
   * has moved on (a later restart, or the case finished). If a new revision was already recorded, its
   * instance is created; otherwise the restart is tried again, with the same new-revision fallback.
   */
  async convergeRestart(p: RestartRetry): Promise<void> {
    try {
      const c = await this.env.DB.prepare("SELECT run_no, status, workflow_instance_id FROM cases WHERE employee_id = ?")
        .bind(this.employeeId)
        .first<{ run_no: number; status: string; workflow_instance_id: string | null }>();
      if (!c?.workflow_instance_id || c.run_no !== p.runNo || c.status === "complete" || c.status === "failed") return;
      if (c.workflow_instance_id !== p.fromInstanceId) {
        await this.control.ensureInstance(c.workflow_instance_id, this.employeeId);
      } else {
        const cmd: Cmd = { actor: p.actor, requestId: p.requestId, idem: null };
        try {
          await this.control.restart(p.fromInstanceId);
        } catch (err) {
          if (isEngineAbort(err)) throw err;
          await this.#newRevision(p.fromInstanceId, cmd, errorMessage(err));
        }
      }
      await this.refresh();
    } catch (err) {
      if (isEngineAbort(err)) throw err;
      if (p.attempt >= RESTART_RETRY_ATTEMPTS) {
        console.error(`restart ${this.employeeId} run ${p.runNo}: giving up after ${p.attempt} attempts: ${errorMessage(err)}`);
        return;
      }
      console.warn(`restart ${this.employeeId} run ${p.runNo}, attempt ${p.attempt}: ${errorMessage(err)}`);
      await this.#scheduleRestartRetry({ ...p, attempt: p.attempt + 1 });
    }
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

  /** Replaceable in tests (for example a slow drafter to force interleaving). */
  drafter: FollowUpDrafter | null = null;

  #drafter(): FollowUpDrafter {
    if (!this.drafter) this.drafter = new FollowUpDrafter(createLlmProvider(this.config, this.env));
    return this.drafter;
  }

  /**
   * Scan (serialized): open blockers and follow-ups for new rule candidates,
   * auto-resolve blockers whose condition cleared, nudge waiting stages whose
   * gate already holds in D1, refresh. Idempotent: running it twice opens nothing new.
   */
  async scanBlockers(): Promise<ScanResult> {
    return this.#serial.run(async () => {
      const db = this.env.DB;
      const clock = await this.clock();
      const startedAt = clock.nowIso();
      const result: ScanResult = { opened: 0, autoResolved: 0, nudged: 0 };
      let candidates = 0;
      let wakeFailures = 0;
      let error: string | null = null;
      try {
        const snapshot = await loadScanSnapshot(db, this.employeeId);
        if (snapshot) {
          const nowMs = clock.nowMs();
          const open = new Set(snapshot.openBlockers.map((b) => b.dedupeKey));
          const fresh = detectBlockers(snapshot, nowMs).filter((c) => !open.has(c.dedupeKey));
          candidates = fresh.length;
          const actor = { type: "agent" as const, id: `case-agent/${this.employeeId}` };
          for (const c of fresh) {
            // Draft first (LLM or template), then write blocker + follow-up + audits in one batch.
            const draft = await this.#drafter().draft(c, { employeeName: snapshot.employeeName });
            const detectedAt = clock.nowIso();
            const id = blockerId(c.dedupeKey, Date.parse(detectedAt));
            const results = await db.batch(
              openBlockerStatements(
                db,
                { id, employeeId: this.employeeId, stageId: c.stageId, kind: c.kind, severity: c.severity, ownerDepartment: c.ownerDepartment, subject: c.subject, dedupeKey: c.dedupeKey, detail: c.detail, detectedAt },
                {
                  title: draft.title,
                  description: draft.description,
                  assignee: c.ownerDepartment,
                  dueAt: new Date(Date.parse(detectedAt) + 86_400_000).toISOString(),
                  draftedBy: draft.draftedBy,
                  llmSuggestedCategory: draft.suggestedCategory,
                  llm: { provider: this.#drafter().providerId, latencyMs: draft.latencyMs, error: draft.error ?? null },
                },
                actor,
              ),
            );
            if ((results[0]?.meta.changes ?? 0) > 0) result.opened++;
          }
          for (const r of resolvedBlockers(snapshot, nowMs)) {
            const now = clock.nowIso();
            const stamp = `ag:${this.employeeId}:auto-resolve:${r.blockerId}`;
            const { applied } = await runGuarded({
              db,
              mutation: db
                .prepare("UPDATE blockers SET status = 'resolved', resolved_at = ?, resolved_by = ?, resolution = ?, last_mutation_id = ? WHERE id = ? AND status = 'open'")
                .bind(now, actor.id, `auto: ${r.reason}`, stamp, r.blockerId),
              applied: stamped("blockers", "id = ?", [r.blockerId], stamp),
              onApplied: (when) => [
                db.prepare(`UPDATE tasks SET status = 'cancelled', last_mutation_id = ? WHERE blocker_id = ? AND status = 'open' AND ${when.sql}`).bind(stamp, r.blockerId, ...when.binds),
                auditInsertWhen(
                  db,
                  {
                    id: auditIds.agent(this.employeeId, "blocker.auto_resolved", r.blockerId),
                    occurredAt: now,
                    actorType: "agent",
                    actorId: actor.id,
                    action: "blocker.auto_resolved",
                    entityType: "blocker",
                    entityId: r.blockerId,
                    employeeId: this.employeeId,
                    detail: { kind: r.kind, reason: r.reason },
                  },
                  when,
                ),
              ],
            });
            if (applied) result.autoResolved++;
          }
          for (const stage of nudgeTargets(snapshot, nowMs, this.config.gates.nudgeAfterS)) {
            if (await this.wake(stage, "nudge")) result.nudged++;
            else wakeFailures++;
          }
        }
        await this.#refreshNow();
      } catch (err) {
        error = errorMessage(err);
        console.error(`scan ${this.employeeId}: ${error}`);
      }
      try {
        this.sql`INSERT INTO scan_runs (started_at, finished_at, candidates, opened, resolved, nudged, wake_failures, error)
          VALUES (${startedAt}, ${new Date().toISOString()}, ${candidates}, ${result.opened}, ${result.autoResolved}, ${result.nudged}, ${wakeFailures}, ${error})`;
      } catch {
        // observability only
      }
      return result;
    });
  }

  scanRuns(): Array<Record<string, string | number | null>> {
    return this.sql`SELECT * FROM scan_runs ORDER BY id`;
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
    if (next) {
      // before pushing new state: drop subscribers that are no longer allowed to see it
      await this.revokeStaleSubscriptions().catch((err: unknown) => console.warn(`subscription check ${this.employeeId}: ${errorMessage(err)}`));
      this.applyProjection(next);
      // Best effort: the hub reconciles from D1 on a debounce and every minute anyway.
      try {
        const hub = await getAgentByName(this.env.OPS_HUB_AGENT, HUB_NAME);
        await hub.caseChanged(this.employeeId, next.asOfSeq);
      } catch (err) {
        console.warn(`hub notify ${this.employeeId}: ${errorMessage(err)}`);
      }
    }
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
