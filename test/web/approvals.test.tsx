import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalsPage } from "../../src/web/pages/ApprovalsPage.tsx";
import { approval } from "./fixtures.ts";
import { mockFetch, PERSONAS, renderWith } from "./harness.tsx";

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
    expect((within(card).getByRole("button", { name: "Reject" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(card).getByRole("checkbox"));
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const approve = calls.find((c) => c.method === "POST")!;
    expect(approve.url).toBe("/api/approvals/apr%3AE001%3Amanager_approval%3A1/decision");
    expect(approve.body).toEqual({ decision: "approve", privilegedAccessApproved: true });
    expect(approve.headers["X-OnboardFlow"]).toBe("1");
    expect(approve.headers["Idempotency-Key"]).toBeTruthy();

    fireEvent.change(within(card).getByLabelText("reason"), { target: { value: "budget" } });
    fireEvent.click(within(card).getByRole("button", { name: "Reject" }));
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
      fireEvent.click(within(card).getByRole("button", { name: "Resubmit" }));
      await waitFor(() => expect(calls.some((c) => c.url.endsWith("/resubmit"))).toBe(true));
      expect(calls.find((c) => c.url.endsWith("/resubmit"))!.body).toEqual({ note: "cheaper model" });
      cleanup();
    }
    serve();
    renderWith(<ApprovalsPage />, { me: PERSONAS.it!, path: "/approvals" });
    await screen.findByRole("article", { name: /Avery Abara/ });
    expect(screen.queryByRole("button", { name: "Resubmit" })).toBeNull();
    // an IT coordinator cannot decide a manager approval either
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });
});
