-- A file attached to any record or transaction: a receipt, a signed PO, a
-- contract. Bytes live in the database itself (one SQLite file stays one
-- SQLite file, and scripts/backup.mjs's VACUUM INTO already backs it all up
-- without needing to know attachments exist) rather than on disk next to it.
CREATE TABLE IF NOT EXISTS attachment (
  tenant_id     TEXT NOT NULL,
  id            TEXT NOT NULL,
  record_type   TEXT NOT NULL,
  record_id     TEXT NOT NULL,
  filename      TEXT NOT NULL,
  content_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
  size          INTEGER NOT NULL,
  bytes         BLOB NOT NULL,
  uploaded_by   TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_attachment_record ON attachment(tenant_id, record_type, record_id, created_at);
