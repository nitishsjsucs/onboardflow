// Who acts on a blocked case, as the dashboard (the hub's stage rollup) and My
// team (the employees list) read it from D1: the owner of the open blocker the
// stage is blocked by, picked in SQL with BLOCKING_BLOCKER_ORDER. The case page
// picks it in TypeScript with blockingBlocker; these tests set up cases whose
// pick depends on every part of that order and check the two agree.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { EmployeeSummarySchema, HubStateSchema, page } from "../../src/shared/api.ts";
import type { BlockerKind } from "../../src/shared/domain.ts";
import type { Department } from "../../src/shared/roles.ts";
import type { StageId } from "../../src/shared/stages.ts";
import { blockingBlocker } from "../../src/shared/who-acts.ts";
import { api } from "../helpers/api.ts";
import { managerOf } from "../helpers/workflow.ts";

const DB = env.DB;

type Blocker = { kind: BlockerKind; owner: Department; at: string; status?: "open" | "resolved"; stage?: StageId; id?: string };

/** Puts a case in a status at a stage with that stage's status, and inserts its blockers. */
async function setCase(employeeId: string, caseStatus: string, stage: StageId, stageStatus: string, blockers: Blocker[]) {
  const stmts = [
    DB.prepare("UPDATE cases SET status = ?, current_stage = ? WHERE employee_id = ?").bind(caseStatus, stage, employeeId),
    DB.prepare("UPDATE case_stages SET status = ? WHERE employee_id = ? AND stage_id = ?").bind(stageStatus, employeeId, stage),
  ];
  blockers.forEach((b, i) => {
    const at = b.stage ?? stage;
    const subject = `s${i}`;
    const dedupe = `${employeeId}:${b.kind}:${at}:${subject}`;
    stmts.push(
      DB.prepare(
        `INSERT INTO blockers (id, employee_id, stage_id, kind, severity, owner_department, subject, dedupe_key, status, detail_json, detected_at)
         VALUES (?, ?, ?, ?, 'high', ?, ?, ?, ?, '{}', ?)`,
      ).bind(b.id ?? `blk:${dedupe}:${i}`, employeeId, at, b.kind, b.owner, subject, dedupe, b.status ?? "open", b.at),
    );
  });
  await DB.batch(stmts);
}

const T = (h: number) => `2026-10-08T${String(h).padStart(2, "0")}:00:00.000Z`;

beforeAll(async () => {
  // the demo's cross-system check: an HR outage, People Ops' blocker; a resolved IT data issue from before is ignored
  await setCase("E046", "blocked", "provisioning_verification", "blocked", [
    { kind: "data_issue", owner: "it", at: T(1), status: "resolved" },
    { kind: "integration_outage", owner: "people_ops", at: T(2) },
  ]);
  // an IT outage stays open beside the People Ops data issue a later retry hit: the data issue blocks now
  await setCase("E047", "blocked", "it_provisioning", "blocked", [
    { kind: "integration_outage", owner: "it", at: T(3) },
    { kind: "data_issue", owner: "people_ops", at: T(4) },
  ]);
  // blocked, but the scan has not opened its blocker yet
  await setCase("E048", "blocked", "it_provisioning", "blocked", []);
  // two outages at one stage: the earliest, then (same time) the lower id in byte order
  await setCase("E049", "blocked", "facilities_setup", "blocked", [
    { kind: "integration_outage", owner: "it", at: T(6) },
    { kind: "provisioning_stalled", owner: "facilities", at: T(5), id: "blk:b" },
    { kind: "integration_outage", owner: "people_ops", at: T(5), id: "blk:a" },
  ]);
  // a revision: blocked case, revision_requested stage, People Ops' rejection blocker
  await setCase("E050", "blocked", "manager_approval", "revision_requested", [{ kind: "approval_rejected", owner: "people_ops", at: T(7) }]);
  // not blocked: an overdue approval's blocker is not who a blocked stage waits on
  await setCase("E051", "awaiting_approval", "manager_approval", "awaiting_approval", [{ kind: "approval_overdue", owner: "people_ops", at: T(8) }]);
  // an open blocker at an earlier stage than the blocked one does not count for it
  await setCase("E052", "blocked", "facilities_setup", "blocked", [
    { kind: "integration_outage", owner: "it", at: T(1), stage: "it_provisioning" },
    { kind: "integration_outage", owner: "facilities", at: T(9) },
  ]);
});

