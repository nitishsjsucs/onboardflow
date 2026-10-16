import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell, navFor } from "../../src/web/components/AppShell.tsx";
import { RoleGate } from "../../src/web/components/RoleGate.tsx";
import { routes } from "../../src/web/router.tsx";
import { caseDetail } from "./fixtures.ts";
import { mockFetch, PERSONAS, renderWith } from "./harness.tsx";

vi.mock("../../src/web/live/useCaseLive.ts", () => ({ useCaseLive: () => ({ state: null, status: "connected" }) }));
vi.mock("../../src/web/live/useHubLive.ts", () => ({ useHubLive: () => ({ state: null, status: "connected" }) }));

afterEach(cleanup);
// the shell reads /api/health; never let a test reach the network
beforeEach(() => {
  mockFetch((url) => (url === "/api/health" ? { body: { ok: true, authMode: "dev", version: "1.0.0" } } : { body: { items: [], nextCursor: null } }));
});

function navLinks() {
  return within(screen.getByRole("navigation", { name: "main" }))
    .getAllByRole("link")
    .filter((a) => a.closest(".account") === null)
    .map((a) => a.textContent);
}

describe("AppShell navigation per role", () => {
  it.each([
    ["employee", ["My onboarding"]],
    ["manager", ["Approvals", "My team"]],
    ["peopleOps", ["Queue", "Cases", "Dashboard", "Approvals", "Integrations"]],
    ["it", ["Queue", "Cases", "Dashboard", "Integrations"]],
    ["admin", ["Dashboard", "Cases", "Queue", "Approvals", "Integrations", "Audit"]],
  ])("%s sees %j", (persona, expected) => {
    renderWith(null, { me: PERSONAS[persona]!, routes: [{ path: "*", element: <AppShell />, children: [{ path: "*", element: <div /> }] }] });
    expect(navLinks()).toEqual(expected);
  });

  it("covers exactly the 4 roles", () => {
    for (const p of Object.values(PERSONAS)) expect(navFor(p).length).toBeGreaterThan(0);
    expect(new Set(Object.values(PERSONAS).map((p) => p.role))).toEqual(new Set(["employee", "manager", "coordinator", "admin"]));
  });

  it("labels the integrations as simulated", () => {
    renderWith(null, { me: PERSONAS.admin!, routes: [{ path: "*", element: <AppShell /> }] });
    expect(screen.getByText("Integrations simulated")).toBeTruthy();
  });
});

describe("RoleGate", () => {
  it("hides admin pages from other roles and shows them to admins", () => {
    const page = (
      <RoleGate roles={["admin"]}>
        <h1>Admin controls</h1>
      </RoleGate>
    );
    renderWith(page, { me: PERSONAS.employee! });
    expect(screen.queryByText("Admin controls")).toBeNull();
    expect(screen.getByText(/not available for your role/)).toBeTruthy();
    cleanup();
    renderWith(page, { me: PERSONAS.admin! });
    expect(screen.getByText("Admin controls")).toBeTruthy();
  });
});

describe("/approvals gate", () => {
  it.each([
    ["manager", true],
    ["peopleOps", true],
    ["admin", true],
    ["it", false],
  ])("%s may open it: %s", async (persona, allowed) => {
    const calls = mockFetch(() => ({ body: { items: [], nextCursor: null } }));
    renderWith(null, { me: PERSONAS[persona]!, path: "/approvals", routes });
    if (allowed) {
      await screen.findByText("Nothing waiting for a decision.");
      expect(calls.some((c) => c.url.startsWith("/api/approvals"))).toBe(true);
    } else {
      await screen.findByText("Approvals are handled by managers and People Ops.");
      expect(calls.some((c) => c.url.startsWith("/api/approvals"))).toBe(false);
    }
  });

  it("refuses a Facilities coordinator too", async () => {
    const calls = mockFetch(() => ({ body: { items: [], nextCursor: null } }));
    renderWith(null, { me: { ...PERSONAS.it!, department: "facilities", staffId: "C05" }, path: "/approvals", routes });
    await screen.findByText("Approvals are handled by managers and People Ops.");
    expect(calls.some((c) => c.url.startsWith("/api/approvals"))).toBe(false);
  });
});

describe("shell accessibility", () => {
  function serveAll() {
    return mockFetch((url) => {
      if (url === "/api/health") return { body: { ok: true, authMode: "dev", version: "1.0.0" } };
      if (url.includes("/audit")) return { body: { items: [], nextCursor: null } };
      if (url.startsWith("/api/cases/")) return { body: caseDetail(null) };
      if (url.startsWith("/api/integrations/health")) return { body: { hr: h(), it: h(), facilities: h() } };
      return { body: { items: [], nextCursor: null } };
    });
  }

  it("makes Skip to content the first Tab stop, and it moves focus to main", async () => {
    serveAll();
    renderWith(null, { me: PERSONAS.admin!, path: "/cases", routes });
    await screen.findByRole("heading", { name: "Cases" });
    await userEvent.tab();
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(document.activeElement).toBe(skip);
    fireEvent.click(skip);
    expect(document.activeElement).toBe(document.getElementById("main"));
  });

  it("gives every route its own document title", async () => {
    serveAll();
    const titles: string[] = [];
    for (const path of ["/dashboard", "/cases", "/queue", "/approvals", "/integrations", "/audit", "/cases/E001", "/nowhere"]) {
      const { router } = renderWith(null, { me: PERSONAS.admin!, path, routes });
      await waitFor(() => expect(router.state.location.pathname).toBe(path));
      await waitFor(() => expect(document.title).not.toBe("OnboardFlow"));
      if (path === "/cases/E001") await waitFor(() => expect(document.title).toBe("Avery Abara, OnboardFlow"));
      titles.push(document.title);
      cleanup();
      document.title = "OnboardFlow";
    }
    expect(new Set(titles).size).toBe(titles.length);
    expect(titles).toContain("Queue, OnboardFlow");
  });

  it("moves focus to the new page's heading after a navigation", async () => {
    serveAll();
    renderWith(null, { me: PERSONAS.admin!, path: "/dashboard", routes });
    await screen.findByRole("heading", { name: "Onboarding dashboard" });
    fireEvent.click(within(screen.getByRole("navigation", { name: "main" })).getByRole("link", { name: "Cases" }));
    const h1 = await screen.findByRole("heading", { level: 1, name: "Cases" });
    await waitFor(() => expect(document.activeElement).toBe(h1));
  });
});

function h() {
  return { calls: 0, ok: 0, retried: 0, replayed: 0, lastErrorAt: null };
}
