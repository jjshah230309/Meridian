// Order-to-cash and procure-to-pay: the document lifecycle, its stock
// movements, and the journal each step writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant, DATE } from './helpers.mjs';
import * as gl from '../src/modules/gl.mjs';
import * as inv from '../src/modules/inventory.mjs';
import * as entities from '../src/modules/entities.mjs';
import * as T from '../src/modules/txn.mjs';
import { Money, Qty } from '../src/core/util.mjs';

function tradingCo(opts = {}) {
  const f = freshTenant();
  Object.assign(f, f.tx(() => ({
    customer: entities.createCustomer(f.repo, { name: 'Acme Corp', terms: 'NET30', credit_limit: opts.creditLimit ?? 0 }),
    vendor: entities.createVendor(f.repo, { name: 'Globex Supply', terms: 'NET30' }),
    widget: inv.createItem(f.repo, { sku: 'WID-1', name: 'Widget', type: 'inventory', base_price: 250, purchase_price: 100 }),
    service: inv.createItem(f.repo, { sku: 'SVC-1', name: 'Install', type: 'service', base_price: 500 }),
  })));
  return f;
}

/** Receive stock so the company has something to sell. */
function stockUp(f, qty = 100) {
  const po = f.tx(() => T.createTxn(f.repo, 'PURCHASE_ORDER', {
    entity_id: f.vendor.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.widget.id, quantity: qty, unit_price: 100 }],
  }));
  const receipt = f.tx(() => T.transform(f.repo, po.id, 'ITEM_RECEIPT', { txn_date: DATE }));
  return { po, receipt };
}

test('purchase order commits nothing but records on-order quantity', () => {
  const f = tradingCo();
  const po = f.tx(() => T.createTxn(f.repo, 'PURCHASE_ORDER', {
    entity_id: f.vendor.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.widget.id, quantity: 50, unit_price: 100 }],
  }));
  assert.equal(po.status, 'open');
  assert.equal(po.posted, 0, 'a purchase order does not hit the ledger');
  const avail = inv.availability(f.repo, f.widget.id);
  assert.equal(avail.total_on_order, Qty.parse(50));
  assert.equal(avail.total_on_hand, 0);
});

test('item receipt increases stock at cost and accrues the payable', () => {
  const f = tradingCo();
  const { receipt } = stockUp(f, 100);
  const avail = inv.availability(f.repo, f.widget.id);
  assert.equal(avail.total_on_hand, Qty.parse(100));
  assert.equal(avail.total_value, Money.parse(10000));
  assert.equal(avail.locations[0].avg_cost, Money.parse(100));
  assert.equal(avail.total_on_order, 0, 'on-order is relieved by the receipt');

  const balances = gl.balanceMap(f.repo);
  assert.equal(balances[f.posting.inventory], Money.parse(10000), 'Dr Inventory');
  assert.equal(balances[f.posting.accrued_receipts], -Money.parse(10000), 'Cr Accrued receipts');
  assert.equal(receipt.status, 'closed');
});

test('vendor bill clears the accrual rather than double-counting inventory', () => {
  const f = tradingCo();
  const { receipt } = stockUp(f, 100);
  f.tx(() => T.transform(f.repo, receipt.id, 'VENDOR_BILL', { txn_date: DATE }));
  const balances = gl.balanceMap(f.repo);
  assert.equal(balances[f.posting.inventory], Money.parse(10000), 'inventory is unchanged by billing');
  assert.equal(balances[f.posting.accrued_receipts], 0, 'accrual cleared');
  assert.equal(balances[f.posting.ap], -Money.parse(10000), 'Cr Accounts payable');
});

test('sales order commits stock without touching the ledger', () => {
  const f = tradingCo();
  stockUp(f, 100);
  const so = f.tx(() => T.createTxn(f.repo, 'SALES_ORDER', {
    entity_id: f.customer.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.widget.id, quantity: 10 }],
  }));
  assert.equal(so.total, Money.parse(2500), 'priced from the item list price');
  assert.equal(so.posted, 0);
  const avail = inv.availability(f.repo, f.widget.id);
  assert.equal(avail.total_committed, Qty.parse(10));
  assert.equal(avail.total_available, Qty.parse(90));
  assert.equal(avail.total_on_hand, Qty.parse(100), 'committing does not move stock');
});

