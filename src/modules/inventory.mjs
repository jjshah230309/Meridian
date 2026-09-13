// Meridian ERP :: modules/inventory
// Multi-location stock ledger, moving-average costing, commitments and
// replenishment. Every physical movement writes an inventory_txn row, so the
// on-hand figure is always reproducible from an append-only history.
//
// Costing: moving weighted average, maintained per item AND per location
// (NetSuite's default behaviour). Issues are valued at the location's average
// cost at the moment of the movement, which is what makes COGS deterministic.
import { ulid, nowIso, today, Money, Qty, round, sum } from '../core/util.mjs';
import { notFound, unprocessable, ValidationError, badRequest } from '../core/http.mjs';
import * as audit from '../core/audit.mjs';
import { indexRecord } from '../core/search.mjs';

export const ITEM_TYPES = ['inventory', 'noninventory', 'service', 'assembly', 'kit', 'discount'];
/** One whole unit in the scaled-quantity representation. */
const QTY_UNIT = 1_000_000;
export const STOCKED = new Set(['inventory', 'assembly']);
export const isStocked = (item) => STOCKED.has(item?.type);

// ------------------------------------------------------------- items
export function getItem(repo, id) {
  const i = repo.get('item', id);
  if (!i) throw notFound(`Item ${id} not found`);
  return i;
}
export const itemBySku = (repo, sku) => repo.queryOne('SELECT * FROM item WHERE tenant_id = :t AND sku = ?', [sku]);

export function createItem(repo, input) {
  const fields = {};
  if (!input.sku) fields.sku = 'SKU is required';
  if (!input.name) fields.name = 'Item name is required';
  if (input.type && !ITEM_TYPES.includes(input.type)) fields.type = `Type must be one of ${ITEM_TYPES.join(', ')}`;
  if (Object.keys(fields).length) throw new ValidationError(fields);
  if (itemBySku(repo, input.sku)) throw new ValidationError({ sku: `SKU ${input.sku} is already in use` });

  const now = nowIso();
  const id = repo.insert('item', {
    id: ulid(), sku: String(input.sku).trim(), name: input.name, description: input.description || '',
    type: input.type || 'inventory', category: input.category || '', uom: input.uom || 'EA',
    base_price: Money.parse(input.base_price ?? 0),
    standard_cost: Money.parse(input.standard_cost ?? 0),
    purchase_price: Money.parse(input.purchase_price ?? input.standard_cost ?? 0),
    costing_method: input.costing_method || 'average',
    income_account_id: input.income_account_id || null, cogs_account_id: input.cogs_account_id || null,
    asset_account_id: input.asset_account_id || null, expense_account_id: input.expense_account_id || null,
    preferred_vendor_id: input.preferred_vendor_id || null,
    revenue_template_id: input.revenue_template_id || null,
    expense_template_id: input.expense_template_id || null,
    taxable: input.taxable === 0 ? 0 : 1, tax_code: input.tax_code || 'STANDARD',
    weight_g: Number(input.weight_g || 0), barcode: input.barcode || '',
    lead_time_days: Number(input.lead_time_days || 7), is_serialised: input.is_serialised ? 1 : 0,
    active: input.active === 0 ? 0 : 1, custom: input.custom || {}, created_at: now, updated_at: now,
  });
  audit.record(repo, { recordType: 'item', recordId: id, action: 'create', after: input });
  reindexItem(repo, id);
  return getItem(repo, id);
}

export function updateItem(repo, id, patch) {
  const before = getItem(repo, id);
  const allowed = ['sku', 'name', 'description', 'type', 'category', 'uom', 'base_price', 'standard_cost',
    'purchase_price', 'costing_method', 'income_account_id', 'cogs_account_id', 'asset_account_id',
    'expense_account_id', 'preferred_vendor_id', 'taxable', 'tax_code', 'weight_g', 'barcode',
    'lead_time_days', 'is_serialised', 'active', 'custom',
    'revenue_template_id', 'expense_template_id'];
  const clean = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k)) continue;
    clean[k] = ['base_price', 'standard_cost', 'purchase_price'].includes(k) ? Money.parse(v) : v;
  }
  if (clean.sku && clean.sku !== before.sku && itemBySku(repo, clean.sku)) {
    throw new ValidationError({ sku: `SKU ${clean.sku} is already in use` });
  }
  // Switching a stocked item to a non-stocked type would strand its valuation.
  if (clean.type && clean.type !== before.type && isStocked(before) && !STOCKED.has(clean.type)) {
    const onHand = repo.scalar('SELECT COALESCE(SUM(qty_on_hand),0) q FROM item_location WHERE tenant_id = :t AND item_id = ?', [id], 0);
    if (onHand !== 0) throw unprocessable(`${before.sku} still has ${Qty.format(onHand)} ${before.uom} on hand. Adjust stock to zero before changing its type.`);
  }
  clean.updated_at = nowIso();
  repo.update('item', id, clean);
  const after = getItem(repo, id);
  audit.record(repo, { recordType: 'item', recordId: id, action: 'update', before, after });
  reindexItem(repo, id);
  return after;
}

