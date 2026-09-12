-- =====================================================================
-- Meridian ERP :: 010_commerce_service
-- Marketing, partners, commerce channels and field service.
--
-- Commerce here is the back office of a storefront, not the storefront:
-- a channel, its catalogue, its carts and the orders they become. Orders
-- land in the same txn table as everything else, so an online order is a
-- sales order that happens to know which channel it came from.
-- =====================================================================

CREATE TABLE IF NOT EXISTS campaign (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  campaign_no   TEXT NOT NULL,
  name          TEXT NOT NULL,
  channel       TEXT NOT NULL DEFAULT 'email',     -- email|search|social|event|direct|partner
  status        TEXT NOT NULL DEFAULT 'planned',   -- planned|active|paused|complete
  start_date    TEXT,
  end_date      TEXT,
  budget        INTEGER NOT NULL DEFAULT 0,
  actual_cost   INTEGER NOT NULL DEFAULT 0,
  target_audience TEXT NOT NULL DEFAULT '',
  owner_id      TEXT,
  -- Denormalised results, recalculated on demand; attribution is the whole
  -- point of a campaign record and a join every time is too slow to show.
  leads_generated INTEGER NOT NULL DEFAULT 0,
  opportunities   INTEGER NOT NULL DEFAULT 0,
  revenue         INTEGER NOT NULL DEFAULT 0,
  custom        TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_campaign_no ON campaign (tenant_id, campaign_no);

CREATE TABLE IF NOT EXISTS partner (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  partner_no    TEXT NOT NULL,
  name          TEXT NOT NULL,
  partner_type  TEXT NOT NULL DEFAULT 'reseller',  -- reseller|referral|distributor|alliance
  tier          TEXT NOT NULL DEFAULT 'standard',
  status        TEXT NOT NULL DEFAULT 'active',
  email         TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  website       TEXT NOT NULL DEFAULT '',
  address       TEXT NOT NULL DEFAULT '{}',
  manager_id    TEXT,
  commission_pct REAL NOT NULL DEFAULT 0,
  vendor_id     TEXT,                              -- how commission gets paid
  custom        TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_partner_no ON partner (tenant_id, partner_no);

CREATE TABLE IF NOT EXISTS commission (
  id           TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  partner_id   TEXT,
  employee_id  TEXT,
  txn_id       TEXT NOT NULL,
  basis_amount INTEGER NOT NULL DEFAULT 0,
  rate_pct     REAL NOT NULL DEFAULT 0,
  amount       INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'accrued',    -- accrued|approved|paid|reversed
  period_id    TEXT,
  paid_txn_id  TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_commission_who ON commission (tenant_id, partner_id, employee_id, status);

-- ------------------------------------------------------------- commerce
CREATE TABLE IF NOT EXISTS sales_channel (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  name          TEXT NOT NULL,
  channel_type  TEXT NOT NULL DEFAULT 'web',       -- web|b2b|marketplace|pos|phone
  subsidiary_id TEXT,
  currency      TEXT NOT NULL DEFAULT 'USD',
  price_level_id TEXT,
  location_id   TEXT,                              -- fulfils from
  customer_group TEXT NOT NULL DEFAULT '',
  active        INTEGER NOT NULL DEFAULT 1,
  settings      TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS channel_listing (
  id           TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  channel_id   TEXT NOT NULL,
  item_id      TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  price        INTEGER NOT NULL DEFAULT 0,
  compare_price INTEGER NOT NULL DEFAULT 0,
  published    INTEGER NOT NULL DEFAULT 0,
  stock_policy TEXT NOT NULL DEFAULT 'track',      -- track|continue|deny
  seo_slug     TEXT NOT NULL DEFAULT '',
  media        TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_listing ON channel_listing (tenant_id, channel_id, item_id);

CREATE TABLE IF NOT EXISTS cart (
  id           TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  channel_id   TEXT NOT NULL,
  customer_id  TEXT,
  email        TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'open',       -- open|abandoned|converted
  currency     TEXT NOT NULL DEFAULT 'USD',
  subtotal     INTEGER NOT NULL DEFAULT 0,
  lines        TEXT NOT NULL DEFAULT '[]',
  converted_txn_id TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_cart_status ON cart (tenant_id, status, updated_at);

-- --------------------------------------------------------- field service
CREATE TABLE IF NOT EXISTS service_asset (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  asset_tag     TEXT NOT NULL,
  name          TEXT NOT NULL,
  customer_id   TEXT,
  item_id       TEXT,                              -- what product it is
  serial_no     TEXT NOT NULL DEFAULT '',
  installed_at  TEXT,
  warranty_end  TEXT,
  contract_id   TEXT,
  site_address  TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'active',    -- active|retired|replaced
  meter_reading INTEGER NOT NULL DEFAULT 0,
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_service_asset ON service_asset (tenant_id, asset_tag);
CREATE INDEX IF NOT EXISTS ix_service_asset_cust ON service_asset (tenant_id, customer_id);

CREATE TABLE IF NOT EXISTS service_contract (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  contract_no   TEXT NOT NULL,
  customer_id   TEXT NOT NULL,
  name          TEXT NOT NULL,
  start_date    TEXT NOT NULL,
  end_date      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  coverage      TEXT NOT NULL DEFAULT 'parts_labour',
  response_hours INTEGER NOT NULL DEFAULT 24,
  billing_frequency TEXT NOT NULL DEFAULT 'annual',
  amount        INTEGER NOT NULL DEFAULT 0,
  visits_included INTEGER NOT NULL DEFAULT 0,
  visits_used   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS service_order (
  id             TEXT NOT NULL,
  tenant_id      TEXT NOT NULL,
  order_no       TEXT NOT NULL,
  customer_id    TEXT NOT NULL,
  asset_id       TEXT,
  contract_id    TEXT,
  case_id        TEXT,                             -- raised from a support case
  subsidiary_id  TEXT NOT NULL,
  order_type     TEXT NOT NULL DEFAULT 'repair',   -- repair|install|maintenance|inspection
  priority       TEXT NOT NULL DEFAULT 'normal',   -- low|normal|high|emergency
  status         TEXT NOT NULL DEFAULT 'new',      -- new|scheduled|dispatched|on_site|complete|cancelled|invoiced
  description    TEXT NOT NULL DEFAULT '',
  site_address   TEXT NOT NULL DEFAULT '{}',
  requested_date TEXT,
  scheduled_start TEXT,
  scheduled_end  TEXT,
  technician_id  TEXT,
  arrived_at     TEXT,
  completed_at   TEXT,
  resolution     TEXT NOT NULL DEFAULT '',
  labour_hours   INTEGER NOT NULL DEFAULT 0,
  parts_cost     INTEGER NOT NULL DEFAULT 0,
  labour_cost    INTEGER NOT NULL DEFAULT 0,
  billable       INTEGER NOT NULL DEFAULT 1,
  invoice_txn_id TEXT,
  signature      TEXT NOT NULL DEFAULT '',
  custom         TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_service_order ON service_order (tenant_id, order_no);
CREATE INDEX IF NOT EXISTS ix_svc_sched ON service_order (tenant_id, status, scheduled_start);
CREATE INDEX IF NOT EXISTS ix_svc_tech ON service_order (tenant_id, technician_id, scheduled_start);

CREATE TABLE IF NOT EXISTS service_line (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  service_order_id TEXT NOT NULL,
  line_no       INTEGER NOT NULL DEFAULT 1,
  line_type     TEXT NOT NULL DEFAULT 'part',      -- part|labour|expense
  item_id       TEXT,
  description   TEXT NOT NULL DEFAULT '',
  quantity      INTEGER NOT NULL DEFAULT 0,
  unit_price    INTEGER NOT NULL DEFAULT 0,
  unit_cost     INTEGER NOT NULL DEFAULT 0,
  amount        INTEGER NOT NULL DEFAULT 0,
  billable      INTEGER NOT NULL DEFAULT 1,
  covered_by_contract INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_svcline ON service_line (tenant_id, service_order_id, line_no);

-- Technicians are employees with a service profile.
CREATE TABLE IF NOT EXISTS technician (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  employee_id   TEXT NOT NULL,
  skills        TEXT NOT NULL DEFAULT '[]',
  home_location_id TEXT,
  service_radius_km INTEGER NOT NULL DEFAULT 50,
  hourly_rate   INTEGER NOT NULL DEFAULT 0,
  van_location_id TEXT,                            -- stock carried on the van
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_technician ON technician (tenant_id, employee_id);

-- Orders learn where they came from.
ALTER TABLE txn ADD COLUMN channel_id TEXT;
ALTER TABLE txn ADD COLUMN campaign_id TEXT;
ALTER TABLE txn ADD COLUMN partner_id TEXT;
ALTER TABLE txn ADD COLUMN project_id TEXT;
ALTER TABLE lead ADD COLUMN campaign_id TEXT;
ALTER TABLE opportunity ADD COLUMN campaign_id TEXT;
ALTER TABLE opportunity ADD COLUMN partner_id TEXT;
