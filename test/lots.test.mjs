// Lot and serial tracking, layered on the existing moving-average stock
// ledger. These tests exist because inventory_lot used to be a bare CRUD
// record nothing ever wrote to -- receipts, fulfilments, work orders and
// stock counts all had to be wired into it without changing what they cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant, DATE } from './helpers.mjs';
import * as inv from '../src/modules/inventory.mjs';
import * as lotsMod from '../src/modules/lots.mjs';
import * as entities from '../src/modules/entities.mjs';
import * as T from '../src/modules/txn.mjs';
import * as mfg from '../src/modules/manufacturing.mjs';
import * as wh from '../src/modules/warehouse.mjs';
import * as gl from '../src/modules/gl.mjs';
import { Qty, addDays } from '../src/core/util.mjs';

function trading() {
  const f = freshTenant();
  Object.assign(f, f.tx(() => ({
    customer: entities.createCustomer(f.repo, { name: 'Acme Corp' }),
    vendor: entities.createVendor(f.repo, { name: 'Globex Supply' }),
    lotItem: inv.createItem(f.repo, { sku: 'PERISH-1', name: 'Yoghurt', type: 'inventory', track_lots: 1, base_price: 500, purchase_price: 200 }),
    serialItem: inv.createItem(f.repo, { sku: 'SERIAL-1', name: 'Laptop', type: 'inventory', is_serialised: 1, base_price: 100000, purchase_price: 60000 }),
  })));
  return f;
}

const cleanTieOut = (f) => assert.ok(gl.tieOuts(f.repo).every((r) => r.difference === 0), 'inventory must still tie out to the control account');

test('a receipt with no lots named auto-assigns one, and can be issued back out', () => {
  const f = trading();
  const po = f.tx(() => T.createTxn(f.repo, 'PURCHASE_ORDER', {
    entity_id: f.vendor.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.lotItem.id, quantity: 20, unit_price: 200 }],
  }));
  const receipt = f.tx(() => T.transform(f.repo, po.id, 'ITEM_RECEIPT', { txn_date: DATE }));
  assert.equal(receipt.status, 'closed');

  const lots = lotsMod.lotsFor(f.repo, f.lotItem.id, { locationId: f.location.id });
  assert.equal(lots.length, 1);
  assert.equal(lots[0].quantity, Qty.parse(20));
  assert.equal(lots[0].status, 'available');

  const so = f.tx(() => T.createTxn(f.repo, 'SALES_ORDER', {
    entity_id: f.customer.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.lotItem.id, quantity: 8 }],
  }));
  const ful = f.tx(() => T.transform(f.repo, so.id, 'FULFILLMENT', { txn_date: DATE }));
  assert.equal(ful.status, 'closed');

  const after = lotsMod.lotsFor(f.repo, f.lotItem.id, { locationId: f.location.id });
  assert.equal(after[0].quantity, Qty.parse(12), 'the auto lot must be drawn down by the shipment');
  cleanTieOut(f);
});

test('issuing more than one lot covers, draws first-expiry-first-out', () => {
  const f = trading();
  const po = f.tx(() => T.createTxn(f.repo, 'PURCHASE_ORDER', {
    entity_id: f.vendor.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.lotItem.id, quantity: 30, unit_price: 200 }],
  }));
  const receipt = f.tx(() => T.transform(f.repo, po.id, 'ITEM_RECEIPT', {
    txn_date: DATE,
    lines: [{
      source_line_id: po.lines[0].id, quantity: 30,
      custom: { lots: [
        { lot_number: 'LATE', quantity: 10, expiry_date: addDays(DATE, 60) },
        { lot_number: 'SOON', quantity: 20, expiry_date: addDays(DATE, 5) },
      ] },
    }],
  }));
  assert.equal(receipt.status, 'closed');

  const so = f.tx(() => T.createTxn(f.repo, 'SALES_ORDER', {
    entity_id: f.customer.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.lotItem.id, quantity: 25 }],
  }));
  f.tx(() => T.transform(f.repo, so.id, 'FULFILLMENT', { txn_date: DATE }));

  const lots = lotsMod.lotsFor(f.repo, f.lotItem.id, { locationId: f.location.id });
  const soon = lots.find((l) => l.lot_number === 'SOON');
  const late = lots.find((l) => l.lot_number === 'LATE');
  assert.equal(soon.quantity, 0, 'the nearer-expiry lot must be fully drained first');
  assert.equal(soon.status, 'consumed');
  assert.equal(late.quantity, Qty.parse(5), 'only 5 of the later lot should have been drawn, after the nearer lot ran out');
  cleanTieOut(f);
});

