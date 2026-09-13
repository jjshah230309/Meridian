// Meridian ERP :: modules/costing
// Landed cost, and the physical count that checks it was right.
//
// A container of stock costs the invoice price plus the freight, the duty and
// the insurance. Booking those to an expense account leaves the stock
// understated on the balance sheet and the margin on every sale of it
// overstated -- and nobody notices, because both errors are invisible in
// isolation and only meet at the year end.
//
// A physical count is the other half of the same question. Once a quarter
// somebody walks the racks; what they find is rarely what the system says.
// The difference has to arrive as one reviewed adjustment against the figure
// the counter was actually working from, not as forty ad-hoc corrections
// against a number that moved while they were counting.
import { ulid, Money, Qty, nowIso, today, isValidDate, sum } from '../core/util.mjs';
import { ValidationError, notFound, unprocessable, conflict } from '../core/http.mjs';
import { nextNumber } from '../core/seq.mjs';
import * as gl from './gl.mjs';
import * as inv from './inventory.mjs';
import * as T from './txn.mjs';
import { postingAccounts } from './setup.mjs';
import * as audit from '../core/audit.mjs';

export const METHODS = ['value', 'quantity', 'weight'];
const METHOD_LABEL = { value: 'by value', quantity: 'by quantity', weight: 'by weight' };

// ------------------------------------------------------------ landed cost
export const categories = (repo) => repo.query(
  `SELECT c.*, a.number AS account_number, a.name AS account_name
   FROM landed_cost_category c
   LEFT JOIN account a ON a.tenant_id = c.tenant_id AND a.id = c.account_id
   WHERE c.tenant_id = :t ORDER BY c.name`);

export function createCategory(repo, input) {
  if (!input.name) throw new ValidationError({ name: 'Name is required' });
  if (input.method && !METHODS.includes(input.method)) {
    throw new ValidationError({ method: `Spread it ${METHODS.join(', ')}` });
  }
  const id = repo.insert('landed_cost_category', {
    id: ulid(), name: String(input.name).trim(), account_id: input.account_id || null,
    method: input.method || 'value', active: input.active === 0 ? 0 : 1, created_at: nowIso(),
  });
  audit.record(repo, { recordType: 'landed_cost_category', recordId: id, action: 'create', after: input });
  return repo.get('landed_cost_category', id);
}

/** The stocked lines of a receipt or bill, with the three possible bases. */
function costableLines(repo, txn) {
  const lines = repo.query(
    `SELECT l.*, i.sku, i.name AS item_name, i.type AS item_type, i.weight_g
     FROM txn_line l JOIN item i ON i.tenant_id = l.tenant_id AND i.id = l.item_id
     WHERE l.tenant_id = :t AND l.txn_id = ? ORDER BY l.line_no`, [txn.id]);
  return lines
    .filter((l) => inv.isStocked({ type: l.item_type }))
    .map((l) => ({
      ...l,
      basis_value: Money.convert(l.amount, txn.fx_rate || 1),
      basis_quantity: l.quantity,
      basis_weight: Math.round((l.weight_g || 0) * (l.quantity / 1_000_000)),
    }));
}

/**
 * Spread a cost across the goods it belongs to and capitalise it.
 *
 * The stock ledger is moved as well as the journal: a receipt whose value
 * goes up without the stock behind it going up leaves the inventory account
 * and the item's own cost disagreeing on the very next sale.
 */
