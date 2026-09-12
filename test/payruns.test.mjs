// Paying the suppliers in one sitting. The point of a run is that it is a
// proposal first and a set of payments second: everything here is about what
// happens between building the list and pressing the button.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant } from './helpers.mjs';
import * as payruns from '../src/modules/payruns.mjs';
import * as entities from '../src/modules/entities.mjs';
import * as txnMod from '../src/modules/txn.mjs';
import * as gl from '../src/modules/gl.mjs';
import { Money, addDays } from '../src/core/util.mjs';

const NOW = '2026-06-15';
const acct = (f, n) => f.repo.queryOne('SELECT * FROM account WHERE tenant_id = :t AND number = ?', [n]);
const thrown = (fn) => { try { fn(); } catch (e) { return e; } return null; };
const balance = (f, n) => f.repo.scalar(
  `SELECT COALESCE(SUM(jl.base_debit - jl.base_credit), 0) v FROM journal_line jl
   JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
   JOIN account a ON a.tenant_id = jl.tenant_id AND a.id = jl.account_id
   WHERE jl.tenant_id = :t AND je.status = 'posted' AND a.number = ?`, [n], 0);

const bankAccount = (f) => f.repo.queryOne('SELECT * FROM bank_account WHERE tenant_id = :t LIMIT 1');

function bill(f, vendor, { amount, due = addDays(NOW, -5), currency = undefined } = {}) {
  return f.tx(() => txnMod.createTxn(f.repo, 'VENDOR_BILL', {
    entity_id: vendor.id, subsidiary_id: f.subsidiaryId, currency,
    txn_date: addDays(due, -30), due_date: due,
    lines: [{ account_id: acct(f, '6400').id, description: 'Services', quantity: 1, unit_price: amount }],
  }));
}

function supplier(f, name, patch = {}) {
  const v = f.tx(() => entities.createVendor(f.repo, { name, subsidiary_id: f.subsidiaryId, ...patch }));
  return v;
}

function twoSuppliers(f) {
  const acme = supplier(f, 'Acme Supplies', { bank_reference: 'GB29 ACME 0001' });
  const brick = supplier(f, 'Brick & Co');
  const a1 = bill(f, acme, { amount: 1200 });
  const a2 = bill(f, acme, { amount: 800, due: addDays(NOW, -20) });
  const b1 = bill(f, brick, { amount: 3000 });
  return { acme, brick, a1, a2, b1 };
}

test('a run proposes everything due by the cut-off', () => {
  const f = freshTenant();
  const { acme } = twoSuppliers(f);
  bill(f, acme, { amount: 9999, due: addDays(NOW, 60) });     // not due yet

  const run = f.tx(() => payruns.proposeRun(f.repo, {
    bank_account_id: bankAccount(f).id, payment_date: NOW, pay_through: NOW,
  }));
  assert.equal(run.status, 'draft');
  assert.equal(run.bill_count, 3, 'the far-off bill is left out');
  assert.equal(run.vendor_count, 2);
  assert.equal(run.total, Money.parse(5000));
  assert.equal(run.vendors.length, 2);
  assert.equal(run.vendors[0].vendor_name, 'Brick & Co', 'biggest first');
});

test('a supplier on payment hold is listed but not ticked', () => {
  const f = freshTenant();
  const { brick } = twoSuppliers(f);
  f.tx(() => f.repo.update('vendor', brick.id, { payment_hold: 1 }));

  const run = f.tx(() => payruns.proposeRun(f.repo, { bank_account_id: bankAccount(f).id, payment_date: NOW }));
  const held = run.vendors.find((g) => g.vendor_id === brick.id);
  assert.ok(held, 'still on the list, so the hold is visible');
  assert.equal(held.payment_hold, true);
  assert.equal(held.selected_count, 0);
  assert.equal(run.total, Money.parse(2000), 'only Acme is counted');
});

