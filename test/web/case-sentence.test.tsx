import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaseDetail, MeDto, StageView, TaskView } from "../../src/shared/api.ts";
import type { StageStatus } from "../../src/shared/domain.ts";
import { STAGES, type StageId } from "../../src/shared/stages.ts";
import { caseSentence, startWords } from "../../src/web/components/case-sentence.ts";
import { CaseDetailPage } from "../../src/web/pages/CaseDetailPage.tsx";
import { approval, blocker, caseDetail } from "./fixtures.ts";
import { mockFetch, PERSONAS, renderWith } from "./harness.tsx";

vi.mock("../../src/web/live/useCaseLive.ts", () => ({ useCaseLive: () => ({ state: null, status: "connected" }) }));

afterEach(cleanup);

// local noon on Fri Oct 16, 2026; the fixture's employee starts Mon Nov 2 (17 days later)
const NOW = new Date(2026, 9, 16, 12);
const startedAt = new Date(2026, 9, 8, 12).toISOString(); // 8 days earlier

/** A case resting at `stage` in `status`; earlier stages complete, later ones pending. */
function at(stage: StageId, status: StageStatus, over: Partial<CaseDetail> = {}, caseStatus: CaseDetail["case"]["status"] = "in_progress"): CaseDetail {
  const d = caseDetail(null);
  const ordinal = STAGES.find((s) => s.id === stage)!.ordinal;
  const stages: StageView[] = d.stages.map((s) => (s.ordinal < ordinal ? { ...s, status: "complete" } : s.ordinal === ordinal ? { ...s, status, startedAt } : { ...s, status: "pending" }));
  return { ...d, case: { ...d.case, status: caseStatus, currentStage: stage }, stages, approvals: [], blockers: [], ...over };
}

const text = (d: CaseDetail, me: MeDto | null = PERSONAS.admin!) => caseSentence(d, me, NOW).parts.join(" ");

function task(id: string, stageId: StageId, dueAt: string, status: TaskView["status"] = "open"): TaskView {
  return { id, employeeId: "E001", stageId, kind: "checklist", templateKey: id, assignee: "employee", title: id, description: "d", status, dueAt, blockerId: null, draftedBy: null, llmSuggestedCategory: null, createdAt: startedAt, completedAt: null, completedBy: null };
}

