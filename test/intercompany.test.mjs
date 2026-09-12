// Trading between companies you own.
//
// The arithmetic is trivial; what these tests are about is that both halves
// always exist, that they agree, that neither company's own books carry the
// group's consolidation adjustments, and that a period cannot be eliminated
// twice over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant } from './helpers.mjs';
import * as ic from '../src/modules/intercompany.mjs';
import * as gl from '../src/modules/gl.mjs';
import * as inv from '../src/modules/inventory.mjs';
import * as consolidation from '../src/modules/consolidation.mjs';
import { ulid, nowIso, Money } from '../src/core/util.mjs';

const DATE = '2026-06-15';
const acct = (f, n) => f.repo.queryOne('SELECT * FROM account WHERE tenant_id = :t AND number = ?', [n]);
const thrown = (fn) => { try { fn(); } catch (e) { return e; } return null; };

/** A second trading subsidiary, plus the elimination one. */
function group(f, { currency = 'USD' } = {}) {
  const uk = f.tx(() => f.repo.insert('subsidiary', {
    id: ulid(), name: 'Test Co UK', legal_name: 'Test Co UK Ltd',
    parent_id: f.subsidiaryId, currency, country: 'GB', tax_number: '',
    address: {}, is_elimination: 0, active: 1, created_at: nowIso(),
  }));
  const elim = f.tx(() => ic.eliminationSubsidiary(f.repo, { create: true }));
  return { us: f.subsidiaryId, uk, elim };
}

/** What an account stands at, in one subsidiary's own books. */
const balance = (f, subsidiaryId, number) => f.repo.scalar(
  `SELECT COALESCE(SUM(jl.base_debit - jl.base_credit), 0) v FROM journal_line jl
   JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
   JOIN account a ON a.tenant_id = jl.tenant_id AND a.id = jl.account_id
   WHERE jl.tenant_id = :t AND je.status = 'posted'
     AND je.subsidiary_id = ? AND a.number = ?`, [subsidiaryId, number], 0);

function recharge(f, g, { amount = 500000, date = DATE } = {}) {
  return f.tx(() => ic.intercompanyJournal(f.repo, {
    from_subsidiary_id: g.us, to_subsidiary_id: g.uk, txn_date: date,
    memo: 'Head office recharge',
    lines: [
      { subsidiary_id: g.uk, account_id: acct(f, '6500').id, debit: amount },
      { subsidiary_id: g.us, account_id: acct(f, '4020').id, credit: amount },
    ],
  }));
}

// ------------------------------------------------------------ the pairing
test('a recharge posts in both companies, and derives both control accounts', () => {
  const f = freshTenant();
  const g = group(f);
  const t = recharge(f, g);

  assert.equal(t.kind, 'journal');
  assert.ok(t.from_entry_id && t.to_entry_id, 'both halves exist');
  assert.notEqual(t.from_entry_id, t.to_entry_id, 'and they are different entries');

  // The UK bears the cost and owes for it.
  assert.equal(balance(f, g.uk, '6500'), Money.parse(5000), 'UK carries the expense');
  assert.equal(balance(f, g.uk, '2190'), -Money.parse(5000), 'and owes the affiliate');
  // The US recovered it and is owed.
  assert.equal(balance(f, g.us, '4020'), -Money.parse(5000), 'US recovers the cost');
  assert.equal(balance(f, g.us, '1190'), Money.parse(5000), 'and is owed for it');
});

test('each half is a balanced entry in its own company', () => {
  const f = freshTenant();
  const g = group(f);
  const t = recharge(f, g);
  for (const id of [t.from_entry_id, t.to_entry_id]) {
    const e = gl.getJournalEntry(f.repo, id);
    assert.equal(e.total_debit, e.total_credit, `${e.entry_no} balances`);
    assert.equal(e.lines.length, 2, 'the line asked for, plus the derived control side');
  }
});

