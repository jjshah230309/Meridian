-- A pick task drawn from a bin carries the bin's lot_number but never its
-- serial_no, even though bin_quantity is keyed by (bin_id, item_id,
-- lot_number, serial_no) -- so confirming a pick against a serialised item
-- looked up bin_quantity under the wrong (empty) serial and found nothing.
ALTER TABLE pick_task ADD COLUMN serial_no TEXT NOT NULL DEFAULT '';
