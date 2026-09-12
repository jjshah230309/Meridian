-- =====================================================================
-- Meridian ERP :: 021_collections
-- Getting paid: statements, chasing letters, and admitting defeat.
--
-- The aging report says who is late. It does not say who has been chased,
-- what they promised, who is looking after them, or which balances are never
-- coming. That is the difference between a report and a collections desk, and
-- it is all that was missing.
--
-- Three things go in. A dunning policy -- the ladder of reminders and how
-- many days late each rung is. A notice -- what was actually sent, to whom,
-- at what level, with the balance as it stood. And on the customer, the state
-- a collector works from: their level, who owns them, and what they promised.
-- =====================================================================

CREATE TABLE IF NOT EXISTS dunning_policy (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  -- The smallest balance worth a letter. Chasing $4.00 costs more than $4.00.
  min_balance   INTEGER NOT NULL DEFAULT 0,
  -- Days to wait after a notice before the next rung is allowed.
  cooldown_days INTEGER NOT NULL DEFAULT 7,
  is_default    INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_dunning_policy_name ON dunning_policy (tenant_id, name);

CREATE TABLE IF NOT EXISTS dunning_level (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  policy_id     TEXT NOT NULL,
  level_no      INTEGER NOT NULL,
  name          TEXT NOT NULL,
  days_overdue  INTEGER NOT NULL DEFAULT 0,   -- the oldest item must be this late
  subject       TEXT NOT NULL DEFAULT '',
  body          TEXT NOT NULL DEFAULT '',     -- {{placeholders}} filled at render
  -- What the rung does besides write a letter.
  credit_hold   INTEGER NOT NULL DEFAULT 0,
  charge_interest INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_dunning_level ON dunning_level (tenant_id, policy_id, level_no);

CREATE TABLE IF NOT EXISTS dunning_notice (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  notice_no     TEXT NOT NULL,
  customer_id   TEXT NOT NULL,
  policy_id     TEXT,
  level_no      INTEGER NOT NULL DEFAULT 1,
  level_name    TEXT NOT NULL DEFAULT '',
  as_of         TEXT NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  total_due     INTEGER NOT NULL DEFAULT 0,   -- everything open
  total_overdue INTEGER NOT NULL DEFAULT 0,   -- past its due date
  oldest_days   INTEGER NOT NULL DEFAULT 0,
  document_count INTEGER NOT NULL DEFAULT 0,
  subject       TEXT NOT NULL DEFAULT '',
  body          TEXT NOT NULL DEFAULT '',     -- rendered, so it stays what was sent
  documents     TEXT NOT NULL DEFAULT '[]',   -- snapshot of the open items
  status        TEXT NOT NULL DEFAULT 'issued', -- issued | cancelled
  created_at    TEXT NOT NULL,
  created_by    TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_dunning_notice_no ON dunning_notice (tenant_id, notice_no);
CREATE INDEX IF NOT EXISTS ix_dunning_notice_cust ON dunning_notice (tenant_id, customer_id, as_of);

-- The collections desk's own state, on the customer it belongs to.
ALTER TABLE customer ADD COLUMN collector_id TEXT;
ALTER TABLE customer ADD COLUMN dunning_policy_id TEXT;
ALTER TABLE customer ADD COLUMN dunning_level INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customer ADD COLUMN last_dunned_at TEXT;
ALTER TABLE customer ADD COLUMN promise_date TEXT;
ALTER TABLE customer ADD COLUMN promise_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customer ADD COLUMN collection_note TEXT NOT NULL DEFAULT '';
ALTER TABLE customer ADD COLUMN no_dunning INTEGER NOT NULL DEFAULT 0;

-- A default ladder, so the feature works the moment it is switched on.
INSERT INTO dunning_policy (id, tenant_id, name, description, min_balance, cooldown_days, is_default, active, created_at, updated_at)
SELECT 'DUN' || substr(hex(randomblob(11)), 1, 22), t.id, 'Standard collections',
       'Three rungs: a reminder, a firmer letter, then a final notice that puts the account on hold.',
       2500, 7, 1, 1,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM tenant t
WHERE NOT EXISTS (SELECT 1 FROM dunning_policy p WHERE p.tenant_id = t.id);

INSERT INTO dunning_level (id, tenant_id, policy_id, level_no, name, days_overdue, subject, body, credit_hold, charge_interest)
SELECT 'DUL' || substr(hex(randomblob(11)), 1, 22), p.tenant_id, p.id, 1, 'Reminder', 7,
       'Reminder: {{overdue}} outstanding on account {{account}}',
       'We have not yet received payment of {{overdue}} on account {{account}}, the oldest item being {{oldest_days}} days past due. If it has been paid in the last few days, thank you — please ignore this note. Otherwise the open items are listed below.',
       0, 0
FROM dunning_policy p WHERE NOT EXISTS (SELECT 1 FROM dunning_level l WHERE l.tenant_id = p.tenant_id AND l.policy_id = p.id AND l.level_no = 1);

INSERT INTO dunning_level (id, tenant_id, policy_id, level_no, name, days_overdue, subject, body, credit_hold, charge_interest)
SELECT 'DUL' || substr(hex(randomblob(11)), 1, 22), p.tenant_id, p.id, 2, 'Second request', 30,
       'Second request: {{overdue}} now {{oldest_days}} days overdue',
       'Our reminder of {{last_notice_date}} has not been answered and {{overdue}} remains outstanding on account {{account}}, the oldest item now {{oldest_days}} days past due. Please arrange payment within seven days, or tell us when we can expect it so we can note the account.',
       0, 0
FROM dunning_policy p WHERE NOT EXISTS (SELECT 1 FROM dunning_level l WHERE l.tenant_id = p.tenant_id AND l.policy_id = p.id AND l.level_no = 2);

INSERT INTO dunning_level (id, tenant_id, policy_id, level_no, name, days_overdue, subject, body, credit_hold, charge_interest)
SELECT 'DUL' || substr(hex(randomblob(11)), 1, 22), p.tenant_id, p.id, 3, 'Final notice', 60,
       'Final notice: account {{account}} placed on hold',
       'Despite two written reminders, {{overdue}} remains outstanding on account {{account}} and the oldest item is {{oldest_days}} days past due. The account has been placed on credit hold and no further orders will be released. Please settle the balance in full, or contact us within seven days to agree terms.',
       1, 0
FROM dunning_policy p WHERE NOT EXISTS (SELECT 1 FROM dunning_level l WHERE l.tenant_id = p.tenant_id AND l.policy_id = p.id AND l.level_no = 3);
