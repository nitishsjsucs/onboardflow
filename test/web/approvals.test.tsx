import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalsPage } from "../../src/web/pages/ApprovalsPage.tsx";
import { approval } from "./fixtures.ts";
import { announced, mockFetch, PERSONAS, renderWith } from "./harness.tsx";

afterEach(cleanup);

const rejected = approval({ id: "apr:E002:manager_approval:1", employeeId: "E002", employeeName: "Blake Brennick", status: "rejected", reason: "wrong laptop", resubmittable: true });

function serve() {
  return mockFetch((url, method) => {
    if (method === "POST") return { body: { ...approval(), status: "approved" } };
    if (url.includes("status=rejected")) return { body: { items: [rejected], nextCursor: null } };
    return { body: { items: [approval()], nextCursor: null } };
  });
}

describe("ApprovalsPage", () => {
  it("lets the manager approve (with the privileged access flag) and reject with a reason", async () => {
    const calls = serve();
    renderWith(<ApprovalsPage />, { me: PERSONAS.manager!, path: "/approvals" });
    const card = await screen.findByRole("article", { name: /manager approval for Avery Abara/ });
    expect(within(card).getByText(/due in/)).toBeTruthy();
    // reject needs a reason
    expect((within(card).getByRole("button", { name: "Reject manager approval for Avery Abara" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(card).getByRole("checkbox"));
    fireEvent.click(within(card).getByRole("button", { name: "Approve manager approval for Avery Abara" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const approve = calls.find((c) => c.method === "POST")!;
    expect(approve.url).toBe("/api/approvals/apr%3AE001%3Amanager_approval%3A1/decision");
    expect(approve.body).toEqual({ decision: "approve", privilegedAccessApproved: true });
    expect(approve.headers["X-OnboardFlow"]).toBe("1");
    expect(approve.headers["Idempotency-Key"]).toBeTruthy();

    fireEvent.change(within(card).getByLabelText("reason"), { target: { value: "budget" } });
    await waitFor(() => expect((within(card).getByRole("button", { name: /^Reject/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(card).getByRole("button", { name: /^Reject/ }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
    expect(calls.filter((c) => c.method === "POST")[1]!.body).toEqual({ decision: "reject", reason: "budget" });
    // managers never see the resubmission list
    expect(screen.queryByText("Revision requested")).toBeNull();
    expect(calls.some((c) => c.url.includes("status=rejected"))).toBe(false);
  });

  it("shows Resubmit only to People Ops and admins, for revision-requested items", async () => {
    for (const persona of ["peopleOps", "admin"] as const) {
      const calls = serve();
      renderWith(<ApprovalsPage />, { me: PERSONAS[persona]!, path: "/approvals" });
      const card = await screen.findByRole("article", { name: /manager approval for Blake Brennick/ });
      fireEvent.change(within(card).getByLabelText("revision note"), { target: { value: "cheaper model" } });
      fireEvent.click(within(card).getByRole("button", { name: "Resubmit manager approval for Blake Brennick" }));
      await waitFor(() => expect(calls.some((c) => c.url.endsWith("/resubmit"))).toBe(true));
      expect(calls.find((c) => c.url.endsWith("/resubmit"))!.body).toEqual({ note: "cheaper model" });
      cleanup();
    }
    serve();
    renderWith(<ApprovalsPage />, { me: PERSONAS.it!, path: "/approvals" });
    await screen.findByRole("article", { name: /Avery Abara/ });
    expect(screen.queryByRole("button", { name: /^Resubmit/ })).toBeNull();
    // an IT coordinator cannot decide a manager approval either
    expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
  });

  it("keeps each card's pending state and messages to that card", async () => {
    const second = approval({ id: "apr:E002:manager_approval:1", employeeId: "E002", employeeName: "Blake Brennick", request: { equipmentProfile: "standard", licenseBundle: "ft-standard", needsPrivilegedAccess: false } });
    let release: (() => void) | null = null;
    mockFetch(async (url, method) => {
      if (method === "POST") {
        if (url.includes("E002")) return { status: 409, body: { error: { code: "approval_not_pending", message: "approval is approved", requestId: "r-2" } } };
        await new Promise<void>((r) => {
          release = r;
        });
        return { body: { ...approval(), status: "approved" } };
      }
      return { body: { items: [approval(), second], nextCursor: null } };
    });
    renderWith(<ApprovalsPage />, { me: PERSONAS.admin!, path: "/approvals" });
    const avery = await screen.findByRole("article", { name: /manager approval for Avery Abara/ });
    const blake = screen.getByRole("article", { name: /manager approval for Blake Brennick/ });
    fireEvent.click(within(avery).getByRole("checkbox"));
    const approveAvery = within(avery).getByRole("button", { name: "Approve manager approval for Avery Abara" }) as HTMLButtonElement;
    fireEvent.click(approveAvery);
    await waitFor(() => expect(approveAvery.disabled).toBe(true));
    const approveBlake = within(blake).getByRole("button", { name: "Approve manager approval for Blake Brennick" }) as HTMLButtonElement;
    expect(approveBlake.disabled).toBe(false);
    fireEvent.click(approveBlake);
    expect((await within(blake).findByRole("alert")).textContent).toContain("Already decided. Nothing more to do.");
    expect(within(avery).queryByRole("alert")).toBeNull();
    (release as unknown as () => void)();
    await waitFor(() => expect(announced()).toMatch(/^Approved/));
  });
});
