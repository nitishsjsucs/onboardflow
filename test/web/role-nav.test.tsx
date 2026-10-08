import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AppShell, navFor } from "../../src/web/components/AppShell.tsx";
import { RoleGate } from "../../src/web/components/RoleGate.tsx";
import { PERSONAS, renderWith } from "./harness.tsx";

afterEach(cleanup);

function navLinks() {
  return within(screen.getByRole("navigation", { name: "main" }))
    .getAllByRole("link")
    .map((a) => a.textContent);
}

describe("AppShell navigation per role", () => {
  it.each([
    ["employee", ["My onboarding"]],
    ["manager", ["Approvals", "My team"]],
    ["peopleOps", ["Queue", "Cases", "Dashboard", "Approvals"]],
    ["it", ["Queue", "Cases", "Dashboard"]],
    ["admin", ["Dashboard", "Cases", "Queue", "Approvals"]],
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
