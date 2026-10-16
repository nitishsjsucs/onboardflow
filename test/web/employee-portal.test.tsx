import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BlockerView, ChecklistDto, TaskView } from "../../src/shared/api.ts";
import { STAGES } from "../../src/shared/stages.ts";
import { EmployeePortalPage } from "../../src/web/pages/EmployeePortalPage.tsx";
import { blocker } from "./fixtures.ts";
import { announced, isBusy, mockFetch, PERSONAS, renderWith } from "./harness.tsx";

vi.mock("../../src/web/live/useCaseLive.ts", () => ({ useCaseLive: () => ({ state: null, status: "connected" }) }));

afterEach(cleanup);

const task = (id: string, stageId: TaskView["stageId"], title: string, status: TaskView["status"] = "open"): TaskView => ({
  id,
  employeeId: "E001",
  stageId,
  kind: "checklist",
  templateKey: id.split(":")[2] ?? null,
  assignee: "employee",
  title,
  description: "d",
  status,
  // far ahead, so no task turns overdue as the calendar moves on
  dueAt: "2099-10-26T17:00:00.000Z",
  blockerId: null,
  draftedBy: "template",
  llmSuggestedCategory: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  completedAt: null,
  completedBy: null,
});

const checklist: ChecklistDto = {
  caseStatus: "in_progress",
  stages: STAGES.map((s) => ({
    id: s.id,
    ordinal: s.ordinal,
    name: s.name,
    owner: s.owner,
    status: s.id === "intake" ? "complete" : s.id === "paperwork" ? "waiting_on_employee" : "pending",
    round: 1,
    startedAt: null,
    completedAt: null,
    blockedReason: null,
  })),
  tasks: [
    task("chk:E001:w4", "paperwork", "Submit Form W-4"),
    task("chk:E001:offer_docs", "paperwork", "Sign offer documents", "done"),
    task("chk:E001:enroll_mfa", "orientation", "Enroll in MFA"),
  ],
  blockers: [],
};

