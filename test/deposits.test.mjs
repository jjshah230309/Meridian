// Money that moved before there was a document to put it against. The whole
// point is that it stays out of receivables, payables, revenue and cost until
// somebody says what it was for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant } from './helpers.mjs';
import * as deposits from '../src/modules/deposits.mjs';
import * as entities from '../src/modules/entities.mjs';
import * as T from '../src/modules/txn.mjs';
import * as gl from '../src/modules/gl.mjs';
import { Money } from '../src/core/util.mjs';

const acct = (f, n) => f.repo.queryOne('SELECT * FROM account WHERE tenant_id = :t AND number = ?', [n]);
const thrown = (fn) => { try { fn(); } catch (e) { return e; } return null; };
const balance = (f, n) => f.repo.scalar(
  `SELECT COALESCE(SUM(jl.base_debit - jl.base_credit), 0) v FROM journal_line jl
   JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
   JOIN account a ON a.tenant_id = jl.tenant_id AND a.id = jl.account_id
   WHERE jl.tenant_id = :t AND je.status = 'posted' AND a.number = ?`, [n], 0);

function customerWithDeposit(f, amount = 5000) {
  const customer = f.tx(() => entities.createCustomer(f.repo, { name: 'Prepaying Ltd', subsidiary_id: f.subsidiaryId }));
  const deposit = f.tx(() => deposits.createDeposit(f.repo, 'CUSTOMER_DEPOSIT', {
    entity_id: customer.id, subsidiary_id: f.subsidiaryId, txn_date: '2026-03-01',
    amount, account_id: acct(f, '1010').id, memo: 'Deposit on order',
  }));
  return { customer, deposit };
}

const invoiceFor = (f, customer, amount, date = '2026-03-20') => f.tx(() => T.createTxn(f.repo, 'INVOICE', {
  entity_id: customer.id, subsidiary_id: f.subsidiaryId, txn_date: date,
  lines: [{ account_id: acct(f, '4020').id, quantity: 1, unit_price: amount }],
}));

test('a deposit is cash and a liability, not revenue and not a receivable', () => {
  const f = freshTenant();
  const { deposit } = customerWithDeposit(f, 5000);
  assert.equal(balance(f, '1010'), Money.parse(5000), 'the money is in the bank');
  assert.equal(balance(f, '2350'), -Money.parse(5000), 'and owed back until the goods go out');
  assert.equal(balance(f, '1100'), 0, 'nobody owes us anything');
  assert.equal(balance(f, '4020'), 0, 'and nothing has been earned');
  assert.equal(deposit.amount_remaining, Money.parse(5000));
  assert.equal(gl.integrityCheck(f.repo).ok, true);
});

test('a deposit does not sweep itself onto whatever invoice happens to be open', () => {
  const f = freshTenant();
  const customer = f.tx(() => entities.createCustomer(f.repo, { name: 'Prepaying Ltd', subsidiary_id: f.subsidiaryId }));
  invoiceFor(f, customer, 900, '2026-01-10');
  const deposit = f.tx(() => deposits.createDeposit(f.repo, 'CUSTOMER_DEPOSIT', {
    entity_id: customer.id, subsidiary_id: f.subsidiaryId, txn_date: '2026-03-01',
    amount: 5000, account_id: acct(f, '1010').id,
  }));
  assert.equal(deposit.amount_remaining, Money.parse(5000), 'a deposit is for a thing nobody has invoiced yet');
  assert.equal(balance(f, '1100'), Money.parse(900), 'the old invoice is untouched');
});

