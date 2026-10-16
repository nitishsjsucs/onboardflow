import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/web/api/client.ts";
import { createQueryClient, shouldRetryQuery } from "../../src/web/api/query-client.ts";
import { ApprovalsPage } from "../../src/web/pages/ApprovalsPage.tsx";
import { AuditPage } from "../../src/web/pages/AuditPage.tsx";
import { CaseDetailPage } from "../../src/web/pages/CaseDetailPage.tsx";
import { CasesPage } from "../../src/web/pages/CasesPage.tsx";
import { DashboardPage } from "../../src/web/pages/DashboardPage.tsx";
import { EmployeePortalPage } from "../../src/web/pages/EmployeePortalPage.tsx";
import { IntegrationsPage } from "../../src/web/pages/IntegrationsPage.tsx";
import { QueuePage } from "../../src/web/pages/QueuePage.tsx";
import { routes } from "../../src/web/router.tsx";
import { employee } from "./fixtures.ts";
import { mockFetch, PERSONAS, renderWith } from "./harness.tsx";

vi.mock("../../src/web/live/useCaseLive.ts", () => ({ useCaseLive: () => ({ state: null, status: "connected" }) }));
vi.mock("../../src/web/live/useHubLive.ts", () => ({ useHubLive: () => ({ state: null, status: "offline" }) }));

afterEach(cleanup);

const fast = () => createQueryClient({ retryDelay: 0 });
const err = (status: number, code: string, message = "x") => ({ status, body: { error: { code, message, requestId: `r-${status}` } } });
const caseRoutes = [{ path: "/cases/:id", element: <CaseDetailPage /> }];

describe("createQueryClient retry rule", () => {
  it("never retries a 4xx and retries network failures, unreadable answers and 5xx at most twice", () => {
    expect(shouldRetryQuery(0, new ApiError(403, "forbidden", "x", null))).toBe(false);
    expect(shouldRetryQuery(0, new ApiError(404, "not_found", "x", null))).toBe(false);
    expect(shouldRetryQuery(0, new ApiError(409, "stage_not_blocked", "x", null))).toBe(false);
    for (const e of [new ApiError(503, "x", "x", null), new ApiError(0, "network", "x", null), new ApiError(200, "non_json_response", "x", null)]) {
      expect(shouldRetryQuery(0, e)).toBe(true);
      expect(shouldRetryQuery(1, e)).toBe(true);
      expect(shouldRetryQuery(2, e)).toBe(false);
    }
  });
});

