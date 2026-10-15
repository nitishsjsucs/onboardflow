// CPU time per invocation from `wrangler tail --format json`. Each tail event
// is a Workers trace item, which carries cpuTime and wallTime (ms), the outcome,
// the execution model and the entrypoint (Durable Object and Workflow classes),
// and any exceptions. The Workers Free plan allows 10 ms of CPU per HTTP
// request and per Workflow step, and 30 s per Durable Object request
// (developers.cloudflare.com: workers/platform/limits, workflows/reference/limits,
// durable-objects/platform/limits); this module only measures and compares.
import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { REPO, wranglerEnv } from "./exec.ts";

export type TailEvent = {
  outcome?: string;
  scriptName?: string | null;
  entrypoint?: string;
  executionModel?: string;
  cpuTime?: number;
  wallTime?: number;
  eventTimestamp?: number | null;
  event?: Record<string, unknown> | null;
  exceptions?: Array<{ name?: string; message?: unknown }>;
  logs?: Array<{ level?: string; message?: unknown }>;
};

/** Splits a stream of concatenated (pretty-printed or not) JSON objects. */
export class JsonObjectStream {
  #buf = "";
  #depth = 0;
  #inString = false;
  #escape = false;
  #start = -1;
  #scan = 0;

  push(chunk: string): unknown[] {
    this.#buf += chunk;
    const out: unknown[] = [];
    for (let i = this.#scan; i < this.#buf.length; i++) {
      const c = this.#buf[i];
      if (this.#inString) {
        if (this.#escape) this.#escape = false;
        else if (c === "\\") this.#escape = true;
        else if (c === '"') this.#inString = false;
        continue;
      }
      if (c === '"' && this.#depth > 0) this.#inString = true;
      else if (c === "{") {
        if (this.#depth === 0) this.#start = i;
        this.#depth++;
      } else if (c === "}" && this.#depth > 0) {
        this.#depth--;
        if (this.#depth === 0) {
          try {
            out.push(JSON.parse(this.#buf.slice(this.#start, i + 1)));
          } catch {
            // not a JSON object after all (a banner line with braces); skip it
          }
          this.#buf = this.#buf.slice(i + 1);
          i = -1;
          this.#start = -1;
        }
      }
    }
    this.#scan = this.#buf.length;
    if (this.#depth === 0) {
      this.#buf = "";
      this.#scan = 0;
    } else {
      // keep the partial object from its start
      this.#buf = this.#buf.slice(this.#start);
      this.#scan = this.#buf.length;
      this.#start = 0;
    }
    return out;
  }
}

export type Kind = { kind: string; limitMs: number; limitSource: string };

const FREE_HTTP_MS = 10;
const FREE_STEP_MS = 10;
const DO_MS = 30_000;

/** Which limit an invocation is held to. */
export function classify(e: TailEvent): Kind {
  const ep = e.entrypoint ?? "";
  const ev = e.event ?? {};
  const request = ev.request as { url?: string } | undefined;
  const path = request?.url ? safePath(request.url) : null;
  if (ep === "OnboardingWorkflow" || e.executionModel === "workflow") {
    return { kind: "workflow (OnboardingWorkflow)", limitMs: FREE_STEP_MS, limitSource: "Workflows Free: 10 ms CPU per step (an invocation can run several steps, so this is an upper bound per step)" };
  }
  if (e.executionModel === "durableObject" || ep === "CaseAgent" || ep === "OpsHubAgent") {
    const sub = "scheduledTime" in ev ? "alarm" : "rpcMethod" in ev ? `rpc ${String(ev.rpcMethod)}` : request ? "fetch" : "other";
    return { kind: `durable object ${ep || "?"} (${sub.startsWith("rpc") ? "rpc" : sub})`, limitMs: DO_MS, limitSource: "Durable Objects: 30 s CPU per request (both plans)" };
  }
  if (path?.startsWith("/sim/")) return { kind: "worker fetch /sim/* (loopback from workflow steps)", limitMs: FREE_HTTP_MS, limitSource: "Workers Free: 10 ms CPU per HTTP request" };
  if (path?.startsWith("/api/") || path?.startsWith("/agents/")) return { kind: `worker fetch ${path.split("/").slice(0, 2).join("/")}/*`, limitMs: FREE_HTTP_MS, limitSource: "Workers Free: 10 ms CPU per HTTP request" };
  return { kind: request ? "worker fetch (other)" : `worker ${Object.keys(ev)[0] ?? "event"}`, limitMs: FREE_HTTP_MS, limitSource: "Workers Free: 10 ms CPU per HTTP request" };
}

function safePath(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

function pct(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? null;
}

export type CpuGroup = {
  kind: string;
  limitMs: number;
  limitSource: string;
  invocations: number;
  withCpuTime: number;
  cpuMs: { p50: number | null; p95: number | null; p99: number | null; max: number | null };
  wallMs: { p50: number | null; max: number | null };
  overLimit: number;
  outcomes: Record<string, number>;
};

export type CpuSummary = {
  events: number;
  eventsWithCpuTime: number;
  groups: CpuGroup[];
  overLimit: number;
  /** Outcomes other than ok (exceededCpu, exceededMemory, exception, canceled, ...). */
  notOk: Record<string, number>;
  /** Distinct exception messages with counts (subrequest-limit errors would show here). */
  exceptions: Array<{ message: string; count: number }>;
  subrequestLimitErrors: number;
};

export function summarize(events: TailEvent[]): CpuSummary {
  const groups = new Map<string, { k: Kind; cpu: number[]; wall: number[]; n: number; outcomes: Record<string, number> }>();
  const notOk: Record<string, number> = {};
  const exc = new Map<string, number>();
  let withCpu = 0;
  for (const e of events) {
    const k = classify(e);
    const g = groups.get(k.kind) ?? { k, cpu: [], wall: [], n: 0, outcomes: {} };
    g.n++;
    if (typeof e.cpuTime === "number") {
      g.cpu.push(e.cpuTime);
      withCpu++;
    }
    if (typeof e.wallTime === "number") g.wall.push(e.wallTime);
    const outcome = e.outcome ?? "unknown";
    g.outcomes[outcome] = (g.outcomes[outcome] ?? 0) + 1;
    if (outcome !== "ok") notOk[outcome] = (notOk[outcome] ?? 0) + 1;
    for (const x of e.exceptions ?? []) {
      const m = `${x.name ?? "Error"}: ${typeof x.message === "string" ? x.message : JSON.stringify(x.message)}`.slice(0, 300);
      exc.set(m, (exc.get(m) ?? 0) + 1);
    }
    groups.set(k.kind, g);
  }
  const out: CpuGroup[] = [...groups.values()].map((g) => {
    const cpu = [...g.cpu].sort((a, b) => a - b);
    const wall = [...g.wall].sort((a, b) => a - b);
    return {
      kind: g.k.kind,
      limitMs: g.k.limitMs,
      limitSource: g.k.limitSource,
      invocations: g.n,
      withCpuTime: cpu.length,
      cpuMs: { p50: pct(cpu, 50), p95: pct(cpu, 95), p99: pct(cpu, 99), max: cpu.length ? (cpu[cpu.length - 1] as number) : null },
      wallMs: { p50: pct(wall, 50), max: wall.length ? (wall[wall.length - 1] as number) : null },
      overLimit: cpu.filter((c) => c > g.k.limitMs).length,
      outcomes: g.outcomes,
    };
  });
  out.sort((a, b) => a.kind.localeCompare(b.kind));
  const exceptions = [...exc.entries()].map(([message, count]) => ({ message, count })).sort((a, b) => b.count - a.count);
  return {
    events: events.length,
    eventsWithCpuTime: withCpu,
    groups: out,
    overLimit: out.reduce((s, g) => s + g.overLimit, 0),
    notOk,
    exceptions,
    subrequestLimitErrors: exceptions.filter((x) => /too many subrequests|too many api requests/i.test(x.message)).reduce((s, x) => s + x.count, 0),
  };
}

export type TailSession = { ready: Promise<boolean>; stop: () => Promise<{ events: TailEvent[]; sampling: boolean; stderr: string }> };

/** Starts `wrangler tail <worker> --format json` (OAuth login; creates a temporary tail that wrangler deletes on exit). */
export function startTail(worker: string): TailSession {
  const child: ChildProcess = spawn(join(REPO, "node_modules", ".bin", "wrangler"), ["tail", worker, "--format", "json"], { cwd: REPO, env: wranglerEnv(), stdio: ["ignore", "pipe", "pipe"] });
  const stream = new JsonObjectStream();
  const events: TailEvent[] = [];
  let stderr = "";
  let sampling = false;
  let markReady: (v: boolean) => void = () => {};
  const ready = new Promise<boolean>((r) => {
    markReady = r;
  });
  const timer = setTimeout(() => markReady(true), 10_000);
  child.stdout?.on("data", (d: Buffer) => {
    for (const o of stream.push(d.toString())) {
      if (o && typeof o === "object" && ("outcome" in o || "event" in o)) events.push(o as TailEvent);
    }
  });
  child.stderr?.on("data", (d: Buffer) => {
    const s = d.toString();
    stderr += s;
    if (/sampling/i.test(s)) sampling = true;
    if (/connected|waiting for logs/i.test(s)) markReady(true);
  });
  child.on("close", () => {
    clearTimeout(timer);
    markReady(false);
  });
  return {
    ready,
    stop: () =>
      new Promise((ok) => {
        clearTimeout(timer);
        if (child.exitCode !== null) {
          ok({ events, sampling, stderr: stderr.slice(-2000) });
          return;
        }
        child.once("close", () => ok({ events, sampling, stderr: stderr.slice(-2000) }));
        child.kill("SIGINT");
        setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      }),
  };
}
