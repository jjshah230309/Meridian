-- =====================================================================
-- Meridian ERP :: 012_txn_returns
-- Quantity columns the requisition and return document types need.
--
-- qty_ordered tracks how much of a requisition line has been turned into
-- a purchase order; qty_returned tracks how much of a shipped or received
-- line has come back. Both follow the existing qty_* convention so
-- remainingFor() stays a lookup rather than a special case.
-- =====================================================================
ALTER TABLE txn_line ADD COLUMN qty_ordered  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE txn_line ADD COLUMN qty_returned INTEGER NOT NULL DEFAULT 0;

-- Requisitions and returns carry a few header fields of their own.
ALTER TABLE txn ADD COLUMN requested_by   TEXT;
ALTER TABLE txn ADD COLUMN return_reason  TEXT NOT NULL DEFAULT '';
ALTER TABLE txn ADD COLUMN rma_status     TEXT NOT NULL DEFAULT '';
