// Eval harness entry point (SPEC 12):
//   node eval/harness/run.ts [--mode standard|scale] [--llm stub] [--concurrency N] [--gate ci] [--port 8781]
// Runs on `wrangler dev` (local Miniflare/workerd) against a fresh persisted
// D1 per run, with per-run secrets, real HTTP calls as the seed personas,
// and expectations checked against each case's snapshot. Writes
// eval/results/<runId>.json and eval/results/latest-<mode>-<llm>.json.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { generateDataset } from "../../src/shared/synthetic/generate.ts";
import { SCENARIOS } from "../scenarios/index.ts";
import { closeoutApproved, managerApproves, orientation, paperwork } from "../scenarios/script.ts";
import type { Scenario } from "../scenarios/types.ts";
import { executeAction, ExpectationError, Harness, type ScenarioRun, UnknownActionError } from "./actions.ts";
import { caseFacts, evaluateExpectations, type Snapshot } from "./assertions.ts";
import { ciGate, computeMetrics, type EvalRun, type ScenarioResult } from "./metrics.ts";
import { printRun } from "./report.ts";
import { writeRunSecrets } from "./secrets.ts";
import { assertDevBuild, prepareDatabase, startServer } from "./server.ts";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
/** The simulated "now" every run starts from: the seed's reference date (its cohorts start 2026-11-02). */
export const SIMULATED_NOW = "2026-10-08T12:00:00.000Z";
const CASE_DEADLINE_MS = 90_000;

