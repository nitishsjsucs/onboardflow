// Process and file plumbing shared by setup, doctor and verify: wrangler runs
// with its own OAuth login (never an API token from the environment), every
// step is printed, --dry-run prints mutations instead of running them, and the
// verification service token lives in a file outside the repository.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ACCOUNT_ID } from "./settings.ts";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WRANGLER = join(REPO, "node_modules", ".bin", "wrangler");

/** Variables that would make wrangler use an API token instead of its OAuth login. */
export const TOKEN_VARIABLES = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL", "CF_API_TOKEN", "CF_API_KEY", "CF_EMAIL"] as const;

/** The environment wrangler runs with: no credentials of ours, the account pinned, no metrics. */
export function wranglerEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, WRANGLER_SEND_METRICS: "false" };
  for (const k of TOKEN_VARIABLES) delete env[k];
  return env;
}

export type RunResult = { code: number; stdout: string; stderr: string };

/** Runs a command from the repository root; output is captured, and echoed only when `echo` is set. */
export function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string; echo?: boolean } = {}): Promise<RunResult> {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, { cwd: REPO, env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (opts.echo) process.stdout.write(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (opts.echo) process.stderr.write(d);
    });
    child.on("error", fail);
    child.on("close", (code) => ok({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(opts.input ?? "");
  });
}

export function wrangler(args: string[], opts: { input?: string; echo?: boolean } = {}): Promise<RunResult> {
  return run(WRANGLER, args, { ...opts, env: wranglerEnv() });
}

/** wrangler with the production environment of the source config (not the Vite build's redirected config). */
export function wranglerProd(args: string[], opts: { input?: string; echo?: boolean } = {}): Promise<RunResult> {
  return wrangler([...args, "--env", "production", "-c", "wrangler.jsonc"], opts);
}

/** The last JSON value in wrangler's output (it may print banners first). */
export function lastJson<T>(text: string): T {
  for (const open of ["[", "{"]) {
    for (let i = text.lastIndexOf(open); i >= 0; i = text.lastIndexOf(open, i - 1)) {
      try {
        return JSON.parse(text.slice(i)) as T;
      } catch {
        // keep looking further left
      }
      if (i === 0) break;
    }
  }
  throw new Error(`no JSON in output: ${text.slice(0, 200)}`);
}

export function redact(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("[redacted]");
  return out;
}

// ---------------------------------------------------------------------------
// Steps and --dry-run
// ---------------------------------------------------------------------------

export class Steps {
  readonly dryRun: boolean;
  #n = 0;
  readonly planned: string[] = [];

  constructor(dryRun: boolean) {
    this.dryRun = dryRun;
  }

  section(title: string): void {
    this.#n++;
    console.log(`\n${this.#n}. ${title}`);
  }

  info(line: string): void {
    console.log(`   ${line}`);
  }

  /** A read-only action: runs in both modes. */
  async read<T>(what: string, fn: () => Promise<T>): Promise<T> {
    console.log(`   read: ${what}`);
    return fn();
  }

  /** A change to a cloud resource or a tracked file: printed and skipped under --dry-run. */
  async change<T>(what: string, fn: () => Promise<T>, dryValue: T): Promise<T> {
    if (this.dryRun) {
      this.planned.push(what);
      console.log(`   would: ${what}`);
      return dryValue;
    }
    console.log(`   do: ${what}`);
    return fn();
  }
}

// ---------------------------------------------------------------------------
// The verification service token, outside the repository
// ---------------------------------------------------------------------------

export type StoredServiceToken = { accountId: string; tokenId: string; name: string; clientId: string; clientSecret: string; savedAt: string; expiresAt: string | null };

export function secretsFile(): string {
  return process.env.ONBOARDFLOW_SECRETS_FILE ?? join(homedir(), ".config", "onboardflow", "production-service-token.json");
}

export function readServiceToken(file = secretsFile()): StoredServiceToken | null {
  if (process.env.ONBOARDFLOW_VERIFY_CLIENT_ID && process.env.ONBOARDFLOW_VERIFY_CLIENT_SECRET) {
    return {
      accountId: ACCOUNT_ID,
      tokenId: "",
      name: "from environment",
      clientId: process.env.ONBOARDFLOW_VERIFY_CLIENT_ID,
      clientSecret: process.env.ONBOARDFLOW_VERIFY_CLIENT_SECRET,
      savedAt: "",
      expiresAt: null,
    };
  }
  if (!existsSync(file)) return null;
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) throw new Error(`${file} is readable by others (mode ${mode.toString(8)}); run chmod 600 on it`);
  return JSON.parse(readFileSync(file, "utf8")) as StoredServiceToken;
}

export function writeServiceToken(t: StoredServiceToken, file = secretsFile()): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(t, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
