-- =====================================================================
-- Meridian ERP :: 002_finance
-- General Ledger, chart of accounts, periods, multi-currency,
-- multi-subsidiary, and the materialised balance rollup.
--
-- The GL is the system of record. Every subledger document (invoice,
-- bill, fulfilment, payment, payroll run, inventory adjustment) posts a
-- balanced journal_entry through src/modules/gl.mjs::postJournal.
-- Posted entries are immutable: corrections are made by reversal.
-- =====================================================================

CREATE TABLE IF NOT EXISTS subsidiary (
  id             TEXT NOT NULL,
  tenant_id      TEXT NOT NULL,
  name           TEXT NOT NULL,
  legal_name     TEXT NOT NULL DEFAULT '',
  parent_id      TEXT,
  currency       TEXT NOT NULL,
  country        TEXT NOT NULL DEFAULT 'US',
  tax_number     TEXT NOT NULL DEFAULT '',
  address        TEXT NOT NULL DEFAULT '{}',
  is_elimination INTEGER NOT NULL DEFAULT 0,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS currency (
  tenant_id  TEXT NOT NULL,
  code       TEXT NOT NULL,              -- ISO 4217
  name       TEXT NOT NULL,
  symbol     TEXT NOT NULL DEFAULT '',
  precision  INTEGER NOT NULL DEFAULT 2,
  active     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, code)
) STRICT;

CREATE TABLE IF NOT EXISTS exchange_rate (
  tenant_id     TEXT NOT NULL,
  from_currency TEXT NOT NULL,
  to_currency   TEXT NOT NULL,
  rate_date     TEXT NOT NULL,
  rate          REAL NOT NULL,
  source        TEXT NOT NULL DEFAULT 'manual',
  PRIMARY KEY (tenant_id, from_currency, to_currency, rate_date)
) STRICT;

-- Accounting segments (NetSuite: department / class / location classifications)
CREATE TABLE IF NOT EXISTS department (
  id TEXT NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
  parent_id TEXT, subsidiary_id TEXT, active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS segment_class (
  id TEXT NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
  parent_id TEXT, active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id)
) STRICT;