test('one payment per supplier, covering all of their ticked bills', () => {
  const f = freshTenant();
  const { acme, brick } = twoSuppliers(f);
  const run = f.tx(() => payruns.proposeRun(f.repo, { bank_account_id: bankAccount(f).id, payment_date: NOW }));
  const apBefore = balance(f, '2010');

  const res = f.tx(() => payruns.commitRun(f.repo, run.id));
  assert.equal(res.payments.length, 2, 'two suppliers, two payments');
  const toAcme = res.payments.find((p) => p.vendor_id === acme.id);
  assert.equal(toAcme.bills, 2, 'both of theirs on one payment');
  assert.equal(toAcme.amount, Money.parse(2000));
  assert.equal(res.payments.find((p) => p.vendor_id === brick.id).amount, Money.parse(3000));

  assert.equal(balance(f, '2010'), apBefore + Money.parse(5000), 'payables come down');
  assert.equal(balance(f, '1010'), -Money.parse(5000), 'and the bank pays it');
  assert.equal(res.run.status, 'paid');
  assert.equal(gl.integrityCheck(f.repo).ok, true);
  assert.equal(gl.tieOuts(f.repo).find((t) => t.name === 'Payables').difference, 0);
});

test('every bill on the run is settled by the payment that covers it', () => {
  const f = freshTenant();
  const { a1, a2, b1 } = twoSuppliers(f);
  const run = f.tx(() => payruns.proposeRun(f.repo, { bank_account_id: bankAccount(f).id, payment_date: NOW }));
  f.tx(() => payruns.commitRun(f.repo, run.id));
  for (const b of [a1, a2, b1]) {
    const after = f.repo.get('txn', b.id);
    assert.equal(after.amount_remaining, 0, `${after.txn_no} is settled`);
    assert.equal(after.status, 'paid');
  }
});

test('unticking a bill leaves it unpaid', () => {
  const f = freshTenant();
  const { a2 } = twoSuppliers(f);
  const run = f.tx(() => payruns.proposeRun(f.repo, { bank_account_id: bankAccount(f).id, payment_date: NOW }));
  const line = run.vendors.flatMap((g) => g.lines).find((l) => l.txn_id === a2.id);

  const updated = f.tx(() => payruns.updateLines(f.repo, run.id, [{ id: line.id, selected: false }]));
  assert.equal(updated.total, Money.parse(4200), '5,000 less the 800 taken off');
  assert.equal(updated.bill_count, 2);

  f.tx(() => payruns.commitRun(f.repo, run.id));
  assert.equal(f.repo.get('txn', a2.id).amount_remaining, Money.parse(800), 'still owed');
});

test('a bill can be part-paid, and the rest stays outstanding', () => {
  const f = freshTenant();
  const { b1 } = twoSuppliers(f);
  const run = f.tx(() => payruns.proposeRun(f.repo, { bank_account_id: bankAccount(f).id, payment_date: NOW }));
  const line = run.vendors.flatMap((g) => g.lines).find((l) => l.txn_id === b1.id);

  f.tx(() => payruns.updateLines(f.repo, run.id, [{ id: line.id, amount_pay: 1000 }]));
  f.tx(() => payruns.commitRun(f.repo, run.id));
  assert.equal(f.repo.get('txn', b1.id).amount_remaining, Money.parse(2000));
  assert.equal(f.repo.get('txn', b1.id).status, 'partially_paid');
});

test('paying more than a bill is owed is refused', () => {
  const f = freshTenant();
  const { b1 } = twoSuppliers(f);
  const run = f.tx(() => payruns.proposeRun(f.repo, { bank_account_id: bankAccount(f).id, payment_date: NOW }));
  const line = run.vendors.flatMap((g) => g.lines).find((l) => l.txn_id === b1.id);
  const err = thrown(() => f.tx(() => payruns.updateLines(f.repo, run.id, [{ id: line.id, amount_pay: 5000 }])));
  assert.match(err.fields["lines.0.amount_pay"], /Only \$3,000\.00 is outstanding/);
});

test('a bill settled behind the run is dropped from it, and said so', () => {
  const f = freshTenant();
  const { brick, b1 } = twoSuppliers(f);
  const run = f.tx(() => payruns.proposeRun(f.repo, { bank_account_id: bankAccount(f).id, payment_date: NOW }));

  // Somebody pays Brick by hand while the run sits in the drawer.
  f.tx(() => txnMod.createPayment(f.repo, 'VENDOR_PAYMENT', {
    entity_id: brick.id, subsidiary_id: f.subsidiaryId, txn_date: NOW,
    amount: 3000, applications: [{ txn_id: b1.id, amount: 3000 }],
  }));

  const res = f.tx(() => payruns.commitRun(f.repo, run.id));
  assert.equal(res.payments.length, 1, 'only Acme is left to pay');
  assert.equal(res.dropped.length, 1);
  assert.match(res.dropped[0].reason, /settled since the run was built/);
  assert.equal(gl.tieOuts(f.repo).find((t) => t.name === 'Payables').difference, 0);
});