describe("caseSentence", () => {
  it("waiting on the employee: open and overdue checklist tasks", () => {
    const d = at("paperwork", "waiting_on_employee", {
      tasks: [task("a", "paperwork", "2026-10-10T17:00:00.000Z"), task("b", "paperwork", "2026-10-12T17:00:00.000Z"), task("c", "paperwork", "2026-10-30T17:00:00.000Z"), task("d", "paperwork", "2026-10-01T17:00:00.000Z", "done"), task("e", "orientation", "2026-10-01T17:00:00.000Z")],
    });
    expect(text(d)).toBe("Waiting on the employee: 3 checklist tasks open, 2 overdue. In this stage since Oct 8 (8 days). Starts Monday, November 2 (in 17 days). 1 of 8 stages done.");
    expect(caseSentence(d, PERSONAS.admin!, NOW).action).toBeNull();
  });

  it("waiting on the manager: that manager sees 'you' and a Decide link; an admin decides on behalf", () => {
    const pending = approval({ status: "pending", approverStaffId: "M01" });
    const d = at("manager_approval", "awaiting_approval", { approvals: [pending] }, "awaiting_approval");
    expect(text(d, PERSONAS.peopleOps!)).toMatch(/^Waiting on Gray Marlow \(hiring manager\) to decide the equipment and access request\. In this stage since Oct 8 \(8 days\)\./);
    expect(caseSentence(d, PERSONAS.peopleOps!, NOW).action).toBeNull();
    expect(text(d, PERSONAS.manager!)).toMatch(/^Waiting on you to decide the equipment and access request\./);
    expect(caseSentence(d, PERSONAS.manager!, NOW).action).toEqual({ text: "Decide in Approvals", href: "/approvals#approval-apr%3AE001%3Amanager_approval%3A1" });
    expect(caseSentence(d, PERSONAS.admin!, NOW).action).toEqual({ text: "Decide on behalf", href: "/approvals#approval-apr%3AE001%3Amanager_approval%3A1" });
    // another manager (not the approver) gets no link and no "you"
    const other: MeDto = { ...PERSONAS.manager!, staffId: "M02" };
    expect(text(d, other)).toMatch(/^Waiting on Gray Marlow \(hiring manager\)/);
    expect(caseSentence(d, other, NOW).action).toBeNull();
  });

  it("after a rejection: People Ops revises and resubmits, and People Ops gets Open in Approvals", () => {
    const rejected = approval({ status: "rejected", round: 1, reason: "wrong laptop" });
    const d = at("manager_approval", "revision_requested", { approvals: [rejected] }, "blocked");
    const sentence = "Waiting on People Ops to revise and resubmit the equipment and access request (round 1 was rejected).";
    expect(text(d, PERSONAS.manager!)).toMatch(new RegExp(`^${sentence.replace(/[().]/g, "\\$&")}`));
    expect(text(d, PERSONAS.peopleOps!)).toMatch(new RegExp(`^${sentence.replace(/[().]/g, "\\$&")}`));
    expect(caseSentence(d, PERSONAS.manager!, NOW).action).toBeNull();
    expect(caseSentence(d, PERSONAS.peopleOps!, NOW).action).toEqual({ text: "Open in Approvals", href: "/approvals#approval-apr%3AE001%3Amanager_approval%3A1" });
    // the reason itself is not repeated here
    expect(text(d, PERSONAS.peopleOps!)).not.toContain("wrong laptop");
  });

  it("blocked at IT: what failed, who is on it, and since when", () => {
    const b = blocker({ subject: "it.create-account", detail: { system: "it", operation: "it.create-account", message: "service unavailable" }, detectedAt: new Date(2026, 9, 9, 9).toISOString() });
    const d = at("it_provisioning", "blocked", { blockers: [b] }, "blocked");
    expect(text(d)).toBe("Blocked: IT (simulated) could not create the account; IT is on it. Blocked since Oct 9 (7 days). Starts Monday, November 2 (in 17 days). 3 of 8 stages done.");
  });

  it("blocked at the cross-system check on an HR operation names People Ops, not IT", () => {
    const b = blocker({ stageId: "provisioning_verification", ownerDepartment: "people_ops", subject: "hr.get-worker", detail: { system: "hr", operation: "hr.get-worker", message: "service unavailable" } });
    const d = at("provisioning_verification", "blocked", { blockers: [b] }, "blocked");
    expect(text(d)).toMatch(/^Blocked: HR \(simulated\) could not check the worker record; People Ops is on it\./);
    // with no open blocker, it says which departments own the stage's systems
    const bare = at("provisioning_verification", "blocked", {}, "blocked");
    expect(text(bare)).toMatch(/^Blocked; People Ops, IT or Facilities is on it\. In this stage since Oct 8/);
  });

  it("running, not started, complete and failed", () => {
    expect(text(at("facilities_setup", "active"))).toBe("Running Facilities setup. In this stage since Oct 8 (8 days). Starts Monday, November 2 (in 17 days). 4 of 8 stages done.");
    const notStarted = caseDetail(null);
    expect(text({ ...notStarted, case: { ...notStarted.case, status: "not_started", currentStage: null, workflowInstanceId: null } })).toBe(
      "Onboarding has not started: People Ops starts it. Starts Monday, November 2 (in 17 days).",
    );
    const complete = at("closeout", "complete", { case: { ...caseDetail(null).case, status: "complete", currentStage: "closeout", completedAt: new Date(2026, 9, 9, 15).toISOString() } }, "complete");
    expect(text({ ...complete, stages: complete.stages.map((s) => ({ ...s, status: "complete" })) })).toBe("Completed Oct 9. Starts Monday, November 2 (in 17 days). 8 of 8 stages done.");
    const failed = at("it_provisioning", "failed", { case: { ...caseDetail(null).case, status: "failed", failureReason: "recovery_rounds_exhausted", currentStage: "it_provisioning" } }, "failed");
    expect(text(failed)).toBe("Onboarding failed: IT provisioning ran out of recovery rounds. An admin can restart it. Starts Monday, November 2 (in 17 days). 3 of 8 stages done.");
  });

  it("says the start date in words, in the future, today and in the past, without a UTC shift", () => {
    expect(startWords("2026-11-23", "2026-10-16")).toBe("Starts Monday, November 23 (in 38 days).");
    expect(startWords("2026-10-16", "2026-10-16")).toBe("Starts today, Friday, October 16.");
    expect(startWords("2026-10-15", "2026-10-16")).toBe("Started Thursday, October 15 (1 day ago).");
    expect(startWords("2026-10-02", "2026-10-16")).toBe("Started Friday, October 2 (14 days ago).");
  });
});

describe("the sentence on the case page", () => {
  it("comes right after the heading, with the viewer's action link", async () => {
    const pending = approval({ status: "pending", approverStaffId: "M01" });
    const d = at("manager_approval", "awaiting_approval", { approvals: [pending] }, "awaiting_approval");
    mockFetch((url) => (url.includes("/audit") ? { body: { items: [], nextCursor: null } } : { body: d }));
    renderWith(<CaseDetailPage />, { me: PERSONAS.manager!, path: "/cases/E001", routes: [{ path: "/cases/:id", element: <CaseDetailPage /> }] });
    const heading = await screen.findByRole("heading", { level: 1 });
    const p = heading.nextElementSibling as HTMLElement;
    expect(p.dataset.testid).toBe("case-now");
    expect(p.textContent).toMatch(/^Waiting on you to decide the equipment and access request\./);
    const link = within(p).getByRole("link", { name: "Decide in Approvals for Avery Abara" });
    expect(link.getAttribute("href")).toBe("/approvals#approval-apr%3AE001%3Amanager_approval%3A1");
    // the sub line has the start date in words, and the stepper says since when the current stage runs
    expect(screen.getByText(/Start date Mon Nov 2\./)).toBeTruthy();
    expect(screen.getByTestId("stage-manager_approval").textContent).toContain("awaiting approval, since Oct 8");
  });
});
