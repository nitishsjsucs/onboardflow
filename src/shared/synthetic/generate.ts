// generateDataset(seed, anchor, version): the deterministic synthetic
// workforce. Pure: no I/O, no Math.random, no wall-clock reads (dates derive
// from `anchor`). Exact counts are constructed, not sampled: every step either
// shuffles an exact multiset or derives a value from earlier steps, so every
// marginal and joint constraint in SPEC Section 16 holds by construction.
import type { EmploymentType, EquipmentProfile, LicenseBundle, WorkMode } from "../domain.ts";
import { employeeId } from "../ids.ts";
import type { Department, Role } from "../roles.ts";
import { mulberry32, multiset, pick, shuffle } from "./prng.ts";
import {
  ADMIN_COUNT,
  COHORT_SIZE,
  COHORTS,
  COORDINATOR_DEPARTMENTS,
  COST_CENTERS,
  DESIGN_PROFILES_IN_MARKETING,
  EMPLOYMENT_BY_ORG,
  FIRST_NAMES,
  JOB_TITLES,
  LAST_NAMES,
  MANAGERS_BY_ORG,
  OFFICE_SITES,
  ORG_UNIT_COUNTS,
  ORG_UNITS,
  type OrgUnit,
  PRIVILEGED_FT_ENGINEERS,
  REMOTE_SITE,
  titleFor,
  WORK_MODE_COUNTS,
} from "./pools.ts";

export const DEFAULT_SEED = 20261008;
export const DEFAULT_ANCHOR = "2026-11-02";
export const DEFAULT_VERSION = "v1";
export const EMAIL_DOMAIN = "onboardflow.test";

export type SyntheticEmployee = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  jobTitle: string;
  orgUnit: OrgUnit;
  employmentType: EmploymentType;
  workMode: WorkMode;
  site: string;
  startDate: string;
  managerId: string;
  equipmentProfile: EquipmentProfile;
  licenseBundle: LicenseBundle;
  needsPrivilegedAccess: boolean;
  costCenter: string;
  photoOnFile: boolean;
};

export type SyntheticStaff = {
  id: string;
  email: string;
  displayName: string;
  kind: "manager" | "coordinator" | "admin";
  department: Department | null;
  orgUnit: OrgUnit | null;
};

export type SyntheticUser = {
  email: string;
  role: Role;
  employeeId: string | null;
  staffId: string | null;
};

export type Dataset = {
  seed: number;
  anchor: string;
  version: string;
  /** Deterministic timestamp for seeded rows: 00:00Z, 32 days before the anchor. */
  seededAt: string;
  employees: SyntheticEmployee[];
  staff: SyntheticStaff[];
  users: SyntheticUser[];
};

const DAY_MS = 86_400_000;

