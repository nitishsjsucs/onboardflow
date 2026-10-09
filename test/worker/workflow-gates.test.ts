import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { evaluateGate } from "../../src/worker/agents/gate-predicates.ts";
import type { CaseAgent } from "../../src/worker/agents/case-agent.ts";
import { runInDurableObject } from "cloudflare:test";
import { caseAgent, caseRow, cmdFor, completeEmployeeTasks, fastWorkflows, startCase, waitFor, waitForCase, waitForStage } from "../helpers/workflow.ts";

const DB = env.DB;

async function gatePassed(employeeId: string, stage: string) {
  const r = await DB.prepare("SELECT detail_json FROM audit_events WHERE employee_id = ? AND stage_id = ? AND action = 'stage.gate_passed' ORDER BY seq LIMIT 1")
    .bind(employeeId, stage)
    .first<{ detail_json: string }>();
  return r ? (JSON.parse(r.detail_json) as { checks: number; gate: string }) : null;
}

async function stop(employeeId: string) {
  const stub = await caseAgent(employeeId);
  await stub.terminateCase("test cleanup", await cmdFor("A01"));
}

/** Marks every paperwork task done directly in D1: no command, so no wake-up is sent. */
async function finishPaperworkSilently(employeeId: string) {
  await DB.batch([
    DB.prepare("UPDATE tasks SET status = 'done', completed_at = ?, completed_by = 'test' WHERE employee_id = ? AND stage_id = 'paperwork'").bind(new Date().toISOString(), employeeId),
    DB.prepare("UPDATE employees SET photo_on_file = 1 WHERE id = ?").bind(employeeId),
  ]);
}

