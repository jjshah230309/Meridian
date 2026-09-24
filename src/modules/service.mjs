// Meridian ERP :: modules/service
// Field service: assets under contract, work in the field, and billing it.
//
// The rule that makes this useful rather than just a job list is coverage:
// before anything is billed, each line is checked against the customer's
// contract, and covered lines are zero-rated rather than dropped. The
// customer sees what the visit was worth and what their contract absorbed,
// which is the whole argument for renewing it.
import { ulid, Money, Qty, nowIso, today, isValidDate, sum } from '../core/util.mjs';
import { ValidationError, notFound, unprocessable } from '../core/http.mjs';
import { nextNumber } from '../core/seq.mjs';
import * as txnMod from './txn.mjs';
import * as inv from './inventory.mjs';
import * as gl from './gl.mjs';
import { postingAccounts } from './setup.mjs';

/** Any real stocking site, for a job that names none. */
const defaultLocation = (repo) => repo.queryOne(
  "SELECT id FROM location WHERE tenant_id = :t AND active = 1 AND type != 'virtual' ORDER BY code LIMIT 1")?.id || null;
import * as audit from '../core/audit.mjs';

export const ORDER_TYPES = ['repair', 'install', 'maintenance', 'inspection'];
export const PRIORITIES = ['low', 'normal', 'high', 'emergency'];
export const STATUSES = ['new', 'scheduled', 'dispatched', 'on_site', 'complete', 'cancelled', 'invoiced'];

export const getOrder = (repo, id) => {
  const o = repo.get('service_order', id);
  if (!o) throw notFound(`Service order ${id} not found`);
  return o;
};
export const serviceLines = (repo, id) =>
  repo.query(`SELECT sl.*, i.sku, i.name AS item_name FROM service_line sl
              LEFT JOIN item i ON i.tenant_id = sl.tenant_id AND i.id = sl.item_id
              WHERE sl.tenant_id = :t AND sl.service_order_id = ? ORDER BY sl.line_no`, [id]);

export function createOrder(repo, input) {
  const errors = {};
  if (!input.customer_id) errors.customer_id = 'Customer is required';
  if (!input.subsidiary_id) errors.subsidiary_id = 'Subsidiary is required';
  if (input.order_type && !ORDER_TYPES.includes(input.order_type)) errors.order_type = `Type must be one of ${ORDER_TYPES.join(', ')}`;
  if (input.priority && !PRIORITIES.includes(input.priority)) errors.priority = `Priority must be one of ${PRIORITIES.join(', ')}`;
  if (input.requested_date && !isValidDate(input.requested_date)) errors.requested_date = 'Enter a valid date';
  if (Object.keys(errors).length) throw new ValidationError(errors);

  // Inherit the site from the asset when there is one -- the commonest
  // source of a technician being sent to the wrong address.
  const asset = input.asset_id ? repo.get('service_asset', input.asset_id) : null;
  const contract = input.contract_id
    ? repo.get('service_contract', input.contract_id)
    : asset?.contract_id ? repo.get('service_contract', asset.contract_id) : null;

  const now = nowIso();
  const id = ulid();
  repo.insert('service_order', {
    id, order_no: input.order_no || nextNumber(repo, 'service_order'),
    customer_id: input.customer_id, asset_id: input.asset_id || null,
    contract_id: contract?.id || null, case_id: input.case_id || null,
    subsidiary_id: input.subsidiary_id, location_id: input.location_id || null,
    order_type: input.order_type || 'repair', priority: input.priority || 'normal',
    status: 'new', description: input.description || '',
    site_address: input.site_address || asset?.site_address || {},
    requested_date: input.requested_date || null,
    scheduled_start: null, scheduled_end: null, technician_id: null,
    arrived_at: null, completed_at: null, resolution: '',
    labour_hours: 0, parts_cost: 0, labour_cost: 0,
    billable: input.billable === false ? 0 : 1,
    invoice_txn_id: null, signature: '',
    custom: input.custom || {}, created_at: now, updated_at: now,
  });
  audit.record(repo, { recordType: 'service_order', recordId: id, action: 'create' });
  return getOrder(repo, id);
}

/**
 * Technicians free in a window, nearest skill match first.
 * A technician already booked on an overlapping job is excluded rather than
 * ranked low -- double-booking a van is not a trade-off worth offering.
 */
