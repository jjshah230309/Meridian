// A build moves real value through the ledger: components out of stock into
// work in progress, labour and overhead in, finished goods back out. These
// tests exist because that chain used to skip the journal entirely whenever a
// work order had no WIP account, which left the inventory control account and
// the stock ledger permanently apart with nothing to show for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant, DATE } from './helpers.mjs';
import * as mfg from '../src/modules/manufacturing.mjs';
import * as inv from '../src/modules/inventory.mjs';
import * as gl from '../src/modules/gl.mjs';
import { Money, Qty } from '../src/core/util.mjs';

/** A tenant with an assembly, two components in stock, and a released BOM. */
function shop({ withRouting = false } = {}) {
  const f = freshTenant();
  const loc = f.location.id;
  const mk = (sku, name, cost) => f.tx(() => inv.createItem(f.repo, {
    sku, name, type: 'inventory', standard_cost: cost, base_price: cost * 2,
  }));
  const frame = mk('FRAME', 'Steel frame', 40);
  const motor = mk('MOTOR', 'Drive motor', 60);
  const widget = mk('WIDGET', 'Finished widget', 0);

  // 100 of each component on the shelf at standard cost, booked against
  // equity the way an opening balance would be, so the inventory account and
  // the stock ledger start life agreeing with each other.
  f.tx(() => {
    let opening = 0;
    for (const c of [frame, motor]) {
      const r = inv.moveStock(f.repo, {
        item_id: c.id, location_id: loc, qty_delta: Qty.parse(100),
        unit_cost: c.standard_cost, type: 'receipt', txn_date: DATE,
      });
      opening += r.value_delta;
    }
    gl.postJournal(f.repo, {
      subsidiary_id: f.subsidiaryId, txn_date: DATE, memo: 'Opening stock',
      lines: [
        { account_id: f.posting.inventory, debit: opening, credit: 0 },
        { account_id: f.accounts['3010'], debit: 0, credit: opening },
      ],
    });
  });

  let workCentre = null;
  if (withRouting) {
    workCentre = f.tx(() => f.repo.insert('work_center', {
      id: 'wc_press', name: 'Press line', location_id: loc,
      capacity_hours_per_day: Qty.parse(8),
      labour_rate: Money.parse(30), overhead_rate: Money.parse(12),
      labour_account_id: null, overhead_account_id: null,
      active: 1, created_at: new Date().toISOString(),
    }));
  }

  const bom = f.tx(() => mfg.createBom(f.repo, {
    item_id: widget.id, name: 'Widget rev A',
    lines: [
      { component_id: frame.id, quantity: 1 },
      { component_id: motor.id, quantity: 2 },
    ],
    routing: withRouting
      ? [{ operation_no: 10, name: 'Press', work_center_id: workCentre, run_hours: 0.5 }]
      : [],
  }));
  f.tx(() => mfg.releaseBom(f.repo, bom.id));

  return { f, loc, frame, motor, widget, bom, workCentre };
}

/** Posted movement on one account, debit-positive. */
const balance = (f, accountId) => f.repo.scalar(
  `SELECT COALESCE(SUM(jl.base_debit - jl.base_credit), 0) v
   FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
   WHERE jl.tenant_id = :t AND je.status = 'posted' AND jl.account_id = ?`, [accountId], 0);

test('issuing components moves value from inventory into WIP', () => {
  const { f, widget, loc } = shop();
  const wo = f.tx(() => mfg.createWorkOrder(f.repo, {
    item_id: widget.id, location_id: loc, subsidiary_id: f.subsidiaryId, quantity: 10,
  }));
  f.tx(() => mfg.releaseWorkOrder(f.repo, wo.id));

  const before = balance(f, f.posting.inventory);
  const issued = f.tx(() => mfg.issueComponents(f.repo, wo.id, { txn_date: DATE }));

  // 10 frames at 40 plus 20 motors at 60 = 1,600
  assert.equal(issued.value, 1600);
  assert.equal(balance(f, f.posting.inventory), before - Money.parse(1600));
  assert.equal(balance(f, f.posting.wip), Money.parse(1600));
  assert.ok(gl.integrityCheck(f.repo).ok);
});

