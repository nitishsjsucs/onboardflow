// Workflow and agent helpers for worker tests.
import { introspectWorkflow, type WorkflowIntrospector } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import type { Cmd } from "../../src/worker/agents/case-agent.ts";
import { loadPrincipal } from "../../src/worker/auth/middleware.ts";
import type { StageId } from "../../src/shared/stages.ts";
import { emailOf } from "./auth.ts";

export function caseAgent(employeeId: string) {
  return getAgentByName(env.CASE_AGENT, employeeId);
}

type Result = { status: number; body: Record<string, any> };
/** The CaseAgent RPC surface with plain types (the generated stub types get too deep for tsc in places). */
export type CaseRpc = {
  startCase(cmd: Cmd, limits?: Record<string, number>): Promise<Result>;
  completeTask(taskId: string, cmd: Cmd, note?: string): Promise<Result>;
  decideApproval(id: string, d: { decision: "approve" | "reject"; reason?: string; privilegedAccessApproved?: boolean; onBehalfOf?: string }, cmd: Cmd): Promise<Result>;
  resubmitApproval(id: string, cmd: Cmd, note?: string): Promise<Result>;
  retryStage(stage: StageId, cmd: Cmd, note?: string): Promise<Result>;
  fixField(field: "costCenter" | "licenseBundle" | "photoOnFile", value: string | boolean, cmd: Cmd): Promise<Result>;
  resolveBlocker(id: string, resolution: string, cmd: Cmd): Promise<Result>;
  restartCase(reason: string, cmd: Cmd): Promise<Result>;
  terminateCase(reason: string, cmd: Cmd): Promise<Result>;
  scanNow(cmd: Cmd): Promise<Result>;
};
export async function rpc(employeeId: string): Promise<CaseRpc> {
  return (await caseAgent(employeeId)) as unknown as CaseRpc;
}

/** A command envelope as the API layer builds it, for a person id (E001, M01, C01, A01). */
export async function cmdFor(personId: string, key: string | null = null): Promise<Cmd> {
  const email = await emailOf(personId);
  const actor = await loadPrincipal(env.DB, email);
  if (!actor) throw new Error(`no principal for ${personId}`);
  return { actor, requestId: crypto.randomUUID(), idem: key ? { actorEmail: email, key } : null };
}

/**
 * Opens a Workflow introspection session that disables sleeps and retry delays
 * for every instance created afterwards (including the SDK's internal
 * __agent_* steps, which otherwise use the platform default retry policy).
 */
export async function fastWorkflows(opts: { retryDelays?: boolean } = {}): Promise<WorkflowIntrospector> {
  const intro = await introspectWorkflow(env.ONBOARDING_WORKFLOW);
  await intro.modifyAll(async (m) => {
    await m.disableSleeps();
    if (opts.retryDelays !== false) await m.disableRetryDelays();
  });
  return intro;
}

