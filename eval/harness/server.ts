// Local server lifecycle for eval runs: a fresh persisted D1 (migrations +
// committed seed) per run, then `wrangler dev` on the built Worker with eval
// timings, killed as a process group at the end.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Harness } from "./actions.ts";
import type { Snapshot } from "./assertions.ts";
import type { BuildProvenance, RunProvenance } from "./metrics.ts";

export type ServerOptions = {
  stateDir: string;
  envFile: string;
  port: number;
  inspectorPort: number;
  vars: Record<string, string>;
};

export type RunningServer = { baseUrl: string; child: ChildProcess; logPath: string; stop: () => Promise<void> };

const WRANGLER = ["wrangler"];

function npx(args: string[], cwd: string): string {
  return execFileSync("npx", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
}

export function assertDevBuild(root: string): void {
  const built = join(root, "dist/onboardflow/wrangler.json");
  if (!existsSync(built)) throw new Error("no build found: run `npm run build` first (the dev build, not deploy:dry-run)");
  const cfg = JSON.parse(readFileSync(built, "utf8")) as { ai?: unknown; vars?: Record<string, string> };
  if (cfg.ai || cfg.vars?.AUTH_MODE === "access") {
    throw new Error("dist/ holds a production-flattened build; run `npm run build` again before evaluating");
  }
}

/** sha256 over the relative path and content of every file under dist/client and dist/onboardflow (sorted). */
export function hashDist(root: string): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(join(root, "dist/client"));
  walk(join(root, "dist/onboardflow"));
  const h = createHash("sha256");
  for (const f of files.map((x) => relative(root, x)).sort()) {
    h.update(`${f}\0`);
    h.update(readFileSync(join(root, f)));
    h.update("\0");
  }
  return h.digest("hex");
}

/** The build stamp (dist/build-info.json) and a hash of dist/, checked against the commit the run starts at. */
export function readBuild(root: string, headAtStart: string): BuildProvenance {
  const path = join(root, "dist/build-info.json");
  if (!existsSync(path)) throw new Error("dist/build-info.json is missing: run `npm run build` (this build predates build stamps)");
  const info = JSON.parse(readFileSync(path, "utf8")) as { commit: string; dirtyTree: boolean; builtAt: string };
  return {
    commit: info.commit,
    dirtyTree: info.dirtyTree,
    builtAt: info.builtAt,
    distSha256AtStart: hashDist(root),
    distSha256AtEnd: null,
    matchesHead: info.commit === headAtStart && !info.dirtyTree,
  };
}

/** Why a build does not stand for the commit a run records, or null when it does. */
export function buildMismatch(b: Pick<BuildProvenance, "commit" | "dirtyTree">, headAtStart: string): string | null {
  if (b.commit !== headAtStart) return `dist/ was built from ${b.commit.slice(0, 7)}, but HEAD is ${headAtStart.slice(0, 7)}: run \`npm run build\``;
  if (b.dirtyTree) return "dist/ was built from a tree with uncommitted changes: commit, then run `npm run build`";
  return null;
}

export function prepareDatabase(root: string, stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
  npx([...WRANGLER, "d1", "migrations", "apply", "onboardflow", "--local", "--persist-to", stateDir, "-c", "wrangler.jsonc"], root);
  npx([...WRANGLER, "d1", "execute", "onboardflow", "--local", "--persist-to", stateDir, "-c", "wrangler.jsonc", "--file", "seed/seed.sql"], root);
}

async function waitForHealth(url: string, deadlineMs: number, child: ChildProcess): Promise<void> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited with code ${child.exitCode}`);
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > end) throw new Error(`wrangler dev did not become healthy within ${deadlineMs} ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function startServer(root: string, o: ServerOptions): Promise<RunningServer> {
  const logPath = join(o.stateDir, "wrangler.log");
  const log = openSync(logPath, "a");
  const args = [
    ...WRANGLER,
    "dev",
    "--port",
    String(o.port),
    "--inspector-port",
    String(o.inspectorPort),
    "--persist-to",
    o.stateDir,
    "--env-file",
    o.envFile,
    "--show-interactive-dev-session=false",
    ...Object.entries(o.vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]),
  ];
  const child = spawn("npx", args, { cwd: root, detached: true, stdio: ["ignore", log, log], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  const baseUrl = `http://localhost:${o.port}`;
  const stop = async () => {
    if (child.exitCode !== null || child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // already gone
    }
    for (let i = 0; i < 20 && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 250));
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  };
  try {
    await waitForHealth(baseUrl, 120_000, child);
  } catch (err) {
    await stop();
    throw new Error(`${err instanceof Error ? err.message : String(err)}; see ${logPath}`);
  }
  return { baseUrl, child, logPath, stop };
}

// ---------------------------------------------------------------------------
// Run-wide constants and helpers shared by run.ts and chaos.ts
// ---------------------------------------------------------------------------

export const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
/** The simulated "now" every run starts from: the seed's reference date (its cohorts start 2026-11-02). */
export const SIMULATED_NOW = "2026-10-08T12:00:00.000Z";
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

export function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** The command, commit and tree state a run starts from (recorded in its EvalRun). */
export function runProvenance(): RunProvenance {
  return {
    npmScript: process.env.npm_lifecycle_event ?? null,
    argv: process.argv.slice(2),
    headAtStart: git(["rev-parse", "HEAD"]),
    cleanTreeAtStart: git(["status", "--porcelain"]) === "",
  };
}

export function versionOf(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").pop() ?? "unknown";
  } catch {
    return "unknown";
  }
}

export async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
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

export async function snapshot(h: Harness, employeeId: string): Promise<Snapshot> {
  const r = await h.admin<Snapshot>("GET", `/api/dev/eval/snapshot/${employeeId}`);
  if (r.status !== 200) throw new Error(`snapshot ${employeeId}: ${r.status}`);
  return r.body;
}

function domainOf(s: Record<string, unknown>) {
  const { asOfSeq: _a, reconciledAt: _r, version: _v, ...rest } = s;
  return rest;
}

export async function hubConsistency(h: Harness): Promise<{ matchesReconcile: boolean; diffs: string[] }> {
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

