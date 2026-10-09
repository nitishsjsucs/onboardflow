import { describe, expect, it } from "vitest";
import { attemptsInFinalRound, caseFacts, evaluateExpectations, type Snapshot } from "../../eval/harness/assertions.ts";
import { blockerScores, chaosAggregate, type ChaosSeedSummary, ciGate, computeMetrics, percentile, ratio, type ScenarioResult } from "../../eval/harness/metrics.ts";
import { describeInvocation } from "../../eval/harness/report.ts";
import type { Scenario } from "../../eval/scenarios/types.ts";
import { STAGE_IDS } from "../../src/shared/stages.ts";

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    employeeId: "E001",
    case: { status: "complete", failure_reason: null, run_no: 1 },
    stages: STAGE_IDS.map((s) => ({ stage_id: s, status: "complete", round: s === "it_provisioning" ? 2 : 1 })),
    tasks: [
      { id: "chk:E001:w4", kind: "checklist", status: "done", assignee: "employee", blockerId: null, draftedBy: "template", llmSuggestedCategory: null },
      { id: "fu:blk:1", kind: "followup", status: "cancelled", assignee: "it", blockerId: "blk:1", draftedBy: "stub", llmSuggestedCategory: "integration_outage" },
    ],
    approvals: [{ id: "apr:E001:manager_approval:1", status: "approved", checkpoint: "manager_approval", round: 1 }],
    blockers: [{ id: "blk:1", kind: "integration_outage", stage_id: "it_provisioning", owner_department: "it", status: "resolved", detail_json: '{"system":"it","operation":"it.order-device"}' }],
    provisioning: [],
    integrationCalls: [
      { id: "c1", run_no: 1, step_name: "it_provisioning.it.order-device#r1", operation: "it.order-device", attempt: 1, outcome: "retryable_error" },
      { id: "c2", run_no: 1, step_name: "it_provisioning.it.order-device#r1", operation: "it.order-device", attempt: 2, outcome: "retryable_error" },
      { id: "c3", run_no: 1, step_name: "it_provisioning.it.order-device#r2", operation: "it.order-device", attempt: 1, outcome: "replayed" },
      { id: "c4", run_no: 1, step_name: "it_provisioning.poll-it_device#r2.1", operation: "it.get-device-order", attempt: 1, outcome: "ok" },
    ],
    audit: [
      ...["c1", "c2", "c3", "c4"].map((c) => ({ id: `ic:${c}`, action: "integration.call", entity_id: c, run_no: 1, stage_id: null, detail_json: "{}" })),
      { id: "a1", action: "approval.approved", entity_id: "apr:E001:manager_approval:1", run_no: null, stage_id: "manager_approval", detail_json: "{}" },
      { id: "a2", action: "task.completed", entity_id: "chk:E001:w4", run_no: null, stage_id: "paperwork", detail_json: "{}" },
      { id: "a3", action: "blocker.opened", entity_id: "blk:1", run_no: null, stage_id: "it_provisioning", detail_json: "{}" },
      { id: "a4", action: "blocker.auto_resolved", entity_id: "blk:1", run_no: null, stage_id: "it_provisioning", detail_json: "{}" },
      { id: "a5", action: "stage.gate_passed", entity_id: "E001:paperwork", run_no: 1, stage_id: "paperwork", detail_json: '{"checks":1}' },
      ...STAGE_IDS.map((s) => ({ id: `s:${s}`, action: "stage.completed", entity_id: `E001:${s}`, run_no: 1, stage_id: s, detail_json: "{}" })),
    ],
    ledger: [
      { system: "it", operation: "order-device", employee_ref: "E001" },
      { system: "hr", operation: "create-worker", employee_ref: "E001" },
    ],
    ...over,
  };
}

function result(id: string, over: Partial<ScenarioResult> = {}): ScenarioResult {
  return {
    scenarioId: id,
    category: "onboarding",
    employeeId: "E001",
    completed: true,
    passed: true,
    durationMs: 1000,
    failures: [],
    failureReason: null,
    facts: caseFacts(snap()),
    expectedBlockers: null,
    ...over,
  };
}