export function addLandedCost(repo, txnId, input = {}) {
  const txn = repo.get('txn', txnId);
  if (!txn) throw notFound('Transaction not found');
  if (!['ITEM_RECEIPT', 'VENDOR_BILL'].includes(txn.type)) {
    throw unprocessable(`${txn.txn_no} is a ${txn.type.toLowerCase().replace('_', ' ')}. Landed cost goes on a receipt or a bill — the documents that brought the goods in.`);
  }
  if (!txn.posted) throw unprocessable(`${txn.txn_no} is not posted yet.`);

  const category = input.category_id ? repo.get('landed_cost_category', input.category_id) : null;
  if (!category) throw new ValidationError({ category_id: 'Choose what kind of cost this is' });
  const method = input.method || category.method || 'value';
  if (!METHODS.includes(method)) throw new ValidationError({ method: `Spread it ${METHODS.join(', ')}` });

  const amount = Money.parse(input.amount);
  if (!amount || amount <= 0) throw new ValidationError({ amount: 'Enter an amount greater than zero' });

  const lines = costableLines(repo, txn);
  if (!lines.length) throw unprocessable(`${txn.txn_no} has no stocked lines, so there is nothing for the cost to land on.`);

  const key = `basis_${method}`;
  const bases = lines.map((l) => l[key] || 0);
  if (!sum(bases, (b) => b)) {
    throw unprocessable(method === 'weight'
      ? `None of the items on ${txn.txn_no} has a weight, so the cost cannot be spread by weight. Spread it by value or by quantity, or set a weight on the items.`
      : `Every line on ${txn.txn_no} measures zero ${method}, so there is nothing to divide by.`);
  }
  const shares = Money.allocate(amount, bases);

  const period = gl.requireOpenPeriod(repo, input.txn_date || txn.txn_date);
  const acc = postingAccounts(repo);
  const clearing = category.account_id || acc.cogs;
  if (!clearing) throw unprocessable('No account is set on that landed cost category, and no default cost account is configured.');

  return repo.tx(() => {
    const id = ulid();
    const journalLines = [];
    const detail = [];
    lines.forEach((l, i) => {
      const share = shares[i];
      if (!share) return;
      // Move the stock first: it fixes the unit cost the ledger has to match.
      const moved = inv.moveStock(repo, {
        item_id: l.item_id, location_id: l.location_id || txn.location_id,
        qty_delta: 0, value_delta: share, unit_cost: null,
        type: 'landed_cost', source_type: 'landed_cost', source_id: id,
        txn_date: input.txn_date || txn.txn_date, memo: `${category.name} on ${txn.txn_no}`,
      });
      void moved;
      const item = repo.get('item', l.item_id);
      journalLines.push({
        account_id: item?.asset_account_id || acc.inventory, debit: share, credit: 0,
        item_id: l.item_id, location_id: l.location_id || txn.location_id,
        memo: `${category.name} — ${l.sku}`,
      });
      detail.push({
        id: ulid(), landed_cost_id: id, txn_line_id: l.id, item_id: l.item_id,
        location_id: l.location_id || txn.location_id, basis: bases[i], amount: share,
      });
    });
    journalLines.push({ account_id: clearing, debit: 0, credit: amount, memo: `${category.name} on ${txn.txn_no}` });

    const entry = gl.postJournal(repo, {
      subsidiary_id: txn.subsidiary_id, txn_date: input.txn_date || txn.txn_date,
      memo: `Landed cost ${METHOD_LABEL[method]} — ${category.name} on ${txn.txn_no}`,
      source_type: 'landed_cost', source_id: id, lines: journalLines,
    });
    void period;

    repo.insert('landed_cost', {
      id, txn_id: txnId, category_id: category.id, method, amount,
      currency: txn.currency, vendor_id: input.vendor_id || null,
      reference: input.reference || '', entry_id: entry.id, applied_at: nowIso(),
      created_at: nowIso(), created_by: repo.ctx?.user?.id || null,
    });
    for (const d of detail) repo.insert('landed_cost_line', d);

    audit.record(repo, {
      recordType: 'txn', recordId: txnId, action: 'landed_cost',
      changes: {
        category: { from: null, to: category.name },
        amount: { from: null, to: Money.toNumber(amount) },
        spread: { from: null, to: METHOD_LABEL[method] },
        entry: { from: null, to: entry.entry_no },
      },
    });
    return getLandedCost(repo, id);
  });
}

export function getLandedCost(repo, id) {
  const c = repo.get('landed_cost', id);
  if (!c) throw notFound('Landed cost not found');
  return {
    ...c,
    category: repo.get('landed_cost_category', c.category_id),
    txn: repo.get('txn', c.txn_id),
    lines: repo.query(
      `SELECT l.*, i.sku, i.name AS item_name FROM landed_cost_line l
       JOIN item i ON i.tenant_id = l.tenant_id AND i.id = l.item_id
       WHERE l.tenant_id = :t AND l.landed_cost_id = ? ORDER BY i.sku`, [id]),
  };
}

