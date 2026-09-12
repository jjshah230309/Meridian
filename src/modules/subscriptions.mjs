// Meridian ERP :: modules/subscriptions
// Selling the same thing every month.
//
// A subscription is not an invoice that repeats. It is a contract with a
// term, a price that can change part way through, seats that come and go,
// usage that is only known after the fact, and an ending that either renews
// itself or does not. The invoices fall out of it.
//
// The engine is built around three rules.
//
// A period is billed once. Every line of every period ever invoiced is
// written to `subscription_billing`, and a run reads that table before it
// bills anything. A run that is a month late catches up period by period; a
// run started twice by two people bills nothing the second time.
//
// Money and revenue are different questions. Billing a year up front is one
// cash event and twelve earning events. The invoice lines carry the service
// period they cover, so the revenue recognition schedules already in Meridian
// pick them up without knowing subscriptions exist.
//
// A change has a date. Ten seats added on the 12th bill for the rest of the
// month, not the whole of it, and the amendment is kept so the invoice can be
// explained to whoever queries it.
import { ulid, Money, Qty, nowIso, today, isValidDate, addDays, addMonths, daysBetween, sum } from '../core/util.mjs';
import { ValidationError, notFound, unprocessable, conflict } from '../core/http.mjs';
import { nextNumber } from '../core/seq.mjs';
import * as gl from './gl.mjs';
import * as T from './txn.mjs';
import * as entities from './entities.mjs';
import * as audit from '../core/audit.mjs';
import { reportingCurrency } from './collections.mjs';

export const FREQUENCIES = ['monthly', 'quarterly', 'annually'];
export const MODELS = ['recurring', 'one_time', 'usage'];
export const STATUSES = ['draft', 'active', 'suspended', 'cancelled', 'expired'];
const STEP = { monthly: 1, quarterly: 3, annually: 12 };
/** Months in a period, used to normalise everything to a monthly figure. */
const MONTHS = { monthly: 1, quarterly: 3, annually: 12 };

// ------------------------------------------------------------- the calendar
/**
 * Where the period starting at `from` ends.
 *
 * With no billing day, periods run from anniversary to anniversary. With one,
 * the first period is short — from the start date to the next occurrence of
 * that day — and every period after it runs day-to-day, so a hundred
 * customers land on one date instead of a hundred.
 */
export function periodEnd(subscription, from) {
  const step = STEP[subscription.billing_frequency] || 1;
  const day = Number(subscription.billing_day) || 0;
  if (!day) return addMonths(from, step);

  const capped = Math.min(Math.max(day, 1), 28);
  const inThisMonth = `${from.slice(0, 8)}${String(capped).padStart(2, '0')}`;
  // Already on the billing day: a whole period from here.
  if (inThisMonth === from) return addMonths(from, step);
  // Before it: the short first period that brings us onto the cycle.
  if (inThisMonth > from) return inThisMonth;
  // Past it this month: the next occurrence.
  return `${addMonths(from, 1).slice(0, 8)}${String(capped).padStart(2, '0')}`;
}

/** What fraction of a whole period the window [start, end) covers. */
export function prorationFor(subscription, start, end) {
  const full = addMonths(start, STEP[subscription.billing_frequency] || 1);
  const whole = daysBetween(start, full);
  const actual = daysBetween(start, end);
  if (whole <= 0) return 1;
  return Math.min(1, Math.max(0, actual / whole));
}

const overlap = (aStart, aEnd, bStart, bEnd) => {
  const start = aStart > bStart ? aStart : bStart;
  const end = (aEnd < bEnd ? aEnd : bEnd);
  return start < end ? { start, end } : null;
};

// ------------------------------------------------------------------- read
export function getSubscription(repo, id) {
  const s = repo.get('subscription', id);
  if (!s) throw notFound('Subscription not found');
  return {
    ...s,
    customer: repo.get('customer', s.customer_id),
    lines: linesFor(repo, id),
    changes: repo.query(
      'SELECT * FROM subscription_change WHERE tenant_id = :t AND subscription_id = ? ORDER BY effective_date DESC, created_at DESC LIMIT 50', [id]),
  };
}

export const linesFor = (repo, id) => repo.query(
  `SELECT l.*, i.sku, i.name AS item_name, i.uom
   FROM subscription_line l JOIN item i ON i.tenant_id = l.tenant_id AND i.id = l.item_id
   WHERE l.tenant_id = :t AND l.subscription_id = ? ORDER BY l.line_no`, [id]);

export const billingHistory = (repo, id, limit = 200) => repo.query(
  `SELECT b.*, i.sku, i.name AS item_name, t.txn_no, t.txn_date, t.status AS invoice_status
   FROM subscription_billing b
   JOIN subscription_line l ON l.tenant_id = b.tenant_id AND l.id = b.line_id
   JOIN item i ON i.tenant_id = l.tenant_id AND i.id = l.item_id
   LEFT JOIN txn t ON t.tenant_id = b.tenant_id AND t.id = b.invoice_txn_id
   WHERE b.tenant_id = :t AND b.subscription_id = ?
   ORDER BY b.period_start DESC, l.line_no LIMIT ?`, [id, Number(limit) || 200]);

