// Production verification: drives a few onboarding cases through the deployed
// Worker with the Access service token, measures CPU time per invocation, and
// writes everything to eval/results/production/verify-<time>.json.
//
//   npm run prod:verify [-- --count 3] [--llm-cases 1] [--employees E141,E142] [--no-tail] [--graphql-wait 120] [--dry-run]
//
// Small on purpose: the account's free allowances are shared with other apps.
// At most 5 cases per run (default 3), of which at most 3 take the data issue
// path that makes the CaseAgent draft a follow-up with Workers AI (default 1,
// so about 12 neurons of the 10,000 a day). The Worker's own daily cap
// (LLM_DAILY_DRAFT_LIMIT) bounds the drafts whatever this script does.
//
// CPU time: `wrangler tail --format json` (OAuth login) records every
// invocation's cpuTime, outcome and exceptions while the cases run; with
// CF_API_TOKEN (Account Analytics Read) the script also reads the Workers and
// D1 analytics for the run's window from the GraphQL API after --graphql-wait
// seconds (the datasets lag by a few minutes; 0 skips it).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CloudflareApi } from "./cloudflare.ts";
import { type CaseOutcome, type DrivePath, driveCase } from "./drive.ts";
import { REPO, readServiceToken, secretsFile, wrangler } from "./exec.ts";
import { ACCOUNT_ID, HOSTNAME, ORIGIN, VERIFY_RESERVE, WORKER_NAME, WORKFLOW_NAME } from "./settings.ts";
import { type CpuSummary, startTail, summarize } from "./tail.ts";
import { productionValues } from "./wrangler-config.ts";

const MAX_CASES = 5;
const MAX_LLM_CASES = 3;

/** Neurons per million tokens (developers.cloudflare.com/workers-ai/platform/pricing, 2026-10-09). */
export const NEURON_RATES: Record<string, { input: number; output: number }> = {
  "@cf/qwen/qwen3-30b-a3b-fp8": { input: 4625, output: 30475 },
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { input: 26668, output: 204805 },
};

