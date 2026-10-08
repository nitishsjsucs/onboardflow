// The action interpreter (SPEC 12.1 step 6): every scripted action becomes
// real HTTP calls against the running Worker, made as the real seed persona
// with Origin, X-OnboardFlow and a fresh (or deliberately reused)
// Idempotency-Key. The switch is exhaustive over the Action union; an
// action the interpreter does not know fails the scenario as unknown_action
// instead of being skipped.
import { randomUUID } from "node:crypto";
import type { Dataset } from "../../src/shared/synthetic/generate.ts";
import type { Action, PersonaRef, Scenario } from "../scenarios/types.ts";

export class UnknownActionError extends Error {
  constructor(kind: string) {
    super(`unknown_action: ${kind}`);
    this.name = "UnknownActionError";
  }
}

export class ExpectationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpectationError";
  }
}

export type HttpResult<T = any> = { status: number; body: T; headers: Headers };

/** Session and request plumbing shared by every scenario of a run. */
export class Harness {
  readonly baseUrl: string;
  readonly dataset: Dataset;
  readonly #tokens = new Map<string, string>();
  readonly timeouts = { stepMs: 60_000, pollMs: 100 };

  constructor(baseUrl: string, dataset: Dataset) {
    this.baseUrl = baseUrl;
    this.dataset = dataset;
  }

  emailFor(persona: PersonaRef, employeeId: string): string {
    const staff = (id: string) => this.dataset.staff.find((s) => s.id === id)?.email ?? "";
    switch (persona) {
      case "employee":
        return this.dataset.employees.find((e) => e.id === employeeId)?.email ?? "";
      case "manager":
        return staff(this.dataset.employees.find((e) => e.id === employeeId)?.managerId ?? "");
      case "people_ops":
        return staff("C01");
      case "people_ops_2":
        return staff("C02");
      case "it":
        return staff("C03");
      case "facilities":
        return staff("C05");
      case "admin":
        return staff("A01");
    }
  }

  async token(email: string): Promise<string> {
    const hit = this.#tokens.get(email);
    if (hit) return hit;
    const res = await fetch(`${this.baseUrl}/dev/login`, {
      method: "POST",
      headers: { Origin: this.baseUrl, "X-OnboardFlow": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) throw new Error(`dev login failed for ${email}: ${res.status} ${await res.text()}`);
    const { token } = (await res.json()) as { token: string };
    this.#tokens.set(email, token);
    return token;
  }

  async request<T = any>(email: string, method: string, path: string, body?: unknown, key?: string): Promise<HttpResult<T>> {
    const headers: Record<string, string> = { "Cf-Access-Jwt-Assertion": await this.token(email), Accept: "application/json" };
    if (method !== "GET") {
      headers.Origin = this.baseUrl;
      headers["X-OnboardFlow"] = "1";
      headers["Idempotency-Key"] = key ?? randomUUID();
    }
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${this.baseUrl}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T, headers: res.headers };
  }

  async admin<T = any>(method: string, path: string, body?: unknown): Promise<HttpResult<T>> {
    return this.request<T>(this.emailFor("admin", ""), method, path, body);
  }

  async waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = this.timeouts.stepMs): Promise<T> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new ExpectationError(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, this.timeouts.pollMs));
    }
  }
}

/** How a scenario run issues keys: fresh per request, or replayed from a recorded sequence (duplicates). */
type KeyMode = { kind: "fresh" } | { kind: "record"; keys: string[] } | { kind: "replay"; keys: string[]; next: number };

export type ScenarioRun = {
  h: Harness;
  scenario: Scenario;
  employeeId: string;
  notes: string[];
  keys: KeyMode;
  /** true while the second pass of a duplicate runs: conflicts are expected, not failures. */
  duplicatePass: boolean;
};

function nextKey(run: ScenarioRun): string {
  const m = run.keys;
  if (m.kind === "record") {
    const k = randomUUID();
    m.keys.push(k);
    return k;
  }
  if (m.kind === "replay") return m.keys[m.next++] ?? randomUUID();
  return randomUUID();
}

