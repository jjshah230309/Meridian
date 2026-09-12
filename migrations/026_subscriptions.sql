-- =====================================================================
-- Meridian ERP :: 026_subscriptions
-- Selling the same thing every month.
--
-- A subscription is not an invoice that repeats. It is a contract with a
-- term, a price that can change part way through, seats that can be added
-- and removed, usage that is only known after the fact, and an ending that
-- either renews itself or does not. The invoices fall out of it.
--
-- Three rules shape the whole design.
--
-- One: a period is billed once. Every line of every period that has ever been
-- invoiced is recorded, so a run that is late, re-run, or run twice by two
-- people cannot bill the same month twice. This is the same discipline the
-- tax return uses, for the same reason.
--
-- Two: money and revenue are different questions. Billing a year up front is
-- a cash event; earning it is twelve monthly events. The invoice lines carry
-- the service period they cover, so the revenue recognition schedules already
-- in Meridian pick them up without knowing subscriptions exist.
--
-- Three: a change has a date. Adding ten seats on the 12th bills ten seats
-- for the rest of the month, not for the whole of it, and the amendment is
-- kept so the invoice can be explained to whoever queries it.
-- =====================================================================

CREATE TABLE IF NOT EXISTS subscription (
  id              TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  subscription_no TEXT NOT NULL,
  customer_id     TEXT NOT NULL,
  subsidiary_id   TEXT NOT NULL,
  name            TEXT NOT NULL DEFAULT '',
  currency        TEXT NOT NULL DEFAULT 'USD',
  price_level_id  TEXT,

  start_date      TEXT NOT NULL,
  -- The end of the current term. Null means evergreen: it runs until
  -- somebody cancels it.
  end_date        TEXT,
  term_months     INTEGER NOT NULL DEFAULT 0,

  billing_frequency TEXT NOT NULL DEFAULT 'monthly',  -- monthly|quarterly|annually
  -- Bill on a fixed day of the month, so a hundred customers land on one
  -- date rather than on a hundred anniversaries. 0 uses the start date's own
  -- anniversary. The first period is then short, and prorated.
  billing_day     INTEGER NOT NULL DEFAULT 0,
  -- Almost every subscription bills for the period ahead. Usage cannot: you
  -- do not know what somebody used until they have used it.
  bill_in_advance INTEGER NOT NULL DEFAULT 1,

  -- Billing has reached this date, exclusive. The next period starts here,
  -- which is what makes a period impossible to bill twice.
  billed_through  TEXT,
  next_bill_date  TEXT,

  auto_renew          INTEGER NOT NULL DEFAULT 1,
  renewal_term_months INTEGER NOT NULL DEFAULT 0,
  renewal_count       INTEGER NOT NULL DEFAULT 0,

  -- draft     -- being written, bills nothing
  -- active    -- live and billing
  -- suspended -- live but not billing (a dispute, a payment problem)
  -- cancelled -- ended early
  -- expired   -- reached the end of its term and did not renew
  status          TEXT NOT NULL DEFAULT 'draft',

  po_number       TEXT NOT NULL DEFAULT '',
  memo            TEXT NOT NULL DEFAULT '',
  -- Monthly recurring revenue, normalised: an annual line counts as a
  -- twelfth. Cached because every subscription report wants it.
  mrr             INTEGER NOT NULL DEFAULT 0,

  activated_at    TEXT,
  cancelled_at    TEXT,
  cancel_reason   TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  created_by      TEXT,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_subscription_no ON subscription (tenant_id, subscription_no);
CREATE INDEX IF NOT EXISTS ix_subscription_due ON subscription (tenant_id, status, next_bill_date);
CREATE INDEX IF NOT EXISTS ix_subscription_customer ON subscription (tenant_id, customer_id);

CREATE TABLE IF NOT EXISTS subscription_line (
  id              TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  line_no         INTEGER NOT NULL DEFAULT 1,
  item_id         TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  -- recurring -- the same charge every period (seats, a support plan)
  -- one_time  -- charged once, at the start (setup, migration, training)
  -- usage     -- charged for what was metered, in arrears
  model           TEXT NOT NULL DEFAULT 'recurring',

  quantity        INTEGER NOT NULL DEFAULT 0,   -- scaled 1e6
  unit_price      INTEGER NOT NULL DEFAULT 0,   -- per period, minor units
  discount_pct    REAL NOT NULL DEFAULT 0,

  -- A line can start after the subscription and end before it: an add-on
  -- bought in month four, a seat block given up in month nine.
  start_date      TEXT,
  end_date        TEXT,

  usage_uom          TEXT NOT NULL DEFAULT '',
  -- How much usage is included before anything is charged.
  included_quantity  INTEGER NOT NULL DEFAULT 0,

  status          TEXT NOT NULL DEFAULT 'active',  -- active | removed
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_subscription_line ON subscription_line (tenant_id, subscription_id, line_no);

-- What was metered. Recorded as it happens; billed for the period it falls in.
CREATE TABLE IF NOT EXISTS subscription_usage (
  id              TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  line_id         TEXT NOT NULL,
  usage_date      TEXT NOT NULL,
  quantity        INTEGER NOT NULL DEFAULT 0,
  memo            TEXT NOT NULL DEFAULT '',
  -- Set when the period containing it is billed, so the same usage cannot be
  -- charged twice however late the run is.
  billing_id      TEXT,
  created_at      TEXT NOT NULL,
  created_by      TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_usage_line ON subscription_usage (tenant_id, line_id, usage_date);
CREATE INDEX IF NOT EXISTS ix_usage_unbilled ON subscription_usage (tenant_id, subscription_id, billing_id);

-- One row per line per period ever billed. This table IS the guarantee that
-- nothing is billed twice; everything else is presentation.
CREATE TABLE IF NOT EXISTS subscription_billing (
  id              TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  line_id         TEXT NOT NULL,
  period_start    TEXT NOT NULL,
  period_end      TEXT NOT NULL,               -- exclusive
  quantity        INTEGER NOT NULL DEFAULT 0,
  unit_price      INTEGER NOT NULL DEFAULT 0,
  amount          INTEGER NOT NULL DEFAULT 0,
  -- A period shorter than a full one, because the line started or ended
  -- inside it. The fraction is kept so the figure can be explained.
  prorated        INTEGER NOT NULL DEFAULT 0,
  proration       REAL NOT NULL DEFAULT 1,
  invoice_txn_id  TEXT,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_billing_period ON subscription_billing (tenant_id, line_id, period_start);
CREATE INDEX IF NOT EXISTS ix_billing_sub ON subscription_billing (tenant_id, subscription_id, period_start);
CREATE INDEX IF NOT EXISTS ix_billing_invoice ON subscription_billing (tenant_id, invoice_txn_id);

-- Every amendment, so a bill that changed shape mid-term can be explained.
CREATE TABLE IF NOT EXISTS subscription_change (
  id              TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  line_id         TEXT,
  effective_date  TEXT NOT NULL,
  kind            TEXT NOT NULL,    -- activate|quantity|price|add|remove|suspend|resume|cancel|renew
  from_value      TEXT NOT NULL DEFAULT '',
  to_value        TEXT NOT NULL DEFAULT '',
  note            TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  created_by      TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_change_sub ON subscription_change (tenant_id, subscription_id, effective_date);

-- Which subscription an invoice came from, so the invoice can point back.
ALTER TABLE txn ADD COLUMN subscription_id TEXT;
CREATE INDEX IF NOT EXISTS ix_txn_subscription ON txn (tenant_id, subscription_id);
