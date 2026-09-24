// Keeping more than one set of books over the same transactions.
//
// The claim these tests defend is narrow and important: a second book can be
// added, adjusted, depreciated and reported on, and the primary ledger comes
// out of it byte for byte unchanged. That is the whole reason a secondary book
// holds only differences rather than a copy of everything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant } from './helpers.mjs';
import * as books from '../src/modules/books.mjs';
import * as reports from '../src/modules/reports.mjs';
import * as gl from '../src/modules/gl.mjs';
import * as assets from '../src/modules/assets.mjs';
import { Money, ulid, nowIso } from '../src/core/util.mjs';

const DATE = '2026-06-15';
const acct = (f, n) => f.repo.queryOne('SELECT * FROM account WHERE tenant_id = :t AND number = ?', [n]);
const thrown = (fn) => { try { fn(); } catch (e) { return e; } return null; };

const ifrs = (f) => f.tx(() => books.createBook(f.repo, {
  name: 'IFRS', code: 'IFRS', purpose: 'IFRS', description: 'Group reporting basis.',
}));

/**
 * Some ordinary trading, so the primary book has something in it.
 *
 * Banked rather than invoiced on purpose: a raw journal straight at
 * receivables would put the control account out against its subledger, and
 * these tests check integrity.
 */
function trade(f) {
  return f.tx(() => gl.postJournal(f.repo, {
    subsidiary_id: f.subsidiaryId, txn_date: DATE, memo: 'Consulting',
    lines: [
      { account_id: acct(f, '1010').id, debit: Money.parse(10000) },
      { account_id: acct(f, '4020').id, credit: Money.parse(10000) },
    ],
  }));
}

// --------------------------------------------------------------- the books
test('every tenant has exactly one primary book, and it is the ledger', () => {
  const f = freshTenant();
  const p = books.primaryBook(f.repo);
  assert.ok(p);
  assert.equal(p.code, 'PRIMARY');
  assert.equal(p.is_primary, 1);
  assert.equal(books.listBooks(f.repo).length, 1);
});

test('a second book cannot claim to be primary', () => {
  const f = freshTenant();
  const b = f.tx(() => books.createBook(f.repo, { name: 'IFRS', code: 'IFRS', is_primary: true }));
  assert.equal(b.is_primary, 0, 'the request is simply not honoured');
  const e = thrown(() => f.tx(() => books.updateBook(f.repo, b.id, { is_primary: true })));
  assert.match(e.message, /cannot change/);
});

test('the primary book cannot be deleted, demoted or switched off', () => {
  const f = freshTenant();
  const p = books.primaryBook(f.repo);
  assert.match(thrown(() => f.tx(() => books.deleteBook(f.repo, p.id))).message, /cannot be deleted/);
  assert.match(thrown(() => f.tx(() => books.updateBook(f.repo, p.id, { status: 'inactive' }))).message, /cannot be deactivated/);
});

test('a book code has to be a code', () => {
  const f = freshTenant();
  for (const bad of ['1IFRS', 'I', '', 'IF RS', 'IFRS-2']) {
    assert.ok(thrown(() => f.tx(() => books.createBook(f.repo, { name: 'X', code: bad }))), `${bad} should be refused`);
  }
  // A code in the wrong case is corrected rather than rejected.
  assert.equal(f.tx(() => books.createBook(f.repo, { name: 'X', code: 'ifrs' })).code, 'IFRS');
});

test('two books cannot share a code', () => {
  const f = freshTenant();
  ifrs(f);
  const e = thrown(() => f.tx(() => books.createBook(f.repo, { name: 'Another', code: 'IFRS' })));
  assert.match(JSON.stringify(e.details), /already exists/);
});

// --------------------------------------------------------- the adjustments
test('an adjustment is a difference, so it cannot be posted to the primary book', () => {
  const f = freshTenant();
  const p = books.primaryBook(f.repo);
  const e = thrown(() => f.tx(() => books.postAdjustment(f.repo, {
    book_id: p.id, subsidiary_id: f.subsidiaryId, txn_date: DATE,
    lines: [
      { account_id: acct(f, '4020').id, base_credit: 100 },
      { account_id: acct(f, '1100').id, base_debit: 100 },
    ],
  })));
  assert.match(e.message, /post an ordinary journal entry/);
});