export function list(repo, { status = null, customer_id = null, limit = 200 } = {}) {
  const where = ['s.tenant_id = :t'];
  const params = [];
  if (status && status !== 'all') { where.push('s.status = ?'); params.push(status); }
  if (customer_id) { where.push('s.customer_id = ?'); params.push(customer_id); }
  params.push(Number(limit) || 200);
  const rows = repo.query(
    `SELECT s.*, c.name AS customer_name, c.entity_no AS customer_no,
            (SELECT COUNT(*) FROM subscription_line l
              WHERE l.tenant_id = s.tenant_id AND l.subscription_id = s.id AND l.status = 'active') AS line_count
     FROM subscription s
     JOIN customer c ON c.tenant_id = s.tenant_id AND c.id = s.customer_id
     WHERE ${where.join(' AND ')} ORDER BY s.next_bill_date, s.subscription_no LIMIT ?`, params);
  return { rows, total: rows.length };
}

/** Everything due to be billed on or before `through`. */
export const due = (repo, { through = today() } = {}) => {
  if (!isValidDate(through)) throw new ValidationError({ through: 'Enter a valid date' });
  return repo.query(
    `SELECT s.*, c.name AS customer_name FROM subscription s
     JOIN customer c ON c.tenant_id = s.tenant_id AND c.id = s.customer_id
     WHERE s.tenant_id = :t AND s.status = 'active' AND s.next_bill_date IS NOT NULL
       AND s.next_bill_date <= ?
     ORDER BY s.next_bill_date, s.subscription_no`, [through]);
};

// ------------------------------------------------------------------ write
function validate(repo, input, { partial = false } = {}) {
  const errors = {};
  if ((!partial || input.customer_id !== undefined) && !input.customer_id) errors.customer_id = 'Which customer is this for?';
  if ((!partial || input.start_date !== undefined) && !isValidDate(input.start_date)) errors.start_date = 'A valid start date is required';
  if (input.billing_frequency && !FREQUENCIES.includes(input.billing_frequency)) {
    errors.billing_frequency = `Bill ${FREQUENCIES.join(', ')}`;
  }
  if (input.billing_day !== undefined) {
    const day = Number(input.billing_day);
    if (!Number.isInteger(day) || day < 0 || day > 28) {
      errors.billing_day = 'A billing day is 1 to 28, or 0 to bill on the start date’s anniversary';
    }
  }
  if (input.term_months !== undefined && Number(input.term_months) < 0) errors.term_months = 'A term cannot be negative';
  if (input.end_date && !isValidDate(input.end_date)) errors.end_date = 'Enter a valid end date';
  if (input.end_date && input.start_date && input.end_date <= input.start_date) {
    errors.end_date = 'The end date is on or before the start date';
  }
  return errors;
}

function prepareLines(repo, lines, subscription) {
  if (!Array.isArray(lines) || !lines.length) {
    throw new ValidationError({ lines: 'A subscription needs at least one line — what is being sold?' });
  }
  const errors = {};
  const out = [];
  lines.forEach((l, i) => {
    if (!l.item_id) { errors[`lines.${i}.item_id`] = 'Item is required'; return; }
    const item = repo.get('item', l.item_id);
    if (!item) { errors[`lines.${i}.item_id`] = 'That item does not exist'; return; }
    const model = l.model || 'recurring';
    if (!MODELS.includes(model)) { errors[`lines.${i}.model`] = `Model must be one of ${MODELS.join(', ')}`; return; }

    const quantity = Qty.parse(l.quantity ?? 1);
    if (quantity < 0) { errors[`lines.${i}.quantity`] = 'A quantity cannot be negative'; return; }
    const unitPrice = Money.parse(l.unit_price ?? Money.toNumber(item.base_price || 0));
    if (unitPrice < 0) { errors[`lines.${i}.unit_price`] = 'A price cannot be negative'; return; }

    const start = l.start_date || subscription.start_date;
    if (!isValidDate(start)) { errors[`lines.${i}.start_date`] = 'Enter a valid start date'; return; }
    if (l.end_date && !isValidDate(l.end_date)) { errors[`lines.${i}.end_date`] = 'Enter a valid end date'; return; }
    if (l.end_date && l.end_date <= start) { errors[`lines.${i}.end_date`] = 'The line ends before it starts'; return; }
    if (start < subscription.start_date) {
      errors[`lines.${i}.start_date`] = 'A line cannot start before the subscription does';
      return;
    }
    // A usage line with no unit of measure is a meter with no dial on it.
    out.push({
      line_no: i + 1, item_id: item.id,
      description: l.description || item.name,
      model, quantity, unit_price: unitPrice,
      discount_pct: Number(l.discount_pct) || 0,
      start_date: start, end_date: l.end_date || null,
      usage_uom: model === 'usage' ? (l.usage_uom || item.uom || 'units') : '',
      included_quantity: model === 'usage' ? Qty.parse(l.included_quantity ?? 0) : 0,
      status: 'active',
    });
  });
  if (Object.keys(errors).length) throw new ValidationError(errors, 'Some subscription lines are invalid');
  return out;
}

/**
 * Monthly recurring revenue: everything normalised to a month.
 *
 * Only lines that are still live count. An amendment supersedes a line by
 * giving it an end date rather than deleting it — the periods it billed have
 * to keep pointing at something — so a superseded line is still `active` and
 * would otherwise be counted alongside the line that replaced it, doubling
 * the figure every time somebody changed a quantity.
 */
export function computeMrr(subscription, lines, asOf = today()) {
  const months = MONTHS[subscription.billing_frequency] || 1;
  const live = lines.filter((l) => l.status === 'active'
    && l.model === 'recurring'
    && (!l.end_date || l.end_date > asOf));
  return Math.round(sum(
    live,
    (l) => (Qty.extend(l.quantity, l.unit_price) * (1 - (l.discount_pct || 0) / 100)) / months,
  ));
}

