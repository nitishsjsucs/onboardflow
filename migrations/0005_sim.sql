-- State owned by the simulated HR, IT and Facilities systems (prefixed sim_).
-- Device orders, badges and orientation enrollments have no uniqueness on
-- employee_ref, as in real systems: only the idempotency store prevents
-- duplicates, which is what makes the duplicate side-effect metric meaningful.
CREATE TABLE sim_idempotency (
  system TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,         -- sha256(method + path + canonical JSON body)
  status_code INTEGER NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (system, idempotency_key)      -- the PK is the lock: written in the same batch as the side effect
);
CREATE TABLE sim_resources (
  system TEXT NOT NULL, id TEXT NOT NULL,
  resource_type TEXT NOT NULL, employee_ref TEXT NOT NULL,
  status TEXT NOT NULL, polls INTEGER NOT NULL DEFAULT 0, data_json TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (system, id)
);
CREATE INDEX sim_resources_employee ON sim_resources(employee_ref, resource_type);
CREATE TABLE sim_side_effects (               -- ledger used to prove "no duplicate side effects"
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  system TEXT NOT NULL, operation TEXT NOT NULL, employee_ref TEXT NOT NULL,
  resource_id TEXT NOT NULL, idempotency_key TEXT, created_at TEXT NOT NULL
);
CREATE TABLE sim_fault_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system TEXT NOT NULL CHECK (system IN ('hr','it','facilities')),
  operation TEXT NOT NULL,
  employee_ref TEXT,                         -- NULL = any employee
  fault TEXT NOT NULL CHECK (fault IN ('fail_503','rate_limit_429','timeout','lost_response','malformed','stall','conflict_409')),
  remaining INTEGER,                         -- NULL = until cleared (outage)
  param_json TEXT NOT NULL DEFAULT '{}',     -- e.g. {"retryAfterMs": 300}
  created_at TEXT NOT NULL, cleared_at TEXT
);
