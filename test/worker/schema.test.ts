import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

const DB = env.DB;
const now = "2026-10-08T00:00:00.000Z";

async function tables(): Promise<string[]> {
  const r = await DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all<{ name: string }>();
  return r.results.map((x) => x.name);
}

// Fixture rows with ids outside the seed's E001..E150 / M01.. ranges.
beforeAll(async () => {
  await DB.batch([
    DB.prepare("INSERT INTO staff (id, email, display_name, kind, org_unit) VALUES ('MX1','mx1@onboardflow.test','Fixture Manager','manager','Engineering')"),
    DB.prepare(
      `INSERT INTO employees (id, email, first_name, last_name, job_title, org_unit, employment_type, work_mode, site, start_date,
        manager_id, equipment_profile, license_bundle, needs_privileged_access, cost_center, seed_version, updated_at)
       VALUES ('X901','x901@onboardflow.test','Fix','Ture','Engineer','Engineering','full_time','onsite','San Jose HQ','2026-11-02',
        'MX1','engineering','ft-engineering',0,'CC-1000','test',?)`,
    ).bind(now),
    DB.prepare("INSERT INTO cases (employee_id, status, updated_at) VALUES ('X901','not_started',?)").bind(now),
  ]);
});

describe("migrations", () => {
  it("create every table", async () => {
    expect(await tables()).toEqual(
      expect.arrayContaining([
        "stages",
        "task_templates",
        "staff",
        "employees",
        "app_users",
        "cases",
        "case_stages",
        "blockers",
        "tasks",
        "approvals",
        "provisioning_items",
        "integration_calls",
        "audit_events",
        "api_idempotency",
        "sim_idempotency",
        "sim_resources",
        "sim_side_effects",
        "sim_fault_plans",
        "sim_clock",
      ]),
    );
  });

  it("seed the 8 stages, 10 checklist templates and the sim clock row", async () => {
    expect((await DB.prepare("SELECT COUNT(*) AS n FROM stages").first<{ n: number }>())?.n).toBe(8);
    expect((await DB.prepare("SELECT COUNT(*) AS n FROM task_templates").first<{ n: number }>())?.n).toBe(10);
    // the migration inserts offset 0; the test setup then pins the simulated clock to the seed's reference date
    expect((await DB.prepare("SELECT COUNT(*) AS n FROM sim_clock WHERE id = 1").first<{ n: number }>())?.n).toBe(1);
  });

  it("enforce foreign keys", async () => {
    await expect(
      DB.prepare("INSERT INTO cases (employee_id, status, updated_at) VALUES ('NOPE','not_started',?)").bind(now).run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("enforce CHECK constraints on vocabularies", async () => {
    await expect(
      DB.prepare("INSERT INTO app_users (email, role, staff_id) VALUES ('bad@onboardflow.test','superuser','MX1')").run(),
    ).rejects.toThrow(/CHECK/);
    // employee role requires employee_id; non-employee roles require staff_id
    await expect(
      DB.prepare("INSERT INTO app_users (email, role, staff_id) VALUES ('bad2@onboardflow.test','employee','MX1')").run(),
    ).rejects.toThrow(/CHECK/);
  });
});

describe("audit_events is append-only", () => {
  it("allows INSERT and aborts UPDATE and DELETE", async () => {
    await DB.prepare(
      "INSERT INTO audit_events (id, occurred_at, actor_type, actor_id, action, entity_type, entity_id) VALUES ('t:1',?, 'system','test','case.started','case','X901')",
    )
      .bind(now)
      .run();
    await expect(DB.prepare("UPDATE audit_events SET action = 'x' WHERE id = 't:1'").run()).rejects.toThrow(
      /audit_events is append-only/,
    );
    await expect(DB.prepare("DELETE FROM audit_events WHERE id = 't:1'").run()).rejects.toThrow(
      /audit_events is append-only/,
    );
    expect(await DB.prepare("SELECT action FROM audit_events WHERE id = 't:1'").first()).toEqual({ action: "case.started" });
  });

  it("INSERT OR IGNORE with a duplicate id keeps one row", async () => {
    const ins = () =>
      DB.prepare(
        "INSERT OR IGNORE INTO audit_events (id, occurred_at, actor_type, actor_id, action, entity_type, entity_id) VALUES ('t:dup',?, 'system','test','case.started','case','X901')",
      )
        .bind(now)
        .run();
    await ins();
    const second = await ins();
    expect(second.meta.changes).toBe(0);
    expect((await DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE id = 't:dup'").first<{ n: number }>())?.n).toBe(1);
  });
});

describe("partial unique indexes", () => {
  const blocker = (id: string, status: string) =>
    DB.prepare(
      `INSERT INTO blockers (id, employee_id, stage_id, kind, severity, owner_department, subject, dedupe_key, status, detail_json, detected_at)
       VALUES (?, 'X901', 'it_provisioning', 'integration_outage', 'high', 'it', 'it.order-device', 'X901:integration_outage:it_provisioning:it.order-device', ?, '{}', ?)`,
    ).bind(id, status, now);

  it("admit one open blocker per dedupe key, and any number of resolved ones", async () => {
    await blocker("blk:a", "open").run();
    await expect(blocker("blk:b", "open").run()).rejects.toThrow(/UNIQUE/);
    const ignored = await DB.prepare(
      `INSERT OR IGNORE INTO blockers (id, employee_id, stage_id, kind, severity, owner_department, subject, dedupe_key, status, detail_json, detected_at)
       VALUES ('blk:c', 'X901', 'it_provisioning', 'integration_outage', 'high', 'it', 'it.order-device', 'X901:integration_outage:it_provisioning:it.order-device', 'open', '{}', ?)`,
    )
      .bind(now)
      .run();
    expect(ignored.meta.changes).toBe(0);
    await DB.prepare("UPDATE blockers SET status = 'resolved' WHERE id = 'blk:a'").run();
    await blocker("blk:d", "open").run();
    await blocker("blk:e", "resolved").run();
    const open = await DB.prepare("SELECT id FROM blockers WHERE status = 'open'").all();
    expect(open.results).toEqual([{ id: "blk:d" }]);
  });

  it("admit one pending approval per employee and checkpoint", async () => {
    const approval = (id: string, round: number, status: string) =>
      DB.prepare(
        `INSERT INTO approvals (id, employee_id, stage_id, checkpoint, round, approver_role, approver_staff_id, status, request_json, requested_at, due_at)
         VALUES (?, 'X901', 'manager_approval', 'manager_approval', ?, 'manager', 'MX1', ?, '{}', ?, ?)`,
      ).bind(id, round, status, now, now);
    await approval("apr:X901:manager_approval:1", 1, "pending").run();
    await expect(approval("apr:X901:manager_approval:2", 2, "pending").run()).rejects.toThrow(/UNIQUE/);
    await DB.prepare("UPDATE approvals SET status = 'rejected' WHERE id = 'apr:X901:manager_approval:1'").run();
    await approval("apr:X901:manager_approval:2", 2, "pending").run();
    // a pending closeout approval is independent of the manager checkpoint
    await DB.prepare(
      `INSERT INTO approvals (id, employee_id, stage_id, checkpoint, round, approver_role, status, request_json, requested_at, due_at)
       VALUES ('apr:X901:closeout:1', 'X901', 'closeout', 'closeout', 1, 'coordinator', 'pending', '{}', ?, ?)`,
    )
      .bind(now, now)
      .run();
    const pending = await DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").first<{ n: number }>();
    expect(pending?.n).toBe(2);
  });
});
