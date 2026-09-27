-- =====================================================================
-- Meridian ERP :: 036_lot_tracking
-- Wires inventory_lot (added in 009, never populated by anything but
-- generic CRUD) into every real stock movement, and gives each movement
-- a durable line-level record of which lots/serials it touched.
--
-- Costing stays moving-average (inventory.mjs) -- lots and serials track
-- QUANTITY and identity, not a second costing method. inventory_lot's
-- own unit_cost is kept for reference (what that lot cost when received),
-- not used to value issues.
-- =====================================================================

ALTER TABLE item ADD COLUMN track_lots INTEGER NOT NULL DEFAULT 0;

-- A lot at one location is a different physical pile of stock from "the
-- same lot number" at another location. Without location in the key, two
-- warehouses receiving the same vendor lot number would collide into one
-- row. (Item transfers do not yet move stock between locations at all --
-- see txn.mjs's INVENTORY_TRANSFER, `posts: false` -- so a lot's location
-- is fixed at receipt for now; that is a separate, already-known gap.)
DROP INDEX IF EXISTS ux_lot;
CREATE UNIQUE INDEX IF NOT EXISTS ux_lot ON inventory_lot (tenant_id, item_id, location_id, lot_number, serial_no);

-- Which document line consumed or produced how much of which lot/serial.
-- This is the audit trail a trace report reads, and what a void reverses --
-- independent of inventory_txn's coarser (per movement, not per line) grain.
--
-- source_type/source_id follow the same convention inventory_txn already
-- uses (a txn TYPES key and its id, OR 'work_order' and a work order id --
-- anything moveStock is called for), rather than assuming every caller is a
-- row in `txn`.
CREATE TABLE IF NOT EXISTS txn_line_lot (
  id              TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  source_type     TEXT NOT NULL,
  source_id       TEXT NOT NULL,
  source_line_id  TEXT NOT NULL,
  item_id         TEXT NOT NULL,
  location_id     TEXT NOT NULL,
  lot_id          TEXT,
  lot_number      TEXT NOT NULL DEFAULT '',
  serial_no       TEXT NOT NULL DEFAULT '',
  direction       TEXT NOT NULL DEFAULT 'issue',    -- issue|receive
  quantity        INTEGER NOT NULL DEFAULT 0,        -- scaled 1e6, always positive
  reversed        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_txnlinelot_source ON txn_line_lot (tenant_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS ix_txnlinelot_lot ON txn_line_lot (tenant_id, lot_id);

-- A stock count needs to know which lot it is counting, once the item
-- being counted is lot- or serial-tracked.
ALTER TABLE inventory_count_line ADD COLUMN lot_id TEXT;
ALTER TABLE inventory_count_line ADD COLUMN lot_number TEXT NOT NULL DEFAULT '';
ALTER TABLE inventory_count_line ADD COLUMN serial_no TEXT NOT NULL DEFAULT '';

-- putaway_task never had a serial column (009_warehouse), only lot_number --
-- fine while nothing wrote a real lot/serial into the receiving bin. Now
-- that a receipt does (inventory.mjs's fillReceivingBin), a put-away of a
-- serialised item has to move the SAME (lot_number, serial_no) key back out
-- of that bin, or moveBin looks for a row that was never created.
ALTER TABLE putaway_task ADD COLUMN serial_no TEXT NOT NULL DEFAULT '';
