import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BlockerView, IntegrationCallView, MeDto } from "../../src/shared/api.ts";
import { attemptsSentence, closeoutRoundBase, roundOfStep, roundsReadout, stageAttempts } from "../../src/web/components/rounds.ts";
import { CaseDetailPage } from "../../src/web/pages/CaseDetailPage.tsx";
import { QueuePage } from "../../src/web/pages/QueuePage.tsx";
import { approval, blocker, caseDetail, profile } from "./fixtures.ts";
import { mockFetch, PERSONAS, renderWith } from "./harness.tsx";

vi.mock("../../src/web/live/useHubLive.ts", () => ({ useHubLive: () => ({ state: null, status: "connected" }) }));
vi.mock("../../src/web/live/useCaseLive.ts", () => ({ useCaseLive: () => ({ state: null, status: "connected" }) }));

afterEach(cleanup);

const LIMITS = { maxStageRounds: 4, maxRecoveryRounds: 6 };
const withLimits = (p: MeDto): MeDto => ({ ...p, limits: LIMITS });

function call(stepName: string, over: Partial<IntegrationCallView> = {}): IntegrationCallView {
  return {
    id: `onb-E001-1:1:${stepName}:${over.attempt ?? 1}`,
    runNo: 1,
    stepName,
    system: "it",
    operation: "it.create-account",
    method: "POST",
    path: "/sim/it/accounts",
    idempotencyKey: "E001:it.create-account",
    attempt: 1,
    httpStatus: 503,
    outcome: "retryable_error",
    retryAfterMs: null,
    latencyMs: 4,
    error: "service unavailable",
    createdAt: "2026-10-08T12:00:00.000Z",
    ...over,
  };
}

describe("roundsReadout", () => {
  const blocked = (round: number, roundBase?: number) => roundsReadout({ stageStatus: "blocked", stageRound: round, maxStageRounds: 4, ...(roundBase ? { roundBase } : {}) });

  it("counts the rounds a blocked stage used and says how many retries are left at most", () => {
    expect(blocked(1)).toMatchObject({ used: 1, left: 3, next: 2, lastRetry: false, text: "Round 1 of 4 used on this stage. At most 3 more retries: if round 4 fails, the workflow fails the case." });
    expect(blocked(2)!.text).toBe("Round 2 of 4 used on this stage. At most 2 more retries: if round 4 fails, the workflow fails the case.");
    expect(blocked(3)).toMatchObject({ used: 3, left: 1, next: 4, lastRetry: true, text: "Round 3 of 4 used. The next retry is the last: if round 4 fails, the workflow fails the case." });
  });

  it("says which round is running, and counts closeout's rounds from its approved sign-off", () => {
    expect(roundsReadout({ stageStatus: "active", stageRound: 3, maxStageRounds: 4 })).toMatchObject({ used: 3, running: true, lastRetry: false, text: "Round 3 of 4 running." });
    // sign-off approved in round 2, activation blocked in round 3: two of its rounds are used
    expect(blocked(3, 2)).toMatchObject({ used: 2, left: 2, next: 3 });
    expect(closeoutRoundBase([approval({ checkpoint: "closeout", status: "rejected", round: 1 }), approval({ checkpoint: "closeout", status: "approved", round: 2 }), approval({ checkpoint: "manager_approval", status: "approved", round: 3 })])).toBe(2);
    expect(closeoutRoundBase([approval({ checkpoint: "closeout", status: "pending", round: 1 })])).toBeNull();
  });

  it("says nothing without limits, for a stage that is not blocked or running, or below its base", () => {
    expect(roundsReadout({ stageStatus: "blocked", stageRound: 2, maxStageRounds: undefined })).toBeNull();
    expect(roundsReadout({ stageStatus: "waiting_on_employee", stageRound: 1, maxStageRounds: 4 })).toBeNull();
    expect(roundsReadout({ stageStatus: "blocked", stageRound: null, maxStageRounds: 4 })).toBeNull();
    expect(roundsReadout({ stageStatus: "blocked", stageRound: 1, roundBase: 2, maxStageRounds: 4 })).toBeNull();
  });
});

