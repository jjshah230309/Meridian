-- =====================================================================
-- Meridian ERP :: 038_approval_steps
-- Turns approval_rule into a chain instead of one implicit step, and lets
-- a step itself be conditional (e.g. "over 50,000 also needs the CFO").
-- The existing single approver_role_id/approver_user_id columns are kept
-- (nothing else reads them, but dropping a column that used to mean
-- something is a needless migration risk) and backfilled into `steps`.
-- =====================================================================

ALTER TABLE approval_rule ADD COLUMN steps TEXT NOT NULL DEFAULT '[]';

UPDATE approval_rule SET steps = '[{"approver_role_id":' ||
  CASE WHEN approver_role_id IS NULL THEN 'null' ELSE '"' || approver_role_id || '"' END ||
  ',"approver_user_id":' ||
  CASE WHEN approver_user_id IS NULL THEN 'null' ELSE '"' || approver_user_id || '"' END ||
  ',"condition":""}]';

-- Which step of its rule's chain a transaction is currently waiting on, and
-- which rule matched it -- approvalRoute's own condition can depend on the
-- document's current lines, so the match is captured once at routing time
-- rather than recomputed (possibly differently) at every approve/reject.
ALTER TABLE txn ADD COLUMN approval_rule_id TEXT;
ALTER TABLE txn ADD COLUMN approval_step INTEGER NOT NULL DEFAULT 0;
ALTER TABLE txn ADD COLUMN rejected_by TEXT;
ALTER TABLE txn ADD COLUMN rejected_at TEXT;

-- A workflow's "else" branch: the actions that run when its condition does
-- NOT match, instead of nothing happening at all.
ALTER TABLE workflow ADD COLUMN else_actions TEXT NOT NULL DEFAULT '[]';
