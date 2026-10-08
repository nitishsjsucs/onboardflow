// Run metrics (SPEC 12.4). Pure functions over per-scenario results, so the
// arithmetic is unit tested (eval-metrics.test.ts) apart from any server.
import type { SystemId } from "../../src/shared/domain.ts";
import type { Category } from "../scenarios/types.ts";
import type { CaseFacts } from "./assertions.ts";

export type FailureReasonCode = "not_completed" | "expectation_failed" | "deadline" | "unknown_action";

export type ScenarioResult = {
  scenarioId: string;
  category: Category;
  employeeId: string;
  completed: boolean;
  passed: boolean;
  durationMs: number;
  failures: string[];
  failureReason: FailureReasonCode | null;
  facts: CaseFacts | null;
  expectedBlockers: Array<{ kind: string; stage: string }> | null;
};

export type EvalRun = {
  runId: string;
  startedAt: string;
  gitSha: string;
  mode: string;
  llmProvider: string;
  seeds: number[];
  environment: { runtime: "local wrangler dev (Miniflare/workerd)"; wrangler: string; workerd: string; node: string; machine: string };
  config: { retryLimit: number; retryBaseDelayMs: number; pollIntervalMs: number; pollMax: number; integrationTimeoutMs: number; gateWaitTimeoutMs: number; concurrency: number };
  simulatedNow: string;
  totals: { startedCases: number; scenarios: number; completed: number; completionRate: number; passed: number; passRate: number };
  byCategory: Record<Category, { scenarios: number; completed: number; passed: number }>;
  chaos: null;
  integration: {
    calls: number;
    retriedCalls: number;
    replays: number;
    duplicateSideEffects: number;
    bySystem: Record<SystemId, { calls: number; ok: number; retryable: number; fatal: number; timeouts: number; replayed: number }>;
  };
  regression: {
    blockers: { expected: number; detected: number; truePositives: number; precision: number; recall: number };
    audit: { auditableActions: number; auditedActions: number; coverage: number; completedCasesWithFull8StageTrail: number };
    hubConsistency: { matchesReconcile: boolean; diffs: string[] };
  };
  followups: { created: number; correctDepartmentRate: number; draftedByLlmRate: number; llmSchemaValidRate: number | null; llmCategoryAgreement: number | null; llmLatencyP50Ms: number | null };
  timing: { scenarioP50Ms: number; scenarioP95Ms: number; totalMs: number };
  failures: Array<{ scenarioId: string; reason: FailureReasonCode; detail: string }>;
  scenarios: ScenarioResult[];
};

export function ratio(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 10_000) / 10_000;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] as number;
}

/** Blocker precision and recall over (kind, stage) pairs, for scenarios that declare expected blockers. */
export function blockerScores(results: ScenarioResult[]) {
  let expected = 0;
  let detected = 0;
  let tp = 0;
  for (const r of results) {
    if (!r.expectedBlockers || !r.facts) continue;
    const want = r.expectedBlockers.map((b) => `${b.kind}|${b.stage}`);
    const got = r.facts.blockersDetected.map((b) => `${b.kind}|${b.stage}`);
    expected += want.length;
    detected += got.length;
    const pool = [...want];
    for (const g of got) {
      const i = pool.indexOf(g);
      if (i >= 0) {
        tp++;
        pool.splice(i, 1);
      }
    }
  }
  return { expected, detected, truePositives: tp, precision: detected === 0 ? (expected === 0 ? 1 : 0) : ratio(tp, detected), recall: expected === 0 ? 1 : ratio(tp, expected) };
}