test('applying a deposit releases the liability and settles the invoice', () => {
  const f = freshTenant();
  const { customer, deposit } = customerWithDeposit(f, 5000);
  const invoice = invoiceFor(f, customer, 8000);
  assert.equal(balance(f, '1100'), Money.parse(8000));

  const res = f.tx(() => deposits.applyDeposit(f.repo, deposit.id, {
    txn_date: '2026-03-20', applications: [{ txn_id: invoice.id, amount: 5000 }],
  }));

  assert.equal(res.applied, Money.parse(5000));
  assert.equal(balance(f, '2350'), 0, 'nothing is held any more');
  assert.equal(balance(f, '1100'), Money.parse(3000), 'and the customer owes the rest');
  assert.equal(balance(f, '1010'), Money.parse(5000), 'no cash moved — it arrived with the deposit');
  assert.equal(f.repo.get('txn', invoice.id).status, 'partially_paid');
  assert.equal(res.deposit.amount_remaining, 0);
  assert.equal(res.deposit.status, 'closed');
  assert.equal(gl.integrityCheck(f.repo).ok, true);
  assert.equal(gl.tieOuts(f.repo).find((t) => t.name === 'Receivables').difference, 0);
});

test('a deposit can be applied across several invoices, and part-applied', () => {
  const f = freshTenant();
  const { customer, deposit } = customerWithDeposit(f, 5000);
  const a = invoiceFor(f, customer, 1200);
  const b = invoiceFor(f, customer, 800);

  const res = f.tx(() => deposits.applyDeposit(f.repo, deposit.id, {
    txn_date: '2026-03-20',
    applications: [{ txn_id: a.id, amount: 1200 }, { txn_id: b.id, amount: 800 }],
  }));
  assert.equal(res.applied, Money.parse(2000));
  assert.equal(res.deposit.amount_remaining, Money.parse(3000));
  assert.equal(res.deposit.status, 'partially_applied');
  assert.equal(f.repo.get('txn', a.id).status, 'paid');
  assert.equal(f.repo.get('txn', b.id).status, 'paid');
  assert.equal(balance(f, '2350'), -Money.parse(3000), 'what is left is still held');
});

test('a deposit cannot be applied to more than it is worth, or to somebody else', () => {
  const f = freshTenant();
  const { customer, deposit } = customerWithDeposit(f, 1000);
  const invoice = invoiceFor(f, customer, 8000);
  assert.match(thrown(() => f.tx(() => deposits.applyDeposit(f.repo, deposit.id, {
    applications: [{ txn_id: invoice.id, amount: 4000 }], txn_date: '2026-03-20',
  }))).fields.applications, /only \$1,000\.00 left/);

  const other = f.tx(() => entities.createCustomer(f.repo, { name: 'Someone Else', subsidiary_id: f.subsidiaryId }));
  const theirs = invoiceFor(f, other, 500);
  assert.match(thrown(() => f.tx(() => deposits.applyDeposit(f.repo, deposit.id, {
    applications: [{ txn_id: theirs.id, amount: 500 }], txn_date: '2026-03-20',
  }))).fields['applications.0.txn_id'], /belongs to somebody else/);
});

test('applying more than an invoice owes is refused', () => {
  const f = freshTenant();
  const { customer, deposit } = customerWithDeposit(f, 5000);
  const invoice = invoiceFor(f, customer, 900);
  assert.match(thrown(() => f.tx(() => deposits.applyDeposit(f.repo, deposit.id, {
    applications: [{ txn_id: invoice.id, amount: 1500 }], txn_date: '2026-03-20',
  }))).fields['applications.0.amount'], /only \$900\.00 outstanding/);
});

test('a refunded deposit goes back out the way it came in', () => {
  const f = freshTenant();
  const { deposit } = customerWithDeposit(f, 5000);
  const res = f.tx(() => deposits.refundDeposit(f.repo, deposit.id, { amount: 2000, txn_date: '2026-03-15' }));
  assert.equal(res.refunded, Money.parse(2000));
  assert.equal(balance(f, '1010'), Money.parse(3000), 'the cash left again');
  assert.equal(balance(f, '2350'), -Money.parse(3000), 'and we hold less');
  assert.equal(balance(f, '4020'), 0, 'a refund is not negative revenue');
  assert.equal(res.deposit.amount_remaining, Money.parse(3000));
});