describe("a stage's attempts from the call log", () => {
  it("groups the stage's calls in the latest run by the round in the step name", () => {
    expect(roundOfStep("it_provisioning.it.create-account#r2")).toBe(2);
    expect(roundOfStep("it_provisioning.poll-it_device#r3.4")).toBe(3);
    const calls = [
      call("it_provisioning.it.create-account#r1"),
      call("it_provisioning.it.create-account#r2", { attempt: 1 }),
      call("it_provisioning.it.create-account#r2", { attempt: 2 }),
      call("facilities_setup.facilities.assign-workspace#r5"),
      call("it_provisioning.it.create-account#r9", { runNo: 0 }),
    ];
    const latest = stageAttempts(calls, "it_provisioning")!;
    expect(latest.round).toBe(2);
    expect(latest.calls.map((c) => c.attempt)).toEqual([1, 2]);
    expect(stageAttempts(calls, "closeout")).toBeNull();
  });

  it("sums a round up in words: all failed, mixed, all ok", () => {
    const at = (m: number) => new Date(2026, 9, 8, 12, m).toISOString();
    const failed = [1, 2, 3, 4, 5].map((n) => call("it_provisioning.it.create-account#r2", { attempt: n, createdAt: at(n) }));
    expect(attemptsSentence(2, failed)).toBe("Round 2: 5 attempts, all failed with HTTP 503 from IT (simulated); last Oct 8, 12:05.");
    const mixed = [call("x#r1", { createdAt: at(1) }), call("x#r1", { outcome: "ok", httpStatus: 201, createdAt: at(2) })];
    expect(attemptsSentence(1, mixed)).toBe("Round 1: 2 attempts, 1 ok, 1 failed; last Oct 8, 12:02.");
    expect(attemptsSentence(1, [call("x#r1", { outcome: "ok", httpStatus: 200, createdAt: at(0) })])).toBe("Round 1: 1 attempt, all ok; last Oct 8, 12:00.");
  });
});

/** The queue with one IT outage blocker (E001, IT provisioning), and a call log for Show attempts. */
function serveQueue(items: BlockerView[], log: () => { status?: number; body?: unknown } = () => ({ body: { items: [call("it_provisioning.it.create-account#r1")], nextCursor: null } })) {
  return mockFetch((url) => {
    if (url.startsWith("/api/blockers")) return { body: { items, nextCursor: null } };
    if (url.includes("/integrations")) return log();
    if (url.startsWith("/api/employees/")) return { body: profile({ id: "E005" }) };
    return { body: { items: [], nextCursor: null } };
  });
}

