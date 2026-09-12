// Landed cost, and the count that checks the stock ledger was telling the
// truth. Both are about the same number — what a unit actually cost — and
// both are worthless unless the stock ledger and the inventory account move
// together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant } from './helpers.mjs';
import * as costing from '../src/modules/costing.mjs';
import * as entities from '../src/modules/entities.mjs';
import * as inv from '../src/modules/inventory.mjs';
import * as T from '../src/modules/txn.mjs';
import * as gl from '../src/modules/gl.mjs';
import { Money, Qty } from '../src/core/util.mjs';

const acct = (f, n) => f.repo.queryOne('SELECT * FROM account WHERE tenant_id = :t AND number = ?', [n]);
const thrown = (fn) => { try { fn(); } catch (e) { return e; } return null; };
const balance = (f, n) => f.repo.scalar(
  `SELECT COALESCE(SUM(jl.base_debit - jl.base_credit), 0) v FROM journal_line jl
   JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
   JOIN account a ON a.tenant_id = jl.tenant_id AND a.id = jl.account_id
   WHERE jl.tenant_id = :t AND je.status = 'posted' AND a.number = ?`, [n], 0);
const stockValue = (f) => f.repo.scalar(
  'SELECT COALESCE(SUM(total_value), 0) v FROM item_location WHERE tenant_id = :t', [], 0);
const category = (f, name) => f.repo.queryOne(
  'SELECT * FROM landed_cost_category WHERE tenant_id = :t AND name = ?', [name]);

/** Two items received on one bill: 10 at $100 and 40 at $25. Same value each. */
function receipt(f, { weights = [1000, 250] } = {}) {
  const vendor = f.tx(() => entities.createVendor(f.repo, { name: 'Far East Trading', subsidiary_id: f.subsidiaryId }));
  const heavy = f.tx(() => inv.createItem(f.repo, {
    sku: 'HEAVY', name: 'Heavy widget', type: 'inventory', base_price: 300, standard_cost: 100, weight_g: weights[0],
  }));
  const light = f.tx(() => inv.createItem(f.repo, {
    sku: 'LIGHT', name: 'Light widget', type: 'inventory', base_price: 80, standard_cost: 25, weight_g: weights[1],
  }));
  const bill = f.tx(() => T.createTxn(f.repo, 'VENDOR_BILL', {
    entity_id: vendor.id, subsidiary_id: f.subsidiaryId, txn_date: '2026-03-01',
    location_id: f.location.id,
    lines: [
      { item_id: heavy.id, quantity: 10, unit_price: 100 },
      { item_id: light.id, quantity: 40, unit_price: 25 },
    ],
  }));
  return { vendor, heavy, light, bill };
}

test('freight by value is split in proportion to what the goods cost', () => {
  const f = freshTenant();
  const { bill, heavy, light } = receipt(f);
  assert.equal(stockValue(f), Money.parse(2000), '$1,000 of each');

  f.tx(() => costing.addLandedCost(f.repo, bill.id, {
    category_id: category(f, 'Freight').id, amount: 400, method: 'value', reference: 'BL-8871',
  }));

  assert.equal(stockValue(f), Money.parse(2400), 'the goods are worth what they cost to get here');
  assert.equal(balance(f, '1200'), Money.parse(2400), 'and the ledger agrees');
  const heavyPos = f.repo.queryOne('SELECT * FROM item_location WHERE tenant_id = :t AND item_id = ?', [heavy.id]);
  const lightPos = f.repo.queryOne('SELECT * FROM item_location WHERE tenant_id = :t AND item_id = ?', [light.id]);
  assert.equal(heavyPos.total_value, Money.parse(1200), 'half the freight on half the value');
  assert.equal(lightPos.total_value, Money.parse(1200));
  assert.equal(heavyPos.avg_cost, Money.parse(120), '10 units now cost $120 each');
  assert.equal(lightPos.avg_cost, Money.parse(30), '40 units now cost $30 each');
  assert.equal(gl.integrityCheck(f.repo).ok, true);
  assert.equal(gl.tieOuts(f.repo).find((t) => t.name === 'Inventory').difference, 0);
});

test('handling by quantity follows the units, not the money', () => {
  const f = freshTenant();
  const { bill, heavy, light } = receipt(f);
  f.tx(() => costing.addLandedCost(f.repo, bill.id, {
    category_id: category(f, 'Handling').id, amount: 500, method: 'quantity',
  }));
  const heavyPos = f.repo.queryOne('SELECT * FROM item_location WHERE tenant_id = :t AND item_id = ?', [heavy.id]);
  const lightPos = f.repo.queryOne('SELECT * FROM item_location WHERE tenant_id = :t AND item_id = ?', [light.id]);
  assert.equal(heavyPos.total_value, Money.parse(1100), '10 of 50 units');
  assert.equal(lightPos.total_value, Money.parse(1400), '40 of 50 units');
});