test('an adjustment has to balance', () => {
  const f = freshTenant();
  const b = ifrs(f);
  const e = thrown(() => f.tx(() => books.postAdjustment(f.repo, {
    book_id: b.id, subsidiary_id: f.subsidiaryId, txn_date: DATE,
    lines: [
      { account_id: acct(f, '4020').id, base_credit: 100 },
      { account_id: acct(f, '1100').id, base_debit: 90 },
    ],
  })));
  assert.match(e.message, /does not balance/);
});

test('an adjustment moves that book and nothing else', () => {
  const f = freshTenant();
  const b = ifrs(f);
  trade(f);

  const primaryBefore = reports.trialBalance(f.repo, { to: '2026-12-31' });

  f.tx(() => books.postAdjustment(f.repo, {
    book_id: b.id, subsidiary_id: f.subsidiaryId, txn_date: DATE,
    memo: 'IFRS defers this revenue',
    lines: [
      { account_id: acct(f, '4020').id, base_debit: Money.parse(4000) },
      { account_id: acct(f, '2300').id, base_credit: Money.parse(4000) },
    ],
  }));

  // The ledger is untouched — which is the whole point of the design.
  const primaryAfter = reports.trialBalance(f.repo, { to: '2026-12-31' });
  assert.deepEqual(primaryAfter.lines, primaryBefore.lines, 'the primary book is byte for byte what it was');

  // The IFRS book sees the ledger plus the difference.
  const ifrsBook = reports.trialBalance(f.repo, { to: '2026-12-31', bookId: b.id });
  const rev = (tb) => tb.lines.find((l) => l.number === '4020');
  assert.equal(rev(primaryAfter).credit, Money.parse(10000));
  assert.equal(rev(ifrsBook).credit, Money.parse(6000), 'four thousand deferred');
  assert.ok(ifrsBook.lines.find((l) => l.number === '2300'), 'and the deferral appears');
  assert.ok(ifrsBook.balanced, 'and the book still balances');
});

test('asking for the primary book by name gets the ledger, unchanged', () => {
  const f = freshTenant();
  const b = ifrs(f);
  trade(f);
  f.tx(() => books.postAdjustment(f.repo, {
    book_id: b.id, subsidiary_id: f.subsidiaryId, txn_date: DATE,
    lines: [
      { account_id: acct(f, '4020').id, base_debit: Money.parse(4000) },
      { account_id: acct(f, '2300').id, base_credit: Money.parse(4000) },
    ],
  }));
  const byDefault = reports.trialBalance(f.repo, { to: '2026-12-31' });
  const byName = reports.trialBalance(f.repo, { to: '2026-12-31', bookId: books.primaryBook(f.repo).id });
  assert.deepEqual(byName.lines, byDefault.lines);
});

test('the income statement differs by exactly what was adjusted', () => {
  const f = freshTenant();
  const b = ifrs(f);
  trade(f);
  f.tx(() => books.postAdjustment(f.repo, {
    book_id: b.id, subsidiary_id: f.subsidiaryId, txn_date: DATE,
    lines: [
      { account_id: acct(f, '4020').id, base_debit: Money.parse(4000) },
      { account_id: acct(f, '2300').id, base_credit: Money.parse(4000) },
    ],
  }));
  const primary = reports.incomeStatement(f.repo, { from: '2026-01-01', to: '2026-12-31' });
  const other = reports.incomeStatement(f.repo, { from: '2026-01-01', to: '2026-12-31', bookId: b.id });
  assert.equal(primary.net_income - other.net_income, Money.parse(4000));
});

test('a rule-driven adjustment happens once, however many times it is run', () => {
  const f = freshTenant();
  const b = ifrs(f);
  const post = () => f.tx(() => books.postAdjustment(f.repo, {
    book_id: b.id, subsidiary_id: f.subsidiaryId, txn_date: DATE,
    source_type: 'depreciation', source_key: 'depr:asset-1:3',
    lines: [
      { account_id: acct(f, '6800').id, base_debit: 500 },
      { account_id: acct(f, '1590').id, base_credit: 500 },
    ],
  }));
  post();
  const e = thrown(post);
  assert.match(e.message, /already has/);
  assert.equal(books.adjustments(f.repo, { book_id: b.id }).total, 1);
});