test('a bill part-settled behind the run is paid down to what is left', () => {
  const f = freshTenant();
  const { brick, b1 } = twoSuppliers(f);
  const run = f.tx(() => payruns.proposeRun(f.repo, { bank_account_id: bankAccount(f).id, payment_date: NOW }));
  f.tx(() => txnMod.createPayment(f.repo, 'VENDOR_PAYMENT', {
    entity_id: brick.id, subsidiary_id: f.subsidiaryId, txn_date: NOW,
    amount: 500, applications: [{ txn_id: b1.id, amount: 500 }],
  }));

  const res = f.tx(() => payruns.commitRun(f.repo, run.id));
  assert.match(res.dropped[0].reason, /\$2,500\.00 paid instead of \$3,000\.00/);
  assert.equal(f.repo.get('txn', b1.id).amount_remaining, 0);
  assert.equal(gl.tieOuts(f.repo).find((t) => t.name === 'Payables').difference, 0);
});

test('a run pays from the bank account it names', () => {
  const f = freshTenant();
  twoSuppliers(f);
  const payroll = f.tx(() => f.repo.insert('bank_account', {
    id: 'BANK2', name: 'Second Account', account_id: acct(f, '1020').id, subsidiary_id: f.subsidiaryId,
    bank_name: '', number_masked: '', routing_masked: '', currency: 'USD', active: 1,
    created_at: '2026-01-01T00:00:00.000Z',
  }));
  const run = f.tx(() => payruns.proposeRun(f.repo, { bank_account_id: payroll, payment_date: NOW }));
  f.tx(() => payruns.commitRun(f.repo, run.id));
  assert.equal(balance(f, '1020'), -Money.parse(5000), 'the named account paid');
  assert.equal(balance(f, '1010'), 0, 'and the default one did not');
});

test('a run only picks up bills in its bank account’s currency', () => {
  const f = freshTenant();
  f.tx(() => f.repo.exec(
    `INSERT INTO exchange_rate (tenant_id, from_currency, to_currency, rate_date, rate) VALUES (:t,?,?,?,?)`,
    ['EUR', 'USD', '2026-01-01', 1.1]));
  const euro = supplier(f, 'Continental GmbH', { currency: 'EUR' });
  bill(f, euro, { amount: 900, currency: 'EUR' });
  twoSuppliers(f);

  const run = f.tx(() => payruns.proposeRun(f.repo, { bank_account_id: bankAccount(f).id, payment_date: NOW }));
  assert.equal(run.bill_count, 3, 'the euro bill needs a euro account of its own');
  assert.ok(!run.vendors.some((g) => g.vendor_id === euro.id));
});

test('a run with nothing ticked will not commit', () => {
  const f = freshTenant();
  const run = f.tx(() => { twoSuppliers(f); return payruns.proposeRun(f.repo, { bank_account_id: bankAccount(f).id, payment_date: NOW }); });
  const lines = run.vendors.flatMap((g) => g.lines).map((l) => ({ id: l.id, selected: false }));
  f.tx(() => payruns.updateLines(f.repo, run.id, lines));
  assert.match(thrown(() => f.tx(() => payruns.commitRun(f.repo, run.id))).message, /Nothing is ticked/);
});

test('a committed run cannot be edited or paid twice', () => {
  const f = freshTenant();
  twoSuppliers(f);
  const run = f.tx(() => payruns.proposeRun(f.repo, { bank_account_id: bankAccount(f).id, payment_date: NOW }));
  f.tx(() => payruns.commitRun(f.repo, run.id));
  assert.match(thrown(() => f.tx(() => payruns.commitRun(f.repo, run.id))).message, /already been paid/);
  assert.match(thrown(() => f.tx(() => payruns.updateLines(f.repo, run.id, []))).message, /can no longer be changed/);
  assert.match(thrown(() => f.tx(() => payruns.cancelRun(f.repo, run.id))).message, /Void the individual payments/);
});

