import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ROLES } from "../../src/shared/roles.ts";

const n = async (sql: string) => (await env.DB.prepare(sql).first<{ n: number }>())?.n;

describe("seed load", () => {
  it("loads 150 employees, 26 staff, 176 users", async () => {
    expect(await n("SELECT COUNT(*) AS n FROM employees")).toBe(150);
    expect(await n("SELECT COUNT(*) AS n FROM staff")).toBe(26);
    expect(await n("SELECT COUNT(*) AS n FROM app_users")).toBe(176);
  });

  it("creates 150 not_started cases and 1,200 pending case stages", async () => {
    expect(await n("SELECT COUNT(*) AS n FROM cases WHERE status = 'not_started' AND workflow_instance_id IS NULL")).toBe(150);
    expect(await n("SELECT COUNT(*) AS n FROM case_stages WHERE status = 'pending' AND round = 1")).toBe(1200);
    expect(await n("SELECT COUNT(DISTINCT employee_id) AS n FROM case_stages")).toBe(150);
  });

  it("gives every employee a manager", async () => {
    expect(
      await n("SELECT COUNT(*) AS n FROM employees e JOIN staff s ON s.id = e.manager_id AND s.kind = 'manager'"),
    ).toBe(150);
  });

  it("uses exactly the 4 roles", async () => {
    const r = await env.DB.prepare("SELECT DISTINCT role FROM app_users ORDER BY role").all<{ role: string }>();
    expect(r.results.map((x) => x.role).sort()).toEqual([...ROLES].sort());
  });
});
