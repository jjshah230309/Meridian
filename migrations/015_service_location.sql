-- A service order needs to say which stock it draws parts from. Without it,
-- a part could only ever be issued from a technician's van, so a shop repair
-- (or any job with no van stock) billed the part and never relieved it.
ALTER TABLE service_order ADD COLUMN location_id TEXT;
