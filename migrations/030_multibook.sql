-- =====================================================================
-- Meridian ERP :: 030_multibook
-- Keeping more than one set of books over the same transactions.
--
-- A group filing under IFRS in one place and local GAAP in another does not
-- have two businesses. It has one business and two ways of measuring it: the
-- same invoices, the same payments, the same assets, told twice because two
-- sets of rules disagree about when revenue is earned and how long a machine
-- lasts.
--
-- The design question is where the second telling lives, and it has a wrong
-- answer that is very tempting: copy every entry into every book. That means
-- every query in the product -- and there are more than fifty that add up
-- amounts -- has to know which book it means. Miss one and the profit and
-- loss silently doubles. In an accounting system that is the worst failure
-- there is, because it looks like an answer.
--
-- So a secondary book holds only what DIFFERS from the primary, in its own
-- tables, and a report for that book is the primary plus those differences.
-- Nothing that reads the ledger today has to change, the primary book cannot
-- be corrupted by this feature at all, and the difference between two bases
-- is a thing you can actually look at -- which is what an auditor asks for
-- anyway.
--
-- This is the shape NetSuite calls an adjustment-only book. It is the common
-- configuration for the same reason.
-- =====================================================================

CREATE TABLE IF NOT EXISTS accounting_book (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  name          TEXT NOT NULL,
  code          TEXT NOT NULL,
  -- Exactly one book per tenant is primary. It is the ledger every other
  -- part of Meridian already writes to, and it cannot be deleted or demoted.
  is_primary    INTEGER NOT NULL DEFAULT 0,
  -- What this book is for, in the reader's words: 'IFRS', 'Local GAAP',
  -- 'Tax', 'Management'. Not enforced -- it is a label, not a rulebook.
  purpose       TEXT NOT NULL DEFAULT '',
  basis         TEXT NOT NULL DEFAULT 'accrual',   -- accrual | cash
  description   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active',    -- active | inactive
  created_at    TEXT NOT NULL,
  created_by    TEXT,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_book_code ON accounting_book (tenant_id, code);
-- One primary, enforced by the database rather than by everybody remembering.
CREATE UNIQUE INDEX IF NOT EXISTS ux_book_primary ON accounting_book (tenant_id) WHERE is_primary = 1;

-- A difference between this book and the primary one. Deliberately shaped like
-- a journal entry, because that is what it is -- but kept in its own table so
-- that no existing query can pick it up by accident.
CREATE TABLE IF NOT EXISTS book_adjustment (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  book_id       TEXT NOT NULL,
  entry_no      TEXT NOT NULL,
  subsidiary_id TEXT NOT NULL,
  period_id     TEXT NOT NULL,
  txn_date      TEXT NOT NULL,
  memo          TEXT NOT NULL DEFAULT '',
  -- manual       -- somebody posted it
  -- depreciation -- this book depreciates an asset differently
  -- revenue      -- this book earns revenue on a different schedule
  source_type   TEXT NOT NULL DEFAULT 'manual',
  source_id     TEXT,
  -- What it is adjusting, so a run can tell whether it has already done this
  -- period and not do it twice.
  source_key    TEXT,
  total_debit   INTEGER NOT NULL DEFAULT 0,
  total_credit  INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'posted',    -- posted | reversed
  is_reversal   INTEGER NOT NULL DEFAULT 0,
  reverses_id   TEXT,
  reversed_by_id TEXT,
  created_at    TEXT NOT NULL,
  created_by    TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_book_adj_no ON book_adjustment (tenant_id, entry_no);
CREATE INDEX IF NOT EXISTS ix_book_adj_book ON book_adjustment (tenant_id, book_id, txn_date);
CREATE INDEX IF NOT EXISTS ix_book_adj_period ON book_adjustment (tenant_id, book_id, period_id);
-- A rule-driven adjustment happens once per thing per period, whatever else
-- happens. This is what makes a re-run cost nothing.
CREATE UNIQUE INDEX IF NOT EXISTS ux_book_adj_source
  ON book_adjustment (tenant_id, book_id, source_key)
  WHERE source_key IS NOT NULL AND status = 'posted';

CREATE TABLE IF NOT EXISTS book_adjustment_line (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  adjustment_id TEXT NOT NULL,
  line_no       INTEGER NOT NULL DEFAULT 1,
  account_id    TEXT NOT NULL,
  base_debit    INTEGER NOT NULL DEFAULT 0,
  base_credit   INTEGER NOT NULL DEFAULT 0,
  memo          TEXT NOT NULL DEFAULT '',
  department_id TEXT,
  location_id   TEXT,
  class_id      TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_book_adj_line ON book_adjustment_line (tenant_id, adjustment_id, line_no);

-- Rolled up the same way gl_balance is, and for the same reason: a report
-- that had to re-add every line since the company started would be unusable
-- by the second year.
CREATE TABLE IF NOT EXISTS book_balance (
  tenant_id     TEXT NOT NULL,
  book_id       TEXT NOT NULL,
  subsidiary_id TEXT NOT NULL,
  period_id     TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  base_debit    INTEGER NOT NULL DEFAULT 0,
  base_credit   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, book_id, subsidiary_id, period_id, account_id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_book_balance_acct ON book_balance (tenant_id, book_id, account_id, period_id);

-- How a book depreciates an asset differently. The commonest reason a company
-- needs a second set of books at all: the same machine is five years under one
-- set of rules and eight under another.
CREATE TABLE IF NOT EXISTS asset_book_rule (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  book_id       TEXT NOT NULL,
  asset_id      TEXT NOT NULL,
  method        TEXT NOT NULL DEFAULT 'STRAIGHT_LINE',
  life_months   INTEGER NOT NULL DEFAULT 60,
  salvage_value INTEGER NOT NULL DEFAULT 0,
  declining_rate REAL NOT NULL DEFAULT 2.0,
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_asset_book_rule ON asset_book_rule (tenant_id, book_id, asset_id);
CREATE INDEX IF NOT EXISTS ix_asset_book_rule_book ON asset_book_rule (tenant_id, book_id);

-- Every tenant gets the primary book, standing for the ledger it already has.
INSERT INTO accounting_book (id, tenant_id, name, code, is_primary, purpose, basis, description, status, created_at, updated_at)
SELECT lower(hex(randomblob(16))), t.id, 'Primary', 'PRIMARY', 1, 'Statutory', 'accrual',
       'The ledger itself. Everything posts here; other books record only where they differ from it.',
       'active', datetime('now'), datetime('now')
FROM tenant t
WHERE NOT EXISTS (SELECT 1 FROM accounting_book b WHERE b.tenant_id = t.id AND b.is_primary = 1);
