-- =====================================================================
-- Meridian ERP :: 027_intercompany
-- Trading with yourself.
--
-- A group that runs more than one company sells between them: the UK entity
-- buys support from the US one, the parent recharges rent, stock moves from
-- one warehouse to another that happens to belong to a different company.
-- Each of those is a real transaction in two sets of books at once, and the
-- group as a whole has not earned or spent a penny.
--
-- Three problems follow, and this migration is shaped by them.
--
-- One: both sides must exist. A recharge that is an expense in one company
-- and nothing in the other is not a recharge, it is a mistake waiting for a
-- year-end. So the pair is written together, in one transaction, or not at
-- all -- and the link between the two halves is kept, because in six months
-- somebody will ask what the other side of this was.
--
-- Two: the two halves must agree. What one company is owed the other owes.
-- Those balances sit in different books, in possibly different currencies,
-- and they drift -- a rate, a rounding, a journal somebody posted by hand.
-- `intercompany_txn` is the register that makes the drift findable.
--
-- Three: it must all disappear on consolidation. The group did not sell
-- anything to itself. Meridian used to handle that by hiding intercompany
-- accounts when consolidating, which is quick but leaves no audit trail and
-- cannot be reviewed, reconciled or explained. Real elimination entries are
-- posted instead, into the elimination subsidiary, where they can be looked
-- at like any other journal.
-- =====================================================================

-- A customer or vendor that is really one of your own companies. This is what
-- lets an ordinary invoice be recognised as an intercompany one.
ALTER TABLE customer ADD COLUMN represents_subsidiary_id TEXT;
ALTER TABLE vendor   ADD COLUMN represents_subsidiary_id TEXT;
CREATE INDEX IF NOT EXISTS ix_customer_represents ON customer (tenant_id, represents_subsidiary_id);
CREATE INDEX IF NOT EXISTS ix_vendor_represents ON vendor (tenant_id, represents_subsidiary_id);