test('reversing an adjustment takes it back out and lets it be posted again', () => {
  const f = freshTenant();
  const b = ifrs(f);
  trade(f);
  const a = f.tx(() => books.postAdjustment(f.repo, {
    book_id: b.id, subsidiary_id: f.subsidiaryId, txn_date: DATE,
    source_key: 'once',
    lines: [
      { account_id: acct(f, '4020').id, base_debit: Money.parse(4000) },
      { account_id: acct(f, '2300').id, base_credit: Money.parse(4000) },
    ],
  }));
  f.tx(() => books.reverseAdjustment(f.repo, a.id));

  const after = reports.trialBalance(f.repo, { to: '2026-12-31', bookId: b.id });
  const primary = reports.trialBalance(f.repo, { to: '2026-12-31' });
  assert.equal(
    after.lines.find((l) => l.number === '4020').credit,
    primary.lines.find((l) => l.number === '4020').credit,
    'the book agrees with the ledger again');
  assert.equal(f.repo.get('book_adjustment', a.id).status, 'reversed');
});

// -------------------------------------------------- book-specific assets
/** A machine on five years in the ledger, with a year charged. */
function machine(f) {
  const cls = f.tx(() => f.repo.insert('asset_class', {
    id: ulid(), name: 'Plant', method: 'STRAIGHT_LINE', life_months: 60,
    asset_account_id: acct(f, '1500').id, accum_account_id: acct(f, '1590').id,
    expense_account_id: acct(f, '6800').id, active: 1, created_at: nowIso(),
  }));
  const a = f.tx(() => assets.createAsset(f.repo, {
    name: 'Line 4 press', class_id: cls, subsidiary_id: f.subsidiaryId,
    acquisition_date: '2026-01-01', in_service_date: '2026-01-01',
    cost: 60000, life_months: 60, method: 'STRAIGHT_LINE',
    asset_account_id: acct(f, '1500').id, accum_account_id: acct(f, '1590').id,
    expense_account_id: acct(f, '6800').id,
  }));
  f.tx(() => assets.placeInService(f.repo, a.id, { in_service_date: '2026-01-01' }));
  f.tx(() => assets.runDepreciation(f.repo, { through: '2026-06-30' }));
  return assets.getAsset(f.repo, a.id);
}

test('a book that disagrees about useful life posts only the difference', () => {
  const f = freshTenant();
  const b = ifrs(f);
  const a = machine(f);

  // The ledger says five years — 1,000 a month. This book says ten.
  f.tx(() => books.setAssetRule(f.repo, {
    book_id: b.id, asset_id: a.id, method: 'STRAIGHT_LINE', life_months: 120,
    note: 'Useful life reassessed under IFRS.',
  }));

  const plan = books.runBookDepreciation(f.repo, { book_id: b.id, through: '2026-06-30', dry_run: true });
  assert.equal(plan.planned.length, 6, 'six periods the ledger has charged');
  assert.equal(plan.planned[0].primary_amount, Money.parse(1000));
  assert.equal(plan.planned[0].book_amount, Money.parse(500));
  assert.equal(plan.planned[0].difference, -Money.parse(500), 'this book charges less');
  assert.equal(f.repo.scalar('SELECT COUNT(*) c FROM book_adjustment WHERE tenant_id = :t', [], 0), 0, 'and a dry run writes nothing');

  const run = f.tx(() => books.runBookDepreciation(f.repo, { book_id: b.id, through: '2026-06-30' }));
  assert.equal(run.posted, 6);
  assert.equal(run.total_difference, -Money.parse(3000));
});

test('the two books then show different depreciation and the same asset', () => {
  const f = freshTenant();
  const b = ifrs(f);
  const a = machine(f);
  f.tx(() => books.setAssetRule(f.repo, { book_id: b.id, asset_id: a.id, life_months: 120 }));
  f.tx(() => books.runBookDepreciation(f.repo, { book_id: b.id, through: '2026-06-30' }));

  const charge = (tb) => tb.lines.find((l) => l.number === '6800')?.debit || 0;
  const primary = reports.trialBalance(f.repo, { to: '2026-12-31' });
  const other = reports.trialBalance(f.repo, { to: '2026-12-31', bookId: b.id });

  assert.equal(charge(primary), Money.parse(6000), 'six months at a five-year life');
  assert.equal(charge(other), Money.parse(3000), 'and at a ten-year life');
  assert.ok(other.balanced);
  // Cost is the same in both: the machine did not change, only the opinion
  // about how long it lasts.
  const cost = (tb) => tb.lines.find((l) => l.number === '1500')?.debit || 0;
  assert.equal(cost(other), cost(primary));
});

