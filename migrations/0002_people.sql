-- People: staff (managers, coordinators, admins), synthetic employees, and the
-- app_users table that maps an authenticated email to one of the four roles.
-- cost_center and license_bundle validity is left to the simulated systems on
-- purpose: that is what produces genuine 422 data issues in scenarios.
CREATE TABLE staff (
  id TEXT PRIMARY KEY,                       -- M01..M18, C01..C06, A01..A02 (production admins: P01..)
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('manager','coordinator','admin')),
  department TEXT CHECK (department IN ('people_ops','it','facilities')),
  org_unit TEXT,
  CHECK ((kind = 'coordinator') = (department IS NOT NULL))
);
CREATE TABLE employees (
  id TEXT PRIMARY KEY,                       -- E001..E150
  email TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  job_title TEXT NOT NULL,
  org_unit TEXT NOT NULL,
  employment_type TEXT NOT NULL CHECK (employment_type IN ('full_time','contractor','intern')),
  work_mode TEXT NOT NULL CHECK (work_mode IN ('onsite','hybrid','remote')),
  site TEXT NOT NULL,
  start_date TEXT NOT NULL,
  manager_id TEXT NOT NULL REFERENCES staff(id),
  equipment_profile TEXT NOT NULL CHECK (equipment_profile IN ('standard','engineering','design')),
  license_bundle TEXT NOT NULL CHECK (license_bundle IN ('ft-standard','ft-engineering','contractor-basic','intern-basic')),
  needs_privileged_access INTEGER NOT NULL CHECK (needs_privileged_access IN (0,1)),
  cost_center TEXT NOT NULL,
  photo_on_file INTEGER NOT NULL DEFAULT 0 CHECK (photo_on_file IN (0,1)),
  seed_version TEXT NOT NULL,
  last_mutation_id TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX employees_manager ON employees(manager_id);
CREATE TABLE app_users (
  email TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('employee','manager','coordinator','admin')),
  employee_id TEXT REFERENCES employees(id),
  staff_id TEXT REFERENCES staff(id),
  active INTEGER NOT NULL DEFAULT 1,
  CHECK ((role = 'employee') = (employee_id IS NOT NULL)),
  CHECK ((role <> 'employee') = (staff_id IS NOT NULL))
);
