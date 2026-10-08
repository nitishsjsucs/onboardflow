import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { auditIds, blockerDedupeKey, blockerId, userStamp } from "../../src/shared/ids.ts";
import { auditInsertWhen, stamped } from "../../src/worker/db/audit.ts";
import { claimIdempotency, completeIdempotency, releaseIdempotency, requestHash } from "../../src/worker/db/api-idempotency.ts";
import { openBlockerStatements } from "../../src/worker/db/blockers.ts";
import { runGuarded } from "../../src/worker/db/guarded.ts";

const DB = env.DB;
const now = () => new Date().toISOString();

async function insertApproval(employee: string) {
  const id = `apr:${employee}:manager_approval:1`;
  await DB.prepare(
    `INSERT INTO approvals (id, employee_id, stage_id, checkpoint, round, approver_role, approver_staff_id, status, request_json, requested_at, due_at)
     SELECT ?, e.id, 'manager_approval', 'manager_approval', 1, 'manager', e.manager_id, 'pending', '{}', ?, ? FROM employees e WHERE e.id = ?`,
  )
    .bind(id, now(), now(), employee)
    .run();
  return id;
}

/** The SPEC 7.1 decision batch, built on runGuarded. */
function decide(approvalId: string, employee: string, decision: "approved" | "rejected", requestId: string, idem?: { actorEmail: string; key: string }) {
  const stamp = userStamp(requestId);
  const t = now();
  const audit = (action: "approval.approved" | "approval.rejected" | "approval.decision_conflict") => ({
    id: auditIds.user(requestId, action),
    occurredAt: t,
    actorType: "user" as const,
    actorId: "m@onboardflow.test",
    actorRole: "manager",
    action,
    entityType: "approval",
    entityId: approvalId,
    employeeId: employee,
    stageId: "manager_approval",
    round: 1,
    requestId,
  });
  return runGuarded({
    db: DB,
    mutation: DB.prepare(
      `UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, last_mutation_id = ? WHERE id = ? AND status = 'pending'`,
    ).bind(decision, t, "m@onboardflow.test", stamp, approvalId),
    applied: stamped("approvals", "id = ?", [approvalId], stamp),
    onApplied: (when) => [auditInsertWhen(DB, audit(decision === "approved" ? "approval.approved" : "approval.rejected"), when)],
    onConflict: (when) => [auditInsertWhen(DB, audit("approval.decision_conflict"), when)],
    ...(idem
      ? { idempotency: { ...idem, ok: { status: 200, body: { id: approvalId, status: decision } }, conflict: { status: 409, body: { error: { code: "approval_not_pending" } } } } }
      : {}),
  });
}

