// Recurring journals and self-reversing accruals. The two things being proved
// are that a template posts on the dates its calendar says and no others, and
// that nothing — a closed period, a pause, an end date — can make it post the
// same month twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant } from './helpers.mjs';
import * as recurring from '../src/modules/recurring.mjs';
import * as gl from '../src/modules/gl.mjs';
import { Money } from '../src/core/util.mjs';

const acct = (f, n) => f.repo.queryOne('SELECT id FROM account WHERE tenant_id = :t AND number = ?', [n])?.id;
const balance = (f, n) => f.repo.scalar(
  `SELECT COALESCE(SUM(jl.base_debit - jl.base_credit), 0) v FROM journal_line jl
   JOIN journal_entry je ON je.id = jl.entry_id JOIN account a ON a.id = jl.account_id
   WHERE jl.tenant_id = :t AND je.status = 'posted' AND a.number = ?`, [n], 0);
const dates = (f, id) => f.repo.query(
  'SELECT txn_date, is_reversal FROM journal_entry WHERE tenant_id = :t AND recurring_id = ? ORDER BY txn_date, is_reversal', [id]);
const thrown = (fn) => { try { fn(); } catch (e) { return e; } return null; };

function rent(f, patch = {}) {
  return f.tx(() => recurring.createRecurring(f.repo, {
    name: 'Office rent', subsidiary_id: f.subsidiaryId, memo: 'Head office lease',
    frequency: 'monthly', day_rule: 'day_of_month', day_of_month: 1,
    start_date: '2026-01-01',
    lines: [
      { account_id: acct(f, '6100'), debit: 8500 },
      { account_id: acct(f, '1010'), credit: 8500 },
    ],
    ...patch,
  }));
}

function accrual(f, patch = {}) {
  return f.tx(() => recurring.createRecurring(f.repo, {
    name: 'Utilities accrual', subsidiary_id: f.subsidiaryId,
    frequency: 'monthly', day_rule: 'month_end', start_date: '2026-01-01', auto_reverse: true,
    lines: [
      { account_id: acct(f, '6110'), debit: 1450 },
      { account_id: acct(f, '2020'), credit: 1450 },
    ],
    ...patch,
  }));
}

test('a template will not be saved with lines that do not balance', () => {
  const f = freshTenant();
  const err = thrown(() => rent(f, { lines: [
    { account_id: acct(f, '6100'), debit: 8500 },
    { account_id: acct(f, '1010'), credit: 8000 },
  ] }));
  assert.ok(err, 'it was refused');
  assert.match(err.fields.lines, /do not equal/);
  assert.equal(f.repo.scalar('SELECT COUNT(*) c FROM recurring_journal WHERE tenant_id = :t', [], 0), 0);
});

test('a template will not be saved against a summary account', () => {
  const f = freshTenant();
  const err = thrown(() => rent(f, { lines: [
    { account_id: acct(f, '6000'), debit: 8500 },
    { account_id: acct(f, '1010'), credit: 8500 },
  ] }));
  assert.match(err.fields['lines.0.account_id'], /summary account/);
});

