// Meridian ERP :: modules/lots
// Lot and serial tracking, layered on top of inventory.mjs's moving-average
// stock ledger. Costing does not change here -- a lot's own unit_cost is
// kept for reference (what it cost when it arrived), not used to value
// issues, which stay at the location's current average.
//
// Every receipt into, and issue out of, a lot- or serial-tracked item goes
// through receiveLine()/issueLine() rather than inv.moveStock() directly, so
// that inventory_lot and txn_line_lot (the per-line audit trail a trace
// report and a void both read) can never drift from what moveStock recorded.
import { ulid, nowIso, today, Qty, sum } from '../core/util.mjs';
import { ValidationError, unprocessable, notFound } from '../core/http.mjs';
import * as inv from './inventory.mjs';

export const isLotTracked = (item) => !!(item && (item.track_lots || item.is_serialised));
export const isSerialised = (item) => !!(item && item.is_serialised);

/** Normalise whatever a caller sent as lot instructions into a clean list. */
function normaliseEntries(entries, totalQty, { serialised }) {
  if (!entries || !entries.length) return null;
  const out = entries.map((e, i) => {
    const qty = e.quantity !== undefined ? Qty.parse(e.quantity) : (serialised ? Qty.parse(1) : null);
    if (qty === null) throw new ValidationError({ [`lots.${i}.quantity`]: 'Each lot line needs a quantity' });
    if (qty <= 0) throw new ValidationError({ [`lots.${i}.quantity`]: 'Lot quantity must be greater than zero' });
    if (serialised && qty !== Qty.parse(1)) {
      throw new ValidationError({ [`lots.${i}.quantity`]: 'A serialised item takes exactly one unit per serial number' });
    }
    if (!e.lot_number && !e.serial_no) throw new ValidationError({ [`lots.${i}.lot_number`]: 'A lot number or serial number is required' });
    if (serialised && !e.serial_no) throw new ValidationError({ [`lots.${i}.serial_no`]: 'A serial number is required' });
    return {
      lot_number: String(e.lot_number || e.serial_no || '').trim(),
      serial_no: String(e.serial_no || '').trim(),
      expiry_date: e.expiry_date || null,
      quantity: qty,
    };
  });
  const given = sum(out, (e) => e.quantity);
  if (given !== totalQty) {
    throw new ValidationError({ lots: `Lot quantities total ${Qty.format(given)}, but the line is for ${Qty.format(totalQty)}` });
  }
  if (serialised) {
    const seen = new Set();
    for (const e of out) {
      if (seen.has(e.serial_no)) throw new ValidationError({ lots: `Serial number ${e.serial_no} is listed twice` });
      seen.add(e.serial_no);
    }
  }
  return out;
}

// ------------------------------------------------------------- receiving
/**
 * Receive quantity into one or more lots at a location, moving stock for
 * each chunk through inv.moveStock so inventory_txn keeps one row per lot.
 * Falls back to a single auto-numbered lot when the caller names none --
 * every stocked unit of a tracked item must belong to SOME lot.
 *
 * Returns the same shape as inv.moveStock (aggregated across lots) so a
 * caller can treat a tracked and an untracked item identically.
 */
