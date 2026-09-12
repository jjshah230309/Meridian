// Period-end revaluation of open foreign-currency balances. What the ledger
// carries and what the balance is worth part company the moment a rate moves;
// this is the entry that closes the gap, and the reversal that stops it being
// counted twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant } from './helpers.mjs';
import * as revaluation from '../src/modules/revaluation.mjs';
import * as entities from '../src/modules/entities.mjs';
import * as txnMod from '../src/modules/txn.mjs';
import * as gl from '../src/modules/gl.mjs';
import { Money } from '../src/core/util.mjs';

const acct = (f, n) => f.repo.queryOne('SELECT * FROM account WHERE tenant_id = :t AND number = ?', [n]);
const thrown = (fn) => { try { fn(); } catch (e) { return e; } return null; };

/** Balance of an account in base currency, as at a date. */
const balance = (f, number, asOf = '2999-12-31') => f.repo.scalar(
  `SELECT COALESCE(SUM(jl.base_debit - jl.base_credit), 0) v FROM journal_line jl
   JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
   JOIN account a ON a.tenant_id = jl.tenant_id AND a.id = jl.account_id
   WHERE jl.tenant_id = :t AND je.status = 'posted' AND a.number = ? AND je.txn_date <= ?`,
  [number, asOf], 0);

function rate(f, from, to, date, r) {
  f.tx(() => f.repo.exec(
    `INSERT INTO exchange_rate (tenant_id, from_currency, to_currency, rate_date, rate) VALUES (:t,?,?,?,?)
     ON CONFLICT (tenant_id, from_currency, to_currency, rate_date) DO UPDATE SET rate = excluded.rate`,
    [from, to, date, r]));
}

/** A £2,000 invoice raised at 1.25, with the rate at 1.40 by quarter end. */
function sterlingInvoice(f, { amount = 2000, booked = 1.25, closing = 1.40 } = {}) {
  rate(f, 'GBP', 'USD', '2026-01-01', booked);
  rate(f, 'GBP', 'USD', '2026-03-31', closing);
  const customer = f.tx(() => entities.createCustomer(f.repo, {
    name: 'Brit Ltd', subsidiary_id: f.subsidiaryId, currency: 'GBP',
  }));
  const invoice = f.tx(() => txnMod.createTxn(f.repo, 'INVOICE', {
    entity_id: customer.id, subsidiary_id: f.subsidiaryId, txn_date: '2026-01-01', currency: 'GBP',
    lines: [{ account_id: acct(f, '4020').id, description: 'Consulting', quantity: 1, unit_price: amount }],
  }));
  return { customer, invoice };
}

test('an open foreign invoice shows the gap between booked and current value', () => {
  const f = freshTenant();
  sterlingInvoice(f);
  const view = revaluation.exposures(f.repo, { as_of: '2026-03-31' });
  assert.equal(view.lines.length, 1);
  const l = view.lines[0];
  assert.equal(l.scope, 'receivable');
  assert.equal(l.currency, 'GBP');
  assert.equal(l.foreign_amount, Money.parse(2000));
  assert.equal(l.booked_base, Money.parse(2500), '£2,000 at 1.25');
  assert.equal(l.revalued_base, Money.parse(2800), '£2,000 at 1.40');
  assert.equal(l.adjustment, Money.parse(300));
  assert.equal(view.gain, Money.parse(300));
  assert.equal(view.loss, 0);
});

test('a run restates receivables and books the gain, then unwinds itself', () => {
  const f = freshTenant();
  sterlingInvoice(f);
  const before = balance(f, '1100');
  const res = f.tx(() => revaluation.run(f.repo, { as_of: '2026-03-31' }));

  assert.equal(res.posted, true);
  assert.equal(res.run.net, Money.parse(300));
  assert.equal(balance(f, '1100', '2026-03-31'), before + Money.parse(300), 'receivables are worth more at the close');
  assert.equal(balance(f, '7035', '2026-03-31'), Money.parse(-300), 'and the gain is unrealised');
  assert.equal(res.run.reverse_on, '2026-04-01');
  assert.equal(balance(f, '1100'), before, 'the first of April puts it back');
  assert.equal(balance(f, '7035'), 0);
  assert.equal(gl.integrityCheck(f.repo).ok, true);
});

