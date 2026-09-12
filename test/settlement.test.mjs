// Money that has been handed over but has nothing to settle against. An
// overpayment, or a receipt someone unapplied, still credits the receivables
// control account in full -- so the subledger has to know about it too, and
// two lines against one invoice have to be read as one application of their
// sum, or the same balance gets spent twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant, DATE } from './helpers.mjs';
import * as entities from '../src/modules/entities.mjs';
import * as inventory from '../src/modules/inventory.mjs';
import * as txnMod from '../src/modules/txn.mjs';
import * as gl from '../src/modules/gl.mjs';
import { Money } from '../src/core/util.mjs';

function invoiced(f, amount = 100) {
  const customer = f.tx(() => entities.createCustomer(f.repo, { name: 'Acme', subsidiary_id: f.subsidiaryId }));
  const item = f.tx(() => inventory.createItem(f.repo, { sku: 'S1', name: 'Consulting', type: 'service', base_price: amount }));
  const invoice = f.tx(() => txnMod.createTxn(f.repo, 'INVOICE', {
    entity_id: customer.id, subsidiary_id: f.subsidiaryId, txn_date: DATE,
    lines: [{ item_id: item.id, quantity: 1, unit_price: amount }],
  }));
  return { customer, item, invoice };
}

const receivables = (f) => gl.tieOuts(f.repo).find((t) => t.name === 'Receivables');

test('two applications against one invoice are read as one', () => {
  const f = freshTenant();
  const { customer, invoice } = invoiced(f);
  assert.throws(() => f.tx(() => txnMod.createPayment(f.repo, 'CUSTOMER_PAYMENT', {
    entity_id: customer.id, txn_date: DATE, amount: 120,
    applications: [{ txn_id: invoice.id, amount: 60 }, { txn_id: invoice.id, amount: 60 }],
  })), /only \$100\.00 outstanding/);
  assert.equal(txnMod.getTxn(f.repo, invoice.id).amount_remaining, Money.parse(100));
  assert.equal(receivables(f).difference, 0);
});

test('an overpayment leaves a credit on account that still ties out', () => {
  const f = freshTenant();
  const { customer, invoice } = invoiced(f);
  const payment = f.tx(() => txnMod.createPayment(f.repo, 'CUSTOMER_PAYMENT', {
    entity_id: customer.id, txn_date: DATE, amount: 120,
  }));
  assert.equal(payment.amount_applied, Money.parse(100));
  assert.equal(payment.amount_remaining, Money.parse(20));
  assert.equal(txnMod.getTxn(f.repo, invoice.id).status, 'paid');
  assert.equal(receivables(f).difference, 0);
  assert.equal(gl.integrityCheck(f.repo).ok, true);
});

test('unapplying a receipt puts the invoice back and the cash on account', () => {
  const f = freshTenant();
  const { customer, invoice } = invoiced(f);
  const payment = f.tx(() => txnMod.createPayment(f.repo, 'CUSTOMER_PAYMENT', { entity_id: customer.id, txn_date: DATE, amount: 100 }));
  f.tx(() => txnMod.unapplyPayment(f.repo, payment.id, invoice.id));
  assert.equal(txnMod.getTxn(f.repo, invoice.id).amount_remaining, Money.parse(100));
  assert.equal(txnMod.getTxn(f.repo, payment.id).amount_remaining, Money.parse(100));
  assert.equal(receivables(f).difference, 0);
  assert.equal(gl.integrityCheck(f.repo).ok, true);
});

test('a payment on account and the bill it later settles both tie out', () => {
  const f = freshTenant();
  const vendor = f.tx(() => entities.createVendor(f.repo, { name: 'Supplier', subsidiary_id: f.subsidiaryId }));
  const item = f.tx(() => inventory.createItem(f.repo, { sku: 'SVC', name: 'Cleaning', type: 'service', purchase_price: 300 }));
  const bill = f.tx(() => txnMod.createTxn(f.repo, 'VENDOR_BILL', {
    entity_id: vendor.id, subsidiary_id: f.subsidiaryId, txn_date: DATE,
    lines: [{ item_id: item.id, quantity: 1, unit_price: 300 }],
  }));
  const payment = f.tx(() => txnMod.createPayment(f.repo, 'VENDOR_PAYMENT', { entity_id: vendor.id, txn_date: DATE, amount: 500 }));
  assert.equal(payment.amount_remaining, Money.parse(200));
  assert.equal(txnMod.getTxn(f.repo, bill.id).status, 'paid');
  assert.equal(gl.tieOuts(f.repo).find((t) => t.name === 'Payables').difference, 0);
  assert.equal(gl.integrityCheck(f.repo).ok, true);
});