describe("per-case facts", () => {
  it("counts calls, retries, replays, full audit coverage and the 8-stage trail", () => {
    const f = caseFacts(snap());
    expect(f).toMatchObject({ completed: true, calls: 4, retriedCalls: 2, replays: 1, duplicateSideEffects: 0, full8StageTrail: true });
    // 4 calls + 1 decided approval + 1 done task + blocker opened + blocker resolved + 8 stages
    expect(f.auditableActions).toBe(16);
    expect(f.auditedActions).toBe(16);
    expect(f.followups).toMatchObject({ created: 1, correctDepartment: 1, draftedByLlm: 0 });
  });

  it("counts duplicate side effects as max(0, n - 1) per (system, operation, employee)", () => {
    const s = snap({ ledger: [...snap().ledger, { system: "it", operation: "order-device", employee_ref: "E001" }, { system: "it", operation: "order-device", employee_ref: "E001" }] });
    expect(caseFacts(s).duplicateSideEffects).toBe(2);
  });

  it("drops coverage when an action has no audit row", () => {
    const s = snap();
    s.audit = s.audit.filter((a) => a.id !== "ic:c2");
    const f = caseFacts(s);
    expect(f.auditedActions).toBe(f.auditableActions - 1);
  });

  it("measures attempts in the final round only, ignoring polls", () => {
    expect(attemptsInFinalRound(snap(), "it.order-device")).toBe(1);
    expect(attemptsInFinalRound(snap(), "hr.create-worker")).toBe(0);
  });
});

describe("expectations", () => {
  const sc = (expect: Scenario["expect"]): Scenario => ({ id: "T", category: "recovery", title: "t", employeeId: "E001", archetype: {}, setup: [], script: [], expect });

  it("pass when every assertion holds", () => {
    expect(
      evaluateExpectations(
        sc({
          terminal: "complete",
          attempts: { "it.order-device": 1 },
          sideEffects: { "it.order-device": 1 },
          replayed: ["it.order-device"],
          blockers: [{ kind: "integration_outage", stage: "it_provisioning", ownerDepartment: "it" }],
          rounds: { it_provisioning: 2 },
          gateChecks: { paperwork: 1 },
          auditActions: ["blocker.auto_resolved"],
          absentAuditActions: ["case.failed"],
          auditCounts: { "approval.approved": 1 },
        }),
        snap(),
      ),
    ).toEqual([]);
  });

  it("report each failed assertion", () => {
    const failures = evaluateExpectations(
      sc({ terminal: { failed: "terminated" }, attempts: { "it.order-device": 3 }, blockers: [], rounds: { intake: 2 }, absentAuditActions: ["blocker.opened"], auditCounts: { "task.completed": 2 } }),
      snap(),
    );
    expect(failures).toHaveLength(6);
  });
});