test('freight by weight follows the weight', () => {
  const f = freshTenant();
  const { bill, heavy } = receipt(f);
  // 10 × 1000g = 10kg against 40 × 250g = 10kg: an even split.
  f.tx(() => costing.addLandedCost(f.repo, bill.id, {
    category_id: category(f, 'Freight').id, amount: 300, method: 'weight',
  }));
  const heavyPos = f.repo.queryOne('SELECT * FROM item_location WHERE tenant_id = :t AND item_id = ?', [heavy.id]);
  assert.equal(heavyPos.total_value, Money.parse(1150));
});

test('weightless goods cannot be costed by weight, and it says so', () => {
  const f = freshTenant();
  const { bill } = receipt(f, { weights: [0, 0] });
  const err = thrown(() => f.tx(() => costing.addLandedCost(f.repo, bill.id, {
    category_id: category(f, 'Freight').id, amount: 300, method: 'weight',
  })));
  assert.match(err.message, /none of the items|no weight/i);
  assert.equal(stockValue(f), Money.parse(2000), 'and nothing was capitalised');
});

test('the summary explains what a unit ended up costing', () => {
  const f = freshTenant();
  const { bill } = receipt(f);
  f.tx(() => costing.addLandedCost(f.repo, bill.id, { category_id: category(f, 'Freight').id, amount: 400 }));
  f.tx(() => costing.addLandedCost(f.repo, bill.id, { category_id: category(f, 'Duty').id, amount: 200 }));

  const summary = costing.landedSummary(f.repo, bill.id);
  assert.equal(summary.costs.length, 2);
  assert.equal(summary.goods_value, Money.parse(2000));
  assert.equal(summary.landed_total, Money.parse(600));
  const heavy = summary.rows.find((r) => r.sku === 'HEAVY');
  assert.equal(heavy.total, Money.parse(1300));
  assert.equal(heavy.unit_cost, Money.parse(130));
  assert.equal(heavy.uplift_pct, 30);
});

test('landed cost belongs on a receipt or a bill, not on an invoice', () => {
  const f = freshTenant();
  const customer = f.tx(() => entities.createCustomer(f.repo, { name: 'Anyone', subsidiary_id: f.subsidiaryId }));
  const invoice = f.tx(() => T.createTxn(f.repo, 'INVOICE', {
    entity_id: customer.id, subsidiary_id: f.subsidiaryId, txn_date: '2026-03-01',
    lines: [{ account_id: acct(f, '4020').id, quantity: 1, unit_price: 500 }],
  }));
  assert.match(thrown(() => f.tx(() => costing.addLandedCost(f.repo, invoice.id, {
    category_id: category(f, 'Freight').id, amount: 100,
  }))).message, /receipt or a bill/);
});

// ------------------------------------------------------------- counts
function stocked(f, rows) {
  const vendor = f.tx(() => entities.createVendor(f.repo, { name: 'Supplier', subsidiary_id: f.subsidiaryId }));
  const items = rows.map(([sku, , cost]) => f.tx(() => inv.createItem(f.repo, {
    sku, name: sku, type: 'inventory', base_price: cost * 3, standard_cost: cost,
  })));
  f.tx(() => T.createTxn(f.repo, 'VENDOR_BILL', {
    entity_id: vendor.id, subsidiary_id: f.subsidiaryId, txn_date: '2026-03-01',
    location_id: f.location.id,
    lines: items.map((item, i) => ({ item_id: item.id, quantity: rows[i][1], unit_price: rows[i][2] })),
  }));
  return items;
}

test('a count sheet freezes what the system thought at the time', () => {
  const f = freshTenant();
  const [a] = stocked(f, [['A', 10, 5], ['B', 4, 20]]);
  const count = f.tx(() => costing.openCount(f.repo, { location_id: f.location.id, count_date: '2026-03-31' }));

  assert.equal(count.status, 'open');
  assert.equal(count.line_count, 2);
  assert.equal(count.lines.find((l) => l.sku === 'A').expected_qty, Qty.parse(10));

  // Stock moves after the sheet is issued; the sheet does not.
  f.tx(() => inv.moveStock(f.repo, {
    item_id: a.id, location_id: f.location.id, qty_delta: Qty.parse(-3),
    type: 'issue', txn_date: '2026-03-31',
  }));
  assert.equal(costing.getCount(f.repo, count.id).lines.find((l) => l.sku === 'A').expected_qty, Qty.parse(10),
    'the counter was working from ten');
});

test('entering a count works out the variance and its value', () => {
  const f = freshTenant();
  stocked(f, [['A', 10, 5], ['B', 4, 20]]);
  const count = f.tx(() => costing.openCount(f.repo, { location_id: f.location.id, count_date: '2026-03-31' }));
  const lineA = count.lines.find((l) => l.sku === 'A');
  const lineB = count.lines.find((l) => l.sku === 'B');

  const entered = f.tx(() => costing.enterCounts(f.repo, count.id, [
    { id: lineA.id, counted_qty: 8, note: 'Two missing from the top shelf' },
    { id: lineB.id, counted_qty: 4 },
  ]));
  assert.equal(entered.status, 'counted');
  assert.equal(entered.counted_count, 2);
  assert.equal(entered.lines.find((l) => l.sku === 'A').variance_qty, Qty.parse(-2));
  assert.equal(entered.lines.find((l) => l.sku === 'A').variance_value, -Money.parse(10));
  assert.equal(entered.variance_value, -Money.parse(10), 'B was right, so it contributes nothing');
});

