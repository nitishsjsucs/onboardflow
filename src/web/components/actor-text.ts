// Who acts, in words (the structure comes from src/shared/who-acts.ts).
import type { Department } from "../../shared/roles.ts";
import type { Actor } from "../../shared/who-acts.ts";
import { DEPARTMENT_NAMES } from "./blocker-text.ts";

/** "IT", "People Ops or IT", "People Ops, IT or Facilities". */
export function departmentsText(ds: readonly Department[]): string {
  const names = ds.map((d) => DEPARTMENT_NAMES[d]);
  if (names.length <= 1) return names[0] ?? "People Ops";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/** The actor as a noun phrase: "the employee", "the hiring manager", "IT", "the workflow", "an admin". */
export function actorName(a: Actor, managerName?: string): string {
  switch (a.kind) {
    case "employee":
      return "the employee";
    case "manager":
      return managerName ?? "the hiring manager";
    case "department":
      return departmentsText(a.departments);
    case "workflow":
      return "the workflow";
    case "admin":
      return "an admin";
    case "nobody":
      return "nobody";
  }
}

export function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