/** blockingBlocker's pick for an employee's current stage, from the same D1 rows. */
async function pickInTs(employeeId: string): Promise<Department | null> {
  const c = await DB.prepare("SELECT current_stage FROM cases WHERE employee_id = ?").bind(employeeId).first<{ current_stage: StageId }>();
  const rows = await DB.prepare("SELECT id, kind, owner_department, detected_at FROM blockers WHERE employee_id = ? AND stage_id = ? AND status = 'open'")
    .bind(employeeId, c!.current_stage)
    .all<{ id: string; kind: BlockerKind; owner_department: Department; detected_at: string }>();
  return blockingBlocker(rows.results.map((r) => ({ id: r.id, kind: r.kind, detectedAt: r.detected_at, owner: r.owner_department })))?.owner ?? null;
}

describe("who acts on a blocked case, read from D1", () => {
  it("the employees list names the owner of the blocker each blocked case's stage is blocked by", async () => {
    const first = page(EmployeeSummarySchema).parse((await api("/api/employees?limit=100", { as: "A01" })).body);
    const second = page(EmployeeSummarySchema).parse((await api(`/api/employees?limit=100&cursor=${first.nextCursor}`, { as: "A01" })).body);
    const owner = new Map([...first.items, ...second.items].map((e) => [e.id, e.blockerOwner]));
    expect(owner.size).toBe(150);
    expect(Object.fromEntries(["E046", "E047", "E048", "E049", "E050", "E051", "E052", "E053"].map((id) => [id, owner.get(id)]))).toEqual({
      E046: "people_ops",
      E047: "people_ops",
      E048: null,
      E049: "people_ops",
      E050: "people_ops",
      E051: null,
      E052: "facilities",
      E053: null,
    });
    for (const id of ["E046", "E047", "E048", "E049", "E050", "E052"]) expect(owner.get(id), id).toBe(await pickInTs(id));
  });

  it("a manager's list carries it for their own reports only, as before", async () => {
    const m = await managerOf("E046");
    const mine = page(EmployeeSummarySchema).parse((await api("/api/employees?limit=100", { as: m })).body);
    expect(mine.items.every((e) => e.managerId === m)).toBe(true);
    expect(mine.items.find((e) => e.id === "E046")?.blockerOwner).toBe("people_ops");
  });

  it("the hub's stage rollup counts each stage's blocked cases by that owner", async () => {
    const hub = HubStateSchema.parse((await api("/api/dashboard/summary", { as: "C03" })).body);
    const at = (s: StageId) => hub.byStage.find((r) => r.stage === s)!;
    expect(at("provisioning_verification")).toMatchObject({ blocked: 1, blockedBy: { people_ops: 1, it: 0, facilities: 0 } });
    // E047 (People Ops' data issue) and E048 (no blocker yet: in `blocked` only)
    expect(at("it_provisioning")).toMatchObject({ blocked: 2, blockedBy: { people_ops: 1, it: 0, facilities: 0 } });
    // E049 (the earliest, lower id: People Ops) and E052 (Facilities; its open IT blocker is at another stage)
    expect(at("facilities_setup")).toMatchObject({ blocked: 2, blockedBy: { people_ops: 1, it: 0, facilities: 1 } });
    // a revision is not a blocked stage, and an overdue approval waits on a decision
    expect(at("manager_approval")).toMatchObject({ blocked: 0, waiting: 1, awaitingApproval: 1, blockedBy: { people_ops: 0, it: 0, facilities: 0 } });
    for (const r of hub.byStage) expect(r.blockedBy.people_ops + r.blockedBy.it + r.blockedBy.facilities, r.stage).toBeLessThanOrEqual(r.blocked);
  });
});
