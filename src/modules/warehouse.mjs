// Meridian ERP :: modules/warehouse
// Bins, waves, picking, packing, shipping and put-away.
//
// item_location remains the costing and availability record. Bins are a
// second, finer layer that says where in the building the stock is, and
// the two are reconciled by report rather than by trusting one to keep the
// other honest. A pick moves stock between bins; only the fulfilment that
// the wave produces moves stock out of the location and touches valuation.
import { ulid, Qty, Money, nowIso, today, sum } from '../core/util.mjs';
import { ValidationError, notFound, unprocessable } from '../core/http.mjs';
import { nextNumber } from '../core/seq.mjs';
import * as inv from './inventory.mjs';
import * as txnMod from './txn.mjs';
import * as audit from '../core/audit.mjs';

export const BIN_TYPES = ['receiving', 'storage', 'picking', 'staging', 'shipping', 'quarantine'];
export const WAVE_STATUSES = ['open', 'picking', 'picked', 'packed', 'shipped', 'cancelled'];

// -------------------------------------------------------------------- bins
export function createBin(repo, input) {
  const errors = {};
  if (!input.location_id) errors.location_id = 'Location is required';
  if (!input.code) errors.code = 'Bin code is required';
  if (input.bin_type && !BIN_TYPES.includes(input.bin_type)) errors.bin_type = `Type must be one of ${BIN_TYPES.join(', ')}`;
  if (Object.keys(errors).length) throw new ValidationError(errors);
  if (repo.queryOne('SELECT id FROM bin WHERE tenant_id = :t AND location_id = ? AND code = ?', [input.location_id, input.code])) {
    throw new ValidationError({ code: `Bin ${input.code} already exists at this location` });
  }
  const id = ulid();
  return repo.tx(() => {
    repo.insert('bin', {
      id, location_id: input.location_id, code: input.code,
      zone: input.zone || '', bin_type: input.bin_type || 'storage',
      pick_sequence: Number(input.pick_sequence || 0),
      capacity: Qty.parse(input.capacity || 0),
      active: input.active === false ? 0 : 1, created_at: nowIso(),
    });
    // Racking a location is the decision to run it on bins; nobody should have
    // to find a separate checkbox afterwards to make put-away and bin counts
    // work, so the first bin turns the location over.
    repo.update('location', input.location_id, { uses_bins: 1 });
    return repo.get('bin', id);
  });
}

export const binsFor = (repo, locationId) =>
  repo.query('SELECT * FROM bin WHERE tenant_id = :t AND location_id = ? AND active = 1 ORDER BY pick_sequence, code', [locationId]);

export const binContents = (repo, binId) =>
  repo.query(`SELECT bq.*, i.sku, i.name, i.uom FROM bin_quantity bq
              JOIN item i ON i.tenant_id = bq.tenant_id AND i.id = bq.item_id
              WHERE bq.tenant_id = :t AND bq.bin_id = ? AND bq.quantity != 0
              ORDER BY i.sku`, [binId]);

/** Where a given item physically sits, picking bins first. */
export const binsHolding = (repo, itemId, locationId = null) =>
  repo.query(`SELECT bq.*, b.code, b.zone, b.bin_type, b.pick_sequence, b.location_id
              FROM bin_quantity bq JOIN bin b ON b.tenant_id = bq.tenant_id AND b.id = bq.bin_id
              WHERE bq.tenant_id = :t AND bq.item_id = ? AND bq.quantity > 0
                ${locationId ? 'AND b.location_id = ?' : ''}
              ORDER BY CASE b.bin_type WHEN 'picking' THEN 0 ELSE 1 END, b.pick_sequence, b.code`,
    locationId ? [itemId, locationId] : [itemId]);

/**
 * Move stock between bins. This never changes the location's on-hand or its
 * valuation -- it is a physical move inside one four walls.
 */
