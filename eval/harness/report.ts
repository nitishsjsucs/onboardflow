// Console table for a run, and the README Results block rendered only from
// recorded eval/results/latest-*.json files (readme-results.test.ts checks
// that the README block equals this rendering).
import type { HostStalls } from "./host.ts";
import type { EvalRun } from "./metrics.ts";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const secs = (ms: number) => `${Math.round(ms / 1000)} s`;

/** "none", or the stalls with a warning that wall-clock timeouts and deadlines are not reliable. */
export function describeStalls(h: HostStalls): string {
  return h.stalls === 0 ? "none" : `${h.stalls} (${secs(h.stalledMs)} in total, longest ${secs(h.longestMs)}): wall-clock timeouts and deadlines in this run are not reliable`;
}

export function printRun(run: EvalRun): string {
  const lines = [
    `mode ${run.mode}, provider ${run.llmProvider}, git ${run.gitSha.slice(0, 7)}, ${run.environment.runtime}`,
    `scenarios ${run.totals.scenarios}, started ${run.totals.startedCases}, completed ${run.totals.completed} (${pct(run.totals.completionRate)}), passed ${run.totals.passed} (${pct(run.totals.passRate)})`,
    ...Object.entries(run.byCategory)
      .filter(([, c]) => c.scenarios > 0)
      .map(([k, c]) => `  ${k.padEnd(20)} ${c.completed}/${c.scenarios} completed, ${c.passed}/${c.scenarios} passed`),
    `integration calls ${run.integration.calls}, retried ${run.integration.retriedCalls}, replays ${run.integration.replays}, duplicate side effects ${run.integration.duplicateSideEffects}`,
    `regression: blockers precision ${run.regression.blockers.precision} recall ${run.regression.blockers.recall}; audit coverage ${run.regression.audit.coverage}; full 8-stage trails ${run.regression.audit.completedCasesWithFull8StageTrail}; hub consistent ${run.regression.hubConsistency.matchesReconcile}`,
    `follow-ups ${run.followups.created}, correct department ${pct(run.followups.correctDepartmentRate)}, drafted by an LLM ${pct(run.followups.draftedByLlmRate)}` +
      (run.followups.llmSchemaValidRate !== null ? `, LLM schema-valid ${pct(run.followups.llmSchemaValidRate)}, category agreement ${pct(run.followups.llmCategoryAgreement ?? 0)}, LLM p50 ${run.followups.llmLatencyP50Ms} ms` : ""),
    `timing p50 ${run.timing.scenarioP50Ms} ms, p95 ${run.timing.scenarioP95Ms} ms, total ${(run.timing.totalMs / 1000).toFixed(1)} s`,
    ...(run.host ? [`host stalls over 5 s: ${describeStalls(run.host)}`] : []),
    ...run.failures.map((f) => `FAIL ${f.scenarioId} ${f.reason}: ${f.detail}`),
  ];
  return lines.join("\n");
}