-- The register of everything that crossed a company boundary.
CREATE TABLE IF NOT EXISTS intercompany_txn (
  id                TEXT NOT NULL,
  tenant_id         TEXT NOT NULL,
  reference         TEXT NOT NULL,
  -- journal  -- a recharge or allocation, posted directly to the ledger
  -- sale     -- an invoice in one company, a bill in the other
  kind              TEXT NOT NULL DEFAULT 'journal',
  txn_date          TEXT NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'USD',

  -- "From" is the company giving value: the seller, the one recharging out.
  from_subsidiary_id TEXT NOT NULL,
  to_subsidiary_id   TEXT NOT NULL,
  -- In the currency above. Both sides carry this same figure; what differs is
  -- what it converts to in each company's own books.
  amount            INTEGER NOT NULL DEFAULT 0,

  -- The two halves. Journals for a recharge; transactions for a sale, each
  -- with its own journal behind it.
  from_entry_id     TEXT,
  to_entry_id       TEXT,
  from_txn_id       TEXT,
  to_txn_id         TEXT,

  -- posted     -- both halves are in the books
  -- eliminated -- a consolidation run has cancelled it
  -- reversed   -- undone, both halves
  status            TEXT NOT NULL DEFAULT 'posted',
  elimination_run_id TEXT,

  memo              TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL,
  created_by        TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_ic_reference ON intercompany_txn (tenant_id, reference);
CREATE INDEX IF NOT EXISTS ix_ic_pair ON intercompany_txn (tenant_id, from_subsidiary_id, to_subsidiary_id, txn_date);
CREATE INDEX IF NOT EXISTS ix_ic_status ON intercompany_txn (tenant_id, status, txn_date);

-- One run per period. Re-running a period supersedes the last run rather than
-- adding to it, so a period cannot quietly be eliminated twice.
CREATE TABLE IF NOT EXISTS elimination_run (
  id              TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  run_no          TEXT NOT NULL,
  period_id       TEXT NOT NULL,
  -- Where the entries are posted. An elimination subsidiary belongs to no
  -- country and files nothing; it exists so the cancelling entries have
  -- somewhere to live that is not a real company's books.
  subsidiary_id   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'posted',   -- posted | reversed
  entry_count     INTEGER NOT NULL DEFAULT 0,
  total_eliminated INTEGER NOT NULL DEFAULT 0,
  memo            TEXT NOT NULL DEFAULT '',
  reversed_at     TEXT,
  created_at      TEXT NOT NULL,
  created_by      TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_elimination_run_no ON elimination_run (tenant_id, run_no);
CREATE INDEX IF NOT EXISTS ix_elimination_period ON elimination_run (tenant_id, period_id, status);

-- What each run cancelled, kept so the entry can be explained without
-- re-deriving it from the ledger a year later.
CREATE TABLE IF NOT EXISTS elimination_line (
  id              TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  run_id          TEXT NOT NULL,
  account_id      TEXT NOT NULL,
  subsidiary_id   TEXT NOT NULL,
  base_debit      INTEGER NOT NULL DEFAULT 0,
  base_credit     INTEGER NOT NULL DEFAULT 0,
  note            TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_elimination_line_run ON elimination_line (tenant_id, run_id);

-- Which elimination run produced a journal entry, and which intercompany
-- transaction a document belongs to, so both point back at what made them.
ALTER TABLE journal_entry ADD COLUMN elimination_run_id TEXT;
ALTER TABLE journal_entry ADD COLUMN intercompany_id TEXT;
ALTER TABLE txn ADD COLUMN intercompany_id TEXT;
CREATE INDEX IF NOT EXISTS ix_je_elimination ON journal_entry (tenant_id, elimination_run_id);
CREATE INDEX IF NOT EXISTS ix_je_intercompany ON journal_entry (tenant_id, intercompany_id);
CREATE INDEX IF NOT EXISTS ix_txn_intercompany ON txn (tenant_id, intercompany_id);

-- The two sides of every intercompany balance. Flagged so consolidation knows
-- them, and so the reconciliation has something definite to compare.
INSERT INTO account (id, tenant_id, number, name, type, subtype, is_intercompany, currency, description, created_at, updated_at)
SELECT lower(hex(randomblob(16))), t.id, '1190', 'Due from Affiliates', 'ASSET', 'OTHER_CURRENT_ASSET', 1,
       t.base_currency, 'Owed to this company by another company in the group.', datetime('now'), datetime('now')
FROM tenant t
WHERE NOT EXISTS (SELECT 1 FROM account a WHERE a.tenant_id = t.id AND a.number = '1190');

INSERT INTO account (id, tenant_id, number, name, type, subtype, is_intercompany, currency, description, created_at, updated_at)
SELECT lower(hex(randomblob(16))), t.id, '2190', 'Due to Affiliates', 'LIABILITY', 'OTHER_CURRENT_LIABILITY', 1,
       t.base_currency, 'Owed by this company to another company in the group.', datetime('now'), datetime('now')
FROM tenant t
WHERE NOT EXISTS (SELECT 1 FROM account a WHERE a.tenant_id = t.id AND a.number = '2190');

-- Where the translation difference goes when a group's companies keep their
-- books in different currencies. It is equity, not a gain: the balance has not
-- changed, only the rate used to state it in the parent's currency.
INSERT INTO account (id, tenant_id, number, name, type, subtype, is_intercompany, currency, description, created_at, updated_at)
SELECT lower(hex(randomblob(16))), t.id, '3800', 'Cumulative Translation Adjustment', 'EQUITY', 'OWNER_EQUITY', 0,
       t.base_currency, 'The difference between translating a balance at one rate and at another.', datetime('now'), datetime('now')
FROM tenant t
WHERE NOT EXISTS (SELECT 1 FROM account a WHERE a.tenant_id = t.id AND a.number = '3800');
