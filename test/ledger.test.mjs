// The general ledger's invariants. These are the tests that matter most:
// if any of them regress, the books are wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant, DATE } from './helpers.mjs';
import * as gl from '../src/modules/gl.mjs';
import { Money } from '../src/core/util.mjs';

test('a balanced entry posts and updates the rollup', () => {
  const f = freshTenant();
  const e = f.tx(() => gl.postJournal(f.repo, {
    subsidiary_id: f.subsidiaryId, txn_date: DATE, currency: 'USD', memo: 'Capital',
    lines: [
      { account_id: f.posting.bank, debit: Money.parse(100000) },
      { account_id: f.accounts['3010'], credit: Money.parse(100000) },
    ],
  }));
  assert.equal(e.status, 'posted');
  assert.equal(e.total_debit, e.total_credit);
  assert.equal(e.total_debit, Money.parse(100000));

  const balances = gl.balanceMap(f.repo);
  assert.equal(balances[f.posting.bank], Money.parse(100000));
  assert.equal(balances[f.accounts['3010']], -Money.parse(100000));

  const check = gl.integrityCheck(f.repo);
  assert.ok(check.ok, 'integrity check must pass');
  assert.equal(check.rollup_drift.length, 0);
});

test('an unbalanced entry is rejected', () => {
  const f = freshTenant();
  assert.throws(() => f.tx(() => gl.postJournal(f.repo, {
    subsidiary_id: f.subsidiaryId, txn_date: DATE, currency: 'USD',
    lines: [
      { account_id: f.posting.bank, debit: 5000 },
      { account_id: f.accounts['3010'], credit: 4000 },
    ],
  })), /does not balance/);
  // Nothing must have been written.
  assert.equal(f.repo.count('journal_entry'), 0);
  assert.equal(f.repo.count('journal_line'), 0);
});

test('a single-sided entry is rejected', () => {
  const f = freshTenant();
  assert.throws(() => f.tx(() => gl.postJournal(f.repo, {
    subsidiary_id: f.subsidiaryId, txn_date: DATE, currency: 'USD',
    lines: [{ account_id: f.posting.bank, debit: 5000, credit: 5000 }],
  })), /at least two lines|debit or a credit/);
});

test('posting to a summary account is rejected', () => {
  const f = freshTenant();
  const summary = f.repo.queryOne("SELECT id FROM account WHERE tenant_id = :t AND number = '1000'");
  assert.throws(() => f.tx(() => gl.postJournal(f.repo, {
    subsidiary_id: f.subsidiaryId, txn_date: DATE, currency: 'USD',
    lines: [
      { account_id: summary.id, debit: 1000 },
      { account_id: f.accounts['3010'], credit: 1000 },
    ],
  })), /summary account/);
});

test('a closed period refuses new postings, and reopening restores them', () => {
  const f = freshTenant();
  const period = f.repo.queryOne("SELECT * FROM accounting_period WHERE tenant_id = :t AND start_date = '2026-06-01'");
  f.tx(() => gl.closePeriod(f.repo, period.id));

  assert.throws(() => f.tx(() => gl.postJournal(f.repo, {
    subsidiary_id: f.subsidiaryId, txn_date: DATE, currency: 'USD',
    lines: [{ account_id: f.posting.bank, debit: 1000 }, { account_id: f.accounts['3010'], credit: 1000 }],
  })), /is closed/);

  f.tx(() => gl.reopenPeriod(f.repo, period.id));
  const e = f.tx(() => gl.postJournal(f.repo, {
    subsidiary_id: f.subsidiaryId, txn_date: DATE, currency: 'USD',
    lines: [{ account_id: f.posting.bank, debit: 1000 }, { account_id: f.accounts['3010'], credit: 1000 }],
  }));
  assert.equal(e.status, 'posted');
});

