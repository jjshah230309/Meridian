// Turning supply suggestions into purchase orders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant, DATE } from './helpers.mjs';
import * as planning from '../src/modules/planning.mjs';
import * as inv from '../src/modules/inventory.mjs';
import * as entities from '../src/modules/entities.mjs';
import { ulid, nowIso, Qty } from '../src/core/util.mjs';

function suggestion(f, { item, vendor, quantity = 10 }) {
  const id = ulid();
  f.tx(() => f.repo.insert('supply_suggestion', {
    id, run_id: 'RUN-1', item_id: item.id, location_id: f.location.id,
    suggestion: 'purchase', quantity: Qty.parse(quantity), vendor_id: vendor.id,
    reason: 'Below reorder point', status: 'open', created_at: nowIso(),
  }));
  return id;
}

test('one vendor failing does not roll back a purchase order already raised for another vendor', () => {
  // actionSuggestions used to raise every vendor's purchase order inside one
  // transaction, so a vendor whose item became inactive between the plan
  // running and somebody actioning it rolled back purchase orders this same
  // call had already raised for a different, unrelated vendor.
  const f = freshTenant();
  const goodVendor = f.tx(() => entities.createVendor(f.repo, { name: 'Good Supply Co', subsidiary_id: f.subsidiaryId }));
  const badVendor = f.tx(() => entities.createVendor(f.repo, { name: 'Bad Supply Co', subsidiary_id: f.subsidiaryId }));
  const goodItem = f.tx(() => inv.createItem(f.repo, { sku: 'GOOD-1', name: 'Good Widget', type: 'inventory', purchase_price: 10 }));
  const badItem = f.tx(() => inv.createItem(f.repo, { sku: 'BAD-1', name: 'Bad Widget', type: 'inventory', purchase_price: 10 }));

  const goodId = suggestion(f, { item: goodItem, vendor: goodVendor });
  const badId = suggestion(f, { item: badItem, vendor: badVendor });

  // Something changed between the plan running and it being actioned.
  f.tx(() => inv.updateItem(f.repo, badItem.id, { active: false }));

  // Not wrapped in f.tx(): matches the fixed route, and is the point of the
  // test -- wrapping it would turn the isolation back into savepoints that
  // roll back together.
  assert.throws(() => planning.actionSuggestions(f.repo, [goodId, badId], { txn_date: DATE }), /invalid/i);

  const goodSuggestion = f.repo.get('supply_suggestion', goodId);
  assert.equal(goodSuggestion.status, 'actioned', 'the good vendor\'s order must still have gone through');
  assert.ok(goodSuggestion.created_txn_id);

  const badSuggestion = f.repo.get('supply_suggestion', badId);
  assert.equal(badSuggestion.status, 'open', 'the failing vendor\'s suggestion must not have been actioned');
  assert.equal(badSuggestion.created_txn_id, null);
});