export const landedCostsFor = (repo, txnId) => repo.query(
  `SELECT c.*, cat.name AS category_name, j.entry_no
   FROM landed_cost c
   LEFT JOIN landed_cost_category cat ON cat.tenant_id = c.tenant_id AND cat.id = c.category_id
   LEFT JOIN journal_entry j ON j.tenant_id = c.tenant_id AND j.id = c.entry_id
   WHERE c.tenant_id = :t AND c.txn_id = ? ORDER BY c.created_at`, [txnId]);

/** What a document's goods actually cost once everything landed on them. */
export function landedSummary(repo, txnId) {
  const txn = repo.get('txn', txnId);
  if (!txn) throw notFound('Transaction not found');
  const costs = landedCostsFor(repo, txnId);
  const lines = costableLines(repo, txn);
  const byLine = new Map(lines.map((l) => [l.id, { ...l, landed: 0 }]));
  for (const c of costs) {
    for (const d of repo.query('SELECT * FROM landed_cost_line WHERE tenant_id = :t AND landed_cost_id = ?', [c.id])) {
      const row = byLine.get(d.txn_line_id);
      if (row) row.landed += d.amount;
    }
  }
  const rows = [...byLine.values()].map((l) => ({
    txn_line_id: l.id, item_id: l.item_id, sku: l.sku, item_name: l.item_name,
    quantity: l.quantity, invoice_value: l.basis_value, landed: l.landed,
    total: l.basis_value + l.landed,
    unit_cost: l.quantity ? Math.round(((l.basis_value + l.landed) * 1_000_000) / l.quantity) : 0,
    uplift_pct: l.basis_value ? Math.round((l.landed / l.basis_value) * 1000) / 10 : 0,
  }));
  return {
    txn: { id: txn.id, txn_no: txn.txn_no, type: txn.type, txn_date: txn.txn_date, currency: txn.currency },
    costs, rows,
    goods_value: sum(rows, (r) => r.invoice_value),
    landed_total: sum(rows, (r) => r.landed),
  };
}

// ------------------------------------------------------- physical counts
export function openCount(repo, input = {}) {
  const location = input.location_id ? repo.get('location', input.location_id) : null;
  if (!location) throw new ValidationError({ location_id: 'Which location is being counted?' });
  const countDate = input.count_date || today();
  if (!isValidDate(countDate)) throw new ValidationError({ count_date: 'Enter a valid date' });

  const scope = input.scope || 'full';
  if (!['full', 'category', 'cycle'].includes(scope)) throw new ValidationError({ scope: 'Count everything, one category, or a cycle slice' });

  const params = [input.location_id];
  let where = '';
  if (scope === 'category') {
    if (!input.category) throw new ValidationError({ category: 'Which category?' });
    where = ' AND i.category = ?';
    params.push(input.category);
  }
  const limit = scope === 'cycle' ? Math.max(1, Number(input.size) || 25) : 100000;

  // Everything stocked at the location, including what the system thinks is
  // at zero: a line that should be empty and is not is exactly the sort of
  // thing a count exists to find.
  const rows = repo.query(
    `SELECT il.item_id, il.qty_on_hand, il.avg_cost, il.bin, i.sku, i.name, i.category, il.last_count_at
     FROM item_location il
     JOIN item i ON i.tenant_id = il.tenant_id AND i.id = il.item_id
     WHERE il.tenant_id = :t AND il.location_id = ?
       AND i.active = 1 AND i.type IN ('inventory', 'assembly')${where}
     ORDER BY ${scope === 'cycle' ? 'COALESCE(il.last_count_at, \'\'), i.sku' : 'i.sku'}
     LIMIT ${limit}`, params);
  if (!rows.length) throw unprocessable(`Nothing stocked at ${location.name} matches that scope.`);

  const now = nowIso();
  return repo.tx(() => {
    const id = ulid();
    repo.insert('inventory_count', {
      id, count_no: nextNumber(repo, 'inventory_count'), location_id: input.location_id,
      subsidiary_id: input.subsidiary_id || location.subsidiary_id,
      name: input.name || `${scope === 'cycle' ? 'Cycle count' : 'Stock count'} — ${location.name}`,
      scope, category: input.category || '', count_date: countDate, status: 'open',
      line_count: rows.length, counted_count: 0, variance_qty: 0, variance_value: 0,
      adjustment_txn_id: null, notes: input.notes || '',
      created_at: now, created_by: repo.ctx?.user?.id || null,
    });
    for (const r of rows) {
      repo.insert('inventory_count_line', {
        id: ulid(), count_id: id, item_id: r.item_id, bin: r.bin || '',
        expected_qty: r.qty_on_hand || 0, counted_qty: null, unit_cost: r.avg_cost || 0,
        variance_qty: 0, variance_value: 0, note: '', counted_at: null, counted_by: null,
      });
    }
    audit.record(repo, {
      recordType: 'inventory_count', recordId: id, action: 'open',
      changes: { location: { from: null, to: location.name }, lines: { from: 0, to: rows.length } },
    });
    return getCount(repo, id);
  });
}

