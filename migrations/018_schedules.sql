-- =====================================================================
-- Meridian ERP :: 018_schedules
-- Revenue recognition and expense amortisation.
--
-- Cash and the profit and loss disagree on purpose. A twelve-month support
-- contract billed up front is one invoice and twelve months of revenue; a
-- year of insurance paid in January is one bill and twelve months of expense.
-- Both are the same machine run in opposite directions: park the amount on
-- the balance sheet at billing, then release a slice of it each period.
--
-- The deferral account is the parking space -- Deferred Revenue for income,
-- Prepaid Expenses for cost -- and the target account is where the slice
-- eventually lands.
-- =====================================================================

CREATE TABLE IF NOT EXISTS schedule_template (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'revenue',   -- revenue | expense
  method        TEXT NOT NULL DEFAULT 'straight_monthly',
        -- straight_monthly : equal slices, one per calendar month
        -- straight_daily   : pro-rated by day, so part months are exact
        -- on_completion    : one slice, held until somebody releases it
  term_months   INTEGER NOT NULL DEFAULT 12,
  start_rule    TEXT NOT NULL DEFAULT 'transaction_date',
        -- transaction_date | next_month | service_start
  deferral_account_id TEXT,                        -- null = the company default
  description   TEXT NOT NULL DEFAULT '',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_sched_tmpl_name ON schedule_template (tenant_id, name);

-- An item can default a template; a transaction line can override it, and
-- can name the service window the slices should follow.
ALTER TABLE item ADD COLUMN revenue_template_id TEXT;
ALTER TABLE item ADD COLUMN expense_template_id TEXT;
ALTER TABLE txn_line ADD COLUMN schedule_template_id TEXT;
ALTER TABLE txn_line ADD COLUMN service_start TEXT;
ALTER TABLE txn_line ADD COLUMN service_end   TEXT;

CREATE TABLE IF NOT EXISTS schedule (
  id             TEXT NOT NULL,
  tenant_id      TEXT NOT NULL,
  schedule_no    TEXT NOT NULL,
  kind           TEXT NOT NULL,                    -- revenue | expense
  template_id    TEXT,
  source_txn_id  TEXT,
  source_line_id TEXT,
  item_id        TEXT,
  entity_type    TEXT,                             -- customer | vendor
  entity_id      TEXT,
  subsidiary_id  TEXT NOT NULL,
  department_id  TEXT,
  class_id       TEXT,
  deferral_account_id TEXT NOT NULL,               -- balance-sheet holding account
  target_account_id   TEXT NOT NULL,               -- income or expense account
  currency       TEXT NOT NULL DEFAULT 'USD',
  fx_rate        REAL NOT NULL DEFAULT 1.0,
  total_amount   INTEGER NOT NULL DEFAULT 0,       -- minor units, document currency
  posted_amount  INTEGER NOT NULL DEFAULT 0,       -- released so far
  start_date     TEXT NOT NULL,
  end_date       TEXT NOT NULL,
  memo           TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'active',   -- active | complete | cancelled
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_schedule_no ON schedule (tenant_id, schedule_no);
CREATE INDEX IF NOT EXISTS ix_schedule_src ON schedule (tenant_id, source_txn_id);
CREATE INDEX IF NOT EXISTS ix_schedule_status ON schedule (tenant_id, kind, status);

CREATE TABLE IF NOT EXISTS schedule_line (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  schedule_id   TEXT NOT NULL,
  period_no     INTEGER NOT NULL,
  plan_date     TEXT NOT NULL,                     -- the day the slice is due
  amount        INTEGER NOT NULL DEFAULT 0,        -- document currency
  status        TEXT NOT NULL DEFAULT 'planned',   -- planned | posted | held
  entry_id      TEXT,                              -- journal entry that released it
  posted_at     TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_sched_line ON schedule_line (tenant_id, schedule_id, period_no);
CREATE INDEX IF NOT EXISTS ix_sched_line_due ON schedule_line (tenant_id, status, plan_date);
