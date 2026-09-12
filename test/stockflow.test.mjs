// Where stock leaves and enters the business outside the sales cycle. Each of
// these paths moved the stock ledger, or the general ledger, but not both --
// which is exactly the failure that leaves an inventory account describing
// goods that are not there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant, DATE } from './helpers.mjs';
import * as entities from '../src/modules/entities.mjs';
import * as inventory from '../src/modules/inventory.mjs';
import * as service from '../src/modules/service.mjs';
import * as txnMod from '../src/modules/txn.mjs';
import * as gl from '../src/modules/gl.mjs';
import { Money, Qty } from '../src/core/util.mjs';

function stocked(f, { quantity = 10, unit_price = 200 } = {}) {
  const vendor = f.tx(() => entities.createVendor(f.repo, { name: 'Supplier', subsidiary_id: f.subsidiaryId }));
  const item = f.tx(() => inventory.createItem(f.repo, {
    sku: 'PART-1', name: 'Compressor', type: 'inventory', sales_price: 500, purchase_price: unit_price,
  }));
  const bill = f.tx(() => txnMod.createTxn(f.repo, 'VENDOR_BILL', {
    entity_id: vendor.id, subsidiary_id: f.subsidiaryId, txn_date: DATE,
    location_id: f.location.id, lines: [{ item_id: item.id, quantity, unit_price }],
  }));
  return { vendor, item, bill };
}

const tieOut = (f, name) => gl.tieOuts(f.repo).find((t) => t.name === name);

test('a vendor bill with no receipt behind it takes the stock in', () => {
  const f = freshTenant();
  const { item } = stocked(f);
  const pos = inventory.position(f.repo, item.id, f.location.id);
  assert.equal(pos.qty_on_hand, Qty.parse(10));
  assert.equal(pos.total_value, Money.parse(2000));
  assert.equal(tieOut(f, 'Inventory').difference, 0);
});

test('a bill that only clears an accrued receipt does not receive twice', () => {
  const f = freshTenant();
  const { vendor, item } = stocked(f, { quantity: 4 });
  const po = f.tx(() => txnMod.createTxn(f.repo, 'PURCHASE_ORDER', {
    entity_id: vendor.id, subsidiary_id: f.subsidiaryId, txn_date: DATE,
    location_id: f.location.id, lines: [{ item_id: item.id, quantity: 6, unit_price: 200 }],
  }));
  const receipt = f.tx(() => txnMod.transform(f.repo, po.id, 'ITEM_RECEIPT', { txn_date: DATE }));
  f.tx(() => txnMod.transform(f.repo, receipt.id, 'VENDOR_BILL', { txn_date: DATE }));
  // 4 from the standalone bill plus 6 received against the order -- not 16.
  assert.equal(inventory.position(f.repo, item.id, f.location.id).qty_on_hand, Qty.parse(10));
  assert.equal(tieOut(f, 'Inventory').difference, 0);
  assert.equal(gl.integrityCheck(f.repo).ok, true);
});

test('a discounted bill line values the stock net, with the penny to variance', () => {
  const f = freshTenant();
  const vendor = f.tx(() => entities.createVendor(f.repo, { name: 'Supplier', subsidiary_id: f.subsidiaryId }));
  const item = f.tx(() => inventory.createItem(f.repo, { sku: 'BOLT', name: 'Bolt', type: 'inventory', purchase_price: 10 }));
  const bill = f.tx(() => txnMod.createTxn(f.repo, 'VENDOR_BILL', {
    entity_id: vendor.id, subsidiary_id: f.subsidiaryId, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: item.id, quantity: 3, unit_price: 10, discount_pct: 10 }],
  }));
  assert.equal(inventory.position(f.repo, item.id, f.location.id).total_value, Money.parse(27));
  assert.equal(bill.total, Money.parse(27));
  assert.equal(tieOut(f, 'Inventory').difference, 0);
  assert.equal(gl.integrityCheck(f.repo).ok, true);
});

test('a part fitted on a service call relieves stock and charges cost of sales', () => {
  const f = freshTenant();
  const { item } = stocked(f);
  const customer = f.tx(() => entities.createCustomer(f.repo, { name: 'Harbour Foods', subsidiary_id: f.subsidiaryId }));
  const order = f.tx(() => service.createOrder(f.repo, {
    customer_id: customer.id, subsidiary_id: f.subsidiaryId, location_id: f.location.id, order_type: 'repair',
  }));
  f.tx(() => service.addLines(f.repo, order.id, [
    { line_type: 'part', item_id: item.id, quantity: 2, unit_price: 500 },
  ]));

  assert.equal(inventory.position(f.repo, item.id, f.location.id).qty_on_hand, Qty.parse(8));
  const cogs = f.repo.scalar(
    `SELECT COALESCE(SUM(jl.base_debit - jl.base_credit), 0) v FROM journal_line jl
     JOIN journal_entry je ON je.id = jl.entry_id
     WHERE jl.tenant_id = :t AND je.status = 'posted' AND jl.account_id = ?`, [f.posting.cogs], 0);
  assert.equal(cogs, Money.parse(400));
  assert.equal(tieOut(f, 'Inventory').difference, 0);
  assert.equal(gl.integrityCheck(f.repo).ok, true);
});

test('a job with nowhere to draw parts from says so rather than billing thin air', () => {
  const f = freshTenant();
  const { item } = stocked(f);
  f.tx(() => f.repo.exec('UPDATE location SET active = 0 WHERE tenant_id = :t'));
  const customer = f.tx(() => entities.createCustomer(f.repo, { name: 'Harbour Foods', subsidiary_id: f.subsidiaryId }));
  const order = f.tx(() => service.createOrder(f.repo, {
    customer_id: customer.id, subsidiary_id: f.subsidiaryId, order_type: 'repair',
  }));
  assert.throws(() => f.tx(() => service.addLines(f.repo, order.id, [
    { line_type: 'part', item_id: item.id, quantity: 1, unit_price: 500 },
  ])), /cannot be issued/);
});
