// Bin-level picking. bin_quantity is keyed by (bin_id, item_id, lot_number,
// serial_no) -- a pick task drawn from a bin has to carry all three, or
// confirming the pick looks the stock up under the wrong key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant, DATE } from './helpers.mjs';
import * as wh from '../src/modules/warehouse.mjs';
import * as inv from '../src/modules/inventory.mjs';
import * as entities from '../src/modules/entities.mjs';
import * as T from '../src/modules/txn.mjs';
import { Qty } from '../src/core/util.mjs';

test('confirming a pick against a serial-tracked bin does not crash, and clears that serial\'s allocation', () => {
  const f = freshTenant();
  const customer = f.tx(() => entities.createCustomer(f.repo, { name: 'Acme Corp' }));
  const item = f.tx(() => inv.createItem(f.repo, { sku: 'SN-1', name: 'Serial Widget', type: 'inventory', base_price: 250 }));
  const bin = f.tx(() => wh.createBin(f.repo, { location_id: f.location.id, code: 'PICK-01', bin_type: 'picking' }));
  // Two units of the same item in the same bin, distinguished only by serial.
  f.tx(() => wh.moveBin(f.repo, { item_id: item.id, to_bin_id: bin.id, quantity: 1, serial_no: 'SN001' }));
  f.tx(() => wh.moveBin(f.repo, { item_id: item.id, to_bin_id: bin.id, quantity: 1, serial_no: 'SN002' }));

  const so = f.tx(() => T.createTxn(f.repo, 'SALES_ORDER', {
    entity_id: customer.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: item.id, quantity: 1 }],
  }));

  const wave = f.tx(() => wh.createWave(f.repo, { location_id: f.location.id, txn_ids: [so.id] }));
  const task = wave.tasks[0];
  assert.equal(task.bin_id, bin.id);
  assert.ok(['SN001', 'SN002'].includes(task.serial_no), 'the task must remember which serial it was allocated');

  // Before the fix this threw "That bin holds none of this item", because
  // confirmPick never carried the task's serial_no through to moveBin or to
  // its own bin_quantity deallocation.
  const confirmed = f.tx(() => wh.confirmPick(f.repo, task.id, {}));
  assert.equal(confirmed.status, 'picked');

  const remaining = f.repo.queryOne(
    'SELECT * FROM bin_quantity WHERE tenant_id = :t AND bin_id = ? AND item_id = ? AND serial_no = ?',
    [bin.id, item.id, task.serial_no]);
  assert.equal(remaining.allocated, 0, 'the allocation for the picked serial must clear');
  assert.equal(remaining.quantity, 0, 'the picked serial must have left the bin');

  const other = f.repo.queryOne(
    'SELECT * FROM bin_quantity WHERE tenant_id = :t AND bin_id = ? AND item_id = ? AND serial_no != ?',
    [bin.id, item.id, task.serial_no]);
  assert.equal(other.quantity, Qty.parse(1), 'the other serial in the same bin must be untouched');
});

test('shipping a wave ships every good order even when a different one fails', () => {
  // shipWave used to fulfil every order in the wave inside one transaction,
  // so a race between picking and shipping that leaves one order's line
  // unable to fulfil its full picked quantity rolled back the fulfilments
  // already completed for every other, unrelated order in the same wave.
  const f = freshTenant();
  const customer = f.tx(() => entities.createCustomer(f.repo, { name: 'Acme Corp' }));
  const item = f.tx(() => inv.createItem(f.repo, { sku: 'WID-1', name: 'Widget', type: 'inventory', base_price: 50 }));

  const good = f.tx(() => T.createTxn(f.repo, 'SALES_ORDER', {
    entity_id: customer.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: item.id, quantity: 5 }],
  }));
  const bad = f.tx(() => T.createTxn(f.repo, 'SALES_ORDER', {
    entity_id: customer.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: item.id, quantity: 5 }],
  }));

  const wave = f.tx(() => wh.createWave(f.repo, { location_id: f.location.id, txn_ids: [good.id, bad.id] }));
  for (const task of wave.tasks) f.tx(() => wh.confirmPick(f.repo, task.id, {}));

  // Simulate a race: something else fulfilled part of "bad" between picking
  // and shipping, so less than the picked quantity remains to fulfil.
  const badLine = f.repo.queryOne('SELECT * FROM txn_line WHERE tenant_id = :t AND txn_id = ?', [bad.id]);
  f.tx(() => f.repo.update('txn_line', badLine.id, { qty_fulfilled: Qty.parse(4) }));

  // Not wrapped in f.tx(): shipWave commits each order's fulfilment in its
  // own transaction on purpose, and wrapping the call in an outer one here
  // would turn those back into savepoints and undo the very isolation this
  // test is checking for.
  assert.throws(() => wh.shipWave(f.repo, wave.id), /remains on/);

  const goodFulfilment = f.repo.queryOne(
    "SELECT * FROM txn WHERE tenant_id = :t AND type = 'FULFILLMENT' AND source_txn_id = ?", [good.id]);
  assert.ok(goodFulfilment, 'the good order must still have shipped');
  const badFulfilment = f.repo.queryOne(
    "SELECT * FROM txn WHERE tenant_id = :t AND type = 'FULFILLMENT' AND source_txn_id = ?", [bad.id]);
  assert.equal(badFulfilment, null, 'the failing order must not have shipped');
});
