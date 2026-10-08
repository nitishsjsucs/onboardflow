import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROLES } from "../../src/shared/roles.ts";
import { generateDataset, type SyntheticEmployee } from "../../src/shared/synthetic/generate.ts";
import { EMPLOYMENT_BY_ORG, ORG_UNIT_COUNTS, ORG_UNITS } from "../../src/shared/synthetic/pools.ts";
import { datasetToSql, MAX_ROWS_PER_INSERT } from "../../src/shared/synthetic/to-sql.ts";
import { buildSeed } from "../../scripts/seed.ts";

const d = generateDataset(20261008);
const E = d.employees;

function count(pred: (e: SyntheticEmployee) => boolean): number {
  return E.filter(pred).length;
}

describe("generateDataset(20261008)", () => {
  it("produces exact people and user counts with exactly 4 roles", () => {
    expect(E).toHaveLength(150);
    expect(d.staff.filter((s) => s.kind === "manager")).toHaveLength(18);
    const coords = d.staff.filter((s) => s.kind === "coordinator");
    expect(coords).toHaveLength(6);
    expect(coords.filter((c) => c.department === "people_ops")).toHaveLength(2);
    expect(coords.filter((c) => c.department === "it")).toHaveLength(2);
    expect(coords.filter((c) => c.department === "facilities")).toHaveLength(2);
    expect(d.staff.filter((s) => s.kind === "admin")).toHaveLength(2);
    expect(d.users).toHaveLength(176);
    expect(new Set(d.users.map((u) => u.role))).toEqual(new Set(ROLES));
    expect(E.map((e) => e.id)).toEqual(Array.from({ length: 150 }, (_, i) => `E${String(i + 1).padStart(3, "0")}`));
  });

  it("matches the org unit marginal and the org unit x employment joint table exactly", () => {
    for (const org of ORG_UNITS) {
      expect(count((e) => e.orgUnit === org)).toBe(ORG_UNIT_COUNTS[org]);
      for (const [type, n] of Object.entries(EMPLOYMENT_BY_ORG[org])) {
        expect(count((e) => e.orgUnit === org && e.employmentType === type), `${org}|${type}`).toBe(n);
      }
    }
    expect(count((e) => e.employmentType === "full_time")).toBe(120);
    expect(count((e) => e.employmentType === "contractor")).toBe(18);
    expect(count((e) => e.employmentType === "intern")).toBe(12);
  });

  it("matches work mode counts, and remote iff Remote (US); offices round-robin", () => {
    expect(count((e) => e.workMode === "onsite")).toBe(60);
    expect(count((e) => e.workMode === "hybrid")).toBe(54);
    expect(count((e) => e.workMode === "remote")).toBe(36);
    for (const e of E) expect(e.workMode === "remote").toBe(e.site === "Remote (US)");
    const offices = E.filter((e) => e.workMode !== "remote").map((e) => e.site);
    offices.forEach((s, i) => expect(s).toBe(["San Jose HQ", "Austin", "New York"][i % 3]));
  });

  it("assigns 10 weekly Monday cohorts of 15 from the anchor", () => {
    const byDate = new Map<string, number>();
    for (const e of E) byDate.set(e.startDate, (byDate.get(e.startDate) ?? 0) + 1);
    expect([...byDate.keys()].sort()).toEqual([
      "2026-11-02",
      "2026-11-09",
      "2026-11-16",
      "2026-11-23",
      "2026-11-30",
      "2026-12-07",
      "2026-12-14",
      "2026-12-21",
      "2026-12-28",
      "2027-01-04",
    ]);
    for (const n of byDate.values()) expect(n).toBe(15);
    for (const e of E) expect(new Date(`${e.startDate}T00:00:00Z`).getUTCDay()).toBe(1);
  });

  it("derives equipment: engineering for all Engineering, design only in Marketing (exactly 6)", () => {
    expect(count((e) => e.equipmentProfile === "engineering")).toBe(54);
    expect(count((e) => e.equipmentProfile === "engineering" && e.orgUnit !== "Engineering")).toBe(0);
    expect(count((e) => e.equipmentProfile === "design")).toBe(6);
    expect(count((e) => e.equipmentProfile === "design" && e.orgUnit !== "Marketing")).toBe(0);
    expect(count((e) => e.equipmentProfile === "standard")).toBe(90);
  });

  it("derives license bundles from org unit and employment type", () => {
    expect(count((e) => e.licenseBundle === "ft-engineering")).toBe(40);
    expect(count((e) => e.licenseBundle === "ft-standard")).toBe(80);
    expect(count((e) => e.licenseBundle === "contractor-basic")).toBe(18);
    expect(count((e) => e.licenseBundle === "intern-basic")).toBe(12);
    for (const e of E) {
      if (e.licenseBundle === "ft-engineering") expect([e.orgUnit, e.employmentType]).toEqual(["Engineering", "full_time"]);
      if (e.employmentType === "contractor") expect(e.licenseBundle).toBe("contractor-basic");
      if (e.employmentType === "intern") expect(e.licenseBundle).toBe("intern-basic");
    }
  });

  it("grants privileged access to exactly 21, only full-time Engineering", () => {
    expect(count((e) => e.needsPrivilegedAccess)).toBe(21);
    expect(count((e) => e.needsPrivilegedAccess && !(e.orgUnit === "Engineering" && e.employmentType === "full_time"))).toBe(0);
  });

  it("gives every employee a valid cost center and a manager in the same org unit, round-robin", () => {
    const managers = new Map(d.staff.filter((s) => s.kind === "manager").map((m) => [m.id, m]));
    for (const e of E) {
      expect(e.costCenter).toMatch(/^CC-\d{4}$/);
      const m = managers.get(e.managerId);
      expect(m?.orgUnit).toBe(e.orgUnit);
    }
    const reports = new Map<string, number>();
    for (const e of E) reports.set(e.managerId, (reports.get(e.managerId) ?? 0) + 1);
    expect(reports.get("M01")).toBe(9); // 54 engineers over 6 managers
    expect(reports.get("M17")).toBe(12); // Operations has one manager
    expect(reports.size).toBe(18);
  });

  it("uses unique emails on the reserved onboardflow.test domain", () => {
    const emails = d.users.map((u) => u.email);
    expect(new Set(emails).size).toBe(176);
    for (const email of emails) expect(email).toMatch(/^[a-z0-9.]+@onboardflow\.test$/);
    expect(E[41]?.email).toMatch(/\.e042@onboardflow\.test$/);
    expect(d.staff[0]?.email).toMatch(/^m01\./);
  });
});

