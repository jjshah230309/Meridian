-- =====================================================================
-- Meridian ERP :: 006_assets_budget
-- Fixed assets with a posted depreciation schedule, budgeting and
-- forecasting, and the pieces consolidation needs.
--
-- Depreciation is not computed on the fly. Each asset gets an explicit
-- schedule row per period at the moment it is placed in service, so the
-- forecast is auditable, a period can be re-run without drift, and the
-- posted rows always reconcile to accumulated depreciation on the asset.
-- =====================================================================

CREATE TABLE IF NOT EXISTS asset_class (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  name          TEXT NOT NULL,
  -- Defaults inherited by every asset of the class; an asset may override.
  method        TEXT NOT NULL DEFAULT 'STRAIGHT_LINE',
  life_months   INTEGER NOT NULL DEFAULT 60,
  salvage_pct   REAL NOT NULL DEFAULT 0,
  declining_rate REAL NOT NULL DEFAULT 2.0,       -- factor for DECLINING_BALANCE
  asset_account_id       TEXT,
  accum_account_id       TEXT,
  expense_account_id     TEXT,
  disposal_account_id    TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS fixed_asset (
  id              TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  asset_no        TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  class_id        TEXT,
  subsidiary_id   TEXT NOT NULL,
  location_id     TEXT,
  department_id   TEXT,
  serial_no       TEXT NOT NULL DEFAULT '',
  supplier_id     TEXT,                            -- vendor it was bought from
  source_txn_id   TEXT,                            -- the bill that capitalised it
  currency        TEXT NOT NULL DEFAULT 'USD',

  acquisition_date TEXT NOT NULL,
  in_service_date  TEXT,
  cost             INTEGER NOT NULL DEFAULT 0,     -- minor units
  salvage_value    INTEGER NOT NULL DEFAULT 0,
  method           TEXT NOT NULL DEFAULT 'STRAIGHT_LINE',
  life_months      INTEGER NOT NULL DEFAULT 60,
  declining_rate   REAL NOT NULL DEFAULT 2.0,
  total_units      INTEGER NOT NULL DEFAULT 0,     -- UNITS_OF_PRODUCTION only
  units_used       INTEGER NOT NULL DEFAULT 0,

  asset_account_id   TEXT,
  accum_account_id   TEXT,
  expense_account_id TEXT,

  accumulated_depreciation INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'draft',   -- draft|active|fully_depreciated|disposed
  disposal_date   TEXT,
  disposal_proceeds INTEGER NOT NULL DEFAULT 0,
  disposal_entry_id TEXT,

  custom          TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_fixed_asset_no ON fixed_asset (tenant_id, asset_no);
CREATE INDEX IF NOT EXISTS ix_fixed_asset_status ON fixed_asset (tenant_id, status, in_service_date);

CREATE TABLE IF NOT EXISTS depreciation_line (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  asset_id      TEXT NOT NULL,
  period_no     INTEGER NOT NULL,                  -- 1-based within the asset's life
  depr_date     TEXT NOT NULL,                     -- last day of the period
  period_id     TEXT,
  amount        INTEGER NOT NULL DEFAULT 0,
  accumulated   INTEGER NOT NULL DEFAULT 0,
  book_value    INTEGER NOT NULL DEFAULT 0,
  posted        INTEGER NOT NULL DEFAULT 0,
  journal_entry_id TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_depr_asset ON depreciation_line (tenant_id, asset_id, period_no);
CREATE INDEX IF NOT EXISTS ix_depr_due ON depreciation_line (tenant_id, posted, depr_date);

-- ------------------------------------------------------------ budgeting
CREATE TABLE IF NOT EXISTS budget (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  name          TEXT NOT NULL,
  scenario      TEXT NOT NULL DEFAULT 'budget',    -- budget|forecast|plan
  fiscal_year   INTEGER NOT NULL,
  subsidiary_id TEXT,
  currency      TEXT NOT NULL DEFAULT 'USD',
  status        TEXT NOT NULL DEFAULT 'draft',     -- draft|approved|locked
  notes         TEXT NOT NULL DEFAULT '',
  custom        TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_budget_year ON budget (tenant_id, fiscal_year, scenario);

CREATE TABLE IF NOT EXISTS budget_line (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  budget_id     TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  period_id     TEXT NOT NULL,
  department_id TEXT,
  class_id      TEXT,
  location_id   TEXT,
  amount        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_budget_line ON budget_line (tenant_id, budget_id, account_id, period_id);

-- --------------------------------------------------------- consolidation
-- An intercompany account nets to zero across the group, so consolidated
-- statements must drop it. Flagging the account (rather than keeping a
-- separate rule table) keeps the decision next to the thing it describes.
ALTER TABLE account ADD COLUMN is_intercompany INTEGER NOT NULL DEFAULT 0;

-- Rates used to translate a subsidiary's ledger into the parent currency.
-- Balance-sheet accounts translate at the closing rate, income-statement
-- accounts at the period average; the difference lands in CTA.
CREATE TABLE IF NOT EXISTS consolidation_rate (
  tenant_id     TEXT NOT NULL,
  period_id     TEXT NOT NULL,
  from_currency TEXT NOT NULL,
  to_currency   TEXT NOT NULL,
  closing_rate  REAL NOT NULL,
  average_rate  REAL NOT NULL,
  historical_rate REAL,
  PRIMARY KEY (tenant_id, period_id, from_currency, to_currency)
) STRICT;