const refreshMrr = (repo, id) => {
  const s = repo.get('subscription', id);
  repo.update('subscription', id, { mrr: computeMrr(s, linesFor(repo, id)), updated_at: nowIso() });
};

export function createSubscription(repo, input) {
  const errors = validate(repo, input);
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const customer = entities.getCustomer(repo, input.customer_id);

  const draft = {
    start_date: input.start_date,
    billing_frequency: input.billing_frequency || 'monthly',
    billing_day: Number(input.billing_day) || 0,
  };
  const term = Number(input.term_months) || 0;
  const endDate = input.end_date || (term ? addDays(addMonths(input.start_date, term), -1) : null);

  const now = nowIso();
  const id = ulid();
  repo.insert('subscription', {
    id, subscription_no: nextNumber(repo, 'subscription'),
    customer_id: customer.id,
    subsidiary_id: input.subsidiary_id || customer.subsidiary_id,
    name: input.name || `${customer.name} — ${draft.billing_frequency}`,
    currency: input.currency || customer.currency || 'USD',
    price_level_id: input.price_level_id || customer.price_level_id || null,
    start_date: input.start_date, end_date: endDate, term_months: term,
    billing_frequency: draft.billing_frequency, billing_day: draft.billing_day,
    bill_in_advance: input.bill_in_advance === false ? 0 : 1,
    billed_through: null, next_bill_date: null,
    auto_renew: input.auto_renew === false ? 0 : 1,
    renewal_term_months: Number(input.renewal_term_months) || term,
    renewal_count: 0,
    status: 'draft',
    po_number: input.po_number || '', memo: input.memo || '', mrr: 0,
    activated_at: null, cancelled_at: null, cancel_reason: '',
    created_at: now, created_by: repo.ctx?.user?.id || null, updated_at: now,
  });

  const subscription = repo.get('subscription', id);
  for (const l of prepareLines(repo, input.lines, subscription)) {
    repo.insert('subscription_line', { id: ulid(), subscription_id: id, ...l, created_at: now, updated_at: now });
  }
  refreshMrr(repo, id);
  audit.record(repo, { recordType: 'subscription', recordId: id, action: 'create', after: input });

  if (input.activate) activate(repo, id);
  return getSubscription(repo, id);
}

export function updateSubscription(repo, id, patch) {
  const before = getSubscription(repo, id);
  if (['cancelled', 'expired'].includes(before.status)) {
    throw conflict(`${before.subscription_no} is ${before.status} and can no longer be changed.`);
  }
  const merged = { ...before, ...patch };
  const errors = validate(repo, merged, { partial: true });
  if (Object.keys(errors).length) throw new ValidationError(errors);

  // The terms that decide what has already been billed are fixed once
  // billing has started; changing them would restate invoices already sent.
  if (before.billed_through) {
    for (const field of ['start_date', 'billing_frequency', 'billing_day', 'bill_in_advance']) {
      if (patch[field] !== undefined && String(patch[field]) !== String(before[field])) {
        throw unprocessable(`${before.subscription_no} has already been billed to ${before.billed_through}; its ${field.replace(/_/g, ' ')} cannot change now. Cancel it and start a new one.`);
      }
    }
  }

  const changes = { updated_at: nowIso() };
  for (const field of ['name', 'memo', 'po_number', 'currency', 'price_level_id']) {
    if (patch[field] !== undefined) changes[field] = patch[field] || (field === 'price_level_id' ? null : '');
  }
  for (const field of ['start_date', 'billing_frequency', 'billing_day']) {
    if (patch[field] !== undefined) changes[field] = patch[field];
  }
  if (patch.bill_in_advance !== undefined) changes.bill_in_advance = patch.bill_in_advance ? 1 : 0;
  if (patch.auto_renew !== undefined) changes.auto_renew = patch.auto_renew ? 1 : 0;
  if (patch.term_months !== undefined) {
    changes.term_months = Number(patch.term_months) || 0;
    changes.end_date = changes.term_months
      ? addDays(addMonths(merged.start_date, changes.term_months), -1)
      : null;
  }
  if (patch.renewal_term_months !== undefined) changes.renewal_term_months = Number(patch.renewal_term_months) || 0;
  if (patch.end_date !== undefined) changes.end_date = patch.end_date || null;
  repo.update('subscription', id, changes);

  if (patch.lines !== undefined) {
    if (before.billed_through) {
      throw unprocessable(`${before.subscription_no} has already been billed. Add, change or remove lines with an amendment so the change carries a date.`);
    }
    const lines = prepareLines(repo, patch.lines, { ...before, ...changes });
    repo.exec('DELETE FROM subscription_line WHERE tenant_id = :t AND subscription_id = ?', [id]);
    const now = nowIso();
    for (const l of lines) repo.insert('subscription_line', { id: ulid(), subscription_id: id, ...l, created_at: now, updated_at: now });
  }
  refreshMrr(repo, id);
  audit.record(repo, { recordType: 'subscription', recordId: id, action: 'update', before, after: merged });
  return getSubscription(repo, id);
}

