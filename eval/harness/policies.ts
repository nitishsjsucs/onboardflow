// Chaos mode policies (SPEC 12.3). Everything here is a pure function of a
// seed and of data the corresponding persona can see through the API:
//   - the seeded fault schedule (per employee and operation, plus sustained
//     outage windows per system and data corruption),
//   - per-persona behavior plans (employee delays and disengagement, manager
//     delays, first-round rejections, silence),
//   - the coordinator bot's decision for one visible blocker.
// The fault table and these policies were committed before the first chaos
// run; any later change is logged in eval/results/CHANGELOG.md.
import type { BlockerView, EmployeeProfileDto } from "../../src/shared/api.ts";
import type { FaultKind, SystemId } from "../../src/shared/domain.ts";
import { mulberry32, type Rng } from "../../src/shared/synthetic/prng.ts";

/**
 * Chaos faults, bots and outage windows are expressed in wall-clock seconds, so
 * the system's own retry and poll timings must be too: chaos runs use the
 * production retry base (2 s, so about 30 s of step retries per round) and a
 * 1 s poll interval (12 s of polling), not the 20 ms timings that make the
 * scripted suite fast. With 20 ms retries a 10 to 60 s outage outlasts every
 * retry the workflow can make, which measures the compression, not the system.
 */
export const CHAOS_VARS = { RETRY_BASE_DELAY_MS: "2000", POLL_INTERVAL_MS: "1000" } as const;

export const CHAOS = {
  seeds: [1, 2, 3, 4, 5],
  caseDeadlineMs: 180_000,
  botTickMs: 500,
  employeeDelayMs: [200, 3000] as const,
  managerDelayMs: [500, 5000] as const,
  peopleOpsDelayMs: [500, 3000] as const,
  pIgnoreTasks: 0.15,
  pRejectFirst: 0.1,
  pNeverRespond: 0.05,
  pFault: 0.3,
  pCorrupt: 0.05,
  retryBackoffMs: [1000, 2000, 4000] as const,
  patience: 3,
  photoDelayMs: [1000, 10_000] as const,
  outageWindowsPerSystem: [0, 2] as const,
  outageDurationMs: [10_000, 60_000] as const,
  outageStartMs: [5_000, 120_000] as const,
  /** One large simulated-clock jump at a seeded point, so every task due date and pending approval SLA can expire. */
  clockJumpAtMs: [5_000, 15_000] as const,
  clockJumpMs: 90 * 86_400_000,
  /** Afterwards, simulated time keeps passing: approvals left pending across a tick become overdue. */
  clockTickEveryMs: 20_000,
  clockTickMs: 3 * 86_400_000,
};

/** Operations the injector may fault; `stallOp` is the poll that a `stall` fault freezes. */
export const FAULTABLE = [
  { opId: "hr.create-worker", system: "hr", op: "create-worker" },
  { opId: "hr.start-document-verification", system: "hr", op: "start-document-verification", stallOp: "get-document-verification" },
  { opId: "it.create-account", system: "it", op: "create-account" },
  { opId: "it.assign-licenses", system: "it", op: "assign-licenses" },
  { opId: "it.order-device", system: "it", op: "order-device", stallOp: "get-device-order" },
  { opId: "facilities.assign-workspace", system: "facilities", op: "assign-workspace" },
  { opId: "facilities.issue-badge", system: "facilities", op: "issue-badge", stallOp: "get-badge" },
  { opId: "hr.enroll-orientation", system: "hr", op: "enroll-orientation" },
  { opId: "hr.activate-worker", system: "hr", op: "activate-worker" },
] as const satisfies ReadonlyArray<{ opId: string; system: SystemId; op: string; stallOp?: string }>;

/** The committed weighted fault table. fail_503 with remaining >= 5 exceeds the 5-attempt retry budget. */
export const FAULT_TABLE: ReadonlyArray<{ fault: FaultKind; weight: number; remaining?: readonly [number, number]; retryAfterMs?: readonly [number, number]; clearAfterMs?: readonly [number, number] }> = [
  { fault: "fail_503", weight: 4, remaining: [1, 8] },
  { fault: "rate_limit_429", weight: 2, remaining: [1, 3], retryAfterMs: [50, 400] },
  { fault: "timeout", weight: 1, remaining: [1, 2] },
  { fault: "malformed", weight: 1, remaining: [1, 2] },
  { fault: "lost_response", weight: 1, remaining: [1, 1] },
  { fault: "stall", weight: 1, clearAfterMs: [5_000, 30_000] },
];