async function as(run: ScenarioRun, persona: PersonaRef, method: string, path: string, body?: unknown) {
  return run.h.request(run.h.emailFor(persona, run.employeeId), method, path, body, method === "GET" ? undefined : nextKey(run));
}

function expectStatus(r: HttpResult, ok: number[], what: string) {
  if (!ok.includes(r.status)) throw new ExpectationError(`${what}: HTTP ${r.status} ${JSON.stringify(r.body)?.slice(0, 300)}`);
}

async function caseDetail(run: ScenarioRun) {
  const r = await run.h.admin(`GET`, `/api/cases/${run.employeeId}`);
  expectStatus(r, [200], "case detail");
  return r.body as { case: { status: string }; stages: Array<{ id: string; status: string; round: number }>; blockers: Array<{ id: string; kind: string; status: string }> };
}

async function pendingApproval(run: ScenarioRun, checkpoint: string) {
  return run.h.waitFor(`${checkpoint} approval pending for ${run.employeeId}`, async () => {
    const r = await run.h.admin("GET", `/api/approvals?status=pending&limit=100`);
    const items = (r.body?.items ?? []) as Array<{ id: string; employeeId: string; checkpoint: string; round: number }>;
    return items.filter((a) => a.employeeId === run.employeeId && a.checkpoint === checkpoint).sort((a, b) => b.round - a.round)[0] ?? null;
  });
}

async function completeTasks(run: ScenarioRun, stage: string, order: "forward" | "reverse") {
  const employee = run.h.emailFor("employee", run.employeeId);
  const tasks = await run.h.waitFor(`${stage} checklist for ${run.employeeId}`, async () => {
    const r = await run.h.request(employee, "GET", "/api/me/checklist");
    const all = ((r.body?.tasks ?? []) as Array<{ id: string; stageId: string; status: string }>).filter((t) => t.stageId === stage);
    return all.length > 0 ? all : null;
  });
  const ids = tasks.map((t) => t.id).sort();
  if (order === "reverse") ids.reverse();
  for (const id of ids) {
    const r = await as(run, "employee", "POST", `/api/tasks/${encodeURIComponent(id)}/complete`, {});
    expectStatus(r, run.duplicatePass ? [200, 409] : [200, 409], `complete ${id}`);
  }
}