test('fulfilment relieves inventory at average cost and posts COGS', () => {
  const f = tradingCo();
  stockUp(f, 100);
  const so = f.tx(() => T.createTxn(f.repo, 'SALES_ORDER', {
    entity_id: f.customer.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.widget.id, quantity: 10 }],
  }));
  f.tx(() => T.transform(f.repo, so.id, 'FULFILLMENT', { txn_date: DATE }));

  const avail = inv.availability(f.repo, f.widget.id);
  assert.equal(avail.total_on_hand, Qty.parse(90));
  assert.equal(avail.total_committed, 0, 'the reservation is released on shipment');
  assert.equal(avail.total_value, Money.parse(9000));

  const balances = gl.balanceMap(f.repo);
  assert.equal(balances[f.posting.cogs], Money.parse(1000), '10 units at $100 average cost');
  assert.equal(balances[f.posting.inventory], Money.parse(9000));
  assert.equal(f.repo.get('txn', so.id).status, 'fulfilled');
});

test('invoice posts receivable and revenue, and closes the order', () => {
  const f = tradingCo();
  stockUp(f, 100);
  const so = f.tx(() => T.createTxn(f.repo, 'SALES_ORDER', {
    entity_id: f.customer.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.widget.id, quantity: 10 }],
  }));
  f.tx(() => T.transform(f.repo, so.id, 'FULFILLMENT', { txn_date: DATE }));
  const invoice = f.tx(() => T.transform(f.repo, so.id, 'INVOICE', { txn_date: DATE }));

  assert.equal(invoice.total, Money.parse(2500));
  assert.equal(invoice.amount_remaining, Money.parse(2500));
  assert.equal(invoice.due_date, '2026-07-15', 'NET30 from the invoice date');
  const balances = gl.balanceMap(f.repo);
  assert.equal(balances[f.posting.ar], Money.parse(2500));
  assert.equal(balances[f.posting.product_revenue], -Money.parse(2500));
  assert.equal(f.repo.get('txn', so.id).status, 'closed');
  assert.ok(gl.integrityCheck(f.repo).ok);
});

test('payment clears the receivable and marks the invoice paid', () => {
  const f = tradingCo();
  stockUp(f, 100);
  const so = f.tx(() => T.createTxn(f.repo, 'SALES_ORDER', {
    entity_id: f.customer.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.widget.id, quantity: 10 }],
  }));
  f.tx(() => T.transform(f.repo, so.id, 'FULFILLMENT', { txn_date: DATE }));
  const invoice = f.tx(() => T.transform(f.repo, so.id, 'INVOICE', { txn_date: DATE }));

  const payment = f.tx(() => T.createPayment(f.repo, 'CUSTOMER_PAYMENT', {
    entity_id: f.customer.id, txn_date: DATE, amount: 2500,
    applications: [{ txn_id: invoice.id, amount: 2500 }],
  }));

  assert.equal(payment.amount_applied, Money.parse(2500));
  const after = f.repo.get('txn', invoice.id);
  assert.equal(after.status, 'paid');
  assert.equal(after.amount_remaining, 0);
  assert.equal(gl.balanceMap(f.repo)[f.posting.ar], 0);
});

test('partial payment leaves a balance and the invoice partially paid', () => {
  const f = tradingCo();
  stockUp(f, 100);
  const invoice = f.tx(() => T.createTxn(f.repo, 'INVOICE', {
    entity_id: f.customer.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.widget.id, quantity: 4, unit_price: 250 }],
  }));
  f.tx(() => T.createPayment(f.repo, 'CUSTOMER_PAYMENT', {
    entity_id: f.customer.id, txn_date: DATE, amount: 400,
    applications: [{ txn_id: invoice.id, amount: 400 }],
  }));
  const after = f.repo.get('txn', invoice.id);
  assert.equal(after.status, 'partially_paid');
  assert.equal(after.amount_remaining, Money.parse(600));
});

test('a payment cannot be over-applied to a document', () => {
  const f = tradingCo();
  const invoice = f.tx(() => T.createTxn(f.repo, 'INVOICE', {
    entity_id: f.customer.id, txn_date: DATE,
    lines: [{ item_id: f.service.id, quantity: 1, unit_price: 500 }],
  }));
  assert.throws(() => f.tx(() => T.createPayment(f.repo, 'CUSTOMER_PAYMENT', {
    entity_id: f.customer.id, txn_date: DATE, amount: 900,
    applications: [{ txn_id: invoice.id, amount: 900 }],
  })), /only \$500\.00 outstanding/);
});

