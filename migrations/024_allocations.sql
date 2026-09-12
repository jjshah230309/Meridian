-- =====================================================================
-- Meridian ERP :: 024_allocations
-- Statistical accounts, and the schedules that spread cost by them.
--
-- Rent, IT and insurance arrive as one invoice and belong to five
-- departments. Splitting them by hand every month is the job nobody wants,
-- and splitting them by a number typed from memory is the one nobody can
-- audit. So two things go in.
--
-- A statistical account holds a quantity that is not money: headcount, square
-- footage, machine hours. It posts like any other account and is excluded
-- from every financial statement, because forty-two employees is not forty-two
-- dollars and adding it to the balance sheet is how a trial balance stops
-- balancing.
--
-- An allocation schedule says: take what landed on these accounts, and move
-- it to these ones, in these proportions -- either fixed weights, or whatever
-- the statistical accounts say this month. Run it and the split is a journal
-- entry with its workings attached.
-- =====================================================================

-- A quantity, not an amount. Kept out of the statements entirely.
ALTER TABLE account ADD COLUMN is_statistical INTEGER NOT NULL DEFAULT 0;
ALTER TABLE account ADD COLUMN statistical_unit TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS allocation_schedule (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  subsidiary_id TEXT NOT NULL,
  -- fixed       -- the weights on the targets, as given
  -- statistical -- this period's balance on each target's statistical account
  method        TEXT NOT NULL DEFAULT 'fixed',
  frequency     TEXT NOT NULL DEFAULT 'monthly',  -- monthly|quarterly|annually
  -- Where the source balance is taken from: the period being allocated, or
  -- everything not yet allocated.
  basis         TEXT NOT NULL DEFAULT 'period',
  -- Cost is moved off the source accounts onto the targets. Left empty the
  -- source account is credited directly; naming a clearing account leaves the
  -- original cost visible where it was first booked.
  clearing_account_id TEXT,
  next_date     TEXT NOT NULL,
  last_run_date TEXT,
  occurrences   INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active',   -- active | paused | ended
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_alloc_name ON allocation_schedule (tenant_id, name);
CREATE INDEX IF NOT EXISTS ix_alloc_due ON allocation_schedule (tenant_id, status, next_date);

-- What is being spread.
CREATE TABLE IF NOT EXISTS allocation_source (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  schedule_id   TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  department_id TEXT,
  class_id      TEXT,
  location_id   TEXT,
  -- Allocate only part of what landed there: 100 means all of it.
  percent       REAL NOT NULL DEFAULT 100,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_alloc_source ON allocation_source (tenant_id, schedule_id);

-- Where it goes, and in what proportion.
CREATE TABLE IF NOT EXISTS allocation_target (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  schedule_id   TEXT NOT NULL,
  line_no       INTEGER NOT NULL DEFAULT 1,
  account_id    TEXT,                             -- null = keep the source account
  department_id TEXT,
  class_id      TEXT,
  location_id   TEXT,
  weight        REAL NOT NULL DEFAULT 1,          -- used when method = fixed
  statistical_account_id TEXT,                    -- used when method = statistical
  memo          TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_alloc_target ON allocation_target (tenant_id, schedule_id, line_no);

-- Each run, so the split can be explained a year later.
CREATE TABLE IF NOT EXISTS allocation_run (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  run_no        TEXT NOT NULL,
  schedule_id   TEXT NOT NULL,
  period_id     TEXT NOT NULL,
  txn_date      TEXT NOT NULL,
  amount        INTEGER NOT NULL DEFAULT 0,
  entry_id      TEXT,
  weights       TEXT NOT NULL DEFAULT '[]',       -- JSON: the weights actually used
  created_at    TEXT NOT NULL,
  created_by    TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_alloc_run_no ON allocation_run (tenant_id, run_no);
CREATE INDEX IF NOT EXISTS ix_alloc_run ON allocation_run (tenant_id, schedule_id, txn_date);

-- Which run moved a journal entry's worth of cost, so an allocated figure on
-- a report can be traced back to the schedule that produced it.
ALTER TABLE journal_entry ADD COLUMN allocation_run_id TEXT;
