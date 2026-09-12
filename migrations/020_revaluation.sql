-- =====================================================================
-- Meridian ERP :: 020_revaluation
-- Period-end revaluation of foreign-currency balances.
--
-- A sterling invoice raised in January at 1.25 is still carried at 1.25 in
-- March, when the rate is 1.40. The company is owed the same £2,000 but that
-- is now worth $2,800, not $2,500 -- and until somebody says so, the balance
-- sheet is understated by $300 that nothing in the ledger accounts for.
--
-- The adjustment is unrealised: nothing has been received, and the rate may
-- go back. So it posts on the last day of the period and reverses on the
-- first day of the next, leaving the underlying documents at the rate they
-- were booked at -- which is what settlement needs in order to work out the
-- realised difference when the money finally arrives.
-- =====================================================================

INSERT INTO account (id, tenant_id, number, name, type, subtype, parent_id, currency,
                     subsidiary_id, is_summary, cash_flow_category, description, active,
                     custom, created_at, updated_at)
SELECT 'ACC' || substr(hex(randomblob(11)), 1, 22),
       t.id, '7035', 'Unrealised FX Gain/Loss', 'EXPENSE', 'OTHER_EXPENSE',
       (SELECT p.id FROM account p WHERE p.tenant_id = t.id AND p.number = '7000'),
       NULL, NULL, 0, '',
       'Movement on open foreign-currency balances, before the money moves.', 1, '{}',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM tenant t
WHERE NOT EXISTS (SELECT 1 FROM account a WHERE a.tenant_id = t.id AND a.number = '7035');

CREATE TABLE IF NOT EXISTS revaluation_run (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  run_no        TEXT NOT NULL,
  subsidiary_id TEXT NOT NULL,
  base_currency TEXT NOT NULL,
  as_of         TEXT NOT NULL,               -- the date the rates are read at
  period_id     TEXT NOT NULL,
  reverse_on    TEXT NOT NULL,               -- first day of the following period
  scopes        TEXT NOT NULL DEFAULT '[]',  -- JSON array of the exposures included
  gain          INTEGER NOT NULL DEFAULT 0,  -- base minor units, positive
  loss          INTEGER NOT NULL DEFAULT 0,
  net           INTEGER NOT NULL DEFAULT 0,  -- gain - loss, debit-positive
  entry_id      TEXT,
  reversal_entry_id TEXT,
  status        TEXT NOT NULL DEFAULT 'posted', -- posted | reversed
  memo          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  created_by    TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_reval_no ON revaluation_run (tenant_id, run_no);
CREATE INDEX IF NOT EXISTS ix_reval_period ON revaluation_run (tenant_id, subsidiary_id, as_of);

-- One row per exposure that moved: a document, or a bank account. Kept so the
-- run can be explained a year later without recomputing rates nobody stored.
CREATE TABLE IF NOT EXISTS revaluation_line (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  scope         TEXT NOT NULL,               -- receivable | payable | bank
  account_id    TEXT NOT NULL,               -- the control or bank GL account
  currency      TEXT NOT NULL,
  entity_type   TEXT,
  entity_id     TEXT,
  txn_id        TEXT,
  bank_account_id TEXT,
  label         TEXT NOT NULL DEFAULT '',
  foreign_amount INTEGER NOT NULL DEFAULT 0, -- balance in `currency`
  rate_booked   REAL NOT NULL DEFAULT 1.0,
  rate_used     REAL NOT NULL DEFAULT 1.0,
  booked_base   INTEGER NOT NULL DEFAULT 0,
  revalued_base INTEGER NOT NULL DEFAULT 0,
  adjustment    INTEGER NOT NULL DEFAULT 0,  -- revalued - booked, debit-positive
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_reval_line ON revaluation_line (tenant_id, run_id, scope);