test('a falling rate is a loss, on the same machinery', () => {
  const f = freshTenant();
  sterlingInvoice(f, { closing: 1.10 });
  const res = f.tx(() => revaluation.run(f.repo, { as_of: '2026-03-31' }));
  assert.equal(res.run.loss, Money.parse(300), '£2,000 at 1.10 is $2,200, not $2,500');
  assert.equal(res.run.net, -Money.parse(300));
  assert.equal(balance(f, '7035', '2026-03-31'), Money.parse(300), 'a debit: an expense');
});

test('the revaluation leaves the document at the rate it was booked at', () => {
  const f = freshTenant();
  const { invoice } = sterlingInvoice(f);
  f.tx(() => revaluation.run(f.repo, { as_of: '2026-03-31' }));
  const after = f.repo.get('txn', invoice.id);
  assert.equal(after.fx_rate, 1.25, 'settlement still needs the original rate');
  assert.equal(after.amount_remaining, Money.parse(2000));
});

test('what the run posts is exactly what the preview showed', () => {
  const f = freshTenant();
  sterlingInvoice(f);
  const preview = revaluation.run(f.repo, { as_of: '2026-03-31', dry_run: true });
  assert.equal(preview.posted, false);
  assert.equal(f.repo.scalar("SELECT COUNT(*) c FROM journal_entry WHERE tenant_id = :t AND source_type = 'revaluation'", [], 0), 0);

  const real = f.tx(() => revaluation.run(f.repo, { as_of: '2026-03-31' }));
  assert.equal(real.net, preview.net);
  assert.deepEqual(real.lines.map((l) => l.adjustment), preview.lines.map((l) => l.adjustment));
});

test('a base-currency balance is left alone', () => {
  const f = freshTenant();
  const customer = f.tx(() => entities.createCustomer(f.repo, { name: 'Domestic Inc', subsidiary_id: f.subsidiaryId }));
  f.tx(() => txnMod.createTxn(f.repo, 'INVOICE', {
    entity_id: customer.id, subsidiary_id: f.subsidiaryId, txn_date: '2026-01-01',
    lines: [{ account_id: acct(f, '4020').id, quantity: 1, unit_price: 5000 }],
  }));
  const view = revaluation.exposures(f.repo, { as_of: '2026-03-31' });
  assert.equal(view.lines.length, 0, 'a dollar is a dollar');
  assert.match(thrown(() => f.tx(() => revaluation.run(f.repo, { as_of: '2026-03-31' }))).message, /Nothing to revalue/);
});

test('a settled document has no exposure left to revalue', () => {
  const f = freshTenant();
  const { customer, invoice } = sterlingInvoice(f);
  rate(f, 'GBP', 'USD', '2026-02-01', 1.30);
  f.tx(() => txnMod.createPayment(f.repo, 'CUSTOMER_PAYMENT', {
    entity_id: customer.id, subsidiary_id: f.subsidiaryId, txn_date: '2026-02-01', currency: 'GBP',
    amount: 2000, account_id: acct(f, '1010').id,
    applications: [{ txn_id: invoice.id, amount: 2000 }],
  }));
  const view = revaluation.exposures(f.repo, { as_of: '2026-03-31' });
  assert.equal(view.lines.filter((l) => l.scope === 'receivable').length, 0);
});

test('a part-paid document is revalued on what is still outstanding', () => {
  const f = freshTenant();
  const { customer, invoice } = sterlingInvoice(f);
  rate(f, 'GBP', 'USD', '2026-02-01', 1.30);
  f.tx(() => txnMod.createPayment(f.repo, 'CUSTOMER_PAYMENT', {
    entity_id: customer.id, subsidiary_id: f.subsidiaryId, txn_date: '2026-02-01', currency: 'GBP',
    amount: 500, account_id: acct(f, '1010').id,
    applications: [{ txn_id: invoice.id, amount: 500 }],
  }));
  const view = revaluation.exposures(f.repo, { as_of: '2026-03-31' });
  const ar = view.lines.filter((l) => l.scope === 'receivable');
  assert.equal(ar.length, 1);
  assert.equal(ar[0].foreign_amount, Money.parse(1500));
  assert.equal(ar[0].adjustment, Money.parse(225), '£1,500 × (1.40 − 1.25)');
});