export function moveBin(repo, { item_id, from_bin_id = null, to_bin_id = null, quantity, lot_number = '', serial_no = '' }) {
  const qty = Qty.parse(quantity);
  if (qty <= 0) throw new ValidationError({ quantity: 'Quantity must be greater than zero' });
  if (!from_bin_id && !to_bin_id) throw new ValidationError({ to_bin_id: 'A source or destination bin is required' });

  const adjust = (binId, delta) => {
    if (!binId) return;
    const row = repo.queryOne(
      'SELECT * FROM bin_quantity WHERE tenant_id = :t AND bin_id = ? AND item_id = ? AND lot_number = ? AND serial_no = ?',
      [binId, item_id, lot_number, serial_no]);
    if (!row) {
      if (delta < 0) throw unprocessable('That bin holds none of this item');
      repo.exec(
        `INSERT INTO bin_quantity (tenant_id, bin_id, item_id, lot_number, serial_no, quantity, allocated)
         VALUES (:t, ?, ?, ?, ?, ?, 0)`, [binId, item_id, lot_number, serial_no, delta]);
      return;
    }
    if (row.quantity + delta < 0) {
      const bin = repo.get('bin', binId);
      throw unprocessable(`Bin ${bin?.code || binId} holds ${Qty.format(row.quantity)}; cannot remove ${Qty.format(-delta)}`);
    }
    repo.exec(
      `UPDATE bin_quantity SET quantity = quantity + ?
       WHERE tenant_id = :t AND bin_id = ? AND item_id = ? AND lot_number = ? AND serial_no = ?`,
      [delta, binId, item_id, lot_number, serial_no]);
  };

  return repo.tx(() => {
    adjust(from_bin_id, -qty);
    adjust(to_bin_id, qty);
    return { item_id, quantity: Qty.toNumber(qty), from_bin_id, to_bin_id };
  });
}

/** Does the bin layer agree with item_location? Anything listed needs a count. */
export function reconcileBins(repo, locationId) {
  const rows = repo.query(
    `SELECT il.item_id, i.sku, i.name, il.qty_on_hand,
            COALESCE((SELECT SUM(bq.quantity) FROM bin_quantity bq
                        JOIN bin b ON b.tenant_id = bq.tenant_id AND b.id = bq.bin_id
                       WHERE bq.tenant_id = il.tenant_id AND bq.item_id = il.item_id AND b.location_id = il.location_id), 0) AS binned
     FROM item_location il JOIN item i ON i.tenant_id = il.tenant_id AND i.id = il.item_id
     WHERE il.tenant_id = :t AND il.location_id = ? AND (il.qty_on_hand != 0)`, [locationId]);
  const discrepancies = rows
    .filter((r) => r.qty_on_hand !== r.binned)
    .map((r) => ({
      item_id: r.item_id, sku: r.sku, name: r.name,
      on_hand: Qty.toNumber(r.qty_on_hand), in_bins: Qty.toNumber(r.binned),
      difference: Qty.toNumber(r.qty_on_hand - r.binned),
    }));
  return { location_id: locationId, checked: rows.length, discrepancies, clean: discrepancies.length === 0 };
}