describe("page-level loading and error states", () => {
  it("/cases/E999 says there is no such case after one request each, with a link back", async () => {
    const calls = mockFetch(() => err(404, "not_found", "unknown employee"));
    const started = Date.now();
    renderWith(null, { me: PERSONAS.peopleOps!, path: "/cases/E999", routes: caseRoutes, client: createQueryClient() });
    await screen.findByRole("heading", { name: "No case E999" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(screen.getByRole("link", { name: "Back to Cases" }).getAttribute("href")).toBe("/cases");
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.filter((c) => c.url === "/api/cases/E999")).toHaveLength(1);
    expect(calls.filter((c) => c.url.startsWith("/api/cases/E999/audit"))).toHaveLength(1);
  });

  it("explains a 403 per role after one request", async () => {
    const calls = mockFetch(() => err(403, "forbidden", "not allowed to view this case"));
    renderWith(null, { me: PERSONAS.manager!, path: "/cases/E120", routes: caseRoutes, client: createQueryClient() });
    expect((await screen.findByRole("alert")).textContent).toContain("This case is not one of your direct reports.");
    expect(screen.getByRole("link", { name: "Back to my team" })).toBeTruthy();
    expect(calls.filter((c) => c.url === "/api/cases/E120")).toHaveLength(1);
    cleanup();
    mockFetch(() => err(403, "forbidden"));
    renderWith(null, { me: PERSONAS.employee!, path: "/cases/E002", routes: caseRoutes, client: createQueryClient() });
    expect((await screen.findByRole("alert")).textContent).toContain("You can open only your own onboarding.");
  });

  it("retries a 503 on the cases list at most twice, then shows an error with Try again instead of an empty table", async () => {
    let fail = true;
    const calls = mockFetch(() => (fail ? err(503, "internal_error") : { body: { items: [employee("E003", "Wren Abara")], nextCursor: null } }));
    renderWith(<CasesPage />, { me: PERSONAS.peopleOps!, path: "/cases", client: fast() });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not load the cases.");
    expect(calls.filter((c) => c.url.startsWith("/api/employees"))).toHaveLength(3);
    expect(screen.queryByRole("table")).toBeNull();
    fail = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await screen.findByRole("link", { name: "Wren Abara" });
    expect(calls.filter((c) => c.url.startsWith("/api/employees"))).toHaveLength(4);
  });

  it("keeps the previous rows when a background refresh fails, with a warning", async () => {
    let fail = false;
    mockFetch(() => (fail ? err(503, "internal_error") : { body: { items: [employee("E003", "Wren Abara")], nextCursor: null } }));
    const client = fast();
    renderWith(<CasesPage />, { me: PERSONAS.peopleOps!, path: "/cases", client });
    await screen.findByRole("link", { name: "Wren Abara" });
    fail = true;
    await client.refetchQueries({ queryKey: ["employees"] }).catch(() => undefined);
    await screen.findByText(/Could not refresh; showing earlier data/);
    expect(screen.getByRole("link", { name: "Wren Abara" })).toBeTruthy();
  });

  it("keeps an IT coordinator out of /approvals with the API's wording and makes no request", async () => {
    const calls = mockFetch(() => ({ body: { items: [], nextCursor: null } }));
    renderWith(null, { me: PERSONAS.it!, path: "/approvals", routes });
    await screen.findByText("Approvals are handled by managers and People Ops.");
    expect(calls.some((c) => c.url.startsWith("/api/approvals"))).toBe(false);
  });

  it.each([
    ["queue", <QueuePage />, PERSONAS.it!, "Could not load the open blockers."],
    ["approvals", <ApprovalsPage />, PERSONAS.manager!, "Could not load the approvals."],
    ["audit", <AuditPage />, PERSONAS.admin!, "Could not load the audit log."],
    ["portal", <EmployeePortalPage />, PERSONAS.employee!, "Could not load your onboarding."],
    ["dashboard fallback", <DashboardPage />, PERSONAS.admin!, "Could not load the dashboard."],
    ["integrations", <IntegrationsPage />, PERSONAS.admin!, "Could not load the integration health."],
  ])("%s shows a 503 with Try again", async (_name, page, me, text) => {
    mockFetch(() => err(503, "internal_error"));
    renderWith(page, { me, client: fast() });
    const alerts = await screen.findAllByRole("alert");
    const alert = alerts.find((a) => a.textContent?.includes(text));
    expect(alert, `an alert containing "${text}"`).toBeTruthy();
    expect(within(alert!).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("shows 'No case E999' for the call log of an unknown case", async () => {
    mockFetch((url) => (url.startsWith("/api/integrations/health") ? { body: { hr: h(), it: h(), facilities: h() } } : err(404, "not_found", "unknown employee")));
    renderWith(<IntegrationsPage />, { me: PERSONAS.admin!, client: createQueryClient() });
    fireEvent.change(await screen.findByLabelText("case id"), { target: { value: "e999" } });
    expect((await screen.findByRole("alert")).textContent).toBe("No case E999.");
  });

  it("shows no error when a query is cancelled mid-request", async () => {
    mockFetch(
      (_url, _method, _body, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const client = createQueryClient();
    renderWith(<CasesPage />, { me: PERSONAS.peopleOps!, path: "/cases", client });
    await screen.findByText("Loading the cases...");
    await client.cancelQueries();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

function h() {
  return { calls: 0, ok: 0, retried: 0, replayed: 0, lastErrorAt: null };
}