export function getCount(repo, id) {
  const c = repo.get('inventory_count', id);
  if (!c) throw notFound('Stock count not found');
  return {
    ...c,
    location: repo.get('location', c.location_id),
    lines: repo.query(
      `SELECT l.*, i.sku, i.name AS item_name, i.uom, i.category
       FROM inventory_count_line l JOIN item i ON i.tenant_id = l.tenant_id AND i.id = l.item_id
       WHERE l.tenant_id = :t AND l.count_id = ? ORDER BY i.sku`, [id]),
  };
}

export const countHistory = (repo, { status = null, limit = 30 } = {}) => repo.query(
  `SELECT c.*, l.name AS location_name FROM inventory_count c
   LEFT JOIN location l ON l.tenant_id = c.tenant_id AND l.id = c.location_id
   WHERE c.tenant_id = :t${status && status !== 'all' ? ' AND c.status = ?' : ''}
   ORDER BY c.count_date DESC, c.count_no DESC LIMIT ?`,
  status && status !== 'all' ? [status, Number(limit) || 30] : [Number(limit) || 30]);

/** Enter what was found. Counting the same line again simply replaces it. */
export function enterCounts(repo, id, lines) {
  const count = repo.get('inventory_count', id);
  if (!count) throw notFound('Stock count not found');
  if (count.status === 'posted') throw conflict(`${count.count_no} has been posted; its figures cannot change.`);
  if (count.status === 'cancelled') throw conflict(`${count.count_no} was cancelled.`);
  if (!Array.isArray(lines)) throw new ValidationError({ lines: 'Send the lines that were counted' });

  const errors = {};
  const updates = [];
  lines.forEach((l, i) => {
    const row = repo.get('inventory_count_line', l.id);
    if (!row || row.count_id !== id) { errors[`lines.${i}.id`] = 'That line is not on this count'; return; }
    if (l.counted_qty === null || l.counted_qty === undefined || l.counted_qty === '') {
      updates.push({ id: row.id, counted_qty: null, variance_qty: 0, variance_value: 0, note: l.note || row.note });
      return;
    }
    const counted = Qty.parse(l.counted_qty);
    if (counted < 0) { errors[`lines.${i}.counted_qty`] = 'A count cannot be negative'; return; }
    const varianceQty = counted - row.expected_qty;
    updates.push({
      id: row.id, counted_qty: counted, variance_qty: varianceQty,
      variance_value: Qty.extend(varianceQty, row.unit_cost),
      note: l.note === undefined ? row.note : String(l.note).slice(0, 500),
    });
  });
  if (Object.keys(errors).length) throw new ValidationError(errors, 'Some counted lines are invalid');

  const now = nowIso();
  const by = repo.ctx?.user?.id || null;
  return repo.tx(() => {
    for (const u of updates) {
      repo.update('inventory_count_line', u.id, {
        counted_qty: u.counted_qty, variance_qty: u.variance_qty, variance_value: u.variance_value,
        note: u.note, counted_at: u.counted_qty === null ? null : now, counted_by: u.counted_qty === null ? null : by,
      });
    }
    retotal(repo, id);
    return getCount(repo, id);
  });
}