test('a monthly standing entry catches up one occurrence per month', () => {
  const f = freshTenant();
  const r = rent(f);
  assert.equal(r.next_date, '2026-01-01');

  const run = f.tx(() => recurring.generate(f.repo, { through: '2026-04-15' }));
  assert.equal(run.generated, 4, 'January to April, not one lump');
  assert.deepEqual(dates(f, r.id).map((e) => e.txn_date), ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01']);
  assert.equal(balance(f, '6100'), Money.parse(34000));
  assert.equal(balance(f, '1010'), Money.parse(-34000));
  assert.equal(gl.integrityCheck(f.repo).ok, true);

  const after = recurring.getRecurring(f.repo, r.id);
  assert.equal(after.next_date, '2026-05-01');
  assert.equal(after.occurrences, 4);
  assert.equal(after.last_run_date, '2026-04-01');
});

test('running the same period again posts nothing', () => {
  const f = freshTenant();
  const r = rent(f);
  f.tx(() => recurring.generate(f.repo, { through: '2026-04-15' }));
  const again = f.tx(() => recurring.generate(f.repo, { through: '2026-04-15' }));
  assert.equal(again.generated, 0);
  assert.equal(dates(f, r.id).length, 4);
  assert.equal(balance(f, '6100'), Money.parse(34000));
});

test('a dry run reports what would post and posts nothing', () => {
  const f = freshTenant();
  const r = rent(f);
  const dry = recurring.generate(f.repo, { through: '2026-03-31', dry_run: true });
  assert.equal(dry.generated, 3);
  assert.equal(dry.amount, 25500);
  assert.equal(dates(f, r.id).length, 0);
  assert.equal(recurring.getRecurring(f.repo, r.id).next_date, '2026-01-01', 'the calendar did not move');
});

test('an accrual unwinds itself on the following day', () => {
  const f = freshTenant();
  const a = accrual(f);
  f.tx(() => recurring.generate(f.repo, { through: '2026-03-31' }));

  assert.deepEqual(dates(f, a.id).map((e) => `${e.txn_date}${e.is_reversal ? 'R' : ''}`), [
    '2026-01-31', '2026-02-01R', '2026-02-28', '2026-03-01R', '2026-03-31', '2026-04-01R',
  ], 'month end, then the first of the next month');
  assert.equal(balance(f, '2020'), 0, 'the accrual nets to nothing once reversed');
  assert.equal(balance(f, '6110'), 0);
  assert.equal(gl.integrityCheck(f.repo).ok, true);
});

test('an accrual leaves the expense standing in the month it belongs to', () => {
  const f = freshTenant();
  accrual(f);
  f.tx(() => recurring.generate(f.repo, { through: '2026-01-31' }));
  // Posted on 31 January, reversed on 1 February: January carries the cost.
  const jan = f.repo.queryOne("SELECT * FROM accounting_period WHERE tenant_id = :t AND start_date = '2026-01-01'");
  const inJan = f.repo.scalar(
    `SELECT COALESCE(SUM(base_debit - base_credit), 0) v FROM gl_balance
     WHERE tenant_id = :t AND period_id = ? AND account_id = ?`, [jan.id, acct(f, '6110')], 0);
  assert.equal(inJan, Money.parse(1450));
});

test('a quarterly template steps three months at a time', () => {
  const f = freshTenant();
  const q = accrual(f, { name: 'Audit fee', frequency: 'quarterly', auto_reverse: false });
  f.tx(() => recurring.generate(f.repo, { through: '2026-12-31' }));
  assert.deepEqual(dates(f, q.id).map((e) => e.txn_date), ['2026-01-31', '2026-04-30', '2026-07-31', '2026-10-31']);
});

test('a weekly template steps seven days from its start date', () => {
  const f = freshTenant();
  const w = rent(f, { name: 'Weekly float', frequency: 'weekly', start_date: '2026-01-05' });
  f.tx(() => recurring.generate(f.repo, { through: '2026-02-01' }));
  assert.deepEqual(dates(f, w.id).map((e) => e.txn_date),
    ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26']);
});

test('an end date stops the template and marks it ended', () => {
  const f = freshTenant();
  const r = rent(f, { end_date: '2026-03-31' });
  const run = f.tx(() => recurring.generate(f.repo, { through: '2026-12-31' }));
  assert.equal(run.generated, 3);
  assert.equal(recurring.getRecurring(f.repo, r.id).status, 'ended');
  assert.equal(f.tx(() => recurring.generate(f.repo, { through: '2026-12-31' })).generated, 0);
});

test('a run limit stops the template and marks it ended', () => {
  const f = freshTenant();
  const r = rent(f, { max_occurrences: 2 });
  const run = f.tx(() => recurring.generate(f.repo, { through: '2026-12-31' }));
  assert.equal(run.generated, 2);
  const after = recurring.getRecurring(f.repo, r.id);
  assert.equal(after.status, 'ended');
  assert.equal(after.occurrences, 2);
});

test('a paused template is left alone until it is resumed', () => {
  const f = freshTenant();
  const r = rent(f);
  f.tx(() => recurring.setStatus(f.repo, r.id, 'paused'));
  assert.equal(f.tx(() => recurring.generate(f.repo, { through: '2026-06-30' })).generated, 0);

  f.tx(() => recurring.setStatus(f.repo, r.id, 'active'));
  const run = f.tx(() => recurring.generate(f.repo, { through: '2026-06-30' }));
  assert.equal(run.generated, 6, 'the months it sat out are still owed');
});

test('a closed period stops that template where it stands and says why', () => {
  const f = freshTenant();
  const r = rent(f);
  f.tx(() => recurring.generate(f.repo, { through: '2026-02-28' }));
  const mar = f.repo.queryOne("SELECT * FROM accounting_period WHERE tenant_id = :t AND start_date = '2026-03-01'");
  f.tx(() => gl.closePeriod(f.repo, mar.id, { force: true }));

  const run = f.tx(() => recurring.generate(f.repo, { through: '2026-05-31' }));
  assert.equal(run.generated, 0, 'April cannot jump the queue ahead of March');
  assert.equal(run.skipped.length, 1);
  assert.match(run.skipped[0].reason, /closed/);
  assert.equal(recurring.getRecurring(f.repo, r.id).next_date, '2026-03-01', 'still waiting on March');

  f.tx(() => gl.reopenPeriod(f.repo, mar.id));
  assert.equal(f.tx(() => recurring.generate(f.repo, { through: '2026-05-31' })).generated, 3);
});

test('an accrual whose reversal has nowhere to land still posts, and says so', () => {
  const f = freshTenant();
  const a = accrual(f);
  const feb = f.repo.queryOne("SELECT * FROM accounting_period WHERE tenant_id = :t AND start_date = '2026-02-01'");
  f.tx(() => gl.closePeriod(f.repo, feb.id, { force: true }));

  const run = f.tx(() => recurring.generate(f.repo, { through: '2026-01-31' }));
  assert.equal(run.generated, 1);
  assert.equal(run.posted[0].reversal_no, null);
  assert.match(run.skipped[0].reason, /reversal cannot/);
  assert.equal(balance(f, '2020'), Money.parse(-1450), 'the accrual is standing, unreversed');
});

test('moving the calendar never rewinds past what has already posted', () => {
  const f = freshTenant();
  const r = rent(f);
  f.tx(() => recurring.generate(f.repo, { through: '2026-03-31' }));
  const moved = f.tx(() => recurring.updateRecurring(f.repo, r.id, { day_of_month: 15 }));
  assert.equal(moved.next_date, '2026-04-15', 'the next one, not a re-run of March');
  const run = f.tx(() => recurring.generate(f.repo, { through: '2026-04-30' }));
  assert.equal(run.generated, 1);
  assert.equal(dates(f, r.id).length, 4);
});

test('changing the lines changes what the next occurrence posts, not the past', () => {
  const f = freshTenant();
  const r = rent(f);
  f.tx(() => recurring.generate(f.repo, { through: '2026-01-31' }));
  f.tx(() => recurring.updateRecurring(f.repo, r.id, { lines: [
    { account_id: acct(f, '6100'), debit: 9000 },
    { account_id: acct(f, '1010'), credit: 9000 },
  ] }));
  f.tx(() => recurring.generate(f.repo, { through: '2026-02-28' }));
  assert.equal(balance(f, '6100'), Money.parse(17500), '8,500 then 9,000');
});

test('one template can be run on its own', () => {
  const f = freshTenant();
  const r = rent(f);
  const other = accrual(f);
  const run = f.tx(() => recurring.generate(f.repo, { through: '2026-02-28', id: r.id }));
  assert.equal(run.generated, 2);
  assert.equal(dates(f, other.id).length, 0);
});

test('the history of a template lists the entries it produced', () => {
  const f = freshTenant();
  const a = accrual(f);
  f.tx(() => recurring.generate(f.repo, { through: '2026-02-28' }));
  const history = recurring.historyFor(f.repo, a.id);
  assert.equal(history.length, 4, 'two accruals and two reversals');
  assert.equal(history.filter((e) => e.is_reversal).length, 2);
});

test('the due list shows only what a run would actually pick up', () => {
  const f = freshTenant();
  rent(f);
  const paused = accrual(f);
  f.tx(() => recurring.setStatus(f.repo, paused.id, 'paused'));
  const due = recurring.due(f.repo, { through: '2026-01-31' });
  assert.equal(due.length, 1);
  assert.equal(due[0].name, 'Office rent');
});

test('a template that has posted cannot be deleted', () => {
  const f = freshTenant();
  const r = rent(f);
  f.tx(() => recurring.generate(f.repo, { through: '2026-01-31' }));
  const err = thrown(() => f.tx(() => recurring.deleteRecurring(f.repo, r.id)));
  assert.ok(err, 'it was refused');
  assert.match(err.message, /End it instead/);
  assert.equal(f.repo.scalar('SELECT COUNT(*) c FROM recurring_journal WHERE tenant_id = :t', [], 0), 1);
});

test('a template that never ran is deleted along with its lines', () => {
  const f = freshTenant();
  const r = rent(f);
  f.tx(() => recurring.deleteRecurring(f.repo, r.id));
  assert.equal(f.repo.scalar('SELECT COUNT(*) c FROM recurring_journal WHERE tenant_id = :t', [], 0), 0);
  assert.equal(f.repo.scalar('SELECT COUNT(*) c FROM recurring_journal_line WHERE tenant_id = :t', [], 0), 0,
    'no orphan lines left behind');
});