export function reindexItem(repo, id) {
  const i = repo.get('item', id);
  if (!i) return;
  indexRecord(repo, 'item', id, {
    title: `${i.sku} · ${i.name}`,
    subtitle: `${i.type} · ${Money.format(i.base_price)}`,
    body: [i.description, i.category, i.barcode].filter(Boolean).join(' '),
  });
}

// ------------------------------------------------------ stock position
/** Fetch (creating on demand) the item/location position row. */
export function position(repo, itemId, locationId) {
  let row = repo.queryOne('SELECT * FROM item_location WHERE tenant_id = :t AND item_id = ? AND location_id = ?', [itemId, locationId]);
  if (!row) {
    repo.exec(`INSERT INTO item_location (tenant_id, item_id, location_id) VALUES (:t,?,?)
               ON CONFLICT (tenant_id, item_id, location_id) DO NOTHING`, [itemId, locationId]);
    row = repo.queryOne('SELECT * FROM item_location WHERE tenant_id = :t AND item_id = ? AND location_id = ?', [itemId, locationId]);
  }
  return row;
}

export const available = (pos) => (pos.qty_on_hand || 0) - (pos.qty_committed || 0);

/** Availability for one item across every location. */
export function availability(repo, itemId) {
  const rows = repo.query(`SELECT il.*, l.name location_name, l.code location_code
      FROM item_location il JOIN location l ON l.tenant_id = il.tenant_id AND l.id = il.location_id
      WHERE il.tenant_id = :t AND il.item_id = ? ORDER BY l.name`, [itemId]);
  return {
    locations: rows.map((r) => ({ ...r, qty_available: available(r) })),
    total_on_hand: sum(rows, (r) => r.qty_on_hand),
    total_committed: sum(rows, (r) => r.qty_committed),
    total_available: sum(rows, (r) => available(r)),
    total_on_order: sum(rows, (r) => r.qty_on_order),
    total_value: sum(rows, (r) => r.total_value),
  };
}

/**
 * Apply a stock movement and return its valuation impact.
 *
 * Positive qtyDelta (receipt) recalculates the moving average:
 *     newAvg = (existingValue + receivedQty * unitCost) / (existingQty + receivedQty)
 * Negative qtyDelta (issue) is valued at the CURRENT average, so the caller
 * gets back the exact amount to post to COGS.
 *
 * Returns { value_delta, unit_cost_used, avg_cost, qty_after }.
 */