test('a draft can be abandoned without touching the ledger', () => {
  const f = freshTenant();
  twoSuppliers(f);
  const run = f.tx(() => payruns.proposeRun(f.repo, { bank_account_id: bankAccount(f).id, payment_date: NOW }));
  const cancelled = f.tx(() => payruns.cancelRun(f.repo, run.id, { reason: 'Wrong week' }));
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(balance(f, '1010'), 0);
});

test('a run into a closed period is refused before anything posts', () => {
  const f = freshTenant();
  twoSuppliers(f);
  const run = f.tx(() => payruns.proposeRun(f.repo, { bank_account_id: bankAccount(f).id, payment_date: NOW }));
  const jun = f.repo.queryOne("SELECT * FROM accounting_period WHERE tenant_id = :t AND start_date = '2026-06-01'");
  f.tx(() => gl.closePeriod(f.repo, jun.id, { force: true }));
  assert.match(thrown(() => f.tx(() => payruns.commitRun(f.repo, run.id))).message, /closed/);
  assert.equal(f.repo.get('payment_run', run.id).status, 'draft', 'and the run is untouched');
});

test('a run with nothing to propose says so rather than making an empty one', () => {
  const f = freshTenant();
  const err = thrown(() => f.tx(() => payruns.proposeRun(f.repo, { bank_account_id: bankAccount(f).id, payment_date: NOW })));
  assert.match(err.message, /Nothing is due for payment/);
  assert.equal(f.repo.scalar('SELECT COUNT(*) c FROM payment_run WHERE tenant_id = :t', [], 0), 0);
});

test('the remittance advice lists what the payment settled', () => {
  const f = freshTenant();
  const { acme } = twoSuppliers(f);
  const run = f.tx(() => payruns.proposeRun(f.repo, { bank_account_id: bankAccount(f).id, payment_date: NOW }));
  f.tx(() => payruns.commitRun(f.repo, run.id));
  const buf = payruns.remittancePdf(f.repo, run.id, acme.id);
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(buf.length > 800);
  assert.match(thrown(() => payruns.remittancePdf(f.repo, run.id, 'nobody')).message, /not on this run/);
});

test('the payment file has a row per supplier, not per bill', () => {
  const f = freshTenant();
  twoSuppliers(f);
  const run = f.tx(() => payruns.proposeRun(f.repo, { bank_account_id: bankAccount(f).id, payment_date: NOW }));
  f.tx(() => payruns.commitRun(f.repo, run.id));
  const file = payruns.paymentFile(f.repo, run.id);
  const lines = file.text.trim().split('\r\n');
  assert.equal(lines.length, 3, 'a header and two suppliers');
  assert.match(lines[0], /^﻿?Payment date,Beneficiary/);
  assert.match(file.text, /Acme Supplies/);
  assert.match(file.text, /GB29 ACME 0001/);
  assert.match(file.text, /2000\.00/);
  assert.match(file.filename, /^pay-\d+-payments\.csv$/);
});

test('a payment knows which run made it, and the run knows its payments', () => {
  const f = freshTenant();
  twoSuppliers(f);
  const run = f.tx(() => payruns.proposeRun(f.repo, { bank_account_id: bankAccount(f).id, payment_date: NOW }));
  const res = f.tx(() => payruns.commitRun(f.repo, run.id));
  for (const p of res.payments) assert.equal(f.repo.get('txn', p.txn_id).payment_run_id, run.id);
  for (const g of payruns.getRun(f.repo, run.id).vendors) assert.ok(g.payment_no, `${g.vendor_name} has a payment number`);
});

test('what is waiting to be paid is summarised without building a run', () => {
  const f = freshTenant();
  twoSuppliers(f);
  const due = payruns.dueSummary(f.repo, { pay_through: NOW });
  assert.equal(due.total_bills, 3);
  assert.equal(due.groups[0].vendors, 2);
  assert.equal(due.groups[0].total, Money.parse(5000));
  assert.equal(due.groups[0].overdue, Money.parse(5000), 'all three are past due');
});