test('the adjustment ties to the ledger, not to an estimate', () => {
  const f = freshTenant();
  const { customer, invoice } = sterlingInvoice(f, { amount: 3333.33 });
  rate(f, 'GBP', 'USD', '2026-02-01', 1.31);
  f.tx(() => txnMod.createPayment(f.repo, 'CUSTOMER_PAYMENT', {
    entity_id: customer.id, subsidiary_id: f.subsidiaryId, txn_date: '2026-02-01', currency: 'GBP',
    amount: 1000, account_id: acct(f, '1010').id,
    applications: [{ txn_id: invoice.id, amount: 1000 }],
  }));
  const view = revaluation.exposures(f.repo, { as_of: '2026-03-31' });
  const ar = view.lines.find((l) => l.scope === 'receivable');
  // What the ledger carries for sterling receivables, straight from the detail.
  const carried = f.repo.scalar(
    `SELECT COALESCE(SUM(jl.base_debit - jl.base_credit), 0) v FROM journal_line jl
     JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
     JOIN account a ON a.tenant_id = jl.tenant_id AND a.id = jl.account_id
     WHERE jl.tenant_id = :t AND a.number = '1100' AND jl.currency = 'GBP' AND je.status = 'posted'`, [], 0);
  assert.equal(ar.booked_base, carried, 'no drift between the open item and the control account');
});

test('a foreign bank account is revalued off its own ledger balance', () => {
  const f = freshTenant();
  rate(f, 'EUR', 'USD', '2026-01-01', 1.05);
  rate(f, 'EUR', 'USD', '2026-03-31', 1.20);
  const euro = acct(f, '1020');
  f.tx(() => f.repo.insert('bank_account', {
    id: 'BANKEUR', name: 'Euro Account', account_id: euro.id, subsidiary_id: f.subsidiaryId,
    bank_name: 'Continental', number_masked: '••4411', routing_masked: '', currency: 'EUR',
    active: 1, created_at: '2026-01-01T00:00:00.000Z',
  }));
  f.tx(() => gl.postJournal(f.repo, {
    subsidiary_id: f.subsidiaryId, txn_date: '2026-01-01', currency: 'EUR', memo: 'Opening float',
    lines: [
      { account_id: euro.id, debit: Money.parse(10000) },
      { account_id: acct(f, '3010').id, credit: Money.parse(10000) },
    ],
  }));
  const view = revaluation.exposures(f.repo, { as_of: '2026-03-31', scopes: ['bank'] });
  assert.equal(view.lines.length, 1);
  assert.equal(view.lines[0].booked_base, Money.parse(10500), '€10,000 at 1.05');
  assert.equal(view.lines[0].revalued_base, Money.parse(12000), 'and 1.20 at the close');
  assert.equal(view.lines[0].adjustment, Money.parse(1500));
});

test('scopes narrow what is measured', () => {
  const f = freshTenant();
  sterlingInvoice(f);
  assert.equal(revaluation.exposures(f.repo, { as_of: '2026-03-31', scopes: ['payable'] }).lines.length, 0);
  assert.equal(revaluation.exposures(f.repo, { as_of: '2026-03-31', scopes: ['receivable'] }).lines.length, 1);
});

test('the same date cannot be revalued twice', () => {
  const f = freshTenant();
  sterlingInvoice(f);
  f.tx(() => revaluation.run(f.repo, { as_of: '2026-03-31' }));
  const err = thrown(() => f.tx(() => revaluation.run(f.repo, { as_of: '2026-03-31' })));
  assert.match(err.message, /already revalued/);
});