test('a supplier prepayment is an asset until the goods arrive', () => {
  const f = freshTenant();
  const vendor = f.tx(() => entities.createVendor(f.repo, { name: 'Slow Supplies', subsidiary_id: f.subsidiaryId }));
  const prepayment = f.tx(() => deposits.createDeposit(f.repo, 'VENDOR_PREPAYMENT', {
    entity_id: vendor.id, subsidiary_id: f.subsidiaryId, txn_date: '2026-03-01',
    amount: 3000, account_id: acct(f, '1010').id,
  }));
  assert.equal(balance(f, '1260'), Money.parse(3000), 'we are owed goods');
  assert.equal(balance(f, '1010'), -Money.parse(3000));
  assert.equal(balance(f, '2010'), 0, 'and we owe the supplier nothing');

  const bill = f.tx(() => T.createTxn(f.repo, 'VENDOR_BILL', {
    entity_id: vendor.id, subsidiary_id: f.subsidiaryId, txn_date: '2026-03-20',
    lines: [{ account_id: acct(f, '6400').id, quantity: 1, unit_price: 4000 }],
  }));
  f.tx(() => deposits.applyDeposit(f.repo, prepayment.id, {
    txn_date: '2026-03-20', applications: [{ txn_id: bill.id, amount: 3000 }],
  }));
  assert.equal(balance(f, '1260'), 0, 'the goods arrived, so the asset is gone');
  assert.equal(balance(f, '2010'), -Money.parse(1000), 'and only the balance is still owed');
  assert.equal(gl.tieOuts(f.repo).find((t) => t.name === 'Payables').difference, 0);
});

test('a prepayment cannot be applied to an invoice, nor a deposit to a bill', () => {
  const f = freshTenant();
  const { customer, deposit } = customerWithDeposit(f, 1000);
  const vendor = f.tx(() => entities.createVendor(f.repo, { name: 'Anyone', subsidiary_id: f.subsidiaryId }));
  const bill = f.tx(() => T.createTxn(f.repo, 'VENDOR_BILL', {
    entity_id: vendor.id, subsidiary_id: f.subsidiaryId, txn_date: '2026-03-20',
    lines: [{ account_id: acct(f, '6400').id, quantity: 1, unit_price: 500 }],
  }));
  const err = thrown(() => f.tx(() => deposits.applyDeposit(f.repo, deposit.id, {
    applications: [{ txn_id: bill.id, amount: 500 }], txn_date: '2026-03-20',
  })));
  assert.ok(err.fields['applications.0.txn_id']);
  void customer;
});

test('what is held agrees with what the account carries', () => {
  const f = freshTenant();
  const { customer, deposit } = customerWithDeposit(f, 5000);
  const second = f.tx(() => entities.createCustomer(f.repo, { name: 'Another Ltd', subsidiary_id: f.subsidiaryId }));
  f.tx(() => deposits.createDeposit(f.repo, 'CUSTOMER_DEPOSIT', {
    entity_id: second.id, subsidiary_id: f.subsidiaryId, txn_date: '2026-03-02',
    amount: 1500, account_id: acct(f, '1010').id,
  }));

  const summary = deposits.heldSummary(f.repo, { type: 'CUSTOMER_DEPOSIT' });
  assert.equal(summary.held, Money.parse(6500));
  assert.equal(summary.control, Money.parse(6500));
  assert.equal(summary.difference, 0, 'the subledger and the account agree');
  assert.equal(summary.rows.length, 2);
  assert.equal(summary.rows[0].name, 'Prepaying Ltd', 'biggest first');

  const invoice = invoiceFor(f, customer, 5000);
  f.tx(() => deposits.applyDeposit(f.repo, deposit.id, {
    txn_date: '2026-03-20', applications: [{ txn_id: invoice.id, amount: 5000 }],
  }));
  const after = deposits.heldSummary(f.repo, { type: 'CUSTOMER_DEPOSIT' });
  assert.equal(after.held, Money.parse(1500));
  assert.equal(after.difference, 0);
});