// ------------------------------------------------------------- put-away
export function generatePutaway(repo, receiptTxnId) {
  const receipt = repo.get('txn', receiptTxnId);
  if (!receipt) throw notFound(`Transaction ${receiptTxnId} not found`);
  const location = repo.get('location', receipt.location_id);
  if (!location?.uses_bins) throw unprocessable('That location does not use bins');

  const lines = repo.query('SELECT * FROM txn_line WHERE tenant_id = :t AND txn_id = ? ORDER BY line_no', [receiptTxnId]);
  const itemIds = [...new Set(lines.map((l) => l.item_id).filter(Boolean))];
  const itemMap = new Map(repo.find('item', { where: { id: itemIds } }).map((i) => [i.id, i]));

  const fallback = repo.queryOne(
    "SELECT * FROM bin WHERE tenant_id = :t AND location_id = ? AND bin_type = 'storage' AND active = 1 ORDER BY pick_sequence LIMIT 1",
    [receipt.location_id]);

  const allBins = itemIds.length
    ? repo.query(`SELECT bq.*, b.code, b.zone, b.bin_type, b.pick_sequence, b.location_id
      FROM bin_quantity bq JOIN bin b ON b.tenant_id = bq.tenant_id AND b.id = bq.bin_id
      WHERE bq.tenant_id = :t AND bq.item_id IN (${itemIds.map(() => '?').join(',')}) AND bq.quantity > 0
        AND b.location_id = ?
      ORDER BY CASE b.bin_type WHEN 'picking' THEN 0 ELSE 1 END, b.pick_sequence, b.code`,
      [...itemIds, receipt.location_id])
    : [];
  const binMap = new Map();
  for (const b of allBins) {
    if (!binMap.has(b.item_id)) binMap.set(b.item_id, []);
    binMap.get(b.item_id).push(b);
  }

  return repo.tx(() => {
    const created = [];
    for (const l of lines) {
      if (!l.item_id || !l.quantity) continue;
      const item = itemMap.get(l.item_id);
      if (!item || !inv.isStocked(item)) continue;
      // Put stock where the same item already lives, else the first storage bin.
      const existing = binMap.get(l.item_id)?.[0];
      const id = ulid();
      repo.insert('putaway_task', {
        id, receipt_txn_id: receiptTxnId, item_id: l.item_id,
        from_bin_id: location.default_receiving_bin_id || null,
        to_bin_id: existing?.bin_id || fallback?.id || null,
        quantity: l.quantity, lot_number: '', status: 'pending',
        completed_by: null, completed_at: null, created_at: nowIso(),
      });
      created.push(id);
    }
    return { receipt: receipt.txn_no, tasks: created.length };
  });
}

export function completePutaway(repo, taskId, { to_bin_id = null, quantity = null, by = null } = {}) {
  const task = repo.get('putaway_task', taskId);
  if (!task) throw notFound(`Put-away task ${taskId} not found`);
  if (task.status !== 'pending') throw unprocessable('That put-away task is already complete');
  const bin = to_bin_id || task.to_bin_id;
  if (!bin) throw new ValidationError({ to_bin_id: 'A destination bin is required' });
  const qty = quantity === null ? task.quantity : Qty.parse(quantity);

  return repo.tx(() => {
    moveBin(repo, { item_id: task.item_id, from_bin_id: task.from_bin_id, to_bin_id: bin, quantity: Qty.toNumber(qty), lot_number: task.lot_number });
    repo.update('putaway_task', taskId, { status: 'complete', to_bin_id: bin, completed_by: by, completed_at: nowIso() });
    return repo.get('putaway_task', taskId);
  });
}

// ----------------------------------------------------------------- waves
export const getWave = (repo, id) => {
  const w = repo.get('pick_wave', id);
  if (!w) throw notFound(`Wave ${id} not found`);
  return w;
};
export const waveTasks = (repo, waveId) =>
  repo.query(`SELECT pt.*, i.sku, i.name AS item_name, b.code AS bin_code, b.zone, t.txn_no
              FROM pick_task pt
              JOIN item i ON i.tenant_id = pt.tenant_id AND i.id = pt.item_id
              LEFT JOIN bin b ON b.tenant_id = pt.tenant_id AND b.id = pt.bin_id
              LEFT JOIN txn t ON t.tenant_id = pt.tenant_id AND t.id = pt.txn_id
              WHERE pt.tenant_id = :t AND pt.wave_id = ?
              ORDER BY pt.pick_sequence, b.code`, [waveId]);

/**
 * Build a wave from open sales orders. Tasks come out sorted by bin walk
 * order, which is the entire point: one pass through the warehouse instead
 * of one pass per order.
 */