test('a run will not post if it has nowhere to reverse into', () => {
  const f = freshTenant();
  sterlingInvoice(f);
  const apr = f.repo.queryOne("SELECT * FROM accounting_period WHERE tenant_id = :t AND start_date = '2026-04-01'");
  f.tx(() => gl.closePeriod(f.repo, apr.id, { force: true }));
  const err = thrown(() => f.tx(() => revaluation.run(f.repo, { as_of: '2026-03-31' })));
  assert.match(err.message, /reverse on 2026-04-01/);
  assert.equal(f.repo.scalar("SELECT COUNT(*) c FROM journal_entry WHERE tenant_id = :t AND source_type = 'revaluation'", [], 0), 0,
    'and nothing is left half-posted');
});

test('undoing a run cancels both halves and leaves the books where they were', () => {
  const f = freshTenant();
  sterlingInvoice(f);
  const before = balance(f, '1100', '2026-03-31');
  const res = f.tx(() => revaluation.run(f.repo, { as_of: '2026-03-31' }));
  const undone = f.tx(() => revaluation.reverseRun(f.repo, res.run.id, { reason: 'Wrong closing rate' }));

  assert.equal(undone.status, 'reversed');
  assert.equal(balance(f, '1100', '2026-03-31'), before);
  assert.equal(balance(f, '7035'), 0);
  assert.equal(gl.integrityCheck(f.repo).ok, true);
  // And the date is free again.
  const again = f.tx(() => revaluation.run(f.repo, { as_of: '2026-03-31' }));
  assert.equal(again.run.net, Money.parse(300));
});

test('a run cannot be undone once its period is closed', () => {
  const f = freshTenant();
  sterlingInvoice(f);
  const res = f.tx(() => revaluation.run(f.repo, { as_of: '2026-03-31' }));
  const mar = f.repo.queryOne("SELECT * FROM accounting_period WHERE tenant_id = :t AND start_date = '2026-03-01'");
  f.tx(() => gl.closePeriod(f.repo, mar.id, { force: true }));
  const err = thrown(() => f.tx(() => revaluation.reverseRun(f.repo, res.run.id)));
  assert.match(err.message, /closed/);
  assert.equal(f.repo.get('revaluation_run', res.run.id).status, 'posted');
});

test('the run keeps its working, line by line', () => {
  const f = freshTenant();
  sterlingInvoice(f);
  const res = f.tx(() => revaluation.run(f.repo, { as_of: '2026-03-31' }));
  const stored = revaluation.getRun(f.repo, res.run.id);
  assert.equal(stored.lines.length, 1);
  assert.equal(stored.lines[0].rate_booked, 1.25);
  assert.equal(stored.lines[0].rate_used, 1.40);
  assert.equal(stored.lines[0].account_number, '1100');
  assert.equal(stored.entry.source_type, 'revaluation');
  assert.equal(stored.reversal.txn_date, '2026-04-01');
});

test('the exposure view names the run that already covered the date', () => {
  const f = freshTenant();
  sterlingInvoice(f);
  assert.equal(revaluation.exposures(f.repo, { as_of: '2026-03-31' }).already, null);

  const res = f.tx(() => revaluation.run(f.repo, { as_of: '2026-03-31' }));
  const after = revaluation.exposures(f.repo, { as_of: '2026-03-31' });
  assert.equal(after.already?.run_no, res.run.run_no, 'so the screen does not invite a second one');
  assert.equal(after.lines.length, 1, 'the document is untouched, so the gap is still on show');

  f.tx(() => revaluation.reverseRun(f.repo, res.run.id));
  assert.equal(revaluation.exposures(f.repo, { as_of: '2026-03-31' }).already, null, 'and the date is free again');
});

test('a posted run is not deletable — its entries name it as their source', async () => {
  const f = freshTenant();
  sterlingInvoice(f);
  const res = f.tx(() => revaluation.run(f.repo, { as_of: '2026-03-31' }));
  const { blockersFor } = await import('../src/modules/records.mjs');
  assert.match(blockersFor(f.repo, 'revaluation_run', res.run.id) || '', /journal entr/);
});