export function moveStock(repo, {
  item_id, location_id, qty_delta, unit_cost = null, type, source_type = '', source_id = null,
  txn_date = null, memo = '', allow_negative = true, value_delta: valueOnly = null,
  item = null, pos = null,
}) {
  const resolvedItem = item || getItem(repo, item_id);
  if (!isStocked(resolvedItem)) {
    return { value_delta: 0, unit_cost_used: 0, avg_cost: 0, qty_after: 0, skipped: 'not_stocked' };
  }
  if (!location_id) throw new ValidationError({ location_id: 'A location is required to move stock' });

  // Landed cost adds value to stock that is already here: the freight on a
  // container makes the goods worth more without another unit arriving. The
  // average cost moves, the quantity does not.
  if (!qty_delta && valueOnly) {
    const here = pos || position(repo, item_id, location_id);
    const qty = here.qty_on_hand || 0;
    const value = (here.total_value || 0) + valueOnly;
    const avg = qty > 0 ? round(value / (qty / 1_000_000)) : (here.avg_cost || 0);
    repo.exec(`UPDATE item_location SET total_value = ?, avg_cost = ?
               WHERE tenant_id = :t AND item_id = ? AND location_id = ?`,
      [value, avg, item_id, location_id]);
    repo.insert('inventory_txn', {
      id: ulid(), item_id, location_id, type: type || 'landed_cost',
      qty_delta: 0, unit_cost: avg, value_delta: valueOnly,
      running_qty: qty, running_value: value,
      source_type, source_id, txn_date: txn_date || today(), memo, created_at: nowIso(),
    });
    return { value_delta: valueOnly, unit_cost_used: avg, avg_cost: avg, qty_after: qty };
  }
  if (!qty_delta) return { value_delta: 0, unit_cost_used: 0, avg_cost: 0, qty_after: 0, skipped: 'zero_qty' };

  const here = pos || position(repo, item_id, location_id);
  const qtyBefore = here.qty_on_hand || 0;
  const valueBefore = here.total_value || 0;
  const avgBefore = here.avg_cost || resolvedItem.standard_cost || 0;

  let valueDelta, unitCostUsed;
  if (qty_delta > 0) {
    unitCostUsed = unit_cost ?? avgBefore ?? resolvedItem.standard_cost ?? 0;
    valueDelta = Qty.extend(qty_delta, unitCostUsed);
  } else {
    unitCostUsed = avgBefore;
    if (!allow_negative && qtyBefore + qty_delta < 0) {
      throw unprocessable(`Only ${Qty.format(qtyBefore)} ${resolvedItem.uom} of ${resolvedItem.sku} on hand at this location; cannot issue ${Qty.format(-qty_delta)}.`);
    }
    valueDelta = -Qty.extend(-qty_delta, unitCostUsed);
    // When quantity lands exactly on zero, flush the whole remaining value so
    // no rounding residue is stranded in the asset account.
    //
    // Shipping more than is on hand deliberately drives BOTH quantity and
    // value negative rather than silently costing the issue at zero. Negative
    // inventory is visible and correctable on the next receipt; a zero-cost
    // shipment quietly overstates gross margin, which is far worse.
    if (qtyBefore + qty_delta === 0) valueDelta = -valueBefore;
  }

  const qtyAfter = qtyBefore + qty_delta;
  const valueAfter = valueBefore + valueDelta;
  const avgAfter = qtyAfter > 0 ? round(valueAfter / (qtyAfter / 1_000_000)) : (qtyAfter === 0 ? 0 : avgBefore);

  repo.exec(`UPDATE item_location SET qty_on_hand = ?, total_value = ?, avg_cost = ?
             WHERE tenant_id = :t AND item_id = ? AND location_id = ?`,
    [qtyAfter, valueAfter, avgAfter, item_id, location_id]);

  repo.insert('inventory_txn', {
    id: ulid(), item_id, location_id, txn_date: txn_date || today(), type,
    qty_delta, unit_cost: unitCostUsed, value_delta: valueDelta,
    running_qty: qtyAfter, running_value: valueAfter,
    source_type, source_id, memo, created_at: nowIso(),
  });

  return { value_delta: valueDelta, unit_cost_used: unitCostUsed, avg_cost: avgAfter, qty_after: qtyAfter };
}

/** Reserve stock against an open order. Commitments never move valuation. */
export function commit(repo, itemId, locationId, qty) {
  const item = repo.get('item', itemId);
  if (!item || !isStocked(item) || !locationId || !qty) return 0;
  position(repo, itemId, locationId);
  repo.exec(`UPDATE item_location SET qty_committed = MAX(0, qty_committed + ?)
             WHERE tenant_id = :t AND item_id = ? AND location_id = ?`, [qty, itemId, locationId]);
  return qty;
}
export const release = (repo, itemId, locationId, qty) => commit(repo, itemId, locationId, -qty);

export function changeOnOrder(repo, itemId, locationId, qty) {
  const item = repo.get('item', itemId);
  if (!item || !isStocked(item) || !locationId || !qty) return 0;
  position(repo, itemId, locationId);
  repo.exec(`UPDATE item_location SET qty_on_order = MAX(0, qty_on_order + ?)
             WHERE tenant_id = :t AND item_id = ? AND location_id = ?`, [qty, itemId, locationId]);
  return qty;
}

// ----------------------------------------------------- replenishment
/**
 * Reorder analysis.
 *
 * Demand is measured from actual shipments over `lookbackDays`. The reorder
 * point is the greater of the configured value and a computed one:
 *     ROP = averageDailyDemand x leadTimeDays + safetyStock
 * so a stale manual setting cannot hide a genuine stock-out risk.
 */