/** Every POST operation of each system, faulted together during a sustained outage window. */
export const SYSTEM_POSTS: Record<SystemId, string[]> = {
  hr: ["create-worker", "start-document-verification", "enroll-orientation", "activate-worker"],
  it: ["create-account", "assign-licenses", "order-device"],
  facilities: ["assign-workspace", "issue-badge"],
};

export function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** An independent deterministic stream per (seed, purpose). */
export function rngFor(seed: number, purpose: string): Rng {
  return mulberry32((Math.imul(seed, 0x9e3779b1) ^ fnv(purpose)) >>> 0);
}

export function between(rng: Rng, [lo, hi]: readonly [number, number]): number {
  return Math.floor(lo + rng() * (hi - lo + 1));
}

function weighted<T extends { weight: number }>(rng: Rng, items: readonly T[]): T {
  const total = items.reduce((a, b) => a + b.weight, 0);
  let x = rng() * total;
  for (const it of items) {
    x -= it.weight;
    if (x < 0) return it;
  }
  return items[items.length - 1] as T;
}

export type ScheduledFault = {
  employeeRef: string;
  opId: string;
  system: SystemId;
  operation: string;
  fault: FaultKind;
  remaining: number | null;
  params?: { retryAfterMs: number };
  /** stall plans are cleared after this long */
  clearAfterMs?: number;
};

export type OutageWindow = { system: SystemId; startMs: number; durationMs: number };
export type Corruption = { employeeRef: string; field: "costCenter" | "licenseBundle" | "photoOnFile"; value: string | number; when: "setup" | "after_paperwork" };

export type ChaosSchedule = {
  seed: number;
  faults: ScheduledFault[];
  outages: OutageWindow[];
  corruptions: Corruption[];
  clockJumpAtMs: number;
};

export type ChaosEmployee = { id: string; employmentType: string; orgUnit: string };

/** The seeded fault schedule for one seed: deterministic, and visible to no bot. */
export function chaosSchedule(seed: number, employees: readonly ChaosEmployee[]): ChaosSchedule {
  const faults: ScheduledFault[] = [];
  const corruptions: Corruption[] = [];
  for (const e of employees) {
    for (const f of FAULTABLE) {
      const rng = rngFor(seed, `fault:${e.id}:${f.opId}`);
      if (rng() >= CHAOS.pFault) continue;
      const table = "stallOp" in f ? FAULT_TABLE : FAULT_TABLE.filter((x) => x.fault !== "stall");
      const pick = weighted(rng, table);
      if (pick.fault === "stall" && "stallOp" in f) {
        faults.push({ employeeRef: e.id, opId: f.opId, system: f.system, operation: f.stallOp, fault: "stall", remaining: null, clearAfterMs: between(rng, pick.clearAfterMs ?? [5_000, 30_000]) });
      } else {
        faults.push({
          employeeRef: e.id,
          opId: f.opId,
          system: f.system,
          operation: f.op,
          fault: pick.fault,
          remaining: between(rng, pick.remaining ?? [1, 1]),
          ...(pick.retryAfterMs ? { params: { retryAfterMs: between(rng, pick.retryAfterMs) } } : {}),
        });
      }
    }
    const rc = rngFor(seed, `corrupt:${e.id}`);
    if (rc() < CHAOS.pCorrupt) {
      const field = (["costCenter", "licenseBundle", "photoOnFile"] as const)[Math.floor(rc() * 3)] as Corruption["field"];
      const value = field === "costCenter" ? "CC-12" : field === "licenseBundle" ? (e.employmentType === "full_time" ? "contractor-basic" : "ft-standard") : 0;
      corruptions.push({ employeeRef: e.id, field, value, when: field === "photoOnFile" ? "after_paperwork" : "setup" });
    }
  }
  const outages: OutageWindow[] = [];
  for (const system of ["hr", "it", "facilities"] as const) {
    const rng = rngFor(seed, `outage:${system}`);
    const n = between(rng, CHAOS.outageWindowsPerSystem);
    for (let i = 0; i < n; i++) outages.push({ system, startMs: between(rng, CHAOS.outageStartMs), durationMs: between(rng, CHAOS.outageDurationMs) });
  }
  return { seed, faults, outages, corruptions, clockJumpAtMs: between(rngFor(seed, "clock"), CHAOS.clockJumpAtMs) };
}

export type EmployeePlan = { ignoresTasks: boolean; delayMs: { paperwork: number; orientation: number } };
export type ManagerPlan = { delayMs: number; rejectFirst: boolean; neverRespond: boolean };

