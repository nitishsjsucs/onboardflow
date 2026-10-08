// Embedded pools for the synthetic dataset. Names are synthetic combinations
// and are not tied to real people. Counts are exact (SPEC Section 16).
import type { EmploymentType, WorkMode } from "../domain.ts";
import type { Department } from "../roles.ts";

export const ORG_UNITS = [
  "Engineering",
  "Sales",
  "Customer Support",
  "Marketing",
  "Finance",
  "Operations",
  "People",
] as const;
export type OrgUnit = (typeof ORG_UNITS)[number];

export const ORG_UNIT_COUNTS: Record<OrgUnit, number> = {
  Engineering: 54,
  Sales: 24,
  "Customer Support": 21,
  Marketing: 15,
  Finance: 12,
  Operations: 12,
  People: 12,
};

/** Exact org unit x employment type joint table. */
export const EMPLOYMENT_BY_ORG: Record<OrgUnit, Record<EmploymentType, number>> = {
  Engineering: { full_time: 40, contractor: 8, intern: 6 },
  Sales: { full_time: 21, contractor: 2, intern: 1 },
  "Customer Support": { full_time: 16, contractor: 4, intern: 1 },
  Marketing: { full_time: 12, contractor: 1, intern: 2 },
  Finance: { full_time: 11, contractor: 1, intern: 0 },
  Operations: { full_time: 10, contractor: 1, intern: 1 },
  People: { full_time: 10, contractor: 1, intern: 1 },
};

export const WORK_MODE_COUNTS: Record<WorkMode, number> = { onsite: 60, hybrid: 54, remote: 36 };

export const OFFICE_SITES = ["San Jose HQ", "Austin", "New York"] as const;
export const REMOTE_SITE = "Remote (US)";

export const COHORTS = 10;
export const COHORT_SIZE = 15;

export const DESIGN_PROFILES_IN_MARKETING = 6;
export const PRIVILEGED_FT_ENGINEERS = 21;

export const COST_CENTERS: Record<OrgUnit, string> = {
  Engineering: "CC-1100",
  Sales: "CC-2100",
  "Customer Support": "CC-2200",
  Marketing: "CC-2300",
  Finance: "CC-3100",
  Operations: "CC-3200",
  People: "CC-3300",
};

export const MANAGERS_BY_ORG: Record<OrgUnit, number> = {
  Engineering: 6,
  Sales: 3,
  "Customer Support": 3,
  Marketing: 2,
  Finance: 2,
  Operations: 1,
  People: 1,
};

export const COORDINATOR_DEPARTMENTS: readonly Department[] = [
  "people_ops",
  "people_ops",
  "it",
  "it",
  "facilities",
  "facilities",
];
export const ADMIN_COUNT = 2;

export const JOB_TITLES: Record<OrgUnit, readonly string[]> = {
  Engineering: ["Software Engineer", "Senior Software Engineer", "Site Reliability Engineer", "Data Engineer", "QA Engineer"],
  Sales: ["Account Executive", "Sales Development Representative", "Solutions Consultant"],
  "Customer Support": ["Support Specialist", "Technical Support Engineer", "Customer Success Manager"],
  Marketing: ["Product Designer", "Content Strategist", "Growth Marketer", "Brand Designer"],
  Finance: ["Financial Analyst", "Accountant", "Revenue Operations Analyst"],
  Operations: ["Operations Analyst", "Program Manager", "Procurement Specialist"],
  People: ["People Partner", "Recruiter", "Learning Specialist"],
};

export function titleFor(orgUnit: OrgUnit, employment: EmploymentType, base: string): string {
  if (employment === "intern") return `${orgUnit} Intern`;
  if (employment === "contractor") return `Contract ${base}`;
  return base;
}

export const FIRST_NAMES = [
  "Avery", "Blake", "Casey", "Dana", "Elliot", "Finley", "Gray", "Harper", "Indra", "Jordan",
  "Kai", "Logan", "Morgan", "Noor", "Oakley", "Parker", "Quinn", "Riley", "Sage", "Taylor",
  "Uma", "Val", "Wren", "Xen", "Yuki", "Zion", "Arjun", "Bea", "Cyrus", "Divya",
  "Emeka", "Farah", "Gus", "Hana", "Ivo", "Jun", "Kira", "Lena", "Mateo", "Nia",
] as const;

export const LAST_NAMES = [
  "Abara", "Brennick", "Castellan", "Dovetail", "Eastwick", "Farrow", "Galloway", "Hollis", "Ingram", "Jarrow",
  "Kestrel", "Lindqvist", "Marlow", "Nakara", "Okonkwo", "Penhale", "Quillon", "Ravel", "Sorensen", "Tamsin",
  "Underhill", "Varga", "Whitlow", "Yarrow", "Zelenko", "Ashdown", "Brightwater", "Calloway", "Delacroix", "Everly",
  "Fairbanks", "Greystone", "Halvorsen", "Iverson", "Juniper", "Kowalczyk", "Larkspur", "Montclair", "Northcott", "Ostrander",
] as const;
