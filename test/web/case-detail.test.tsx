import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaseDetail } from "../../src/shared/api.ts";
import { CaseDetailPage } from "../../src/web/pages/CaseDetailPage.tsx";
import { caseDetail } from "./fixtures.ts";
import { announced, mockFetch, PERSONAS, renderWith } from "./harness.tsx";

vi.mock("../../src/web/live/useCaseLive.ts", () => ({ useCaseLive: () => ({ state: null, status: "connected" }) }));

afterEach(cleanup);

function serve(detail = caseDetail()) {
  return mockFetch((url, method) => {
    if (method === "POST") return { status: 202, body: { round: 2 } };
    if (url.includes("/audit")) return { body: { items: [], nextCursor: null } };
    return { body: detail };
  });
}

const routes = [{ path: "/cases/:id", element: <CaseDetailPage /> }];

describe("CaseDetailPage", () => {
  it("renders the 8 stages with their statuses and the blocker", async () => {
    serve();
    renderWith(null, { me: PERSONAS.it!, path: "/cases/E001", routes });
    const stepper = await screen.findByRole("list", { name: "onboarding stages" });
    const steps = within(stepper).getAllByRole("listitem");
    expect(steps).toHaveLength(8);
    expect(steps.map((s) => s.getAttribute("data-status"))).toEqual(["complete", "complete", "complete", "blocked", "pending", "pending", "pending", "pending"]);
    expect(screen.getByTestId("blocker-integration_outage")).toBeTruthy();
    expect(screen.getAllByText("simulated").length).toBeGreaterThan(0);
  });

  it("writes a blocker's detail as its own sentence, and the blocked stage's reason in words", async () => {
    const d = caseDetail();
    d.blockers[0]!.detail = { system: "it", operation: "it.order-device", class: "retryable", message: "service_unavailable: simulated outage" };
    d.blockers[0]!.detectedAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
    d.stages.find((s) => s.id === "it_provisioning")!.blockedReason = { class: "retryable", operation: "it.order-device", message: "service_unavailable: simulated outage", round: 1 };
    serve(d);
    renderWith(null, { me: PERSONAS.it!, path: "/cases/E001", routes });
    const item = await screen.findByTestId("blocker-integration_outage");
    expect(item.querySelector(".muted")!.textContent).toBe("IT provisioning: Blocked after round 1. Service unavailable: simulated outage. Owner IT, detected 8 days ago.");
    expect(screen.getByText("IT provisioning is blocked: service unavailable: simulated outage.")).toBeTruthy();
  });

  it("shows Retry only to the owning department and admins, and sends the retry", async () => {
    const calls = serve();
    renderWith(null, { me: PERSONAS.it!, path: "/cases/E001", routes });
    fireEvent.click(await screen.findByRole("button", { name: "Retry IT provisioning for Avery Abara" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/cases/E001/stages/it_provisioning/retry");
    expect(post.headers["Idempotency-Key"]).toBeTruthy();
    cleanup();
    for (const persona of ["peopleOps", "manager", "employee"] as const) {
      serve();
      renderWith(null, { me: PERSONAS[persona]!, path: "/cases/E001", routes });
      await screen.findByRole("list", { name: "onboarding stages" });
      expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
      cleanup();
    }
    serve();
    renderWith(null, { me: PERSONAS.admin!, path: "/cases/E001", routes });
    expect(await screen.findByRole("button", { name: "Retry IT provisioning for Avery Abara" })).toBeTruthy();
  });

  it("shows restart and terminate to admins only", async () => {
    serve(caseDetail(null));
    renderWith(null, { me: PERSONAS.admin!, path: "/cases/E001", routes });
    const controls = await screen.findByRole("region", { name: "admin controls" });
    expect(within(controls).getByRole("button", { name: "Restart workflow" })).toBeTruthy();
    expect(within(controls).getByRole("button", { name: "Terminate" })).toBeTruthy();
    cleanup();
    serve(caseDetail(null));
    renderWith(null, { me: PERSONAS.peopleOps!, path: "/cases/E001", routes });
    await screen.findByRole("list", { name: "onboarding stages" });
    expect(screen.queryByRole("region", { name: "admin controls" })).toBeNull();
  });

  it("enables the controls only where the server would accept them, and says why not", async () => {
    const cases: Array<[string, Partial<CaseDetail["case"]>, boolean, boolean, string | null]> = [
      ["in progress", {}, true, true, null],
      ["complete", { status: "complete" }, true, false, "This case already ended: complete. Terminate is not available."],
      ["terminated", { status: "failed", failureReason: "terminated" }, true, false, "This case already ended: failed (terminated). Terminate is not available."],
      ["not started", { status: "not_started", workflowInstanceId: null }, false, false, "The case has not started."],
    ];
    for (const [, over, restartOn, terminateOn, why] of cases) {
      const d = caseDetail(null);
      d.case = { ...d.case, ...over };
      serve(d);
      renderWith(null, { me: PERSONAS.admin!, path: "/cases/E001", routes });
      const controls = await screen.findByRole("region", { name: "admin controls" });
      fireEvent.change(within(controls).getByLabelText("Reason (audited)"), { target: { value: "a reason long enough" } });
      expect((within(controls).getByRole("button", { name: "Restart workflow" }) as HTMLButtonElement).disabled).toBe(!restartOn);
      expect((within(controls).getByRole("button", { name: "Terminate" }) as HTMLButtonElement).disabled).toBe(!terminateOn);
      if (why) expect(within(controls).getByText(why)).toBeTruthy();
      cleanup();
    }
  });

  it("needs a reason of 10 characters and a confirm step; Cancel sends nothing", async () => {
    const calls = serve(caseDetail(null));
    renderWith(null, { me: PERSONAS.admin!, path: "/cases/E001", routes });
    const controls = await screen.findByRole("region", { name: "admin controls" });
    const terminate = within(controls).getByRole("button", { name: "Terminate" }) as HTMLButtonElement;
    fireEvent.change(within(controls).getByLabelText("Reason (audited)"), { target: { value: "too short" } });
    expect(terminate.disabled).toBe(true);
    fireEvent.change(within(controls).getByLabelText("Reason (audited)"), { target: { value: "duplicate hire record" } });
    fireEvent.click(terminate);
    expect(within(controls).getByText("Terminate Avery Abara's onboarding? The case ends as failed (terminated). This cannot be undone. Reason: duplicate hire record")).toBeTruthy();
    fireEvent.click(within(controls).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(controls).getByRole("button", { name: "Restart workflow" }));
    expect(within(controls).getByText("Restart Avery Abara's workflow as run 2? Reason: duplicate hire record")).toBeTruthy();
    fireEvent.click(within(controls).getByRole("button", { name: "Cancel" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("focuses the confirm prompt, returns focus to the opener on Cancel, and focuses the result after Confirm", async () => {
    serve(caseDetail(null));
    mockFetch((url, method) => {
      if (method === "POST") return { status: 202, body: { runNo: 2, instanceId: "onb-E001-1" } };
      if (url.includes("/audit")) return { body: { items: [], nextCursor: null } };
      return { body: caseDetail(null) };
    });
    renderWith(null, { me: PERSONAS.admin!, path: "/cases/E001", routes });
    const controls = await screen.findByRole("region", { name: "admin controls" });
    fireEvent.change(within(controls).getByLabelText("Reason (audited)"), { target: { value: "stuck after the IT outage" } });
    const restart = within(controls).getByRole("button", { name: "Restart workflow" });
    restart.focus();
    fireEvent.click(restart);
    const step = within(controls).getByRole("group", { name: "Confirm restart" });
    await waitFor(() => expect(document.activeElement).toBe(step.querySelector("p")));
    fireEvent.click(within(step).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(restart));
    fireEvent.click(restart);
    const confirm = within(controls).getByRole("button", { name: "Confirm restart" });
    confirm.focus();
    fireEvent.click(confirm);
    const result = await within(controls).findByText("Restarted: run 2");
    expect(within(controls).queryByRole("group", { name: "Confirm restart" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(result));
  });

  it("moves focus to the Blockers heading when a retried stage leaves the blocked list", async () => {
    let d = caseDetail();
    mockFetch((url, method) => {
      if (method === "POST") {
        d = caseDetail(null);
        return { status: 202, body: { round: 2 } };
      }
      if (url.includes("/audit")) return { body: { items: [], nextCursor: null } };
      return { body: d };
    });
    renderWith(null, { me: PERSONAS.it!, path: "/cases/E001", routes });
    const retry = await screen.findByRole("button", { name: "Retry IT provisioning for Avery Abara" });
    retry.focus();
    fireEvent.click(retry);
    // the blocked stage and its blocker are gone after the refetch, and so is the section
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Retry/ })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 })));
  });

  it("locks the reason while the confirm step is open, so Confirm sends the reason it showed", async () => {
    const calls = serve(caseDetail(null));
    renderWith(null, { me: PERSONAS.admin!, path: "/cases/E001", routes });
    const controls = await screen.findByRole("region", { name: "admin controls" });
    const reason = within(controls).getByLabelText("Reason (audited)") as HTMLInputElement;
    fireEvent.change(reason, { target: { value: "stuck after the IT outage" } });
    fireEvent.click(within(controls).getByRole("button", { name: "Restart workflow" }));
    expect(reason.readOnly).toBe(true);
    expect(within(controls).getByText(/Cancel to change it\./)).toBeTruthy();
    // a change that slips through (readOnly is not enforced by fireEvent) is still refused at Confirm
    fireEvent.change(reason, { target: { value: "x" } });
    fireEvent.click(within(controls).getByRole("button", { name: "Confirm restart" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    fireEvent.click(within(controls).getByRole("button", { name: "Cancel" }));
    expect(reason.readOnly).toBe(false);
  });

  it("confirms a terminate, announces it and clears the reason", async () => {
    const calls = mockFetch((url, method) => {
      if (method === "POST") return { status: 202, body: { status: "failed", failureReason: "terminated" } };
      if (url.includes("/audit")) return { body: { items: [], nextCursor: null } };
      return { body: caseDetail(null) };
    });
    renderWith(null, { me: PERSONAS.admin!, path: "/cases/E001", routes });
    const controls = await screen.findByRole("region", { name: "admin controls" });
    const reason = within(controls).getByLabelText("Reason (audited)") as HTMLInputElement;
    fireEvent.change(reason, { target: { value: "duplicate hire record" } });
    fireEvent.click(within(controls).getByRole("button", { name: "Terminate" }));
    fireEvent.click(within(controls).getByRole("button", { name: "Confirm terminate" }));
    await within(controls).findByText("Terminated Avery Abara's onboarding");
    await waitFor(() => expect(announced()).toBe("Terminated Avery Abara's onboarding"));
    expect(reason.value).toBe("");
    const post = calls.find((c) => c.method === "POST")!;
    expect([post.url, post.body]).toEqual(["/api/cases/E001/terminate", { reason: "duplicate hire record" }]);
  });

  it("shows staff the same Overdue and Not open yet task badges as the employee", async () => {
    const d = caseDetail(null);
    const base = { employeeId: "E001", kind: "checklist" as const, templateKey: null, assignee: "employee" as const, description: "d", blockerId: null, draftedBy: null, llmSuggestedCategory: null, createdAt: "2026-10-01T00:00:00.000Z", completedAt: null, completedBy: null };
    d.tasks = [
      { ...base, id: "chk:E001:w4", stageId: "paperwork", title: "Submit Form W-4", status: "open", dueAt: "2020-01-01T00:00:00.000Z" },
      { ...base, id: "chk:E001:enroll_mfa", stageId: "orientation", title: "Enroll in MFA", status: "open", dueAt: "2020-01-01T00:00:00.000Z" },
    ];
    serve(d);
    renderWith(null, { me: PERSONAS.peopleOps!, path: "/cases/E001", routes });
    const tasks = await screen.findByRole("region", { name: "tasks" });
    expect(within(within(tasks).getByText("Submit Form W-4").closest("li") as HTMLElement).getByText("Overdue")).toBeTruthy();
    // orientation has not started: its task is not open yet, so it is not overdue either
    expect(within(within(tasks).getByText("Enroll in MFA").closest("li") as HTMLElement).getByText("Not open yet")).toBeTruthy();
  });
});
