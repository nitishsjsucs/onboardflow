import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaseDetailPage } from "../../src/web/pages/CaseDetailPage.tsx";
import { caseDetail } from "./fixtures.ts";
import { mockFetch, PERSONAS, renderWith } from "./harness.tsx";

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

  it("shows Retry only to the owning department and admins, and sends the retry", async () => {
    const calls = serve();
    renderWith(null, { me: PERSONAS.it!, path: "/cases/E001", routes });
    fireEvent.click(await screen.findByRole("button", { name: "Retry IT provisioning" }));
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
    expect(await screen.findByRole("button", { name: "Retry IT provisioning" })).toBeTruthy();
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
});