export function neurons(model: string, promptTokens: number, completionTokens: number): number | null {
  const r = NEURON_RATES[model];
  return r ? (promptTokens * r.input + completionTokens * r.output) / 1_000_000 : null;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export type Plan = Array<{ employeeId: string; path: DrivePath }>;

/** Which reserved employees take which path: the first `llm` of them the data issue path. */
export function planCases(available: readonly string[], count: number, llm: number): Plan {
  if (!Number.isInteger(count) || count < 1 || count > MAX_CASES) throw new Error(`--count must be 1 to ${MAX_CASES}`);
  if (!Number.isInteger(llm) || llm < 0 || llm > Math.min(MAX_LLM_CASES, count)) throw new Error(`--llm-cases must be 0 to ${Math.min(MAX_LLM_CASES, count)}`);
  if (available.length < count) throw new Error(`only ${available.length} reserved employees are still not started (${VERIFY_RESERVE.join(", ")}); restart or reseed to verify again`);
  return available.slice(0, count).map((employeeId, i) => ({ employeeId, path: i < llm ? "data_issue" : "happy" }));
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const count = Number(arg("--count") ?? 3);
  const llm = Number(arg("--llm-cases") ?? 1);
  const explicit = arg("--employees")?.split(",").map((s) => s.trim()).filter(Boolean);
  const useTail = !process.argv.includes("--no-tail");
  const graphqlWait = Number(arg("--graphql-wait") ?? 120);
  const caseTimeoutMs = Number(arg("--timeout-min") ?? 20) * 60_000;
  const config = productionValues(readFileSync(join(REPO, "wrangler.jsonc"), "utf8"));

  console.log(`OnboardFlow production verification against ${ORIGIN}${dryRun ? " (dry run: no requests)" : ""}`);
  if (dryRun) {
    const plan = planCases(explicit ?? [...VERIFY_RESERVE], count, llm);
    console.log(`would: read the service token from ${secretsFile()} (or ONBOARDFLOW_VERIFY_CLIENT_ID and _SECRET)`);
    console.log(`would: GET ${ORIGIN}/api/me with it and require the admin principal`);
    console.log(`would: pick the first ${count} not_started cases of ${(explicit ?? VERIFY_RESERVE).join(", ")}`);
    for (const p of plan) console.log(`would: drive ${p.employeeId} (${p.path}${p.path === "data_issue" ? ": IT refuses the bundle, the agent drafts one follow-up with Workers AI, the driver corrects and retries" : ""})`);
    if (useTail) console.log(`would: run wrangler tail ${WORKER_NAME} --format json during the run and summarize cpuTime per invocation against the Free limits`);
    console.log(`would: count each instance's steps with wrangler workflows instances describe ${WORKFLOW_NAME} <id> --json`);
    if (graphqlWait > 0) console.log(`would: after ${graphqlWait} s read workersInvocationsAdaptive and d1AnalyticsAdaptiveGroups for the window (CF_API_TOKEN with Account Analytics Read)`);
    console.log("would: write eval/results/production/verify-<time>.json");
    return;
  }

  const token = readServiceToken();
  if (!token) throw new Error(`no service token in ${secretsFile()}; run npm run prod:setup first`);
  const transport = (path: string, init: { method: string; headers: Record<string, string>; body?: string }) =>
    fetch(`${ORIGIN}${path}`, {
      method: init.method,
      redirect: "manual",
      headers: { ...init.headers, "CF-Access-Client-Id": token.clientId, "CF-Access-Client-Secret": token.clientSecret },
      ...(init.body !== undefined ? { body: init.body } : {}),
    });

  const me = await transport("/api/me", { method: "GET", headers: {} });
  if (me.status !== 200) throw new Error(`/api/me with the service token answered HTTP ${me.status} (Access refused it, or the principal is not provisioned)`);
  const principal = (await me.json()) as { email: string; role: string };
  if (principal.role !== "admin") throw new Error(`the service token is ${principal.role}, expected admin`);
  console.log(`service token principal: ${principal.email} (${principal.role})`);

  const candidates: string[] = [];
  for (const id of explicit ?? VERIFY_RESERVE) {
    const r = await transport(`/api/cases/${id}`, { method: "GET", headers: {} });
    if (r.status === 200 && ((await r.json()) as { case: { status: string } }).case.status === "not_started") candidates.push(id);
    if (candidates.length >= count) break;
  }
  const plan = planCases(candidates, count, llm);
  for (const p of plan) console.log(`plan: ${p.employeeId} ${p.path}`);

  const tail = useTail ? startTail(WORKER_NAME) : null;
  if (tail) console.log(`tail: ${(await tail.ready) ? "connected" : "did not connect (CPU time comes only from GraphQL then)"}`);
  const startedAt = new Date();
  const outcomes: CaseOutcome[] = await Promise.all(
    plan.map((p) => driveCase(p.employeeId, p.path, { transport, origin: ORIGIN, pollMs: 3000, caseTimeoutMs, followUpWaitMs: 90_000, log: (l) => console.log(`  ${l}`) })),
  );
  // trailing invocations (workflow completion callbacks, the hub's debounced reconcile)
  if (tail) await new Promise((r) => setTimeout(r, 20_000));
  const finishedAt = new Date();
  const tailed = tail ? await tail.stop() : null;
  const cpu: CpuSummary | null = tailed ? summarize(tailed.events) : null;

  // steps per instance (Workflows Free: 1,024 per instance, 3,000 per day per account)
  const steps: Record<string, Record<string, number> | { error: string }> = {};
  for (const o of outcomes) {
    if (!o.instanceId) continue;
    const r = await wrangler(["workflows", "instances", "describe", WORKFLOW_NAME, o.instanceId, "--json"]);
    try {
      const inst = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))) as { steps?: Array<{ type?: string }> };
      const byType: Record<string, number> = {};
      for (const s of inst.steps ?? []) byType[s.type ?? "?"] = (byType[s.type ?? "?"] ?? 0) + 1;
      steps[o.instanceId] = byType;
    } catch {
      steps[o.instanceId] = { error: (r.stderr || r.stdout).trim().slice(0, 300) };
    }
  }

  // LLM drafts and their cost
  const model = config.llmModel ?? "";
  const drafts = outcomes.flatMap((o) => o.followUps);
  const llmDrafts = drafts.filter((d) => d.draftedBy?.startsWith("llm:"));
  const promptTokens = drafts.reduce((s, d) => s + (d.usage?.promptTokens ?? 0), 0);
  const completionTokens = drafts.reduce((s, d) => s + (d.usage?.completionTokens ?? 0), 0);

  // GraphQL analytics (optional)
  let analytics: Record<string, unknown> = { skipped: graphqlWait <= 0 ? "--graphql-wait 0" : "CF_API_TOKEN not set" };
  if (graphqlWait > 0 && process.env.CF_API_TOKEN) {
    console.log(`waiting ${graphqlWait} s for the analytics datasets to catch up`);
    await new Promise((r) => setTimeout(r, graphqlWait * 1000));
    analytics = await readAnalytics(new CloudflareApi(process.env.CF_API_TOKEN, ACCOUNT_ID), startedAt, new Date(), config.databaseId);
  }

  const complete = outcomes.filter((o) => o.status === "complete").length;
  const stepCounts = Object.values(steps).filter((s): s is Record<string, number> => !("error" in s));
  const maxSteps = stepCounts.length ? Math.max(...stepCounts.map((s) => s.step ?? 0)) : null;
  const verdicts = {
    casesComplete: `${complete}/${outcomes.length}`,
    cpuWithinFreeLimits: cpu ? (cpu.eventsWithCpuTime === 0 ? "not measured (tail events carried no cpuTime)" : cpu.overLimit === 0 ? "yes" : `no: ${cpu.overLimit} invocations over their limit`) : "not measured (--no-tail)",
    workflowInvocationsSeen: cpu ? cpu.groups.some((g) => g.kind.startsWith("workflow")) : null,
    subrequestLimitErrors: cpu?.subrequestLimitErrors ?? null,
    stepsPerInstanceMax: maxSteps,
    stepsWithinFreeLimits: maxSteps === null ? "not measured" : maxSteps <= 1024 ? `yes (max ${maxSteps} of 1,024 per instance; ${stepCounts.reduce((s, c) => s + (c.step ?? 0), 0)} of the account's 3,000 a day)` : "no",
    llmDrafts: `${llmDrafts.length} of ${drafts.length} follow-ups drafted by the model`,
    neuronsEstimated: neurons(model, promptTokens, completionTokens),
  };

  const result = {
    kind: "onboardflow-production-verification",
    host: HOSTNAME,
    gitSha: gitSha(),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    principal: principal.email,
    plan,
    verdicts,
    cases: outcomes,
    workflowSteps: steps,
    cpu,
    tail: tailed ? { events: tailed.events.length, sampling: tailed.sampling, stderrTail: tailed.stderr.slice(-500) } : null,
    llm: { provider: config.llmProvider, model, dailyDraftLimit: config.llmDailyDraftLimit, drafts: drafts.length, llmDrafts: llmDrafts.length, promptTokens, completionTokens, neuronsEstimated: verdicts.neuronsEstimated, rates: NEURON_RATES[model] ?? null },
    analytics,
  };
  const dir = join(REPO, "eval", "results", "production");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `verify-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);

  console.log("\nverdicts:");
  for (const [k, v] of Object.entries(verdicts)) console.log(`  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  if (cpu) for (const g of cpu.groups) console.log(`  cpu ${g.kind}: n=${g.invocations} p50=${g.cpuMs.p50} p99=${g.cpuMs.p99} max=${g.cpuMs.max} ms (limit ${g.limitMs} ms), over ${g.overLimit}`);
  for (const o of outcomes) console.log(`  case ${o.employeeId} ${o.path}: ${o.status}${o.failureReason ? ` (${o.failureReason})` : ""}${o.error ? `: ${o.error}` : ""} in ${Math.round(o.durationMs / 1000)} s`);
  console.log(`\nwrote ${file}`);
  if (complete !== outcomes.length || (cpu && cpu.overLimit > 0) || (cpu && cpu.subrequestLimitErrors > 0)) process.exitCode = 1;
}