export function createWave(repo, { location_id, txn_ids = [], strategy = 'batch', assigned_to = null, limit = 50 }) {
  if (!location_id) throw new ValidationError({ location_id: 'Location is required' });
  const orders = txn_ids.length
    ? repo.query(`SELECT * FROM txn WHERE tenant_id = :t AND id IN (${txn_ids.map(() => '?').join(',')})`, txn_ids)
    : repo.query(
      `SELECT * FROM txn WHERE tenant_id = :t AND type = 'SALES_ORDER'
         AND status IN ('open','partially_fulfilled') AND location_id = ?
       ORDER BY txn_date LIMIT ?`, [location_id, limit]);
  if (!orders.length) throw unprocessable('No open sales orders to pick at that location');

  const id = ulid();

  const orderIds = orders.map((o) => o.id);
  const allLines = repo.query(`SELECT * FROM txn_line WHERE tenant_id = :t AND txn_id IN (${orderIds.map(() => '?').join(',')}) ORDER BY txn_id, line_no`, orderIds);
  const linesByOrder = new Map();
  for (const l of allLines) {
    if (!linesByOrder.has(l.txn_id)) linesByOrder.set(l.txn_id, []);
    linesByOrder.get(l.txn_id).push(l);
  }

  const itemIds = [...new Set(allLines.map((l) => l.item_id).filter(Boolean))];
  const itemMap = new Map(repo.find('item', { where: { id: itemIds } }).map((i) => [i.id, i]));

  const allBins = itemIds.length
    ? repo.query(`SELECT bq.*, b.code, b.zone, b.bin_type, b.pick_sequence, b.location_id
      FROM bin_quantity bq JOIN bin b ON b.tenant_id = bq.tenant_id AND b.id = bq.bin_id
      WHERE bq.tenant_id = :t AND bq.item_id IN (${itemIds.map(() => '?').join(',')}) AND bq.quantity > 0
        AND b.location_id = ?
      ORDER BY CASE b.bin_type WHEN 'picking' THEN 0 ELSE 1 END, b.pick_sequence, b.code`,
      [...itemIds, location_id])
    : [];
  const binMap = new Map();
  for (const b of allBins) {
    if (!binMap.has(b.item_id)) binMap.set(b.item_id, []);
    binMap.get(b.item_id).push(b);
  }

  return repo.tx(() => {
    repo.insert('pick_wave', {
      id, wave_no: nextNumber(repo, 'pick_wave'), location_id,
      status: 'open', strategy, assigned_to,
      order_count: orders.length, line_count: 0,
      released_at: null, completed_at: null, created_at: nowIso(),
    });

    let lineCount = 0;
    for (const order of orders) {
      const lines = linesByOrder.get(order.id) || [];
      for (const l of lines) {
        if (!l.item_id) continue;
        const item = itemMap.get(l.item_id);
        if (!item || !inv.isStocked(item)) continue;
        let outstanding = Math.max(0, (l.quantity || 0) - (l.qty_fulfilled || 0));
        if (outstanding <= 0) continue;

        // Split the pick across bins, nearest first, so the picker is told
        // exactly where to go rather than "somewhere in the warehouse".
        const sources = binMap.get(l.item_id) || [];
        if (!sources.length) {
          repo.insert('pick_task', {
            id: ulid(), wave_id: id, txn_id: order.id, txn_line_id: l.id,
            item_id: l.item_id, bin_id: null, lot_number: '',
            quantity: outstanding, quantity_picked: 0, pick_sequence: 999999,
            status: 'pending', picked_by: null, picked_at: null,
          });
          lineCount++;
          continue;
        }
        for (const src of sources) {
          if (outstanding <= 0) break;
          const free = Math.max(0, src.quantity - src.allocated);
          if (free <= 0) continue;
          const take = Math.min(free, outstanding);
          repo.insert('pick_task', {
            id: ulid(), wave_id: id, txn_id: order.id, txn_line_id: l.id,
            item_id: l.item_id, bin_id: src.bin_id, lot_number: src.lot_number || '',
            quantity: take, quantity_picked: 0, pick_sequence: src.pick_sequence || 0,
            status: 'pending', picked_by: null, picked_at: null,
          });
          repo.exec(
            `UPDATE bin_quantity SET allocated = allocated + ?
             WHERE tenant_id = :t AND bin_id = ? AND item_id = ? AND lot_number = ? AND serial_no = ?`,
            [take, src.bin_id, l.item_id, src.lot_number || '', src.serial_no || '']);
          // The batched snapshot is read once above; without this, a second
          // line in the same wave that draws on the same bin would see its
          // capacity as still free and over-allocate it.
          src.allocated += take;
          outstanding -= take;
          lineCount++;
        }
      }
    }
    repo.update('pick_wave', id, { line_count: lineCount });
    audit.record(repo, { recordType: 'pick_wave', recordId: id, action: 'create' });
    return { ...getWave(repo, id), tasks: waveTasks(repo, id) };
  });
}