test('a work order posts even when nobody configured a WIP account', () => {
  const { f, widget, loc } = shop();
  const wo = f.tx(() => mfg.createWorkOrder(f.repo, {
    item_id: widget.id, location_id: loc, subsidiary_id: f.subsidiaryId, quantity: 5,
  }));
  // Simulate the old data shape: a job with no accounts named on it at all.
  f.tx(() => f.repo.update('work_order', wo.id, { wip_account_id: null, variance_account_id: null }));
  f.tx(() => mfg.releaseWorkOrder(f.repo, wo.id));
  f.tx(() => mfg.issueComponents(f.repo, wo.id, { txn_date: DATE }));

  assert.equal(balance(f, f.posting.wip), Money.parse(800), 'the company default must be used');
  assert.ok(gl.integrityCheck(f.repo).ok);
});

test('labour and overhead enter WIP from an account, not from nowhere', () => {
  const { f, widget, loc } = shop({ withRouting: true });
  const wo = f.tx(() => mfg.createWorkOrder(f.repo, {
    item_id: widget.id, location_id: loc, subsidiary_id: f.subsidiaryId, quantity: 10,
  }));
  f.tx(() => mfg.releaseWorkOrder(f.repo, wo.id));
  f.tx(() => mfg.issueComponents(f.repo, wo.id, { txn_date: DATE }));

  const op = mfg.woOperations(f.repo, wo.id)[0];
  assert.ok(op, 'the routing must produce an operation');
  const logged = f.tx(() => mfg.logOperation(f.repo, wo.id, op.id, { hours: 4, complete: true }));

  assert.equal(logged.labour, 120);    // 4h at 30
  assert.equal(logged.overhead, 48);   // 4h at 12
  assert.equal(balance(f, f.posting.wip), Money.parse(1600 + 120 + 48));
  assert.equal(balance(f, f.posting.labour_absorbed), -Money.parse(120));
  assert.equal(balance(f, f.posting.overhead_absorbed), -Money.parse(48));
  assert.ok(gl.integrityCheck(f.repo).ok);
});

test('a completed build leaves nothing behind in WIP', () => {
  const { f, widget, loc } = shop({ withRouting: true });
  const wo = f.tx(() => mfg.createWorkOrder(f.repo, {
    item_id: widget.id, location_id: loc, subsidiary_id: f.subsidiaryId, quantity: 10,
  }));
  f.tx(() => mfg.releaseWorkOrder(f.repo, wo.id));
  f.tx(() => mfg.issueComponents(f.repo, wo.id, { txn_date: DATE }));
  const op = mfg.woOperations(f.repo, wo.id)[0];
  f.tx(() => mfg.logOperation(f.repo, wo.id, op.id, { hours: 4, complete: true }));
  const built = f.tx(() => mfg.buildWorkOrder(f.repo, wo.id, { txn_date: DATE }));

  assert.equal(built.complete, true);
  assert.equal(balance(f, f.posting.wip), 0, 'WIP must be empty once the job is done');

  // Everything the job absorbed is now sitting in the finished goods.
  const position = inv.position(f.repo, widget.id, loc);
  assert.equal(Qty.toNumber(position.qty_on_hand), 10);
  assert.equal(Money.toNumber(position.total_value), 1600 + 120 + 48);

  const check = gl.integrityCheck(f.repo);
  assert.ok(check.ok, JSON.stringify(check.subledgers));
});

test('the integrity check ties inventory to the stock ledger', () => {
  const { f, widget, loc } = shop();
  const wo = f.tx(() => mfg.createWorkOrder(f.repo, {
    item_id: widget.id, location_id: loc, subsidiary_id: f.subsidiaryId, quantity: 4,
  }));
  f.tx(() => mfg.releaseWorkOrder(f.repo, wo.id));
  f.tx(() => mfg.issueComponents(f.repo, wo.id, { txn_date: DATE }));
  f.tx(() => mfg.buildWorkOrder(f.repo, wo.id, { txn_date: DATE }));

  const check = gl.integrityCheck(f.repo);
  const stock = check.subledgers.find((s) => s.name === 'Inventory');
  assert.ok(stock, 'the inventory tie-out must be reported');
  assert.equal(stock.difference, 0);
  assert.equal(check.subledgers_tied, true);

  // And it must actually notice when they part company.
  f.repo.exec('UPDATE item_location SET total_value = total_value + 500 WHERE tenant_id = :t AND item_id = ?', [widget.id]);
  const broken = gl.integrityCheck(f.repo);
  assert.equal(broken.ok, false);
  assert.equal(broken.subledgers.find((s) => s.name === 'Inventory').difference, -500);
});
