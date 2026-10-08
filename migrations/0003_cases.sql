-- Onboarding cases, per-stage state, blockers, tasks, approvals, provisioning
-- items and the integration call log. D1 is the source of truth (ADR 0001);
-- agent state is a projection of these tables.
CREATE TABLE cases (
  employee_id TEXT PRIMARY KEY REFERENCES employees(id),
  revision INTEGER NOT NULL DEFAULT 1,       -- bumped only by the new-instance fallback
  workflow_instance_id TEXT UNIQUE,          -- onb-E042-1; claimed before create
  status TEXT NOT NULL CHECK (status IN ('not_started','in_progress','blocked','awaiting_approval','complete','failed')),
  failure_reason TEXT CHECK (failure_reason IN ('terminated','approval_rejected_final','recovery_rounds_exhausted','wait_budget_exhausted','workflow_error')),
  current_stage TEXT REFERENCES stages(id),
  run_no INTEGER NOT NULL DEFAULT 1,         -- increments on restart
  started_at TEXT, completed_at TEXT,
  last_mutation_id TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE case_stages (
  employee_id TEXT NOT NULL REFERENCES cases(employee_id),
  stage_id TEXT NOT NULL REFERENCES stages(id),
  status TEXT NOT NULL CHECK (status IN ('pending','active','waiting_on_employee','awaiting_approval','revision_requested','blocked','complete','failed')),
  round INTEGER NOT NULL DEFAULT 1,          -- recovery round (operation stages) or approval round (checkpoint stages)
  blocked_reason_json TEXT,                  -- {class, system, operation, httpStatus, field?, message}
  last_wake_at TEXT,                         -- last wake-up sent by the CaseAgent (nudge rate limit)
  last_mutation_id TEXT,
  started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (employee_id, stage_id)
);
CREATE TABLE blockers (
  id TEXT PRIMARY KEY,                       -- blk:{dedupe_key}:{opened_at_ms}
  employee_id TEXT NOT NULL REFERENCES employees(id),
  stage_id TEXT NOT NULL REFERENCES stages(id),
  kind TEXT NOT NULL CHECK (kind IN ('integration_outage','data_issue','provisioning_stalled','approval_overdue','employee_task_overdue','approval_rejected')),
  severity TEXT NOT NULL CHECK (severity IN ('low','medium','high')),
  owner_department TEXT NOT NULL CHECK (owner_department IN ('people_ops','it','facilities')),
  subject TEXT NOT NULL,                     -- operation id, approval id, or task id
  dedupe_key TEXT NOT NULL,                  -- {employee}:{kind}:{stage}:{subject}
  status TEXT NOT NULL CHECK (status IN ('open','resolved')),
  detail_json TEXT NOT NULL,
  detected_at TEXT NOT NULL, resolved_at TEXT, resolved_by TEXT, resolution TEXT,
  last_mutation_id TEXT
);
CREATE UNIQUE INDEX blockers_open_dedupe ON blockers(dedupe_key) WHERE status = 'open';
CREATE INDEX blockers_status_dept ON blockers(status, owner_department);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,                       -- chk:{employee}:{template} | fu:{blocker_id}
  employee_id TEXT NOT NULL REFERENCES employees(id),
  stage_id TEXT NOT NULL REFERENCES stages(id),
  kind TEXT NOT NULL CHECK (kind IN ('checklist','followup')),
  template_key TEXT REFERENCES task_templates(key),
  assignee TEXT NOT NULL CHECK (assignee IN ('employee','people_ops','it','facilities','manager')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','done','cancelled')),
  due_at TEXT,
  blocker_id TEXT REFERENCES blockers(id),   -- every follow-up has a blocker, including approval_rejected
  drafted_by TEXT,                           -- template | llm:<provider id>
  llm_suggested_category TEXT,
  last_mutation_id TEXT,
  created_at TEXT NOT NULL, completed_at TEXT, completed_by TEXT
);
CREATE INDEX tasks_employee_stage ON tasks(employee_id, stage_id);
CREATE INDEX tasks_assignee_status ON tasks(assignee, status);
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,                       -- apr:{employee}:{checkpoint}:{round}
  employee_id TEXT NOT NULL REFERENCES employees(id),
  stage_id TEXT NOT NULL REFERENCES stages(id),
  checkpoint TEXT NOT NULL CHECK (checkpoint IN ('manager_approval','closeout')),
  round INTEGER NOT NULL,
  approver_role TEXT NOT NULL CHECK (approver_role IN ('manager','coordinator')),
  approver_staff_id TEXT REFERENCES staff(id),   -- set for manager_approval
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  request_json TEXT NOT NULL,                -- equipment profile, license bundle, privileged access
  privileged_access_approved INTEGER CHECK (privileged_access_approved IN (0,1)),
  requested_at TEXT NOT NULL, due_at TEXT NOT NULL,
  decided_at TEXT, decided_by TEXT, decided_on_behalf_of TEXT, reason TEXT,
  last_mutation_id TEXT
);
CREATE UNIQUE INDEX approvals_one_pending ON approvals(employee_id, checkpoint) WHERE status = 'pending';
CREATE TABLE provisioning_items (
  employee_id TEXT NOT NULL REFERENCES employees(id),
  system TEXT NOT NULL CHECK (system IN ('hr','it','facilities')),
  resource TEXT NOT NULL CHECK (resource IN ('hr_worker','hr_documents','hr_orientation','it_account','it_licenses','it_device','fac_workspace','fac_badge')),
  external_id TEXT,
  status TEXT NOT NULL,
  polls INTEGER NOT NULL DEFAULT 0,
  detail_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (employee_id, resource)
);
CREATE TABLE integration_calls (
  id TEXT PRIMARY KEY,                       -- {instance}:{run_no}:{step_name}:{attempt}
  employee_id TEXT NOT NULL REFERENCES employees(id),
  workflow_instance_id TEXT NOT NULL,
  run_no INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  system TEXT NOT NULL CHECK (system IN ('hr','it','facilities')),
  operation TEXT NOT NULL,
  method TEXT NOT NULL, path TEXT NOT NULL,
  idempotency_key TEXT,
  attempt INTEGER NOT NULL,                  -- WorkflowStepContext.attempt (1-based)
  http_status INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','replayed','retryable_error','fatal_error','timeout','malformed','conflict')),
  retry_after_ms INTEGER,
  latency_ms INTEGER NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX integration_calls_employee ON integration_calls(employee_id, created_at);
CREATE INDEX integration_calls_system ON integration_calls(system, outcome);