/** Start it billing. A draft bills nothing, however overdue it looks. */
export function activate(repo, id) {
  const s = repo.get('subscription', id);
  if (!s) throw notFound('Subscription not found');
  if (s.status === 'active') return getSubscription(repo, id);
  if (['cancelled', 'expired'].includes(s.status)) throw conflict(`${s.subscription_no} is ${s.status}.`);
  if (!linesFor(repo, id).length) throw unprocessable(`${s.subscription_no} has no lines, so there is nothing to bill.`);

  const now = nowIso();
  repo.update('subscription', id, {
    status: 'active',
    activated_at: s.activated_at || now,
    billed_through: s.billed_through || s.start_date,
    next_bill_date: s.next_bill_date || firstBillDate(s),
    updated_at: now,
  });
  // Dated from when it starts billing rather than from when somebody pressed
  // the button, so the amendment history reads in the order things happened.
  recordChange(repo, id, { kind: 'activate', effective_date: s.start_date, to_value: 'active', note: 'Started billing' });
  audit.record(repo, { recordType: 'subscription', recordId: id, action: 'activate', before: s });
  return getSubscription(repo, id);
}

/** Advance billing raises the invoice at the start; arrears at the end. */
function firstBillDate(subscription) {
  if (subscription.bill_in_advance) return subscription.start_date;
  return periodEnd(subscription, subscription.start_date);
}

export function suspend(repo, id, { reason = '' } = {}) {
  const s = repo.get('subscription', id);
  if (!s) throw notFound('Subscription not found');
  if (s.status !== 'active') throw conflict(`${s.subscription_no} is ${s.status}, not active.`);
  repo.update('subscription', id, { status: 'suspended', updated_at: nowIso() });
  recordChange(repo, id, { kind: 'suspend', effective_date: today(), from_value: 'active', to_value: 'suspended', note: reason });
  audit.record(repo, { recordType: 'subscription', recordId: id, action: 'suspend', changes: { reason: { from: null, to: reason } } });
  return getSubscription(repo, id);
}

export function resume(repo, id) {
  const s = repo.get('subscription', id);
  if (!s) throw notFound('Subscription not found');
  if (s.status !== 'suspended') throw conflict(`${s.subscription_no} is ${s.status}, not suspended.`);
  repo.update('subscription', id, { status: 'active', updated_at: nowIso() });
  recordChange(repo, id, { kind: 'resume', effective_date: today(), from_value: 'suspended', to_value: 'active' });
  audit.record(repo, { recordType: 'subscription', recordId: id, action: 'resume' });
  return getSubscription(repo, id);
}

/**
 * End it.
 *
 * Billing stops at the effective date; what has already been billed stays
 * billed. Cancelling mid-period does not claw anything back on its own —
 * whether the customer gets that money back is a commercial decision, so it
 * is a credit memo somebody raises deliberately.
 */
export function cancel(repo, id, { effective_date = null, reason = '' } = {}) {
  const s = repo.get('subscription', id);
  if (!s) throw notFound('Subscription not found');
  if (['cancelled', 'expired'].includes(s.status)) throw conflict(`${s.subscription_no} is already ${s.status}.`);
  const when = effective_date || today();
  if (!isValidDate(when)) throw new ValidationError({ effective_date: 'Enter a valid date' });

  const now = nowIso();
  repo.update('subscription', id, {
    status: 'cancelled', cancelled_at: now, cancel_reason: reason || '',
    end_date: when, next_bill_date: null, updated_at: now,
  });
  recordChange(repo, id, { kind: 'cancel', effective_date: when, from_value: s.status, to_value: 'cancelled', note: reason });
  audit.record(repo, {
    recordType: 'subscription', recordId: id, action: 'cancel',
    changes: { effective: { from: null, to: when }, reason: { from: null, to: reason } },
  });
  return getSubscription(repo, id);
}

// -------------------------------------------------------------- amendments
const recordChange = (repo, id, change) => repo.insert('subscription_change', {
  id: ulid(), subscription_id: id, line_id: change.line_id || null,
  effective_date: change.effective_date, kind: change.kind,
  from_value: String(change.from_value ?? ''), to_value: String(change.to_value ?? ''),
  note: change.note || '', created_at: nowIso(), created_by: repo.ctx?.user?.id || null,
});

/**
 * Change a line part way through.
 *
 * The change carries a date. Everything already billed stays billed; the next
 * run prices the part of the period before the change at the old figure and
 * the part after it at the new one, which is what proration is for.
 */