test('the two control accounts are not something you can post by hand', () => {
  const f = freshTenant();
  const g = group(f);
  const e = thrown(() => f.tx(() => ic.intercompanyJournal(f.repo, {
    from_subsidiary_id: g.us, to_subsidiary_id: g.uk, txn_date: DATE,
    lines: [
      { subsidiary_id: g.uk, account_id: acct(f, '2190').id, credit: 100000 },
      { subsidiary_id: g.us, account_id: acct(f, '1190').id, debit: 100000 },
    ],
  })));
  assert.match(JSON.stringify(e.details), /affiliate control account/);
});

test('a transaction that touches only one company is refused', () => {
  const f = freshTenant();
  const g = group(f);
  const e = thrown(() => f.tx(() => ic.intercompanyJournal(f.repo, {
    from_subsidiary_id: g.us, to_subsidiary_id: g.uk, txn_date: DATE,
    lines: [
      { subsidiary_id: g.us, account_id: acct(f, '6500').id, debit: 100000 },
      { subsidiary_id: g.us, account_id: acct(f, '4020').id, credit: 100000 },
    ],
  })));
  assert.match(e.message, /Nothing was posted to/);
});

test('the two sides have to face each other', () => {
  const f = freshTenant();
  const g = group(f);
  const e = thrown(() => f.tx(() => ic.intercompanyJournal(f.repo, {
    from_subsidiary_id: g.us, to_subsidiary_id: g.uk, txn_date: DATE,
    lines: [
      { subsidiary_id: g.uk, account_id: acct(f, '6500').id, debit: 100000 },
      { subsidiary_id: g.us, account_id: acct(f, '4020').id, credit: 90000 },
    ],
  })));
  assert.match(e.message, /do not balance against each other/);
});

test('a company cannot trade with itself', () => {
  const f = freshTenant();
  const g = group(f);
  const e = thrown(() => f.tx(() => ic.intercompanyJournal(f.repo, {
    from_subsidiary_id: g.us, to_subsidiary_id: g.us, txn_date: DATE,
    lines: [{ subsidiary_id: g.us, account_id: acct(f, '6500').id, debit: 1 }],
  })));
  assert.equal(e.status, 422);
  assert.match(JSON.stringify(e.details), /cannot trade with itself/);
});

// ------------------------------------------------------------- the sale
test('an intercompany sale raises an invoice in one company and a bill in the other', () => {
  const f = freshTenant();
  const g = group(f);
  const item = f.tx(() => inv.createItem(f.repo, {
    sku: 'IC-SUPPORT', name: 'Group support', type: 'service', base_price: 2000,
    income_account_id: acct(f, '4020').id, expense_account_id: acct(f, '6500').id,
  }));

  const t = f.tx(() => ic.intercompanySale(f.repo, {
    from_subsidiary_id: g.us, to_subsidiary_id: g.uk, txn_date: DATE,
    lines: [{ item_id: item.id, quantity: 3, unit_price: 2000 }],
  }));

  assert.equal(t.kind, 'sale');
  assert.equal(t.from_txn.type, 'INVOICE');
  assert.equal(t.to_txn.type, 'VENDOR_BILL');
  assert.equal(t.from_txn.total, t.to_txn.total, 'both sides are for the same money');
  assert.equal(t.amount, Money.parse(6000));

  // The customer and vendor stand for the other company, so ageing and
  // statements have something real to point at.
  const customer = f.repo.get('customer', t.from_txn.entity_id);
  assert.equal(customer.represents_subsidiary_id, g.uk);
  const vendor = f.repo.get('vendor', t.to_txn.entity_id);
  assert.equal(vendor.represents_subsidiary_id, g.us);
});