export const EVAL_VARS = {
  AUTH_MODE: "dev",
  EVAL_HOOKS: "on",
  SIM_CLOCK: "on",
  RETRY_BASE_DELAY_MS: "20",
  POLL_INTERVAL_MS: "20",
  INTEGRATION_TIMEOUT_MS: "2000",
  GATE_WAIT_TIMEOUT_MS: "3000",
  NUDGE_AFTER_S: "2",
  HUB_DEBOUNCE_S: "1",
  BLOCKER_SCAN_INTERVAL_S: "5",
};

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function versionOf(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").pop() ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

async function snapshot(h: Harness, employeeId: string): Promise<Snapshot> {
  const r = await h.admin<Snapshot>("GET", `/api/dev/eval/snapshot/${employeeId}`);
  if (r.status !== 200) throw new Error(`snapshot ${employeeId}: ${r.status}`);
  return r.body;
}

export async function runScenario(h: Harness, sc: Scenario, started: Set<string>): Promise<ScenarioResult> {
  const t0 = Date.now();
  const run: ScenarioRun = { h, scenario: sc, employeeId: sc.employeeId, notes: [], keys: { kind: "fresh" }, duplicatePass: false };
  const result: ScenarioResult = {
    scenarioId: sc.id,
    category: sc.category,
    employeeId: sc.employeeId,
    completed: false,
    passed: false,
    durationMs: 0,
    failures: [],
    failureReason: null,
    facts: null,
    expectedBlockers: sc.expect.blockers ? sc.expect.blockers.map((b) => ({ kind: b.kind, stage: b.stage })) : null,
  };
  try {
    for (const item of sc.setup) {
      const r = "corrupt" in item ? await h.admin("PATCH", `/api/dev/employees/${sc.employeeId}/corrupt`, item.corrupt) : await h.admin("POST", "/api/dev/faults", item);
      if (r.status !== 200) throw new ExpectationError(`setup failed: ${r.status} ${JSON.stringify(r.body)}`);
    }
    const scriptStarts = sc.script.some((a) => a.do === "start" || (a.do === "duplicate" && a.action.do === "start"));
    if (!scriptStarts) await executeAction(run, { do: "start" });
    started.add(sc.employeeId);
    for (const a of sc.script) await executeAction(run, a);
    // wait for the terminal status
    const deadline = Date.now() + CASE_DEADLINE_MS;
    for (;;) {
      const r = await h.admin("GET", `/api/cases/${sc.employeeId}`);
      const status = r.body?.case?.status;
      if (status === "complete" || status === "failed") break;
      if (Date.now() > deadline) {
        result.failureReason = "deadline";
        result.failures.push(`deadline: case still ${status} after ${CASE_DEADLINE_MS} ms`);
        break;
      }
      await new Promise((res) => setTimeout(res, 200));
    }
  } catch (err) {
    if (err instanceof UnknownActionError) result.failureReason = "unknown_action";
    else result.failureReason = result.failureReason ?? "expectation_failed";
    result.failures.push(err instanceof Error ? err.message : String(err));
  }
  try {
    // let trailing agent scans (auto-resolution after stage_completed) settle
    await new Promise((res) => setTimeout(res, 1500));
    const snap = await snapshot(h, sc.employeeId);
    result.facts = caseFacts(snap);
    result.completed = result.facts.completed;
    result.failures.push(...evaluateExpectations(sc, snap));
  } catch (err) {
    result.failures.push(`snapshot: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!result.completed && !result.failureReason) result.failureReason = "not_completed";
  if (result.failures.length > 0 && !result.failureReason) result.failureReason = "expectation_failed";
  result.passed = result.completed && result.failures.length === 0;
  result.durationMs = Date.now() - t0;
  console.log(`${result.passed ? "pass" : "FAIL"} ${sc.id.padEnd(26)} ${(result.durationMs / 1000).toFixed(1)} s${result.failures.length ? `  ${result.failures.join("; ").slice(0, 300)}` : ""}`);
  return result;
}

/** Scale mode: every seeded employee through the happy path, no faults. */
function scaleScenarios(dataset: ReturnType<typeof generateDataset>): Scenario[] {
  return dataset.employees.map((e) => ({
    id: `S-${e.id}`,
    category: "onboarding" as const,
    title: `scale ${e.id}`,
    employeeId: e.id,
    archetype: {},
    setup: [],
    script: [paperwork(), managerApproves(), orientation(), closeoutApproved()],
    expect: { terminal: "complete" as const },
  }));
}

function domainOf(s: Record<string, unknown>) {
  const { asOfSeq: _a, reconciledAt: _r, version: _v, ...rest } = s;
  return rest;
}

async function hubConsistency(h: Harness): Promise<{ matchesReconcile: boolean; diffs: string[] }> {
  // quiescence: no new audit rows for 2 x HUB_DEBOUNCE_S
  let last = -1;
  for (let i = 0; i < 120; i++) {
    const r = await h.admin("GET", "/api/audit?limit=1");
    const seq = r.body?.items?.[0]?.seq ?? 0;
    if (seq === last) break;
    last = seq;
    await new Promise((res) => setTimeout(res, 2 * Number(EVAL_VARS.HUB_DEBOUNCE_S) * 1000 + 500));
  }
  // the live hub reconciles on a debounce after the last case change
  let diffs: string[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const [hub, summary] = await Promise.all([h.admin("GET", "/api/dev/eval/hub"), h.admin("GET", "/api/dashboard/summary")]);
    const a = domainOf(hub.body ?? {});
    const b = domainOf(summary.body ?? {});
    diffs = Object.keys(b).filter((k) => JSON.stringify((a as Record<string, unknown>)[k]) !== JSON.stringify((b as Record<string, unknown>)[k]));
    if (diffs.length === 0) return { matchesReconcile: true, diffs };
    await new Promise((res) => setTimeout(res, 2000));
  }
  return { matchesReconcile: false, diffs };
}

async function main() {
  const { values } = parseArgs({
    options: {
      mode: { type: "string", default: "standard" },
      llm: { type: "string", default: "stub" },
      seeds: { type: "string", default: "1" },
      concurrency: { type: "string" },
      gate: { type: "string" },
      port: { type: "string", default: "8781" },
      "inspector-port": { type: "string", default: "9231" },
      only: { type: "string" },
      keep: { type: "boolean", default: false },
    },
  });
  const mode = values.mode ?? "standard";
  if (mode !== "standard" && mode !== "scale") throw new Error(`mode ${mode} is Tier 2 and not built in this version (standard and scale only)`);
  if (values.llm !== "stub") throw new Error("--llm llama is Tier 2 and not built in this version; use --llm stub");
  const concurrency = Number(values.concurrency ?? (mode === "scale" ? 10 : 6));

  assertDevBuild(ROOT);
  const dataset = generateDataset();
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${mode}`;
  const stateDir = join(ROOT, "eval/.state", runId, "0");
  console.log(`eval ${runId}: preparing ${stateDir}`);
  prepareDatabase(ROOT, stateDir);
  const { path: envFile } = await writeRunSecrets(stateDir);
  const server = await startServer(ROOT, {
    stateDir,
    envFile,
    port: Number(values.port),
    inspectorPort: Number(values["inspector-port"]),
    vars: { ...EVAL_VARS, LLM_PROVIDER: "stub" },
  });
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let exitCode = 0;
  try {
    const h = new Harness(server.baseUrl, dataset);
    // fail fast: secrets, login and a guarded no-op mutation must work before any scenario runs
    await h.token(h.emailFor("admin", ""));
    const probe = await h.admin("POST", "/api/cases/E150/scan", {});
    if (probe.status !== 200) throw new Error(`preflight mutation failed: ${probe.status} ${JSON.stringify(probe.body)}`);
    // pin the simulated clock to the seed's reference date
    const pin = await h.admin("POST", "/api/dev/clock/advance", { ms: Date.parse(SIMULATED_NOW) - Date.now() });
    if (pin.status !== 200) throw new Error(`could not pin the simulated clock: ${pin.status}`);

    let scenarios = mode === "scale" ? scaleScenarios(dataset) : SCENARIOS;
    if (values.only) {
      const only = new Set(values.only.split(","));
      scenarios = scenarios.filter((s) => only.has(s.id));
    }
    const started = new Set<string>();
    const parallel = scenarios.filter((s) => !s.movesClock);
    const serial = scenarios.filter((s) => s.movesClock);
    const results = await pool(parallel, concurrency, (s) => runScenario(h, s, started));
    for (const s of serial) results.push(await runScenario(h, s, started));
    const order = new Map(scenarios.map((s, i) => [s.id, i]));
    results.sort((a, b) => (order.get(a.scenarioId) ?? 0) - (order.get(b.scenarioId) ?? 0));

    const hub = await hubConsistency(h);
    const metrics = computeMetrics(results, { startedCases: started.size, totalMs: Date.now() - t0, hub });
    const run: EvalRun = {
      runId,
      startedAt,
      gitSha: git(["rev-parse", "HEAD"]),
      mode,
      llmProvider: "stub",
      seeds: [],
      environment: {
        runtime: "local wrangler dev (Miniflare/workerd)",
        wrangler: versionOf("npx", ["wrangler", "--version"]),
        workerd: versionOf("node", ["-p", "require('./node_modules/workerd/package.json').version"]),
        node: process.version,
        machine: `${platform()} ${release()}, ${cpus().length} cpus`,
      },
      config: {
        retryLimit: 4,
        retryBaseDelayMs: Number(EVAL_VARS.RETRY_BASE_DELAY_MS),
        pollIntervalMs: Number(EVAL_VARS.POLL_INTERVAL_MS),
        pollMax: 12,
        integrationTimeoutMs: Number(EVAL_VARS.INTEGRATION_TIMEOUT_MS),
        gateWaitTimeoutMs: Number(EVAL_VARS.GATE_WAIT_TIMEOUT_MS),
        concurrency,
      },
      simulatedNow: SIMULATED_NOW,
      ...metrics,
      chaos: null,
      scenarios: results,
    };
    const out = join(ROOT, "eval/results");
    mkdirSync(out, { recursive: true });
    const body = JSON.stringify(run, null, 2) + "\n";
    if (!values.only) {
      writeFileSync(join(out, `${runId}.json`), body);
      writeFileSync(join(out, `latest-${mode}-stub.json`), body);
    }
    console.log(`\n${printRun(run)}`);
    if (values.gate === "ci") {
      const problems = ciGate(run, mode === "scale" ? 150 : SCENARIOS.length);
      if (problems.length > 0) {
        console.error(`CI gate failed: ${problems.join("; ")}`);
        exitCode = 1;
      } else console.log("CI gate passed");
    }
  } catch (err) {
    console.error(err instanceof Error ? err.stack : String(err));
    exitCode = 1;
  } finally {
    await server.stop();
    if (!values.keep && exitCode === 0) rmSync(join(ROOT, "eval/.state", runId), { recursive: true, force: true });
  }
  process.exit(exitCode);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