export function amend(repo, id, input = {}) {
  const s = repo.get('subscription', id);
  if (!s) throw notFound('Subscription not found');
  if (['cancelled', 'expired'].includes(s.status)) throw conflict(`${s.subscription_no} is ${s.status}.`);
  const when = input.effective_date || today();
  if (!isValidDate(when)) throw new ValidationError({ effective_date: 'Enter a valid date' });
  if (s.billed_through && when < s.billed_through) {
    throw unprocessable(`${s.subscription_no} has been billed to ${s.billed_through}. An amendment cannot take effect before that, because the invoice has gone out. Date it ${s.billed_through} or later.`);
  }

  const now = nowIso();
  const kind = input.kind || 'quantity';

  if (kind === 'add') {
    const [line] = prepareLines(repo, [{ ...input.line, start_date: when }], s);
    const nextNo = (repo.scalar('SELECT COALESCE(MAX(line_no), 0) n FROM subscription_line WHERE tenant_id = :t AND subscription_id = ?', [id], 0)) + 1;
    const lineId = repo.insert('subscription_line', {
      id: ulid(), subscription_id: id, ...line, line_no: nextNo, created_at: now, updated_at: now,
    });
    recordChange(repo, id, { kind: 'add', line_id: lineId, effective_date: when, to_value: line.description, note: input.note });
    refreshMrr(repo, id);
    audit.record(repo, { recordType: 'subscription', recordId: id, action: 'amend', changes: { added: { from: null, to: line.description } } });
    return getSubscription(repo, id);
  }

  const line = repo.get('subscription_line', input.line_id);
  if (!line || line.subscription_id !== id) throw new ValidationError({ line_id: 'That line is not on this subscription' });

  if (kind === 'remove') {
    // Kept, not deleted: it was billed for real periods and those invoices
    // have to keep pointing at something.
    repo.update('subscription_line', line.id, { end_date: when, status: 'removed', updated_at: now });
    recordChange(repo, id, { kind: 'remove', line_id: line.id, effective_date: when, from_value: line.description, note: input.note });
  } else if (kind === 'quantity') {
    const quantity = Qty.parse(input.quantity);
    if (quantity < 0) throw new ValidationError({ quantity: 'A quantity cannot be negative' });
    // A quantity change is a line ending and another beginning, so each
    // period is priced at whatever was true during it.
    repo.update('subscription_line', line.id, { end_date: when, updated_at: now });
    const nextNo = (repo.scalar('SELECT COALESCE(MAX(line_no), 0) n FROM subscription_line WHERE tenant_id = :t AND subscription_id = ?', [id], 0)) + 1;
    const replacement = repo.insert('subscription_line', {
      id: ulid(), subscription_id: id, line_no: nextNo,
      item_id: line.item_id, description: line.description, model: line.model,
      quantity, unit_price: line.unit_price, discount_pct: line.discount_pct,
      start_date: when, end_date: line.end_date && line.end_date > when ? line.end_date : null,
      usage_uom: line.usage_uom, included_quantity: line.included_quantity,
      status: 'active', created_at: now, updated_at: now,
    });
    recordChange(repo, id, {
      kind: 'quantity', line_id: replacement, effective_date: when,
      from_value: Qty.toNumber(line.quantity), to_value: Qty.toNumber(quantity), note: input.note,
    });
  } else if (kind === 'price') {
    const unitPrice = Money.parse(input.unit_price);
    if (unitPrice < 0) throw new ValidationError({ unit_price: 'A price cannot be negative' });
    repo.update('subscription_line', line.id, { end_date: when, updated_at: now });
    const nextNo = (repo.scalar('SELECT COALESCE(MAX(line_no), 0) n FROM subscription_line WHERE tenant_id = :t AND subscription_id = ?', [id], 0)) + 1;
    const replacement = repo.insert('subscription_line', {
      id: ulid(), subscription_id: id, line_no: nextNo,
      item_id: line.item_id, description: line.description, model: line.model,
      quantity: line.quantity, unit_price: unitPrice, discount_pct: line.discount_pct,
      start_date: when, end_date: line.end_date && line.end_date > when ? line.end_date : null,
      usage_uom: line.usage_uom, included_quantity: line.included_quantity,
      status: 'active', created_at: now, updated_at: now,
    });
    recordChange(repo, id, {
      kind: 'price', line_id: replacement, effective_date: when,
      from_value: Money.toNumber(line.unit_price), to_value: Money.toNumber(unitPrice), note: input.note,
    });
  } else {
    throw new ValidationError({ kind: 'An amendment adds, removes, or changes a quantity or a price' });
  }

  refreshMrr(repo, id);
  audit.record(repo, { recordType: 'subscription', recordId: id, action: 'amend', changes: { kind: { from: null, to: kind }, effective: { from: null, to: when } } });
  return getSubscription(repo, id);
}

// ------------------------------------------------------------------- usage
export function recordUsage(repo, id, input = {}) {
  const s = repo.get('subscription', id);
  if (!s) throw notFound('Subscription not found');
  const line = repo.get('subscription_line', input.line_id);
  if (!line || line.subscription_id !== id) throw new ValidationError({ line_id: 'That line is not on this subscription' });
  if (line.model !== 'usage') throw unprocessable(`${line.description} is not metered, so there is no usage to record against it.`);

  const when = input.usage_date || today();
  if (!isValidDate(when)) throw new ValidationError({ usage_date: 'Enter a valid date' });
  const quantity = Qty.parse(input.quantity);
  if (!quantity) throw new ValidationError({ quantity: 'Enter a quantity' });
  // Usage inside a period already invoiced would never be charged, because
  // the run that would have charged it has been and gone.
  if (s.billed_through && when < s.billed_through) {
    throw unprocessable(`Usage on ${when} falls in a period already billed (up to ${s.billed_through}). Record it in the current period, or raise it separately.`);
  }

  const usageId = repo.insert('subscription_usage', {
    id: ulid(), subscription_id: id, line_id: line.id, usage_date: when,
    quantity, memo: input.memo || '', billing_id: null,
    created_at: nowIso(), created_by: repo.ctx?.user?.id || null,
  });
  return repo.get('subscription_usage', usageId);
}

export const usageFor = (repo, id, { from = null, to = null } = {}) => {
  const where = ['u.tenant_id = :t', 'u.subscription_id = ?'];
  const params = [id];
  if (from) { where.push('u.usage_date >= ?'); params.push(from); }
  if (to) { where.push('u.usage_date < ?'); params.push(to); }
  return repo.query(
    `SELECT u.*, l.description, l.usage_uom FROM subscription_usage u
     JOIN subscription_line l ON l.tenant_id = u.tenant_id AND l.id = u.line_id
     WHERE ${where.join(' AND ')} ORDER BY u.usage_date DESC, u.created_at DESC`, params);
};