test('a receipt naming exact lots refuses a total that does not match the line', () => {
  const f = trading();
  const po = f.tx(() => T.createTxn(f.repo, 'PURCHASE_ORDER', {
    entity_id: f.vendor.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.lotItem.id, quantity: 10, unit_price: 200 }],
  }));
  assert.throws(() => f.tx(() => T.transform(f.repo, po.id, 'ITEM_RECEIPT', {
    txn_date: DATE,
    lines: [{ source_line_id: po.lines[0].id, quantity: 10, custom: { lots: [{ lot_number: 'A', quantity: 4 }] } }],
  })), /Lot quantities total/);
});

test('a serialised item requires a distinct serial per unit, and refuses a re-received duplicate', () => {
  const f = trading();
  const po = f.tx(() => T.createTxn(f.repo, 'PURCHASE_ORDER', {
    entity_id: f.vendor.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.serialItem.id, quantity: 2, unit_price: 60000 }],
  }));
  assert.throws(() => f.tx(() => T.transform(f.repo, po.id, 'ITEM_RECEIPT', { txn_date: DATE })), /Serial numbers are required/);

  const receipt = f.tx(() => T.transform(f.repo, po.id, 'ITEM_RECEIPT', {
    txn_date: DATE,
    lines: [{
      source_line_id: po.lines[0].id, quantity: 2,
      custom: { lots: [{ serial_no: 'SN-100', quantity: 1 }, { serial_no: 'SN-101', quantity: 1 }] },
    }],
  }));
  assert.equal(receipt.status, 'closed');

  const po2 = f.tx(() => T.createTxn(f.repo, 'PURCHASE_ORDER', {
    entity_id: f.vendor.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.serialItem.id, quantity: 1, unit_price: 60000 }],
  }));
  assert.throws(() => f.tx(() => T.transform(f.repo, po2.id, 'ITEM_RECEIPT', {
    txn_date: DATE,
    lines: [{ source_line_id: po2.lines[0].id, quantity: 1, custom: { lots: [{ serial_no: 'SN-100', quantity: 1 }] } }],
  })), /already in stock/);

  // Two of the same serial on one receipt line is refused too.
  const po3 = f.tx(() => T.createTxn(f.repo, 'PURCHASE_ORDER', {
    entity_id: f.vendor.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.serialItem.id, quantity: 2, unit_price: 60000 }],
  }));
  assert.throws(() => f.tx(() => T.transform(f.repo, po3.id, 'ITEM_RECEIPT', {
    txn_date: DATE,
    lines: [{ source_line_id: po3.lines[0].id, quantity: 2, custom: { lots: [{ serial_no: 'SN-200', quantity: 1 }, { serial_no: 'SN-200', quantity: 1 }] } }],
  })), /listed twice/);
});

test('voiding a fulfilment gives the lot its quantity back; voiding a receipt removes what it added', () => {
  const f = trading();
  const po = f.tx(() => T.createTxn(f.repo, 'PURCHASE_ORDER', {
    entity_id: f.vendor.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.lotItem.id, quantity: 15, unit_price: 200 }],
  }));
  const receipt = f.tx(() => T.transform(f.repo, po.id, 'ITEM_RECEIPT', {
    txn_date: DATE,
    lines: [{ source_line_id: po.lines[0].id, quantity: 15, custom: { lots: [{ lot_number: 'BATCH-1', quantity: 15 }] } }],
  }));

  const so = f.tx(() => T.createTxn(f.repo, 'SALES_ORDER', {
    entity_id: f.customer.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.lotItem.id, quantity: 6 }],
  }));
  const ful = f.tx(() => T.transform(f.repo, so.id, 'FULFILLMENT', {
    txn_date: DATE,
    lines: [{ source_line_id: so.lines[0].id, quantity: 6, custom: { lots: [{ lot_number: 'BATCH-1', quantity: 6 }] } }],
  }));

  let lot = lotsMod.lotsFor(f.repo, f.lotItem.id, { locationId: f.location.id })[0];
  assert.equal(lot.quantity, Qty.parse(9));

  f.tx(() => T.voidTxn(f.repo, ful.id));
  lot = lotsMod.lotsFor(f.repo, f.lotItem.id, { locationId: f.location.id })[0];
  assert.equal(lot.quantity, Qty.parse(15), 'voiding the fulfilment must give the lot its quantity back');
  assert.equal(lot.status, 'available');

  f.tx(() => T.voidTxn(f.repo, receipt.id));
  lot = lotsMod.lotsFor(f.repo, f.lotItem.id, { locationId: f.location.id })[0];
  assert.equal(lot.quantity, 0, 'voiding the receipt must remove what it put on the lot');
  cleanTieOut(f);
});

