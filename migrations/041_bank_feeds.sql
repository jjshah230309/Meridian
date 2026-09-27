-- =====================================================================
-- Meridian ERP :: 041_bank_feeds
-- Live bank feeds via GoCardless Bank Account Data. Credentials live on
-- tenant.settings (migration 001), same non-TENANT_TABLES pattern as the
-- SMTP and payment settings. bank_feed tracks the link itself, one row per
-- bank_account that has been connected to a live external account.
-- =====================================================================

CREATE TABLE IF NOT EXISTS bank_feed (
  id                  TEXT NOT NULL,
  tenant_id           TEXT NOT NULL,
  bank_account_id     TEXT NOT NULL,
  requisition_id      TEXT NOT NULL,       -- GoCardless requisition id (the link/consent flow)
  institution_id      TEXT NOT NULL,
  institution_name    TEXT NOT NULL DEFAULT '',
  external_account_id TEXT,                -- set once the requisition completes and an account is chosen
  status              TEXT NOT NULL DEFAULT 'pending', -- pending|linked|expired|error
  last_synced_at      TEXT,
  last_error          TEXT NOT NULL DEFAULT '',
  access_expires_at   TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_bank_feed_account ON bank_feed (tenant_id, bank_account_id);
CREATE INDEX IF NOT EXISTS ix_bank_feed_requisition ON bank_feed (tenant_id, requisition_id);