export function receiveLine(repo, {
  item, location_id, quantity, unit_cost, entries = null, type = 'receipt',
  source_type = '', source_id = null, txn_date = null, memo = '',
  source_line_id = null, autoLotPrefix = 'LOT',
}) {
  // `quantity` arrives already scaled (1e6) -- every caller into this
  // function reads it straight off a scaled column (txn_line.quantity,
  // work_order_line/work_order columns) or has already run it through
  // Qty.parse itself, the same convention inv.moveStock's own qty_delta
  // follows. Only the per-lot `entries[].quantity` below is natural-unit
  // API input and needs parsing.
  const qty = quantity;
  if (qty <= 0) return { value_delta: 0, unit_cost_used: 0, avg_cost: 0, qty_after: 0, skipped: 'zero_qty' };
  const serialised = isSerialised(item);
  const list = normaliseEntries(entries, qty, { serialised })
    || (serialised
      ? null // a serialised receipt with no serials given is refused below
      : [{ lot_number: `${autoLotPrefix}-${today().replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`, serial_no: '', expiry_date: null, quantity: qty }]);
  if (!list) throw new ValidationError({ lots: 'Serial numbers are required to receive a serialised item' });

  let valueDelta = 0, qtyAfter = 0, avgAfter = 0, unitCostUsed = unit_cost || 0;
  for (const e of list) {
    if (serialised) {
      const dupe = repo.queryOne(
        `SELECT id FROM inventory_lot WHERE tenant_id = :t AND item_id = ? AND serial_no = ? AND status != 'consumed'`,
        [item.id, e.serial_no]);
      if (dupe) throw unprocessable(`Serial number ${e.serial_no} is already in stock for ${item.sku}.`);
    }
    const r = inv.moveStock(repo, {
      item_id: item.id, location_id, qty_delta: e.quantity, unit_cost, type,
      source_type, source_id, txn_date, memo, item, lot_number: e.lot_number, serial_no: e.serial_no,
    });
    valueDelta += r.value_delta; qtyAfter = r.qty_after; avgAfter = r.avg_cost; unitCostUsed = r.unit_cost_used;

    const lot = upsertLot(repo, {
      item_id: item.id, location_id, lot_number: e.lot_number, serial_no: e.serial_no,
      quantity: e.quantity, unit_cost: r.unit_cost_used, expiry_date: e.expiry_date,
      received_at: txn_date || today(), source_txn_id: source_id,
    });
    if (source_line_id) {
      repo.insert('txn_line_lot', {
        id: ulid(), source_type, source_id, source_line_id, item_id: item.id, location_id, lot_id: lot.id,
        lot_number: e.lot_number, serial_no: e.serial_no, direction: 'receive',
        quantity: e.quantity, reversed: 0, created_at: nowIso(),
      });
    }
  }
  return { value_delta: valueDelta, unit_cost_used: unitCostUsed, avg_cost: avgAfter, qty_after: qtyAfter };
}

function upsertLot(repo, { item_id, location_id, lot_number, serial_no, quantity, unit_cost, expiry_date, received_at, source_txn_id }) {
  const existing = repo.queryOne(
    `SELECT * FROM inventory_lot WHERE tenant_id = :t AND item_id = ? AND location_id = ? AND lot_number = ? AND serial_no = ?`,
    [item_id, location_id, lot_number, serial_no]);
  if (existing) {
    const newQty = existing.quantity + quantity;
    const newCost = newQty > 0 ? Math.round((existing.unit_cost * existing.quantity + unit_cost * quantity) / newQty) : existing.unit_cost;
    repo.update('inventory_lot', existing.id, {
      quantity: newQty, unit_cost: newCost,
      expiry_date: expiry_date || existing.expiry_date,
      status: newQty > 0 ? (existing.status === 'consumed' ? 'available' : existing.status) : existing.status,
    });
    return repo.get('inventory_lot', existing.id);
  }
  const id = ulid();
  repo.insert('inventory_lot', {
    id, item_id, location_id, lot_number, serial_no, quantity, unit_cost,
    received_at, expiry_date, status: 'available', source_txn_id,
  });
  return repo.get('inventory_lot', id);
}

// ------------------------------------------------------------- issuing
/**
 * Consume quantity from one or more lots. Explicit entries are honoured
 * exactly (and refused if any names a lot that does not have that much
 * available); otherwise lots are drained first-expiry-first-out, oldest
 * (no expiry date) last, which is the safe default for anything perishable
 * and harmless for anything that is not.
 */
