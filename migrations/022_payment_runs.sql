-- =====================================================================
-- Meridian ERP :: 022_payment_runs
-- Paying the suppliers, once a week, in one sitting.
--
-- Paying bills one at a time works until there are two hundred of them. What
-- an accounts payable clerk actually does is pick a date, look at everything
-- falling due before it, take a few things off the list, and send one payment
-- to each supplier covering whatever of theirs is left on it.
--
-- So the run is the object: a proposal that can be edited before it is
-- committed, and a record afterwards of exactly which bills each payment
-- settled -- which is the only thing the supplier's remittance advice can be
-- built from, and the first thing anybody asks when a payment is queried.
-- =====================================================================

CREATE TABLE IF NOT EXISTS payment_run (
  id             TEXT NOT NULL,
  tenant_id      TEXT NOT NULL,
  run_no         TEXT NOT NULL,
  subsidiary_id  TEXT NOT NULL,
  bank_account_id TEXT NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'USD',
  payment_date   TEXT NOT NULL,               -- when the money leaves
  pay_through    TEXT NOT NULL,               -- include bills due on or before
  memo           TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'draft', -- draft | paid | cancelled
  vendor_count   INTEGER NOT NULL DEFAULT 0,
  bill_count     INTEGER NOT NULL DEFAULT 0,
  total          INTEGER NOT NULL DEFAULT 0,  -- selected, in run currency
  created_at     TEXT NOT NULL,
  created_by     TEXT,
  paid_at        TEXT,
  paid_by        TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_payrun_no ON payment_run (tenant_id, run_no);
CREATE INDEX IF NOT EXISTS ix_payrun_status ON payment_run (tenant_id, status, payment_date);

CREATE TABLE IF NOT EXISTS payment_run_line (
  id             TEXT NOT NULL,
  tenant_id      TEXT NOT NULL,
  run_id         TEXT NOT NULL,
  vendor_id      TEXT NOT NULL,
  txn_id         TEXT NOT NULL,               -- the bill being settled
  currency       TEXT NOT NULL DEFAULT 'USD',
  due_date       TEXT,
  days_overdue   INTEGER NOT NULL DEFAULT 0,
  amount_due     INTEGER NOT NULL DEFAULT 0,  -- what is outstanding on the bill
  amount_pay     INTEGER NOT NULL DEFAULT 0,  -- what this run will pay of it
  selected       INTEGER NOT NULL DEFAULT 1,
  payment_txn_id TEXT,                        -- filled in when the run commits
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_payrun_line ON payment_run_line (tenant_id, run_id, vendor_id);
CREATE INDEX IF NOT EXISTS ix_payrun_line_txn ON payment_run_line (tenant_id, txn_id);

-- Which run produced a payment, so a payment can point back at its remittance.
ALTER TABLE txn ADD COLUMN payment_run_id TEXT;

-- Suppliers can be held out of every run without being made inactive: a
-- dispute, a missing bank mandate, an account under review.
ALTER TABLE vendor ADD COLUMN payment_hold INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vendor ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'bank_transfer';
ALTER TABLE vendor ADD COLUMN bank_reference TEXT NOT NULL DEFAULT '';
ALTER TABLE vendor ADD COLUMN remittance_email TEXT NOT NULL DEFAULT '';
