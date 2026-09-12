-- =====================================================================
-- Meridian ERP :: 007_projects
-- Projects and professional services automation.
--
-- A project is a costing and billing container: time and expense flow
-- into it, and billing rules turn that into invoices. Profitability is
-- therefore a fact derived from posted documents, not a spreadsheet.
-- =====================================================================

CREATE TABLE IF NOT EXISTS project (
  id             TEXT NOT NULL,
  tenant_id      TEXT NOT NULL,
  project_no     TEXT NOT NULL,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  customer_id    TEXT,
  subsidiary_id  TEXT NOT NULL,
  manager_id     TEXT,                              -- employee
  department_id  TEXT,
  status         TEXT NOT NULL DEFAULT 'planned',   -- planned|active|on_hold|completed|cancelled
  billing_type   TEXT NOT NULL DEFAULT 'time_and_materials', -- time_and_materials|fixed_price|milestone|non_billable
  currency       TEXT NOT NULL DEFAULT 'USD',
  start_date     TEXT,
  end_date       TEXT,
  estimated_hours INTEGER NOT NULL DEFAULT 0,       -- scaled 1e6
  budget_amount  INTEGER NOT NULL DEFAULT 0,        -- minor units
  fixed_fee      INTEGER NOT NULL DEFAULT 0,
  percent_complete REAL NOT NULL DEFAULT 0,
  income_account_id  TEXT,
  wip_account_id     TEXT,
  custom         TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_project_no ON project (tenant_id, project_no);
CREATE INDEX IF NOT EXISTS ix_project_customer ON project (tenant_id, customer_id, status);

CREATE TABLE IF NOT EXISTS project_task (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  parent_id     TEXT,
  sequence      INTEGER NOT NULL DEFAULT 0,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  assignee_id   TEXT,
  status        TEXT NOT NULL DEFAULT 'not_started', -- not_started|in_progress|blocked|complete
  start_date    TEXT,
  end_date      TEXT,
  estimated_hours INTEGER NOT NULL DEFAULT 0,
  actual_hours    INTEGER NOT NULL DEFAULT 0,
  percent_complete REAL NOT NULL DEFAULT 0,
  is_milestone  INTEGER NOT NULL DEFAULT 0,
  milestone_amount INTEGER NOT NULL DEFAULT 0,
  milestone_billed INTEGER NOT NULL DEFAULT 0,
  predecessor_id TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_task_project ON project_task (tenant_id, project_id, sequence);

-- Who is booked on what, so utilisation is answerable before the fact.
CREATE TABLE IF NOT EXISTS resource_allocation (
  id           TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  task_id      TEXT,
  employee_id  TEXT NOT NULL,
  start_date   TEXT NOT NULL,
  end_date     TEXT NOT NULL,
  hours_per_week INTEGER NOT NULL DEFAULT 0,        -- scaled 1e6
  bill_rate    INTEGER NOT NULL DEFAULT 0,          -- minor units per hour
  cost_rate    INTEGER NOT NULL DEFAULT 0,
  notes        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_alloc_emp ON resource_allocation (tenant_id, employee_id, start_date);

-- Billing rates resolve most-specific-first: employee on project, then role
-- on project, then project default, then the customer's rate card.
CREATE TABLE IF NOT EXISTS billing_rate (
  id           TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  project_id   TEXT,
  customer_id  TEXT,
  employee_id  TEXT,
  role_name    TEXT,
  service_item_id TEXT,
  rate         INTEGER NOT NULL DEFAULT 0,
  cost_rate    INTEGER NOT NULL DEFAULT 0,
  effective_from TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS expense_report (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  report_no     TEXT NOT NULL,
  employee_id   TEXT NOT NULL,
  project_id    TEXT,
  subsidiary_id TEXT NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  report_date   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft',      -- draft|submitted|approved|rejected|reimbursed
  total         INTEGER NOT NULL DEFAULT 0,
  billable_total INTEGER NOT NULL DEFAULT 0,
  memo          TEXT NOT NULL DEFAULT '',
  approved_by   TEXT,
  approved_at   TEXT,
  journal_entry_id TEXT,
  custom        TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_expense_no ON expense_report (tenant_id, report_no);

CREATE TABLE IF NOT EXISTS expense_line (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  report_id     TEXT NOT NULL,
  line_no       INTEGER NOT NULL DEFAULT 1,
  expense_date  TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'other',
  account_id    TEXT,
  project_id    TEXT,
  task_id       TEXT,
  description   TEXT NOT NULL DEFAULT '',
  amount        INTEGER NOT NULL DEFAULT 0,
  tax_amount    INTEGER NOT NULL DEFAULT 0,
  billable      INTEGER NOT NULL DEFAULT 0,
  billed_txn_id TEXT,
  receipt_ref   TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_expense_line ON expense_line (tenant_id, report_id, line_no);

-- time_entry already carries billable / bill_rate / cost_rate / billed_txn_id
-- and a free-text `project` label. These two turn that label into a real
-- reference so time rolls up to a project and a task.
ALTER TABLE time_entry ADD COLUMN project_id TEXT;
ALTER TABLE time_entry ADD COLUMN task_id TEXT;
CREATE INDEX IF NOT EXISTS ix_time_project ON time_entry (tenant_id, project_id, entry_date);
