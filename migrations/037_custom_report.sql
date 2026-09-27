-- =====================================================================
-- Meridian ERP :: 037_custom_report
-- Saved pivot reports (src/modules/pivot.mjs). `definition` holds the
-- dataset, row/column dimensions, values and filters; `chart` names which
-- chart (if any) the builder should draw alongside the table.
-- =====================================================================

CREATE TABLE IF NOT EXISTS custom_report (
  id           TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  definition   TEXT NOT NULL DEFAULT '{}',
  chart        TEXT NOT NULL DEFAULT 'none',   -- none|bar|line|donut
  owner_id     TEXT,
  is_public    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_custom_report_owner ON custom_report (tenant_id, owner_id);
