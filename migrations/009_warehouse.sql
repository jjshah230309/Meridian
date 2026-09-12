-- =====================================================================
-- Meridian ERP :: 009_warehouse
-- Bin-level warehousing, the pick/pack/ship cycle, and planning.
--
-- Bins sit underneath the existing item_location rollup rather than
-- replacing it: item_location stays the costing and availability record,
-- and bin_quantity says where in the building the stock physically is.
-- Reconciling the two is a report, not a second source of truth.
-- =====================================================================

CREATE TABLE IF NOT EXISTS bin (
  id           TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  location_id  TEXT NOT NULL,
  code         TEXT NOT NULL,                      -- 'A-01-3'
  zone         TEXT NOT NULL DEFAULT '',
  bin_type     TEXT NOT NULL DEFAULT 'storage',    -- receiving|storage|picking|staging|shipping|quarantine
  pick_sequence INTEGER NOT NULL DEFAULT 0,        -- walk order for pick paths
  capacity     INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_bin_code ON bin (tenant_id, location_id, code);
CREATE INDEX IF NOT EXISTS ix_bin_pick ON bin (tenant_id, location_id, pick_sequence);

CREATE TABLE IF NOT EXISTS bin_quantity (
  tenant_id   TEXT NOT NULL,
  bin_id      TEXT NOT NULL,
  item_id     TEXT NOT NULL,
  lot_number  TEXT NOT NULL DEFAULT '',
  serial_no   TEXT NOT NULL DEFAULT '',
  expiry_date TEXT,
  quantity    INTEGER NOT NULL DEFAULT 0,          -- scaled 1e6
  allocated   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, bin_id, item_id, lot_number, serial_no)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_binqty_item ON bin_quantity (tenant_id, item_id);

-- Lot and serial tracking, independent of bins so it also covers
-- non-binned locations.
CREATE TABLE IF NOT EXISTS inventory_lot (
  id          TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  item_id     TEXT NOT NULL,
  lot_number  TEXT NOT NULL,
  serial_no   TEXT NOT NULL DEFAULT '',
  location_id TEXT,
  quantity    INTEGER NOT NULL DEFAULT 0,
  unit_cost   INTEGER NOT NULL DEFAULT 0,
  received_at TEXT,
  expiry_date TEXT,
  status      TEXT NOT NULL DEFAULT 'available',   -- available|allocated|quarantine|consumed|expired
  source_txn_id TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_lot ON inventory_lot (tenant_id, item_id, lot_number, serial_no);
CREATE INDEX IF NOT EXISTS ix_lot_expiry ON inventory_lot (tenant_id, expiry_date);

-- A wave groups orders so one walk of the warehouse picks them all.
CREATE TABLE IF NOT EXISTS pick_wave (
  id          TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  wave_no     TEXT NOT NULL,
  location_id TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',        -- open|picking|picked|packed|shipped|cancelled
  strategy    TEXT NOT NULL DEFAULT 'order',       -- order|batch|zone
  assigned_to TEXT,
  order_count INTEGER NOT NULL DEFAULT 0,
  line_count  INTEGER NOT NULL DEFAULT 0,
  released_at TEXT,
  completed_at TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_wave_no ON pick_wave (tenant_id, wave_no);

CREATE TABLE IF NOT EXISTS pick_task (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  wave_id       TEXT NOT NULL,
  txn_id        TEXT NOT NULL,                     -- the sales order being picked
  txn_line_id   TEXT,
  item_id       TEXT NOT NULL,
  bin_id        TEXT,
  lot_number    TEXT NOT NULL DEFAULT '',
  quantity      INTEGER NOT NULL DEFAULT 0,
  quantity_picked INTEGER NOT NULL DEFAULT 0,
  pick_sequence INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending|picked|short|cancelled
  picked_by     TEXT,
  picked_at     TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_picktask_wave ON pick_task (tenant_id, wave_id, pick_sequence);

CREATE TABLE IF NOT EXISTS package (
  id           TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  wave_id      TEXT,
  txn_id       TEXT,                               -- fulfilment it belongs to
  package_no   TEXT NOT NULL,
  carrier      TEXT NOT NULL DEFAULT '',
  service      TEXT NOT NULL DEFAULT '',
  tracking_no  TEXT NOT NULL DEFAULT '',
  weight       INTEGER NOT NULL DEFAULT 0,         -- scaled 1e6, kg
  length       INTEGER NOT NULL DEFAULT 0,
  width        INTEGER NOT NULL DEFAULT 0,
  height       INTEGER NOT NULL DEFAULT 0,
  freight_cost INTEGER NOT NULL DEFAULT 0,
  shipped_at   TEXT,
  status       TEXT NOT NULL DEFAULT 'open',       -- open|packed|shipped|delivered
  contents     TEXT NOT NULL DEFAULT '[]',         -- [{item_id, quantity, lot}]
  created_at   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_package_txn ON package (tenant_id, txn_id);

CREATE TABLE IF NOT EXISTS putaway_task (
  id           TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  receipt_txn_id TEXT,
  item_id      TEXT NOT NULL,
  from_bin_id  TEXT,
  to_bin_id    TEXT,
  quantity     INTEGER NOT NULL DEFAULT 0,
  lot_number   TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending',    -- pending|complete|cancelled
  completed_by TEXT,
  completed_at TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_putaway_status ON putaway_task (tenant_id, status);

-- ------------------------------------------------------------- planning
-- A plan run is a snapshot: what demand looked like, what supply existed,
-- and what the engine suggested. Keeping the snapshot means a buyer can
-- ask "why did it tell me that last week?" and get an answer.
CREATE TABLE IF NOT EXISTS demand_plan (
  id           TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  location_id  TEXT,
  horizon_days INTEGER NOT NULL DEFAULT 90,
  bucket       TEXT NOT NULL DEFAULT 'week',       -- week|month
  method       TEXT NOT NULL DEFAULT 'moving_average', -- moving_average|linear_trend|seasonal|manual
  lookback_days INTEGER NOT NULL DEFAULT 365,
  status       TEXT NOT NULL DEFAULT 'draft',      -- draft|approved
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS demand_plan_line (
  id           TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  plan_id      TEXT NOT NULL,
  item_id      TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  forecast_qty INTEGER NOT NULL DEFAULT 0,
  actual_qty   INTEGER NOT NULL DEFAULT 0,
  override_qty INTEGER,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_dpl ON demand_plan_line (tenant_id, plan_id, item_id, bucket_start);

CREATE TABLE IF NOT EXISTS supply_suggestion (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  run_id        TEXT NOT NULL,                     -- groups one planning run
  item_id       TEXT NOT NULL,
  location_id   TEXT,
  suggestion    TEXT NOT NULL DEFAULT 'purchase',  -- purchase|manufacture|transfer
  required_by   TEXT,
  order_by      TEXT,                              -- required_by minus lead time
  quantity      INTEGER NOT NULL DEFAULT 0,
  on_hand       INTEGER NOT NULL DEFAULT 0,
  on_order      INTEGER NOT NULL DEFAULT 0,
  committed     INTEGER NOT NULL DEFAULT 0,
  reorder_point INTEGER NOT NULL DEFAULT 0,
  vendor_id     TEXT,
  reason        TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'open',      -- open|actioned|dismissed
  created_txn_id TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_supply_run ON supply_suggestion (tenant_id, run_id, item_id);

-- Locations gain the flags the warehouse cycle needs.
ALTER TABLE location ADD COLUMN uses_bins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE location ADD COLUMN default_receiving_bin_id TEXT;
ALTER TABLE location ADD COLUMN default_shipping_bin_id TEXT;