test('running the book depreciation twice charges nothing the second time', () => {
  const f = freshTenant();
  const b = ifrs(f);
  const a = machine(f);
  f.tx(() => books.setAssetRule(f.repo, { book_id: b.id, asset_id: a.id, life_months: 120 }));
  const first = f.tx(() => books.runBookDepreciation(f.repo, { book_id: b.id, through: '2026-06-30' }));
  const second = f.tx(() => books.runBookDepreciation(f.repo, { book_id: b.id, through: '2026-06-30' }));
  assert.equal(first.posted, 6);
  assert.equal(second.posted, 0);
});

test('a rule cannot be set on the primary book', () => {
  const f = freshTenant();
  const a = machine(f);
  const p = books.primaryBook(f.repo);
  const e = thrown(() => f.tx(() => books.setAssetRule(f.repo, { book_id: p.id, asset_id: a.id, life_months: 120 })));
  assert.match(e.message, /already has the asset/);
});

// Dates arrive from query strings and request bodies, so one can be an array
// or the word "yesterday". SQLite cannot bind most of those and throws a
// driver-level TypeError, which reaches the client as a 500 for what is only
// a badly typed filter. This was a real 500 on POST /books/:id/depreciation.
test('a date of the wrong shape is a bad request, not a crash', () => {
  const f = freshTenant();
  const b = ifrs(f);
  for (const bad of [[], {}, true, 42, 'yesterday', '2026-13-45', null]) {
    const e = thrown(() => books.runBookDepreciation(f.repo, { book_id: b.id, through: bad, dry_run: true }));
    assert.ok(e, `${JSON.stringify(bad)} should be refused`);
    assert.equal(e.status, 422, 'and refused as a bad request');
  }
  // A real date still works.
  assert.equal(books.runBookDepreciation(f.repo, { book_id: b.id, through: '2026-06-30', dry_run: true }).planned.length, 0);
});

test('the same guard covers the filters that reach SQL', () => {
  const f = freshTenant();
  const b = ifrs(f);
  assert.equal(thrown(() => books.adjustments(f.repo, { book_id: b.id, from: [] }))?.status, 422);
  assert.equal(thrown(() => books.comparison(f.repo, { to: {} }))?.status, 422);
  assert.equal(thrown(() => books.adjustmentBalances(f.repo, { book_id: b.id, to: true }))?.status, 422);
  // And absent is still absent, not an error.
  assert.equal(books.adjustments(f.repo, { book_id: b.id, from: null }).total, 0);
});