export function reorderAnalysis(repo, { locationId = null, lookbackDays = 90 } = {}) {
  const since = new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10);
  const locFilter = locationId ? ' AND il.location_id = ?' : '';
  const params = locationId ? [since, locationId] : [since];

  const rows = repo.query(`
    SELECT il.*, i.sku, i.name item_name, i.uom, i.type, i.lead_time_days item_lead_time,
           i.purchase_price, i.preferred_vendor_id, l.name location_name, l.code location_code,
           COALESCE(d.shipped, 0) shipped_qty
      FROM item_location il
      JOIN item i ON i.tenant_id = il.tenant_id AND i.id = il.item_id
      JOIN location l ON l.tenant_id = il.tenant_id AND l.id = il.location_id
      LEFT JOIN (
        SELECT item_id, location_id, SUM(-qty_delta) shipped
          FROM inventory_txn
         WHERE tenant_id = :t AND type = 'shipment' AND txn_date >= ?
         GROUP BY item_id, location_id
      ) d ON d.item_id = il.item_id AND d.location_id = il.location_id
     WHERE il.tenant_id = :t AND i.active = 1 AND i.type IN ('inventory','assembly')${locFilter}`, params);

  const out = [];
  for (const r of rows) {
    const leadTime = r.lead_time_days || r.item_lead_time || 7;
    const dailyDemand = (r.shipped_qty || 0) / lookbackDays;          // scaled qty per day
    const computedRop = Math.ceil((round(dailyDemand * leadTime) + (r.safety_stock || 0)) / QTY_UNIT) * QTY_UNIT;
    const rop = Math.max(r.reorder_point || 0, computedRop);
    const avail = available(r);
    const projected = avail + (r.qty_on_order || 0);
    if (rop <= 0 && projected > 0) continue;
    if (projected > rop) continue;

    const target = r.preferred_stock_level || round(rop * 2) || round(dailyDemand * leadTime * 2) || 0;
    // Round the suggestion up to a whole unit: nobody orders 12.82 routers.
    const suggested = Math.ceil(Math.max(0, target - projected) / QTY_UNIT) * QTY_UNIT;
    if (suggested <= 0) continue;
    out.push({
      item_id: r.item_id, sku: r.sku, item_name: r.item_name, uom: r.uom,
      location_id: r.location_id, location_name: r.location_name, location_code: r.location_code,
      qty_on_hand: r.qty_on_hand, qty_committed: r.qty_committed, qty_available: avail,
      qty_on_order: r.qty_on_order, projected_available: projected,
      reorder_point: rop, configured_reorder_point: r.reorder_point,
      computed_reorder_point: computedRop, daily_demand: dailyDemand,
      lead_time_days: leadTime, preferred_stock_level: target,
      suggested_qty: suggested,
      estimated_cost: Qty.extend(suggested, r.purchase_price || r.avg_cost || 0),
      preferred_vendor_id: r.preferred_vendor_id,
      severity: avail <= 0 ? 'stockout' : projected <= (r.safety_stock || 0) ? 'critical' : 'low',
    });
  }
  return out.sort((a, b) => ({ stockout: 0, critical: 1, low: 2 }[a.severity] - { stockout: 0, critical: 1, low: 2 }[b.severity]) || b.estimated_cost - a.estimated_cost);
}

/** Inventory valuation, optionally as at a date (rebuilt from the ledger). */
export function valuation(repo, { locationId = null, asOf = null } = {}) {
  if (!asOf) {
    const locFilter = locationId ? ' AND il.location_id = ?' : '';
    const rows = repo.query(`SELECT i.id item_id, i.sku, i.name item_name, i.uom, i.category,
        l.id location_id, l.name location_name,
        il.qty_on_hand, il.avg_cost, il.total_value
        FROM item_location il
        JOIN item i ON i.tenant_id = il.tenant_id AND i.id = il.item_id
        JOIN location l ON l.tenant_id = il.tenant_id AND l.id = il.location_id
       WHERE il.tenant_id = :t AND i.type IN ('inventory','assembly') AND il.qty_on_hand != 0${locFilter}
       ORDER BY i.sku, l.name`, locationId ? [locationId] : []);
    return { as_of: today(), rows, total_value: sum(rows, (r) => r.total_value), total_qty: sum(rows, (r) => r.qty_on_hand) };
  }
  const locFilter = locationId ? ' AND it.location_id = ?' : '';
  const params = locationId ? [asOf, locationId] : [asOf];
  const rows = repo.query(`SELECT i.id item_id, i.sku, i.name item_name, i.uom, i.category,
      l.id location_id, l.name location_name,
      SUM(it.qty_delta) qty_on_hand, SUM(it.value_delta) total_value
      FROM inventory_txn it
      JOIN item i ON i.tenant_id = it.tenant_id AND i.id = it.item_id
      JOIN location l ON l.tenant_id = it.tenant_id AND l.id = it.location_id
     WHERE it.tenant_id = :t AND it.txn_date <= ?${locFilter}
     GROUP BY i.id, l.id HAVING SUM(it.qty_delta) != 0 ORDER BY i.sku, l.name`, params);
  for (const r of rows) r.avg_cost = r.qty_on_hand ? round(r.total_value / (r.qty_on_hand / 1_000_000)) : 0;
  return { as_of: asOf, rows, total_value: sum(rows, (r) => r.total_value), total_qty: sum(rows, (r) => r.qty_on_hand) };
}

/** Movement history for one item. */
export const itemHistory = (repo, itemId, { locationId = null, limit = 200 } = {}) =>
  repo.query(`SELECT it.*, l.name location_name FROM inventory_txn it
      JOIN location l ON l.tenant_id = it.tenant_id AND l.id = it.location_id
     WHERE it.tenant_id = :t AND it.item_id = ?${locationId ? ' AND it.location_id = ?' : ''}
     ORDER BY it.txn_date DESC, it.id DESC LIMIT ?`,
    locationId ? [itemId, locationId, limit] : [itemId, limit]);
