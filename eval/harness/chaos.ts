// Chaos mode (SPEC 12.3): the same 60 employees for each of K seeds, each
// seed on a fresh state directory and its own wrangler dev process, with no
// per-scenario script. Seeded faults (some beyond the retry budget), sustained
// outage windows and data corruption hit the simulated systems; generic,
// seeded persona bots act only on what the API shows them. Completion is
// measured per seed and reported as mean, min and max.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { BlockerView, EmployeeProfileDto, EmployeeSummary, Page } from "../../src/shared/api.ts";
import { generateDataset } from "../../src/shared/synthetic/generate.ts";
import { SCENARIOS } from "../scenarios/index.ts";
import { Harness, type HttpResult } from "./actions.ts";
import { caseFacts } from "./assertions.ts";
import { type HostStalls, watchHost } from "./host.ts";
import type { ScenarioResult } from "./metrics.ts";
import {
  type BotMemory,
  CHAOS,
  CHAOS_VARS,
  chaosSchedule,
  coordinatorDecision,
  correctionFor,
  employeePlan,
  managerPlan,
  newMemory,
  peopleOpsDelay,
  photoDelay,
  SYSTEM_POSTS,
} from "./policies.ts";
import { writeRunSecrets } from "./secrets.ts";
import { EVAL_VARS, hubConsistency, pool, prepareDatabase, ROOT, SIMULATED_NOW, snapshot, startServer } from "./server.ts";

export type ChaosFailure = "bot_patience" | "deadline" | "case_failed";
/**
 * Harness-side transport health for one seed. Control actions are the
 * orchestrator's own schedule (faults, outage windows, stall clears, clock,
 * corruption); a control failure means the committed schedule was not fully
 * applied and the seed is flagged. Bot request errors are persona requests
 * that failed in transport (the bot tries again on a later tick if its
 * policy allows).
 */
export type HarnessHealth = { controlRetries: number; controlFailures: number; botRequestErrors: number; transportRetries: number; transportFailures: number };
export type SeedOutcome = {
  seed: number;
  /** Cases that started: the start request was accepted (202), or a later poll saw the case past not_started. */
  started: number;
  completed: number;
  cases: number;
  failures: Record<ChaosFailure, number>;
  harness: HarnessHealth;
  results: ScenarioResult[];
  hub: { matchesReconcile: boolean; diffs: string[] };
  /** Host stalls while the seed's cases ran (from a healthy server to the end of the seed). */
  host: HostStalls;
};

/** Control calls ride out the API idempotency store's 60 s in-progress window of a request the runtime dropped. */
const CONTROL_DEADLINE_MS = 75_000;
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** True for a failure in transport rather than an answer from the app: network error, 5xx, or a non-JSON body. */
function isTransportError(err: unknown): boolean {
  return err instanceof Error && (/non-JSON body|fetch failed|ECONNRESET|ECONNREFUSED|socket/i.test(err.message) || err.name === "TypeError");
}

/**
 * One orchestrator control call. Retried with the same Idempotency-Key on a
 * transport failure, a 5xx, or 409 idempotency_in_progress: the eval hooks
 * replay a committed request instead of applying it twice, so a retried
 * clock advance or fault plan takes effect exactly once.
 */
export async function control(h: Harness, email: string, health: HarnessHealth, method: string, path: string, body?: unknown, ok: readonly number[] = [200], deadlineMs = CONTROL_DEADLINE_MS): Promise<HttpResult> {
  const key = randomUUID();
  const end = Date.now() + deadlineMs;
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) {
      health.controlRetries++;
      await sleep(Math.min(250 * 2 ** (attempt - 1), 4_000));
    }
    let failure: string;
    try {
      const r = await h.request(email, method, path, body, key);
      if (ok.includes(r.status)) return r;
      const code = (r.body as { error?: { code?: string } } | null)?.error?.code;
      if (r.status < 500 && code !== "idempotency_in_progress") {
        health.controlFailures++;
        throw new Error(`${method} ${path}: HTTP ${r.status} ${code ?? ""}`.trim());
      }
      failure = `${method} ${path}: HTTP ${r.status}${code ? ` ${code}` : ""}`;
    } catch (err) {
      if (!isTransportError(err)) throw err;
      failure = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() >= end) {
      health.controlFailures++;
      throw new Error(`gave up after ${attempt + 1} attempts: ${failure}`);
    }
  }
}

