// Meridian ERP :: modules/planning
// Demand forecasting and supply planning.
//
// The forecast and the plan are kept apart on purpose. A forecast says what
// we think demand will be; the plan says what to do about it given what is
// already on hand and on order. Storing both as snapshots means a buyer can
// see why last week's suggestion looked the way it did, which is the first
// thing anyone asks when a suggestion turns out wrong.
import { ulid, Qty, Money, nowIso, today, addDays, round, sum } from '../core/util.mjs';
import { ValidationError, notFound, unprocessable } from '../core/http.mjs';
import * as inv from './inventory.mjs';
import * as txnMod from './txn.mjs';
import * as audit from '../core/audit.mjs';

export const METHODS = ['moving_average', 'linear_trend', 'seasonal', 'manual'];

const startOfWeek = (iso) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));   // Monday
  return d.toISOString().slice(0, 10);
};
const bucketStart = (iso, bucket) => (bucket === 'month' ? iso.slice(0, 8) + '01' : startOfWeek(iso));
const nextBucket = (iso, bucket) => {
  const d = new Date(iso + 'T00:00:00Z');
  if (bucket === 'month') { d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(1); }
  else d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
};

/** Historic shipped quantity per item per bucket. */
function demandHistory(repo, { lookbackDays, bucket, locationId }) {
  const from = addDays(today(), -lookbackDays);
  const rows = repo.query(
    `SELECT tl.item_id, t.txn_date, SUM(tl.quantity) AS qty
     FROM txn_line tl JOIN txn t ON t.tenant_id = tl.tenant_id AND t.id = tl.txn_id
     WHERE tl.tenant_id = :t AND t.type = 'FULFILLMENT' AND t.status != 'voided' AND t.txn_date >= ?
       ${locationId ? 'AND t.location_id = ?' : ''}
     GROUP BY tl.item_id, t.txn_date`,
    locationId ? [from, locationId] : [from]);

  const byItem = new Map();
  for (const r of rows) {
    const key = r.item_id;
    if (!byItem.has(key)) byItem.set(key, new Map());
    const b = bucketStart(r.txn_date, bucket);
    const m = byItem.get(key);
    m.set(b, (m.get(b) || 0) + (r.qty || 0));
  }
  return byItem;
}

/** Least-squares slope and intercept over evenly spaced points. */
function linearFit(values) {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: values[0] || 0 };
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - meanX) * (values[i] - meanY); den += (i - meanX) ** 2; }
  const slope = den ? num / den : 0;
  return { slope, intercept: meanY - slope * meanX };
}

export function createPlan(repo, input) {
  if (!input.name) throw new ValidationError({ name: 'Name is required' });
  if (input.method && !METHODS.includes(input.method)) {
    throw new ValidationError({ method: `Method must be one of ${METHODS.join(', ')}` });
  }
  const now = nowIso();
  const id = ulid();
  repo.insert('demand_plan', {
    id, name: input.name, location_id: input.location_id || null,
    horizon_days: Number(input.horizon_days || 90),
    bucket: input.bucket === 'month' ? 'month' : 'week',
    method: input.method || 'moving_average',
    lookback_days: Number(input.lookback_days || 365),
    status: 'draft', created_at: now, updated_at: now,
  });
  return repo.get('demand_plan', id);
}

/**
 * Generate the forecast lines for a plan.
 * Seasonal uses the same bucket one year back scaled by the year-on-year
 * trend, which is crude but honest -- and vastly better than a flat average
 * for anything with a Christmas.
 */