test('posting a count adjusts the stock and the ledger together', () => {
  const f = freshTenant();
  stocked(f, [['A', 10, 5], ['B', 4, 20]]);
  const before = stockValue(f);
  const count = f.tx(() => costing.openCount(f.repo, { location_id: f.location.id, count_date: '2026-03-31' }));
  const lineA = count.lines.find((l) => l.sku === 'A');
  const lineB = count.lines.find((l) => l.sku === 'B');
  f.tx(() => costing.enterCounts(f.repo, count.id, [
    { id: lineA.id, counted_qty: 8 },
    { id: lineB.id, counted_qty: 5 },
  ]));

  const res = f.tx(() => costing.postCount(f.repo, count.id));
  assert.equal(res.count.status, 'posted');
  assert.equal(res.variances, 2);
  assert.ok(res.adjustment.txn_no, 'one adjustment carries the lot');
  assert.equal(stockValue(f), before - Money.parse(10) + Money.parse(20));
  assert.equal(gl.tieOuts(f.repo).find((t) => t.name === 'Inventory').difference, 0);
  assert.equal(gl.integrityCheck(f.repo).ok, true);
});

test('a count where everything agrees posts without an adjustment', () => {
  const f = freshTenant();
  stocked(f, [['A', 10, 5]]);
  const count = f.tx(() => costing.openCount(f.repo, { location_id: f.location.id, count_date: '2026-03-31' }));
  f.tx(() => costing.enterCounts(f.repo, count.id, [{ id: count.lines[0].id, counted_qty: 10 }]));
  const res = f.tx(() => costing.postCount(f.repo, count.id));
  assert.equal(res.variances, 0);
  assert.equal(res.adjustment, null, 'nothing to correct, so nothing is posted');
  assert.equal(res.count.status, 'posted');
});

test('a cycle count takes the shelves nobody has looked at longest', () => {
  const f = freshTenant();
  stocked(f, [['A', 10, 5], ['B', 4, 20], ['C', 7, 9]]);
  f.tx(() => f.repo.exec(
    "UPDATE item_location SET last_count_at = '2026-01-01' WHERE tenant_id = :t AND item_id IN (SELECT id FROM item WHERE tenant_id = :t AND sku = 'A')"));
  const count = f.tx(() => costing.openCount(f.repo, { location_id: f.location.id, scope: 'cycle', size: 2 }));
  assert.equal(count.line_count, 2);
  assert.deepEqual(count.lines.map((l) => l.sku).sort(), ['B', 'C'], 'A was counted in January');
});

test('posting a count records when each line was last counted', () => {
  const f = freshTenant();
  stocked(f, [['A', 10, 5]]);
  const count = f.tx(() => costing.openCount(f.repo, { location_id: f.location.id, count_date: '2026-03-31' }));
  f.tx(() => costing.enterCounts(f.repo, count.id, [{ id: count.lines[0].id, counted_qty: 10 }]));
  f.tx(() => costing.postCount(f.repo, count.id));
  const pos = f.repo.queryOne('SELECT last_count_at FROM item_location WHERE tenant_id = :t LIMIT 1');
  assert.equal(pos.last_count_at, '2026-03-31');
});

test('a posted count is closed to further changes', () => {
  const f = freshTenant();
  stocked(f, [['A', 10, 5]]);
  const count = f.tx(() => costing.openCount(f.repo, { location_id: f.location.id, count_date: '2026-03-31' }));
  f.tx(() => costing.enterCounts(f.repo, count.id, [{ id: count.lines[0].id, counted_qty: 9 }]));
  f.tx(() => costing.postCount(f.repo, count.id));
  assert.match(thrown(() => f.tx(() => costing.enterCounts(f.repo, count.id, [{ id: count.lines[0].id, counted_qty: 8 }]))).message,
    /cannot change/);
  assert.match(thrown(() => f.tx(() => costing.postCount(f.repo, count.id))).message, /already been posted/);
  assert.match(thrown(() => f.tx(() => costing.cancelCount(f.repo, count.id))).message, /Reverse the adjustment/);
});

test('a negative count is refused', () => {
  const f = freshTenant();
  stocked(f, [['A', 10, 5]]);
  const count = f.tx(() => costing.openCount(f.repo, { location_id: f.location.id }));
  assert.match(thrown(() => f.tx(() => costing.enterCounts(f.repo, count.id, [{ id: count.lines[0].id, counted_qty: -1 }]))).fields['lines.0.counted_qty'],
    /cannot be negative/);
});

test('a count of a location with nothing in it says so rather than opening an empty sheet', () => {
  const f = freshTenant();
  assert.match(thrown(() => f.tx(() => costing.openCount(f.repo, { location_id: f.location.id }))).message,
    /Nothing stocked/);
});