describe("run metrics", () => {
  it("computes completion and pass rates by category", () => {
    const rs = [result("A"), result("B", { passed: false, failures: ["x"], failureReason: "expectation_failed" }), result("C", { category: "recovery", completed: false, passed: false, failureReason: "deadline", facts: null })];
    const m = computeMetrics(rs, { startedCases: 3, totalMs: 5000, hub: { matchesReconcile: true, diffs: [] } });
    expect(m.totals).toEqual({ startedCases: 3, scenarios: 3, completed: 2, completionRate: 0.6667, passed: 1, passRate: 0.3333 });
    expect(m.byCategory.onboarding).toEqual({ scenarios: 2, completed: 2, passed: 1 });
    expect(m.byCategory.recovery).toEqual({ scenarios: 1, completed: 0, passed: 0 });
    expect(m.failures.map((f) => [f.scenarioId, f.reason])).toEqual([
      ["B", "expectation_failed"],
      ["C", "deadline"],
    ]);
    expect(m.integration.calls).toBe(8);
    expect(m.integration.bySystem.it.replayed).toBe(2);
  });

  it("scores blocker detection with precision and recall over (kind, stage)", () => {
    const facts = caseFacts(snap());
    const rs = [
      result("A", { expectedBlockers: [{ kind: "integration_outage", stage: "it_provisioning" }], facts }),
      result("B", { expectedBlockers: [{ kind: "data_issue", stage: "intake" }], facts }),
      result("C", { expectedBlockers: null, facts }),
    ];
    expect(blockerScores(rs)).toEqual({ expected: 2, detected: 2, truePositives: 1, precision: 0.5, recall: 0.5 });
  });

  it("gates CI on started, completed, passed, duplicates, audit coverage and hub consistency", () => {
    const ok = computeMetrics([result("A")], { startedCases: 1, totalMs: 1, hub: { matchesReconcile: true, diffs: [] } });
    expect(ciGate(ok, 1)).toEqual([]);
    const bad = computeMetrics([result("A", { completed: false, passed: false })], { startedCases: 0, totalMs: 1, hub: { matchesReconcile: false, diffs: ["totals"] } });
    expect(ciGate(bad, 1)).toHaveLength(4);
  });

  it("has well-defined ratio and percentile helpers", () => {
    expect(ratio(1, 0)).toBe(0);
    expect(ratio(2, 3)).toBe(0.6667);
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([], 50)).toBe(0);
  });
});

describe("chaos aggregates", () => {
  const seed = (n: number, completed: number, cases = 60): ChaosSeedSummary => ({ seed: n, completed, cases, failures: { bot_patience: 0, deadline: cases - completed, case_failed: 0 } });

  it("reports the mean, min and max of the per-seed completion rates, rounded to 4 places", () => {
    const perSeed = [seed(1, 58), seed(2, 57), seed(3, 58), seed(4, 58), seed(5, 56)];
    const a = chaosAggregate(perSeed);
    expect(a).toMatchObject({ meanCompletion: 0.9567, minCompletion: 0.9333, maxCompletion: 0.9667 });
    expect(a.perSeed).toBe(perSeed);
  });

  it("averages over seeds, not over pooled cases", () => {
    // pooled would be 10/12 = 0.8333; the per-seed mean is (0.5 + 0.9) / 2
    expect(chaosAggregate([seed(1, 1, 2), seed(2, 9, 10)])).toMatchObject({ meanCompletion: 0.7, minCompletion: 0.5, maxCompletion: 0.9 });
  });

  it("counts a seed with no cases as 0, and an empty run as all zeros", () => {
    expect(chaosAggregate([seed(1, 60), seed(2, 0, 0)])).toMatchObject({ meanCompletion: 0.5, minCompletion: 0, maxCompletion: 1 });
    expect(chaosAggregate([])).toEqual({ perSeed: [], meanCompletion: 0, minCompletion: 0, maxCompletion: 0 });
  });
});

describe("run invocation in the README", () => {
  const base = { mode: "chaos", llmProvider: "stub", gitSha: "f442532aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };

  it("says when the command is inferred, for runs that predate recorded commands", () => {
    expect(describeInvocation(base, "2026-10-09")).toBe(
      "Command `npm run eval:chaos` (inferred from the mode; this run predates recorded commands), run 2026-10-09 (git f442532, read when the run ended)",
    );
  });

  it("renders the recorded command, the commit at start and the tree state", () => {
    const provenance = { npmScript: "eval:scale", argv: ["--mode", "scale", "--llm", "stub", "--keep"], headAtStart: "6dbf935bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", cleanTreeAtStart: true };
    expect(describeInvocation({ ...base, mode: "scale", provenance }, "2026-10-09")).toBe(
      "Command `node eval/harness/run.ts --mode scale --llm stub --keep` (via `npm run eval:scale`), run 2026-10-09 (git 6dbf935 at start, clean tree)",
    );
    expect(describeInvocation({ ...base, provenance: { ...provenance, npmScript: null, cleanTreeAtStart: false } }, "2026-10-09")).toContain("(git 6dbf935 at start, **uncommitted changes in the tree**)");
  });
});
