import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmployeeProfileDto } from "../../src/shared/api.ts";
import { DataIssueFix } from "../../src/web/components/DataIssueFix.tsx";
import { CaseDetailPage } from "../../src/web/pages/CaseDetailPage.tsx";
import { caseDetail, profile } from "./fixtures.ts";
import { type MockResponse, announced, isBusy, mockFetch, PERSONAS, renderWith } from "./harness.tsx";

vi.mock("../../src/web/live/useCaseLive.ts", () => ({ useCaseLive: () => ({ state: null, status: "connected" }) }));

afterEach(cleanup);

const COST_CENTER = { field: "costCenter", system: "hr", operation: "hr.create-worker", class: "fatal", message: "costCenter must match CC-####" };
const BUNDLE = { field: "licenseBundle", system: "it", operation: "it.assign-licenses", class: "fatal", message: "bundle ft-standard is not allowed for contractor" };
const PHOTO = { field: "photoOnFile", system: "facilities", operation: "facilities.issue-badge", class: "fatal", message: "a badge photo is required" };

function serve(p: EmployeeProfileDto, post?: (url: string, method: string) => MockResponse) {
  let current = p;
  return mockFetch((url, method, body) => {
    if (method === "PATCH") {
      const r = post?.(url, method);
      if (r) return r;
      current = { ...current, ...(body as object) };
      return { body: current };
    }
    if (method === "POST") return post?.(url, method) ?? { status: 202, body: { round: 2 } };
    return { body: current };
  });
}

function fixFor(detail: Record<string, unknown>, me = PERSONAS.admin!, stageId: "intake" | "it_provisioning" | "facilities_setup" = "intake", owner = "people_ops") {
  return renderWith(<DataIssueFix me={me} employeeId="E042" employeeName="Logan Northcott" stageId={stageId} owner={owner} detail={detail} />, { me });
}

const writes = (calls: ReturnType<typeof mockFetch>) => calls.filter((c) => c.method !== "GET");

