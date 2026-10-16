import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockerView, TaskView } from "../../src/shared/api.ts";
import { QueuePage } from "../../src/web/pages/QueuePage.tsx";
import { blocker, profile } from "./fixtures.ts";
import { type FetchCall, mockFetch, PERSONAS, renderWith } from "./harness.tsx";

const hub = vi.hoisted(() => ({ onVersion: undefined as undefined | ((v: number) => void) }));
vi.mock("../../src/web/live/useHubLive.ts", () => ({
  useHubLive: (opts: { onVersion?: (v: number) => void } = {}) => {
    hub.onVersion = opts.onVersion;
    return { state: null, status: "connected" };
  },
}));

afterEach(cleanup);
beforeEach(() => {
  hub.onVersion = undefined;
});

const followUp = (id: string, blockerId: string | null, title: string, assignee: TaskView["assignee"] = "people_ops"): TaskView => ({
  id,
  employeeId: "E003",
  stageId: "manager_approval",
  kind: "followup",
  templateKey: null,
  assignee,
  title,
  description: "d",
  status: "open",
  dueAt: null,
  blockerId,
  draftedBy: "template",
  llmSuggestedCategory: null,
  createdAt: "2026-10-08T10:00:00.000Z",
  completedAt: null,
  completedBy: null,
});

const overdue = blocker({
  id: "blk:E003:approval_overdue",
  employeeId: "E003",
  employeeName: "Wren Abara",
  stageId: "manager_approval",
  kind: "approval_overdue",
  severity: "medium",
  ownerDepartment: "people_ops",
  subject: "apr:E003:manager_approval:1",
  detail: { approvalId: "apr:E003:manager_approval:1", checkpoint: "manager_approval", round: 1, dueAt: "2026-10-07T10:00:00.000Z" },
  detectedAt: "2026-10-08T09:00:00.000Z",
  followUpTaskId: "fu:1",
  stageStatus: "awaiting_approval",
  stageRound: 1,
});
const rejected = blocker({
  id: "blk:E004:approval_rejected",
  employeeId: "E004",
  employeeName: "Logan Northcott",
  stageId: "manager_approval",
  kind: "approval_rejected",
  severity: "medium",
  ownerDepartment: "people_ops",
  subject: "apr:E004:manager_approval:1",
  detail: { approvalId: "apr:E004:manager_approval:1", checkpoint: "manager_approval", round: 1 },
  detectedAt: "2026-10-08T08:00:00.000Z",
  stageStatus: "revision_requested",
  stageRound: 1,
});
const costCenter = blocker({
  id: "blk:E005:data_issue",
  employeeId: "E005",
  employeeName: "Quinn Ortega",
  stageId: "intake",
  kind: "data_issue",
  severity: "high",
  ownerDepartment: "people_ops",
  subject: "hr.create-worker",
  detail: { field: "costCenter", system: "hr", operation: "hr.create-worker", class: "fatal", message: "costCenter must match CC-####" },
  detectedAt: "2026-10-08T11:00:00.000Z",
});
const tasksOverdue = blocker({
  id: "blk:E006:employee_task_overdue",
  employeeId: "E006",
  employeeName: "Rory Lane",
  stageId: "paperwork",
  kind: "employee_task_overdue",
  severity: "low",
  ownerDepartment: "people_ops",
  subject: "checklist:paperwork",
  detail: { taskIds: ["chk:E006:w4", "chk:E006:i9_section1"], count: 2 },
  detectedAt: "2026-10-08T07:00:00.000Z",
  stageStatus: "waiting_on_employee",
});
const closeout = blocker({
  id: "blk:E007:approval_overdue",
  employeeId: "E007",
  employeeName: "Sam Ito",
  stageId: "closeout",
  kind: "approval_overdue",
  severity: "medium",
  ownerDepartment: "people_ops",
  subject: "apr:E007:closeout:1",
  detail: { approvalId: "apr:E007:closeout:1", checkpoint: "closeout", round: 1, dueAt: "2026-10-07T10:00:00.000Z" },
  detectedAt: "2026-10-08T06:00:00.000Z",
  stageStatus: "awaiting_approval",
});
const peopleOpsQueue = [overdue, rejected, costCenter, tasksOverdue, closeout];