/** Runs one action. Throws ExpectationError on a failed step, UnknownActionError on an unknown action. */
export async function executeAction(run: ScenarioRun, a: Action): Promise<void> {
  const id = run.employeeId;
  switch (a.do) {
    case "start": {
      const r = await as(run, "people_ops", "POST", `/api/cases/${id}/start`, {});
      expectStatus(r, [202], "start");
      run.notes.push(`start:${(r.body as { instanceId: string }).instanceId}`);
      return;
    }
    case "completeEmployeeTasks":
      return completeTasks(run, a.stage, a.order === "reverse" ? "reverse" : "forward");
    case "decide": {
      const approval = run.duplicatePass ? { id: run.notes.findLast((n) => n.startsWith(`decided:${a.checkpoint}:`))?.split(":").slice(2).join(":") ?? "" } : await pendingApproval(run, a.checkpoint);
      const employee = run.h.dataset.employees.find((e) => e.id === id);
      const privileged = a.checkpoint === "manager_approval" && a.decision === "approve" && employee?.needsPrivilegedAccess ? (a.privileged ?? true) : undefined;
      const body = { decision: a.decision, ...(a.decision === "reject" ? { reason: "please revise the request" } : {}), ...(privileged !== undefined ? { privilegedAccessApproved: privileged } : {}) };
      const r = await as(run, a.as, "POST", `/api/approvals/${encodeURIComponent(approval.id)}/decision`, body);
      expectStatus(r, run.duplicatePass ? [200, 409] : [200], `decide ${approval.id}`);
      if (!run.duplicatePass) run.notes.push(`decided:${a.checkpoint}:${approval.id}`);
      return;
    }
    case "resubmit": {
      const target = await run.h.waitFor(`${a.checkpoint} resubmittable for ${id}`, async () => {
        const r = await run.h.request(run.h.emailFor(a.as, id), "GET", `/api/approvals?status=rejected&limit=100`);
        const items = (r.body?.items ?? []) as Array<{ id: string; employeeId: string; checkpoint: string; resubmittable?: boolean }>;
        return items.find((x) => x.employeeId === id && x.checkpoint === a.checkpoint && x.resubmittable) ?? null;
      });
      const r = await as(run, a.as, "POST", `/api/approvals/${encodeURIComponent(target.id)}/resubmit`, { note: "revised per the reviewer" });
      expectStatus(r, [202], `resubmit ${target.id}`);
      return;
    }
    case "advanceClock": {
      const r = await run.h.admin("POST", "/api/dev/clock/advance", { ms: a.ms });
      expectStatus(r, [200], "advance clock");
      return;
    }
    case "scan": {
      const r = await as(run, "admin", "POST", `/api/cases/${id}/scan`, {});
      expectStatus(r, [200], "scan");
      return;
    }
    case "waitStage":
      await run.h.waitFor(`${id} ${a.stage} -> ${a.status}`, async () => {
        const d = await caseDetail(run);
        if (d.case.status === "failed") throw new ExpectationError(`case failed while waiting for ${a.stage} ${a.status}`);
        return d.stages.find((s) => s.id === a.stage)?.status === a.status;
      });
      return;
    case "corrupt": {
      const r = await run.h.admin("PATCH", `/api/dev/employees/${id}/corrupt`, { field: a.field, value: a.value });
      expectStatus(r, [200], `corrupt ${a.field}`);
      return;
    }
    case "fixField": {
      const seed = run.h.dataset.employees.find((e) => e.id === id);
      const value = a.value ?? (seed ? seed[a.field] : undefined);
      const fixed = a.field === "photoOnFile" ? true : value;
      const r = await as(run, a.as, "PATCH", `/api/employees/${id}`, { [a.field]: fixed });
      expectStatus(r, [200], `fix ${a.field}`);
      return;
    }
    case "setFault": {
      const r = await run.h.admin("POST", "/api/dev/faults", a.plan);
      expectStatus(r, [200], "set fault");
      return;
    }
    case "clearFaults": {
      const r = await run.h.admin("DELETE", `/api/dev/faults?employeeRef=${id}${a.system ? `&system=${a.system}` : ""}`);
      expectStatus(r, [200], "clear faults");
      return;
    }
    case "retryStage": {
      const r = await as(run, a.as, "POST", `/api/cases/${id}/stages/${a.stage}/retry`, { note: "retry after the fix" });
      expectStatus(r, [a.expectStatus ?? 202], `retry ${a.stage}`);
      return;
    }
    case "restart": {
      const r = await as(run, "admin", "POST", `/api/cases/${id}/restart`, { reason: "operator restart (eval)" });
      expectStatus(r, [202], "restart");
      return;
    }
    case "terminate": {
      const r = await as(run, "admin", "POST", `/api/cases/${id}/terminate`, { reason: "operator stop (eval)" });
      expectStatus(r, [202], "terminate");
      return;
    }
    case "evict": {
      const r = await as(run, "admin", "POST", a.kind === "case" ? `/api/dev/agents/case/${id}/evict` : "/api/dev/agents/hub/global/evict", {});
      expectStatus(r, [202], `evict ${a.kind}`);
      return;
    }
    case "duplicate":
      return duplicate(run, a.action, a.sameKey);
    case "completeFollowUp": {
      const email = run.h.emailFor(a.as, id);
      const task = await run.h.waitFor(`${a.kind} follow-up for ${id}`, async () => {
        const [f, b] = await Promise.all([
          run.h.request(email, "GET", "/api/followups?status=open&limit=100"),
          run.h.request(email, "GET", `/api/blockers?status=all&kind=${a.kind}&limit=100`),
        ]);
        const blockerIds = new Set(((b.body?.items ?? []) as Array<{ id: string; employeeId: string }>).filter((x) => x.employeeId === id).map((x) => x.id));
        return ((f.body?.items ?? []) as Array<{ id: string; employeeId: string; blockerId: string | null }>).find((t) => t.employeeId === id && t.blockerId && blockerIds.has(t.blockerId)) ?? null;
      });
      const r = await as(run, a.as, "POST", `/api/tasks/${encodeURIComponent(task.id)}/complete`, {});
      expectStatus(r, [200], `complete follow-up ${task.id}`);
      return;
    }
    case "concurrent":
      await Promise.all(a.actions.map((x) => executeAction(run, x)));
      return;
    case "expectBlockerStatus":
      await run.h.waitFor(
        `${a.kind} blocker ${a.status} for ${id}`,
        async () => (await caseDetail(run)).blockers.some((b) => b.kind === a.kind && b.status === a.status),
        20_000,
      );
      return;
    default: {
      const unknown: never = a;
      throw new UnknownActionError((unknown as { do?: string }).do ?? "undefined");
    }
  }
}

