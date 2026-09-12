-- =====================================================================
-- Meridian ERP :: 019_recurring
-- Recurring journals, and the accruals that reverse themselves.
--
-- Every month a controller posts the same handful of entries: rent, the
-- depreciation of something outside the register, a management charge. And
-- every month end they accrue for invoices that have not arrived, then
-- reverse the accrual on the first of the next month so the real invoice does
-- not double-count. Both are the same object: a template, a calendar, and a
-- switch for whether the entry unwinds itself.
-- =====================================================================

CREATE TABLE IF NOT EXISTS recurring_journal (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  name          TEXT NOT NULL,
  subsidiary_id TEXT NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  memo          TEXT NOT NULL DEFAULT '',
  frequency     TEXT NOT NULL DEFAULT 'monthly',  -- weekly|monthly|quarterly|annually
  day_rule      TEXT NOT NULL DEFAULT 'month_end',-- month_end | day_of_month
  day_of_month  INTEGER NOT NULL DEFAULT 1,
  start_date    TEXT NOT NULL,
  end_date      TEXT,                             -- null = runs until paused
  next_date     TEXT NOT NULL,                    -- the next occurrence due
  -- An accrual: post it at period end, unwind it on the first day of the next
  -- period, so the invoice that eventually turns up is not counted twice.
  auto_reverse  INTEGER NOT NULL DEFAULT 0,
  occurrences   INTEGER NOT NULL DEFAULT 0,       -- how many times it has run
  max_occurrences INTEGER NOT NULL DEFAULT 0,     -- 0 = no limit
  last_run_date TEXT,
  status        TEXT NOT NULL DEFAULT 'active',   -- active | paused | ended
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_recurring_name ON recurring_journal (tenant_id, name);
CREATE INDEX IF NOT EXISTS ix_recurring_due ON recurring_journal (tenant_id, status, next_date);

CREATE TABLE IF NOT EXISTS recurring_journal_line (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  recurring_id  TEXT NOT NULL,
  line_no       INTEGER NOT NULL,
  account_id    TEXT NOT NULL,
  debit         INTEGER NOT NULL DEFAULT 0,
  credit        INTEGER NOT NULL DEFAULT 0,
  memo          TEXT NOT NULL DEFAULT '',
  department_id TEXT,
  class_id      TEXT,
  entity_type   TEXT,
  entity_id     TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_recurring_line ON recurring_journal_line (tenant_id, recurring_id, line_no);

-- Which recurring template produced a journal entry, so the ledger can say
-- where an entry came from and the template can show its own history.
ALTER TABLE journal_entry ADD COLUMN recurring_id TEXT;
