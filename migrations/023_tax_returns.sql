-- =====================================================================
-- Meridian ERP :: 023_tax_returns
-- The sales tax return, and the 1099s.
--
-- Tax collected on sales and tax paid on purchases both land on one control
-- account, which nets to what is owed. That number is easy. What is hard is
-- everything around it: which transactions it came from, whether a late bill
-- entered after the quarter closed has been claimed yet, and being able to
-- answer both questions two years later when somebody audits the filing.
--
-- So a return is a snapshot with its workings attached, and filing it stamps
-- every transaction it counted. A transaction can therefore be counted once
-- and exactly once -- a late one simply falls into the next return, which is
-- what the tax authority expects anyway.
-- =====================================================================

CREATE TABLE IF NOT EXISTS tax_return (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  return_no     TEXT NOT NULL,
  subsidiary_id TEXT NOT NULL,
  country       TEXT NOT NULL DEFAULT '',
  currency      TEXT NOT NULL DEFAULT 'USD',
  period_from   TEXT NOT NULL,
  period_to     TEXT NOT NULL,
  -- Output tax charged on sales, input tax suffered on purchases, and the
  -- difference: positive is owed to the authority, negative is reclaimable.
  sales_net     INTEGER NOT NULL DEFAULT 0,
  output_tax    INTEGER NOT NULL DEFAULT 0,
  purchases_net INTEGER NOT NULL DEFAULT 0,
  input_tax     INTEGER NOT NULL DEFAULT 0,
  net_tax       INTEGER NOT NULL DEFAULT 0,
  -- Transactions dated before the period that had never been returned. They
  -- belong in this one; saying how many keeps the figures explainable.
  late_count    INTEGER NOT NULL DEFAULT 0,
  late_tax      INTEGER NOT NULL DEFAULT 0,
  txn_count     INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'draft',  -- draft | filed
  reference     TEXT NOT NULL DEFAULT '',       -- the authority's receipt
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  created_by    TEXT,
  filed_at      TEXT,
  filed_by      TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_tax_return_no ON tax_return (tenant_id, return_no);
CREATE INDEX IF NOT EXISTS ix_tax_return_period ON tax_return (tenant_id, subsidiary_id, period_to);

CREATE TABLE IF NOT EXISTS tax_return_line (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  return_id     TEXT NOT NULL,
  tax_code      TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  rate          REAL NOT NULL DEFAULT 0,
  sales_net     INTEGER NOT NULL DEFAULT 0,
  output_tax    INTEGER NOT NULL DEFAULT 0,
  purchases_net INTEGER NOT NULL DEFAULT 0,
  input_tax     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_tax_return_line ON tax_return_line (tenant_id, return_id);

-- Which return counted this transaction. Null means it is still to be
-- returned, whatever its date, which is how a late entry finds its way into
-- the next filing instead of being lost behind a closed quarter.
ALTER TABLE txn ADD COLUMN tax_return_id TEXT;
CREATE INDEX IF NOT EXISTS ix_txn_tax_return ON txn (tenant_id, tax_return_id);

-- 1099 reporting. The flag already existed; what was missing was which form
-- and which box, without which a total is not a filing.
-- A supplier has a tax position too: what they charge us is the input tax we
-- reclaim. Reading the rate only from the customer left every purchase
-- untaxed and the input side of every return at zero.
ALTER TABLE vendor ADD COLUMN tax_code TEXT NOT NULL DEFAULT '';
ALTER TABLE vendor ADD COLUMN tax_form TEXT NOT NULL DEFAULT '1099-NEC';
ALTER TABLE vendor ADD COLUMN tax_form_box TEXT NOT NULL DEFAULT '1';
