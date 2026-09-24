// The analytic OData feeds (ProfitAndLoss, TrialBalance, ...) resolve
// $filter the same way $orderby does: through colMap, to the real SQL
// expression behind a column, not the PascalCase alias Power BI sees. The
// alias used to be spliced straight into WHERE, which only worked for a
// plain column by accident -- SQLite falls back to matching a bare word
// against a SELECT-list alias -- and threw "misuse of aggregate: SUM()" for
// any column backed by one (Amount, Debit, Credit, Balance). Money and
// quantity columns are also stored as scaled integers, so a filter literal
// has to be scaled the same way a column comparison would be, or "Amount gt
// 500" silently compares 500 against a value stored as 50000.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant } from './helpers.mjs';
import * as gl from '../src/modules/gl.mjs';
import * as odata from '../src/modules/odata.mjs';
import { Money } from '../src/core/util.mjs';

const ACCESS = { isOwner: true };

function trader() {
  const f = freshTenant();
  f.sale = (date, amount) => f.tx(() => gl.postJournal(f.repo, {
    subsidiary_id: f.subsidiaryId, txn_date: date, memo: `Cash sale ${date}`,
    lines: [
      { account_id: f.posting.bank, debit: Money.parse(amount) },
      { account_id: f.posting.product_revenue, credit: Money.parse(amount) },
    ],
  }));
  return f;
}

test('$filter on an aggregate analytic column runs in HAVING, not WHERE', () => {
  const f = trader();
  f.sale('2026-03-31', 10000);
  f.sale('2026-04-30', 250);

  // Before the fix, filtering an aggregate column (Amount, Debit, Credit,
  // Balance) threw "misuse of aggregate: SUM()" because the filter landed in
  // WHERE, which runs before GROUP BY.
  const res = odata.readSet(f.repo, ACCESS, 'ProfitAndLoss', { $filter: 'Amount gt 500' });
  assert.ok(res.value.length >= 1, 'expected the 10000 sale to survive the filter');
  assert.ok(res.value.every((r) => r.AccountType === 'INCOME'));
});

test('$filter on a money column compares dollars, not stored minor units', () => {
  const f = trader();
  f.sale('2026-03-31', 10000);
  f.sale('2026-04-30', 250);

  const over = odata.readSet(f.repo, ACCESS, 'ProfitAndLoss', { $filter: 'Amount gt 500' });
  const under = odata.readSet(f.repo, ACCESS, 'ProfitAndLoss', { $filter: 'Amount le 500' });
  // Unscaled, 500 compares against a value stored as 50000 (cents) and both
  // sales -- stored as 1,000,000 and 25,000 -- would read as "gt 500".
  assert.deepEqual(over.value.map((r) => r.Amount).sort((a, b) => a - b), [10000]);
  assert.deepEqual(under.value.map((r) => r.Amount).sort((a, b) => a - b), [250]);
});

test('$filter on a plain (non-aggregate) analytic column still works', () => {
  const f = trader();
  f.sale('2026-03-31', 10000);
  const res = odata.readSet(f.repo, ACCESS, 'ProfitAndLoss', { $filter: "AccountType eq 'INCOME'" });
  assert.ok(res.value.length >= 1);
  assert.ok(res.value.every((r) => r.AccountType === 'INCOME'));
});

test('$filter on TrialBalance Debit/Credit/Balance also runs in HAVING', () => {
  const f = trader();
  f.sale('2026-03-31', 10000);
  const res = odata.readSet(f.repo, ACCESS, 'TrialBalance', { $filter: 'Credit gt 500' });
  assert.ok(res.value.some((r) => r.AccountName === 'Product Revenue' || r.Credit === 10000));
});

test('$filter naming a synthesised or unknown analytic column is a clear 400', () => {
  const f = trader();
  assert.throws(() => odata.readSet(f.repo, ACCESS, 'ProfitAndLoss', { $filter: 'RowId eq 1' }), /Unknown field/);
  assert.throws(() => odata.readSet(f.repo, ACCESS, 'ProfitAndLoss', { $filter: 'NoSuchColumn eq 1' }), /Unknown field/);
});
