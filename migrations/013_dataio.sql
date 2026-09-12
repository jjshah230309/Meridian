-- =====================================================================
-- Meridian ERP :: 013_dataio
-- Import jobs, saved field mappings, and export definitions.
--
-- Every import is recorded with its mapping, its row-level results and the
-- ids it created. That is what makes an import undoable and auditable:
-- without the created-id list, "reverse that import" is guesswork.
-- =====================================================================

CREATE TABLE IF NOT EXISTS import_job (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  job_no        TEXT NOT NULL,
  record_type   TEXT NOT NULL,
  filename      TEXT NOT NULL DEFAULT '',
  format        TEXT NOT NULL DEFAULT 'csv',       -- csv|ofx|qfx|bai2|camt053|json
  mode          TEXT NOT NULL DEFAULT 'add',       -- add|update|upsert
  key_field     TEXT NOT NULL DEFAULT '',          -- how an existing row is matched
  mapping       TEXT NOT NULL DEFAULT '{}',        -- {csvHeader: fieldName}
  defaults      TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending|validated|committed|failed|reversed
  total_rows    INTEGER NOT NULL DEFAULT 0,
  valid_rows    INTEGER NOT NULL DEFAULT 0,
  error_rows    INTEGER NOT NULL DEFAULT 0,
  created_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  errors        TEXT NOT NULL DEFAULT '[]',        -- [{line, field, message}]
  created_ids   TEXT NOT NULL DEFAULT '[]',
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  completed_at  TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_import_job_no ON import_job (tenant_id, job_no);
CREATE INDEX IF NOT EXISTS ix_import_status ON import_job (tenant_id, status, created_at);

-- A mapping worth keeping, so the same monthly file is one click next time.
CREATE TABLE IF NOT EXISTS import_template (
  id          TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  record_type TEXT NOT NULL,
  format      TEXT NOT NULL DEFAULT 'csv',
  mode        TEXT NOT NULL DEFAULT 'add',
  key_field   TEXT NOT NULL DEFAULT '',
  mapping     TEXT NOT NULL DEFAULT '{}',
  defaults    TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS export_definition (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  name          TEXT NOT NULL,
  source_type   TEXT NOT NULL DEFAULT 'record',    -- record|saved_search|report
  record_type   TEXT NOT NULL DEFAULT '',
  saved_search_id TEXT,
  report_key    TEXT NOT NULL DEFAULT '',
  format        TEXT NOT NULL DEFAULT 'xlsx',      -- csv|xlsx|pdf|json
  columns       TEXT NOT NULL DEFAULT '[]',
  filters       TEXT NOT NULL DEFAULT '[]',
  options       TEXT NOT NULL DEFAULT '{}',
  last_run_at   TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
