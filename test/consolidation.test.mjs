// Group reporting across subsidiaries in different currencies. Translating
// asset/liability accounts at the closing rate and equity at the historical
// rate is exactly what leaves a translated trial balance's debits and
// credits unequal -- the cumulative translation adjustment (CTA) is that gap,
// credited to equity so the balance sheet balances again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant } from './helpers.mjs';
import * as gl from '../src/modules/gl.mjs';
import * as consolidation from '../src/modules/consolidation.mjs';
import { ulid, nowIso, Money } from '../src/core/util.mjs';

const DATE = '2026-06-15';

function ukSubsidiary(f) {
  return f.tx(() => f.repo.insert('subsidiary', {
    id: ulid(), name: 'Test Co UK', legal_name: 'Test Co UK Ltd',
    parent_id: f.subsidiaryId, currency: 'GBP', country: 'GB', tax_number: '',
    address: {}, is_elimination: 0, active: 1, created_at: nowIso(),
  }));
}

test('the CTA is credited (not debited) so a translated group balance sheet actually balances', () => {
  const f = freshTenant(); // USD parent
  const uk = ukSubsidiary(f);
  const period = gl.periodForDate(f.repo, DATE);
  f.tx(() => consolidation.setRate(f.repo, {
    period_id: period.id, from_currency: 'GBP', to_currency: 'USD',
    closing_rate: 1.40, average_rate: 1.30, historical_rate: 1.20,
  }));
  // A capital injection: Dr Cash / Cr Common Stock, 1,000 GBP -- balanced in
  // the subsidiary's own books.
  f.tx(() => gl.postJournal(f.repo, {
    subsidiary_id: uk, txn_date: DATE, memo: 'Capital injection',
    lines: [
      { account_id: f.accounts['1010'], debit: Money.parse(1000) },
      { account_id: f.accounts['3010'], credit: Money.parse(1000) },
    ],
  }));

  const stmt = consolidation.consolidatedStatements(f.repo, { fiscalYear: 2026 });
  // Cash (ASSET) translates at closing (1.40) -> $1,400. Common Stock
  // (EQUITY) translates at historical (1.20) -> $1,200. The $200 gap is the
  // CTA, and it has to sit on the credit/equity side for assets to equal
  // liabilities plus equity again.
  assert.equal(stmt.balance_sheet.total_assets, 1400);
  assert.equal(stmt.balance_sheet.cumulative_translation_adjustment, 200);
  assert.equal(stmt.balance_sheet.total_equity, 1400);
  assert.equal(stmt.balance_sheet.balanced, true,
    'assets must equal liabilities + equity + CTA once currencies are mixed in');
});