test('work order component issue and build both carry lots', () => {
  const f = trading();
  const frame = f.tx(() => inv.createItem(f.repo, { sku: 'FRAME-LOT', name: 'Tracked frame', type: 'inventory', track_lots: 1, standard_cost: 40 }));
  const assembly = f.tx(() => inv.createItem(f.repo, { sku: 'ASM-LOT', name: 'Tracked assembly', type: 'assembly', track_lots: 1, standard_cost: 0 }));
  const bom = f.tx(() => mfg.createBom(f.repo, {
    item_id: assembly.id, name: 'Tracked assembly BOM', subsidiary_id: f.subsidiaryId,
    lines: [{ component_id: frame.id, quantity: 1 }],
  }));
  f.tx(() => mfg.releaseBom(f.repo, bom.id));

  f.tx(() => {
    const r = lotsMod.receiveLine(f.repo, {
      item: frame, location_id: f.location.id, quantity: Qty.parse(10), unit_cost: 40,
      entries: [{ lot_number: 'FRAME-BATCH', quantity: 10 }], type: 'receipt', source_type: 'ADJUST_SEED', source_id: 'seed', source_line_id: 'seed',
    });
    // A direct lots.mjs call (as opposed to going through a document) moves
    // stock but posts no journal on its own -- give the value a home the
    // same way an opening balance would, so the ledger and the stock ledger
    // start life agreeing (see manufacturing.test.mjs's `shop()`).
    gl.postJournal(f.repo, {
      subsidiary_id: f.subsidiaryId, txn_date: DATE, memo: 'Opening stock',
      lines: [
        { account_id: f.posting.inventory, debit: r.value_delta, credit: 0 },
        { account_id: f.accounts['3010'], debit: 0, credit: r.value_delta },
      ],
    });
  });

  const wo = f.tx(() => mfg.createWorkOrder(f.repo, {
    item_id: assembly.id, location_id: f.location.id, subsidiary_id: f.subsidiaryId, quantity: 4,
  }));
  f.tx(() => mfg.releaseWorkOrder(f.repo, wo.id));
  f.tx(() => mfg.issueComponents(f.repo, wo.id, { txn_date: DATE }));

  const frameLot = lotsMod.lotsFor(f.repo, frame.id, { locationId: f.location.id })[0];
  assert.equal(frameLot.quantity, Qty.parse(6), '4 frames must have been drawn off the named lot');

  f.tx(() => mfg.buildWorkOrder(f.repo, wo.id, {
    quantity: 4, txn_date: DATE, close: true, lots: [{ lot_number: 'ASM-BATCH', quantity: 4 }],
  }));
  const asmLots = lotsMod.lotsFor(f.repo, assembly.id, { locationId: f.location.id });
  assert.equal(asmLots.length, 1);
  assert.equal(asmLots[0].lot_number, 'ASM-BATCH');
  assert.equal(asmLots[0].quantity, Qty.parse(4));
  cleanTieOut(f);
});

