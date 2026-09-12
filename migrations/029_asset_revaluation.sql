-- =====================================================================
-- Meridian ERP :: 029_asset_revaluation
-- When an asset stops being worth what the books say.
--
-- Depreciation is a plan: spread the cost over the years the thing is useful
-- for. Reality interferes. A building is worth more than it cost. A machine
-- is damaged, or the product it makes is discontinued, and it will never earn
-- back what is still sitting on the balance sheet. Neither is a depreciation
-- question, and neither can be handled by adjusting the schedule.
--
-- Two operations, and the difference between them is not cosmetic.
--
-- A REVALUATION restates the asset at a new carrying amount. Upwards it goes
-- to a revaluation reserve in equity, not to profit, because the gain has not
-- been realised -- nobody has sold anything. Downwards it first reverses any
-- reserve this asset previously built up, and only what is left goes to the
-- income statement. That order matters and is the part people get wrong.
--
-- An IMPAIRMENT writes the asset down to what it is actually worth, and
-- always goes to the income statement. It is a loss, and it is recognised.
--
-- Both change what remains to be depreciated, so both rebuild the schedule
-- from the date they take effect. Depreciation already posted is history and
-- is never touched: it was right when it was charged.
-- =====================================================================

CREATE TABLE IF NOT EXISTS asset_revaluation (
  id              TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  reference       TEXT NOT NULL,
  asset_id        TEXT NOT NULL,
  -- revaluation -- restated to a new value, up or down
  -- impairment  -- written down to what it is really worth, always a loss
  kind            TEXT NOT NULL DEFAULT 'revaluation',
  effective_date  TEXT NOT NULL,

  -- What the books said before, and what they say after. Kept rather than
  -- derived, because the schedule is rebuilt afterwards and the old figures
  -- would otherwise be unrecoverable.
  carrying_before INTEGER NOT NULL DEFAULT 0,
  carrying_after  INTEGER NOT NULL DEFAULT 0,
  adjustment      INTEGER NOT NULL DEFAULT 0,     -- after - before; negative is a write-down

  -- How the adjustment was split. An upward revaluation can be part reversal
  -- of an earlier loss (income) and part new reserve (equity); a downward one
  -- can be part reserve reversal and part loss.
  to_reserve      INTEGER NOT NULL DEFAULT 0,
  to_income       INTEGER NOT NULL DEFAULT 0,

  -- The remaining life from the effective date. Null keeps what was left.
  remaining_life_months INTEGER,

  reason          TEXT NOT NULL DEFAULT '',
  memo            TEXT NOT NULL DEFAULT '',
  journal_entry_id TEXT,
  status          TEXT NOT NULL DEFAULT 'posted',  -- posted | reversed
  reversed_at     TEXT,
  created_at      TEXT NOT NULL,
  created_by      TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_asset_reval_ref ON asset_revaluation (tenant_id, reference);
CREATE INDEX IF NOT EXISTS ix_asset_reval_asset ON asset_revaluation (tenant_id, asset_id, effective_date);

-- Moving an asset between the parts of the business that carry it. Not a
-- revaluation -- the asset is worth exactly what it was -- but it changes
-- whose depreciation charge it is from that date, which is why it is recorded
-- rather than quietly edited onto the record.
CREATE TABLE IF NOT EXISTS asset_transfer (
  id              TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  asset_id        TEXT NOT NULL,
  transfer_date   TEXT NOT NULL,
  from_subsidiary_id TEXT,
  to_subsidiary_id   TEXT,
  from_location_id   TEXT,
  to_location_id     TEXT,
  from_department_id TEXT,
  to_department_id   TEXT,
  reason          TEXT NOT NULL DEFAULT '',
  journal_entry_id TEXT,
  created_at      TEXT NOT NULL,
  created_by      TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_asset_transfer ON asset_transfer (tenant_id, asset_id, transfer_date);

-- What the asset has been written up or down by in total, so the next
-- revaluation knows how much reserve there is to reverse before it starts
-- charging the income statement.
ALTER TABLE fixed_asset ADD COLUMN revaluation_reserve INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fixed_asset ADD COLUMN impairment_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fixed_asset ADD COLUMN last_revalued_on TEXT;

-- The accounts the two operations post to.
INSERT INTO account (id, tenant_id, number, name, type, subtype, currency, cash_flow_category, description, created_at, updated_at)
SELECT lower(hex(randomblob(16))), t.id, '3850', 'Revaluation Reserve', 'EQUITY', 'OWNER_EQUITY',
       t.base_currency, 'financing', 'Gains on revaluing an asset upwards, which are not profit until it is sold.', datetime('now'), datetime('now')
FROM tenant t
WHERE NOT EXISTS (SELECT 1 FROM account a WHERE a.tenant_id = t.id AND a.number = '3850');

INSERT INTO account (id, tenant_id, number, name, type, subtype, currency, cash_flow_category, description, created_at, updated_at)
SELECT lower(hex(randomblob(16))), t.id, '7060', 'Impairment and Revaluation Loss', 'EXPENSE', 'OTHER_EXPENSE',
       t.base_currency, 'operating', 'Writing an asset down to what it is actually worth.', datetime('now'), datetime('now')
FROM tenant t
WHERE NOT EXISTS (SELECT 1 FROM account a WHERE a.tenant_id = t.id AND a.number = '7060');