export function availableTechnicians(repo, { start, end, skills = [] } = {}) {
  if (!start || !end) throw new ValidationError({ start: 'A start and end time are required' });
  const techs = repo.query(
    `SELECT tc.*, (e.first_name || ' ' || e.last_name) AS name, e.email FROM technician tc
     JOIN employee e ON e.tenant_id = tc.tenant_id AND e.id = tc.employee_id
     WHERE tc.tenant_id = :t AND tc.active = 1 ORDER BY e.last_name, e.first_name`);
  const busy = new Set(repo.query(
    `SELECT technician_id FROM service_order
     WHERE tenant_id = :t AND technician_id IS NOT NULL
       AND status IN ('scheduled','dispatched','on_site')
       AND scheduled_start < ? AND scheduled_end > ?`, [end, start]).map((r) => r.technician_id));

  return techs
    .filter((t) => !busy.has(t.employee_id))
    .map((t) => {
      const has = Array.isArray(t.skills) ? t.skills : [];
      const matched = skills.filter((s) => has.includes(s));
      return {
        // `service_order.technician_id` holds the EMPLOYEE id -- that is what
        // the metadata declares, what the dispatch board joins on and what
        // invoicing looks up. Returning the technician row id here instead
        // scheduled jobs onto a person who did not exist.
        technician_id: t.employee_id, employee_id: t.employee_id,
        technician_record_id: t.id, name: t.name, email: t.email,
        skills: has, matched_skills: matched,
        match_pct: skills.length ? Math.round((matched.length / skills.length) * 100) : 100,
        hourly_rate: Money.toNumber(t.hourly_rate),
      };
    })
    .sort((a, b) => b.match_pct - a.match_pct);
}

export function schedule(repo, id, { technician_id, scheduled_start, scheduled_end }) {
  const order = getOrder(repo, id);
  if (['complete', 'invoiced', 'cancelled'].includes(order.status)) {
    throw unprocessable(`${order.order_no} is ${order.status} and cannot be rescheduled`);
  }
  if (!scheduled_start || !scheduled_end) throw new ValidationError({ scheduled_start: 'A start and end time are required' });
  if (scheduled_end <= scheduled_start) throw new ValidationError({ scheduled_end: 'The end time must be after the start' });

  const clash = repo.queryOne(
    `SELECT order_no FROM service_order
     WHERE tenant_id = :t AND technician_id = ? AND id != ?
       AND status IN ('scheduled','dispatched','on_site')
       AND scheduled_start < ? AND scheduled_end > ?`,
    [technician_id, id, scheduled_end, scheduled_start]);
  if (clash) throw unprocessable(`That technician is already on ${clash.order_no} at that time`);

  repo.update('service_order', id, {
    technician_id, scheduled_start, scheduled_end, status: 'scheduled', updated_at: nowIso(),
  });
  audit.record(repo, { recordType: 'service_order', recordId: id, action: 'schedule' });
  return getOrder(repo, id);
}

export function setStatus(repo, id, status, extra = {}) {
  const order = getOrder(repo, id);
  if (!STATUSES.includes(status)) throw new ValidationError({ status: `Status must be one of ${STATUSES.join(', ')}` });
  const patch = { status, updated_at: nowIso() };
  if (status === 'on_site') patch.arrived_at = extra.arrived_at || nowIso();
  if (status === 'complete') {
    patch.completed_at = extra.completed_at || nowIso();
    patch.resolution = extra.resolution || order.resolution;
    patch.signature = extra.signature || order.signature;
  }
  repo.update('service_order', id, patch);
  audit.record(repo, { recordType: 'service_order', recordId: id, action: 'status', changes: { status: { from: order.status, to: status } } });
  return getOrder(repo, id);
}

/**
 * Add parts and labour. Parts consume stock from the technician's van when
 * they have one, because that is where the part physically came from.
 */
