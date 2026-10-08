import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChecklistDto, TaskView } from "../../src/shared/api.ts";
import { STAGES } from "../../src/shared/stages.ts";
import { EmployeePortalPage } from "../../src/web/pages/EmployeePortalPage.tsx";
import { mockFetch, PERSONAS, renderWith } from "./harness.tsx";

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
  dueAt: "2026-10-26T17:00:00.000Z",
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
    await screen.findByText("Submit Form W-4");
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

  it("completes a task with Idempotency-Key and X-OnboardFlow, updating optimistically", async () => {
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
    await screen.findByText("Submit Form W-4");
    const paperwork = screen.getByRole("region", { name: "Paperwork and verification checklist" });
    fireEvent.click(within(paperwork).getByRole("button", { name: "Mark done" }));
    // optimistic: the button disappears before the server answers
    await waitFor(() => expect(within(paperwork).queryByRole("button", { name: "Mark done" })).toBeNull());
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/tasks/chk%3AE001%3Aw4/complete");
    expect(post?.headers["X-OnboardFlow"]).toBe("1");
    expect(post?.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    release!();
    await waitFor(() => expect(calls.filter((c) => c.method === "GET").length).toBeGreaterThanOrEqual(2));
  });
});