-- Chart of accounts.
-- type drives the normal balance and which statement the account rolls into.
CREATE TABLE IF NOT EXISTS account (
  id          TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  number      TEXT NOT NULL,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,   -- ASSET|LIABILITY|EQUITY|INCOME|EXPENSE
  subtype     TEXT NOT NULL DEFAULT '',
                               -- BANK|AR|INVENTORY|FIXED_ASSET|OTHER_CURRENT_ASSET|
                               -- AP|CREDIT_CARD|OTHER_CURRENT_LIABILITY|LONG_TERM_LIABILITY|
                               -- RETAINED_EARNINGS|COMMON_STOCK|REVENUE|OTHER_INCOME|
                               -- COGS|OPERATING_EXPENSE|OTHER_EXPENSE
  parent_id   TEXT,
  currency    TEXT,            -- NULL = multi-currency / base
  subsidiary_id TEXT,          -- NULL = shared across subsidiaries
  is_summary  INTEGER NOT NULL DEFAULT 0,   -- summary accounts cannot be posted to
  cash_flow_category TEXT NOT NULL DEFAULT '', -- operating|investing|financing
  description TEXT NOT NULL DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1,
  custom      TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_account_number ON account(tenant_id, number);
CREATE INDEX IF NOT EXISTS ix_account_type ON account(tenant_id, type, active);

CREATE TABLE IF NOT EXISTS accounting_period (
  id          TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  name        TEXT NOT NULL,             -- 'Jan 2026'
  start_date  TEXT NOT NULL,
  end_date    TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL,
  quarter     INTEGER NOT NULL,
  period_no   INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',  -- open | closed | locked
  is_adjustment INTEGER NOT NULL DEFAULT 0,
  closed_at   TEXT,
  closed_by   TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_period_range ON accounting_period(tenant_id, start_date);
CREATE INDEX IF NOT EXISTS ix_period_lookup ON accounting_period(tenant_id, start_date, end_date);

-- ---------------- Journal ----------------

CREATE TABLE IF NOT EXISTS journal_entry (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  entry_no      TEXT NOT NULL,
  subsidiary_id TEXT NOT NULL,
  period_id     TEXT NOT NULL,
  txn_date      TEXT NOT NULL,
  currency      TEXT NOT NULL,
  fx_rate       REAL NOT NULL DEFAULT 1.0,
  memo          TEXT NOT NULL DEFAULT '',
  source_type   TEXT NOT NULL DEFAULT 'manual', -- manual|invoice|bill|payment|fulfillment|receipt|payroll|inventory|revaluation|close
  source_id     TEXT,
  status        TEXT NOT NULL DEFAULT 'posted', -- draft | posted | voided
  is_reversal   INTEGER NOT NULL DEFAULT 0,
  reverses_id   TEXT,
  reversed_by_id TEXT,
  total_debit   INTEGER NOT NULL DEFAULT 0,     -- base currency minor units
  total_credit  INTEGER NOT NULL DEFAULT 0,
  posted_at     TEXT,
  posted_by     TEXT,
  approval_status TEXT NOT NULL DEFAULT 'approved',
  custom        TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  created_by    TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_je_no ON journal_entry(tenant_id, entry_no);
CREATE INDEX IF NOT EXISTS ix_je_period ON journal_entry(tenant_id, period_id, status);
CREATE INDEX IF NOT EXISTS ix_je_source ON journal_entry(tenant_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS ix_je_date ON journal_entry(tenant_id, txn_date);

CREATE TABLE IF NOT EXISTS journal_line (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  entry_id      TEXT NOT NULL,
  line_no       INTEGER NOT NULL,
  account_id    TEXT NOT NULL,
  memo          TEXT NOT NULL DEFAULT '',
  -- transaction currency amounts
  debit         INTEGER NOT NULL DEFAULT 0,
  credit        INTEGER NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL,
  fx_rate       REAL NOT NULL DEFAULT 1.0,
  -- base (subsidiary) currency amounts -- what the trial balance sums
  base_debit    INTEGER NOT NULL DEFAULT 0,
  base_credit   INTEGER NOT NULL DEFAULT 0,
  entity_type   TEXT,       -- customer | vendor | employee
  entity_id     TEXT,
  department_id TEXT,
  location_id   TEXT,
  class_id      TEXT,
  item_id       TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_jl_entry ON journal_line(tenant_id, entry_id, line_no);
CREATE INDEX IF NOT EXISTS ix_jl_account ON journal_line(tenant_id, account_id);
CREATE INDEX IF NOT EXISTS ix_jl_entity ON journal_line(tenant_id, entity_type, entity_id);

-- Materialised per-period account balances. Maintained inside the same
-- transaction as the journal write, so it can never drift; reports read it
-- instead of scanning journal_line. Verified by /api/v1/reports/integrity.
CREATE TABLE IF NOT EXISTS gl_balance (
  tenant_id     TEXT NOT NULL,
  subsidiary_id TEXT NOT NULL,
  period_id     TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  base_debit    INTEGER NOT NULL DEFAULT 0,
  base_credit   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, subsidiary_id, period_id, account_id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_glbal_acct ON gl_balance(tenant_id, account_id, period_id);

-- ---------------- Cash management ----------------

CREATE TABLE IF NOT EXISTS bank_account (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  name          TEXT NOT NULL,
  account_id    TEXT NOT NULL,           -- GL account
  subsidiary_id TEXT NOT NULL,
  bank_name     TEXT NOT NULL DEFAULT '',
  number_masked TEXT NOT NULL DEFAULT '',
  routing_masked TEXT NOT NULL DEFAULT '',
  currency      TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS bank_txn (
  id              TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  bank_account_id TEXT NOT NULL,
  txn_date        TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  reference       TEXT NOT NULL DEFAULT '',
  amount          INTEGER NOT NULL,      -- signed minor units; +deposit -withdrawal
  status          TEXT NOT NULL DEFAULT 'unmatched', -- unmatched|matched|reconciled|ignored
  matched_txn_id  TEXT,
  matched_journal_id TEXT,
  reconciliation_id TEXT,
  external_id     TEXT,
  imported_at     TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_banktxn ON bank_txn(tenant_id, bank_account_id, txn_date);
CREATE UNIQUE INDEX IF NOT EXISTS ux_banktxn_ext ON bank_txn(tenant_id, bank_account_id, external_id)
  WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS reconciliation (
  id              TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  bank_account_id TEXT NOT NULL,
  statement_date  TEXT NOT NULL,
  statement_balance INTEGER NOT NULL,
  cleared_balance INTEGER NOT NULL DEFAULT 0,
  difference      INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'in_progress',
  completed_at    TEXT,
  completed_by    TEXT,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
