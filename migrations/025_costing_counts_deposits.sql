-- =====================================================================
-- Meridian ERP :: 025_costing_counts_deposits
-- Three gaps that show up the moment a real warehouse and a real customer
-- are involved.
--
-- LANDED COST. A container of stock costs the invoice price plus the freight,
-- the duty and the insurance. Booking those to an expense account leaves the
-- stock understated and the margin on every sale of it overstated. They
-- belong in the value of the goods, spread across them by value or by weight.
--
-- PHYSICAL COUNT. Once a quarter somebody walks the racks with a sheet. What
-- they find is rarely what the system says, and the difference has to be
-- entered as one reviewed, approved adjustment rather than forty ad-hoc ones.
--
-- CUSTOMER DEPOSITS. Money taken before there is an invoice to apply it to.
-- It is not revenue and it is not a receivable: it is a liability until the
-- goods go out, and pretending otherwise overstates both.
-- =====================================================================

-- ------------------------------------------------------------ landed cost
CREATE TABLE IF NOT EXISTS landed_cost_category (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  name          TEXT NOT NULL,
  -- Where the cost sits before it is capitalised into the goods.
  account_id    TEXT,
  -- value | quantity | weight -- how it is spread across the lines
  method        TEXT NOT NULL DEFAULT 'value',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_landed_name ON landed_cost_category (tenant_id, name);

CREATE TABLE IF NOT EXISTS landed_cost (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  txn_id        TEXT NOT NULL,                    -- the receipt or bill it lands on
  category_id   TEXT NOT NULL,
  method        TEXT NOT NULL DEFAULT 'value',
  amount        INTEGER NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'USD',
  vendor_id     TEXT,                             -- who charged it, if not the supplier
  reference     TEXT NOT NULL DEFAULT '',
  entry_id      TEXT,                             -- the journal that capitalised it
  applied_at    TEXT,
  created_at    TEXT NOT NULL,
  created_by    TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_landed_txn ON landed_cost (tenant_id, txn_id);

-- What each line actually absorbed, so a unit cost can be explained.
CREATE TABLE IF NOT EXISTS landed_cost_line (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  landed_cost_id TEXT NOT NULL,
  txn_line_id   TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  location_id   TEXT,
  basis         INTEGER NOT NULL DEFAULT 0,       -- value, quantity or weight
  amount        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_landed_line ON landed_cost_line (tenant_id, landed_cost_id);

-- ------------------------------------------------------- physical counts
CREATE TABLE IF NOT EXISTS inventory_count (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  count_no      TEXT NOT NULL,
  location_id   TEXT NOT NULL,
  subsidiary_id TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  -- full     -- everything at the location
  -- category -- one category
  -- cycle    -- a rolling slice, oldest-counted first
  scope         TEXT NOT NULL DEFAULT 'full',
  category      TEXT NOT NULL DEFAULT '',
  count_date    TEXT NOT NULL,
  -- open      -- sheet issued, quantities being entered
  -- counted   -- every line has a number against it
  -- posted    -- variances adjusted into the ledger
  -- cancelled
  status        TEXT NOT NULL DEFAULT 'open',
  line_count    INTEGER NOT NULL DEFAULT 0,
  counted_count INTEGER NOT NULL DEFAULT 0,
  variance_qty  INTEGER NOT NULL DEFAULT 0,       -- scaled quantity, signed
  variance_value INTEGER NOT NULL DEFAULT 0,      -- base minor units, signed
  adjustment_txn_id TEXT,
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  created_by    TEXT,
  posted_at     TEXT,
  posted_by     TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_count_no ON inventory_count (tenant_id, count_no);
CREATE INDEX IF NOT EXISTS ix_count_status ON inventory_count (tenant_id, status, count_date);

CREATE TABLE IF NOT EXISTS inventory_count_line (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  count_id      TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  bin           TEXT NOT NULL DEFAULT '',
  -- What the system said when the sheet was issued. Frozen on purpose: the
  -- variance is against the book figure the counter was working from, not
  -- against a number that moved while they were walking the racks.
  expected_qty  INTEGER NOT NULL DEFAULT 0,
  counted_qty   INTEGER,                          -- null until somebody counts it
  unit_cost     INTEGER NOT NULL DEFAULT 0,
  variance_qty  INTEGER NOT NULL DEFAULT 0,
  variance_value INTEGER NOT NULL DEFAULT 0,
  note          TEXT NOT NULL DEFAULT '',
  counted_at    TEXT,
  counted_by    TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_count_line ON inventory_count_line (tenant_id, count_id);

-- ------------------------------------------------- deposits and prepayments
-- Money that has moved before there is a document to apply it to. A customer
-- deposit is a liability; a supplier prepayment is an asset. Neither is
-- revenue, cost, a receivable or a payable until it is applied.
ALTER TABLE txn ADD COLUMN applied_deposit INTEGER NOT NULL DEFAULT 0;

INSERT INTO account (id, tenant_id, number, name, type, subtype, parent_id, currency,
                     subsidiary_id, is_summary, cash_flow_category, description, active,
                     custom, created_at, updated_at)
SELECT 'ACC' || substr(hex(randomblob(11)), 1, 22),
       t.id, '2350', 'Customer Deposits', 'LIABILITY', 'OTHER_CURRENT_LIABILITY',
       (SELECT p.id FROM account p WHERE p.tenant_id = t.id AND p.number = '2000'),
       NULL, NULL, 0, 'operating',
       'Money taken before the goods went out. Owed back until it is applied.', 1, '{}',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM tenant t
WHERE NOT EXISTS (SELECT 1 FROM account a WHERE a.tenant_id = t.id AND a.number = '2350');

INSERT INTO account (id, tenant_id, number, name, type, subtype, parent_id, currency,
                     subsidiary_id, is_summary, cash_flow_category, description, active,
                     custom, created_at, updated_at)
SELECT 'ACC' || substr(hex(randomblob(11)), 1, 22),
       t.id, '1260', 'Supplier Prepayments', 'ASSET', 'OTHER_CURRENT_ASSET',
       (SELECT p.id FROM account p WHERE p.tenant_id = t.id AND p.number = '1000'),
       NULL, NULL, 0, 'operating',
       'Paid before the goods arrived. An asset until it is applied to a bill.', 1, '{}',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM tenant t
WHERE NOT EXISTS (SELECT 1 FROM account a WHERE a.tenant_id = t.id AND a.number = '1260');

-- A default set of landed cost categories, so the feature works on day one.
INSERT INTO landed_cost_category (id, tenant_id, name, account_id, method, active, created_at)
SELECT 'LCC' || substr(hex(randomblob(11)), 1, 22), t.id, v.name,
       (SELECT a.id FROM account a WHERE a.tenant_id = t.id AND a.number = '5020'),
       v.method, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM tenant t
JOIN (SELECT 'Freight' AS name, 'value' AS method
      UNION ALL SELECT 'Duty', 'value'
      UNION ALL SELECT 'Insurance', 'value'
      UNION ALL SELECT 'Handling', 'quantity') v
WHERE NOT EXISTS (SELECT 1 FROM landed_cost_category c WHERE c.tenant_id = t.id AND c.name = v.name);
