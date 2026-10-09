import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AuditPage } from "../../src/web/pages/AuditPage.tsx";
import { IntegrationsPage } from "../../src/web/pages/IntegrationsPage.tsx";
import { auditEvent } from "./fixtures.ts";
import { mockFetch, PERSONAS, renderWith } from "./harness.tsx";

afterEach(cleanup);

const health = {
  hr: { calls: 10, ok: 9, retried: 1, replayed: 0, lastErrorAt: "2026-10-08T10:00:00.000Z" },
  it: { calls: 20, ok: 15, retried: 3, replayed: 2, lastErrorAt: null },
  facilities: { calls: 0, ok: 0, retried: 0, replayed: 0, lastErrorAt: null },
};

describe("IntegrationsPage", () => {
  it("shows per-system health for the chosen window and a case's call log", async () => {
    const calls = mockFetch((url) => {
      if (url.startsWith("/api/integrations/health")) return { body: health };
      return {
        body: {
          items: [
            { id: "c1", runNo: 1, stepName: "it_provisioning.it.order-device#r1", system: "it", operation: "it.order-device", method: "POST", path: "/sim/it/v1/device-orders", idempotencyKey: "E042:it.order-device", attempt: 1, httpStatus: 503, outcome: "retryable_error", retryAfterMs: null, latencyMs: 4, error: "x", createdAt: "2026-10-08T10:00:00.000Z" },
            { id: "c2", runNo: 1, stepName: "it_provisioning.it.order-device#r1", system: "it", operation: "it.order-device", method: "POST", path: "/sim/it/v1/device-orders", idempotencyKey: "E042:it.order-device", attempt: 2, httpStatus: 202, outcome: "ok", retryAfterMs: null, latencyMs: 6, error: null, createdAt: "2026-10-08T10:00:01.000Z" },
          ],
          nextCursor: null,
        },
      };
    });
    renderWith(<IntegrationsPage />, { me: PERSONAS.it!, path: "/integrations" });
    expect((await screen.findByTestId("health-it")).textContent).toContain("85.0%");
    expect(screen.getByTestId("health-facilities").textContent).toContain("n/a");
    fireEvent.change(screen.getByLabelText("window"), { target: { value: "7d" } });
    await waitFor(() => expect(calls.some((c) => c.url === "/api/integrations/health?window=7d")).toBe(true));
    fireEvent.change(screen.getByLabelText("case id"), { target: { value: "e042" } });
    await waitFor(() => expect(screen.getAllByTestId("call")).toHaveLength(2));
    expect(calls.some((c) => c.url === "/api/cases/E042/integrations?limit=50")).toBe(true);
    expect(screen.getAllByText("E042:it.order-device")).toHaveLength(2);
  });
});

describe("AuditPage", () => {
  it("filters by action, actor and case, newest first with pagination", async () => {
    const calls = mockFetch((url) =>
      url.includes("cursor=") ? { body: { items: [auditEvent(1)], nextCursor: null } } : { body: { items: [auditEvent(3), auditEvent(2)], nextCursor: "Mg" } },
    );
    renderWith(<AuditPage />, { me: PERSONAS.admin!, path: "/audit" });
    await waitFor(() => expect(screen.getAllByTestId("audit-event")).toHaveLength(2));
    fireEvent.change(screen.getByLabelText("action"), { target: { value: "approval.approved" } });
    fireEvent.change(screen.getByLabelText("case"), { target: { value: "e001" } });
    await waitFor(() => expect(calls.some((c) => c.url === "/api/audit?limit=50&action=approval.approved&employeeId=E001")).toBe(true));
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getAllByTestId("audit-event")).toHaveLength(3));
  });
});