export function runForecast(repo, planId) {
  const plan = repo.get('demand_plan', planId);
  if (!plan) throw notFound(`Plan ${planId} not found`);

  const history = demandHistory(repo, {
    lookbackDays: plan.lookback_days, bucket: plan.bucket, locationId: plan.location_id,
  });
  const buckets = [];
  let cursor = bucketStart(today(), plan.bucket);
  const end = addDays(today(), plan.horizon_days);
  while (cursor <= end) { buckets.push(cursor); cursor = nextBucket(cursor, plan.bucket); }

  repo.exec('DELETE FROM demand_plan_line WHERE tenant_id = :t AND plan_id = ?', [planId]);
  let written = 0;
  for (const [itemId, series] of history) {
    const keys = [...series.keys()].sort();
    if (!keys.length) continue;
    const values = keys.map((k) => series.get(k));
    const fit = linearFit(values);
    const average = values.reduce((a, b) => a + b, 0) / values.length;

    buckets.forEach((b, i) => {
      let forecast;
      switch (plan.method) {
        case 'linear_trend':
          forecast = fit.intercept + fit.slope * (values.length + i);
          break;
        case 'seasonal': {
          const yearAgo = plan.bucket === 'month'
            ? `${Number(b.slice(0, 4)) - 1}${b.slice(4)}`
            : addDays(b, -364);
          const base = series.get(bucketStart(yearAgo, plan.bucket));
          const recent = values.slice(-4).reduce((a, v) => a + v, 0) / Math.min(4, values.length);
          const older = values.slice(0, 4).reduce((a, v) => a + v, 0) / Math.min(4, values.length);
          const yoy = older > 0 ? recent / older : 1;
          forecast = base !== undefined ? base * yoy : average;
          break;
        }
        case 'manual':
          forecast = 0;
          break;
        case 'moving_average':
        default: {
          const window = values.slice(-6);
          forecast = window.reduce((a, v) => a + v, 0) / window.length;
        }
      }
      repo.insert('demand_plan_line', {
        id: ulid(), plan_id: planId, item_id: itemId, bucket_start: b,
        forecast_qty: Math.max(0, round(forecast)), actual_qty: series.get(b) || 0, override_qty: null,
      });
      written++;
    });
  }
  repo.update('demand_plan', planId, { updated_at: nowIso() });
  return { plan_id: planId, method: plan.method, items: history.size, buckets: buckets.length, lines: written };
}

export const planLines = (repo, planId, { itemId = null } = {}) =>
  repo.query(`SELECT dl.*, i.sku, i.name, i.uom FROM demand_plan_line dl
              JOIN item i ON i.tenant_id = dl.tenant_id AND i.id = dl.item_id
              WHERE dl.tenant_id = :t AND dl.plan_id = ? ${itemId ? 'AND dl.item_id = ?' : ''}
              ORDER BY i.sku, dl.bucket_start`,
    itemId ? [planId, itemId] : [planId]);

export function overrideLine(repo, lineId, quantity) {
  const line = repo.get('demand_plan_line', lineId);
  if (!line) throw notFound(`Plan line ${lineId} not found`);
  repo.update('demand_plan_line', lineId, { override_qty: quantity === null ? null : Qty.parse(quantity) });
  return repo.get('demand_plan_line', lineId);
}

/**
 * Net requirements: for each item, walk forward through the horizon applying
 * forecast demand and expected receipts, and raise a suggestion the moment
 * projected stock would fall below the reorder point.
 *
 * The suggestion carries `order_by` -- the date the order has to be placed
 * given the vendor's lead time -- because "you need 40 by March" is useless
 * to a buyer who needed to place it in January.
 */
export function runSupplyPlan(repo, { plan_id = null, location_id = null, horizon_days = 90 } = {}) {
  const runId = ulid();
  const items = repo.query(
    `SELECT DISTINCT i.* FROM item i
     WHERE i.tenant_id = :t AND i.active = 1 AND i.type IN ('inventory','assembly')`);
  const forecast = plan_id
    ? repo.query('SELECT * FROM demand_plan_line WHERE tenant_id = :t AND plan_id = ? ORDER BY bucket_start', [plan_id])
    : [];
  const forecastByItem = new Map();
  for (const f of forecast) {
    if (!forecastByItem.has(f.item_id)) forecastByItem.set(f.item_id, []);
    forecastByItem.get(f.item_id).push(f);
  }

  const horizonEnd = addDays(today(), horizon_days);
  const suggestions = [];
  for (const item of items) {
    const locations = location_id
      ? [{ location_id }]
      : repo.query('SELECT location_id FROM item_location WHERE tenant_id = :t AND item_id = ?', [item.id]);
    for (const loc of locations) {
      const pos = inv.position(repo, item.id, loc.location_id);
      const onHand = pos.qty_on_hand || 0;
      const onOrder = pos.qty_on_order || 0;
      const committed = pos.qty_committed || 0;
      const reorderPoint = pos.reorder_point || item.reorder_point || 0;

      // Demand is the forecast if there is one, else what is already committed.
      const demand = (forecastByItem.get(item.id) || [])
        .filter((f) => f.bucket_start <= horizonEnd)
        .reduce((a, f) => a + (f.override_qty ?? f.forecast_qty), 0) || committed;

      const projected = onHand + onOrder - demand;
      if (projected >= reorderPoint) continue;

      // Order back up to the preferred stock level where one is set. Buying
      // only the shortfall tops the item up to the point that triggered the
      // order, so the next sale trips it again and the buyer raises the same
      // purchase order every week.
      const target = pos.preferred_stock_level || 0;
      const raw = target > reorderPoint ? target - projected : reorderPoint - projected;
      // Round up to whole units -- nobody orders 12.82 routers.
      const quantity = Math.ceil(raw / 1_000_000) * 1_000_000;
      if (quantity <= 0) continue;

      const leadDays = item.lead_time_days || 14;
      const hasBom = !!repo.queryOne(
        "SELECT id FROM bom WHERE tenant_id = :t AND item_id = ? AND status = 'released' LIMIT 1", [item.id]);
      const requiredBy = addDays(today(), Math.min(horizon_days, leadDays));

      const id = ulid();
      repo.insert('supply_suggestion', {
        id, run_id: runId, item_id: item.id, location_id: loc.location_id,
        suggestion: hasBom ? 'manufacture' : 'purchase',
        required_by: requiredBy, order_by: addDays(requiredBy, -leadDays),
        quantity, on_hand: onHand, on_order: onOrder, committed,
        reorder_point: reorderPoint,
        vendor_id: item.preferred_vendor_id || null,
        reason: demand > 0
          ? `Projected ${Qty.format(projected)} against a reorder point of ${Qty.format(reorderPoint)}`
          : 'Below reorder point',
        status: 'open', created_txn_id: null, created_at: nowIso(),
      });
      suggestions.push(id);
    }
  }
  return {
    run_id: runId, suggestions: suggestions.length,
    lines: repo.query('SELECT * FROM supply_suggestion WHERE tenant_id = :t AND run_id = ? ORDER BY order_by', [runId]),
  };
}