async function readAnalytics(cf: CloudflareApi, start: Date, end: Date, databaseId: string | null): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { window: { start: start.toISOString(), end: end.toISOString() } };
  try {
    out.workers = await cf.graphql(
      `query W($accountTag: string, $start: string, $end: string, $script: string) {
        viewer { accounts(filter: {accountTag: $accountTag}) {
          workersInvocationsAdaptive(limit: 100, filter: {scriptName: $script, datetime_geq: $start, datetime_leq: $end}) {
            sum { requests subrequests errors }
            quantiles { cpuTimeP50 cpuTimeP99 }
            dimensions { status }
          }
        } }
      }`,
      { accountTag: ACCOUNT_ID, start: start.toISOString(), end: end.toISOString(), script: WORKER_NAME },
    );
    out.workersNote = "cpuTime quantiles are in microseconds";
  } catch (err) {
    out.workers = { error: (err as Error).message };
  }
  if (databaseId) {
    try {
      out.d1 = await cf.graphql(
        `query D($accountTag: string, $start: Date, $end: Date, $databaseId: string) {
          viewer { accounts(filter: {accountTag: $accountTag}) {
            d1AnalyticsAdaptiveGroups(limit: 100, filter: {date_geq: $start, date_leq: $end, databaseId: $databaseId}) {
              sum { rowsRead rowsWritten readQueries writeQueries }
              dimensions { date }
            }
          } }
        }`,
        { accountTag: ACCOUNT_ID, start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), databaseId },
      );
      out.d1Note = "whole UTC days, not only this run";
    } catch (err) {
      out.d1 = { error: (err as Error).message };
    }
  }
  return out;
}

function gitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

if (process.argv[1]?.endsWith("verify.ts")) {
  main().catch((err: unknown) => {
    console.error(`verification stopped: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