export function addLines(repo, id, lines = []) {
  const order = getOrder(repo, id);
  if (['invoiced', 'cancelled'].includes(order.status)) throw unprocessable(`${order.order_no} is ${order.status}`);
  if (!lines.length) throw new ValidationError({ lines: 'At least one line is required' });

  const contract = order.contract_id ? repo.get('service_contract', order.contract_id) : null;
  const tech = order.technician_id
    ? repo.queryOne('SELECT * FROM technician WHERE tenant_id = :t AND employee_id = ?', [order.technician_id])
    : null;

  return repo.tx(() => {
    const existing = repo.queryOne(
      'SELECT COALESCE(MAX(line_no), 0) AS m FROM service_line WHERE tenant_id = :t AND service_order_id = ?', [id]);
    let lineNo = existing.m;
    let parts = 0, labour = 0, hours = 0;
    const relieved = [];

    for (const l of lines) {
      lineNo++;
      const type = l.line_type || 'part';
      const quantity = Qty.parse(l.quantity ?? 1);
      const item = l.item_id ? repo.get('item', l.item_id) : null;
      const unitPrice = Money.parse(l.unit_price ?? Money.toNumber(item?.base_price ?? 0));
      // item.standard_cost is already minor units, same as item.base_price
      // above -- passing it straight into Money.parse (which expects major
      // units) scales it up by 100x for any line that doesn't override cost.
      let unitCost = Money.parse(l.unit_cost ?? Money.toNumber(item?.standard_cost ?? 0));

      // Contract coverage: parts_labour covers both, parts_only covers parts.
      const covered = contract && contract.status === 'active'
        && contract.end_date >= today()
        && (contract.coverage === 'parts_labour' || (contract.coverage === 'parts_only' && type === 'part'));

      if (type === 'part' && item && inv.isStocked(item)) {
        // Van stock first -- that is where a field technician's parts really
        // are -- then the site the job was booked against. Falling through to
        // nothing would bill the customer for a part that never left stock.
        const fromLocation = tech?.van_location_id || order.location_id || tech?.home_location_id || defaultLocation(repo);
        if (!fromLocation) throw unprocessable(`${item.sku} cannot be issued: set a location on ${order.order_no}, or van stock on the technician`);
        const res = inv.moveStock(repo, {
          item_id: item.id, location_id: fromLocation, qty_delta: -quantity,
          type: 'service_issue', source_type: 'service_order', source_id: id,
          memo: `Used on ${order.order_no}`,
        });
        unitCost = res.unit_cost_used;
        relieved.push({ item, value: -res.value_delta });
      }

      const amount = covered ? 0 : Qty.extend(quantity, unitPrice);
      repo.insert('service_line', {
        id: ulid(), service_order_id: id, line_no: lineNo, line_type: type,
        item_id: l.item_id || null, description: l.description || item?.name || '',
        quantity, unit_price: unitPrice, unit_cost: unitCost, amount,
        billable: l.billable === false ? 0 : 1,
        covered_by_contract: covered ? 1 : 0,
      });
      if (type === 'labour') { labour += Qty.extend(quantity, unitCost); hours += quantity; }
      else parts += Qty.extend(quantity, unitCost);
    }

    // Parts fitted on site have left stock for good. The stock ledger knows
    // that the moment moveStock runs; the general ledger only knows if we tell
    // it, and until we do the inventory account carries goods that are sitting
    // in a customer's plant room.
    const cost = sum(relieved, (r) => r.value);
    if (cost) {
      const acc = postingAccounts(repo);
      gl.postJournal(repo, {
        subsidiary_id: order.subsidiary_id, txn_date: today(),
        memo: `${order.order_no} parts fitted`,
        source_type: 'service_order', source_id: id,
        lines: [
          ...relieved.filter((r) => r.value).map((r) => ({
            account_id: r.item.cogs_account_id || acc.cogs, debit: r.value, credit: 0, memo: `Parts used ${r.item.sku}`,
          })),
          ...relieved.filter((r) => r.value).map((r) => ({
            account_id: r.item.asset_account_id || acc.inventory, debit: 0, credit: r.value, memo: `Stock issued ${r.item.sku}`,
          })),
        ],
      });
    }

    repo.update('service_order', id, {
      parts_cost: order.parts_cost + parts,
      labour_cost: order.labour_cost + labour,
      labour_hours: order.labour_hours + hours,
      updated_at: nowIso(),
    });
    return { order: getOrder(repo, id), lines: serviceLines(repo, id) };
  });
}