export function employeePlan(seed: number, employeeId: string): EmployeePlan {
  const rng = rngFor(seed, `employee:${employeeId}`);
  return { ignoresTasks: rng() < CHAOS.pIgnoreTasks, delayMs: { paperwork: between(rng, CHAOS.employeeDelayMs), orientation: between(rng, CHAOS.employeeDelayMs) } };
}

/** The manager's behavior for one direct report's checkpoint. */
export function managerPlan(seed: number, employeeId: string): ManagerPlan {
  const rng = rngFor(seed, `manager:${employeeId}`);
  const silent = rng() < CHAOS.pNeverRespond;
  return { delayMs: between(rng, CHAOS.managerDelayMs), rejectFirst: !silent && rng() < CHAOS.pRejectFirst, neverRespond: silent };
}

export function peopleOpsDelay(seed: number, key: string): number {
  return between(rngFor(seed, `people_ops:${key}`), CHAOS.peopleOpsDelayMs);
}

export function photoDelay(seed: number, blockerId: string): number {
  return between(rngFor(seed, `photo:${blockerId}`), CHAOS.photoDelayMs);
}

// ---------------------------------------------------------------------------
// Coordinator bot
// ---------------------------------------------------------------------------

export type BotMemory = { firstSeenMs: number; retries: number; lastRetryMs: number | null; fixed: boolean; photoRequestedMs: number | null; gaveUp: boolean };

export type BotAction =
  | { kind: "retry" }
  | { kind: "fix"; field: "costCenter" | "licenseBundle" | "photoOnFile"; value: string | boolean }
  | { kind: "request_photo" }
  | { kind: "wait" }
  | { kind: "give_up" }
  | { kind: "ignore" };

export function newMemory(nowMs: number): BotMemory {
  return { firstSeenMs: nowMs, retries: 0, lastRetryMs: null, fixed: false, photoRequestedMs: null, gaveUp: false };
}

/**
 * The documented correction policy, using only API-visible data:
 * cost center = the modal value among the same org unit's employees (ties: smallest);
 * license bundle = the policy table in CONTEXT.md by employment type;
 * photo = on file (after the photo was requested).
 */
export function correctionFor(field: "costCenter" | "licenseBundle", profile: Pick<EmployeeProfileDto, "employmentType" | "orgUnit">, peerCostCenters: readonly string[]): string {
  if (field === "licenseBundle") {
    if (profile.employmentType === "contractor") return "contractor-basic";
    if (profile.employmentType === "intern") return "intern-basic";
    return profile.orgUnit === "Engineering" ? "ft-engineering" : "ft-standard";
  }
  const counts = new Map<string, number>();
  for (const cc of peerCostCenters) counts.set(cc, (counts.get(cc) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "";
}

/**
 * One decision for one open blocker the department bot can see.
 * integration_outage, provisioning_stalled: retry with backoff (1, 2, 4 s), at most `patience` retries.
 * data_issue: correct the field (photo: request it, wait the seeded delay), then retry, same patience.
 * Other kinds belong to other personas (People Ops resubmits, the admin decides overdue approvals,
 * employees act on overdue tasks).
 */
export function coordinatorDecision(
  b: Pick<BlockerView, "id" | "kind" | "detail">,
  m: BotMemory,
  nowMs: number,
  ctx: { photoDelayMs: number; correction?: string | null },
): BotAction {
  if (b.kind !== "integration_outage" && b.kind !== "provisioning_stalled" && b.kind !== "data_issue") return { kind: "ignore" };
  if (m.gaveUp) return { kind: "ignore" };
  if (b.kind === "data_issue" && !m.fixed) {
    const field = (b.detail as { field?: string }).field;
    if (field === "photoOnFile") {
      if (m.photoRequestedMs === null) return { kind: "request_photo" };
      return nowMs - m.photoRequestedMs >= ctx.photoDelayMs ? { kind: "fix", field, value: true } : { kind: "wait" };
    }
    if ((field === "costCenter" || field === "licenseBundle") && ctx.correction) return { kind: "fix", field, value: ctx.correction };
    // a validation error the bot has no policy for: it can only retry
  }
  if (m.retries >= CHAOS.patience) return { kind: "give_up" };
  const since = m.lastRetryMs ?? m.firstSeenMs;
  const backoff = CHAOS.retryBackoffMs[Math.min(m.retries, CHAOS.retryBackoffMs.length - 1)] as number;
  return nowMs - since >= backoff ? { kind: "retry" } : { kind: "wait" };
}
