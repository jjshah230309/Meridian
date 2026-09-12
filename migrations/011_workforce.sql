-- =====================================================================
-- Meridian ERP :: 011_workforce
-- Performance, scheduling, attendance and employee self-service.
--
-- Self-service requests are deliberately one table with a payload rather
-- than a table per request kind: the approval routing, the notification
-- and the audit trail are identical whatever is being asked for, and a
-- new request type should not need a migration.
-- =====================================================================

CREATE TABLE IF NOT EXISTS review_cycle (
  id           TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,
  due_date     TEXT,
  status       TEXT NOT NULL DEFAULT 'draft',      -- draft|open|closed
  template     TEXT NOT NULL DEFAULT '[]',         -- [{competency, description, weight}]
  rating_scale INTEGER NOT NULL DEFAULT 5,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS performance_review (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  cycle_id      TEXT NOT NULL,
  employee_id   TEXT NOT NULL,
  reviewer_id   TEXT,
  status        TEXT NOT NULL DEFAULT 'not_started', -- not_started|self_review|manager_review|complete|acknowledged
  self_rating   REAL,
  manager_rating REAL,
  overall_rating REAL,
  ratings       TEXT NOT NULL DEFAULT '[]',        -- [{competency, self, manager, comment}]
  strengths     TEXT NOT NULL DEFAULT '',
  development   TEXT NOT NULL DEFAULT '',
  goals         TEXT NOT NULL DEFAULT '[]',
  submitted_at  TEXT,
  acknowledged_at TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_review ON performance_review (tenant_id, cycle_id, employee_id);

CREATE TABLE IF NOT EXISTS shift (
  id           TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  location_id  TEXT,
  department_id TEXT,
  starts_at    TEXT NOT NULL,                      -- 'HH:MM'
  ends_at      TEXT NOT NULL,
  break_minutes INTEGER NOT NULL DEFAULT 0,
  colour       TEXT NOT NULL DEFAULT '',
  active       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS schedule_entry (
  id           TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  employee_id  TEXT NOT NULL,
  shift_id     TEXT,
  work_date    TEXT NOT NULL,
  starts_at    TEXT NOT NULL DEFAULT '',
  ends_at      TEXT NOT NULL DEFAULT '',
  location_id  TEXT,
  status       TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled|confirmed|swapped|absent
  notes        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_sched ON schedule_entry (tenant_id, work_date, employee_id);

CREATE TABLE IF NOT EXISTS attendance (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  employee_id   TEXT NOT NULL,
  work_date     TEXT NOT NULL,
  clock_in      TEXT,
  clock_out     TEXT,
  break_minutes INTEGER NOT NULL DEFAULT 0,
  worked_hours  INTEGER NOT NULL DEFAULT 0,        -- scaled 1e6
  overtime_hours INTEGER NOT NULL DEFAULT 0,
  scheduled_id  TEXT,
  status        TEXT NOT NULL DEFAULT 'open',      -- open|closed|approved|exception
  exception     TEXT NOT NULL DEFAULT '',          -- late|early_leave|no_show|long_break
  source        TEXT NOT NULL DEFAULT 'manual',    -- manual|kiosk|mobile|import
  approved_by   TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_attendance ON attendance (tenant_id, employee_id, work_date);

CREATE TABLE IF NOT EXISTS employee_request (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  employee_id   TEXT NOT NULL,
  request_type  TEXT NOT NULL,                     -- address_change|bank_change|time_off|shift_swap|equipment|training|document
  title         TEXT NOT NULL DEFAULT '',
  payload       TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'submitted', -- submitted|approved|rejected|applied|withdrawn
  approver_id   TEXT,
  decided_at    TEXT,
  decision_note TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_emp_request ON employee_request (tenant_id, status, employee_id);

-- Sales reps earn commission the same way partners do; the rate belongs on
-- the employee so a rep's terms travel with them between deals.
ALTER TABLE employee ADD COLUMN commission_pct REAL NOT NULL DEFAULT 0;