export function issueLine(repo, {
  item, location_id, quantity, entries = null, type = 'shipment',
  source_type = '', source_id = null, txn_date = null, memo = '',
  source_line_id = null, allow_negative = false,
}) {
  // See receiveLine's note: `quantity` is already scaled by every caller.
  const qty = quantity;
  if (qty <= 0) return { value_delta: 0, unit_cost_used: 0, avg_cost: 0, qty_after: 0, skipped: 'zero_qty' };
  const serialised = isSerialised(item);
  const explicit = normaliseEntries(entries, qty, { serialised });
  const plan = explicit || fefoPlan(repo, item.id, location_id, qty, allow_negative);

  let valueDelta = 0, qtyAfter = 0, avgAfter = 0, unitCostUsed = 0;
  for (const e of plan) {
    let lot = null;
    if (explicit) {
      lot = repo.queryOne(
        `SELECT * FROM inventory_lot WHERE tenant_id = :t AND item_id = ? AND location_id = ? AND lot_number = ? AND serial_no = ?`,
        [item.id, location_id, e.lot_number, e.serial_no]);
      if (!lot || lot.quantity < e.quantity) {
        throw unprocessable(`Only ${Qty.format(lot?.quantity || 0)} of ${item.sku} lot ${e.lot_number}${e.serial_no ? '/' + e.serial_no : ''} is available at this location.`);
      }
    } else {
      lot = e.lot; // fefoPlan already resolved the row
    }

    const r = inv.moveStock(repo, {
      item_id: item.id, location_id, qty_delta: -e.quantity, type,
      source_type, source_id, txn_date, memo, item, allow_negative,
      lot_number: e.lot_number, serial_no: e.serial_no,
    });
    valueDelta += r.value_delta; qtyAfter = r.qty_after; avgAfter = r.avg_cost; unitCostUsed = r.unit_cost_used;

    const remaining = lot.quantity - e.quantity;
    repo.update('inventory_lot', lot.id, {
      quantity: remaining,
      status: remaining <= 0 ? 'consumed' : lot.status,
    });
    if (source_line_id) {
      repo.insert('txn_line_lot', {
        id: ulid(), source_type, source_id, source_line_id, item_id: item.id, location_id, lot_id: lot.id,
        lot_number: e.lot_number, serial_no: e.serial_no, direction: 'issue',
        quantity: e.quantity, reversed: 0, created_at: nowIso(),
      });
    }
  }
  return { value_delta: valueDelta, unit_cost_used: unitCostUsed, avg_cost: avgAfter, qty_after: qtyAfter };
}

/** First-expiry-first-out allocation across the available lots at a location. */
function fefoPlan(repo, itemId, locationId, qty, allowNegative) {
  const lots = repo.query(
    `SELECT * FROM inventory_lot WHERE tenant_id = :t AND item_id = ? AND location_id = ?
       AND status = 'available' AND quantity > 0
     ORDER BY CASE WHEN expiry_date IS NULL OR expiry_date = '' THEN 1 ELSE 0 END, expiry_date, received_at`,
    [itemId, locationId]);
  const plan = [];
  let remaining = qty;
  for (const lot of lots) {
    if (remaining <= 0) break;
    const take = Math.min(lot.quantity, remaining);
    if (take <= 0) continue;
    plan.push({ lot, lot_number: lot.lot_number, serial_no: lot.serial_no, quantity: take });
    remaining -= take;
  }
  if (remaining > 0 && !allowNegative) {
    throw unprocessable(`Not enough tracked stock to issue: ${Qty.format(remaining)} short across its lots at this location.`);
  }
  // Nothing to allocate the shortfall against -- record it against a
  // synthetic "unknown lot" entry rather than losing the quantity silently.
  if (remaining > 0) plan.push({ lot: { id: null, quantity: remaining }, lot_number: '', serial_no: '', quantity: remaining });
  return plan;
}

// ------------------------------------------------------------- void
/**
 * Reverse every lot movement a document made: a receive gives its quantity
 * back to the lot (or removes it if the lot was created purely by this
 * receipt), an issue restores what was consumed. Runs inside the same
 * transaction as the rest of voidTxn. `sourceType`/`sourceId` are the same
 * pair the movement was recorded under (a txn TYPES key and its id, or
 * 'work_order' and a work order id).
 */