test('lots survive a wave pick-pack-ship, and the staging bin is left empty afterwards', () => {
  const f = trading();
  const recvBin = f.tx(() => wh.createBin(f.repo, { location_id: f.location.id, code: 'RECV', bin_type: 'receiving' }));
  const storageBin = f.tx(() => wh.createBin(f.repo, { location_id: f.location.id, code: 'STORE-A', bin_type: 'storage' }));
  const stagingBin = f.tx(() => wh.createBin(f.repo, { location_id: f.location.id, code: 'STAGE', bin_type: 'staging' }));
  f.tx(() => f.repo.update('location', f.location.id, { default_receiving_bin_id: recvBin.id }));

  const po = f.tx(() => T.createTxn(f.repo, 'PURCHASE_ORDER', {
    entity_id: f.vendor.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.lotItem.id, quantity: 12, unit_price: 200 }],
  }));
  const receipt = f.tx(() => T.transform(f.repo, po.id, 'ITEM_RECEIPT', {
    txn_date: DATE,
    lines: [{ source_line_id: po.lines[0].id, quantity: 12, custom: { lots: [{ lot_number: 'WAVE-1', quantity: 12 }] } }],
  }));

  const inRecv = f.repo.queryOne(
    'SELECT * FROM bin_quantity WHERE tenant_id = :t AND bin_id = ? AND item_id = ? AND lot_number = ?',
    [recvBin.id, f.lotItem.id, 'WAVE-1']);
  assert.equal(inRecv.quantity, Qty.parse(12), 'the receipt must have filled the receiving bin under its real lot key');

  const putaway = f.tx(() => wh.generatePutaway(f.repo, receipt.id));
  assert.equal(putaway.tasks, 1);
  const task = f.repo.queryOne("SELECT * FROM putaway_task WHERE tenant_id = :t AND receipt_txn_id = ?", [receipt.id]);
  assert.equal(task.lot_number, 'WAVE-1');
  f.tx(() => wh.completePutaway(f.repo, task.id, { to_bin_id: storageBin.id }));

  const so = f.tx(() => T.createTxn(f.repo, 'SALES_ORDER', {
    entity_id: f.customer.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.lotItem.id, quantity: 5 }],
  }));
  const wave = f.tx(() => wh.createWave(f.repo, { location_id: f.location.id, txn_ids: [so.id] }));
  assert.equal(wave.tasks[0].lot_number, 'WAVE-1');
  for (const t of wave.tasks) f.tx(() => wh.confirmPick(f.repo, t.id, {}));

  wh.shipWave(f.repo, wave.id);

  const fulfilment = f.repo.queryOne("SELECT * FROM txn WHERE tenant_id = :t AND type = 'FULFILLMENT' AND source_txn_id = ?", [so.id]);
  assert.ok(fulfilment, 'the order must have shipped');
  const lot = lotsMod.lotsFor(f.repo, f.lotItem.id, { locationId: f.location.id })[0];
  assert.equal(lot.quantity, Qty.parse(7), 'the named lot, not a fresh FEFO pick, must have been consumed');

  const stagingRow = f.repo.queryOne(
    'SELECT * FROM bin_quantity WHERE tenant_id = :t AND bin_id = ? AND item_id = ?', [stagingBin.id, f.lotItem.id]);
  assert.equal(stagingRow?.quantity || 0, 0, 'shipping must clear the staging bin, not leave it forever "holding" shipped stock');

  const trace = lotsMod.trace(f.repo, lot.id);
  assert.equal(trace.movements.length, 2, 'a receive and an issue');
  assert.equal(trace.movements[0].direction, 'receive');
  assert.equal(trace.movements[1].direction, 'issue');
  assert.equal(trace.movements[1].document.ref, fulfilment.txn_no);
  cleanTieOut(f);
});

test('a stock count on a lot-tracked item counts lot by lot, and posts a per-lot adjustment', async () => {
  const costing = await import('../src/modules/costing.mjs');
  const f = trading();
  f.tx(() => {
    const r = lotsMod.receiveLine(f.repo, {
      item: f.lotItem, location_id: f.location.id, quantity: Qty.parse(10), unit_cost: 200,
      entries: [{ lot_number: 'A', quantity: 6 }, { lot_number: 'B', quantity: 4 }],
      type: 'receipt', source_type: 'ADJUST_SEED', source_id: 'seed', source_line_id: 'seed',
    });
    gl.postJournal(f.repo, {
      subsidiary_id: f.subsidiaryId, txn_date: DATE, memo: 'Opening stock',
      lines: [
        { account_id: f.posting.inventory, debit: r.value_delta, credit: 0 },
        { account_id: f.accounts['3010'], debit: 0, credit: r.value_delta },
      ],
    });
  });

  const count = f.tx(() => costing.openCount(f.repo, { location_id: f.location.id }));
  const lines = count.lines.filter((l) => l.item_id === f.lotItem.id);
  assert.equal(lines.length, 2, 'one count line per lot, not one per item');

  const lineA = lines.find((l) => l.lot_number === 'A');
  const lineB = lines.find((l) => l.lot_number === 'B');
  f.tx(() => costing.enterCounts(f.repo, count.id, [
    { id: lineA.id, counted_qty: 5 },   // 1 short
    { id: lineB.id, counted_qty: 4 },   // matches
  ]));
  const posted = f.tx(() => costing.postCount(f.repo, count.id, { txn_date: DATE }));
  assert.equal(posted.variances, 1);

  const lots = lotsMod.lotsFor(f.repo, f.lotItem.id, { locationId: f.location.id });
  assert.equal(lots.find((l) => l.lot_number === 'A').quantity, Qty.parse(5));
  assert.equal(lots.find((l) => l.lot_number === 'B').quantity, Qty.parse(4), 'the matching lot must be untouched');
  cleanTieOut(f);
});
