// Local server lifecycle for eval runs: a fresh persisted D1 (migrations +
// committed seed) per run, then `wrangler dev` on the built Worker with eval
// timings, killed as a process group at the end.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