export function reverseForSource(repo, sourceType, sourceId) {
  const rows = repo.query(
    `SELECT * FROM txn_line_lot WHERE tenant_id = :t AND source_type = ? AND source_id = ? AND reversed = 0`,
    [sourceType, sourceId]);
  for (const r of rows) {
    if (!r.lot_id) { repo.update('txn_line_lot', r.id, { reversed: 1 }); continue; }
    const lot = repo.get('inventory_lot', r.lot_id);
    if (lot) {
      const delta = r.direction === 'receive' ? -r.quantity : r.quantity;
      const newQty = lot.quantity + delta;
      repo.update('inventory_lot', lot.id, {
        quantity: newQty,
        status: newQty > 0 ? (lot.status === 'consumed' ? 'available' : lot.status) : lot.status,
      });
    }
    repo.update('txn_line_lot', r.id, { reversed: 1 });
  }
  return rows.length;
}

// ------------------------------------------------------------- reads
export const lotsFor = (repo, itemId, { locationId = null, status = null } = {}) => repo.query(
  `SELECT l.*, i.sku, i.name AS item_name, i.uom, loc.name AS location_name, loc.code AS location_code
     FROM inventory_lot l
     JOIN item i ON i.tenant_id = l.tenant_id AND i.id = l.item_id
     LEFT JOIN location loc ON loc.tenant_id = l.tenant_id AND loc.id = l.location_id
    WHERE l.tenant_id = :t AND l.item_id = ?
      ${locationId ? 'AND l.location_id = ?' : ''}
      ${status ? 'AND l.status = ?' : ''}
    ORDER BY CASE WHEN l.expiry_date IS NULL OR l.expiry_date = '' THEN 1 ELSE 0 END, l.expiry_date, l.received_at`,
  [itemId, ...(locationId ? [locationId] : []), ...(status ? [status] : [])]);

export const expiringLots = (repo, { withinDays = 30, locationId = null } = {}) => {
  const cutoff = new Date(Date.now() + withinDays * 86400000).toISOString().slice(0, 10);
  return repo.query(
    `SELECT l.*, i.sku, i.name AS item_name, i.uom, loc.name AS location_name
       FROM inventory_lot l
       JOIN item i ON i.tenant_id = l.tenant_id AND i.id = l.item_id
       LEFT JOIN location loc ON loc.tenant_id = l.tenant_id AND loc.id = l.location_id
      WHERE l.tenant_id = :t AND l.quantity > 0 AND l.expiry_date IS NOT NULL AND l.expiry_date != ''
        AND l.expiry_date <= ? ${locationId ? 'AND l.location_id = ?' : ''}
      ORDER BY l.expiry_date`,
    locationId ? [cutoff, locationId] : [cutoff]);
};

export function getLot(repo, id) {
  const l = repo.get('inventory_lot', id);
  if (!l) throw notFound('Lot not found');
  return { ...l, item: repo.get('item', l.item_id), location: l.location_id ? repo.get('location', l.location_id) : null };
}

/**
 * Every movement a lot has been through, from receipt to consumption.
 * source_type/source_id point at whichever document made the movement --
 * usually a `txn` row, occasionally a `work_order` -- so the label is
 * resolved per row rather than assumed to be one table.
 */
export function trace(repo, lotId) {
  const lot = getLot(repo, lotId);
  const rows = repo.query(
    `SELECT * FROM txn_line_lot WHERE tenant_id = :t AND lot_id = ? ORDER BY created_at`, [lotId]);
  const movements = rows.map((r) => {
    let doc = repo.queryOne('SELECT txn_no AS ref, type AS kind, txn_date AS date, status FROM txn WHERE tenant_id = :t AND id = ?', [r.source_id]);
    if (!doc) {
      const wo = repo.queryOne('SELECT order_no AS ref, status, created_at AS date FROM work_order WHERE tenant_id = :t AND id = ?', [r.source_id]);
      doc = wo ? { ...wo, kind: 'WORK_ORDER' } : { ref: r.source_id, kind: r.source_type, date: null, status: null };
    }
    return { ...r, document: doc };
  });
  return { lot, movements };
}
