import { focusManager } from "@tanstack/react-query";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { formatDate, slaText } from "../../src/web/components/ApprovalCard.tsx";
import { ApprovalsPage } from "../../src/web/pages/ApprovalsPage.tsx";
import { approval } from "./fixtures.ts";
import { announced, isBusy, mockFetch, PERSONAS, renderWith } from "./harness.tsx";

afterEach(cleanup);

const rejected = approval({ id: "apr:E002:manager_approval:1", employeeId: "E002", employeeName: "Blake Brennick", status: "rejected", reason: "wrong laptop", resubmittable: true });
const posts = (calls: ReturnType<typeof mockFetch>) => calls.filter((c) => c.method === "POST");

function serve(items = [approval()]) {
  return mockFetch((url, method) => {
    if (method === "POST") return url.endsWith("/resubmit") ? { status: 202, body: { round: 2 } } : { body: { ...approval(), status: "approved" } };
    if (url.includes("status=rejected")) return { body: { items: [rejected], nextCursor: null } };
    return { body: { items, nextCursor: null } };
  });
}

describe("ApprovalsPage", () => {
  it("needs an explicit privileged-access choice before Approve, and sends that choice", async () => {
    for (const [choice, expected] of [
      ["Grant privileged access", true],
      ["Approve without privileged access", false],
    ] as const) {
      const calls = serve();
      renderWith(<ApprovalsPage />, { me: PERSONAS.manager!, path: "/approvals" });
      const card = await screen.findByRole("article", { name: "manager approval for Avery Abara" });
      const approve = within(card).getByRole("button", { name: "Approve manager approval for Avery Abara" }) as HTMLButtonElement;
      expect(within(card).getByRole("group", { name: "Privileged access was requested" })).toBeTruthy();
      expect(within(card).getAllByRole("radio").every((r) => !(r as HTMLInputElement).checked)).toBe(true);
      expect(approve.disabled).toBe(true);
      expect(document.getElementById(approve.getAttribute("aria-describedby")!)!.textContent).toBe("Choose whether to grant privileged access before approving.");
      fireEvent.click(within(card).getByLabelText(choice));
      expect(approve.disabled).toBe(false);
      fireEvent.click(approve);
      await waitFor(() => expect(posts(calls)).toHaveLength(1));
      const post = posts(calls)[0]!;
      expect(post.url).toBe("/api/approvals/apr%3AE001%3Amanager_approval%3A1/decision");
      expect(post.body).toEqual({ decision: "approve", privilegedAccessApproved: expected });
      expect(post.headers["X-OnboardFlow"]).toBe("1");
      expect(post.headers["Idempotency-Key"]).toBeTruthy();
      // the card confirms the decision and the live region announces it
      expect(await within(card).findByText("Approved. IT provisioning starts next.")).toBeTruthy();
      await waitFor(() => expect(announced()).toBe("Approved. IT provisioning starts next."));
      expect(within(card).queryByRole("button", { name: /^Approve/ })).toBeNull();
      cleanup();
    }
  });

  it("moves focus from the removed Approve button to the card's outcome", async () => {
    serve();
    renderWith(<ApprovalsPage />, { me: PERSONAS.manager!, path: "/approvals" });
    const card = await screen.findByRole("article", { name: "manager approval for Avery Abara" });
    fireEvent.click(within(card).getByLabelText("Approve without privileged access"));
    const approve = within(card).getByRole("button", { name: "Approve manager approval for Avery Abara" });
    approve.focus();
    fireEvent.click(approve);
    const outcome = await within(card).findByText("Approved. IT provisioning starts next.");
    expect(within(card).queryByRole("button", { name: /^Approve/ })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(outcome));
  });

  it("rejects with a reason (the field has a visible label), and needs no privileged choice to reject", async () => {
    const calls = serve();
    renderWith(<ApprovalsPage />, { me: PERSONAS.manager!, path: "/approvals" });
    const card = await screen.findByRole("article", { name: "manager approval for Avery Abara" });
    const reject = within(card).getByRole("button", { name: "Reject manager approval for Avery Abara" }) as HTMLButtonElement;
    expect(reject.disabled).toBe(true);
    fireEvent.change(within(card).getByLabelText("Reason"), { target: { value: " budget " } });
    fireEvent.click(reject);
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]!.body).toEqual({ decision: "reject", reason: "budget" });
    // managers never see the resubmission list
    expect(screen.queryByText("Revision requested")).toBeNull();
    expect(calls.some((c) => c.url.includes("status=rejected"))).toBe(false);
  });

  it("shows readable request fields, a case link and the SLA", async () => {
    serve([approval({ dueAt: new Date(Date.now() + 4 * 86_400_000).toISOString(), request: { equipmentProfile: "engineering", licenseBundle: "ft-engineering", needsPrivilegedAccess: false, workMode: "remote", site: "Austin", startDate: "2026-11-02" } })]);
    renderWith(<ApprovalsPage />, { me: PERSONAS.manager!, path: "/approvals" });
    const card = await screen.findByRole("article", { name: "manager approval for Avery Abara" });
    const fields = Object.fromEntries([...card.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]));
    expect(fields).toEqual({
      "Equipment profile": "engineering",
      "License bundle": "ft-engineering",
      "Privileged access": "Not requested",
      "Work mode": "remote",
      Site: "Austin",
      "Start date": new Date(2026, 10, 2).toLocaleDateString(),
    });
    expect(within(card).getByText("Due in 4 days")).toBeTruthy();
    expect(within(card).getByRole("link", { name: "Avery Abara" }).getAttribute("href")).toBe("/cases/E001");
    // no privileged choice when none was requested
    expect(within(card).queryByRole("radio")).toBeNull();
  });

  it("formats the SLA in hours below 48 h and in days from there", () => {
    const now = Date.parse("2026-10-08T12:00:00Z");
    expect(slaText("2026-10-08T17:00:00Z", now)).toBe("Due in 5 h");
    expect(slaText("2026-10-10T11:00:00Z", now)).toBe("Due in 47 h");
    expect(slaText("2026-10-10T12:00:00Z", now)).toBe("Due in 2 days");
    expect(slaText("2026-10-03T12:00:00Z", now)).toBe("Overdue by 5 days");
    expect(slaText("2026-10-08T11:30:00Z", now)).toBe("Overdue by less than 1 h");
    expect(formatDate("2026-11-02")).toBe(new Date(2026, 10, 2).toLocaleDateString());
  });

  it("shows the round-1 rejection reason and the People Ops note on a round-2 card", async () => {
    serve([approval({ id: "apr:E001:manager_approval:2", round: 2, previousRound: { round: 1, reason: "wrong laptop", note: "switched to the standard profile" } })]);
    renderWith(<ApprovalsPage />, { me: PERSONAS.manager!, path: "/approvals" });
    const card = await screen.findByRole("article", { name: "manager approval for Avery Abara" });
    expect(within(card).getByText("Round 1 rejected: wrong laptop")).toBeTruthy();
    expect(within(card).getByText("People Ops note: switched to the standard profile")).toBeTruthy();
  });

  it("tells an admin they decide on behalf, before any decision", async () => {
    serve([approval(), approval({ id: "apr:E003:closeout:1", employeeId: "E003", employeeName: "Wren Abara", checkpoint: "closeout", stageId: "closeout", approverRole: "coordinator", approverStaffId: null, request: { summary: "All stages before sign-off are complete", startDate: "2026-11-02" } })]);
    renderWith(<ApprovalsPage />, { me: PERSONAS.admin!, path: "/approvals" });
    const manager = await screen.findByRole("article", { name: "manager approval for Avery Abara" });
    expect(within(manager).getByText("You are deciding on behalf of the hiring manager (M01). The decision is audited.")).toBeTruthy();
    expect(within(screen.getByRole("article", { name: "closeout for Wren Abara" })).getByText("You are deciding on behalf of People Ops. The decision is audited.")).toBeTruthy();
    cleanup();
    serve();
    renderWith(<ApprovalsPage />, { me: PERSONAS.manager!, path: "/approvals" });
    await screen.findByRole("article", { name: "manager approval for Avery Abara" });
    expect(screen.queryByText(/on behalf of/)).toBeNull();
  });

  it("shows Resubmit only to People Ops and admins, for revision-requested items, and confirms the new round", async () => {
    for (const persona of ["peopleOps", "admin"] as const) {
      const calls = serve();
      renderWith(<ApprovalsPage />, { me: PERSONAS[persona]!, path: "/approvals" });
      const card = await screen.findByRole("article", { name: "manager approval for Blake Brennick" });
      fireEvent.change(within(card).getByLabelText(/What changed/), { target: { value: "cheaper model" } });
      fireEvent.click(within(card).getByRole("button", { name: "Resubmit manager approval for Blake Brennick" }));
      await waitFor(() => expect(calls.some((c) => c.url.endsWith("/resubmit"))).toBe(true));
      expect(calls.find((c) => c.url.endsWith("/resubmit"))!.body).toEqual({ note: "cheaper model" });
      expect(await within(card).findByText("Resubmitted: round 2 sent for approval")).toBeTruthy();
      cleanup();
    }
    serve();
    renderWith(<ApprovalsPage />, { me: PERSONAS.it!, path: "/approvals" });
    await screen.findByRole("article", { name: /Avery Abara/ });
    expect(screen.queryByRole("button", { name: /^Resubmit/ })).toBeNull();
    // an IT coordinator cannot decide a manager approval either
    expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
  });

  it("keeps each card's pending state and messages to that card, and a stale card says it was already decided", async () => {
    const second = approval({ id: "apr:E002:manager_approval:1", employeeId: "E002", employeeName: "Blake Brennick", request: { equipmentProfile: "standard", licenseBundle: "ft-standard", needsPrivilegedAccess: false } });
    let release: (() => void) | null = null;
    let list = [approval(), second];
    mockFetch(async (url, method) => {
      if (method === "POST") {
        if (url.includes("E002")) {
          list = [approval()];
          return { status: 409, body: { error: { code: "approval_not_pending", message: "approval is approved", requestId: "r-2" } } };
        }
        await new Promise<void>((r) => {
          release = r;
        });
        return { body: { ...approval(), status: "approved" } };
      }
      return { body: { items: list, nextCursor: null } };
    });
    renderWith(<ApprovalsPage />, { me: PERSONAS.admin!, path: "/approvals" });
    const avery = await screen.findByRole("article", { name: "manager approval for Avery Abara" });
    const blake = screen.getByRole("article", { name: "manager approval for Blake Brennick" });
    fireEvent.click(within(avery).getByLabelText("Grant privileged access"));
    const approveAvery = within(avery).getByRole("button", { name: "Approve manager approval for Avery Abara" }) as HTMLButtonElement;
    fireEvent.click(approveAvery);
    await waitFor(() => expect(isBusy(approveAvery)).toBe(true));
    const approveBlake = within(blake).getByRole("button", { name: "Approve manager approval for Blake Brennick" }) as HTMLButtonElement;
    expect(approveBlake.disabled).toBe(false);
    expect(isBusy(approveBlake)).toBe(false);
    fireEvent.click(approveBlake);
    expect((await within(blake).findByRole("alert")).textContent).toContain("Already decided. Nothing more to do.");
    expect(within(avery).queryByRole("alert")).toBeNull();
    // the list refetched without Blake's card, but the card stays with its message
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByRole("article", { name: "manager approval for Blake Brennick" })).toBeTruthy();
    (release as unknown as () => void)();
    await waitFor(() => expect(announced()).toMatch(/^Approved/));
  });

  it("refetches the approvals when the window regains focus", async () => {
    const calls = serve();
    renderWith(<ApprovalsPage />, { me: PERSONAS.manager!, path: "/approvals" });
    await screen.findByRole("article", { name: "manager approval for Avery Abara" });
    const before = calls.filter((c) => c.url.startsWith("/api/approvals")).length;
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await waitFor(() => expect(calls.filter((c) => c.url.startsWith("/api/approvals")).length).toBeGreaterThan(before));
    focusManager.setFocused(undefined);
  });

  it("focuses the card named by /approvals#approval-<id> (the queue's link)", async () => {
    serve();
    renderWith(<ApprovalsPage />, { me: PERSONAS.peopleOps!, path: `/approvals#approval-${encodeURIComponent("apr:E002:manager_approval:1")}` });
    const card = await screen.findByRole("article", { name: "manager approval for Blake Brennick" });
    await waitFor(() => expect(document.activeElement).toBe(card));
    expect(card.id).toBe("approval-apr:E002:manager_approval:1");
  });

  it("says so when the linked card is not waiting any more", async () => {
    serve();
    renderWith(<ApprovalsPage />, { me: PERSONAS.peopleOps!, path: `/approvals#approval-${encodeURIComponent("apr:E099:manager_approval:1")}` });
    await screen.findByText(/That request is not waiting here any more/);
  });
});
