-- =====================================================================
-- Meridian ERP :: 003_crm
-- Entities (customer / vendor / contact), lead-to-cash CRM objects,
-- and customer support ticketing.
-- =====================================================================

CREATE TABLE IF NOT EXISTS customer (
  id             TEXT NOT NULL,
  tenant_id      TEXT NOT NULL,
  entity_no      TEXT NOT NULL,
  name           TEXT NOT NULL,
  legal_name     TEXT NOT NULL DEFAULT '',
  parent_id      TEXT,
  category       TEXT NOT NULL DEFAULT '',
  email          TEXT NOT NULL DEFAULT '',
  phone          TEXT NOT NULL DEFAULT '',
  website        TEXT NOT NULL DEFAULT '',
  billing_address  TEXT NOT NULL DEFAULT '{}',
  shipping_address TEXT NOT NULL DEFAULT '{}',
  currency       TEXT NOT NULL,
  subsidiary_id  TEXT NOT NULL,
  terms          TEXT NOT NULL DEFAULT 'NET30',   -- DUE_ON_RECEIPT|NET15|NET30|NET45|NET60
  credit_limit   INTEGER NOT NULL DEFAULT 0,
  credit_hold    INTEGER NOT NULL DEFAULT 0,
  price_level_id TEXT,
  discount_pct   REAL NOT NULL DEFAULT 0,
  tax_number     TEXT NOT NULL DEFAULT '',
  tax_code       TEXT NOT NULL DEFAULT 'STANDARD',
  sales_rep_id   TEXT,                             -- employee
  owner_id       TEXT,                             -- app_user
  status         TEXT NOT NULL DEFAULT 'active',   -- active|inactive|prospect
  source         TEXT NOT NULL DEFAULT '',
  notes          TEXT NOT NULL DEFAULT '',
  custom         TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_cust_no ON customer(tenant_id, entity_no);
CREATE INDEX IF NOT EXISTS ix_cust_name ON customer(tenant_id, name);
CREATE INDEX IF NOT EXISTS ix_cust_owner ON customer(tenant_id, owner_id);

CREATE TABLE IF NOT EXISTS vendor (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  entity_no     TEXT NOT NULL,
  name          TEXT NOT NULL,
  legal_name    TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  website       TEXT NOT NULL DEFAULT '',
  address       TEXT NOT NULL DEFAULT '{}',
  currency      TEXT NOT NULL,
  subsidiary_id TEXT NOT NULL,
  terms         TEXT NOT NULL DEFAULT 'NET30',
  tax_number    TEXT NOT NULL DEFAULT '',
  is_1099       INTEGER NOT NULL DEFAULT 0,
  payables_account_id TEXT,
  expense_account_id  TEXT,
  lead_time_days INTEGER NOT NULL DEFAULT 7,
  status        TEXT NOT NULL DEFAULT 'active',
  notes         TEXT NOT NULL DEFAULT '',
  custom        TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_vend_no ON vendor(tenant_id, entity_no);

CREATE TABLE IF NOT EXISTS contact (
  id           TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  first_name   TEXT NOT NULL DEFAULT '',
  last_name    TEXT NOT NULL DEFAULT '',
  email        TEXT NOT NULL DEFAULT '',
  phone        TEXT NOT NULL DEFAULT '',
  mobile       TEXT NOT NULL DEFAULT '',
  title        TEXT NOT NULL DEFAULT '',
  company_type TEXT NOT NULL DEFAULT 'customer',  -- customer|vendor|lead
  company_id   TEXT,
  is_primary   INTEGER NOT NULL DEFAULT 0,
  owner_id     TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  notes        TEXT NOT NULL DEFAULT '',
  custom       TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_contact_company ON contact(tenant_id, company_type, company_id);

CREATE TABLE IF NOT EXISTS lead (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  lead_no       TEXT NOT NULL,
  name          TEXT NOT NULL,
  company       TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  title         TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT '',      -- web|referral|event|outbound|partner
  status        TEXT NOT NULL DEFAULT 'new',   -- new|working|qualified|unqualified|converted
  rating        TEXT NOT NULL DEFAULT 'warm',  -- hot|warm|cold
  score         INTEGER NOT NULL DEFAULT 0,
  industry      TEXT NOT NULL DEFAULT '',
  estimated_value INTEGER NOT NULL DEFAULT 0,
  owner_id      TEXT,
  address       TEXT NOT NULL DEFAULT '{}',
  converted_customer_id TEXT,
  converted_opportunity_id TEXT,
  converted_at  TEXT,
  notes         TEXT NOT NULL DEFAULT '',
  custom        TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_lead_no ON lead(tenant_id, lead_no);
CREATE INDEX IF NOT EXISTS ix_lead_status ON lead(tenant_id, status, owner_id);

CREATE TABLE IF NOT EXISTS opportunity (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  opp_no        TEXT NOT NULL,
  name          TEXT NOT NULL,
  customer_id   TEXT,
  lead_id       TEXT,
  stage         TEXT NOT NULL DEFAULT 'prospecting',
                -- prospecting|qualification|proposal|negotiation|closed_won|closed_lost
  amount        INTEGER NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL,
  probability   INTEGER NOT NULL DEFAULT 10,   -- percent
  weighted_amount INTEGER NOT NULL DEFAULT 0,
  forecast_category TEXT NOT NULL DEFAULT 'pipeline', -- pipeline|best_case|commit|closed|omitted
  expected_close TEXT,
  actual_close  TEXT,
  owner_id      TEXT,
  sales_rep_id  TEXT,
  subsidiary_id TEXT,
  source        TEXT NOT NULL DEFAULT '',
  competitor    TEXT NOT NULL DEFAULT '',
  lost_reason   TEXT NOT NULL DEFAULT '',
  next_step     TEXT NOT NULL DEFAULT '',
  notes         TEXT NOT NULL DEFAULT '',
  custom        TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_opp_no ON opportunity(tenant_id, opp_no);
CREATE INDEX IF NOT EXISTS ix_opp_stage ON opportunity(tenant_id, stage, expected_close);
CREATE INDEX IF NOT EXISTS ix_opp_owner ON opportunity(tenant_id, owner_id);

CREATE TABLE IF NOT EXISTS activity (
  id           TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'task',  -- task|call|meeting|email|note
  subject      TEXT NOT NULL,
  notes        TEXT NOT NULL DEFAULT '',
  related_type TEXT,
  related_id   TEXT,
  owner_id     TEXT,
  assigned_to  TEXT,
  priority     TEXT NOT NULL DEFAULT 'normal',
  due_date     TEXT,
  start_at     TEXT,
  completed_at TEXT,
  status       TEXT NOT NULL DEFAULT 'open',  -- open|completed|cancelled
  custom       TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_act_related ON activity(tenant_id, related_type, related_id);
CREATE INDEX IF NOT EXISTS ix_act_due ON activity(tenant_id, status, due_date);

CREATE TABLE IF NOT EXISTS support_case (
  id           TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  case_no      TEXT NOT NULL,
  subject      TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  customer_id  TEXT,
  contact_id   TEXT,
  origin       TEXT NOT NULL DEFAULT 'email',  -- email|phone|portal|chat
  category     TEXT NOT NULL DEFAULT 'general',
  priority     TEXT NOT NULL DEFAULT 'medium', -- low|medium|high|urgent
  severity     TEXT NOT NULL DEFAULT 'minor',
  status       TEXT NOT NULL DEFAULT 'new',    -- new|open|pending|escalated|resolved|closed
  assigned_to  TEXT,
  sla_due_at   TEXT,
  first_response_at TEXT,
  resolved_at  TEXT,
  resolution   TEXT NOT NULL DEFAULT '',
  satisfaction INTEGER,
  custom       TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_case_no ON support_case(tenant_id, case_no);
CREATE INDEX IF NOT EXISTS ix_case_status ON support_case(tenant_id, status, priority);

CREATE TABLE IF NOT EXISTS case_message (
  id         TEXT NOT NULL,
  tenant_id  TEXT NOT NULL,
  case_id    TEXT NOT NULL,
  author_type TEXT NOT NULL DEFAULT 'agent',   -- agent|customer|system
  author_id  TEXT,
  author_name TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL,
  internal   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_casemsg ON case_message(tenant_id, case_id, created_at);
