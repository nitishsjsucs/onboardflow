import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditTimeline } from "../../src/web/components/AuditTimeline.tsx";
import { CaseDetailPage } from "../../src/web/pages/CaseDetailPage.tsx";
import { auditEvent, caseDetail } from "./fixtures.ts";
import { mockFetch, PERSONAS, renderWith } from "./harness.tsx";

vi.mock("../../src/web/live/useCaseLive.ts", () => ({ useCaseLive: () => ({ state: null, status: "connected" }) }));

afterEach(cleanup);

describe("AuditTimeline", () => {
  it("renders actor, action, entity and time for each event", () => {
    const e = auditEvent(7, { actorRole: "manager", actorId: "m01@onboardflow.test", action: "approval.approved", entityType: "approval", entityId: "apr:E001:manager_approval:1", round: 2 });
    renderWith(<AuditTimeline events={[e]} />, { me: PERSONAS.admin! });
    const item = screen.getByTestId("audit-event");
    expect(within(item).getByText("approval.approved")).toBeTruthy();
    expect(within(item).getByText("approval:apr:E001:manager_approval:1")).toBeTruthy();
    expect(item.textContent).toContain("by user m01@onboardflow.test (manager)");
    expect(item.textContent).toContain("round 2");
    expect(item.querySelector("time")?.getAttribute("dateTime")).toBe(e.occurredAt);
  });

  it("paginates the case audit trail with the cursor", async () => {
    const calls = mockFetch((url) => {
      if (url.includes("/audit")) {
        return url.includes("cursor=")
          ? { body: { items: [auditEvent(3)], nextCursor: null } }
          : { body: { items: [auditEvent(1), auditEvent(2)], nextCursor: "Mg" } };
      }
      return { body: caseDetail(null) };
    });
    renderWith(null, { me: PERSONAS.admin!, path: "/cases/E001", routes: [{ path: "/cases/:id", element: <CaseDetailPage /> }] });
    await waitFor(() => expect(screen.getAllByTestId("audit-event")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getAllByTestId("audit-event")).toHaveLength(3));
    expect(calls.some((c) => c.url === "/api/cases/E001/audit?limit=25&cursor=Mg")).toBe(true);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });
});
