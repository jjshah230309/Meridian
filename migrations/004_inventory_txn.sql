-- =====================================================================
-- Meridian ERP :: 004_inventory_txn
-- Items, multi-location inventory, and the UNIFIED TRANSACTION MODEL.
--
-- Every business document -- quote, sales order, invoice, purchase order,
-- item receipt, vendor bill, payment, fulfilment, inventory adjustment --
-- is a row in `txn` with children in `txn_line`. This mirrors NetSuite's
-- own design and is what makes the platform features (custom fields,
-- saved searches, workflows, approvals, audit) work uniformly across
-- every document type instead of being reimplemented per module.
--
-- Quantities: INTEGER scaled 1e6.  Money: INTEGER minor units.
-- =====================================================================

CREATE TABLE IF NOT EXISTS location (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  subsidiary_id TEXT NOT NULL,
  address       TEXT NOT NULL DEFAULT '{}',
  type          TEXT NOT NULL DEFAULT 'warehouse', -- warehouse|store|dropship|virtual
  makes_commitments INTEGER NOT NULL DEFAULT 1,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_loc_code ON location(tenant_id, code);

CREATE TABLE IF NOT EXISTS item (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  sku           TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  type          TEXT NOT NULL DEFAULT 'inventory', -- inventory|noninventory|service|assembly|kit|discount
  category      TEXT NOT NULL DEFAULT '',
  uom           TEXT NOT NULL DEFAULT 'EA',
  base_price    INTEGER NOT NULL DEFAULT 0,
  standard_cost INTEGER NOT NULL DEFAULT 0,
  costing_method TEXT NOT NULL DEFAULT 'average',  -- average|standard
  -- GL account mapping
  income_account_id   TEXT,
  cogs_account_id     TEXT,
  asset_account_id    TEXT,
  expense_account_id  TEXT,
  preferred_vendor_id TEXT,
  purchase_price INTEGER NOT NULL DEFAULT 0,
  taxable       INTEGER NOT NULL DEFAULT 1,
  tax_code      TEXT NOT NULL DEFAULT 'STANDARD',
  weight_g      INTEGER NOT NULL DEFAULT 0,
  barcode       TEXT NOT NULL DEFAULT '',
  lead_time_days INTEGER NOT NULL DEFAULT 7,
  is_serialised INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  custom        TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_item_sku ON item(tenant_id, sku);
CREATE INDEX IF NOT EXISTS ix_item_name ON item(tenant_id, name);

-- Bill of materials for assembly items
CREATE TABLE IF NOT EXISTS item_component (
  tenant_id   TEXT NOT NULL,
  parent_item_id TEXT NOT NULL,
  component_item_id TEXT NOT NULL,
  quantity    INTEGER NOT NULL DEFAULT 1000000,
  PRIMARY KEY (tenant_id, parent_item_id, component_item_id)
) STRICT;

-- Per-item, per-location stock ledger position and replenishment policy.
CREATE TABLE IF NOT EXISTS item_location (
  tenant_id      TEXT NOT NULL,
  item_id        TEXT NOT NULL,
  location_id    TEXT NOT NULL,
  qty_on_hand    INTEGER NOT NULL DEFAULT 0,
  qty_committed  INTEGER NOT NULL DEFAULT 0,   -- allocated to open sales orders
  qty_on_order   INTEGER NOT NULL DEFAULT 0,   -- open purchase orders
  qty_back_order INTEGER NOT NULL DEFAULT 0,
  reorder_point  INTEGER NOT NULL DEFAULT 0,
  preferred_stock_level INTEGER NOT NULL DEFAULT 0,
  safety_stock   INTEGER NOT NULL DEFAULT 0,
  lead_time_days INTEGER NOT NULL DEFAULT 0,
  avg_cost       INTEGER NOT NULL DEFAULT 0,   -- moving average, minor units per unit
  total_value    INTEGER NOT NULL DEFAULT 0,   -- on-hand valuation, minor units
  bin            TEXT NOT NULL DEFAULT '',
  last_count_at  TEXT,
  PRIMARY KEY (tenant_id, item_id, location_id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_il_loc ON item_location(tenant_id, location_id);

-- Append-only stock ledger. One row per physical movement.
CREATE TABLE IF NOT EXISTS inventory_txn (
  id          TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  item_id     TEXT NOT NULL,
  location_id TEXT NOT NULL,
  txn_date    TEXT NOT NULL,
  type        TEXT NOT NULL,  -- receipt|shipment|adjustment|transfer_in|transfer_out|build|count
  qty_delta   INTEGER NOT NULL,
  unit_cost   INTEGER NOT NULL DEFAULT 0,
  value_delta INTEGER NOT NULL DEFAULT 0,
  running_qty   INTEGER NOT NULL DEFAULT 0,
  running_value INTEGER NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL DEFAULT '',
  source_id   TEXT,
  memo        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_invtxn ON inventory_txn(tenant_id, item_id, location_id, txn_date);
CREATE INDEX IF NOT EXISTS ix_invtxn_src ON inventory_txn(tenant_id, source_type, source_id);

-- ---------------- Pricing ----------------

CREATE TABLE IF NOT EXISTS price_level (
  id           TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  discount_pct REAL NOT NULL DEFAULT 0,
  is_base      INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS item_price (
  tenant_id      TEXT NOT NULL,
  item_id        TEXT NOT NULL,
  price_level_id TEXT NOT NULL,
  min_qty        INTEGER NOT NULL DEFAULT 0,
  currency       TEXT NOT NULL,
  price          INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, item_id, price_level_id, currency, min_qty)
) STRICT;

-- Declarative pricing/discount rules evaluated by the expression engine.
CREATE TABLE IF NOT EXISTS pricing_rule (
  id          TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  priority    INTEGER NOT NULL DEFAULT 100,
  condition   TEXT NOT NULL DEFAULT '',   -- expression over {item, customer, line, txn}
  action      TEXT NOT NULL DEFAULT 'discount_pct', -- discount_pct|fixed_price|markup_pct
  value       REAL NOT NULL DEFAULT 0,
  stackable   INTEGER NOT NULL DEFAULT 0,
  starts_on   TEXT,
  ends_on     TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;

-- Declarative approval routing.
CREATE TABLE IF NOT EXISTS approval_rule (
  id          TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  txn_type    TEXT NOT NULL,
  condition   TEXT NOT NULL DEFAULT '',
  approver_role_id TEXT,
  approver_user_id TEXT,
  sequence    INTEGER NOT NULL DEFAULT 1,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;

-- ---------------- Unified transaction header ----------------

CREATE TABLE IF NOT EXISTS txn (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  type          TEXT NOT NULL,
       -- QUOTE | SALES_ORDER | FULFILLMENT | INVOICE | CREDIT_MEMO | CUSTOMER_PAYMENT
       -- PURCHASE_ORDER | ITEM_RECEIPT | VENDOR_BILL | VENDOR_PAYMENT
       -- INVENTORY_ADJUSTMENT | INVENTORY_TRANSFER | EXPENSE_REPORT
  txn_no        TEXT NOT NULL,
  txn_date      TEXT NOT NULL,
  entity_type   TEXT,                    -- customer | vendor | employee
  entity_id     TEXT,
  subsidiary_id TEXT NOT NULL,
  location_id   TEXT,
  to_location_id TEXT,                   -- transfers
  department_id TEXT,
  class_id      TEXT,
  currency      TEXT NOT NULL,
  fx_rate       REAL NOT NULL DEFAULT 1.0,
  memo          TEXT NOT NULL DEFAULT '',
  reference     TEXT NOT NULL DEFAULT '',
  -- lifecycle
  status        TEXT NOT NULL DEFAULT 'open',
       -- draft|pending_approval|open|partially_fulfilled|fulfilled|billed|paid|
       -- partially_paid|closed|cancelled|rejected|voided
  approval_status TEXT NOT NULL DEFAULT 'not_required', -- not_required|pending|approved|rejected
  approved_by   TEXT,
  approved_at   TEXT,
  -- amounts, transaction currency, minor units
  subtotal      INTEGER NOT NULL DEFAULT 0,
  discount_total INTEGER NOT NULL DEFAULT 0,
  tax_total     INTEGER NOT NULL DEFAULT 0,
  shipping_total INTEGER NOT NULL DEFAULT 0,
  total         INTEGER NOT NULL DEFAULT 0,
  base_total    INTEGER NOT NULL DEFAULT 0,
  amount_applied INTEGER NOT NULL DEFAULT 0,   -- paid / applied to date
  amount_remaining INTEGER NOT NULL DEFAULT 0,
  -- terms
  terms         TEXT NOT NULL DEFAULT 'NET30',
  due_date      TEXT,
  ship_date     TEXT,
  ship_method   TEXT NOT NULL DEFAULT '',
  tracking_no   TEXT NOT NULL DEFAULT '',
  billing_address  TEXT NOT NULL DEFAULT '{}',
  shipping_address TEXT NOT NULL DEFAULT '{}',
  -- linkage & posting
  source_txn_id TEXT,                    -- e.g. invoice created from sales order
  journal_entry_id TEXT,
  period_id     TEXT,
  posted        INTEGER NOT NULL DEFAULT 0,
  sales_rep_id  TEXT,
  opportunity_id TEXT,
  probability   INTEGER NOT NULL DEFAULT 100,
  expected_close TEXT,
  custom        TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  created_by    TEXT,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_txn_no ON txn(tenant_id, type, txn_no);
CREATE INDEX IF NOT EXISTS ix_txn_type_date ON txn(tenant_id, type, txn_date DESC);
CREATE INDEX IF NOT EXISTS ix_txn_entity ON txn(tenant_id, entity_type, entity_id, txn_date DESC);
CREATE INDEX IF NOT EXISTS ix_txn_status ON txn(tenant_id, type, status);
CREATE INDEX IF NOT EXISTS ix_txn_source ON txn(tenant_id, source_txn_id);
CREATE INDEX IF NOT EXISTS ix_txn_due ON txn(tenant_id, type, due_date) WHERE amount_remaining > 0;

CREATE TABLE IF NOT EXISTS txn_line (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  txn_id        TEXT NOT NULL,
  line_no       INTEGER NOT NULL,
  item_id       TEXT,
  account_id    TEXT,                    -- expense/GL line when item is null
  description   TEXT NOT NULL DEFAULT '',
  quantity      INTEGER NOT NULL DEFAULT 1000000,
  unit_price    INTEGER NOT NULL DEFAULT 0,
  unit_cost     INTEGER NOT NULL DEFAULT 0,
  discount_pct  REAL NOT NULL DEFAULT 0,
  discount_amount INTEGER NOT NULL DEFAULT 0,
  amount        INTEGER NOT NULL DEFAULT 0,
  tax_code      TEXT NOT NULL DEFAULT '',
  tax_rate      REAL NOT NULL DEFAULT 0,
  tax_amount    INTEGER NOT NULL DEFAULT 0,
  location_id   TEXT,
  department_id TEXT,
  class_id      TEXT,
  -- fulfilment / billing progress (scaled qty)
  qty_committed INTEGER NOT NULL DEFAULT 0,
  qty_fulfilled INTEGER NOT NULL DEFAULT 0,
  qty_billed    INTEGER NOT NULL DEFAULT 0,
  qty_received  INTEGER NOT NULL DEFAULT 0,
  source_line_id TEXT,
  is_closed     INTEGER NOT NULL DEFAULT 0,
  custom        TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_txnline ON txn_line(tenant_id, txn_id, line_no);
CREATE INDEX IF NOT EXISTS ix_txnline_item ON txn_line(tenant_id, item_id);

-- Applications: payment -> invoice, credit memo -> invoice, order -> fulfilment...
CREATE TABLE IF NOT EXISTS txn_link (
  id          TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  from_txn_id TEXT NOT NULL,
  to_txn_id   TEXT NOT NULL,
  link_type   TEXT NOT NULL,   -- applied|fulfils|bills|receives|derives
  amount      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_link_from ON txn_link(tenant_id, from_txn_id);
CREATE INDEX IF NOT EXISTS ix_link_to ON txn_link(tenant_id, to_txn_id);

CREATE TABLE IF NOT EXISTS tax_code (
  tenant_id TEXT NOT NULL,
  code      TEXT NOT NULL,
  name      TEXT NOT NULL,
  rate      REAL NOT NULL DEFAULT 0,
  account_id TEXT,
  country   TEXT NOT NULL DEFAULT 'US',
  active    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, code)
) STRICT;
