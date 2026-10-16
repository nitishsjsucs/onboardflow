import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CasesPage } from "../../src/web/pages/CasesPage.tsx";
import { employee } from "./fixtures.ts";
import { announced, mockFetch, PERSONAS, renderWith } from "./harness.tsx";

afterEach(cleanup);

const WREN = employee("E003", "Wren Abara");
const LOGAN = employee("E004", "Logan Northcott");

describe("CasesPage actions", () => {
  it("starts one case per row, names the employee on each button, and confirms in the row and the live region", async () => {
    let release: (() => void) | null = null;
    const calls = mockFetch(async (_url, method) => {
      if (method === "POST") {
        await new Promise<void>((r) => {
          release = r;
        });
        return { status: 202, body: { instanceId: "onb-E003-1", created: true } };
      }
      return { body: { items: [WREN, LOGAN], nextCursor: null } };
    });
    renderWith(<CasesPage />, { me: PERSONAS.peopleOps!, path: "/cases" });
    const wren = (await screen.findByRole("button", { name: "Start onboarding for Wren Abara" })) as HTMLButtonElement;
    const logan = screen.getByRole("button", { name: "Start onboarding for Logan Northcott" }) as HTMLButtonElement;
    fireEvent.click(wren);
    await waitFor(() => expect(wren.disabled).toBe(true));
    // only the row that acted waits
    expect(logan.disabled).toBe(false);
    (release as unknown as () => void)();
    const row = wren.closest("tr") as HTMLElement;
    await within(row).findByText("Onboarding started for Wren Abara");
    await waitFor(() => expect(announced()).toBe("Onboarding started for Wren Abara"));
    expect(calls.find((c) => c.method === "POST")!.url).toBe("/api/cases/E003/start");
  });

  it("shows a failed start inside that row with what to do next", async () => {
    mockFetch((_url, method) => {
      if (method === "POST") return { status: 503, body: { error: { code: "workflow_create_failed", message: "the workflow could not be created yet; retry", requestId: "r-503" } } };
      return { body: { items: [WREN, LOGAN], nextCursor: null } };
    });
    renderWith(<CasesPage />, { me: PERSONAS.peopleOps!, path: "/cases" });
    fireEvent.click(await screen.findByRole("button", { name: "Start onboarding for Wren Abara" }));
    const row = screen.getByRole("button", { name: "Start onboarding for Wren Abara" }).closest("tr") as HTMLElement;
    const alert = await within(row).findByRole("alert");
    expect(alert.textContent).toContain("The onboarding workflow could not be started yet. Try again in a moment: it is sent as the same action.");
    expect(alert.textContent).toContain("Request id r-503");
    const other = screen.getByRole("button", { name: "Start onboarding for Logan Northcott" }).closest("tr") as HTMLElement;
    expect(within(other).queryByRole("alert")).toBeNull();
  });
});