describe("rounds in the queue", () => {
  it("reads the rounds used above Retry stage, and Retry points at that text", async () => {
    serveQueue([blocker({ stageRound: 1 })]);
    renderWith(<QueuePage />, { me: withLimits(PERSONAS.it!), path: "/queue" });
    const retry = await screen.findByRole("button", { name: "Retry stage: IT provisioning for Avery Abara" });
    const text = "Round 1 of 4 used on this stage. At most 3 more retries: if round 4 fails, the workflow fails the case.";
    expect(document.getElementById(retry.getAttribute("aria-describedby")!)!.textContent).toBe(text);
    // the pips are decoration: one per allowed round, the last one marked
    const pips = retry.closest("li")!.querySelector(".pips")!;
    expect(pips.getAttribute("aria-hidden")).toBe("true");
    expect(pips.querySelectorAll(".pip")).toHaveLength(4);
    expect(pips.querySelectorAll(".pip.used")).toHaveLength(1);
    expect(pips.querySelectorAll(".pip.last")).toHaveLength(1);
  });

  it("labels the last retry, and its accessible name starts with that label", async () => {
    serveQueue([blocker({ stageRound: 3 })]);
    renderWith(<QueuePage />, { me: withLimits(PERSONAS.it!), path: "/queue" });
    const retry = await screen.findByRole("button", { name: "Retry stage (last round): IT provisioning for Avery Abara" });
    expect(retry.textContent).toBe("Retry stage (last round)");
    expect(within(retry.closest("li")!).getByText("Round 3 of 4 used. The next retry is the last: if round 4 fails, the workflow fails the case.")).toBeTruthy();
  });

  it("shows no meter without limits, nor on a closeout item, which points to the case page", async () => {
    serveQueue([blocker({ stageRound: 2 })]);
    renderWith(<QueuePage />, { me: PERSONAS.it!, path: "/queue" });
    const retry = await screen.findByRole("button", { name: "Retry stage: IT provisioning for Avery Abara" });
    expect(retry.getAttribute("aria-describedby")).toBeNull();
    cleanup();
    serveQueue([blocker({ stageId: "closeout", ownerDepartment: "people_ops", subject: "hr.activate-worker", detail: { system: "hr", operation: "hr.activate-worker", message: "service unavailable" }, stageRound: 3 })]);
    renderWith(<QueuePage />, { me: withLimits(PERSONAS.peopleOps!), path: "/queue" });
    const item = (await screen.findByRole("button", { name: "Retry stage: People Ops sign-off for Avery Abara" })).closest("li")!;
    expect(item.querySelector(".pips")).toBeNull();
    expect(within(item).getByText(/Rounds for the sign-off stage:/)).toBeTruthy();
    expect(within(item).getByRole("link", { name: "see the case page" }).getAttribute("href")).toBe("/cases/E001");
  });

  it("names the round a data issue's early retry would use", async () => {
    serveQueue([
      blocker({
        id: "blk:E005:data_issue",
        employeeId: "E005",
        employeeName: "Quinn Ortega",
        stageId: "intake",
        kind: "data_issue",
        ownerDepartment: "people_ops",
        subject: "hr.create-worker",
        detail: { field: "costCenter", system: "hr", operation: "hr.create-worker", class: "fatal", message: "costCenter must match CC-####" },
        stageRound: 2,
      }),
    ]);
    renderWith(<QueuePage />, { me: withLimits(PERSONAS.peopleOps!), path: "/queue" });
    const retry = await screen.findByRole("button", { name: "Retry Pre-boarding intake for Quinn Ortega" });
    const described = retry.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)!.textContent);
    expect(described).toEqual([
      "Round 2 of 4 used on this stage. At most 2 more retries: if round 4 fails, the workflow fails the case.",
      "Fix the cost center first, or the retry fails again and uses round 3 of 4.",
    ]);
  });

  it("fetches the attempts only when Show attempts opens, once, and lists the latest round's", async () => {
    const at = (m: number) => new Date(2026, 9, 8, 12, m).toISOString();
    const calls = serveQueue([blocker({ stageRound: 2 })], () => ({
      body: {
        items: [call("intake.hr.create-worker#r1", { system: "hr", outcome: "ok", httpStatus: 201 }), call("it_provisioning.it.create-account#r1", { createdAt: at(1) }), ...[1, 2, 3].map((n) => call("it_provisioning.it.create-account#r2", { attempt: n, createdAt: at(n + 1) }))],
        nextCursor: null,
      },
    }));
    renderWith(<QueuePage />, { me: withLimits(PERSONAS.it!), path: "/queue" });
    const show = await screen.findByRole("button", { name: "Show attempts: IT provisioning for Avery Abara" });
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.filter((c) => c.url.includes("/integrations"))).toHaveLength(0);
    expect(show.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(show);
    expect(show.getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(show.getAttribute("aria-controls")!)!;
    expect(await within(panel).findByText("Round 2: 3 attempts, all failed with HTTP 503 from IT (simulated); last Oct 8, 12:04.")).toBeTruthy();
    const attempts = within(panel).getByRole("list", { name: "Round 2 attempts" });
    expect(within(attempts).getAllByRole("listitem").map((li) => li.textContent)).toEqual([" 1: failed 503", " 2: failed 503", " 3: failed 503"]);
    expect(within(panel).getByText(/A case also allows at most 6 recovery rounds per run across all stages\./)).toBeTruthy();
    expect(within(panel).getByRole("link", { name: "Full call log" }).getAttribute("href")).toBe("/integrations?case=E001&window=all");
    expect(calls.filter((c) => c.url.includes("/integrations")).map((c) => c.url)).toEqual(["/api/cases/E001/integrations?limit=100"]);
  });

  it("says when the stage has no calls, and offers Try again when the log cannot load", async () => {
    serveQueue([blocker()], () => ({ body: { items: [], nextCursor: null } }));
    renderWith(<QueuePage />, { me: withLimits(PERSONAS.it!), path: "/queue" });
    fireEvent.click(await screen.findByRole("button", { name: /^Show attempts/ }));
    expect(await screen.findByText("No calls recorded for this stage.")).toBeTruthy();
    cleanup();
    let n = 0;
    serveQueue([blocker()], () => (++n === 1 ? { status: 503, body: { error: { code: "unavailable", message: "try later", requestId: "r-2" } } } : { body: { items: [call("it_provisioning.it.create-account#r1")], nextCursor: null } }));
    renderWith(<QueuePage />, { me: withLimits(PERSONAS.it!), path: "/queue" });
    fireEvent.click(await screen.findByRole("button", { name: /^Show attempts/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not load the attempts.");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/^Round 1: 1 attempt, all failed with HTTP 503/)).toBeTruthy();
  });

  it("follows the log's pages up to 500 calls and says when it stops there", async () => {
    let page = 0;
    const calls = serveQueue([blocker()], () => {
      page++;
      return { body: { items: [call(`it_provisioning.it.create-account#r${page}`, { id: `c${page}` })], nextCursor: `p${page}` } };
    });
    renderWith(<QueuePage />, { me: withLimits(PERSONAS.it!), path: "/queue" });
    fireEvent.click(await screen.findByRole("button", { name: /^Show attempts/ }));
    expect(await screen.findByText(/^Showing the first 500 calls\./)).toBeTruthy();
    await waitFor(() => expect(calls.filter((c) => c.url.includes("/integrations"))).toHaveLength(5));
    expect(screen.getByText(/^Round 5: 1 attempt/)).toBeTruthy();
  });
});

describe("rounds on the case page", () => {
  it("counts a blocked closeout's rounds from the round its sign-off was approved in", async () => {
    const d = caseDetail(null);
    const stages = d.stages.map((s) =>
      s.id === "closeout" ? { ...s, status: "blocked" as const, round: 3, blockedReason: { class: "retryable", system: "hr", operation: "hr.activate-worker", message: "service_unavailable" } } : { ...s, status: "complete" as const },
    );
    const detail = {
      ...d,
      case: { ...d.case, status: "blocked" as const, currentStage: "closeout" as const },
      stages,
      approvals: [approval({ status: "approved" }), approval({ id: "apr:E001:closeout:1", checkpoint: "closeout", stageId: "closeout", status: "rejected", round: 1 }), approval({ id: "apr:E001:closeout:2", checkpoint: "closeout", stageId: "closeout", status: "approved", round: 2 })],
    };
    mockFetch((url) => (url.includes("/audit") ? { body: { items: [], nextCursor: null } } : { body: detail }));
    renderWith(<CaseDetailPage />, { me: withLimits(PERSONAS.peopleOps!), path: "/cases/E001", routes: [{ path: "/cases/:id", element: <CaseDetailPage /> }] });
    const retry = await screen.findByRole("button", { name: "Retry People Ops sign-off for Avery Abara" });
    expect(document.getElementById(retry.getAttribute("aria-describedby")!)!.textContent).toBe("Round 2 of 4 used on this stage. At most 2 more retries: if round 4 fails, the workflow fails the case.");
    expect(screen.getByRole("button", { name: "Show attempts: People Ops sign-off for Avery Abara" })).toBeTruthy();
  });

  it("labels the last retry of an IT stage on the case page", async () => {
    const d = caseDetail("it_provisioning");
    const detail = { ...d, stages: d.stages.map((s) => (s.id === "it_provisioning" ? { ...s, round: 3 } : s)) };
    mockFetch((url) => (url.includes("/audit") ? { body: { items: [], nextCursor: null } } : { body: detail }));
    renderWith(<CaseDetailPage />, { me: withLimits(PERSONAS.it!), path: "/cases/E001", routes: [{ path: "/cases/:id", element: <CaseDetailPage /> }] });
    const retry = await screen.findByRole("button", { name: "Retry IT provisioning (last round) for Avery Abara" });
    expect(retry.textContent).toBe("Retry IT provisioning (last round)");
  });
});