describe("DataIssueFix", () => {
  it("shows what was rejected and the current value, and accepts only a cost center the simulated HR system takes", async () => {
    serve(profile());
    fixFor(COST_CENTER, PERSONAS.peopleOps!);
    // field names in words, no raw codes
    expect(screen.getByText("HR (simulated) rejected the cost center: cost center must match CC-####")).toBeTruthy();
    expect((await screen.findByText("CC 1100")).className).toContain("mono");
    const input = screen.getByLabelText("New cost center");
    const hint = screen.getByText("CC- followed by 4 digits, for example CC-1100");
    expect(input.getAttribute("aria-describedby")).toBe(hint.id);
    const submit = screen.getByRole("button", { name: "Fix cost center" }) as HTMLButtonElement;
    for (const bad of ["CC-12", "CC 1100", "cc-1100", "CC-11000"]) {
      fireEvent.change(input, { target: { value: bad } });
      expect(submit.disabled).toBe(true);
    }
    fireEvent.change(input, { target: { value: " CC-1100 " } });
    expect(submit.disabled).toBe(false);
  });

  it("before a fix, Retry is secondary with the recovery-round warning; after a 200 it offers Retry now, with a key of its own", async () => {
    const calls = serve(profile());
    fixFor(COST_CENTER, PERSONAS.peopleOps!);
    await screen.findByText("CC 1100");
    const early = screen.getByRole("button", { name: "Retry Pre-boarding intake for Logan Northcott" });
    expect(early.className).not.toContain("primary");
    expect(document.getElementById(early.getAttribute("aria-describedby")!)!.textContent).toBe(
      "Fix the cost center first, or the retry fails again and uses one of this stage's recovery rounds.",
    );
    fireEvent.change(screen.getByLabelText("New cost center"), { target: { value: "CC-1100" } });
    fireEvent.click(screen.getByRole("button", { name: "Fix cost center" }));
    await screen.findByText("Saved. Retry Pre-boarding intake now?");
    await waitFor(() => expect(announced()).toBe("Saved the cost center for Logan Northcott"));
    const now = screen.getByRole("button", { name: "Retry Pre-boarding intake now for Logan Northcott" });
    expect(now.className).toContain("primary");
    fireEvent.click(now);
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    const [patch, retry] = writes(calls);
    expect([patch!.method, patch!.url, patch!.body]).toEqual(["PATCH", "/api/employees/E042", { costCenter: "CC-1100" }]);
    expect([retry!.method, retry!.url]).toEqual(["POST", "/api/cases/E042/stages/intake/retry"]);
    expect(retry!.headers["Idempotency-Key"]).toBeTruthy();
    expect(retry!.headers["Idempotency-Key"]).not.toBe(patch!.headers["Idempotency-Key"]);
    await screen.findByText("Retry requested for Pre-boarding intake: round 2 running");
  });

  it("names a running retry as running, in the accessible name too", async () => {
    serve(profile());
    renderWith(<DataIssueFix me={PERSONAS.peopleOps!} employeeId="E042" employeeName="Logan Northcott" stageId="intake" owner="people_ops" detail={COST_CENTER} retryRunning />, { me: PERSONAS.peopleOps! });
    await screen.findByText("CC 1100");
    const running = screen.getByRole("button", { name: "Retry running: Pre-boarding intake for Logan Northcott" }) as HTMLButtonElement;
    expect(running.textContent).toBe("Retry running");
    expect(isBusy(running)).toBe(true);
  });

  it("offers only the bundles IT accepts for the employment type, minus the rejected one, with nothing preselected", async () => {
    serve(profile({ licenseBundle: "ft-standard" }));
    fixFor(BUNDLE, PERSONAS.it!, "it_provisioning", "it");
    await screen.findByText("ft-standard");
    const select = screen.getByLabelText("New license bundle") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["", "ft-engineering"]);
    expect(select.value).toBe("");
    expect((screen.getByRole("button", { name: "Fix license bundle" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    serve(profile({ employmentType: "contractor", licenseBundle: "ft-standard" }));
    fixFor(BUNDLE, PERSONAS.it!, "it_provisioning", "it");
    await screen.findByText("ft-standard");
    expect([...(screen.getByLabelText("New license bundle") as HTMLSelectElement).options].map((o) => o.value)).toEqual(["", "contractor-basic"]);
    fireEvent.change(screen.getByLabelText("New license bundle"), { target: { value: "contractor-basic" } });
    expect((screen.getByRole("button", { name: "Fix license bundle" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("marks the photo on file, then says so and moves focus to Retry now", async () => {
    const calls = serve(profile({ photoOnFile: false }));
    fixFor(PHOTO, PERSONAS.admin!, "facilities_setup", "facilities");
    const mark = await screen.findByRole("button", { name: "Mark photo on file for Logan Northcott" });
    mark.focus();
    fireEvent.click(mark);
    await screen.findByText("Photo on file");
    expect(writes(calls)[0]!.body).toEqual({ photoOnFile: true });
    expect(screen.queryByRole("button", { name: /Mark photo on file/ })).toBeNull();
    // the removed button's focus goes to the next step
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Retry Facilities setup now for Logan Northcott" })));
  });

  it("moves focus to Retry now after a saved cost center", async () => {
    serve(profile());
    fixFor(COST_CENTER, PERSONAS.peopleOps!);
    await screen.findByText("CC 1100");
    fireEvent.change(screen.getByLabelText("New cost center"), { target: { value: "CC-1100" } });
    fireEvent.click(screen.getByRole("button", { name: "Fix cost center" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Retry Pre-boarding intake now for Logan Northcott" })));
  });

  it("clears the bundle choice after a saved fix, so Fix license bundle cannot resend it", async () => {
    const calls = serve(profile({ licenseBundle: "ft-standard" }));
    fixFor(BUNDLE, PERSONAS.it!, "it_provisioning", "it");
    await screen.findByText("ft-standard");
    const select = screen.getByLabelText("New license bundle") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "ft-engineering" } });
    fireEvent.click(screen.getByRole("button", { name: "Fix license bundle" }));
    await screen.findByText("Saved. Retry IT provisioning now?");
    expect(writes(calls)[0]!.body).toEqual({ licenseBundle: "ft-engineering" });
    // the profile refetched: ft-engineering is current, so the list offers only the other bundle, none chosen
    await waitFor(() => expect([...select.options].map((o) => o.value)).toEqual(["", "ft-standard"]));
    expect(select.value).toBe("");
    expect((screen.getByRole("button", { name: "Fix license bundle" }) as HTMLButtonElement).disabled).toBe(true);
    expect(writes(calls)).toHaveLength(1);
  });

  it("explains field_locked_by_approval inside the row", async () => {
    serve(profile({ licenseBundle: "ft-standard" }), (_url, method) =>
      method === "PATCH"
        ? { status: 409, body: { error: { code: "field_locked_by_approval", message: "the license bundle was part of the manager's approval request; it can change only to correct an open data issue", requestId: "r-lock" } } }
        : { status: 202, body: { round: 2 } },
    );
    const { container } = fixFor(BUNDLE, PERSONAS.it!, "it_provisioning", "it");
    await screen.findByText("ft-standard");
    fireEvent.change(screen.getByLabelText("New license bundle"), { target: { value: "ft-engineering" } });
    fireEvent.click(screen.getByRole("button", { name: "Fix license bundle" }));
    const alert = await within(container).findByRole("alert");
    expect(alert.textContent).toContain("The license bundle was part of the manager's approval, so it can change only to fix an open license bundle issue.");
    expect(alert.textContent).toContain("Request id r-lock");
  });

  it("shows nothing to someone who may neither fix the field nor retry the stage", async () => {
    const calls = serve(profile());
    const { container } = fixFor(COST_CENTER, PERSONAS.it!);
    expect(container.querySelector(".data-fix")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("CaseDetailPage data issues", () => {
  function detailWithDataIssue() {
    const d = caseDetail("intake");
    const intake = d.stages.find((s) => s.id === "intake")!;
    intake.status = "blocked";
    intake.blockedReason = { ...COST_CENTER, round: 1 };
    d.blockers = [
      {
        id: "blk:E001:data_issue:intake",
        employeeId: "E001",
        employeeName: "Avery Abara",
        stageId: "intake",
        kind: "data_issue",
        severity: "high",
        ownerDepartment: "people_ops",
        subject: "hr.create-worker",
        status: "open",
        detail: { ...COST_CENTER, round: 1 },
        detectedAt: "2026-10-08T10:00:00.000Z",
        resolvedAt: null,
        resolvedBy: null,
        resolution: null,
        followUpTaskId: null,
        stageStatus: "blocked",
        stageRound: 1,
      },
    ];
    return d;
  }

  function serveCase() {
    const d = detailWithDataIssue();
    return mockFetch((url) => {
      if (url.includes("/audit")) return { body: { items: [], nextCursor: null } };
      if (url.startsWith("/api/employees/")) return { body: profile({ id: "E001", firstName: "Avery", lastName: "Abara" }) };
      return { body: d };
    });
  }

  const routes = [{ path: "/cases/:id", element: <CaseDetailPage /> }];

  it("shows the guided fix to the owning department and admins, with Retry secondary before the fix", async () => {
    for (const persona of ["peopleOps", "admin"] as const) {
      serveCase();
      renderWith(null, { me: PERSONAS[persona]!, path: "/cases/E001", routes });
      const blockers = await screen.findByRole("region", { name: "blockers" });
      expect(await within(blockers).findByLabelText("New cost center")).toBeTruthy();
      const retry = within(blockers).getByRole("button", { name: "Retry Pre-boarding intake for Avery Abara" });
      expect(retry.className).not.toContain("primary");
      cleanup();
    }
  });

  it("guides the fix when an outage blocker stays open beside the data issue, even after the stage was blocked again by the outage", async () => {
    const d = detailWithDataIssue();
    const intake = d.stages.find((s) => s.id === "intake")!;
    // the fix was saved but HR is down again: the stage's reason is an outage, the data issue is still open
    intake.blockedReason = { class: "retryable", system: "hr", operation: "hr.create-worker", message: "service_unavailable", round: 2 };
    const outage = { ...d.blockers[0]!, id: "blk:E001:integration_outage:intake", kind: "integration_outage" as const, detail: { class: "retryable", system: "hr", operation: "hr.create-worker", message: "service_unavailable" } };
    d.blockers = [outage, d.blockers[0]!];
    mockFetch((url) => {
      if (url.includes("/audit")) return { body: { items: [], nextCursor: null } };
      if (url.startsWith("/api/employees/")) return { body: profile({ id: "E001", firstName: "Avery", lastName: "Abara" }) };
      return { body: d };
    });
    renderWith(null, { me: PERSONAS.peopleOps!, path: "/cases/E001", routes });
    const blockers = await screen.findByRole("region", { name: "blockers" });
    expect(await within(blockers).findByLabelText("New cost center")).toBeTruthy();
    // the cost center is still CC 1100: one Retry, secondary, with the recovery-round warning
    const retries = within(blockers).getAllByRole("button", { name: /^Retry/ });
    expect(retries).toHaveLength(1);
    expect(retries[0]!.className).not.toContain("primary");
  });

  it("shows no fix control to anyone else", async () => {
    for (const persona of ["it", "manager"] as const) {
      serveCase();
      renderWith(null, { me: PERSONAS[persona]!, path: "/cases/E001", routes });
      const blockers = await screen.findByRole("region", { name: "blockers" });
      expect(within(blockers).queryByLabelText("New cost center")).toBeNull();
      expect(within(blockers).queryByRole("button", { name: /Retry/ })).toBeNull();
      cleanup();
    }
  });
});
