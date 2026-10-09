// Demo driver (not a resume claim): resets the local state, starts every case
// on a local wrangler dev, and drives a seeded mix of progress so the portal
// and the live dashboard have something to show: 42 cases complete and the
// rest held in each of the 8 stages. Cases rest without faults at the four
// human checkpoints; the three automated stages (intake, IT, Facilities) and
// provisioning verification only hold a case when a simulated outage blocks
// it, so a handful of cases get a sustained 503 there and show real blockers.
//   npm run build && npm run dev:keys   (once)
//   npm run demo:drive -- [--port 8787] [--seed 7]
// Afterwards `npm run serve:local` serves the same local state.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { generateDataset } from "../src/shared/synthetic/generate.ts";
import type { StageStatus, SystemId } from "../src/shared/domain.ts";
import type { StageId } from "../src/shared/stages.ts";
import { executeAction, Harness, type ScenarioRun } from "../eval/harness/actions.ts";
import { rngFor } from "../eval/harness/policies.ts";
import { closeoutApproved, managerApproves, orientation, paperwork } from "../eval/scenarios/script.ts";
import type { Action, Scenario } from "../eval/scenarios/types.ts";
import { assertDevBuild, EVAL_VARS, pool, prepareDatabase, ROOT, SIMULATED_NOW, startServer } from "../eval/harness/server.ts";

/** Where each case is left, and how many cases go there (sums to 150). */
export const DEMO_MIX = {
  complete: 42,
  intake_blocked: 3,
  paperwork: 24,
  manager_approval: 24,
  it_blocked: 3,
  facilities_blocked: 3,
  verification_blocked: 3,
  orientation: 24,
  closeout: 24,
} as const;
export type DemoTarget = keyof typeof DEMO_MIX;
export const DEMO_TARGETS = Object.keys(DEMO_MIX) as DemoTarget[];

/** The sustained outage that holds a blocked target, scoped to that one employee. */
export const DEMO_FAULTS: Partial<Record<DemoTarget, { system: SystemId; operation: string; stage: StageId }>> = {
  intake_blocked: { system: "hr", operation: "create-worker", stage: "intake" },
  it_blocked: { system: "it", operation: "create-account", stage: "it_provisioning" },
  facilities_blocked: { system: "facilities", operation: "issue-badge", stage: "facilities_setup" },
  verification_blocked: { system: "hr", operation: "get-worker", stage: "provisioning_verification" },
};

/** Seeded target per employee, with exactly the DEMO_MIX counts for 150 ids. */
export function demoPlan(seed: number, ids: readonly string[]): Map<string, DemoTarget> {
  const rng = rngFor(seed, "demo");
  const shuffled = [...ids];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j] as string, shuffled[i] as string];
  }
  const slots = DEMO_TARGETS.flatMap((t) => Array.from({ length: DEMO_MIX[t] }, () => t));
  const plan = new Map<string, DemoTarget>();
  shuffled.forEach((id, i) => plan.set(id, slots[i % slots.length] as DemoTarget));
  return plan;
}

/** The human actions for a target, each ending in a wait so no workflow is still moving when the server stops. */
function scriptFor(target: DemoTarget): Action[] {
  const at = (stage: StageId, status: StageStatus): Action => ({ do: "waitStage", stage, status });
  const outageOpen: Action = { do: "expectBlockerStatus", kind: "integration_outage", status: "open" };
  switch (target) {
    case "complete":
      return [paperwork(), managerApproves(), orientation(), closeoutApproved(), at("closeout", "complete")];
    case "intake_blocked":
      return [at("intake", "blocked"), outageOpen];
    case "paperwork":
      return [at("paperwork", "waiting_on_employee")];
    case "manager_approval":
      return [paperwork(), at("manager_approval", "awaiting_approval")];
    case "it_blocked":
    case "facilities_blocked":
    case "verification_blocked":
      return [paperwork(), managerApproves(), at(DEMO_FAULTS[target]!.stage, "blocked"), outageOpen];
    case "orientation":
      return [paperwork(), managerApproves(), at("orientation", "waiting_on_employee")];
    case "closeout":
      return [paperwork(), managerApproves(), orientation(), at("closeout", "awaiting_approval")];
  }
}

async function main() {
  const { values } = parseArgs({ options: { port: { type: "string", default: "8787" }, "inspector-port": { type: "string", default: "9229" }, seed: { type: "string", default: "7" } } });
  assertDevBuild(ROOT);
  const stateDir = join(ROOT, ".wrangler/state");
  console.log(`demo-drive: resetting ${stateDir}`);
  rmSync(stateDir, { recursive: true, force: true });
  prepareDatabase(ROOT, stateDir);
  const server = await startServer(ROOT, {
    stateDir,
    envFile: join(ROOT, ".dev.vars"),
    port: Number(values.port),
    inspectorPort: Number(values["inspector-port"]),
    vars: { ...EVAL_VARS, LLM_PROVIDER: "stub" },
  });
  try {
    const dataset = generateDataset();
    const h = new Harness(server.baseUrl, dataset);
    await h.admin("POST", "/api/dev/clock/advance", { ms: Date.parse(SIMULATED_NOW) - Date.now() });
    const plan = demoPlan(Number(values.seed), dataset.employees.map((e) => e.id));
    for (const [id, target] of plan) {
      const f = DEMO_FAULTS[target];
      if (!f) continue;
      const r = await h.admin("POST", "/api/dev/faults", { system: f.system, operation: f.operation, employeeRef: id, fault: "fail_503", remaining: null });
      if (r.status !== 200) throw new Error(`fault plan for ${id}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    let done = 0;
    await pool([...plan.entries()], 10, async ([id, target]) => {
      const scenario = { id: `demo-${id}`, category: "onboarding", title: target, employeeId: id, archetype: {}, setup: [], script: scriptFor(target), expect: { terminal: "complete" } } as Scenario;
      const run: ScenarioRun = { h, scenario, employeeId: id, notes: [], keys: { kind: "fresh" }, duplicatePass: false };
      try {
        await executeAction(run, { do: "start" });
        for (const a of scenario.script) await executeAction(run, a);
        if (target === "complete") {
          await h.waitFor(`${id} complete`, async () => (await h.admin<{ case: { status: string } }>("GET", `/api/cases/${id}`)).body?.case.status === "complete");
        }
      } catch (err) {
        console.warn(`demo ${id} (${target}): ${err instanceof Error ? err.message : String(err)}`);
      }
      done++;
      if (done % 25 === 0) console.log(`demo-drive: ${done}/150 cases driven`);
    });
    const counts: Record<string, number> = {};
    for (const t of plan.values()) counts[t] = (counts[t] ?? 0) + 1;
    console.log(`demo-drive: done ${JSON.stringify(counts)}. Run \`npm run serve:local\` and sign in as a persona.`);
  } finally {
    await server.stop();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
