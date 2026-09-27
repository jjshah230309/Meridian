-- =====================================================================
-- Meridian ERP :: 039_portal
-- Customer and vendor self-service. A portal user is not an app_user --
-- it has no role, no permission row, and cannot reach a single /api/v1
-- route other than the ones under /api/v1/portal. Every query a portal
-- route runs is scoped in the SQL itself by entity_id, not by the RBAC
-- machinery staff sessions go through.
-- =====================================================================

CREATE TABLE IF NOT EXISTS portal_user (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  entity_type   TEXT NOT NULL,             -- customer|vendor
  entity_id     TEXT NOT NULL,
  contact_id    TEXT,
  email         TEXT NOT NULL,
  password_hash TEXT,
  password_salt TEXT,
  invite_token_hash TEXT,
  invite_expires_at TEXT,
  status        TEXT NOT NULL DEFAULT 'invited', -- invited|active|revoked
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  last_login_at TEXT,
  invited_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
-- One portal identity per email per tenant, regardless of how many
-- entities that email might be a contact for.
CREATE UNIQUE INDEX IF NOT EXISTS ux_portal_user_email ON portal_user (tenant_id, email);
CREATE INDEX IF NOT EXISTS ix_portal_user_entity ON portal_user (tenant_id, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS portal_session (
  id          TEXT NOT NULL,               -- sha256 of the raw token; the raw token never touches disk
  tenant_id   TEXT NOT NULL,
  portal_user_id TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip          TEXT NOT NULL DEFAULT '',
  user_agent  TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_portal_session_expires ON portal_session (expires_at);