// ----------------------------------------------------------------- billing
/**
 * What the next invoice for this subscription would contain.
 *
 * Nothing is written. The screen shows this before anybody bills, and the run
 * itself calls the same function, so what is previewed is what is posted.
 */
export function previewNext(repo, id, { through = today() } = {}) {
  const s = repo.get('subscription', id);
  if (!s) throw notFound('Subscription not found');
  const lines = linesFor(repo, id);
  const periods = [];

  let cursor = s.billed_through || s.start_date;
  // Guarded rather than open-ended: a subscription left unbilled for years
  // should catch up, not run forever.
  for (let guard = 0; guard < 120; guard++) {
    const end = periodEnd(s, cursor);
    const billOn = s.bill_in_advance ? cursor : end;
    if (billOn > through) break;
    if (s.end_date && cursor > s.end_date) break;
    const charges = chargesFor(repo, s, lines, cursor, end);
    if (charges.length) periods.push({ period_start: cursor, period_end: end, bill_on: billOn, charges, total: sum(charges, (c) => c.amount) });
    cursor = end;
  }
  return {
    subscription: s, periods,
    total: sum(periods, (p) => p.total),
    billed_through: cursor,
    ready: periods.length > 0,
  };
}

/** Every charge a line makes for the window [start, end). */
function chargesFor(repo, subscription, lines, start, end) {
  const out = [];
  for (const line of lines) {
    const lineStart = line.start_date || subscription.start_date;
    const lineEnd = line.end_date || null;
    const window = overlap(start, end, lineStart, lineEnd || '9999-12-31');
    if (!window) continue;

    if (line.model === 'one_time') {
      // Charged once, in the period its start date falls in.
      const already = repo.scalar(
        'SELECT COUNT(*) c FROM subscription_billing WHERE tenant_id = :t AND line_id = ?', [line.id], 0);
      if (already) continue;
      if (lineStart < start || lineStart >= end) continue;
      out.push({
        line, model: 'one_time', period_start: start, period_end: end,
        quantity: line.quantity, unit_price: line.unit_price, proration: 1, prorated: 0,
        amount: discounted(Qty.extend(line.quantity, line.unit_price), line.discount_pct),
        detail: 'One-off charge',
      });
      continue;
    }

    if (line.model === 'usage') {
      // Metered charges are billed for the period that has ended, because
      // that is when the quantity is finally known.
      const rows = repo.query(
        `SELECT * FROM subscription_usage
         WHERE tenant_id = :t AND line_id = ? AND billing_id IS NULL
           AND usage_date >= ? AND usage_date < ?`, [line.id, window.start, window.end]);
      const used = sum(rows, (r) => r.quantity);
      if (!used) continue;
      const chargeable = Math.max(0, used - (line.included_quantity || 0));
      if (!chargeable) {
        out.push({
          line, model: 'usage', period_start: window.start, period_end: window.end,
          quantity: 0, unit_price: line.unit_price, proration: 1, prorated: 0, amount: 0,
          usage_ids: rows.map((r) => r.id),
          detail: `${Qty.toNumber(used)} ${line.usage_uom} used, all within the ${Qty.toNumber(line.included_quantity)} included`,
        });
        continue;
      }
      out.push({
        line, model: 'usage', period_start: window.start, period_end: window.end,
        quantity: chargeable, unit_price: line.unit_price, proration: 1, prorated: 0,
        amount: discounted(Qty.extend(chargeable, line.unit_price), line.discount_pct),
        usage_ids: rows.map((r) => r.id),
        detail: line.included_quantity
          ? `${Qty.toNumber(used)} ${line.usage_uom} used, ${Qty.toNumber(line.included_quantity)} included`
          : `${Qty.toNumber(used)} ${line.usage_uom} used`,
      });
      continue;
    }

    // Recurring. A line that covers only part of the period is prorated.
    const already = repo.queryOne(
      'SELECT id FROM subscription_billing WHERE tenant_id = :t AND line_id = ? AND period_start = ?',
      [line.id, window.start]);
    if (already) continue;

    const proration = prorationFor(subscription, start, end) === 1 && window.start === start && window.end === end
      ? 1
      : partialFactor(subscription, start, end, window);
    if (proration <= 0) continue;
    const full = discounted(Qty.extend(line.quantity, line.unit_price), line.discount_pct);
    out.push({
      line, model: 'recurring', period_start: window.start, period_end: window.end,
      quantity: line.quantity, unit_price: line.unit_price,
      proration, prorated: proration < 1 ? 1 : 0,
      amount: Math.round(full * proration),
      detail: proration < 1
        ? `${daysBetween(window.start, window.end)} of ${daysBetween(start, addMonths(start, STEP[subscription.billing_frequency] || 1))} days`
        : '',
    });
  }
  return out;
}

/**
 * How much of a whole period this line actually covers.
 *
 * Measured against a whole period rather than against the period being
 * billed, so a line that runs for half of an already-short first period is
 * charged for half of a short period rather than half of a full one.
 */
function partialFactor(subscription, periodStart, periodEnd_, window) {
  const wholeEnd = addMonths(periodStart, STEP[subscription.billing_frequency] || 1);
  const whole = daysBetween(periodStart, wholeEnd);
  if (whole <= 0) return 1;
  void periodEnd_;
  return Math.min(1, Math.max(0, daysBetween(window.start, window.end) / whole));
}

