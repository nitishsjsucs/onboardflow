// Evaluates a scenario's expectations against the case snapshot
// (/api/dev/eval/snapshot/:id) and extracts the per-case facts the metrics
// need. Pure: input is the snapshot, output is a list of failed assertions.
import { ownerFor } from "../../src/worker/agents/blocker-rules.ts";
import type { BlockerKind } from "../../src/shared/domain.ts";
import { STAGE_IDS } from "../../src/shared/stages.ts";
import type { Scenario } from "../scenarios/types.ts";

export type Snapshot = {
  employeeId: string;
  case: { status: string; failure_reason: string | null; run_no: number } | null;
  stages: Array<{ stage_id: string; status: string; round: number }>;
  tasks: Array<{ id: string; kind: string; status: string; assignee: string; blockerId: string | null; draftedBy: string | null; llmSuggestedCategory: string | null }>;
  approvals: Array<{ id: string; status: string; checkpoint: string; round: number }>;
  blockers: Array<{ id: string; kind: BlockerKind; stage_id: string; owner_department: string; status: string; detail_json: string }>;
  provisioning: Array<{ resource: string; status: string }>;
  integrationCalls: Array<{ id: string; run_no: number; step_name: string; operation: string; attempt: number; outcome: string }>;
  audit: Array<{ id: string; action: string; entity_id: string; run_no: number | null; stage_id: string | null; detail_json: string }>;
  ledger: Array<{ system: string; operation: string; employee_ref: string }>;
};

export type CaseFacts = {
  completed: boolean;
  failedReason: string | null;
  calls: number;
  retriedCalls: number;
  replays: number;
  duplicateSideEffects: number;
  bySystem: Record<string, { calls: number; ok: number; retryable: number; fatal: number; timeouts: number; replayed: number }>;
  auditableActions: number;
  auditedActions: number;
  full8StageTrail: boolean;
  blockersDetected: Array<{ kind: string; stage: string }>;
  followups: { created: number; correctDepartment: number; draftedByLlm: number; llmSchemaValid: number; llmCategoryAgrees: number; llmAttempted: number; llmLatenciesMs: number[] };
};