describe("D1 gates with bounded waits", () => {
  it("passes a gate already satisfied in D1 on the first check, with no wait", async () => {
    const intro = await fastWorkflows();
    try {
      // the employee finished paperwork before the workflow reached the gate
      const now = new Date().toISOString();
      await DB.batch([
        ...["offer_docs", "i9_section1", "w4", "direct_deposit", "emergency_contact", "badge_photo"].map((k) =>
          DB.prepare(
            "INSERT INTO tasks (id, employee_id, stage_id, kind, template_key, assignee, title, description, status, created_at, completed_at) VALUES (?, 'E070', 'paperwork', 'checklist', ?, 'employee', 't', 'd', 'done', ?, ?)",
          ).bind(`chk:E070:${k}`, k, now, now),
        ),
        DB.prepare("UPDATE employees SET photo_on_file = 1 WHERE id = 'E070'"),
      ]);
      await startCase("E070");
      const passed = await waitFor(() => gatePassed("E070", "paperwork"), { what: "paperwork gate" });
      expect(passed).toMatchObject({ checks: 1, gate: "tasks" });
      expect((await DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE employee_id = 'E070' AND action = 'stage.waiting_on_employee' AND stage_id = 'paperwork'").first<{ n: number }>())!.n).toBe(0);
      await waitForStage("E070", "manager_approval", "awaiting_approval");
      await stop("E070");
    } finally {
      await intro.dispose();
    }
  });

  it("passes after one bounded wait when the wake-up is lost", async () => {
    const intro = await fastWorkflows();
    try {
      // a 5 s bounded wait (instead of the 1 s test default), so the silent completion below lands inside
      // the first wait even on a loaded machine and the count of checks does not depend on timing
      await startCase("E071", { gateWaitTimeoutMs: 5_000 });
      await waitForStage("E071", "paperwork", "waiting_on_employee");
      const [inst] = await intro.get();
      expect(await inst!.waitForStepResult({ name: "paperwork.tasks.check#r1.1" })).toMatchObject({ satisfied: false });
      await finishPaperworkSilently("E071");
      const passed = await waitFor(() => gatePassed("E071", "paperwork"), { what: "paperwork gate", timeoutMs: 20_000 });
      expect(passed.checks).toBe(2);
      await waitForStage("E071", "manager_approval", "awaiting_approval");
      expect((await caseRow("E071"))!.status).toBe("awaiting_approval");
      await stop("E071");
    } finally {
      await intro.dispose();
    }
  });

  it("spends one extra check on a stale wake-up, and ignores an invalid wake payload", async () => {
    const intro = await fastWorkflows();
    try {
      // a 60 s bounded wait, so only the scripted events below wake the gate (never a timeout under load)
      const instanceId = await startCase("E072", { gateWaitTimeoutMs: 60_000 });
      await waitForStage("E072", "paperwork", "waiting_on_employee");
      const [inst] = await intro.get();
      await inst!.waitForStepResult({ name: "paperwork.tasks.check#r1.1" });
      // a stale wake-up (gate still closed): consumed by the wait, the re-check fails
      const stub = await caseAgent("E072");
      await runInDurableObject(stub, (agent: CaseAgent) => agent.wake("paperwork", "nudge"));
      expect(await inst!.waitForStepResult({ name: "paperwork.tasks.check#r1.2" })).toMatchObject({ satisfied: false });
      // an invalid payload wakes the wait too but decides nothing
      await (await env.ONBOARDING_WORKFLOW.get(instanceId)).sendEvent({ type: "wake_paperwork", payload: { bogus: true } });
      expect(await inst!.waitForStepResult({ name: "paperwork.tasks.check#r1.3" })).toMatchObject({ satisfied: false });
      // the real completion (with its wake-up) opens the gate on the next check
      await completeEmployeeTasks("E072", "paperwork");
      const passed = await waitFor(() => gatePassed("E072", "paperwork"), { what: "paperwork gate" });
      expect(passed.checks).toBe(4);
      await waitForStage("E072", "manager_approval", "awaiting_approval");
      await stop("E072");
    } finally {
      await intro.dispose();
    }
  });

  it("keys decision gates by approval id: a manager_approval round 1 decision opens neither closeout nor round 2", async () => {
    const now = new Date().toISOString();
    await DB.prepare(
      `INSERT INTO approvals (id, employee_id, stage_id, checkpoint, round, approver_role, approver_staff_id, status, request_json, requested_at, due_at, privileged_access_approved)
       SELECT 'apr:E073:manager_approval:1', 'E073', 'manager_approval', 'manager_approval', 1, 'manager', manager_id, 'approved', '{}', ?, ?, 1 FROM employees WHERE id = 'E073'`,
    )
      .bind(now, now)
      .run();
    expect(await evaluateGate(DB, "E073", { kind: "decision", approvalId: "apr:E073:manager_approval:1" })).toEqual({
      satisfied: true,
      kind: "decision",
      status: "approved",
      privilegedAccessApproved: true,
    });
    expect(await evaluateGate(DB, "E073", { kind: "decision", approvalId: "apr:E073:closeout:1" })).toEqual({ satisfied: false });
    expect(await evaluateGate(DB, "E073", { kind: "decision", approvalId: "apr:E073:manager_approval:2" })).toEqual({ satisfied: false });
    // round gates open only past the given round
    await DB.prepare("UPDATE case_stages SET round = 2 WHERE employee_id = 'E073' AND stage_id = 'manager_approval'").run();
    expect(await evaluateGate(DB, "E073", { kind: "resubmit", stage: "manager_approval", round: 1 })).toEqual({ satisfied: true, kind: "round", round: 2 });
    expect(await evaluateGate(DB, "E073", { kind: "resubmit", stage: "manager_approval", round: 2 })).toEqual({ satisfied: false });
  });

  it("fails the case with wait_budget_exhausted when the wait budget runs out", async () => {
    const intro = await fastWorkflows();
    try {
      await startCase("E074", { waitBudget: 2 });
      const failed = await waitForCase("E074", "failed", 20_000);
      expect(failed.failure_reason).toBe("wait_budget_exhausted");
      expect((await DB.prepare("SELECT status FROM case_stages WHERE employee_id = 'E074' AND stage_id = 'paperwork'").first())).toEqual({ status: "failed" });
      const audit = await DB.prepare("SELECT detail_json FROM audit_events WHERE employee_id = 'E074' AND action = 'case.failed'").all<{ detail_json: string }>();
      expect(audit.results).toHaveLength(1);
      expect(JSON.parse(audit.results[0]!.detail_json)).toMatchObject({ failureReason: "wait_budget_exhausted", gate: "tasks" });
    } finally {
      await intro.dispose();
    }
  });
});
