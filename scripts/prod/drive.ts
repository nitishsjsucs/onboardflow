// Drives onboarding cases through the OnboardFlow REST API as one admin
// principal, the way the production verification script does it through
// Cloudflare Access with a service token (scripts/prod/verify.ts). It only
// uses fetch-shaped I/O, so the worker test project runs the same code against
// the real Worker in workerd (test/worker/prod-verify-driver.test.ts).
//
// An admin may do every human step of a case (PERMISSION_MATRIX): start it,
// complete checklist tasks of started stages, decide both approval
// checkpoints on behalf of the approver, correct a profile field and retry a
// blocked stage. Two paths:
// - happy: start, then answer every task and approval until the case ends.
// - data_issue: before the start, set a license bundle the simulated IT
//   system refuses for this employment type. IT provisioning blocks with a data
//   issue, the CaseAgent opens a blocker and drafts its follow-up (the LLM call
//   in production), then the driver restores the bundle and retries the stage,
//   like an IT coordinator would (scenario F-it-validation).

export type Transport = (path: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>;

export type DrivePath = "happy" | "data_issue";

export type DriveOptions = {
  transport: Transport;
  /** Origin header for mutations (same-origin check): the deployment's https origin. */
  origin: string;
  pollMs: number;
  caseTimeoutMs: number;
  /** After the data issue blocks the stage, how long to wait for the blocker's follow-up before correcting. */
  followUpWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
};

export type FollowUpRecord = {
  taskId: string;
  blockerKind: string;
  draftedBy: string | null;
  provider: string | null;
  latencyMs: number | null;
  error: string | null;
  usage: { promptTokens: number; completionTokens: number } | null;
};

export type CaseOutcome = {
  employeeId: string;
  path: DrivePath;
  status: "complete" | "failed" | "timeout" | "error";
  failureReason: string | null;
  error: string | null;
  instanceId: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Mutations the driver sent (method, path, status). */
  actions: Array<{ what: string; status: number }>;
  requests: number;
  /** Stages that blocked although the path did not plan it (in production nothing injects faults). */
  unexpectedBlocks: Array<{ stage: string; reason: Record<string, unknown> | null }>;
  blockers: Array<{ kind: string; ownerDepartment: string; status: string; subject: string }>;
  followUps: FollowUpRecord[];
};

type Stage = { id: string; status: string; round: number; blockedReason: Record<string, unknown> | null };
type Task = { id: string; stageId: string; kind: "checklist" | "followup"; status: string; blockerId: string | null; draftedBy: string | null };
type Approval = { id: string; status: string; checkpoint: string; request: Record<string, unknown> };
type Blocker = { id: string; kind: string; ownerDepartment: string; status: string; subject: string; detail: Record<string, unknown>; followUpTaskId: string | null };
type Detail = {
  employee: { employmentType: string; licenseBundle: string };
  case: { status: string; failureReason: string | null; workflowInstanceId: string | null };
  stages: Stage[];
  tasks: Task[];
  approvals: Approval[];
  blockers: Blocker[];
};

/** A bundle the simulated IT system rejects for this employment type (ALLOWED_BUNDLES in src/shared/domain.ts). */
export function rejectedBundleFor(employmentType: string): string {
  return employmentType === "full_time" ? "contractor-basic" : employmentType === "contractor" ? "intern-basic" : "contractor-basic";
}

class Api {
  requests = 0;
  readonly actions: CaseOutcome["actions"] = [];
  readonly #o: DriveOptions;

  constructor(o: DriveOptions) {
    this.#o = o;
  }

  async get<T>(path: string): Promise<T> {
    const res = await this.#send("GET", path);
    if (res.status !== 200) throw new Error(`GET ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }

  /** A mutation with the SPA's headers. A network error is retried with the same Idempotency-Key. */
  async mutate(method: string, path: string, body: unknown, accept: number[]): Promise<{ status: number; body: unknown }> {
    const key = crypto.randomUUID();
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await this.#send(method, path, body, { "Idempotency-Key": key, "X-OnboardFlow": "1", Origin: this.#o.origin });
        const text = await res.text();
        const parsed = text ? safeJson(text) : null;
        this.actions.push({ what: `${method} ${path}`, status: res.status });
        if (!accept.includes(res.status)) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
        return { status: res.status, body: parsed };
      } catch (err) {
        if (err instanceof Error && err.message.startsWith(`${method} ${path}: HTTP`)) throw err;
        lastError = err;
        await (this.#o.sleep ?? defaultSleep)(500 * attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async #send(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Response> {
    this.requests++;
    const headers: Record<string, string> = { Accept: "application/json", ...extra };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return this.#o.transport(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 200);
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isDataIssueOnBundle(s: Stage): boolean {
  return s.id === "it_provisioning" && s.status === "blocked" && s.blockedReason?.class === "fatal" && s.blockedReason?.field === "licenseBundle";
}

/** Drives one case from not_started to complete (or failed, or the deadline). Never throws; errors are in the outcome. */
export async function driveCase(employeeId: string, path: DrivePath, o: DriveOptions): Promise<CaseOutcome> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? defaultSleep;
  const log = o.log ?? (() => {});
  const api = new Api(o);
  const t0 = now();
  const outcome: CaseOutcome = {
    employeeId,
    path,
    status: "error",
    failureReason: null,
    error: null,
    instanceId: null,
    startedAt: new Date(t0).toISOString(),
    finishedAt: "",
    durationMs: 0,
    actions: api.actions,
    requests: 0,
    unexpectedBlocks: [],
    blockers: [],
    followUps: [],
  };
  const caseUrl = `/api/cases/${encodeURIComponent(employeeId)}`;
  try {
    const first = await api.get<Detail>(caseUrl);
    if (first.case.status !== "not_started") throw new Error(`${employeeId} is ${first.case.status}; the driver starts only not_started cases`);
    const originalBundle = first.employee.licenseBundle;
    if (path === "data_issue") {
      const bad = rejectedBundleFor(first.employee.employmentType);
      log(`${employeeId}: license bundle ${originalBundle} -> ${bad} (IT will refuse it)`);
      await api.mutate("PATCH", `/api/employees/${encodeURIComponent(employeeId)}`, { licenseBundle: bad }, [200]);
    }
    await api.mutate("POST", `${caseUrl}/start`, {}, [202]);
    log(`${employeeId}: started (${path})`);

    const deadline = t0 + o.caseTimeoutMs;
    let corrected = false;
    let blockedSeenAt: number | null = null;
    const retried = new Map<string, number>();
    for (;;) {
      const d = await api.get<Detail>(caseUrl);
      outcome.instanceId = d.case.workflowInstanceId;
      if (d.case.status === "complete" || d.case.status === "failed") {
        outcome.status = d.case.status;
        outcome.failureReason = d.case.failureReason;
        break;
      }
      if (now() > deadline) {
        outcome.status = "timeout";
        outcome.error = `not finished after ${o.caseTimeoutMs} ms (case ${d.case.status}, stages ${d.stages.map((s) => `${s.id}:${s.status}`).join(",")})`;
        break;
      }
      const started = new Set(d.stages.filter((s) => s.status !== "pending").map((s) => s.id));
      for (const t of d.tasks.filter((x) => x.kind === "checklist" && x.status === "open" && started.has(x.stageId))) {
        await api.mutate("POST", `/api/tasks/${encodeURIComponent(t.id)}/complete`, {}, [200, 409]);
      }
      for (const a of d.approvals.filter((x) => x.status === "pending")) {
        const privileged = a.request.needsPrivilegedAccess === true;
        await api.mutate("POST", `/api/approvals/${encodeURIComponent(a.id)}/decision`, { decision: "approve", ...(privileged ? { privilegedAccessApproved: true } : {}) }, [200, 409]);
      }
      for (const s of d.stages.filter((x) => x.status === "blocked")) {
        if (path === "data_issue" && !corrected && isDataIssueOnBundle(s)) {
          blockedSeenAt ??= now();
          const blocker = d.blockers.find((b) => b.kind === "data_issue" && b.status === "open" && b.detail.field === "licenseBundle");
          const followUpReady = blocker?.followUpTaskId ? d.tasks.some((t) => t.id === blocker.followUpTaskId) : false;
          // let the agent open the blocker and write its follow-up first, so the run records the draft
          if (!followUpReady && now() - blockedSeenAt < (o.followUpWaitMs ?? 60_000)) continue;
          log(`${employeeId}: IT refused the bundle; restoring ${originalBundle} and retrying (follow-up ${followUpReady ? "written" : "not seen"})`);
          await api.mutate("PATCH", `/api/employees/${encodeURIComponent(employeeId)}`, { licenseBundle: originalBundle }, [200]);
          await api.mutate("POST", `${caseUrl}/stages/it_provisioning/retry`, {}, [202]);
          corrected = true;
          continue;
        }
        // Nothing injects faults in production: any other block is a finding. Record it and retry it twice,
        // as the owning coordinator would.
        const key = `${s.id}#${s.round}`;
        if (retried.has(key)) continue;
        outcome.unexpectedBlocks.push({ stage: s.id, reason: s.blockedReason });
        const tries = [...retried.keys()].filter((k) => k.startsWith(`${s.id}#`)).length;
        retried.set(key, tries + 1);
        if (tries < 2) {
          log(`${employeeId}: unexpected block at ${s.id} (${JSON.stringify(s.blockedReason)}); retrying`);
          await api.mutate("POST", `${caseUrl}/stages/${encodeURIComponent(s.id)}/retry`, {}, [202, 409]);
        }
      }
      await sleep(o.pollMs);
    }
    const last = await api.get<Detail>(caseUrl);
    outcome.blockers = last.blockers.map((b) => ({ kind: b.kind, ownerDepartment: b.ownerDepartment, status: b.status, subject: b.subject }));
    outcome.followUps = await followUps(api, caseUrl, last);
    if (path === "data_issue" && !corrected && outcome.status === "complete") outcome.error = "the data issue never blocked the IT stage";
  } catch (err) {
    outcome.status = outcome.status === "complete" || outcome.status === "failed" ? outcome.status : "error";
    outcome.error = err instanceof Error ? err.message : String(err);
  }
  const t1 = now();
  outcome.finishedAt = new Date(t1).toISOString();
  outcome.durationMs = t1 - t0;
  outcome.requests = api.requests;
  return outcome;
}

/** Follow-up tasks and what drafted them (followup.created audit detail: provider, latency, error, token usage). */
async function followUps(api: Api, caseUrl: string, d: Detail): Promise<FollowUpRecord[]> {
  const created = new Map<string, Record<string, unknown>>();
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const r: { items: Array<{ action: string; entityId: string; detail: Record<string, unknown> }>; nextCursor: string | null } = await api.get(
      `${caseUrl}/audit?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    for (const e of r.items) if (e.action === "followup.created") created.set(e.entityId, e.detail);
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  return d.tasks
    .filter((t) => t.kind === "followup")
    .map((t) => {
      const detail = created.get(t.id) ?? {};
      const llm = (detail.llm ?? null) as { provider?: string; latencyMs?: number | null; error?: string | null; usage?: { promptTokens: number; completionTokens: number } } | null;
      const blocker = d.blockers.find((b) => b.id === t.blockerId);
      return {
        taskId: t.id,
        blockerKind: blocker?.kind ?? "unknown",
        draftedBy: t.draftedBy,
        provider: llm?.provider ?? null,
        latencyMs: llm?.latencyMs ?? null,
        error: llm?.error ?? null,
        usage: llm?.usage ?? null,
      };
    });
}