describe("EmployeePortalPage", () => {
  it("shows the 8 stages, what is next, and the checklist grouped by stage", async () => {
    mockFetch(() => ({ body: checklist }));
    renderWith(<EmployeePortalPage />, { me: PERSONAS.employee!, path: "/me" });
    await screen.findByRole("region", { name: "Paperwork and verification checklist" });
    const steps = within(screen.getByRole("list", { name: "onboarding stages" })).getAllByRole("listitem");
    expect(steps).toHaveLength(8);
    expect(steps[1]?.getAttribute("data-status")).toBe("waiting_on_employee");
    expect(screen.getByTestId("what-next").textContent).toMatch(/Finish your paperwork and verification tasks: 1 left/);
    const paperwork = screen.getByRole("region", { name: "Paperwork and verification checklist" });
    expect(within(paperwork).getByText("Submit Form W-4")).toBeTruthy();
    expect(within(paperwork).getByText("Sign offer documents")).toBeTruthy();
    const orientation = screen.getByRole("region", { name: "Orientation and day one checklist" });
    expect(within(orientation).getByText("Enroll in MFA")).toBeTruthy();
    expect(screen.getByRole("status", { name: /live updates: Live/ })).toBeTruthy();
  });

  it("completes a task with Idempotency-Key and X-OnboardFlow, changing the row only once the server confirmed", async () => {
    let release: (() => void) | null = null;
    const calls = mockFetch(async (url, method) => {
      if (method === "POST") {
        await new Promise<void>((r) => {
          release = r;
        });
        return { body: { ...task("chk:E001:w4", "paperwork", "Submit Form W-4", "done") } };
      }
      return { body: checklist };
    });
    renderWith(<EmployeePortalPage />, { me: PERSONAS.employee!, path: "/me" });
    await screen.findByRole("region", { name: "Paperwork and verification checklist" });
    const paperwork = screen.getByRole("region", { name: "Paperwork and verification checklist" });
    const button = within(paperwork).getByRole("button", { name: "Mark done: Submit Form W-4" });
    button.focus();
    fireEvent.click(button);
    // while the request is in flight the task stays open and the button stays, focused, unavailable
    await waitFor(() => expect(isBusy(button)).toBe(true));
    expect(document.activeElement).toBe(button);
    expect(button.closest("li")!.className).toBe("open");
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/tasks/chk%3AE001%3Aw4/complete");
    expect(post?.headers["X-OnboardFlow"]).toBe("1");
    expect(post?.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    release!();
    // confirmed: the row is done, and its confirmation takes the focus the removed button had
    const confirmation = await within(paperwork).findByText("Marked done: Submit Form W-4");
    expect(within(paperwork).queryByRole("button", { name: /^Mark done/ })).toBeNull();
    expect(confirmation.closest("li")!.className).toBe("done");
    await waitFor(() => expect(document.activeElement).toBe(confirmation));
    await waitFor(() => expect(calls.filter((c) => c.method === "GET").length).toBeGreaterThanOrEqual(2));
  });

  it("keeps Mark done focused after a failed completion, so Enter tries again with the same key", async () => {
    let fail = true;
    const calls = mockFetch((_url, method) => {
      if (method === "POST") {
        if (fail) {
          fail = false;
          return { status: 502, raw: "<html>Bad gateway</html>" };
        }
        return { body: task("chk:E001:w4", "paperwork", "Submit Form W-4", "done") };
      }
      return { body: checklist };
    });
    renderWith(<EmployeePortalPage />, { me: PERSONAS.employee!, path: "/me" });
    const button = await screen.findByRole("button", { name: "Mark done: Submit Form W-4" });
    const row = button.closest("li") as HTMLElement;
    button.focus();
    fireEvent.click(button);
    expect((await within(row).findByRole("alert")).textContent).toContain("Trying again is safe");
    // the same button, still mounted, enabled and focused (no optimistic removal and rollback)
    expect(within(row).getByRole("button", { name: "Mark done: Submit Form W-4" })).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(isBusy(button)).toBe(false);
    fireEvent.click(document.activeElement as HTMLElement);
    await within(row).findByText("Marked done: Submit Form W-4");
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[1]!.headers["Idempotency-Key"]).toBe(posts[0]!.headers["Idempotency-Key"]);
  });

  it("offers no Mark done for tasks of a stage that has not started, and says when they open", async () => {
    mockFetch(() => ({ body: checklist }));
    renderWith(<EmployeePortalPage />, { me: PERSONAS.employee!, path: "/me" });
    await screen.findByRole("region", { name: "Orientation and day one checklist" });
    const orientation = screen.getByRole("region", { name: "Orientation and day one checklist" });
    expect(within(orientation).queryByRole("button", { name: /^Mark done/ })).toBeNull();
    expect(within(orientation).getByText(/Opens when Orientation and day one starts\./)).toBeTruthy();
    // a neutral badge, not "open"
    expect(within(orientation).getByText("Not open yet")).toBeTruthy();
    expect(within(orientation).queryByText("open")).toBeNull();
    // the started stage keeps its button
    const paperwork = screen.getByRole("region", { name: "Paperwork and verification checklist" });
    expect(within(paperwork).getByRole("button", { name: "Mark done: Submit Form W-4" })).toBeTruthy();
  });

  it("shows a failed completion inside that task's row and confirms a success in the live region", async () => {
    let fail = true;
    mockFetch((_url, method) => {
      if (method === "POST") {
        if (fail) {
          fail = false;
          return { status: 409, body: { error: { code: "stage_not_started", message: "the paperwork stage has not started yet; its tasks open when it does", requestId: "r-409" } } };
        }
        return { body: task("chk:E001:w4", "paperwork", "Submit Form W-4", "done") };
      }
      return { body: checklist };
    });
    renderWith(<EmployeePortalPage />, { me: PERSONAS.employee!, path: "/me" });
    const button = await screen.findByRole("button", { name: "Mark done: Submit Form W-4" });
    const row = button.closest("li") as HTMLElement;
    fireEvent.click(button);
    const alert = await within(row).findByRole("alert");
    expect(alert.textContent).toContain("Paperwork and verification has not started yet. Its tasks open when it starts.");
    // the task stayed open, so it can be tried again
    fireEvent.click(await within(row).findByRole("button", { name: "Mark done: Submit Form W-4" }));
    await within(row).findByText("Marked done: Submit Form W-4");
    expect(within(row).queryByRole("alert")).toBeNull();
    await waitFor(() => expect(announced()).toBe("Marked done: Submit Form W-4"));
  });

  it("explains blockers in plain words, with no ids or owner codes", async () => {
    const notices: Array<[BlockerView, string]> = [
      [
        blocker({ kind: "approval_overdue", stageId: "manager_approval", ownerDepartment: "people_ops", subject: "apr:E001:manager_approval:1", detail: { approvalId: "apr:E001:manager_approval:1", checkpoint: "manager_approval", round: 1 } }),
        "Your manager's approval is taking longer than planned. People Operations is following up. Nothing is needed from you.",
      ],
      [
        blocker({ id: "b2", kind: "data_issue", stageId: "intake", ownerDepartment: "people_ops", subject: "hr.create-worker", detail: { field: "costCenter", system: "hr", message: "costCenter must match CC-####" } }),
        "We hit a setup problem with HR (a simulated system). The People Operations team is fixing it.",
      ],
      [blocker({ id: "b3" }), "We hit a setup problem with IT (a simulated system). The IT team is fixing it."],
      [
        blocker({ id: "b4", kind: "employee_task_overdue", stageId: "paperwork", ownerDepartment: "people_ops", subject: "checklist:paperwork", detail: { taskIds: ["chk:E001:w4"], count: 1 } }),
        "1 of your tasks is past its due date.",
      ],
    ];
    mockFetch(() => ({ body: { ...checklist, blockers: notices.map(([b]) => b) } }));
    renderWith(<EmployeePortalPage />, { me: PERSONAS.employee!, path: "/me" });
    const box = await screen.findByRole("region", { name: "Updates on your onboarding" });
    for (const [, text] of notices) expect(within(box).getByText(text)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/apr:|blk:|Subject:|Owner:|people_ops|it\.order-device|data issue/i);
  });

  it("marks overdue tasks from the blocker's task ids and from a past due date, and counts them in What is next", async () => {
    const past = { ...task("chk:E001:i9_section1", "paperwork", "Complete Form I-9 Section 1"), dueAt: "2020-01-01T00:00:00.000Z" };
    const data: ChecklistDto = {
      ...checklist,
      tasks: [task("chk:E001:w4", "paperwork", "Submit Form W-4"), past, task("chk:E001:offer_docs", "paperwork", "Sign offer documents", "done"), task("chk:E001:enroll_mfa", "orientation", "Enroll in MFA")],
      blockers: [blocker({ kind: "employee_task_overdue", stageId: "paperwork", ownerDepartment: "people_ops", subject: "checklist:paperwork", detail: { taskIds: ["chk:E001:w4"], count: 1 } })],
    };
    mockFetch(() => ({ body: data }));
    renderWith(<EmployeePortalPage />, { me: PERSONAS.employee!, path: "/me" });
    const paperwork = await screen.findByRole("region", { name: "Paperwork and verification checklist" });
    const w4 = within(paperwork).getByText("Submit Form W-4").closest("li") as HTMLElement;
    expect(within(w4).getByText("Overdue")).toBeTruthy();
    expect(within(within(paperwork).getByText("Complete Form I-9 Section 1").closest("li") as HTMLElement).getByText("Overdue")).toBeTruthy();
    expect(within(within(paperwork).getByText("Sign offer documents").closest("li") as HTMLElement).queryByText("Overdue")).toBeNull();
    expect(screen.getByTestId("what-next").textContent).toBe("What is next: Finish your paperwork and verification tasks: 2 left, 2 overdue.");
  });

  it("exposes the stage progress as a progressbar", async () => {
    mockFetch(() => ({ body: checklist }));
    renderWith(<EmployeePortalPage />, { me: PERSONAS.employee!, path: "/me" });
    const bar = await screen.findByRole("progressbar", { name: "Stages complete" });
    expect([bar.getAttribute("aria-valuemin"), bar.getAttribute("aria-valuemax"), bar.getAttribute("aria-valuenow")]).toEqual(["0", "8", "1"]);
    expect(bar.getAttribute("aria-valuetext")).toBe("1 of 8 stages complete");
  });
});