function assertMonday(anchor: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) throw new Error(`anchor must be YYYY-MM-DD, got ${anchor}`);
  const d = new Date(`${anchor}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.getUTCDay() !== 1) throw new Error(`anchor must be a Monday, got ${anchor}`);
  return d;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, "");
}

export function generateDataset(
  seed: number = DEFAULT_SEED,
  anchor: string = DEFAULT_ANCHOR,
  version: string = DEFAULT_VERSION,
): Dataset {
  const anchorDate = assertMonday(anchor);
  // Independent streams per concern keep each construction step stable.
  const stream = (salt: number) => mulberry32((seed ^ Math.imul(salt, 0x9e3779b1)) >>> 0);
  const ids = Array.from({ length: 150 }, (_, i) => employeeId(i + 1));

  // 1. Org unit: exact multiset shuffled onto E001..E150.
  const orgOf = shuffle(multiset(ORG_UNIT_COUNTS), stream(1));

  // 2. Employment type conditional on org unit, shuffled within each org unit.
  const employmentOf: EmploymentType[] = new Array(150);
  const rngEmp = stream(2);
  for (const org of ORG_UNITS) {
    const members = ids.map((_, i) => i).filter((i) => orgOf[i] === org);
    const types = shuffle(multiset(EMPLOYMENT_BY_ORG[org]), rngEmp);
    members.forEach((i, k) => (employmentOf[i] = types[k] as EmploymentType));
  }

  // 3. Work mode over all 150; site derived (remote -> Remote (US), else round-robin in id order).
  const modeOf = shuffle(multiset(WORK_MODE_COUNTS), stream(3));
  const siteOf: string[] = new Array(150);
  let officeIdx = 0;
  for (let i = 0; i < 150; i++) {
    siteOf[i] = modeOf[i] === "remote" ? REMOTE_SITE : (OFFICE_SITES[officeIdx++ % OFFICE_SITES.length] as string);
  }

  // 4. Start date: 10 weekly Monday cohorts from the anchor, 15 each, shuffled.
  const cohortOf = shuffle(
    Array.from({ length: COHORTS * COHORT_SIZE }, (_, i) => Math.floor(i / COHORT_SIZE)),
    stream(4),
  );
  const startOf = cohortOf.map((c) => isoDate(anchorDate.getTime() + c * 7 * DAY_MS));

  // 5. Equipment profile: engineering for Engineering; design for exactly 6 Marketing; standard otherwise.
  const marketing = ids.map((_, i) => i).filter((i) => orgOf[i] === "Marketing");
  const designSet = new Set(shuffle(marketing, stream(5)).slice(0, DESIGN_PROFILES_IN_MARKETING));
  const equipmentOf: EquipmentProfile[] = ids.map((_, i) =>
    orgOf[i] === "Engineering" ? "engineering" : designSet.has(i) ? "design" : "standard",
  );

  // 6. License bundle derived from org unit and employment type.
  const bundleOf: LicenseBundle[] = ids.map((_, i) => {
    const e = employmentOf[i];
    if (e === "contractor") return "contractor-basic";
    if (e === "intern") return "intern-basic";
    return orgOf[i] === "Engineering" ? "ft-engineering" : "ft-standard";
  });

  // 7. Privileged access: exactly 21 of the 40 full-time engineers.
  const ftEng = ids.map((_, i) => i).filter((i) => orgOf[i] === "Engineering" && employmentOf[i] === "full_time");
  const privileged = new Set(shuffle(ftEng, stream(7)).slice(0, PRIVILEGED_FT_ENGINEERS));

  // 9. Staff: managers by org unit (M01..M18), coordinators (C01..C06), admins (A01..A02).
  const rngNames = stream(9);
  const staff: SyntheticStaff[] = [];
  const name = () => ({ first: pick(FIRST_NAMES, rngNames), last: pick(LAST_NAMES, rngNames) });
  const managersByOrg = new Map<OrgUnit, string[]>();
  let m = 0;
  for (const org of ORG_UNITS) {
    const list: string[] = [];
    for (let k = 0; k < MANAGERS_BY_ORG[org]; k++) {
      const id = `M${String(++m).padStart(2, "0")}`;
      const n = name();
      staff.push({
        id,
        email: `${id.toLowerCase()}.${slug(n.first)}.${slug(n.last)}@${EMAIL_DOMAIN}`,
        displayName: `${n.first} ${n.last}`,
        kind: "manager",
        department: null,
        orgUnit: org,
      });
      list.push(id);
    }
    managersByOrg.set(org, list);
  }
  COORDINATOR_DEPARTMENTS.forEach((dept, k) => {
    const id = `C${String(k + 1).padStart(2, "0")}`;
    const n = name();
    staff.push({
      id,
      email: `${id.toLowerCase()}.${slug(n.first)}.${slug(n.last)}@${EMAIL_DOMAIN}`,
      displayName: `${n.first} ${n.last}`,
      kind: "coordinator",
      department: dept,
      orgUnit: null,
    });
  });
  for (let k = 0; k < ADMIN_COUNT; k++) {
    const id = `A${String(k + 1).padStart(2, "0")}`;
    const n = name();
    staff.push({
      id,
      email: `${id.toLowerCase()}.${slug(n.first)}.${slug(n.last)}@${EMAIL_DOMAIN}`,
      displayName: `${n.first} ${n.last}`,
      kind: "admin",
      department: null,
      orgUnit: null,
    });
  }

  // Managers: round-robin within org unit, in id order.
  const managerOf: string[] = new Array(150);
  for (const org of ORG_UNITS) {
    const list = managersByOrg.get(org) ?? [];
    ids
      .map((_, i) => i)
      .filter((i) => orgOf[i] === org)
      .forEach((i, k) => (managerOf[i] = list[k % list.length] as string));
  }

  // Names and titles, then the employee rows (8. cost center by org unit; 11. emails).
  const rngPeople = stream(11);
  const employees: SyntheticEmployee[] = ids.map((id, i) => {
    const org = orgOf[i] as OrgUnit;
    const emp = employmentOf[i] as EmploymentType;
    const first = pick(FIRST_NAMES, rngPeople);
    const last = pick(LAST_NAMES, rngPeople);
    const base = pick(JOB_TITLES[org], rngPeople);
    return {
      id,
      email: `${slug(first)}.${slug(last)}.${id.toLowerCase()}@${EMAIL_DOMAIN}`,
      firstName: first,
      lastName: last,
      jobTitle: titleFor(org, emp, base),
      orgUnit: org,
      employmentType: emp,
      workMode: modeOf[i] as WorkMode,
      site: siteOf[i] as string,
      startDate: startOf[i] as string,
      managerId: managerOf[i] as string,
      equipmentProfile: equipmentOf[i] as EquipmentProfile,
      licenseBundle: bundleOf[i] as LicenseBundle,
      needsPrivilegedAccess: privileged.has(i),
      costCenter: COST_CENTERS[org],
      photoOnFile: false,
    };
  });

  // 10. Users: 150 employees + 18 managers + 6 coordinators + 2 admins.
  const users: SyntheticUser[] = [
    ...employees.map((e) => ({ email: e.email, role: "employee" as const, employeeId: e.id, staffId: null })),
    ...staff.map((s) => ({ email: s.email, role: s.kind as Role, employeeId: null, staffId: s.id })),
  ];

  return {
    seed,
    anchor,
    version,
    seededAt: new Date(anchorDate.getTime() - 32 * DAY_MS).toISOString(),
    employees,
    staff,
    users,
  };
}

export type DatasetCounts = {
  employees: number;
  staff: number;
  managers: number;
  coordinators: number;
  admins: number;
  users: number;
  roles: number;
  cases: number;
  caseStages: number;
};

export function datasetCounts(d: Dataset): DatasetCounts {
  return {
    employees: d.employees.length,
    staff: d.staff.length,
    managers: d.staff.filter((s) => s.kind === "manager").length,
    coordinators: d.staff.filter((s) => s.kind === "coordinator").length,
    admins: d.staff.filter((s) => s.kind === "admin").length,
    users: d.users.length,
    roles: new Set(d.users.map((u) => u.role)).size,
    cases: d.employees.length,
    caseStages: d.employees.length * 8,
  };
}

function countBy<T>(items: readonly T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) out[key(it)] = (out[key(it)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export function jointCounts(d: Dataset) {
  const e = d.employees;
  return {
    orgUnit: countBy(e, (x) => x.orgUnit),
    orgUnitByEmployment: countBy(e, (x) => `${x.orgUnit}|${x.employmentType}`),
    workMode: countBy(e, (x) => x.workMode),
    site: countBy(e, (x) => x.site),
    startDate: countBy(e, (x) => x.startDate),
    equipmentProfile: countBy(e, (x) => x.equipmentProfile),
    equipmentByOrgUnit: countBy(e, (x) => `${x.orgUnit}|${x.equipmentProfile}`),
    licenseBundle: countBy(e, (x) => x.licenseBundle),
    privilegedByOrgEmployment: countBy(
      e.filter((x) => x.needsPrivilegedAccess),
      (x) => `${x.orgUnit}|${x.employmentType}`,
    ),
    managerReports: countBy(e, (x) => x.managerId),
  };
}
