-- =====================================================================
-- Meridian ERP :: 028_custom_records
-- Records the product does not know about.
--
-- Every business keeps something an ERP has never heard of: a register of
-- calibration certificates, a list of approved subcontractors, the safety
-- inspections a site has to pass before work starts. Without somewhere to put
-- them they end up in a spreadsheet on somebody's desktop, unbacked up,
-- unpermissioned, and impossible to report against alongside everything else.
--
-- The design here is deliberately parasitic on machinery that already exists,
-- because a custom record that behaves differently from a built-in one is
-- worth very little.
--
-- `custom_field` already describes a field: its type, its options, whether it
-- is required, what it refers to. It is reused unchanged, with `record_type`
-- naming the custom type instead of a built-in one. So a custom record's
-- fields validate, coerce, render and import exactly like the custom fields
-- already bolted onto customers and items.
--
-- `custom_record` is one physical table for every custom type. The values
-- live in the `custom` JSON column, which the database layer already encodes
-- and decodes. A table per type would be tidier to query and considerably
-- worse to live with: it would mean running DDL at runtime, on a tenant's
-- behalf, inside a multi-tenant database, which is how one tenant's mistake
-- becomes everybody's outage.
-- =====================================================================

CREATE TABLE IF NOT EXISTS custom_record_type (
  id           TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  -- Machine name, lower_snake_case. Addressed as `c_<name>` everywhere a
  -- record type is named, so a custom type can never be mistaken for -- or
  -- collide with -- a built-in one, however it is called.
  name         TEXT NOT NULL,
  label        TEXT NOT NULL,
  plural       TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  icon         TEXT NOT NULL DEFAULT '',
  -- Which part of the navigation it appears under. One of the existing
  -- groups, so it sits with the work it belongs to rather than in a ghetto
  -- of custom things.
  nav_group    TEXT NOT NULL DEFAULT 'Platform',
  -- Give it document numbers, like an invoice has. Off by default: most
  -- registers are keyed by their own name.
  numbered     INTEGER NOT NULL DEFAULT 0,
  number_prefix TEXT NOT NULL DEFAULT '',
  -- The field whose value titles the record in lists, search and audit.
  title_field  TEXT NOT NULL DEFAULT 'name',
  show_in_nav  INTEGER NOT NULL DEFAULT 1,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  created_by   TEXT,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_crt_name ON custom_record_type (tenant_id, name);

CREATE TABLE IF NOT EXISTS custom_record (
  id           TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  -- The machine name of the type, without the `c_` prefix.
  type_name    TEXT NOT NULL,
  record_no    TEXT NOT NULL DEFAULT '',
  -- Held as a column rather than only in the JSON so lists can sort and
  -- search on it without opening every document.
  name         TEXT NOT NULL DEFAULT '',
  -- Optional structure, for the registers that have it: which subsidiary a
  -- record belongs to, and what it hangs off.
  subsidiary_id TEXT,
  parent_type  TEXT,
  parent_id    TEXT,
  -- Everything the type defines. Encoded and decoded by the database layer
  -- like every other `custom` column in the schema.
  custom       TEXT NOT NULL DEFAULT '{}',
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  created_by   TEXT,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_custom_record_type ON custom_record (tenant_id, type_name, created_at);
CREATE INDEX IF NOT EXISTS ix_custom_record_name ON custom_record (tenant_id, type_name, name);
CREATE INDEX IF NOT EXISTS ix_custom_record_parent ON custom_record (tenant_id, parent_type, parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_custom_record_no ON custom_record (tenant_id, type_name, record_no)
  WHERE record_no != '';
