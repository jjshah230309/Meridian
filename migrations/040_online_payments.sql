-- =====================================================================
-- Meridian ERP :: 040_online_payments
-- Online payment collection: a Demo provider (moves no money, for trying
-- this out with no account) and Stripe. Settings live on tenant.settings
-- (migration 001), the same non-TENANT_TABLES pattern setup.mjs's SMTP
-- settings already use, for the same reason -- the tenant row is what
-- *names* the tenant, not one more tenant-owned record.
-- =====================================================================

CREATE TABLE IF NOT EXISTS payment_intent (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  provider      TEXT NOT NULL,             -- demo|stripe
  provider_ref  TEXT NOT NULL,             -- Stripe Checkout Session id, or a generated ref for demo
  invoice_id    TEXT NOT NULL,
  customer_id   TEXT NOT NULL,
  amount        INTEGER NOT NULL,          -- minor units, snapshotted at checkout creation
  currency      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'created', -- created|completed|failed|expired
  payment_txn_id TEXT,                     -- the CUSTOMER_PAYMENT this became, once completed
  created_at    TEXT NOT NULL,
  completed_at  TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
-- A webhook can be retried or arrive twice; this is what makes completing
-- the same provider reference a no-op the second time rather than a
-- duplicate payment.
CREATE UNIQUE INDEX IF NOT EXISTS ux_payment_intent_ref ON payment_intent (tenant_id, provider, provider_ref);
CREATE INDEX IF NOT EXISTS ix_payment_intent_invoice ON payment_intent (tenant_id, invoice_id);