export type Track = {
  id: string;
  managerEmail: string;
  startedAt: number;
  status: string;
  currentStage: string | null;
  /** The case left the run: observed complete or failed, or its deadline passed. Bots stop acting on it. */
  done: boolean;
  finishedAt: number | null;
  /** First poll that saw the case `complete` (an upper bound of the real completion time). */
  completedAt: number | null;
  /** The deadline closed the case while it was neither complete nor failed. */
  deadlineHit: boolean;
  gaveUp: boolean;
  stallClearScheduled: boolean;
  photoCorrupted: boolean;
};

export function newTrack(id: string, managerEmail: string, startedAt: number, started: boolean): Track {
  return {
    id,
    managerEmail,
    startedAt,
    status: started ? "in_progress" : "not_started",
    currentStage: null,
    done: false,
    finishedAt: null,
    completedAt: null,
    deadlineHit: false,
    gaveUp: false,
    stallClearScheduled: false,
    photoCorrupted: false,
  };
}

/**
 * Applies one poll of a case's status to its track (SPEC 12.3 and 12.4: a case
 * counts as completed only if it reached `complete` before its deadline). The
 * first poll that sees `complete` records `completedAt`; a poll after the
 * deadline closes a case that is not finished. A case first seen complete
 * after its deadline is closed at that poll and does not count (its exact
 * completion time between two polls is unknown, so the rule is conservative).
 */
export function observeCase(t: Track, s: { caseStatus: string; currentStage: string | null }, now: number, deadlineMs: number): void {
  if (t.done) return;
  t.status = s.caseStatus;
  t.currentStage = s.currentStage;
  if (s.caseStatus === "complete") t.completedAt = now;
  else if (s.caseStatus !== "failed" && now > t.startedAt + deadlineMs) t.deadlineHit = true;
  if (s.caseStatus === "complete" || s.caseStatus === "failed" || t.deadlineHit) {
    t.done = true;
    t.finishedAt = now;
  }
}

/** Completed iff seen complete within the deadline (and the final snapshot agrees); otherwise the reason. */
export function chaosVerdict(t: Track, snapshotCompleted: boolean, deadlineMs: number): { completed: true } | { completed: false; reason: ChaosFailure } {
  if (t.completedAt !== null && t.completedAt - t.startedAt <= deadlineMs && snapshotCompleted) return { completed: true };
  if (t.status === "failed") return { completed: false, reason: "case_failed" };
  if (t.gaveUp) return { completed: false, reason: "bot_patience" };
  return { completed: false, reason: "deadline" };
}

const STALL_STAGE: Record<string, string> = { "hr.start-document-verification": "paperwork", "it.order-device": "it_provisioning", "facilities.issue-badge": "facilities_setup" };
const STAGE_ORDER = ["intake", "paperwork", "manager_approval", "it_provisioning", "facilities_setup", "provisioning_verification", "orientation", "closeout"];

