import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CasesPage } from "../../src/web/pages/CasesPage.tsx";
import { employee } from "./fixtures.ts";
import { announced, isBusy, mockFetch, PERSONAS, renderWith } from "./harness.tsx";

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const employeeGets = (calls: ReturnType<typeof mockFetch>) => calls.filter((c) => c.url.startsWith("/api/employees"));

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
    wren.focus();
    fireEvent.click(wren);
    await waitFor(() => expect(isBusy(wren)).toBe(true));
    // only the row that acted waits
    expect(isBusy(logan)).toBe(false);
    expect(logan.disabled).toBe(false);
    (release as unknown as () => void)();
    const row = wren.closest("tr") as HTMLElement;
    const confirmation = await within(row).findByText("Onboarding started for Wren Abara");
    await waitFor(() => expect(announced()).toBe("Onboarding started for Wren Abara"));
    // Start went away with the success: its confirmation took focus instead of <body>
    expect(within(row).queryByRole("button", { name: /^Start/ })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(confirmation));
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

describe("CasesPage list", () => {
  it("loads the next 100 with the cursor and appends them", async () => {
    const page1 = Array.from({ length: 3 }, (_, i) => employee(`E00${i + 1}`, `Person ${i + 1}`));
    const calls = mockFetch((url) =>
      url.includes("cursor=") ? { body: { items: [employee("E150", "Last Person")], nextCursor: null } } : { body: { items: page1, nextCursor: "IkUxMDAi" } },
    );
    renderWith(<CasesPage />, { me: PERSONAS.admin!, path: "/cases" });
    await screen.findByText("Showing 3; more available");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByRole("link", { name: "Last Person" });
    expect(screen.getAllByRole("row")).toHaveLength(1 + 4);
    expect(calls.some((c) => c.url === "/api/employees?limit=100&cursor=IkUxMDAi")).toBe(true);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(screen.getByText("4 employees")).toBeTruthy();
  });

  it("keeps the filters in the URL: a link opens pre-filtered, and Back restores the previous filter", async () => {
    const calls = mockFetch(() => ({ body: { items: [WREN], nextCursor: null } }));
    const { router } = renderWith(<CasesPage />, { me: PERSONAS.peopleOps!, path: "/cases?status=blocked" });
    await screen.findByRole("link", { name: "Wren Abara" });
    expect((screen.getByLabelText("status") as HTMLSelectElement).value).toBe("blocked");
    expect(employeeGets(calls)[0]!.url).toBe("/api/employees?limit=100&status=blocked");
    fireEvent.change(screen.getByLabelText("stage"), { target: { value: "paperwork" } });
    await waitFor(() => expect(router.state.location.search).toBe("?status=blocked&stage=paperwork"));
    await waitFor(() => expect(employeeGets(calls).some((c) => c.url === "/api/employees?limit=100&status=blocked&stage=paperwork")).toBe(true));
    await act(() => router.navigate(-1));
    expect(router.state.location.search).toBe("?status=blocked");
    expect((screen.getByLabelText("stage") as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText("status") as HTMLSelectElement).value).toBe("blocked");
  });

  it("sends one search request, after typing stops", async () => {
    const calls = mockFetch(() => ({ body: { items: [WREN], nextCursor: null } }));
    const { router } = renderWith(<CasesPage />, { me: PERSONAS.peopleOps!, path: "/cases" });
    await screen.findByRole("link", { name: "Wren Abara" });
    expect(employeeGets(calls)).toHaveLength(1);
    vi.useFakeTimers();
    const search = screen.getByLabelText("search");
    for (const typed of ["W", "Wr", "Wre", "Wren"]) {
      fireEvent.change(search, { target: { value: typed } });
      await act(async () => {
        vi.advanceTimersByTime(100);
      });
    }
    expect(employeeGets(calls)).toHaveLength(1);
    // typing replaced the history entry instead of adding one per keystroke
    expect(router.state.location.search).toBe("?q=Wren");
    expect(router.state.historyAction).toBe("REPLACE");
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    vi.useRealTimers();
    await waitFor(() => expect(employeeGets(calls)).toHaveLength(2));
    expect(employeeGets(calls)[1]!.url).toBe("/api/employees?limit=100&q=Wren");
  });

  it("labels every cell with its column header, for the stacked phone layout", async () => {
    mockFetch(() => ({ body: { items: [WREN, LOGAN], nextCursor: null } }));
    renderWith(<CasesPage />, { me: PERSONAS.peopleOps!, path: "/cases" });
    await screen.findByRole("link", { name: "Wren Abara" });
    const headers = [...document.querySelectorAll("table.list thead th")].map((th) => th.textContent);
    for (const row of document.querySelectorAll("table.list tbody tr")) {
      expect([...row.querySelectorAll("td")].map((td) => td.getAttribute("data-label"))).toEqual(headers);
    }
  });
});