/** Invoice the visit. Covered lines appear at zero so the customer sees the value. */
export function invoiceOrder(repo, id, { txn_date = today() } = {}) {
  const order = getOrder(repo, id);
  if (order.status !== 'complete') throw unprocessable(`${order.order_no} must be complete before it can be invoiced`);
  if (order.invoice_txn_id) throw unprocessable(`${order.order_no} is already invoiced`);
  if (!order.billable) throw unprocessable(`${order.order_no} is marked non-billable`);

  const lines = serviceLines(repo, id).filter((l) => l.billable);
  if (!lines.length) throw unprocessable('There is nothing billable on this order');

  // Labour and expense lines are typed straight onto the job and carry no
  // item, so the invoice has to be told which revenue account they land in --
  // parts fall back to product revenue, everything else to service revenue.
  const acc = postingAccounts(repo);
  const fallbackAccount = (l) => (l.line_type === 'part' ? (acc.product_revenue || acc.service_revenue) : (acc.service_revenue || acc.product_revenue));
  const orphan = lines.find((l) => !l.item_id && !fallbackAccount(l));
  if (orphan) throw unprocessable(`"${orphan.description}" has no item and there is no revenue account to bill it to`);

  return repo.tx(() => {
    const invoice = txnMod.createTxn(repo, 'INVOICE', {
      entity_id: order.customer_id, subsidiary_id: order.subsidiary_id, txn_date,
      memo: `${order.order_no} — ${order.description || order.order_type}`,
      lines: lines.map((l) => ({
        item_id: l.item_id || null,
        account_id: l.item_id ? null : fallbackAccount(l),
        description: l.covered_by_contract ? `${l.description} (covered by contract)` : l.description,
        quantity: Qty.toNumber(l.quantity),
        rate: l.covered_by_contract ? 0 : Money.toNumber(l.unit_price),
      })),
    });
    repo.update('service_order', id, { invoice_txn_id: invoice.id, status: 'invoiced', updated_at: nowIso() });
    if (order.contract_id) {
      const c = repo.get('service_contract', order.contract_id);
      if (c) repo.update('service_contract', order.contract_id, { visits_used: (c.visits_used || 0) + 1 });
    }
    audit.record(repo, { recordType: 'service_order', recordId: id, action: 'invoice' });
    return { order: getOrder(repo, id), invoice };
  });
}

/** The dispatch board: one day, every technician, in time order. */
export function dispatchBoard(repo, { date = today() } = {}) {
  const orders = repo.query(
    `SELECT so.*, c.name AS customer_name, (e.first_name || ' ' || e.last_name) AS technician_name
     FROM service_order so
     LEFT JOIN customer c ON c.tenant_id = so.tenant_id AND c.id = so.customer_id
     LEFT JOIN employee e ON e.tenant_id = so.tenant_id AND e.id = so.technician_id
     WHERE so.tenant_id = :t AND (substr(so.scheduled_start, 1, 10) = ? OR (so.scheduled_start IS NULL AND so.status = 'new'))
     ORDER BY so.scheduled_start`, [date]);
  const byTech = new Map();
  const unassigned = [];
  for (const o of orders) {
    const row = {
      id: o.id, order_no: o.order_no, customer: o.customer_name, type: o.order_type,
      priority: o.priority, status: o.status,
      start: o.scheduled_start, end: o.scheduled_end, description: o.description,
    };
    if (!o.technician_id) { unassigned.push(row); continue; }
    if (!byTech.has(o.technician_id)) byTech.set(o.technician_id, { technician_id: o.technician_id, name: o.technician_name, jobs: [] });
    byTech.get(o.technician_id).jobs.push(row);
  }
  return {
    date, technicians: [...byTech.values()], unassigned,
    counts: {
      total: orders.length, unassigned: unassigned.length,
      emergency: orders.filter((o) => o.priority === 'emergency').length,
    },
  };
}

/** Contracts expiring soon and how much of their entitlement is used. */
export function contractRenewals(repo, { within_days = 90 } = {}) {
  const cutoff = new Date(Date.now() + within_days * 86400000).toISOString().slice(0, 10);
  return repo.query(
    `SELECT sc.*, c.name AS customer_name FROM service_contract sc
     JOIN customer c ON c.tenant_id = sc.tenant_id AND c.id = sc.customer_id
     WHERE sc.tenant_id = :t AND sc.status = 'active' AND sc.end_date <= ?
     ORDER BY sc.end_date`, [cutoff])
    .map((c) => ({
      id: c.id, contract_no: c.contract_no, customer: c.customer_name, name: c.name,
      end_date: c.end_date, amount: Money.toNumber(c.amount),
      visits_included: c.visits_included, visits_used: c.visits_used,
      utilisation_pct: c.visits_included ? Math.round((c.visits_used / c.visits_included) * 100) : null,
    }));
}