function retotal(repo, id) {
  const rows = repo.query('SELECT counted_qty, variance_qty, variance_value FROM inventory_count_line WHERE tenant_id = :t AND count_id = ?', [id]);
  const counted = rows.filter((r) => r.counted_qty !== null);
  repo.update('inventory_count', id, {
    counted_count: counted.length,
    variance_qty: sum(counted, (r) => r.variance_qty),
    variance_value: sum(counted, (r) => r.variance_value),
    status: counted.length && counted.length === rows.length ? 'counted' : 'open',
  });
}

/**
 * Post the differences.
 *
 * One inventory adjustment carries every variance, so the ledger shows a
 * stock count rather than forty unexplained corrections, and the count itself
 * is the supporting paper for it.
 */
export function postCount(repo, id, { txn_date = null, memo = '' } = {}) {
  const count = getCount(repo, id);
  if (count.status === 'posted') throw conflict(`${count.count_no} has already been posted.`);
  if (count.status === 'cancelled') throw conflict(`${count.count_no} was cancelled.`);
  const uncounted = count.lines.filter((l) => l.counted_qty === null);
  if (uncounted.length === count.lines.length) throw unprocessable(`Nothing has been counted on ${count.count_no} yet.`);

  const varied = count.lines.filter((l) => l.counted_qty !== null && l.variance_qty !== 0);
  const date = txn_date || count.count_date;
  if (!isValidDate(date)) throw new ValidationError({ txn_date: 'Enter a valid date' });
  gl.requireOpenPeriod(repo, date);

  return repo.tx(() => {
    let adjustment = null;
    if (varied.length) {
      // Deliberately routed through the ordinary adjustment document: a count
      // that posted its own private journal would be invisible to every stock
      // report that knows what an adjustment is.
      adjustment = T.createTxn(repo, 'INVENTORY_ADJUSTMENT', {
        subsidiary_id: count.subsidiary_id, location_id: count.location_id, txn_date: date,
        memo: memo || `${count.count_no} — stock count at ${count.location?.name || 'location'}`,
        reference: count.count_no,
        lines: varied.map((l) => ({
          item_id: l.item_id, quantity: Qty.toNumber(l.variance_qty),
          unit_cost: Money.toNumber(l.unit_cost), description: `Counted ${Qty.toNumber(l.counted_qty)}, expected ${Qty.toNumber(l.expected_qty)}`,
        })),
      });
    }

    const now = nowIso();
    repo.update('inventory_count', id, {
      status: 'posted', adjustment_txn_id: adjustment?.id || null,
      posted_at: now, posted_by: repo.ctx?.user?.id || null,
    });
    // Remember when each line was last counted, which is what a cycle count
    // orders by so the same shelf is not counted every month.
    for (const l of count.lines) {
      if (l.counted_qty === null) continue;
      repo.exec('UPDATE item_location SET last_count_at = ? WHERE tenant_id = :t AND item_id = ? AND location_id = ?',
        [date, l.item_id, count.location_id]);
    }

    audit.record(repo, {
      recordType: 'inventory_count', recordId: id, action: 'post',
      changes: {
        lines: { from: null, to: count.lines.length },
        variances: { from: null, to: varied.length },
        value: { from: null, to: Money.toNumber(count.variance_value) },
        adjustment: { from: null, to: adjustment?.txn_no || 'none needed' },
      },
    });
    return { count: getCount(repo, id), adjustment, variances: varied.length, uncounted: uncounted.length };
  });
}

export function cancelCount(repo, id, { reason = '' } = {}) {
  const count = repo.get('inventory_count', id);
  if (!count) throw notFound('Stock count not found');
  if (count.status === 'posted') throw conflict(`${count.count_no} has been posted. Reverse the adjustment instead.`);
  repo.update('inventory_count', id, { status: 'cancelled' });
  audit.record(repo, {
    recordType: 'inventory_count', recordId: id, action: 'cancel',
    changes: { status: { from: count.status, to: 'cancelled' }, reason: { from: null, to: reason || 'Abandoned' } },
  });
  return getCount(repo, id);
}
