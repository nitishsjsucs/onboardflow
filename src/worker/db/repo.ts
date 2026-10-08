// Typed D1 queries shared by routes, agents and workflow steps.
import type { EmploymentType, EquipmentProfile, LicenseBundle, WorkMode } from "../../shared/domain.ts";

export type EmployeeProfile = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  jobTitle: string;
  orgUnit: string;
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

type EmployeeRow = {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  job_title: string;
  org_unit: string;
  employment_type: EmploymentType;
  work_mode: WorkMode;
  site: string;
  start_date: string;
  manager_id: string;
  equipment_profile: EquipmentProfile;
  license_bundle: LicenseBundle;
  needs_privileged_access: number;
  cost_center: string;
  photo_on_file: number;
};

export function toEmployeeProfile(r: EmployeeRow): EmployeeProfile {
  return {
    id: r.id,
    email: r.email,
    firstName: r.first_name,
    lastName: r.last_name,
    jobTitle: r.job_title,
    orgUnit: r.org_unit,
    employmentType: r.employment_type,
    workMode: r.work_mode,
    site: r.site,
    startDate: r.start_date,
    managerId: r.manager_id,
    equipmentProfile: r.equipment_profile,
    licenseBundle: r.license_bundle,
    needsPrivilegedAccess: r.needs_privileged_access === 1,
    costCenter: r.cost_center,
    photoOnFile: r.photo_on_file === 1,
  };
}

export const EMPLOYEE_COLUMNS =
  "id, email, first_name, last_name, job_title, org_unit, employment_type, work_mode, site, start_date, manager_id, equipment_profile, license_bundle, needs_privileged_access, cost_center, photo_on_file";

export async function getEmployee(db: D1Database, id: string): Promise<EmployeeProfile | null> {
  const r = await db.prepare(`SELECT ${EMPLOYEE_COLUMNS} FROM employees WHERE id = ?`).bind(id).first<EmployeeRow>();
  return r ? toEmployeeProfile(r) : null;
}