const roundOf = (step: string) => Number(/#r(\d+)/.exec(step)?.[1] ?? 0);

/** Attempts of an operation in its final round of the final run. */
export function attemptsInFinalRound(s: Snapshot, operation: string): number {
  const calls = s.integrationCalls.filter((c) => c.operation === operation && !/poll-/.test(c.step_name));
  if (calls.length === 0) return 0;
  const run = Math.max(...calls.map((c) => c.run_no));
  const inRun = calls.filter((c) => c.run_no === run);
  const round = Math.max(...inRun.map((c) => roundOf(c.step_name)));
  return new Set(inRun.filter((c) => roundOf(c.step_name) === round).map((c) => c.attempt)).size;
}

export function ledgerCount(s: Snapshot, operation: string): number {
  const [system, op] = [operation.split(".")[0], operation.split(".").slice(1).join(".")];
  return s.ledger.filter((l) => l.system === system && l.operation === op).length;
}

export function evaluateExpectations(sc: Scenario, s: Snapshot): string[] {
  const failures: string[] = [];
  const e = sc.expect;
  const status = s.case?.status ?? "missing";
  if (e.terminal === "complete") {
    if (status !== "complete") failures.push(`terminal: expected complete, got ${status}${s.case?.failure_reason ? ` (${s.case.failure_reason})` : ""}`);
  } else if (status !== "failed" || s.case?.failure_reason !== e.terminal.failed) {
    failures.push(`terminal: expected failed ${e.terminal.failed}, got ${status} ${s.case?.failure_reason ?? ""}`);
  }
  for (const [op, n] of Object.entries(e.attempts ?? {})) {
    const got = attemptsInFinalRound(s, op);
    if (got !== n) failures.push(`attempts ${op}: expected ${n}, got ${got}`);
  }
  for (const [op, n] of Object.entries(e.sideEffects ?? {})) {
    const got = ledgerCount(s, op);
    if (got !== n) failures.push(`side effects ${op}: expected ${n}, got ${got}`);
  }
  for (const op of e.replayed ?? []) {
    if (!s.integrationCalls.some((c) => c.operation === op && c.outcome === "replayed")) failures.push(`replayed ${op}: no replayed call`);
  }
  {
    // A scenario that declares no blockers expects none: a spurious blocker fails it too.
    const got = s.blockers.map((b) => `${b.kind}|${b.stage_id}|${b.owner_department}`).sort();
    const want = (e.blockers ?? []).map((b) => `${b.kind}|${b.stage}|${b.ownerDepartment}`).sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`blockers: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
  for (const [stage, n] of Object.entries(e.rounds ?? {})) {
    const got = s.stages.find((x) => x.stage_id === stage)?.round;
    if (got !== n) failures.push(`round ${stage}: expected ${n}, got ${got}`);
  }
  if (e.gateChecks) {
    const runNo = s.case?.run_no ?? 1;
    for (const stage of Object.keys(e.gateChecks)) {
      const passes = s.audit.filter((a) => a.action === "stage.gate_passed" && a.stage_id === stage && a.run_no === runNo);
      const checks = passes.map((p) => (JSON.parse(p.detail_json) as { checks?: number }).checks);
      if (passes.length === 0 || checks.some((c) => c !== 1)) failures.push(`gate ${stage} in run ${runNo}: expected checks 1, got ${JSON.stringify(checks)}`);
    }
  }
  const actions = new Map<string, number>();
  for (const a of s.audit) actions.set(a.action, (actions.get(a.action) ?? 0) + 1);
  for (const a of e.auditActions ?? []) if (!actions.has(a)) failures.push(`audit: missing ${a}`);
  for (const a of e.absentAuditActions ?? []) if (actions.has(a)) failures.push(`audit: unexpected ${a}`);
  for (const [a, n] of Object.entries(e.auditCounts ?? {})) {
    if ((actions.get(a) ?? 0) !== n) failures.push(`audit count ${a}: expected ${n}, got ${actions.get(a) ?? 0}`);
  }
  return failures;
}

/** Per-case facts for the run metrics. */
export function caseFacts(s: Snapshot): CaseFacts {
  const bySystem: CaseFacts["bySystem"] = {};
  for (const c of s.integrationCalls) {
    const sys = c.operation.split(".")[0] as string;
    const b = (bySystem[sys] ??= { calls: 0, ok: 0, retryable: 0, fatal: 0, timeouts: 0, replayed: 0 });
    b.calls++;
    if (c.outcome === "ok") b.ok++;
    else if (c.outcome === "replayed") b.replayed++;
    else if (c.outcome === "fatal_error") b.fatal++;
    else if (c.outcome === "timeout") b.timeouts++;
    else if (c.outcome === "retryable_error" || c.outcome === "malformed") b.retryable++;
  }
  const ledgerKeys = new Map<string, number>();
  for (const l of s.ledger) ledgerKeys.set(`${l.system}.${l.operation}.${l.employee_ref}`, (ledgerKeys.get(`${l.system}.${l.operation}.${l.employee_ref}`) ?? 0) + 1);
  const duplicateSideEffects = [...ledgerKeys.values()].reduce((a, n) => a + Math.max(0, n - 1), 0);

  // Audit coverage: every auditable action with its matching audit row.
  const auditIds = new Set(s.audit.map((a) => a.id));
  const auditByEntity = new Map<string, Set<string>>();
  for (const a of s.audit) {
    if (!auditByEntity.has(a.entity_id)) auditByEntity.set(a.entity_id, new Set());
    auditByEntity.get(a.entity_id)!.add(a.action);
  }
  const has = (entity: string, ...acts: string[]) => acts.some((x) => auditByEntity.get(entity)?.has(x));
  let auditable = 0;
  let audited = 0;
  const count = (ok: boolean) => {
    auditable++;
    if (ok) audited++;
  };
  for (const c of s.integrationCalls) count(auditIds.has(`ic:${c.id}`));
  for (const a of s.approvals) if (a.status !== "pending") count(has(a.id, "approval.approved", "approval.rejected"));
  for (const t of s.tasks) if (t.status === "done") count(has(t.id, "task.completed", "followup.completed"));
  for (const b of s.blockers) {
    count(has(b.id, "blocker.opened"));
    if (b.status === "resolved") count(has(b.id, "blocker.resolved", "blocker.auto_resolved"));
  }
  for (const st of s.stages) if (st.status === "complete") count(has(`${s.employeeId}:${st.stage_id}`, "stage.completed"));

  const completedStages = new Set(s.audit.filter((a) => a.action === "stage.completed").map((a) => a.stage_id));
  const followups = s.tasks.filter((t) => t.kind === "followup");
  const blockerById = new Map(s.blockers.map((b) => [b.id, b]));
  let correct = 0;
  let schemaValid = 0;
  let agrees = 0;
  for (const f of followups) {
    const b = f.blockerId ? blockerById.get(f.blockerId) : undefined;
    if (b && f.assignee === ownerFor(b.kind, JSON.parse(b.detail_json))) correct++;
    if (f.draftedBy?.startsWith("llm:")) {
      schemaValid++;
      if (b && f.llmSuggestedCategory === b.kind) agrees++;
    }
  }
  return {
    completed: s.case?.status === "complete" && s.stages.length === 8 && s.stages.every((x) => x.status === "complete"),
    failedReason: s.case?.status === "failed" ? (s.case.failure_reason ?? "unknown") : null,
    calls: s.integrationCalls.length,
    retriedCalls: s.integrationCalls.filter((c) => ["retryable_error", "timeout", "malformed"].includes(c.outcome)).length,
    replays: s.integrationCalls.filter((c) => c.outcome === "replayed").length,
    duplicateSideEffects,
    bySystem,
    auditableActions: auditable,
    auditedActions: audited,
    full8StageTrail: STAGE_IDS.every((st) => completedStages.has(st)),
    blockersDetected: s.blockers.map((b) => ({ kind: b.kind, stage: b.stage_id })),
    followups: {
      created: followups.length,
      correctDepartment: correct,
      draftedByLlm: followups.filter((f) => f.draftedBy?.startsWith("llm:")).length,
      llmSchemaValid: schemaValid,
      llmCategoryAgrees: agrees,
      ...llmAudit(s),
    },
  };
}

/** LLM attempts and latencies, from the followup.created audit detail (the provider "stub" is not an LLM). */
function llmAudit(s: Snapshot): { llmAttempted: number; llmLatenciesMs: number[] } {
  let attempted = 0;
  const latencies: number[] = [];
  for (const a of s.audit) {
    if (a.action !== "followup.created") continue;
    const d = JSON.parse(a.detail_json) as { draftedBy?: string; llm?: { provider?: string; latencyMs?: number | null } };
    if (!d.llm?.provider || d.llm.provider === "stub") continue;
    attempted++;
    if (d.draftedBy?.startsWith("llm:") && typeof d.llm.latencyMs === "number") latencies.push(d.llm.latencyMs);
  }
  return { llmAttempted: attempted, llmLatenciesMs: latencies };
}