const auditCount = async (entityId: string, action: string) =>
  (await DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE entity_id = ? AND action = ?").bind(entityId, action).first<{ n: number }>())!.n;

describe("guarded mutations", () => {
  let first: string;
  beforeAll(async () => {
    first = await insertApproval("E030");
  });

  it("applies once; a later decision changes 0 rows and writes only the conflict audit and the 409 response", async () => {
    const a = await decide(first, "E030", "approved", "req-a");
    expect(a.applied).toBe(true);

    const hash = await requestHash("POST", "/api/approvals/x/decision", { decision: "reject" });
    expect(await claimIdempotency(DB, { actorEmail: "m@onboardflow.test", key: "k-late", route: "decision", requestHash: hash })).toEqual({ kind: "claimed" });
    const b = await decide(first, "E030", "rejected", "req-b", { actorEmail: "m@onboardflow.test", key: "k-late" });
    expect(b.applied).toBe(false);

    expect(await auditCount(first, "approval.approved")).toBe(1);
    expect(await auditCount(first, "approval.rejected")).toBe(0);
    expect(await auditCount(first, "approval.decision_conflict")).toBe(1);
    const row = await DB.prepare("SELECT status, decided_by, last_mutation_id FROM approvals WHERE id = ?").bind(first).first();
    expect(row).toMatchObject({ status: "approved", last_mutation_id: "usr:req-a" });
    const stored = await DB.prepare("SELECT state, status, response_json FROM api_idempotency WHERE key = 'k-late'").first<{ state: string; status: number; response_json: string }>();
    expect(stored).toMatchObject({ state: "complete", status: 409 });
    expect(JSON.parse(stored!.response_json)).toEqual({ error: { code: "approval_not_pending" } });
  });

  it("lets exactly one of two concurrent decisions win", async () => {
    const id = await insertApproval("E031");
    const [x, y] = await Promise.all([decide(id, "E031", "approved", "race-1"), decide(id, "E031", "rejected", "race-2")]);
    expect([x.applied, y.applied].filter(Boolean)).toHaveLength(1);
    expect((await auditCount(id, "approval.approved")) + (await auditCount(id, "approval.rejected"))).toBe(1);
    expect(await auditCount(id, "approval.decision_conflict")).toBe(1);
  });

  it("stores the success response in the same batch when the mutation applies", async () => {
    const id = await insertApproval("E032");
    const hash = await requestHash("POST", "/api/approvals/x/decision", { decision: "approve" });
    await claimIdempotency(DB, { actorEmail: "m2@onboardflow.test", key: "k-ok", route: "decision", requestHash: hash });
    const r = await decide(id, "E032", "approved", "req-ok", { actorEmail: "m2@onboardflow.test", key: "k-ok" });
    expect(r.applied).toBe(true);
    const replay = await claimIdempotency(DB, { actorEmail: "m2@onboardflow.test", key: "k-ok", route: "decision", requestHash: hash });
    expect(replay).toEqual({ kind: "replay", status: 200, body: { id, status: "approved" } });
  });
});

describe("blocker + follow-up guarded on the blocker row", () => {
  it("an INSERT OR IGNORE blocker that loses to the open-dedupe index writes no follow-up, no audit and no error", async () => {
    const dedupe = blockerDedupeKey("E033", "integration_outage", "it_provisioning", "it.order-device");
    const mk = (ms: number) =>
      openBlockerStatements(
        DB,
        {
          id: blockerId(dedupe, ms),
          employeeId: "E033",
          stageId: "it_provisioning",
          kind: "integration_outage",
          severity: "high",
          ownerDepartment: "it",
          subject: "it.order-device",
          dedupeKey: dedupe,
          detail: {},
          detectedAt: new Date(ms).toISOString(),
        },
        { title: "t", description: "d", assignee: "it", dueAt: null, draftedBy: "template", llmSuggestedCategory: null },
        { type: "agent", id: "case-agent/E033" },
      );
    await DB.batch(mk(1_000));
    await expect(DB.batch(mk(2_000))).resolves.toBeDefined();
    const blockers = await DB.prepare("SELECT id FROM blockers WHERE dedupe_key = ?").bind(dedupe).all<{ id: string }>();
    expect(blockers.results.map((b) => b.id)).toEqual([blockerId(dedupe, 1_000)]);
    const tasks = await DB.prepare("SELECT id, blocker_id FROM tasks WHERE employee_id = 'E033' AND kind = 'followup'").all();
    expect(tasks.results).toEqual([{ id: `fu:${blockerId(dedupe, 1_000)}`, blocker_id: blockerId(dedupe, 1_000) }]);
    const opened = await DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE employee_id = 'E033' AND action IN ('blocker.opened','followup.created')").first<{ n: number }>();
    expect(opened!.n).toBe(2);
  });
});

describe("API idempotency claims", () => {
  const base = { actorEmail: "c@onboardflow.test", route: "start" };

  it("reports in-progress for a fresh pending claim, reuse for a different body, and re-claims an abandoned one", async () => {
    const h1 = await requestHash("POST", "/api/cases/E001/start", {});
    const h2 = await requestHash("POST", "/api/cases/E001/start", { other: true });
    expect(await claimIdempotency(DB, { ...base, key: "k1", requestHash: h1 })).toEqual({ kind: "claimed" });
    expect(await claimIdempotency(DB, { ...base, key: "k1", requestHash: h1 })).toEqual({ kind: "in_progress" });
    expect(await claimIdempotency(DB, { ...base, key: "k1", requestHash: h2 })).toEqual({ kind: "reuse" });
    // 61 s later the pending claim counts as abandoned
    expect(await claimIdempotency(DB, { ...base, key: "k1", requestHash: h1, nowMs: Date.now() + 61_000 })).toEqual({ kind: "claimed" });
  });

  it("releases a pending claim after a 5xx but keeps a completed one", async () => {
    const h = await requestHash("POST", "/api/x", {});
    await claimIdempotency(DB, { ...base, key: "k2", requestHash: h });
    await releaseIdempotency(DB, base.actorEmail, "k2");
    expect(await claimIdempotency(DB, { ...base, key: "k2", requestHash: h })).toEqual({ kind: "claimed" });
    await completeIdempotency(DB, base.actorEmail, "k2", 202, { ok: 1 });
    await releaseIdempotency(DB, base.actorEmail, "k2");
    expect(await claimIdempotency(DB, { ...base, key: "k2", requestHash: h })).toEqual({ kind: "replay", status: 202, body: { ok: 1 } });
  });
});