test('selling to the same company twice reuses the affiliate records', () => {
  const f = freshTenant();
  const g = group(f);
  const item = f.tx(() => inv.createItem(f.repo, {
    sku: 'IC-2', name: 'Group support', type: 'service', base_price: 100,
    income_account_id: acct(f, '4020').id, expense_account_id: acct(f, '6500').id,
  }));
  const line = [{ item_id: item.id, quantity: 1, unit_price: 100 }];
  const a = f.tx(() => ic.intercompanySale(f.repo, { from_subsidiary_id: g.us, to_subsidiary_id: g.uk, txn_date: DATE, lines: line }));
  const b = f.tx(() => ic.intercompanySale(f.repo, { from_subsidiary_id: g.us, to_subsidiary_id: g.uk, txn_date: DATE, lines: line }));
  assert.equal(a.from_txn.entity_id, b.from_txn.entity_id);
  assert.equal(
    f.repo.scalar('SELECT COUNT(*) c FROM customer WHERE tenant_id = :t AND represents_subsidiary_id IS NOT NULL', [], 0),
    1, 'one affiliate customer, not one per sale');
});

// --------------------------------------------------------- reconciliation
test('what one company is owed, the other owes', () => {
  const f = freshTenant();
  const g = group(f);
  recharge(f, g, { amount: 500000 });
  recharge(f, g, { amount: 125000 });

  const r = ic.reconciliation(f.repo, { as_of: '2026-12-31' });
  assert.equal(r.total_due_from, Money.parse(6250));
  assert.equal(r.total_due_to, Money.parse(6250));
  assert.deepEqual(r.unmatched, [], 'every pair agrees');
  assert.deepEqual(r.drifting, [], 'and every ledger matches its register');
  assert.ok(r.clean);
  assert.equal(r.transactions, 2);
  assert.equal(r.pairs.length, 1, 'two companies, one pair');
  assert.equal(r.pairs[0].count, 2);
});

test('a control account posted to by hand shows up as drift', () => {
  const f = freshTenant();
  const g = group(f);
  recharge(f, g);

  // Somebody journals straight at the control account, which is exactly the
  // thing the reconciliation exists to catch.
  f.tx(() => gl.postJournal(f.repo, {
    subsidiary_id: g.us, txn_date: DATE, memo: 'Manual',
    lines: [
      { account_id: acct(f, '1190').id, debit: 30000 },
      { account_id: acct(f, '4020').id, credit: 30000 },
    ],
  }));

  const r = ic.reconciliation(f.repo, { as_of: '2026-12-31' });
  assert.equal(r.clean, false);
  assert.equal(r.drifting.length, 1);
  assert.equal(r.drifting[0].subsidiary_id, g.us);
  assert.equal(r.drifting[0].drift, Money.parse(300));
  assert.deepEqual(r.unmatched, [], 'the paired transactions themselves are still fine');
});

// A sterling company holding a dollar balance is a translation difference,
// not somebody's mistake. A report that called it an error would cry wolf on
// every multi-currency group there is.
test('translation across currencies is reported as translation, not as an error', () => {
  const f = freshTenant();
  const g = group(f, { currency: 'GBP' });
  f.tx(() => f.repo.exec(
    `INSERT INTO exchange_rate (tenant_id, from_currency, to_currency, rate_date, rate, source)
     VALUES (:t,?,?,?,?,'test')`, ['USD', 'GBP', '2026-01-01', 0.8]));
  f.tx(() => f.repo.exec(
    `INSERT INTO exchange_rate (tenant_id, from_currency, to_currency, rate_date, rate, source)
     VALUES (:t,?,?,?,?,'test')`, ['GBP', 'USD', '2026-12-01', 1.4]));

  recharge(f, g, { amount: 1000000 });

  const r = ic.reconciliation(f.repo, { as_of: '2026-12-31' });
  assert.ok(r.clean, 'nothing is wrong');
  assert.deepEqual(r.unmatched, []);
  assert.deepEqual(r.drifting, []);
  // The US is owed $10,000; the UK owes £8,000, which at 1.4 is $11,200.
  assert.notEqual(r.translation_difference, 0, 'but the translated halves differ');
  assert.equal(r.total_due_from, Money.parse(10000));
  assert.equal(r.total_due_to, Money.parse(11200));
});