const discounted = (amount, pct) => Math.round(amount * (1 - (Number(pct) || 0) / 100));

/**
 * Bill everything due.
 *
 * One invoice per subscription per run, carrying every period it owes —
 * because a subscription three months behind should produce one invoice with
 * three months on it, not three invoices a customer has to reconcile.
 */
export function runBilling(repo, { through = today(), id = null, dry_run = false, txn_date = null } = {}) {
  if (!isValidDate(through)) throw new ValidationError({ through: 'Enter a valid date' });
  const targets = id
    ? [repo.get('subscription', id)].filter(Boolean)
    : due(repo, { through });
  if (id && !targets.length) throw notFound('Subscription not found');

  const invoiced = [];
  const skipped = [];

  for (const s of targets) {
    if (s.status !== 'active') { skipped.push({ subscription_no: s.subscription_no, reason: `it is ${s.status}` }); continue; }
    const plan = previewNext(repo, s.id, { through });
    if (!plan.periods.length) { skipped.push({ subscription_no: s.subscription_no, reason: 'nothing is due yet' }); continue; }

    const invoiceDate = txn_date || plan.periods[plan.periods.length - 1].bill_on;
    if (!dry_run) {
      const period = gl.periodForDate(repo, invoiceDate);
      if (!period || period.status !== 'open') {
        skipped.push({
          subscription_no: s.subscription_no,
          reason: period ? `${period.name} is ${period.status}` : `no accounting period covers ${invoiceDate}`,
        });
        continue;
      }
    }

    const charges = plan.periods.flatMap((p) => p.charges);
    const total = sum(charges, (c) => c.amount);
    // Usage that stayed inside the included allowance is a real event with a
    // quantity of nothing to charge for. It is recorded so the same usage can
    // never be billed twice, but it does not go on the invoice: an invoice
    // line for nought is a question the customer has to ring up about.
    const billable = charges.filter((c) => c.quantity > 0);

    if (dry_run) {
      invoiced.push({
        subscription_id: s.id, subscription_no: s.subscription_no, customer_id: s.customer_id,
        customer_name: repo.get('customer', s.customer_id)?.name || '',
        periods: plan.periods.length, lines: billable.length,
        currency: s.currency, amount: total, txn_date: invoiceDate,
        billed_through: plan.billed_through,
      });
      continue;
    }

    const invoice = !billable.length ? null : T.createTxn(repo, 'INVOICE', {
      entity_id: s.customer_id, subsidiary_id: s.subsidiary_id, txn_date: invoiceDate,
      currency: s.currency, price_level_id: s.price_level_id || undefined,
      memo: s.name || `Subscription ${s.subscription_no}`,
      reference: s.po_number || s.subscription_no,
      lines: billable.map((c) => ({
        item_id: c.line.item_id,
        description: periodLabel(c),
        quantity: Qty.toNumber(c.model === 'recurring' ? c.quantity : c.quantity),
        // The period's price after proration and discount, expressed as a
        // unit price so the invoice line multiplies back to the same figure.
        unit_price: Money.toNumber(unitFor(c)),
        // What the schedules need in order to earn it over the right months.
        service_start: c.period_start,
        service_end: addDays(c.period_end, -1),
      })),
    });
    if (invoice) repo.update('txn', invoice.id, { subscription_id: s.id });

    const now = nowIso();
    for (const c of charges) {
      const billingId = repo.insert('subscription_billing', {
        id: ulid(), subscription_id: s.id, line_id: c.line.id,
        period_start: c.period_start, period_end: c.period_end,
        quantity: c.quantity, unit_price: c.unit_price, amount: c.amount,
        prorated: c.prorated, proration: c.proration,
        invoice_txn_id: invoice ? invoice.id : null, created_at: now,
      });
      for (const usageId of c.usage_ids || []) repo.update('subscription_usage', usageId, { billing_id: billingId });
    }

    const nextDate = nextBillDateAfter(s, plan.billed_through);
    repo.update('subscription', s.id, {
      billed_through: plan.billed_through,
      next_bill_date: nextDate,
      updated_at: now,
    });
    // A subscription that has billed to the end of its term either renews or
    // stops here, rather than quietly carrying on.
    if (s.end_date && plan.billed_through > s.end_date) closeTerm(repo, s.id);

    invoiced.push({
      subscription_id: s.id, subscription_no: s.subscription_no,
      customer_id: s.customer_id, customer_name: repo.get('customer', s.customer_id)?.name || '',
      invoice_id: invoice ? invoice.id : null,
      txn_no: invoice ? invoice.txn_no : null,
      txn_date: invoiceDate,
      periods: plan.periods.length, lines: billable.length,
      currency: s.currency, amount: total, billed_through: plan.billed_through,
      note: invoice ? '' : 'Usage stayed within the included allowance, so there was nothing to invoice.',
    });
  }

  if (!dry_run && invoiced.length) {
    audit.record(repo, {
      recordType: 'subscription', recordId: id, action: 'bill',
      changes: { through: { from: null, to: through }, invoices: { from: 0, to: invoiced.length } },
    });
  }
  return {
    through, dry_run: !!dry_run,
    invoiced, skipped,
    count: invoiced.length,
    amount: sum(invoiced, (i) => i.amount),
  };
}

const unitFor = (charge) => (charge.quantity ? Math.round((charge.amount * 1_000_000) / charge.quantity) : charge.amount);