describe("seed SQL", () => {
  it("is byte-identical across runs and matches seed/manifest.json and seed/seed.sql", () => {
    const a = datasetToSql(generateDataset(20261008));
    const b = datasetToSql(generateDataset(20261008));
    expect(a).toBe(b);
    const sha = createHash("sha256").update(a).digest("hex");
    const manifest = JSON.parse(readFileSync("seed/manifest.json", "utf8")) as { sha256: string; counts: { users: number } };
    expect(manifest.sha256).toBe(sha);
    expect(manifest.counts.users).toBe(176);
    expect(readFileSync("seed/seed.sql", "utf8")).toBe(a);
    expect(buildSeed().sha256).toBe(sha);
  });

  it("chunks INSERTs to at most 50 rows", () => {
    const sql = datasetToSql(d);
    for (const stmt of sql.split(";\n").filter((s) => s.includes("INSERT"))) {
      const rows = stmt.split("\n").filter((l) => l.startsWith("  ("));
      expect(rows.length).toBeLessThanOrEqual(MAX_ROWS_PER_INSERT);
    }
  });

  it("--anchor shifts dates only", () => {
    const shifted = generateDataset(20261008, "2027-03-01");
    expect(shifted.employees.map(({ startDate: _s, ...rest }) => rest)).toEqual(E.map(({ startDate: _s, ...rest }) => rest));
    expect(shifted.staff).toEqual(d.staff);
    const weeks = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / (7 * 86_400_000);
    shifted.employees.forEach((e, i) => expect(weeks(e.startDate, E[i]!.startDate)).toBe(17));
  });

  it("rejects an anchor that is not a Monday", () => {
    expect(() => generateDataset(1, "2026-11-03")).toThrow(/Monday/);
  });
});
