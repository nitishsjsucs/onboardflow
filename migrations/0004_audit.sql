-- Append-only audit log and the API idempotency store. Every mutation of a
-- domain table writes its audit row in the same DB.batch, conditioned on the
-- mutation having taken effect (ADR 0008).
CREATE TABLE audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,                   -- usr:/wf:/ag:/ic: deterministic ids
  occurred_at TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user','agent','workflow','system')),
  actor_id TEXT NOT NULL,                    -- email, agent name, or workflow instance id
  actor_role TEXT,
  action TEXT NOT NULL,                      -- AuditAction catalog in src/shared/domain.ts
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  employee_id TEXT,
  stage_id TEXT,
  run_no INTEGER,
  round INTEGER,
  request_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_employee ON audit_events(employee_id, seq);
CREATE INDEX audit_entity ON audit_events(entity_type, entity_id);
CREATE INDEX audit_action ON audit_events(action, seq);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events
  BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events
  BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;

CREATE TABLE api_idempotency (
  actor_email TEXT NOT NULL,
  key TEXT NOT NULL,
  route TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','complete')),
  status INTEGER,                            -- set when complete
  response_json TEXT,                        -- set when complete
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor_email, key)
);