function serve(items: BlockerView[], tasks: TaskView[] = [], over: (url: string, method: string) => { status?: number; body?: unknown } | undefined = () => undefined) {
  return mockFetch((url, method) => {
    const r = over(url, method);
    if (r) return r;
    if (url.startsWith("/api/blockers")) {
      const kind = new URL(url, "http://x").searchParams.get("kind");
      return { body: { items: kind ? items.filter((b) => b.kind === kind) : items, nextCursor: null } };
    }
    if (url.startsWith("/api/followups")) return { body: { items: tasks, nextCursor: null } };
    if (url.startsWith("/api/employees/")) return { body: profile({ id: "E005" }) };
    if (method === "POST") return { status: 200, body: {} };
    return { body: { items: [], nextCursor: null } };
  });
}

const blockerGets = (calls: FetchCall[]) => calls.filter((c) => c.method === "GET" && c.url.startsWith("/api/blockers"));
const item = (name: string | RegExp) => screen.getByRole("listitem", { name });

describe("QueuePage", () => {
  it("renders one item per blocker with its follow-up, a case link and a plain title; orphan follow-ups are listed separately", async () => {
    serve(peopleOpsQueue, [followUp("fu:1", overdue.id, "Chase the manager approval for Wren Abara"), followUp("fu:9", "blk:gone", "Confirm the badge for Rory Lane")]);
    renderWith(<QueuePage />, { me: PERSONAS.peopleOps!, path: "/queue" });
    const wren = await screen.findByRole("listitem", { name: /Manager approval overdue/ });
    expect(within(wren).getByRole("link", { name: "Wren Abara" }).getAttribute("href")).toBe("/cases/E003");
    expect(within(wren).getByText(/Chase the manager approval for Wren Abara/)).toBeTruthy();
    expect(within(wren).getByRole("button", { name: /^Mark follow-up done for Wren Abara/ })).toBeTruthy();
    expect(within(wren).getByText("Marks your follow-up task done; it does not unblock the stage.")).toBeTruthy();
    expect(screen.getAllByRole("listitem", { name: /Manager approval overdue|rejected|rejected by|overdue/ }).length).toBeGreaterThanOrEqual(4);
    // the follow-up is not listed twice
    expect(screen.getAllByText(/Chase the manager approval for Wren Abara/)).toHaveLength(1);
    const other = screen.getByRole("region", { name: "other follow-ups" });
    expect(within(other).getByText("Confirm the badge for Rory Lane")).toBeTruthy();
    expect(within(other).queryByText(/Chase the manager approval/)).toBeNull();
  });

  it("titles every kind in plain words, without raw ids", async () => {
    serve([...peopleOpsQueue, blocker(), blocker({ id: "blk:E008:stalled", kind: "provisioning_stalled", severity: "medium", employeeName: "Ari Park", employeeId: "E008", subject: "it.order-device", detail: { system: "it", operation: "it.order-device", class: "stalled" } })]);
    renderWith(<QueuePage />, { me: PERSONAS.admin!, path: "/queue" });
    await screen.findByText("Manager approval overdue");
    for (const title of [
      "Manager approval overdue",
      "Manager approval rejected: revise and resubmit",
      "Cost center rejected by HR",
      "2 checklist tasks overdue",
      "People Ops sign-off overdue",
      "IT (simulated) could not order the device",
      "Device order stalled in IT (simulated)",
    ]) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    const titles = [...document.querySelectorAll(".queue-item .title")].map((t) => t.textContent ?? "");
    for (const t of titles) expect(t).not.toMatch(/apr:|blk:|Subject:|\w\.\w+-\w+|_/);
  });

  it("orders high severity first, then the oldest first", async () => {
    const newerHigh = blocker({ id: "blk:new", employeeName: "Newer High", employeeId: "E010", detectedAt: "2026-10-08T12:00:00.000Z" });
    const olderHigh = blocker({ id: "blk:old", employeeName: "Older High", employeeId: "E011", detectedAt: "2026-10-08T01:00:00.000Z" });
    serve([tasksOverdue, newerHigh, overdue, olderHigh]);
    renderWith(<QueuePage />, { me: PERSONAS.admin!, path: "/queue" });
    await screen.findByText("Older High");
    const names = [...document.querySelectorAll(".queue-item .item-main a")].map((a) => a.textContent);
    expect(names).toEqual(["Older High", "Newer High", "Wren Abara", "Rory Lane"]);
  });

  it("keeps the kind filter in the URL and sends it to the API; reload and back keep working", async () => {
    const calls = serve(peopleOpsQueue);
    const { router } = renderWith(<QueuePage />, { me: PERSONAS.peopleOps!, path: "/queue" });
    fireEvent.click(await screen.findByRole("button", { name: /^Approval overdue/ }));
    await waitFor(() => expect(router.state.location.search).toBe("?kind=approval_overdue"));
    await waitFor(() => expect(blockerGets(calls).some((c) => c.url === "/api/blockers?status=open&limit=100&kind=approval_overdue")).toBe(true));
    await waitFor(() => expect(document.querySelectorAll(".queue-item")).toHaveLength(2));
    expect(screen.getByRole("button", { name: /^Approval overdue/ }).getAttribute("aria-pressed")).toBe("true");
    await router.navigate(-1);
    await waitFor(() => expect(document.querySelectorAll(".queue-item")).toHaveLength(5));
    cleanup();
    // a reload of the filtered URL
    const again = serve(peopleOpsQueue);
    renderWith(<QueuePage />, { me: PERSONAS.peopleOps!, path: "/queue?kind=approval_overdue" });
    await waitFor(() => expect(document.querySelectorAll(".queue-item")).toHaveLength(2));
    expect(blockerGets(again).some((c) => c.url.endsWith("&kind=approval_overdue"))).toBe(true);
  });

  it("lets an admin pick a department, kept in the URL and sent to the API", async () => {
    const calls = serve([blocker()]);
    const { router } = renderWith(<QueuePage />, { me: PERSONAS.admin!, path: "/queue" });
    fireEvent.change(await screen.findByLabelText("Department"), { target: { value: "it" } });
    await waitFor(() => expect(router.state.location.search).toBe("?department=it"));
    await waitFor(() => expect(blockerGets(calls).some((c) => c.url === "/api/blockers?status=open&limit=100&department=it")).toBe(true));
    expect(calls.some((c) => c.url === "/api/followups?limit=100&department=it")).toBe(true);
    // a coordinator gets no department picker; the API forces their own department
    cleanup();
    serve([blocker()]);
    renderWith(<QueuePage />, { me: PERSONAS.it!, path: "/queue?department=people_ops" });
    await screen.findByText("IT (simulated) could not order the device");
    expect(screen.queryByLabelText("Department")).toBeNull();
  });

  it("offers the next action per kind", async () => {
    serve(peopleOpsQueue);
    renderWith(<QueuePage />, { me: PERSONAS.peopleOps!, path: "/queue" });
    await screen.findByText("Manager approval overdue");
    // approval_rejected: resubmit in Approvals, on that card; no Resolve (the agents resolve it on resubmit)
    const rej = item(/Manager approval rejected/);
    expect(within(rej).getByRole("link", { name: "Resubmit in Approvals for Logan Northcott" }).getAttribute("href")).toBe("/approvals#approval-apr%3AE004%3Amanager_approval%3A1");
    expect(within(rej).queryByRole("button", { name: /^Resolve/ })).toBeNull();
    // manager approval overdue: People Ops waits on the manager (no card to decide)
    const wait = item(/Manager approval overdue/);
    expect(within(wait).getByText("Waiting on the hiring manager")).toBeTruthy();
    expect(within(wait).queryByRole("link", { name: /Decide on behalf/ })).toBeNull();
    // closeout overdue: People Ops decides it in Approvals
    expect(within(item(/sign-off overdue/)).getByRole("link", { name: /Decide the sign-off in Approvals/ }).getAttribute("href")).toBe("/approvals#approval-apr%3AE007%3Acloseout%3A1");
    // data issue: the guided fix
    expect(within(item(/Cost center rejected by HR/)).getByLabelText("New cost center")).toBeTruthy();
    // employee tasks overdue: the case link
    expect(within(item(/checklist tasks overdue/)).getByRole("link", { name: "Rory Lane" }).getAttribute("href")).toBe("/cases/E006");
    cleanup();
    serve(peopleOpsQueue);
    renderWith(<QueuePage />, { me: PERSONAS.admin!, path: "/queue" });
    await screen.findByText("Manager approval overdue");
    expect(within(item(/Manager approval overdue/)).getByRole("link", { name: "Decide on behalf of the manager for Wren Abara" }).getAttribute("href")).toBe("/approvals#approval-apr%3AE003%3Amanager_approval%3A1");
  });

  it("asks for a reason before resolving, warns that the agents may reopen it, and sends the typed reason", async () => {
    const calls = serve([blocker()]);
    renderWith(<QueuePage />, { me: PERSONAS.it!, path: "/queue" });
    fireEvent.click(await screen.findByRole("button", { name: "Resolve: IT (simulated) could not order the device, Avery Abara" }));
    expect(screen.getByText("This closes the blocker only. If the condition still holds, the agents open it again.")).toBeTruthy();
    const submit = screen.getByRole("button", { name: "Resolve blocker" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason for resolving"), { target: { value: "   " } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason for resolving"), { target: { value: " Vendor fixed the device API " } });
    fireEvent.click(submit);
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe(`/api/blockers/${encodeURIComponent("blk:E001:it")}/resolve`);
    expect(post.body).toEqual({ resolution: "Vendor fixed the device API" });
  });

  it("disables Retry while the stage's retry is running, and says which round", async () => {
    serve([blocker({ stageStatus: "active", stageRound: 3 })]);
    renderWith(<QueuePage />, { me: PERSONAS.it!, path: "/queue" });
    const retry = (await screen.findByRole("button", { name: "Retry IT provisioning for Avery Abara" })) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.textContent).toBe("Retry running");
    expect(screen.getByText(": Retry running, round 3")).toBeTruthy();
    cleanup();
    serve([blocker({ stageStatus: "blocked", stageRound: 3 })]);
    renderWith(<QueuePage />, { me: PERSONAS.it!, path: "/queue" });
    expect(((await screen.findByRole("button", { name: "Retry IT provisioning for Avery Abara" })) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(": Blocked after round 3")).toBeTruthy();
  });

  it("refetches the queue when the ops hub publishes a new version", async () => {
    let items = [blocker()];
    const calls = mockFetch((url) => (url.startsWith("/api/blockers") ? { body: { items, nextCursor: null } } : { body: { items: [], nextCursor: null } }));
    renderWith(<QueuePage />, { me: PERSONAS.it!, path: "/queue" });
    await screen.findByText("IT (simulated) could not order the device");
    const before = blockerGets(calls).length;
    items = [blocker(), blocker({ id: "blk:E009", employeeId: "E009", employeeName: "Noor Haddad", detectedAt: "2026-10-08T11:30:00.000Z" })];
    expect(hub.onVersion).toBeTypeOf("function");
    hub.onVersion!(13);
    await screen.findByText("Noor Haddad");
    expect(blockerGets(calls).length).toBeGreaterThan(before);
  });

  it("loads the next page of blockers with the cursor", async () => {
    const calls = mockFetch((url) => {
      if (url.startsWith("/api/blockers")) {
        return url.includes("cursor=")
          ? { body: { items: [blocker({ id: "blk:p2", employeeId: "E120", employeeName: "Page Two" })], nextCursor: null } }
          : { body: { items: [blocker()], nextCursor: "YmxrOnAx" } };
      }
      return { body: { items: [], nextCursor: null } };
    });
    renderWith(<QueuePage />, { me: PERSONAS.it!, path: "/queue" });
    fireEvent.click(await screen.findByRole("button", { name: "Showing 1; load more" }));
    await screen.findByText("Page Two");
    expect(calls.some((c) => c.url === "/api/blockers?status=open&limit=100&cursor=YmxrOnAx")).toBe(true);
    expect(screen.queryByRole("button", { name: /load more/ })).toBeNull();
  });
});
