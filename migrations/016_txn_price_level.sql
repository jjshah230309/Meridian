-- The price level a document was priced at. It was already read when a quote
-- became an order and an order became an invoice, but never stored, so the
-- agreed level was lost the moment the quote was saved.
ALTER TABLE txn ADD COLUMN price_level_id TEXT;