test('a sale between companies counts towards what they owe each other', () => {
  const f = freshTenant();
  const g = group(f);
  const item = f.tx(() => inv.createItem(f.repo, {
    sku: 'IC-AR', name: 'Group support', type: 'service', base_price: 400,
    income_account_id: acct(f, '4020').id, expense_account_id: acct(f, '6500').id,
  }));
  f.tx(() => ic.intercompanySale(f.repo, {
    from_subsidiary_id: g.us, to_subsidiary_id: g.uk, txn_date: DATE,
    lines: [{ item_id: item.id, quantity: 2, unit_price: 400 }],
  }));

  const r = ic.reconciliation(f.repo, { as_of: '2026-12-31' });
  const us = r.by_subsidiary.find((b) => b.subsidiary_id === g.us);
  const uk = r.by_subsidiary.find((b) => b.subsidiary_id === g.uk);
  // The money sits in ordinary receivables and payables against the records
  // that stand for the other company, not in the control accounts.
  assert.equal(us.receivable, Money.parse(800));
  assert.equal(uk.payable, Money.parse(800));
  assert.equal(us.due_from, 0);
  assert.ok(r.clean);
});

// ------------------------------------------------------------ elimination
test('elimination reverses the intercompany balances into their own subsidiary', () => {
  const f = freshTenant();
  const g = group(f);
  recharge(f, g);
  const period = gl.periodForDate(f.repo, DATE);

  const plan = ic.previewElimination(f.repo, { period_id: period.id });
  assert.equal(plan.lines.length, 2, 'one per control account per company');
  assert.equal(plan.totals.translation, 0, 'a single-currency group has nothing to translate');

  const run = f.tx(() => ic.runElimination(f.repo, { period_id: period.id }));
  assert.equal(run.status, 'posted');
  assert.equal(run.lines.length, 2);

  // The cancelling entry lands in the elimination subsidiary and nowhere else.
  assert.equal(balance(f, g.elim.id, '1190'), -Money.parse(5000));
  assert.equal(balance(f, g.elim.id, '2190'), Money.parse(5000));
  // Each real company's own books are untouched: it files those.
  assert.equal(balance(f, g.us, '1190'), Money.parse(5000));
  assert.equal(balance(f, g.uk, '2190'), -Money.parse(5000));
});

// Two companies on different currencies cancel exactly in the currencies they
// are held in, and not at all once both are stated in the parent's. What is
// left is translation, and it belongs in equity — not in a warning telling
// somebody to go and find a reconciling item that does not exist.
test('a cross-currency elimination puts the translation difference in equity', () => {
  const f = freshTenant();
  const g = group(f, { currency: 'GBP' });
  f.tx(() => f.repo.exec(
    `INSERT INTO exchange_rate (tenant_id, from_currency, to_currency, rate_date, rate, source)
     VALUES (:t,?,?,?,?,'test')`, ['USD', 'GBP', '2026-01-01', 0.8]));
  f.tx(() => f.repo.exec(
    `INSERT INTO exchange_rate (tenant_id, from_currency, to_currency, rate_date, rate, source)
     VALUES (:t,?,?,?,?,'test')`, ['GBP', 'USD', '2026-06-01', 1.4]));

  recharge(f, g, { amount: 1000000 });
  const period = gl.periodForDate(f.repo, DATE);

  const plan = ic.previewElimination(f.repo, { period_id: period.id });
  assert.equal(plan.currency, 'USD', 'stated in the currency the entry is posted in');
  assert.equal(plan.totals.single_currency, false);
  assert.notEqual(plan.totals.translation, 0);
  // The UK's £8,000 due-to, translated back at 1.4, is $11,200 against the
  // US's $10,000 due-from.
  assert.equal(plan.totals.debit, Money.parse(11200));
  assert.equal(plan.totals.credit, Money.parse(10000));

  const run = f.tx(() => ic.runElimination(f.repo, { period_id: period.id }));
  const entry = gl.getJournalEntry(f.repo, run.entries[0].id);
  assert.equal(entry.total_debit, entry.total_credit, 'the entry still balances');
  const cta = entry.lines.find((l) => l.account_number === '3800');
  assert.ok(cta, 'and the difference is in the translation adjustment');
  assert.equal(cta.credit, Money.parse(1200));
});