function periodLabel(charge) {
  const last = addDays(charge.period_end, -1);
  const base = charge.line.description;
  if (charge.model === 'one_time') return base;
  const period = `${charge.period_start} to ${last}`;
  if (charge.model === 'usage') return `${base} — ${period} (${charge.detail})`;
  return charge.prorated ? `${base} — ${period} (${charge.detail})` : `${base} — ${period}`;
}

function nextBillDateAfter(subscription, billedThrough) {
  if (subscription.end_date && billedThrough > subscription.end_date) return null;
  return subscription.bill_in_advance ? billedThrough : periodEnd(subscription, billedThrough);
}

/** The term is up: renew it, or let it expire. */
function closeTerm(repo, id) {
  const s = repo.get('subscription', id);
  const now = nowIso();
  if (!s.auto_renew) {
    repo.update('subscription', id, { status: 'expired', next_bill_date: null, updated_at: now });
    recordChange(repo, id, { kind: 'cancel', effective_date: s.end_date, from_value: 'active', to_value: 'expired', note: 'Term ended and auto-renew is off' });
    return;
  }
  const term = Number(s.renewal_term_months) || Number(s.term_months) || 12;
  const newEnd = addDays(addMonths(addDays(s.end_date, 1), term), -1);
  repo.update('subscription', id, {
    end_date: newEnd, renewal_count: (s.renewal_count || 0) + 1,
    next_bill_date: s.billed_through, updated_at: now,
  });
  recordChange(repo, id, { kind: 'renew', effective_date: addDays(s.end_date, 1), from_value: s.end_date, to_value: newEnd, note: `Renewed for ${term} months` });
}

// --------------------------------------------------------------- reporting
/**
 * Recurring revenue, and what is happening to it.
 *
 * MRR is the figure a subscription business is actually run on, and it is
 * worth stating exactly what it means here: the monthly value of active
 * recurring lines, ignoring one-off charges and metered usage, because
 * neither recurs.
 */
export function recurringRevenue(repo, { as_of = today(), subsidiary_id = null } = {}) {
  const where = ['s.tenant_id = :t', "s.status IN ('active','suspended')"];
  const params = [];
  if (subsidiary_id) { where.push('s.subsidiary_id = ?'); params.push(subsidiary_id); }
  const rows = repo.query(
    `SELECT s.*, c.name AS customer_name FROM subscription s
     JOIN customer c ON c.tenant_id = s.tenant_id AND c.id = s.customer_id
     WHERE ${where.join(' AND ')} ORDER BY s.mrr DESC`, params);

  const active = rows.filter((r) => r.status === 'active');

  // A sterling contract and a dollar contract are not one number until they
  // are put in the same currency. Converted at the rate on the day it is
  // being asked, because MRR is a question about what the book is worth now.
  const currency = subsidiary_id ? gl.subsidiaryCurrency(repo, subsidiary_id) : reportingCurrency(repo);
  const rates = new Map([[currency, 1]]);
  const missing = new Set();
  const rateFor = (from) => {
    if (!rates.has(from)) {
      // A missing rate must not take the whole screen down with it. The
      // contract is left out of the total and said so by name, which is more
      // use than a number that is quietly wrong.
      try { rates.set(from, gl.exchangeRate(repo, from, currency, as_of)); } catch { rates.set(from, null); missing.add(from); }
    }
    return rates.get(from);
  };
  const inBase = (r) => {
    const rate = rateFor(r.currency);
    return rate === null ? null : Math.round(r.mrr * rate);
  };

  const mrr = sum(active, (r) => inBase(r) || 0);
  const counted = active.filter((r) => inBase(r) !== null);
  const renewing = active.filter((r) => r.end_date && r.end_date >= as_of && r.end_date <= addDays(as_of, 90));

  return {
    as_of, currency,
    mrr, arr: mrr * 12,
    subscriptions: active.length,
    suspended: rows.length - active.length,
    average: counted.length ? Math.round(mrr / counted.length) : 0,
    // Named so the screen can say the total is short, rather than showing a
    // figure that silently is not the whole book.
    missing_rates: [...missing],
    by_customer: active.slice(0, 20).map((r) => ({
      subscription_id: r.id, subscription_no: r.subscription_no,
      customer_name: r.customer_name, mrr: r.mrr, mrr_base: inBase(r), currency: r.currency,
      end_date: r.end_date, status: r.status,
    })),
    renewals_due: renewing.map((r) => ({
      subscription_id: r.id, subscription_no: r.subscription_no, customer_name: r.customer_name,
      end_date: r.end_date, auto_renew: !!r.auto_renew, mrr: r.mrr, mrr_base: inBase(r), currency: r.currency,
    })).sort((a, b) => (a.end_date < b.end_date ? -1 : 1)),
  };
}

/** Everything invoiced from subscriptions in a window, for a revenue report. */
export const billedBetween = (repo, { from, to }) => repo.query(
  `SELECT b.*, s.subscription_no, s.currency, c.name AS customer_name, t.txn_no
   FROM subscription_billing b
   JOIN subscription s ON s.tenant_id = b.tenant_id AND s.id = b.subscription_id
   JOIN customer c ON c.tenant_id = s.tenant_id AND c.id = s.customer_id
   LEFT JOIN txn t ON t.tenant_id = b.tenant_id AND t.id = b.invoice_txn_id
   WHERE b.tenant_id = :t AND b.period_start >= ? AND b.period_start < ?
   ORDER BY b.period_start, s.subscription_no`, [from, to]);

