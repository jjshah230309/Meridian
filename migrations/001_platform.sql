-- =====================================================================
-- Meridian ERP :: 001_platform
-- Tenancy, identity, RBAC, audit, customization engine, search index.
--
-- Conventions used throughout every migration:
--   * Every business table carries tenant_id as the FIRST column of its
--     primary/unique keys so tenant isolation is an index-leading predicate,
--     not an afterthought. The Repo layer refuses to build SQL without it.
--   * Money is stored as INTEGER minor units (cents). Never floats.
--   * Quantities are INTEGER scaled by 1e6 (see src/core/num.mjs).
--   * Dates are TEXT 'YYYY-MM-DD'; timestamps are TEXT ISO-8601 UTC.
--   * Booleans are INTEGER 0/1.
--   * STRICT tables are used everywhere SQLite allows it, so a type error
--     is a write-time failure rather than a silent coercion in the ledger.
-- =====================================================================

CREATE TABLE IF NOT EXISTS tenant (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  plan         TEXT NOT NULL DEFAULT 'standard',
  status       TEXT NOT NULL DEFAULT 'active',   -- active | suspended | closed
  base_currency TEXT NOT NULL DEFAULT 'USD',
  fiscal_year_start_month INTEGER NOT NULL DEFAULT 1,
  settings     TEXT NOT NULL DEFAULT '{}',       -- JSON
  data_region  TEXT NOT NULL DEFAULT 'local',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS app_user (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT,
  password_salt TEXT,
  status        TEXT NOT NULL DEFAULT 'active',  -- active | disabled | invited
  is_owner      INTEGER NOT NULL DEFAULT 0,
  employee_id   TEXT,
  default_subsidiary_id TEXT,
  locale        TEXT NOT NULL DEFAULT 'en-US',
  timezone      TEXT NOT NULL DEFAULT 'UTC',
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  last_login_at TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_user_email ON app_user(tenant_id, email);

CREATE TABLE IF NOT EXISTS role (
  id          TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_system   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_role_name ON role(tenant_id, name);

-- level: 0 none | 1 view | 2 create | 3 edit | 4 full (incl. delete/approve)
CREATE TABLE IF NOT EXISTS permission (
  tenant_id   TEXT NOT NULL,
  role_id     TEXT NOT NULL,
  record_type TEXT NOT NULL,
  level       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, role_id, record_type)
) STRICT;

-- Row-level security. dimension = subsidiary | department | location | class | owner
CREATE TABLE IF NOT EXISTS role_restriction (
  tenant_id  TEXT NOT NULL,
  role_id    TEXT NOT NULL,
  dimension  TEXT NOT NULL,
  allowed    TEXT NOT NULL DEFAULT '[]',   -- JSON array of ids; [] = all
  own_only   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, role_id, dimension)
) STRICT;

CREATE TABLE IF NOT EXISTS user_role (
  tenant_id TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  role_id   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id, role_id)
) STRICT;