/** The README Results block, rendered from recorded runs only. */
export function renderResults(runs: EvalRun[]): string {
  const rank = (m: string) => ["standard", "chaos", "scale", "ablation-idempotency", "ablation-retries"].indexOf(m) + 1 || 9;
  const sorted = [...runs].sort((a, b) => rank(a.mode) - rank(b.mode) || a.llmProvider.localeCompare(b.llmProvider) || a.mode.localeCompare(b.mode));
  const out: string[] = [];
  for (const r of sorted) {
    const date = r.startedAt.slice(0, 10);
    const cmd =
      r.mode === "standard" && r.llmProvider.startsWith("llama") ? "npm run eval:llama" : r.mode === "standard" ? "npm run eval:ci" : r.mode === "scale" ? "npm run eval:scale" : r.mode === "chaos" ? "npm run eval:chaos" : `node eval/harness/run.ts --mode ${r.mode}`;
    const titles: Record<string, string> = {
      standard: r.llmProvider.startsWith("llama") ? "Standard mode with a local LLM drafting follow-up wording" : "Standard mode (regression suite, scripted recovery)",
      scale: "Scale mode (all 150 synthetic employees, no faults)",
      chaos: `Chaos mode (seeded faults and policy bots, ${r.seeds.length} seeds)`,
      "ablation-idempotency": "Ablation: Idempotency-Key handling switched off in the simulated systems",
      "ablation-retries": "Ablation: step retries switched off (RETRY_LIMIT=0)",
    };
    out.push(`#### ${titles[r.mode] ?? r.mode}`);
    out.push("");
    out.push(`Command \`${cmd}\`, run ${date} (git ${r.gitSha.slice(0, 7)}), provider \`${r.llmProvider}\`, ${r.environment.runtime}, concurrency ${r.config.concurrency}.`);
    out.push("");
    out.push("| Metric | Value |");
    out.push("|---|---|");
    out.push(`| Cases started | ${r.totals.startedCases} |`);
    out.push(`| Completed | ${r.totals.completed}/${r.totals.scenarios} (${pct(r.totals.completionRate)}) |`);
    if (r.chaos) {
      out.push(`| Completion per seed (mean, min, max) | ${pct(r.chaos.meanCompletion)}, ${pct(r.chaos.minCompletion)}, ${pct(r.chaos.maxCompletion)} |`);
      for (const s of r.chaos.perSeed) {
        const transport = s.harness?.transportRetries !== undefined ? `${s.harness.transportRetries} transport retries, ` : "";
        const harness = s.harness
          ? `; harness: ${transport}${s.harness.controlRetries} control retries, ${s.harness.botRequestErrors} bot request errors${s.harness.controlFailures > 0 ? `, **${s.harness.controlFailures} control actions failed (schedule not fully applied)**` : ""}`
          : "";
        const host = s.host && s.host.stalls > 0 ? `; **host stalled ${secs(s.host.stalledMs)}, deadlines not reliable**` : "";
        out.push(`| Seed ${s.seed} | ${s.completed}/${s.cases}; not completed: ${s.failures.case_failed} failed, ${s.failures.bot_patience} bot patience, ${s.failures.deadline} deadline${harness}${host} |`);
      }
    }
    if (r.mode === "standard" || r.mode.startsWith("ablation")) {
      out.push(`| Passed (completed and every expectation held) | ${r.totals.passed}/${r.totals.scenarios} |`);
      for (const [k, c] of Object.entries(r.byCategory)) out.push(`| ${k.replace("_", " ")} | ${c.passed}/${c.scenarios} passed |`);
    }
    out.push(`| Integration calls (retried, replayed) | ${r.integration.calls} (${r.integration.retriedCalls}, ${r.integration.replays}) |`);
    if (r.followups.llmSchemaValidRate !== null) {
      out.push(`| Follow-ups drafted by the LLM (schema-valid / attempted) | ${r.followups.created} created, ${pct(r.followups.llmSchemaValidRate)} valid, category agrees with the rules ${pct(r.followups.llmCategoryAgreement ?? 0)}, p50 ${r.followups.llmLatencyP50Ms} ms |`);
    }
    out.push(`| Duplicate side effects in the simulated systems | ${r.integration.duplicateSideEffects} |`);
    if (r.harnessTransport) {
      out.push(`| Harness requests retried after a dropped local proxy connection (still failed) | ${r.harnessTransport.retries} (${r.harnessTransport.failures}) |`);
    }
    out.push(`| Audit coverage (regression check) | ${r.regression.audit.coverage} |`);
    out.push(`| Live hub equals D1 reconcile after the run | ${r.regression.hubConsistency.matchesReconcile ? "yes" : "no"} |`);
    out.push(`| Scenario time p50 / p95, wall time | ${(r.timing.scenarioP50Ms / 1000).toFixed(1)} s / ${(r.timing.scenarioP95Ms / 1000).toFixed(1)} s, ${(r.timing.totalMs / 1000).toFixed(0)} s |`);
    if (r.host) out.push(`| Host stalls over 5 s (system sleep or a frozen harness) | ${describeStalls(r.host)} |`);
    out.push("");
  }
  return out.join("\n").trimEnd();
}