export async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Polls `fn` until it returns a truthy value or the deadline passes. */
export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, opts: { timeoutMs?: number; intervalMs?: number; what?: string } = {}): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${opts.what ?? "condition"}`);
    await sleep(opts.intervalMs ?? 50);
  }
}

const DB = () => env.DB;

export async function caseRow(employeeId: string) {
  return DB().prepare("SELECT status, failure_reason, run_no, revision, workflow_instance_id, current_stage FROM cases WHERE employee_id = ?").bind(employeeId).first<{
    status: string;
    failure_reason: string | null;
    run_no: number;
    revision: number;
    workflow_instance_id: string | null;
    current_stage: string | null;
  }>();
}

export async function stageRow(employeeId: string, stage: string) {
  return DB().prepare("SELECT status, round, blocked_reason_json FROM case_stages WHERE employee_id = ? AND stage_id = ?").bind(employeeId, stage).first<{ status: string; round: number; blocked_reason_json: string | null }>();
}

export async function waitForStage(employeeId: string, stage: string, status: string | string[], timeoutMs = 30_000) {
  const want = Array.isArray(status) ? status : [status];
  return waitFor(async () => {
    const r = await stageRow(employeeId, stage);
    return r && want.includes(r.status) ? r : null;
  }, { timeoutMs, what: `${employeeId} ${stage} -> ${want.join("|")}` });
}

export async function waitForCase(employeeId: string, status: string | string[], timeoutMs = 45_000) {
  const want = Array.isArray(status) ? status : [status];
  return waitFor(async () => {
    const r = await caseRow(employeeId);
    return r && want.includes(r.status) ? r : null;
  }, { timeoutMs, what: `${employeeId} case -> ${want.join("|")}` });
}

/** Starts a case through the CaseAgent as a People Ops coordinator. */
export async function startCase(employeeId: string, limits?: Record<string, number>) {
  const stub = await caseAgent(employeeId);
  const r: { status: number; body: { instanceId: string; created: boolean } } = await stub.startCase(await cmdFor("C01"), limits);
  if (r.status !== 202) throw new Error(`start ${employeeId} failed: ${r.status}`);
  return r.body.instanceId;
}

/** Completes the employee's checklist tasks of a stage through the CaseAgent, as the employee. */
export async function completeEmployeeTasks(employeeId: string, stage: "paperwork" | "orientation", order: "forward" | "reverse" = "forward") {
  const stub = await caseAgent(employeeId);
  const tasks = await waitFor(async () => {
    const r = await DB().prepare("SELECT id FROM tasks WHERE employee_id = ? AND stage_id = ? AND kind = 'checklist' ORDER BY id").bind(employeeId, stage).all<{ id: string }>();
    return r.results.length > 0 ? r.results : null;
  }, { what: `${employeeId} ${stage} checklist` });
  const ids = tasks.map((t) => t.id);
  if (order === "reverse") ids.reverse();
  for (const id of ids) {
    const r: { status: number } = await stub.completeTask(id, await cmdFor(employeeId));
    if (r.status !== 200 && r.status !== 409) throw new Error(`complete ${id}: ${r.status}`);
  }
}

/** Waits for the pending approval of a checkpoint round and decides it as `as`. */
export async function decide(
  employeeId: string,
  checkpoint: "manager_approval" | "closeout",
  decision: "approve" | "reject",
  as: string,
  opts: { round?: number; privileged?: boolean; onBehalfOf?: string } = {},
) {
  const round = opts.round ?? 1;
  const id = `apr:${employeeId}:${checkpoint}:${round}`;
  await waitFor(async () => DB().prepare("SELECT 1 AS ok FROM approvals WHERE id = ? AND status = 'pending'").bind(id).first(), { what: `${id} pending` });
  const stub = await caseAgent(employeeId);
  const r: { status: number } = await stub.decideApproval(
    id,
    { decision, ...(opts.privileged !== undefined ? { privilegedAccessApproved: opts.privileged } : {}), ...(opts.onBehalfOf ? { onBehalfOf: opts.onBehalfOf } : {}), reason: decision === "reject" ? "please revise" : "ok" },
    await cmdFor(as),
  );
  return { id, status: r.status };
}

/** Drives a case from start to complete with every human action on time. */
export async function driveHappyPath(employeeId: string, opts: { privileged?: boolean } = {}) {
  await startCase(employeeId);
  await waitForStage(employeeId, "paperwork", "waiting_on_employee");
  await completeEmployeeTasks(employeeId, "paperwork");
  const manager = (await DB().prepare("SELECT manager_id FROM employees WHERE id = ?").bind(employeeId).first<{ manager_id: string }>())!.manager_id;
  await decide(employeeId, "manager_approval", "approve", manager, opts.privileged !== undefined ? { privileged: opts.privileged } : {});
  await waitForStage(employeeId, "orientation", "waiting_on_employee");
  await completeEmployeeTasks(employeeId, "orientation");
  await decide(employeeId, "closeout", "approve", "C01");
  return waitForCase(employeeId, ["complete", "failed"]);
}

export async function auditActions(employeeId: string): Promise<Array<{ action: string; stage_id: string | null; detail_json: string; id: string; seq: number }>> {
  return (await DB().prepare("SELECT seq, id, action, stage_id, detail_json FROM audit_events WHERE employee_id = ? ORDER BY seq").bind(employeeId).all<{ action: string; stage_id: string | null; detail_json: string; id: string; seq: number }>()).results;
}

export async function managerOf(employeeId: string): Promise<string> {
  return (await DB().prepare("SELECT manager_id FROM employees WHERE id = ?").bind(employeeId).first<{ manager_id: string }>())!.manager_id;
}

/** Starts the case and performs the human steps before IT provisioning (paperwork, manager approval). */
export async function driveThroughManagerApproval(employeeId: string, limits?: Record<string, number>) {
  await startCase(employeeId, limits);
  await waitForStage(employeeId, "paperwork", "waiting_on_employee");
  await completeEmployeeTasks(employeeId, "paperwork");
  await decide(employeeId, "manager_approval", "approve", await managerOf(employeeId));
}

/** Performs the human steps after provisioning (orientation tasks, closeout approval) and waits for the end. */
export async function finishFromOrientation(employeeId: string, closeoutRound = 1) {
  await waitForStage(employeeId, "orientation", "waiting_on_employee");
  await completeEmployeeTasks(employeeId, "orientation");
  await decide(employeeId, "closeout", "approve", "C01", { round: closeoutRound });
  return waitForCase(employeeId, ["complete", "failed"]);
}

export async function calls(employeeId: string, operation?: string) {
  const sql = `SELECT run_no, step_name, operation, attempt, outcome, http_status, created_at FROM integration_calls WHERE employee_id = ?${operation ? " AND operation = ?" : ""} ORDER BY created_at, attempt`;
  const binds = operation ? [employeeId, operation] : [employeeId];
  return (await DB().prepare(sql).bind(...binds).all<{ run_no: number; step_name: string; operation: string; attempt: number; outcome: string; http_status: number | null; created_at: string }>()).results;
}

export async function retry(employeeId: string, stage: StageId, as: string) {
  return (await rpc(employeeId)).retryStage(stage, await cmdFor(as));
}

/** Drives a case to the end through the real REST API with the real personas. */
export async function driveHappyPathViaApi(employeeId: string) {
  const { api } = await import("./api.ts");
  const ok = (r: { status: number }, what: string) => {
    if (r.status >= 300) throw new Error(`${what}: ${r.status}`);
  };
  ok(await api(`/api/cases/${employeeId}/start`, { as: "C01", body: {} }), "start");
  for (const stage of ["paperwork", "orientation"] as const) {
    await waitForStage(employeeId, stage, "waiting_on_employee");
    const checklist: { body: { tasks: Array<{ id: string; stageId: string; status: string }> } } = await api("/api/me/checklist", { as: employeeId });
    for (const t of checklist.body.tasks.filter((x) => x.stageId === stage && x.status === "open")) {
      ok(await api(`/api/tasks/${t.id}/complete`, { as: employeeId, body: {} }), `complete ${t.id}`);
    }
    if (stage === "paperwork") {
      const manager = await managerOf(employeeId);
      const id = `apr:${employeeId}:manager_approval:1`;
      await waitFor(async () => DB().prepare("SELECT 1 AS ok FROM approvals WHERE id = ? AND status = 'pending'").bind(id).first(), { what: id });
      ok(await api(`/api/approvals/${id}/decision`, { as: manager, body: { decision: "approve", privilegedAccessApproved: true } }), "manager decision");
    }
  }
  const closeout = `apr:${employeeId}:closeout:1`;
  await waitFor(async () => DB().prepare("SELECT 1 AS ok FROM approvals WHERE id = ? AND status = 'pending'").bind(closeout).first(), { what: closeout });
  ok(await api(`/api/approvals/${closeout}/decision`, { as: "C02", body: { decision: "approve" } }), "closeout decision");
  return waitForCase(employeeId, ["complete", "failed"]);
}