CREATE TABLE IF NOT EXISTS session (
  id         TEXT PRIMARY KEY,           -- hashed session token
  tenant_id  TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip         TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE INDEX IF NOT EXISTS ix_session_user ON session(tenant_id, user_id);

CREATE TABLE IF NOT EXISTS api_token (
  id          TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  prefix      TEXT NOT NULL,
  scopes      TEXT NOT NULL DEFAULT '["*"]',
  created_at  TEXT NOT NULL,
  expires_at  TEXT,
  last_used_at TEXT,
  revoked_at  TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;

-- Immutable append-only audit trail. Every mutation lands here.
CREATE TABLE IF NOT EXISTS audit_event (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  at          TEXT NOT NULL,
  user_id     TEXT,
  user_label  TEXT NOT NULL DEFAULT '',
  record_type TEXT NOT NULL,
  record_id   TEXT,
  action      TEXT NOT NULL,             -- create|update|delete|post|void|approve|login|...
  changes     TEXT NOT NULL DEFAULT '{}',-- JSON {field:{from,to}}
  ip          TEXT NOT NULL DEFAULT '',
  request_id  TEXT NOT NULL DEFAULT '',
  financial   INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS ix_audit_record ON audit_event(tenant_id, record_type, record_id, at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_at ON audit_event(tenant_id, at DESC);

-- Document numbering (INV-001042 etc). Allocated inside the writing txn.
CREATE TABLE IF NOT EXISTS sequence (
  tenant_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  prefix     TEXT NOT NULL DEFAULT '',
  next_value INTEGER NOT NULL DEFAULT 1,
  padding    INTEGER NOT NULL DEFAULT 5,
  PRIMARY KEY (tenant_id, name)
) STRICT;

-- ---------------- Customization engine ----------------

CREATE TABLE IF NOT EXISTS custom_field (
  id           TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  record_type  TEXT NOT NULL,
  name         TEXT NOT NULL,            -- machine name, stored in <record>.custom JSON
  label        TEXT NOT NULL,
  type         TEXT NOT NULL,            -- text|longtext|number|money|date|checkbox|select|multiselect|formula|reference
  options      TEXT NOT NULL DEFAULT '[]',
  ref_type     TEXT,
  formula      TEXT,                     -- expression DSL, evaluated on read
  required     INTEGER NOT NULL DEFAULT 0,
  help_text    TEXT NOT NULL DEFAULT '',
  display_order INTEGER NOT NULL DEFAULT 0,
  show_in_list INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_cf_name ON custom_field(tenant_id, record_type, name);

CREATE TABLE IF NOT EXISTS saved_search (
  id          TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  record_type TEXT NOT NULL,
  definition  TEXT NOT NULL,             -- JSON {columns,filters,sort,group,limit}
  owner_id    TEXT,
  is_public   INTEGER NOT NULL DEFAULT 1,
  is_system   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS dashboard (
  id         TEXT NOT NULL,
  tenant_id  TEXT NOT NULL,
  user_id    TEXT,                        -- NULL = tenant default layout
  name       TEXT NOT NULL DEFAULT 'Home',
  layout     TEXT NOT NULL DEFAULT '[]',  -- JSON array of widget descriptors
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;

-- SuiteFlow analogue: declarative, sandboxed workflow automation.
CREATE TABLE IF NOT EXISTS workflow (
  id          TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  record_type TEXT NOT NULL,
  trigger     TEXT NOT NULL,             -- before_create|after_create|before_update|after_update|on_approve|on_post|scheduled
  condition   TEXT NOT NULL DEFAULT '',  -- expression DSL; blank = always
  actions     TEXT NOT NULL DEFAULT '[]',-- JSON array of action descriptors
  status      TEXT NOT NULL DEFAULT 'released', -- draft|released|paused
  priority    INTEGER NOT NULL DEFAULT 100,
  run_count   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_wf_dispatch ON workflow(tenant_id, record_type, trigger, status);

CREATE TABLE IF NOT EXISTS workflow_log (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  record_id   TEXT,
  at          TEXT NOT NULL,
  result      TEXT NOT NULL,             -- matched|skipped|error
  message     TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS ix_wflog ON workflow_log(tenant_id, at DESC);

-- SuiteScript analogue. Disabled unless MERIDIAN_ENABLE_SCRIPTS=1 (see docs).
CREATE TABLE IF NOT EXISTS server_script (
  id          TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  record_type TEXT NOT NULL,
  event       TEXT NOT NULL,
  code        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'draft',
  timeout_ms  INTEGER NOT NULL DEFAULT 250,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS notification (
  id         TEXT NOT NULL,
  tenant_id  TEXT NOT NULL,
  user_id    TEXT,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  severity   TEXT NOT NULL DEFAULT 'info',
  link       TEXT NOT NULL DEFAULT '',
  read_at    TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_notif ON notification(tenant_id, user_id, created_at DESC);

-- ---------------- Search index (FTS5, replaces Elasticsearch) ----------------
CREATE TABLE IF NOT EXISTS search_doc (
  rowid_key   INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   TEXT NOT NULL,
  record_type TEXT NOT NULL,
  record_id   TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  subtitle    TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_searchdoc ON search_doc(tenant_id, record_type, record_id);

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  title, subtitle, body,
  content='search_doc', content_rowid='rowid_key',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS trg_sd_ai AFTER INSERT ON search_doc BEGIN
  INSERT INTO search_fts(rowid, title, subtitle, body) VALUES (new.rowid_key, new.title, new.subtitle, new.body);
END;
CREATE TRIGGER IF NOT EXISTS trg_sd_ad AFTER DELETE ON search_doc BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, subtitle, body) VALUES ('delete', old.rowid_key, old.title, old.subtitle, old.body);
END;
CREATE TRIGGER IF NOT EXISTS trg_sd_au AFTER UPDATE ON search_doc BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, subtitle, body) VALUES ('delete', old.rowid_key, old.title, old.subtitle, old.body);
  INSERT INTO search_fts(rowid, title, subtitle, body) VALUES (new.rowid_key, new.title, new.subtitle, new.body);
END;
