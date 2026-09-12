-- =====================================================================
-- Meridian ERP :: 005_hr
-- Employee directory, org structure, time tracking, time off,
-- and payroll with integration hooks to an external payroll provider.
-- =====================================================================

CREATE TABLE IF NOT EXISTS employee (
  id             TEXT NOT NULL,
  tenant_id      TEXT NOT NULL,
  employee_no    TEXT NOT NULL,
  first_name     TEXT NOT NULL,
  last_name      TEXT NOT NULL,
  preferred_name TEXT NOT NULL DEFAULT '',
  email          TEXT NOT NULL DEFAULT '',
  work_phone     TEXT NOT NULL DEFAULT '',
  mobile         TEXT NOT NULL DEFAULT '',
  title          TEXT NOT NULL DEFAULT '',
  department_id  TEXT,
  manager_id     TEXT,
  subsidiary_id  TEXT NOT NULL,
  location_id    TEXT,
  class_id       TEXT,
  hire_date      TEXT,
  termination_date TEXT,
  employment_type TEXT NOT NULL DEFAULT 'full_time', -- full_time|part_time|contractor|intern
  status         TEXT NOT NULL DEFAULT 'active',     -- active|on_leave|terminated
  pay_type       TEXT NOT NULL DEFAULT 'salary',     -- salary|hourly
  pay_rate       INTEGER NOT NULL DEFAULT 0,         -- annual salary or hourly rate, minor units
  pay_frequency  TEXT NOT NULL DEFAULT 'monthly',    -- weekly|biweekly|semimonthly|monthly
  currency       TEXT NOT NULL,
  standard_hours REAL NOT NULL DEFAULT 40,
  is_sales_rep   INTEGER NOT NULL DEFAULT 0,
  is_manager     INTEGER NOT NULL DEFAULT 0,
  user_id        TEXT,
  address        TEXT NOT NULL DEFAULT '{}',
  emergency_contact TEXT NOT NULL DEFAULT '{}',
  -- Sensitive identifiers are never stored in clear text. The platform keeps
  -- only a last-4 fragment for display; full identifiers live with the
  -- payroll provider and are referenced by provider_ref. See docs/SECURITY.md
  national_id_last4 TEXT NOT NULL DEFAULT '',
  bank_last4     TEXT NOT NULL DEFAULT '',
  provider_ref   TEXT NOT NULL DEFAULT '',
  pto_balance_hours REAL NOT NULL DEFAULT 0,
  notes          TEXT NOT NULL DEFAULT '',
  custom         TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_emp_no ON employee(tenant_id, employee_no);
CREATE INDEX IF NOT EXISTS ix_emp_dept ON employee(tenant_id, department_id, status);
CREATE INDEX IF NOT EXISTS ix_emp_mgr ON employee(tenant_id, manager_id);

CREATE TABLE IF NOT EXISTS time_entry (
  id          TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  entry_date  TEXT NOT NULL,
  hours       REAL NOT NULL DEFAULT 0,
  customer_id TEXT,
  item_id     TEXT,                       -- service item, for billable time
  project     TEXT NOT NULL DEFAULT '',
  department_id TEXT,
  billable    INTEGER NOT NULL DEFAULT 0,
  billed_txn_id TEXT,
  bill_rate   INTEGER NOT NULL DEFAULT 0,
  cost_rate   INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'draft', -- draft|submitted|approved|rejected
  approved_by TEXT,
  approved_at TEXT,
  memo        TEXT NOT NULL DEFAULT '',
  custom      TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_time_emp ON time_entry(tenant_id, employee_id, entry_date);
CREATE INDEX IF NOT EXISTS ix_time_status ON time_entry(tenant_id, status);

CREATE TABLE IF NOT EXISTS time_off (
  id          TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'vacation', -- vacation|sick|personal|unpaid|parental
  start_date  TEXT NOT NULL,
  end_date    TEXT NOT NULL,
  hours       REAL NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|rejected|cancelled
  approver_id TEXT,
  approved_at TEXT,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_pto ON time_off(tenant_id, employee_id, start_date);

CREATE TABLE IF NOT EXISTS payroll_run (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  run_no        TEXT NOT NULL,
  subsidiary_id TEXT NOT NULL,
  period_start  TEXT NOT NULL,
  period_end    TEXT NOT NULL,
  pay_date      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft', -- draft|calculated|approved|posted|sent|failed
  currency      TEXT NOT NULL,
  total_gross   INTEGER NOT NULL DEFAULT 0,
  total_employee_tax INTEGER NOT NULL DEFAULT 0,
  total_employer_tax INTEGER NOT NULL DEFAULT 0,
  total_deductions   INTEGER NOT NULL DEFAULT 0,
  total_net     INTEGER NOT NULL DEFAULT 0,
  employee_count INTEGER NOT NULL DEFAULT 0,
  journal_entry_id TEXT,
  -- outbound integration hook state
  provider      TEXT NOT NULL DEFAULT 'none',
  provider_ref  TEXT NOT NULL DEFAULT '',
  provider_status TEXT NOT NULL DEFAULT '',
  exported_at   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_payrun_no ON payroll_run(tenant_id, run_no);

CREATE TABLE IF NOT EXISTS payroll_line (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  employee_id   TEXT NOT NULL,
  hours         REAL NOT NULL DEFAULT 0,
  overtime_hours REAL NOT NULL DEFAULT 0,
  gross         INTEGER NOT NULL DEFAULT 0,
  employee_tax  INTEGER NOT NULL DEFAULT 0,
  employer_tax  INTEGER NOT NULL DEFAULT 0,
  deductions    INTEGER NOT NULL DEFAULT 0,
  net           INTEGER NOT NULL DEFAULT 0,
  department_id TEXT,
  earnings      TEXT NOT NULL DEFAULT '{}',   -- JSON breakdown
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_payline ON payroll_line(tenant_id, run_id);

-- Outbound integration queue: payroll, tax filing, e-commerce, banking.
-- Deliveries are recorded so retries are idempotent and auditable.
CREATE TABLE IF NOT EXISTS integration_event (
  id          TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  channel     TEXT NOT NULL,               -- payroll|bank|webhook|email
  event_type  TEXT NOT NULL,
  record_type TEXT NOT NULL DEFAULT '',
  record_id   TEXT,
  payload     TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'pending', -- pending|delivered|failed|skipped
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT NOT NULL DEFAULT '',
  target_url  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  delivered_at TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_intev ON integration_event(tenant_id, status, created_at);