export function releaseWave(repo, id) {
  const wave = getWave(repo, id);
  if (wave.status !== 'open') throw unprocessable(`Wave ${wave.wave_no} is already ${wave.status}`);
  repo.update('pick_wave', id, { status: 'picking', released_at: nowIso() });
  return getWave(repo, id);
}

/** Confirm a pick. A short pick is recorded as short rather than silently reduced. */
export function confirmPick(repo, taskId, { quantity = null, by = null } = {}) {
  const task = repo.get('pick_task', taskId);
  if (!task) throw notFound(`Pick task ${taskId} not found`);
  if (task.status !== 'pending') throw unprocessable('That pick is already confirmed');
  const picked = quantity === null ? task.quantity : Qty.parse(quantity);
  if (picked < 0) throw new ValidationError({ quantity: 'Quantity cannot be negative' });
  if (picked > task.quantity) throw new ValidationError({ quantity: 'Cannot pick more than the task calls for' });

  return repo.tx(() => {
    const wave = getWave(repo, task.wave_id);
    if (task.bin_id) {
      const staging = repo.queryOne(
        "SELECT id FROM bin WHERE tenant_id = :t AND location_id = ? AND bin_type = 'staging' AND active = 1 ORDER BY pick_sequence LIMIT 1",
        [wave.location_id]);
      if (picked > 0) {
        moveBin(repo, {
          item_id: task.item_id, from_bin_id: task.bin_id,
          to_bin_id: staging?.id || null, quantity: Qty.toNumber(picked), lot_number: task.lot_number,
        });
      }
      repo.exec(
        `UPDATE bin_quantity SET allocated = MAX(0, allocated - ?)
         WHERE tenant_id = :t AND bin_id = ? AND item_id = ? AND lot_number = ?`,
        [task.quantity, task.bin_id, task.item_id, task.lot_number]);
    }
    repo.update('pick_task', taskId, {
      quantity_picked: picked,
      status: picked >= task.quantity ? 'picked' : 'short',
      picked_by: by, picked_at: nowIso(),
    });
    const outstanding = repo.queryOne(
      "SELECT COUNT(*) AS c FROM pick_task WHERE tenant_id = :t AND wave_id = ? AND status = 'pending'", [task.wave_id]);
    if (!outstanding.c) repo.update('pick_wave', task.wave_id, { status: 'picked' });
    return repo.get('pick_task', taskId);
  });
}

// ------------------------------------------------------------- packing
export function packWave(repo, waveId, { packages = [] } = {}) {
  const wave = getWave(repo, waveId);
  if (!['picked', 'picking'].includes(wave.status)) {
    throw unprocessable(`Wave ${wave.wave_no} is ${wave.status}; it must be picked before packing`);
  }
  const picked = repo.query(
    "SELECT * FROM pick_task WHERE tenant_id = :t AND wave_id = ? AND quantity_picked > 0", [waveId]);
  if (!picked.length) throw unprocessable('Nothing has been picked on this wave');

  // Default to one package per order, which is what actually happens unless
  // the packer says otherwise.
  const specs = packages.length ? packages : [...new Set(picked.map((p) => p.txn_id))].map((txn_id) => ({ txn_id }));
  return repo.tx(() => {
    const created = [];
    for (const spec of specs) {
      const contents = picked
        .filter((p) => !spec.txn_id || p.txn_id === spec.txn_id)
        .map((p) => ({ item_id: p.item_id, quantity: Qty.toNumber(p.quantity_picked), lot: p.lot_number || null }));
      const id = ulid();
      repo.insert('package', {
        id, wave_id: waveId, txn_id: spec.txn_id || null,
        package_no: `${wave.wave_no}-${created.length + 1}`,
        carrier: spec.carrier || '', service: spec.service || '', tracking_no: spec.tracking_no || '',
        weight: Qty.parse(spec.weight || 0), length: Qty.parse(spec.length || 0),
        width: Qty.parse(spec.width || 0), height: Qty.parse(spec.height || 0),
        freight_cost: Money.parse(spec.freight_cost), shipped_at: null,
        status: 'packed', contents, created_at: nowIso(),
      });
      created.push(id);
    }
    repo.update('pick_wave', waveId, { status: 'packed' });
    return { wave: getWave(repo, waveId), packages: created.length };
  });
}