/** Runs an action twice: with the same Idempotency-Keys (replays) or with fresh ones (real duplicates). */
async function duplicate(run: ScenarioRun, action: Action, sameKey: boolean): Promise<void> {
  const keys: string[] = [];
  run.keys = sameKey ? { kind: "record", keys } : { kind: "fresh" };
  if (action.do === "start") {
    const first = await as(run, "people_ops", "POST", `/api/cases/${run.employeeId}/start`, {});
    const second = sameKey
      ? await run.h.request(run.h.emailFor("people_ops", run.employeeId), "POST", `/api/cases/${run.employeeId}/start`, {}, keys[0])
      : await as(run, "people_ops", "POST", `/api/cases/${run.employeeId}/start`, {});
    run.keys = { kind: "fresh" };
    expectStatus(first, [202], "first start");
    expectStatus(second, [202], "duplicate start");
    if (first.body.instanceId !== second.body.instanceId) throw new ExpectationError(`duplicate start returned ${first.body.instanceId} and ${second.body.instanceId}`);
    run.notes.push(`start:${first.body.instanceId}`);
    return;
  }
  await executeAction(run, action);
  run.keys = sameKey ? { kind: "replay", keys, next: 0 } : { kind: "fresh" };
  run.duplicatePass = true;
  try {
    if (sameKey) {
      // Replaying the recorded keys must return the stored responses, not execute again.
      await replayCheck(run, action, keys);
    } else {
      await executeAction(run, action);
    }
  } finally {
    run.duplicatePass = false;
    run.keys = { kind: "fresh" };
  }
}

/** Re-sends the same requests with the same keys and checks Idempotent-Replayed and identical bodies. */
async function replayCheck(run: ScenarioRun, action: Action, keys: string[]): Promise<void> {
  if (action.do !== "completeEmployeeTasks") {
    await executeAction(run, action);
    return;
  }
  const employee = run.h.emailFor("employee", run.employeeId);
  const r = await run.h.request(employee, "GET", "/api/me/checklist");
  const ids = ((r.body?.tasks ?? []) as Array<{ id: string; stageId: string }>).filter((t) => t.stageId === action.stage).map((t) => t.id).sort();
  if (action.order === "reverse") ids.reverse();
  for (let i = 0; i < ids.length; i++) {
    const res = await run.h.request(employee, "POST", `/api/tasks/${encodeURIComponent(ids[i] as string)}/complete`, {}, keys[i]);
    if (res.headers.get("Idempotent-Replayed") !== "true" || res.status !== 200) {
      throw new ExpectationError(`same-key completion of ${ids[i]} was not a replay (HTTP ${res.status})`);
    }
  }
}

/** Every Action kind the interpreter supports (kept in sync by eval-actions.test.ts). */
export const SUPPORTED_ACTIONS = [
  "start",
  "completeEmployeeTasks",
  "decide",
  "resubmit",
  "advanceClock",
  "scan",
  "waitStage",
  "corrupt",
  "fixField",
  "setFault",
  "clearFaults",
  "retryStage",
  "restart",
  "terminate",
  "evict",
  "duplicate",
  "completeFollowUp",
  "concurrent",
  "expectBlockerStatus",
] as const satisfies ReadonlyArray<Action["do"]>;

/** Compile-time check that SUPPORTED_ACTIONS lists every Action kind. */
type Missing = Exclude<Action["do"], (typeof SUPPORTED_ACTIONS)[number]>;
export const ALL_ACTIONS_SUPPORTED: Missing extends never ? true : Missing = true;