/** Timed actions the orchestrator fires from its loop. */
class Timeline {
  #items: Array<{ at: number; key: string; fn: () => Promise<void> }> = [];
  #keys = new Set<string>();
  add(at: number, key: string, fn: () => Promise<void>): void {
    if (this.#keys.has(key)) return;
    this.#keys.add(key);
    this.#items.push({ at, key, fn });
  }
  has(key: string): boolean {
    return this.#keys.has(key);
  }
  #running = new Set<Promise<void>>();
  /** Starts every due action without waiting for it, so a control call riding out a runtime hiccup does not stall the bots. */
  fireDue(now: number): void {
    const due = this.#items.filter((i) => i.at <= now);
    this.#items = this.#items.filter((i) => i.at > now);
    for (const d of due) {
      const p: Promise<void> = d
        .fn()
        .catch((err: unknown) => {
          console.warn(`chaos action ${d.key} failed: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => this.#running.delete(p));
      this.#running.add(p);
    }
  }
  /** Waits for actions still in flight (end of a seed). */
  async drain(): Promise<void> {
    while (this.#running.size > 0) await Promise.all([...this.#running]);
  }
}

export async function runChaosSeed(seed: number, runId: string, opts: { port: number; inspectorPort: number; concurrency: number }): Promise<SeedOutcome> {
  const dataset = generateDataset();
  const employees = SCENARIOS.map((s) => dataset.employees.find((e) => e.id === s.employeeId)!);
  const stateDir = join(ROOT, "eval/.state", runId, String(seed));
  console.log(`chaos seed ${seed}: preparing ${stateDir}`);
  prepareDatabase(ROOT, stateDir);
  const { path: envFile } = await writeRunSecrets(stateDir);
  const server = await startServer(ROOT, { stateDir, envFile, port: opts.port, inspectorPort: opts.inspectorPort, vars: { ...EVAL_VARS, ...CHAOS_VARS, LLM_PROVIDER: "stub" } });
  // Watch for host stalls only from here: prepareDatabase above blocks this
  // process on synchronous `wrangler d1` calls, which the detector would
  // otherwise count as a stall although no case has started.
  const watch = watchHost();
  try {
    const h = new Harness(server.baseUrl, dataset);
    const admin = h.emailFor("admin", "");
    const coordinators = { people_ops: h.emailFor("people_ops", ""), it: h.emailFor("it", ""), facilities: h.emailFor("facilities", "") } as const;
    const health: HarnessHealth = { controlRetries: 0, controlFailures: 0, botRequestErrors: 0, transportRetries: 0, transportFailures: 0 };
    const ctl = (method: string, path: string, body?: unknown) => control(h, admin, health, method, path, body);
    /** A persona request block; a transport error skips it for this tick and is counted. */
    const bot = async (what: string, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn();
      } catch (err) {
        if (!isTransportError(err)) throw err;
        health.botRequestErrors++;
        console.warn(`chaos bot ${what}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    await h.token(admin);
    const probe = await h.admin("POST", "/api/cases/E150/scan", {});
    if (probe.status !== 200) throw new Error(`preflight failed: ${probe.status}`);
    await ctl("POST", "/api/dev/clock/advance", { ms: Date.parse(SIMULATED_NOW) - Date.now() });

    const schedule = chaosSchedule(
      seed,
      employees.map((e) => ({ id: e.id, employmentType: e.employmentType, orgUnit: e.orgUnit })),
    );
    // per-employee faults and setup corruptions, before any case starts
    const stallIds = new Map<string, { id: number; clearAfterMs: number; opId: string }>();
    for (const f of schedule.faults) {
      const r = await ctl("POST", "/api/dev/faults", { system: f.system, operation: f.operation, employeeRef: f.employeeRef, fault: f.fault, remaining: f.remaining, ...(f.params ? { params: f.params } : {}) });
      if (f.fault === "stall" && f.clearAfterMs) stallIds.set(f.employeeRef, { id: r.body.id as number, clearAfterMs: f.clearAfterMs, opId: f.opId });
    }
    for (const c of schedule.corruptions.filter((x) => x.when === "setup")) {
      await ctl("PATCH", `/api/dev/employees/${c.employeeRef}/corrupt`, { field: c.field, value: c.value });
    }

    const t0 = Date.now();
    const timeline = new Timeline();
    const tracks = new Map<string, Track>();
    // sustained outage windows (all POST operations of a system, any employee)
    for (const [i, o] of schedule.outages.entries()) {
      timeline.add(t0 + o.startMs, `outage:${o.system}:${i}:start`, async () => {
        const ids: number[] = [];
        for (const op of SYSTEM_POSTS[o.system]) {
          const r = await ctl("POST", "/api/dev/faults", { system: o.system, operation: op, employeeRef: null, fault: "fail_503", remaining: null });
          ids.push(r.body.id as number);
        }
        timeline.add(Date.now() + o.durationMs, `outage:${o.system}:${i}:end`, async () => {
          await ctl("DELETE", `/api/dev/faults?ids=${ids.join(",")}`);
        });
      });
    }
    // simulated time: one jump that lets every due date and SLA expire, then periodic ticks
    timeline.add(t0 + schedule.clockJumpAtMs, "clock:jump", async () => {
      await ctl("POST", "/api/dev/clock/advance", { ms: CHAOS.clockJumpMs });
    });
    for (let k = 1; k * CHAOS.clockTickEveryMs < CHAOS.caseDeadlineMs + 60_000; k++) {
      timeline.add(t0 + schedule.clockJumpAtMs + k * CHAOS.clockTickEveryMs, `clock:tick:${k}`, async () => {
        await ctl("POST", "/api/dev/clock/advance", { ms: CHAOS.clockTickMs });
      });
    }

    // start every case (bounded concurrency)
    await pool(employees, opts.concurrency, async (e) => {
      const r = await control(h, coordinators.people_ops, health, "POST", `/api/cases/${e.id}/start`, {}, [202]).catch(() => ({ status: 0 }));
      tracks.set(e.id, newTrack(e.id, h.emailFor("manager", e.id), Date.now(), r.status === 202));
    });

    const memory = new Map<string, BotMemory>();
    const decided = new Set<string>();
    const ccCache = new Map<string, string[]>();
    const employeeSeen = new Map<string, number>();
    let lastEmployeePoll = 0;

    const peerCostCenters = async (orgUnit: string): Promise<string[]> => {
      if (ccCache.has(orgUnit)) return ccCache.get(orgUnit)!;
      const list = await h.request<Page<EmployeeSummary>>(coordinators.people_ops, "GET", `/api/employees?orgUnit=${encodeURIComponent(orgUnit)}&limit=12`);
      const values: string[] = [];
      for (const s of list.body.items) {
        const p = await h.request<EmployeeProfileDto>(coordinators.people_ops, "GET", `/api/employees/${s.id}`);
        if (p.status === 200) values.push(p.body.costCenter);
      }
      ccCache.set(orgUnit, values);
      return values;
    };

    /** Bots act only on cases still in the run: a case past its deadline (or finished) gets no more help. */
    const live = (employeeId: string) => {
      const t = tracks.get(employeeId);
      return t !== undefined && !t.done;
    };
    for (;;) {
      const now = Date.now();
      timeline.fireDue(now);

      // case statuses as the admin sees them in the cases table
      let summaries: EmployeeSummary[] = [];
      await bot("case status poll", async () => {
        const page1 = await h.request<Page<EmployeeSummary>>(admin, "GET", "/api/employees?limit=100");
        const page2 = page1.body.nextCursor ? await h.request<Page<EmployeeSummary>>(admin, "GET", `/api/employees?limit=100&cursor=${page1.body.nextCursor}`) : null;
        summaries = [...page1.body.items, ...(page2?.body.items ?? [])];
      });
      for (const s of summaries) {
        const t = tracks.get(s.id);
        if (!t || t.done) continue;
        observeCase(t, s, now, CHAOS.caseDeadlineMs);
        if (t.done) continue;
        const idx = STAGE_ORDER.indexOf(s.currentStage ?? "");
        // orchestrator-side schedule (not a bot): clear stalls a seeded time after the stalled stage starts,
        // and apply photo corruption once paperwork is behind the case.
        const stall = stallIds.get(s.id);
        if (stall && !t.stallClearScheduled && idx >= STAGE_ORDER.indexOf(STALL_STAGE[stall.opId] ?? "closeout")) {
          t.stallClearScheduled = true;
          timeline.add(now + stall.clearAfterMs, `stall:${s.id}`, async () => {
            await ctl("DELETE", `/api/dev/faults?ids=${stall.id}`);
          });
        }
        const photo = schedule.corruptions.find((c) => c.employeeRef === s.id && c.when === "after_paperwork");
        if (photo && !t.photoCorrupted && idx >= STAGE_ORDER.indexOf("manager_approval") && idx <= STAGE_ORDER.indexOf("it_provisioning")) {
          t.photoCorrupted = true;
          timeline.add(now, `photo:${s.id}`, async () => {
            await ctl("PATCH", `/api/dev/employees/${s.id}/corrupt`, { field: "photoOnFile", value: 0 });
          });
        }
      }
      timeline.fireDue(now);
      const active = [...tracks.values()].filter((t) => !t.done);
      if (active.length === 0) break;

      // employees: complete a waiting stage's tasks after a seeded delay (or, if disengaged, once an overdue follow-up exists)
      if (now - lastEmployeePoll >= 1000) {
        lastEmployeePoll = now;
        await Promise.all(
          active.map((t) => bot(`employee ${t.id}`, async () => {
            const email = h.emailFor("employee", t.id);
            const cl = await h.request<{ stages: Array<{ id: string; status: string }>; tasks: Array<{ id: string; stageId: string; status: string }>; blockers: Array<{ kind: string }> }>(email, "GET", "/api/me/checklist");
            if (cl.status !== 200) return;
            const waiting = cl.body.stages.find((s) => s.status === "waiting_on_employee");
            if (!waiting || (waiting.id !== "paperwork" && waiting.id !== "orientation")) return;
            const plan = employeePlan(seed, t.id);
            if (plan.ignoresTasks && !cl.body.blockers.some((b) => b.kind === "employee_task_overdue")) return;
            const key = `${t.id}:${waiting.id}`;
            if (!employeeSeen.has(key)) employeeSeen.set(key, now);
            if (now - (employeeSeen.get(key) as number) < plan.delayMs[waiting.id]) return;
            for (const task of cl.body.tasks.filter((x) => x.stageId === waiting.id && x.status === "open")) {
              await h.request(email, "POST", `/api/tasks/${encodeURIComponent(task.id)}/complete`, {});
            }
          })),
        );
      }

      // managers: decide their reports' checkpoint after a seeded delay; some reject round 1, some never answer
      const managers = new Set(active.map((t) => t.managerEmail));
      await Promise.all(
        [...managers].map((email) => bot(`manager ${email}`, async () => {
          const r = await h.request<Page<{ id: string; employeeId: string; round: number; checkpoint: string; request: { needsPrivilegedAccess?: boolean } }>>(email, "GET", "/api/approvals?status=pending&limit=100");
          for (const a of r.body?.items ?? []) {
            if (!live(a.employeeId) || a.checkpoint !== "manager_approval" || decided.has(a.id)) continue;
            const plan = managerPlan(seed, a.employeeId);
            if (plan.neverRespond) continue;
            decided.add(a.id);
            const reject = plan.rejectFirst && a.round === 1;
            timeline.add(now + plan.delayMs, `manager:${a.id}`, () =>
              bot(`manager decision ${a.id}`, async () => {
                if (!live(a.employeeId)) return;
                await h.request(email, "POST", `/api/approvals/${encodeURIComponent(a.id)}/decision`, reject ? { decision: "reject", reason: "please revise the equipment request" } : { decision: "approve", ...(a.request.needsPrivilegedAccess ? { privilegedAccessApproved: true } : {}) });
              }),
            );
          }
        })),
      );

      // People Ops: sign off closeouts, resubmit rejected requests
      await bot("people ops queue", async () => {
      const po = await h.request<Page<{ id: string; employeeId: string; checkpoint: string; status: string; resubmittable?: boolean }>>(coordinators.people_ops, "GET", "/api/approvals?status=all&limit=100");
      for (const a of po.body?.items ?? []) {
        if (!live(a.employeeId) || decided.has(`po:${a.id}`)) continue;
        if (a.status === "pending" && a.checkpoint === "closeout") {
          decided.add(`po:${a.id}`);
          timeline.add(now + peopleOpsDelay(seed, a.id), `closeout:${a.id}`, () =>
            bot(`closeout ${a.id}`, async () => {
              if (!live(a.employeeId)) return;
              await h.request(coordinators.people_ops, "POST", `/api/approvals/${encodeURIComponent(a.id)}/decision`, { decision: "approve" });
            }),
          );
        } else if (a.status === "rejected" && a.resubmittable) {
          decided.add(`po:${a.id}`);
          timeline.add(now + peopleOpsDelay(seed, `resubmit:${a.id}`), `resubmit:${a.id}`, () =>
            bot(`resubmit ${a.id}`, async () => {
              if (!live(a.employeeId)) return;
              await h.request(coordinators.people_ops, "POST", `/api/approvals/${encodeURIComponent(a.id)}/resubmit`, { note: "revised per the reviewer" });
            }),
          );
        }
      }
      });

      // admin: decide overdue approvals on behalf
      await bot("admin overdue approvals", async () => {
      const overdue = await h.request<Page<BlockerView>>(admin, "GET", "/api/blockers?kind=approval_overdue&status=open&limit=100");
      for (const b of overdue.body?.items ?? []) {
        const approvalId = (b.detail as { approvalId?: string }).approvalId;
        if (!approvalId || !live(b.employeeId) || decided.has(`admin:${approvalId}`)) continue;
        decided.add(`admin:${approvalId}`);
        decided.add(approvalId);
        await h.request(admin, "POST", `/api/approvals/${encodeURIComponent(approvalId)}/decision`, { decision: "approve", privilegedAccessApproved: true });
      }
      });

      // department coordinators: work their own blocker queue
      for (const [dept, email] of Object.entries(coordinators)) {
        await bot(`${dept} coordinator`, async () => {
        const q = await h.request<Page<BlockerView>>(email, "GET", "/api/blockers?status=open&limit=100");
        for (const b of q.body?.items ?? []) {
          if (!live(b.employeeId) || b.ownerDepartment !== dept) continue;
          const m = memory.get(b.id) ?? newMemory(now);
          memory.set(b.id, m);
          let correction: string | null = null;
          const field = (b.detail as { field?: string }).field;
          if (b.kind === "data_issue" && !m.fixed && (field === "costCenter" || field === "licenseBundle")) {
            const p = await h.request<EmployeeProfileDto>(email, "GET", `/api/employees/${b.employeeId}`);
            correction = field === "costCenter" ? correctionFor(field, p.body, (await peerCostCenters(p.body.orgUnit)).filter((x) => x !== p.body.costCenter)) : correctionFor(field, p.body, []);
          }
          const decision = coordinatorDecision(b, m, now, { photoDelayMs: photoDelay(seed, b.id), correction });
          if (decision.kind === "ignore" || decision.kind === "wait") continue;
          if (decision.kind === "request_photo") {
            m.photoRequestedMs = now;
            continue;
          }
          if (decision.kind === "fix") {
            const r = await h.request(email, "PATCH", `/api/employees/${b.employeeId}`, { [decision.field]: decision.value });
            if (r.status === 200) m.fixed = true;
            continue;
          }
          // retry and give-up only make sense while the stage is actually blocked (visible on the case)
          const c = await h.request<{ stages: Array<{ id: string; status: string }> }>(email, "GET", `/api/cases/${b.employeeId}`);
          const blocked = c.body?.stages?.find((s) => s.id === b.stageId)?.status === "blocked";
          if (!blocked) continue;
          if (decision.kind === "give_up") {
            m.gaveUp = true;
            const t = tracks.get(b.employeeId);
            if (t) t.gaveUp = true;
            continue;
          }
          const r = await h.request(email, "POST", `/api/cases/${b.employeeId}/stages/${b.stageId}/retry`, { note: "retry (chaos bot)" });
          if (r.status === 202) {
            m.retries++;
            m.lastRetryMs = now;
          }
        }
        });
      }
      await new Promise((res) => setTimeout(res, CHAOS.botTickMs));
    }

    await timeline.drain();

    // collect
    const results: ScenarioResult[] = [];
    const failures: Record<ChaosFailure, number> = { bot_patience: 0, deadline: 0, case_failed: 0 };
    let completed = 0;
    for (const sc of SCENARIOS) {
      const t = tracks.get(sc.employeeId)!;
      let facts = null;
      try {
        facts = caseFacts(await snapshot(h, sc.employeeId));
      } catch {
        // counted as not completed below
      }
      const verdict = chaosVerdict(t, facts?.completed === true, CHAOS.caseDeadlineMs);
      const isComplete = verdict.completed;
      const reason: ChaosFailure | null = verdict.completed ? null : verdict.reason;
      if (reason) failures[reason]++;
      else completed++;
      const late = !isComplete && facts?.completed === true ? `; the case was first seen complete only after its ${CHAOS.caseDeadlineMs / 1000} s deadline` : "";
      results.push({
        scenarioId: `chaos-${seed}-${sc.employeeId}`,
        category: sc.category,
        employeeId: sc.employeeId,
        completed: isComplete,
        passed: isComplete,
        durationMs: (t.finishedAt ?? Date.now()) - t.startedAt,
        failures: reason ? [`${reason}: case ${t.status}${facts?.failedReason ? ` (${facts.failedReason})` : ""} at ${t.currentStage ?? "start"}${late}`] : [],
        failureReason: reason ? (reason === "deadline" ? "deadline" : "not_completed") : null,
        facts,
        expectedBlockers: null,
      });
    }
    const hub = await hubConsistency(h);
    health.transportRetries = h.transport.retries;
    health.transportFailures = h.transport.failures;
    console.log(
      `chaos seed ${seed}: ${completed}/60 completed (bot_patience ${failures.bot_patience}, deadline ${failures.deadline}, case_failed ${failures.case_failed}), hub consistent ${hub.matchesReconcile}; ` +
        `harness: ${health.transportRetries} transport retries (${health.transportFailures} still failed), ${health.controlRetries} control retries, ${health.controlFailures} control failures, ${health.botRequestErrors} bot request errors`,
    );
    if (health.controlFailures > 0) console.warn(`chaos seed ${seed}: the committed schedule was not fully applied (${health.controlFailures} control actions failed); this seed is flagged in the results`);
    const started = [...tracks.values()].filter((t) => t.status !== "not_started").length;
    return { seed, started, completed, cases: SCENARIOS.length, failures, harness: health, results, hub, host: watch.stop() };
  } finally {
    watch.stop();
    await server.stop();
  }
}