/**
 * Ship the wave: turn each picked order into a fulfilment, which is where
 * stock actually leaves the location and the GL is touched.
 */
export function shipWave(repo, waveId, { txn_date = today(), carrier = '', tracking_no = '' } = {}) {
  const wave = getWave(repo, waveId);
  if (!['packed', 'picked'].includes(wave.status)) {
    throw unprocessable(`Wave ${wave.wave_no} is ${wave.status}; pick and pack it before shipping`);
  }
  const orderIds = [...new Set(repo.query(
    'SELECT DISTINCT txn_id FROM pick_task WHERE tenant_id = :t AND wave_id = ? AND quantity_picked > 0', [waveId])
    .map((r) => r.txn_id))];

  return repo.tx(() => {
    const fulfilments = [];
    for (const orderId of orderIds) {
      const tasks = repo.query(
        'SELECT * FROM pick_task WHERE tenant_id = :t AND wave_id = ? AND txn_id = ? AND quantity_picked > 0', [waveId, orderId]);
      const byLine = new Map();
      for (const t of tasks) byLine.set(t.txn_line_id, (byLine.get(t.txn_line_id) || 0) + t.quantity_picked);
      const ful = txnMod.transform(repo, orderId, 'FULFILLMENT', {
        txn_date, tracking_no: tracking_no || undefined,
        lines: [...byLine].map(([source_line_id, quantity]) => ({ source_line_id, quantity: Qty.toNumber(quantity) })),
      });
      fulfilments.push({ id: ful.id, txn_no: ful.txn_no });
      repo.exec('UPDATE package SET txn_id = ?, status = \'shipped\', shipped_at = ?, carrier = COALESCE(NULLIF(carrier, \'\'), ?), tracking_no = COALESCE(NULLIF(tracking_no, \'\'), ?) WHERE tenant_id = :t AND wave_id = ? AND (txn_id = ? OR txn_id IS NULL)',
        [ful.id, nowIso(), carrier, tracking_no, waveId, orderId]);
    }
    repo.update('pick_wave', waveId, { status: 'shipped', completed_at: nowIso() });
    audit.record(repo, { recordType: 'pick_wave', recordId: waveId, action: 'ship' });
    return { wave: getWave(repo, waveId), fulfilments };
  });
}

/** Live picture of the floor: waves in flight and what is holding them up. */
export function workloadSummary(repo, { location_id = null } = {}) {
  const waves = repo.query(
    `SELECT * FROM pick_wave WHERE tenant_id = :t AND status NOT IN ('shipped','cancelled')
     ${location_id ? 'AND location_id = ?' : ''} ORDER BY created_at`,
    location_id ? [location_id] : []);
  const putaway = repo.queryOne("SELECT COUNT(*) AS c FROM putaway_task WHERE tenant_id = :t AND status = 'pending'");
  const shorts = repo.query(
    `SELECT pt.*, i.sku, i.name FROM pick_task pt JOIN item i ON i.tenant_id = pt.tenant_id AND i.id = pt.item_id
     WHERE pt.tenant_id = :t AND pt.status = 'short' ORDER BY pt.picked_at DESC LIMIT 20`);
  return {
    waves: waves.map((w) => ({
      id: w.id, wave_no: w.wave_no, status: w.status, orders: w.order_count, lines: w.line_count,
      picked: repo.queryOne("SELECT COUNT(*) AS c FROM pick_task WHERE tenant_id = :t AND wave_id = ? AND status != 'pending'", [w.id]).c,
    })),
    pending_putaway: putaway.c,
    short_picks: shorts.map((s) => ({ sku: s.sku, name: s.name, wanted: Qty.toNumber(s.quantity), picked: Qty.toNumber(s.quantity_picked) })),
  };
}