test('over-shipping a sales order is refused', () => {
  const f = tradingCo();
  stockUp(f, 100);
  const so = f.tx(() => T.createTxn(f.repo, 'SALES_ORDER', {
    entity_id: f.customer.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.widget.id, quantity: 10 }],
  }));
  assert.throws(() => f.tx(() => T.transform(f.repo, so.id, 'FULFILLMENT', {
    txn_date: DATE, lines: [{ source_line_id: so.lines[0].id, quantity: 25 }],
  })), /only 10 remains/);
});

test('partial fulfilment leaves the order partially fulfilled', () => {
  const f = tradingCo();
  stockUp(f, 100);
  const so = f.tx(() => T.createTxn(f.repo, 'SALES_ORDER', {
    entity_id: f.customer.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.widget.id, quantity: 10 }],
  }));
  f.tx(() => T.transform(f.repo, so.id, 'FULFILLMENT', {
    txn_date: DATE, lines: [{ source_line_id: so.lines[0].id, quantity: 4 }],
  }));
  assert.equal(f.repo.get('txn', so.id).status, 'partially_fulfilled');
  const avail = inv.availability(f.repo, f.widget.id);
  assert.equal(avail.total_on_hand, Qty.parse(96));
  assert.equal(avail.total_committed, Qty.parse(6), 'the unshipped remainder stays reserved');
});

test('credit limit blocks an order that would breach it, unless overridden', () => {
  const f = tradingCo({ creditLimit: 1000 });
  stockUp(f, 100);
  assert.throws(() => f.tx(() => T.createTxn(f.repo, 'SALES_ORDER', {
    entity_id: f.customer.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.widget.id, quantity: 10 }],
  })), /credit limit/);

  const forced = f.tx(() => T.createTxn(f.repo, 'SALES_ORDER', {
    entity_id: f.customer.id, txn_date: DATE, location_id: f.location.id,
    override_credit: true, lines: [{ item_id: f.widget.id, quantity: 10 }],
  }));
  assert.ok(forced.warnings?.[0]?.includes('credit limit'));
});

test('credit hold stops an order outright', () => {
  const f = tradingCo();
  f.tx(() => entities.updateCustomer(f.repo, f.customer.id, { credit_hold: 1 }));
  assert.throws(() => f.tx(() => T.createTxn(f.repo, 'SALES_ORDER', {
    entity_id: f.customer.id, txn_date: DATE, lines: [{ item_id: f.service.id, quantity: 1 }],
  })), /credit hold/);
});

test('voiding a posted invoice reverses its journal', () => {
  const f = tradingCo();
  const invoice = f.tx(() => T.createTxn(f.repo, 'INVOICE', {
    entity_id: f.customer.id, txn_date: DATE,
    lines: [{ item_id: f.service.id, quantity: 2, unit_price: 500 }],
  }));
  assert.equal(gl.balanceMap(f.repo)[f.posting.ar], Money.parse(1000));

  f.tx(() => T.voidTxn(f.repo, invoice.id, { reason: 'Duplicate' }));
  assert.equal(f.repo.get('txn', invoice.id).status, 'voided');
  assert.equal(gl.balanceMap(f.repo)[f.posting.ar], 0);
  assert.ok(gl.integrityCheck(f.repo).ok);
});

test('a document with payments applied cannot be voided', () => {
  const f = tradingCo();
  const invoice = f.tx(() => T.createTxn(f.repo, 'INVOICE', {
    entity_id: f.customer.id, txn_date: DATE,
    lines: [{ item_id: f.service.id, quantity: 1, unit_price: 500 }],
  }));
  f.tx(() => T.createPayment(f.repo, 'CUSTOMER_PAYMENT', {
    entity_id: f.customer.id, txn_date: DATE, amount: 500,
    applications: [{ txn_id: invoice.id, amount: 500 }],
  }));
  assert.throws(() => f.tx(() => T.voidTxn(f.repo, invoice.id)), /applied against it/);
});

test('quote converts to an order and closes itself', () => {
  const f = tradingCo();
  const quote = f.tx(() => T.createTxn(f.repo, 'QUOTE', {
    entity_id: f.customer.id, txn_date: DATE,
    lines: [{ item_id: f.service.id, quantity: 3, unit_price: 500 }],
  }));
  const so = f.tx(() => T.transform(f.repo, quote.id, 'SALES_ORDER', { txn_date: DATE }));
  assert.equal(so.total, Money.parse(1500));
  assert.equal(f.repo.get('txn', quote.id).status, 'closed');
  assert.equal(so.source_txn_id, quote.id);
});