test('the entry it posts balances', () => {
  const f = freshTenant();
  const g = group(f);
  recharge(f, g);
  const period = gl.periodForDate(f.repo, DATE);
  const run = f.tx(() => ic.runElimination(f.repo, { period_id: period.id }));
  const entry = gl.getJournalEntry(f.repo, run.entries[0].id);
  assert.equal(entry.total_debit, entry.total_credit);
  assert.equal(entry.subsidiary_id, g.elim.id);
});

test('re-running a period supersedes the last run rather than eliminating twice', () => {
  const f = freshTenant();
  const g = group(f);
  recharge(f, g);
  const period = gl.periodForDate(f.repo, DATE);

  const first = f.tx(() => ic.runElimination(f.repo, { period_id: period.id }));
  const second = f.tx(() => ic.runElimination(f.repo, { period_id: period.id }));
  assert.notEqual(first.id, second.id);
  assert.equal(f.repo.get('elimination_run', first.id).status, 'reversed');

  // Two runs and one reversal leave the elimination subsidiary holding one
  // elimination, not two.
  assert.equal(balance(f, g.elim.id, '1190'), -Money.parse(5000));
});

test('a dry run writes nothing', () => {
  const f = freshTenant();
  const g = group(f);
  recharge(f, g);
  const period = gl.periodForDate(f.repo, DATE);
  const plan = ic.runElimination(f.repo, { period_id: period.id, dry_run: true });
  assert.equal(plan.posted, false);
  assert.equal(f.repo.scalar('SELECT COUNT(*) c FROM elimination_run WHERE tenant_id = :t', [], 0), 0);
  assert.equal(balance(f, g.elim.id, '1190'), 0);
});

test('reversing a run puts the transactions back', () => {
  const f = freshTenant();
  const g = group(f);
  const t = recharge(f, g);
  const period = gl.periodForDate(f.repo, DATE);
  const run = f.tx(() => ic.runElimination(f.repo, { period_id: period.id }));
  assert.equal(f.repo.get('intercompany_txn', t.id).status, 'eliminated');

  f.tx(() => ic.reverseElimination(f.repo, run.id, { reason: 'Wrong period' }));
  assert.equal(f.repo.get('elimination_run', run.id).status, 'reversed');
  assert.equal(f.repo.get('intercompany_txn', t.id).status, 'posted');
  assert.equal(balance(f, g.elim.id, '1190'), 0, 'the cancelling entry is cancelled');
});

test('eliminating a period with nothing in it says so rather than posting an empty entry', () => {
  const f = freshTenant();
  group(f);
  const period = gl.periodForDate(f.repo, DATE);
  const e = thrown(() => f.tx(() => ic.runElimination(f.repo, { period_id: period.id })));
  assert.match(e.message, /Nothing to eliminate/);
});

test('without an elimination subsidiary it says how to make one', () => {
  const f = freshTenant();
  f.tx(() => f.repo.insert('subsidiary', {
    id: ulid(), name: 'Test Co UK', legal_name: '', parent_id: f.subsidiaryId,
    currency: 'USD', country: 'GB', tax_number: '', address: {},
    is_elimination: 0, active: 1, created_at: nowIso(),
  }));
  const e = thrown(() => ic.eliminationSubsidiary(f.repo));
  assert.match(e.message, /no elimination subsidiary/);
});

// ----------------------------------------------------------- consolidated
test('the group consolidates to nothing on what it sold itself', () => {
  const f = freshTenant();
  const g = group(f);
  recharge(f, g);
  const period = gl.periodForDate(f.repo, DATE);
  f.tx(() => ic.runElimination(f.repo, { period_id: period.id }));

  // With the elimination entry posted, the intercompany accounts net to zero
  // across the group without the report having to hide anything.
  const tb = consolidation.consolidatedTrialBalance(f.repo, {
    periodIds: [period.id], eliminate: false,
  });
  const due = tb.lines.filter((l) => ['1190', '2190'].includes(l.number));
  for (const l of due) {
    assert.equal(l.balance, 0, `${l.number} nets to nothing across the group`);
  }
  assert.ok(tb.totals.balanced);
});