export function computeMetrics(results: ScenarioResult[], extra: { startedCases: number; totalMs: number; hub: { matchesReconcile: boolean; diffs: string[] } }) {
  const completed = results.filter((r) => r.completed).length;
  const passed = results.filter((r) => r.passed).length;
  const cats: Category[] = ["onboarding", "integration_failure", "recovery"];
  const byCategory = Object.fromEntries(
    cats.map((c) => {
      const rs = results.filter((r) => r.category === c);
      return [c, { scenarios: rs.length, completed: rs.filter((r) => r.completed).length, passed: rs.filter((r) => r.passed).length }];
    }),
  ) as EvalRun["byCategory"];

  const bySystem: EvalRun["integration"]["bySystem"] = {
    hr: { calls: 0, ok: 0, retryable: 0, fatal: 0, timeouts: 0, replayed: 0 },
    it: { calls: 0, ok: 0, retryable: 0, fatal: 0, timeouts: 0, replayed: 0 },
    facilities: { calls: 0, ok: 0, retryable: 0, fatal: 0, timeouts: 0, replayed: 0 },
  };
  let calls = 0;
  let retriedCalls = 0;
  let replays = 0;
  let duplicates = 0;
  let auditable = 0;
  let audited = 0;
  let trails = 0;
  let fCreated = 0;
  let fCorrect = 0;
  let fLlm = 0;
  for (const r of results) {
    const f = r.facts;
    if (!f) continue;
    calls += f.calls;
    retriedCalls += f.retriedCalls;
    replays += f.replays;
    duplicates += f.duplicateSideEffects;
    auditable += f.auditableActions;
    audited += f.auditedActions;
    if (f.completed && f.full8StageTrail) trails++;
    fCreated += f.followups.created;
    fCorrect += f.followups.correctDepartment;
    fLlm += f.followups.draftedByLlm;
    for (const [sys, s] of Object.entries(f.bySystem)) {
      const t = bySystem[sys as SystemId];
      if (!t) continue;
      t.calls += s.calls;
      t.ok += s.ok;
      t.retryable += s.retryable;
      t.fatal += s.fatal;
      t.timeouts += s.timeouts;
      t.replayed += s.replayed;
    }
  }
  const durations = results.map((r) => r.durationMs);
  return {
    totals: { startedCases: extra.startedCases, scenarios: results.length, completed, completionRate: ratio(completed, results.length), passed, passRate: ratio(passed, results.length) },
    byCategory,
    integration: { calls, retriedCalls, replays, duplicateSideEffects: duplicates, bySystem },
    regression: {
      blockers: blockerScores(results),
      audit: { auditableActions: auditable, auditedActions: audited, coverage: ratio(audited, auditable), completedCasesWithFull8StageTrail: trails },
      hubConsistency: extra.hub,
    },
    followups: { created: fCreated, correctDepartmentRate: ratio(fCorrect, fCreated), draftedByLlmRate: ratio(fLlm, fCreated), llmSchemaValidRate: null, llmCategoryAgreement: null, llmLatencyP50Ms: null },
    timing: { scenarioP50Ms: percentile(durations, 50), scenarioP95Ms: percentile(durations, 95), totalMs: extra.totalMs },
    failures: results.filter((r) => !r.passed).map((r) => ({ scenarioId: r.scenarioId, reason: r.failureReason ?? "expectation_failed", detail: r.failures.join("; ").slice(0, 1000) })),
  };
}

/** The CI gate (SPEC 12.1): every started, completed, passed, no duplicates, full audit coverage, hub consistent. */
export function ciGate(run: Pick<EvalRun, "totals" | "integration" | "regression">, expectedScenarios: number): string[] {
  const problems: string[] = [];
  if (run.totals.startedCases !== expectedScenarios) problems.push(`startedCases ${run.totals.startedCases} != ${expectedScenarios}`);
  if (run.totals.completed !== expectedScenarios) problems.push(`completed ${run.totals.completed}/${expectedScenarios}`);
  if (run.totals.passed !== expectedScenarios) problems.push(`passed ${run.totals.passed}/${expectedScenarios}`);
  if (run.integration.duplicateSideEffects !== 0) problems.push(`duplicate side effects ${run.integration.duplicateSideEffects}`);
  if (run.regression.audit.coverage !== 1) problems.push(`audit coverage ${run.regression.audit.coverage}`);
  if (!run.regression.hubConsistency.matchesReconcile) problems.push(`hub inconsistent: ${run.regression.hubConsistency.diffs.join(", ")}`);
  return problems;
}