test('a service line is invoiced without any stock movement', () => {
  const f = tradingCo();
  const so = f.tx(() => T.createTxn(f.repo, 'SALES_ORDER', {
    entity_id: f.customer.id, txn_date: DATE,
    lines: [{ item_id: f.service.id, quantity: 2 }],
  }));
  const invoice = f.tx(() => T.transform(f.repo, so.id, 'INVOICE', { txn_date: DATE }));
  assert.equal(invoice.total, Money.parse(1000));
  assert.equal(gl.balanceMap(f.repo)[f.posting.service_revenue], -Money.parse(1000));
  assert.equal(f.repo.count('inventory_txn'), 0);
});

// --- Regressions: places where a document used to leave the books wrong.

test('billing a purchase order directly clears the accrual, it does not re-debit stock', () => {
  const f = tradingCo();
  const { po } = stockUp(f, 40);           // receipt: Dr inventory 4,000 / Cr accrued 4,000
  f.tx(() => T.transform(f.repo, po.id, 'VENDOR_BILL', { txn_date: DATE }));

  const balances = gl.balanceMap(f.repo);
  assert.equal(balances[f.posting.inventory], Money.parse(4000), 'stock is only capitalised once');
  assert.equal(balances[f.posting.accrued_receipts] || 0, 0, 'the accrual is cleared by the bill');
  assert.equal(balances[f.posting.ap], -Money.parse(4000), 'the vendor is owed');
  assert.ok(gl.integrityCheck(f.repo).ok);
});

test('an invoice cannot be credited twice for the same goods', () => {
  const f = tradingCo();
  stockUp(f, 20);
  const invoice = f.tx(() => T.createTxn(f.repo, 'INVOICE', {
    entity_id: f.customer.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.widget.id, quantity: 5, unit_price: 250 }],
  }));
  f.tx(() => T.transform(f.repo, invoice.id, 'CREDIT_MEMO', { txn_date: DATE }));
  assert.throws(
    () => f.tx(() => T.transform(f.repo, invoice.id, 'CREDIT_MEMO', { txn_date: DATE })),
    /Nothing remains/);
});

test('an unapplied credit memo is visible in the receivables subledger', () => {
  const f = tradingCo();
  stockUp(f, 20);
  const invoice = f.tx(() => T.createTxn(f.repo, 'INVOICE', {
    entity_id: f.customer.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.widget.id, quantity: 4, unit_price: 250 }],
  }));
  const memo = f.tx(() => T.createTxn(f.repo, 'CREDIT_MEMO', {
    entity_id: f.customer.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.widget.id, quantity: 1, unit_price: 250 }],
  }));
  assert.equal(memo.amount_remaining, Money.parse(250), 'a credit memo is an open receivable item');

  const check = gl.integrityCheck(f.repo);
  const ar = check.subledgers.find((s) => s.name === 'Receivables');
  assert.equal(ar.subledger, Money.parse(1000 - 250), 'the credit reduces what the customer owes');
  assert.equal(ar.difference, 0);
  assert.ok(check.ok);
});

test('a vendor return takes stock off the shelf and off the payable', () => {
  const f = tradingCo();
  const { po } = stockUp(f, 30);
  const bill = f.tx(() => T.transform(f.repo, po.id, 'VENDOR_BILL', { txn_date: DATE }));
  const ret = f.tx(() => T.transform(f.repo, bill.id, 'VENDOR_RETURN', { txn_date: DATE }));

  assert.equal(ret.posted, 1, 'a vendor return posts');
  assert.equal(inv.availability(f.repo, f.widget.id).total_on_hand, 0, 'the goods have gone back');
  const balances = gl.balanceMap(f.repo);
  assert.equal(balances[f.posting.inventory] || 0, 0, 'inventory is relieved');
  assert.equal(balances[f.posting.ap] || 0, 0, 'the payable is cleared');
  assert.ok(gl.integrityCheck(f.repo).ok);

  assert.throws(() => f.tx(() => T.transform(f.repo, bill.id, 'VENDOR_RETURN', { txn_date: DATE })),
    /Nothing remains/, 'the same bill cannot be returned twice');
});
