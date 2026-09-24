-- The outbox has had a status, an attempt counter and a last_error since
-- migration 005, but nothing ever drained it -- no code read a pending row
-- and tried to deliver it. Now that something does, retries need a way to
-- back off without polling the whole table on every tick: a due row is
-- pending with next_attempt_at unset or in the past.
ALTER TABLE integration_event ADD COLUMN next_attempt_at TEXT;
CREATE INDEX IF NOT EXISTS ix_intev_due ON integration_event(status, next_attempt_at);