export const suggestionsFor = (repo, { run_id = null, status = 'open' } = {}) =>
  repo.query(`SELECT ss.*, i.sku, i.name, i.uom, v.name AS vendor_name
              FROM supply_suggestion ss
              JOIN item i ON i.tenant_id = ss.tenant_id AND i.id = ss.item_id
              LEFT JOIN vendor v ON v.tenant_id = ss.tenant_id AND v.id = ss.vendor_id
              WHERE ss.tenant_id = :t ${run_id ? 'AND ss.run_id = ?' : ''} ${status ? 'AND ss.status = ?' : ''}
              ORDER BY ss.order_by, i.sku`,
    [...(run_id ? [run_id] : []), ...(status ? [status] : [])]);

/**
 * Turn open purchase suggestions into purchase orders, one per vendor.
 * Grouping by vendor is the difference between a useful action and forty
 * single-line orders.
 */
export function actionSuggestions(repo, ids, { txn_date = today() } = {}) {
  if (!ids?.length) throw new ValidationError({ ids: 'Select at least one suggestion' });
  const rows = repo.query(
    `SELECT * FROM supply_suggestion WHERE tenant_id = :t AND id IN (${ids.map(() => '?').join(',')}) AND status = 'open'`, ids);
  if (!rows.length) throw unprocessable('None of those suggestions are still open');

  const purchases = rows.filter((r) => r.suggestion === 'purchase');
  const missingVendor = purchases.filter((r) => !r.vendor_id);
  if (missingVendor.length) {
    throw unprocessable(`${missingVendor.length} item${missingVendor.length === 1 ? ' has' : 's have'} no preferred vendor, so no purchase order can be raised for them.`);
  }

  return repo.tx(() => {
    const byVendor = new Map();
    for (const r of purchases) {
      if (!byVendor.has(r.vendor_id)) byVendor.set(r.vendor_id, []);
      byVendor.get(r.vendor_id).push(r);
    }
    const created = [];
    for (const [vendorId, group] of byVendor) {
      const po = txnMod.createTxn(repo, 'PURCHASE_ORDER', {
        entity_id: vendorId, txn_date,
        location_id: group[0].location_id,
        memo: 'Raised from supply plan',
        lines: group.map((g) => ({
          item_id: g.item_id, quantity: Qty.toNumber(g.quantity),
          rate: Money.toNumber(repo.get('item', g.item_id)?.purchase_price || 0),
        })),
      });
      for (const g of group) repo.update('supply_suggestion', g.id, { status: 'actioned', created_txn_id: po.id });
      created.push({ vendor_id: vendorId, txn_no: po.txn_no, id: po.id, lines: group.length });
    }
    const builds = rows.filter((r) => r.suggestion === 'manufacture');
    for (const b of builds) repo.update('supply_suggestion', b.id, { status: 'actioned' });
    audit.record(repo, { recordType: 'supply_suggestion', recordId: rows[0].run_id, action: 'action', changes: { count: { from: 0, to: rows.length } } });
    return { purchase_orders: created, manufacture_flagged: builds.length };
  });
}

export function dismissSuggestions(repo, ids) {
  for (const id of ids || []) repo.update('supply_suggestion', id, { status: 'dismissed' });
  return { dismissed: (ids || []).length };
}