// ------------------------------------------------------------ comparison
test('the books can be compared, and agreeing shows as nothing', () => {
  const f = freshTenant();
  const b = ifrs(f);
  trade(f);

  let cmp = books.comparison(f.repo, { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(cmp.books.length, 2);
  assert.equal(cmp.books.find((x) => x.is_primary).profit_difference, 0);
  assert.equal(cmp.books.find((x) => !x.is_primary).profit_difference, 0, 'nothing has been adjusted yet');

  f.tx(() => books.postAdjustment(f.repo, {
    book_id: b.id, subsidiary_id: f.subsidiaryId, txn_date: DATE,
    lines: [
      { account_id: acct(f, '4020').id, base_debit: Money.parse(4000) },
      { account_id: acct(f, '2300').id, base_credit: Money.parse(4000) },
    ],
  }));
  cmp = books.comparison(f.repo, { from: '2026-01-01', to: '2026-12-31' });
  const other = cmp.books.find((x) => !x.is_primary);
  assert.equal(other.profit_difference, -Money.parse(4000), 'this book earns four thousand less');
  assert.equal(other.adjustment_count, 1);
});

// ---------------------------------------------------------- the guarantee
test('none of this leaves a mark on the ledger', () => {
  const f = freshTenant();
  const b = ifrs(f);
  trade(f);
  const a = machine(f);

  const before = {
    integrity: gl.integrityCheck(f.repo),
    tb: reports.trialBalance(f.repo, { to: '2026-12-31' }),
    entries: f.repo.scalar('SELECT COUNT(*) c FROM journal_entry WHERE tenant_id = :t', [], 0),
    lines: f.repo.scalar('SELECT COUNT(*) c FROM journal_line WHERE tenant_id = :t', [], 0),
  };

  f.tx(() => books.setAssetRule(f.repo, { book_id: b.id, asset_id: a.id, life_months: 120 }));
  f.tx(() => books.runBookDepreciation(f.repo, { book_id: b.id, through: '2026-06-30' }));
  f.tx(() => books.postAdjustment(f.repo, {
    book_id: b.id, subsidiary_id: f.subsidiaryId, txn_date: DATE,
    lines: [
      { account_id: acct(f, '4020').id, base_debit: Money.parse(4000) },
      { account_id: acct(f, '2300').id, base_credit: Money.parse(4000) },
    ],
  }));

  const after = {
    integrity: gl.integrityCheck(f.repo),
    tb: reports.trialBalance(f.repo, { to: '2026-12-31' }),
    entries: f.repo.scalar('SELECT COUNT(*) c FROM journal_entry WHERE tenant_id = :t', [], 0),
    lines: f.repo.scalar('SELECT COUNT(*) c FROM journal_line WHERE tenant_id = :t', [], 0),
  };

  assert.equal(after.entries, before.entries, 'not one journal entry was added');
  assert.equal(after.lines, before.lines, 'nor one journal line');
  assert.deepEqual(after.tb.lines, before.tb.lines, 'and the trial balance is identical');
  assert.ok(before.integrity.ok, 'the ledger was sound to begin with');
  assert.ok(after.integrity.ok, 'and it still is');
  assert.ok(after.integrity.ledger_balanced);
});

test('one asset failing does not roll back another asset already adjusted in the same run', () => {
  // runBookDepreciation used to post every asset's adjustment inside one
  // transaction (postAdjustment manages no transaction of its own), so an
  // asset whose expense account went inactive rolled back adjustments this
  // same run had already posted for a different, unrelated asset.
  const f = freshTenant();
  const b = ifrs(f);
  const goodClass = f.tx(() => f.repo.insert('asset_class', {
    id: ulid(), name: 'Plant A', method: 'STRAIGHT_LINE', life_months: 60,
    asset_account_id: acct(f, '1500').id, accum_account_id: acct(f, '1590').id,
    expense_account_id: acct(f, '6800').id, active: 1, created_at: nowIso(),
  }));
  const badClass = f.tx(() => f.repo.insert('asset_class', {
    id: ulid(), name: 'Plant B', method: 'STRAIGHT_LINE', life_months: 60,
    asset_account_id: acct(f, '1500').id, accum_account_id: acct(f, '1590').id,
    expense_account_id: acct(f, '6100').id, active: 1, created_at: nowIso(),
  }));
  const good = f.tx(() => assets.createAsset(f.repo, {
    name: 'Good press', class_id: goodClass, subsidiary_id: f.subsidiaryId,
    acquisition_date: '2026-01-01', in_service_date: '2026-01-01', cost: 60000,
  }));
  const bad = f.tx(() => assets.createAsset(f.repo, {
    name: 'Bad press', class_id: badClass, subsidiary_id: f.subsidiaryId,
    acquisition_date: '2026-01-01', in_service_date: '2026-01-01', cost: 60000,
  }));
  f.tx(() => assets.placeInService(f.repo, good.id, { in_service_date: '2026-01-01' }));
  f.tx(() => assets.placeInService(f.repo, bad.id, { in_service_date: '2026-01-01' }));
  f.tx(() => assets.runDepreciation(f.repo, { through: '2026-01-31' }));

  f.tx(() => books.setAssetRule(f.repo, { book_id: b.id, asset_id: good.id, life_months: 120 }));
  f.tx(() => books.setAssetRule(f.repo, { book_id: b.id, asset_id: bad.id, life_months: 120 }));

  // The bad asset's expense account goes inactive after both rules exist.
  f.tx(() => f.repo.update('account', acct(f, '6100').id, { active: 0 }));

  // Not wrapped in f.tx(): matches the fixed route, and is the point of the
  // test -- wrapping it would turn the isolation back into savepoints that
  // roll back together.
  assert.throws(() => books.runBookDepreciation(f.repo, { book_id: b.id, through: '2026-01-31' }), /inactive/);

  const goodPosted = f.repo.scalar(
    "SELECT COUNT(*) c FROM book_adjustment WHERE tenant_id = :t AND book_id = ? AND source_id = ?", [b.id, good.id], 0);
  assert.equal(goodPosted, 1, 'the good asset must still have its adjustment posted');
  const badPosted = f.repo.scalar(
    "SELECT COUNT(*) c FROM book_adjustment WHERE tenant_id = :t AND book_id = ? AND source_id = ?", [b.id, bad.id], 0);
  assert.equal(badPosted, 0, 'the failing asset must not have posted');
});
