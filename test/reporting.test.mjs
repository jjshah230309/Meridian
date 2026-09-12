// Statements have to agree with the ledger and with each other, and they have
// to keep doing so after 31 December. The balance sheet used to fold only the
// current year's profit into equity, so from the company's second year onward
// it was out by every penny earned before it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant } from './helpers.mjs';
import * as gl from '../src/modules/gl.mjs';
import * as reports from '../src/modules/reports.mjs';
import { Money } from '../src/core/util.mjs';

/** A company whose only activity is cash sales, so the maths is checkable. */
function trader() {
  const f = freshTenant();
  f.sale = (date, amount) => f.tx(() => gl.postJournal(f.repo, {
    subsidiary_id: f.subsidiaryId, txn_date: date, memo: `Cash sale ${date}`,
    lines: [
      { account_id: f.posting.bank, debit: Money.parse(amount) },
      { account_id: f.posting.product_revenue, credit: Money.parse(amount) },
    ],
  }));
  f.cost = (date, amount) => f.tx(() => gl.postJournal(f.repo, {
    subsidiary_id: f.subsidiaryId, txn_date: date, memo: `Rent ${date}`,
    lines: [
      { account_id: f.accounts['6100'], debit: Money.parse(amount) },
      { account_id: f.posting.bank, credit: Money.parse(amount) },
    ],
  }));
  return f;
}

test('the balance sheet balances in the first year', () => {
  const f = trader();
  f.sale('2026-03-31', 10000);
  f.cost('2026-04-30', 2500);
  const bs = reports.balanceSheet(f.repo, { asOf: '2026-12-31' });
  assert.equal(bs.balanced, true, `out by ${bs.out_of_balance}`);
  assert.equal(bs.equity.current_year_earnings, Money.parse(7500));
  assert.equal(bs.equity.retained_earnings_prior_years, 0);
});

test('and keeps balancing once the books span more than one year', () => {
  const f = trader();
  f.sale('2026-03-31', 10000);
  f.cost('2026-04-30', 2500);
  f.sale('2027-03-31', 4000);

  const bs = reports.balanceSheet(f.repo, { asOf: '2027-12-31' });
  assert.equal(bs.balanced, true, `out by ${bs.out_of_balance}`);
  assert.equal(bs.equity.retained_earnings_prior_years, Money.parse(7500),
    'last year\'s profit is retained earnings whether or not anyone closed the year');
  assert.equal(bs.equity.current_year_earnings, Money.parse(4000));
  assert.equal(bs.total_assets, Money.parse(11500));
});

test('the income statement agrees with the ledger for the period asked for', () => {
  const f = trader();
  f.sale('2026-03-31', 10000);
  f.sale('2027-03-31', 4000);

  const y1 = reports.incomeStatement(f.repo, { from: '2026-01-01', to: '2026-12-31' });
  const y2 = reports.incomeStatement(f.repo, { from: '2027-01-01', to: '2027-12-31' });
  assert.equal(y1.net_income, Money.parse(10000));
  assert.equal(y2.net_income, Money.parse(4000), 'the second year does not inherit the first');
});

test('the fiscal year is read from the company calendar, not assumed to be January', () => {
  const f = freshTenant();
  // Re-cut the calendar so the year runs April to March.
  f.tx(() => {
    f.repo.exec('DELETE FROM accounting_period WHERE tenant_id = :t');
    gl.generatePeriods(f.repo, 2026, 4);
  });
  assert.equal(reports.fiscalYearStart(f.repo, '2026-09-15'), '2026-04-01');
  assert.equal(reports.fiscalYearStart(f.repo, '2027-02-15'), '2026-04-01',
    'February belongs to the year that started last April');
});

test('the trial balance and the cash flow reconcile with themselves', () => {
  const f = trader();
  f.sale('2026-03-31', 10000);
  f.cost('2026-04-30', 2500);

  const tb = reports.trialBalance(f.repo, { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(tb.total_debit, tb.total_credit);
  assert.equal(tb.balanced, true);

  const cf = reports.cashFlow(f.repo, { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(cf.reconciles, true, `net change ${cf.net_change_in_cash} vs computed ${cf.computed_cash_movement}`);
  assert.equal(cf.closing_cash, Money.parse(7500));
  assert.ok(gl.integrityCheck(f.repo).ok);
});