test('reversal produces an equal and opposite entry, and cannot be repeated', () => {
  const f = freshTenant();
  const original = f.tx(() => gl.postJournal(f.repo, {
    subsidiary_id: f.subsidiaryId, txn_date: DATE, currency: 'USD', memo: 'Oops',
    lines: [{ account_id: f.posting.bank, debit: 7500 }, { account_id: f.accounts['3010'], credit: 7500 }],
  }));
  const reversal = f.tx(() => gl.reverseJournal(f.repo, original.id));

  assert.equal(reversal.is_reversal, 1);
  assert.equal(reversal.reverses_id, original.id);
  assert.equal(gl.balanceMap(f.repo)[f.posting.bank], 0, 'net effect must be zero');
  assert.throws(() => f.tx(() => gl.reverseJournal(f.repo, original.id)), /already reversed/);
  assert.ok(gl.integrityCheck(f.repo).ok);
});

test('period close is blocked while a draft entry exists', () => {
  const f = freshTenant();
  f.tx(() => gl.postJournal(f.repo, {
    subsidiary_id: f.subsidiaryId, txn_date: DATE, currency: 'USD', status: 'draft',
    lines: [{ account_id: f.posting.bank, debit: 100 }, { account_id: f.accounts['3010'], credit: 100 }],
  }));
  const period = f.repo.queryOne("SELECT * FROM accounting_period WHERE tenant_id = :t AND start_date = '2026-06-01'");
  assert.throws(() => f.tx(() => gl.closePeriod(f.repo, period.id)), /unposted draft/);
  // ...but an explicit override is available.
  const closed = f.tx(() => gl.closePeriod(f.repo, period.id, { force: true }));
  assert.equal(closed.status, 'closed');
});

test('multi-currency posting converts to the subsidiary base currency', () => {
  const f = freshTenant();
  f.tx(() => f.repo.exec(
    "INSERT INTO exchange_rate (tenant_id, from_currency, to_currency, rate_date, rate, source) VALUES (:t,'EUR','USD',?,?,'test')",
    ['2026-01-01', 1.10]));

  const e = f.tx(() => gl.postJournal(f.repo, {
    subsidiary_id: f.subsidiaryId, txn_date: DATE, currency: 'EUR', memo: 'EUR sale',
    lines: [
      { account_id: f.posting.bank, debit: Money.parse(1000) },
      { account_id: f.accounts['4010'], credit: Money.parse(1000) },
    ],
  }));
  assert.equal(e.currency, 'EUR');
  assert.equal(e.fx_rate, 1.10);
  assert.equal(e.total_debit, Money.parse(1100), 'base amount is converted');
  assert.equal(e.lines[0].debit, Money.parse(1000), 'transaction amount is preserved');
  assert.ok(gl.integrityCheck(f.repo).ok);
});

test('a missing exchange rate is reported, not silently defaulted to 1', () => {
  const f = freshTenant();
  assert.throws(() => f.tx(() => gl.postJournal(f.repo, {
    subsidiary_id: f.subsidiaryId, txn_date: DATE, currency: 'JPY',
    lines: [{ account_id: f.posting.bank, debit: 1000 }, { account_id: f.accounts['4010'], credit: 1000 }],
  })), /No exchange rate/);
});

test('rebuildBalances reproduces the rollup exactly', () => {
  const f = freshTenant();
  for (let i = 0; i < 5; i++) {
    f.tx(() => gl.postJournal(f.repo, {
      subsidiary_id: f.subsidiaryId, txn_date: DATE, currency: 'USD',
      lines: [{ account_id: f.posting.bank, debit: 1000 * (i + 1) }, { account_id: f.accounts['4010'], credit: 1000 * (i + 1) }],
    }));
  }
  const before = gl.balanceMap(f.repo);
  f.tx(() => gl.rebuildBalances(f.repo));
  assert.deepEqual(gl.balanceMap(f.repo), before);
  assert.ok(gl.integrityCheck(f.repo).ok);
});
