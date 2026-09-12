-- =====================================================================
-- Meridian ERP :: 008_manufacturing
-- Bills of material, routing, work orders and quality.
--
-- A work order is the manufacturing analogue of a transaction: it issues
-- components out of stock and receives a finished good back in, and the
-- difference in value is variance that has to land somewhere in the GL.
-- Build cost = component cost + labour + overhead applied by the routing.
-- =====================================================================

CREATE TABLE IF NOT EXISTS bom (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  item_id       TEXT NOT NULL,                    -- the assembly this builds
  name          TEXT NOT NULL,
  revision      TEXT NOT NULL DEFAULT 'A',
  status        TEXT NOT NULL DEFAULT 'draft',    -- draft|released|obsolete
  effective_from TEXT,
  effective_to  TEXT,
  yield_pct     REAL NOT NULL DEFAULT 100,        -- expected good output
  is_default    INTEGER NOT NULL DEFAULT 0,
  notes         TEXT NOT NULL DEFAULT '',
  custom        TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_bom_item ON bom (tenant_id, item_id, status);

CREATE TABLE IF NOT EXISTS bom_line (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  bom_id        TEXT NOT NULL,
  line_no       INTEGER NOT NULL DEFAULT 1,
  component_id  TEXT NOT NULL,
  quantity      INTEGER NOT NULL DEFAULT 0,       -- scaled 1e6, per one assembly
  scrap_pct     REAL NOT NULL DEFAULT 0,
  operation_no  INTEGER,                          -- which routing step consumes it
  is_optional   INTEGER NOT NULL DEFAULT 0,
  notes         TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_bomline_bom ON bom_line (tenant_id, bom_id, line_no);

CREATE TABLE IF NOT EXISTS work_center (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  name          TEXT NOT NULL,
  location_id   TEXT,
  capacity_hours_per_day INTEGER NOT NULL DEFAULT 8000000,  -- scaled 1e6
  labour_rate   INTEGER NOT NULL DEFAULT 0,        -- minor units per hour
  overhead_rate INTEGER NOT NULL DEFAULT 0,
  labour_account_id   TEXT,
  overhead_account_id TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS routing_step (
  id             TEXT NOT NULL,
  tenant_id      TEXT NOT NULL,
  bom_id         TEXT NOT NULL,
  operation_no   INTEGER NOT NULL,
  name           TEXT NOT NULL,
  work_center_id TEXT,
  setup_hours    INTEGER NOT NULL DEFAULT 0,       -- scaled 1e6, per run
  run_hours      INTEGER NOT NULL DEFAULT 0,       -- scaled 1e6, per unit
  instructions   TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_routing_bom ON routing_step (tenant_id, bom_id, operation_no);

CREATE TABLE IF NOT EXISTS work_order (
  id             TEXT NOT NULL,
  tenant_id      TEXT NOT NULL,
  order_no       TEXT NOT NULL,
  item_id        TEXT NOT NULL,
  bom_id         TEXT,
  subsidiary_id  TEXT NOT NULL,
  location_id    TEXT NOT NULL,
  quantity       INTEGER NOT NULL DEFAULT 0,       -- scaled 1e6, ordered
  quantity_built INTEGER NOT NULL DEFAULT 0,
  quantity_scrapped INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'planned',  -- planned|released|in_progress|built|closed|cancelled
  priority       INTEGER NOT NULL DEFAULT 5,
  start_date     TEXT,
  due_date       TEXT,
  completed_date TEXT,
  sales_order_id TEXT,                             -- make-to-order link
  project_id     TEXT,
  -- Costs accumulated as the order runs; variance is the difference between
  -- these and the value of what was actually received into stock.
  component_cost INTEGER NOT NULL DEFAULT 0,
  labour_cost    INTEGER NOT NULL DEFAULT 0,
  overhead_cost  INTEGER NOT NULL DEFAULT 0,
  built_value    INTEGER NOT NULL DEFAULT 0,
  variance       INTEGER NOT NULL DEFAULT 0,
  wip_account_id      TEXT,
  variance_account_id TEXT,
  memo           TEXT NOT NULL DEFAULT '',
  custom         TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_wo_no ON work_order (tenant_id, order_no);
CREATE INDEX IF NOT EXISTS ix_wo_status ON work_order (tenant_id, status, due_date);

CREATE TABLE IF NOT EXISTS work_order_line (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  work_order_id TEXT NOT NULL,
  line_no       INTEGER NOT NULL DEFAULT 1,
  component_id  TEXT NOT NULL,
  quantity_required INTEGER NOT NULL DEFAULT 0,
  quantity_issued   INTEGER NOT NULL DEFAULT 0,
  unit_cost     INTEGER NOT NULL DEFAULT 0,
  location_id   TEXT,
  operation_no  INTEGER,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_woline ON work_order_line (tenant_id, work_order_id, line_no);

CREATE TABLE IF NOT EXISTS work_order_operation (
  id             TEXT NOT NULL,
  tenant_id      TEXT NOT NULL,
  work_order_id  TEXT NOT NULL,
  operation_no   INTEGER NOT NULL,
  name           TEXT NOT NULL,
  work_center_id TEXT,
  planned_hours  INTEGER NOT NULL DEFAULT 0,
  actual_hours   INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending|running|complete
  started_at     TEXT,
  completed_at   TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_wo_op ON work_order_operation (tenant_id, work_order_id, operation_no);

CREATE TABLE IF NOT EXISTS quality_inspection (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  reference_type TEXT NOT NULL,                    -- work_order|item_receipt|fulfillment
  reference_id  TEXT NOT NULL,
  item_id       TEXT,
  inspector_id  TEXT,
  inspected_at  TEXT NOT NULL,
  quantity_inspected INTEGER NOT NULL DEFAULT 0,
  quantity_passed    INTEGER NOT NULL DEFAULT 0,
  quantity_failed    INTEGER NOT NULL DEFAULT 0,
  result        TEXT NOT NULL DEFAULT 'pending',   -- pending|pass|fail|conditional
  disposition   TEXT NOT NULL DEFAULT '',          -- accept|rework|scrap|return
  checks        TEXT NOT NULL DEFAULT '[]',        -- [{name, spec, measured, pass}]
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_qi_ref ON quality_inspection (tenant_id, reference_type, reference_id);
