// Meridian ERP :: modules/schedules
// Revenue recognition and expense amortisation.
//
// One engine, run in two directions. A twelve-month support contract billed
// up front is one invoice and twelve months of revenue; a year of insurance
// paid in January is one bill and twelve months of expense. In both cases the
// amount is parked on the balance sheet when the document posts -- Deferred
// Revenue for income, Prepaid Expenses for cost -- and a slice is released
// each period.
//
// The slices are laid down once, when the source document posts, and never
// recalculated: a schedule is a promise about future periods, and quietly
// re-cutting it after somebody has closed a month is how two people end up
// with different numbers for the same quarter. Releasing a slice is a normal
// journal entry, so it reverses like anything else.
import { ulid, Money, nowIso, today, isValidDate, addMonths, addDays, endOfMonth, startOfMonth, daysBetween, sum } from '../core/util.mjs';
import { ValidationError, notFound, unprocessable } from '../core/http.mjs';
import { nextNumber } from '../core/seq.mjs';
import * as gl from './gl.mjs';
import { postingAccounts } from './setup.mjs';
import * as audit from '../core/audit.mjs';

export const KINDS = ['revenue', 'expense'];
export const METHODS = ['straight_monthly', 'straight_daily', 'on_completion'];
export const START_RULES = ['transaction_date', 'next_month', 'service_start'];
export const STATUSES = ['active', 'complete', 'cancelled'];

const METHOD_LABEL = {
  straight_monthly: 'Equal monthly slices',
  straight_daily: 'Pro-rated by day',
  on_completion: 'Held until released',
};

// ------------------------------------------------------------- templates
export const getTemplate = (repo, id) => {
  const t = repo.get('schedule_template', id);
  if (!t) throw notFound('Schedule template not found');
  return t;
};

export function createTemplate(repo, input) {
  const errors = {};
  if (!input.name) errors.name = 'Name is required';
  if (input.kind && !KINDS.includes(input.kind)) errors.kind = `Kind must be one of ${KINDS.join(', ')}`;
  if (input.method && !METHODS.includes(input.method)) errors.method = `Method must be one of ${METHODS.join(', ')}`;
  if (input.start_rule && !START_RULES.includes(input.start_rule)) errors.start_rule = `Start rule must be one of ${START_RULES.join(', ')}`;
  const term = Number(input.term_months ?? 12);
  const method = input.method || 'straight_monthly';
  if (method !== 'on_completion' && (!Number.isInteger(term) || term < 1 || term > 600)) {
    errors.term_months = 'Term must be a whole number of months between 1 and 600';
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);

  const now = nowIso();
  const id = repo.insert('schedule_template', {
    id: ulid(), name: String(input.name).trim(), kind: input.kind || 'revenue',
    method, term_months: method === 'on_completion' ? 1 : term,
    start_rule: input.start_rule || 'transaction_date',
    deferral_account_id: input.deferral_account_id || null,
    description: input.description || '',
    active: input.active === 0 || input.active === false ? 0 : 1,
    created_at: now, updated_at: now,
  });
  audit.record(repo, { recordType: 'schedule_template', recordId: id, action: 'create', after: input });
  return getTemplate(repo, id);
}

export function updateTemplate(repo, id, patch) {
  const before = getTemplate(repo, id);
  const merged = { ...before, ...patch };
  const errors = {};
  if (patch.name !== undefined && !patch.name) errors.name = 'Name is required';
  if (merged.kind && !KINDS.includes(merged.kind)) errors.kind = `Kind must be one of ${KINDS.join(', ')}`;
  if (merged.method && !METHODS.includes(merged.method)) errors.method = `Method must be one of ${METHODS.join(', ')}`;
  if (merged.start_rule && !START_RULES.includes(merged.start_rule)) errors.start_rule = `Start rule must be one of ${START_RULES.join(', ')}`;
  if (Object.keys(errors).length) throw new ValidationError(errors);
  // Editing a template never disturbs schedules already cut from it.
  repo.update('schedule_template', id, {
    name: merged.name, kind: merged.kind, method: merged.method,
    term_months: Number(merged.term_months) || 1, start_rule: merged.start_rule,
    deferral_account_id: merged.deferral_account_id || null,
    description: merged.description || '',
    active: merged.active ? 1 : 0, updated_at: nowIso(),
  });
  audit.record(repo, { recordType: 'schedule_template', recordId: id, action: 'update', before, after: merged });
  return getTemplate(repo, id);
}

// --------------------------------------------------------------- cutting
/** The template a line should follow, if any: line override, then the item. */
export function templateFor(repo, line, item, kind) {
  const id = line?.schedule_template_id
    || (kind === 'revenue' ? item?.revenue_template_id : item?.expense_template_id);
  if (!id) return null;
  const tmpl = repo.get('schedule_template', id);
  if (!tmpl || !tmpl.active) return null;
  return tmpl.kind === kind ? tmpl : null;
}

/** When the first slice falls, given the template's rule and the line. */
function startFor(tmpl, line, txnDate) {
  if (tmpl.start_rule === 'service_start' && isValidDate(line?.service_start)) return line.service_start;
  if (tmpl.start_rule === 'next_month') return addDays(endOfMonth(txnDate), 1);
  return txnDate;
}

/**
 * Cut the slices. Monthly is equal parts with the remainder spread by
 * largest-remainder so they sum to the penny; daily pro-rates each calendar
 * month by the days it actually covers, which is what a mid-month start
 * needs. Either way the last slice absorbs nothing extra -- Money.allocate
 * has already made the parts add up.
 */
export function planLines(tmpl, { amount, start_date, end_date }) {
  if (tmpl.method === 'on_completion') {
    return [{ period_no: 1, plan_date: end_date || start_date, amount, status: 'held' }];
  }

  const months = [];
  let cursor = start_date;
  while (cursor <= end_date) {
    const monthEnd = endOfMonth(cursor);
    const sliceEnd = monthEnd < end_date ? monthEnd : end_date;
    months.push({ from: cursor, to: sliceEnd, plan_date: sliceEnd });
    if (sliceEnd >= end_date) break;
    cursor = addDays(sliceEnd, 1);
  }
  if (!months.length) months.push({ from: start_date, to: end_date, plan_date: end_date });

  const weights = tmpl.method === 'straight_daily'
    ? months.map((m) => daysBetween(m.from, m.to) + 1)
    : months.map(() => 1);
  const parts = Money.allocate(amount, weights);
  return months.map((m, i) => ({
    period_no: i + 1, plan_date: m.plan_date, amount: parts[i], status: 'planned',
  }));
}

/**
 * Create a schedule for one transaction line. Called by the posting path, so
 * it runs inside the document's own transaction: a schedule can never exist
 * for a document that failed to post.
 */
export function createFromLine(repo, { txn, line, item, kind, template, targetAccount, deferralAccount }) {
  const amount = Math.trunc(line.amount || 0);
  if (!amount) return null;

  const start = startFor(template, line, txn.txn_date);
  const end = isValidDate(line.service_end) && template.start_rule === 'service_start'
    ? line.service_end
    : addDays(addMonths(start, template.method === 'on_completion' ? 1 : template.term_months), -1);
  if (end < start) throw new ValidationError({ service_end: 'The service period ends before it starts' });

  const now = nowIso();
  const id = ulid();
  repo.insert('schedule', {
    id, schedule_no: nextNumber(repo, kind === 'revenue' ? 'REV_SCHEDULE' : 'AMORT_SCHEDULE'),
    kind, template_id: template.id,
    source_txn_id: txn.id, source_line_id: line.id, item_id: line.item_id || null,
    entity_type: txn.entity_type || null, entity_id: txn.entity_id || null,
    subsidiary_id: txn.subsidiary_id,
    department_id: line.department_id || txn.department_id || null,
    class_id: line.class_id || txn.class_id || null,
    deferral_account_id: deferralAccount, target_account_id: targetAccount,
    currency: txn.currency, fx_rate: txn.fx_rate || 1,
    total_amount: amount, posted_amount: 0,
    start_date: start, end_date: end,
    memo: line.description || item?.name || '',
    status: 'active', created_at: now, updated_at: now,
  });
  for (const p of planLines(template, { amount, start_date: start, end_date: end })) {
    repo.insert('schedule_line', {
      id: ulid(), schedule_id: id, period_no: p.period_no, plan_date: p.plan_date,
      amount: p.amount, status: p.status, entry_id: null, posted_at: null,
    });
  }
  return getSchedule(repo, id);
}

// ----------------------------------------------------------------- reads
export function getSchedule(repo, id) {
  const s = repo.get('schedule', id);
  if (!s) throw notFound('Schedule not found');
  return { ...s, lines: linesFor(repo, id) };
}

export const linesFor = (repo, scheduleId) =>
  repo.query('SELECT * FROM schedule_line WHERE tenant_id = :t AND schedule_id = ? ORDER BY period_no', [scheduleId]);

export const schedulesForTxn = (repo, txnId) =>
  repo.query('SELECT * FROM schedule WHERE tenant_id = :t AND source_txn_id = ? ORDER BY created_at', [txnId]);

/** Slices due on or before `through` that nobody has released yet. */
export function due(repo, { kind = null, through = today(), subsidiary_id = null } = {}) {
  if (!isValidDate(through)) throw new ValidationError({ through: 'Enter a valid date' });
  const where = ['sl.tenant_id = :t', "sl.status = 'planned'", 's.status = \'active\'', 'sl.plan_date <= ?'];
  const params = [through];
  if (kind) { where.push('s.kind = ?'); params.push(kind); }
  if (subsidiary_id) { where.push('s.subsidiary_id = ?'); params.push(subsidiary_id); }
  // `base_amount` travels with every row because a due list spans currencies
  // and a total that adds pounds to dollars is not a total.
  return repo.query(
    `SELECT sl.*, s.kind, s.schedule_no, s.subsidiary_id, s.currency, s.fx_rate, s.memo AS schedule_memo,
            s.deferral_account_id, s.target_account_id, s.department_id, s.class_id, s.item_id,
            s.entity_type, s.entity_id, s.source_txn_id
     FROM schedule_line sl
     JOIN schedule s ON s.tenant_id = sl.tenant_id AND s.id = sl.schedule_id
     WHERE ${where.join(' AND ')}
     ORDER BY sl.plan_date, s.schedule_no`, params)
    .map((r) => ({ ...r, base_amount: Money.convert(r.amount, r.fx_rate || 1) }));
}

// ------------------------------------------------------------- releasing
/**
 * Release everything due through a date.
 *
 * Slices are grouped into one journal per (period end, subsidiary, currency)
 * rather than one per schedule: a company with four hundred subscriptions
 * wants twelve entries a year in its ledger, not four thousand eight hundred.
 * Every slice still names its own schedule on its own journal line, so the
 * drill-down from the ledger back to the contract survives.
 */
export function runRecognition(repo, { kind = 'revenue', through = today(), dry_run = false, memo = '' } = {}) {
  if (!KINDS.includes(kind)) throw new ValidationError({ kind: `Kind must be one of ${KINDS.join(', ')}` });
  const rows = due(repo, { kind, through });
  if (!rows.length) {
    return { kind, through, posted: 0, amount: 0, entries: [], deferred: [], dry_run: !!dry_run };
  }

  const groups = new Map();
  for (const r of rows) {
    const key = `${r.plan_date}|${r.subsidiary_id}|${r.currency}`;
    if (!groups.has(key)) groups.set(key, { plan_date: r.plan_date, subsidiary_id: r.subsidiary_id, currency: r.currency, rows: [] });
    groups.get(key).rows.push(r);
  }

  const entries = [];
  const deferred = [];
  let total = 0;          // base currency, so a mixed-currency run still totals

  for (const g of [...groups.values()].sort((a, b) => (a.plan_date < b.plan_date ? -1 : 1))) {
    // A slice whose period is closed waits rather than failing the whole run:
    // one locked month must not stop the other eleven from being recognised.
    const period = gl.periodForDate(repo, g.plan_date);
    if (!period || period.status !== 'open') {
      deferred.push({
        plan_date: g.plan_date, period: period?.name || null,
        reason: period ? `${period.name} is ${period.status}` : `no accounting period covers ${g.plan_date}`,
        lines: g.rows.length, amount: Money.toNumber(sum(g.rows, (r) => r.base_amount)),
      });
      continue;
    }

    const journalLines = [];
    for (const r of g.rows) {
      if (!r.amount) continue;
      const seg = { department_id: r.department_id, class_id: r.class_id, item_id: r.item_id, entity_type: r.entity_type, entity_id: r.entity_id };
      const label = `${r.schedule_no} ${r.schedule_memo}`.trim();
      // Each row carries its own base_amount, booked at that schedule's own
      // rate -- which can differ from another schedule's in the same group.
      // Setting it here explicitly (postJournal honours a line's own
      // base_debit/base_credit) is what lets one journal entry hold several
      // schedules correctly, instead of converting all of them at whichever
      // schedule happened to be first in the group.
      if (kind === 'revenue') {
        journalLines.push({ account_id: r.deferral_account_id, debit: r.amount, credit: 0, base_debit: r.base_amount, base_credit: 0, ...seg, memo: `Deferred revenue released — ${label}` });
        journalLines.push({ account_id: r.target_account_id, debit: 0, credit: r.amount, base_debit: 0, base_credit: r.base_amount, ...seg, memo: `Revenue recognised — ${label}` });
      } else {
        journalLines.push({ account_id: r.target_account_id, debit: r.amount, credit: 0, base_debit: r.base_amount, base_credit: 0, ...seg, memo: `Amortisation — ${label}` });
        journalLines.push({ account_id: r.deferral_account_id, debit: 0, credit: r.amount, base_debit: 0, base_credit: r.base_amount, ...seg, memo: `Prepayment released — ${label}` });
      }
    }
    if (journalLines.length < 2) continue;

    const amount = sum(g.rows, (r) => r.amount);
    const baseAmount = sum(g.rows, (r) => r.base_amount);
    if (dry_run) {
      entries.push({
        date: g.plan_date, subsidiary_id: g.subsidiary_id, currency: g.currency,
        amount: Money.toNumber(amount), base_amount: Money.toNumber(baseAmount), lines: g.rows.length,
      });
      total += baseAmount;
      continue;
    }

    const entry = gl.postJournal(repo, {
      subsidiary_id: g.subsidiary_id, txn_date: g.plan_date, currency: g.currency,
      fx_rate: g.rows[0].fx_rate || 1,
      memo: memo || (kind === 'revenue'
        ? `Revenue recognition through ${g.plan_date}`
        : `Expense amortisation through ${g.plan_date}`),
      source_type: kind === 'revenue' ? 'revenue_recognition' : 'amortisation',
      source_id: g.rows[0].schedule_id,
      lines: journalLines,
    });

    for (const r of g.rows) {
      repo.update('schedule_line', r.id, { status: 'posted', entry_id: entry.id, posted_at: nowIso() });
      const s = repo.get('schedule', r.schedule_id);
      const posted = (s.posted_amount || 0) + r.amount;
      repo.update('schedule', r.schedule_id, {
        posted_amount: posted,
        status: posted >= s.total_amount ? 'complete' : 'active',
        updated_at: nowIso(),
      });
    }
    entries.push({
      id: entry.id, entry_no: entry.entry_no, date: g.plan_date, subsidiary_id: g.subsidiary_id,
      currency: g.currency, amount: Money.toNumber(amount), base_amount: Money.toNumber(baseAmount), lines: g.rows.length,
    });
    total += baseAmount;
  }

  if (!dry_run && entries.length) {
    audit.record(repo, {
      recordType: 'schedule', recordId: null, action: kind === 'revenue' ? 'recognise' : 'amortise',
      changes: { through: { from: null, to: through }, entries: { from: 0, to: entries.length }, amount: { from: 0, to: Money.toNumber(total) } },
    });
  }
  return { kind, through, posted: entries.length, amount: Money.toNumber(total), entries, deferred, dry_run: !!dry_run };
}

/** Release an `on_completion` slice: the work is done, so the revenue is earned. */
export function releaseHeld(repo, scheduleId, { plan_date = today(), line_id = null } = {}) {
  const s = getSchedule(repo, scheduleId);
  if (s.status !== 'active') throw unprocessable(`${s.schedule_no} is ${s.status}`);
  const held = s.lines.filter((l) => l.status === 'held' && (!line_id || l.id === line_id));
  if (!held.length) throw unprocessable(`${s.schedule_no} has nothing waiting to be released`);
  if (!isValidDate(plan_date)) throw new ValidationError({ plan_date: 'Enter a valid date' });

  for (const l of held) repo.update('schedule_line', l.id, { status: 'planned', plan_date });
  audit.record(repo, { recordType: 'schedule', recordId: scheduleId, action: 'release', changes: { held: { from: held.length, to: 0 } } });
  return runRecognition(repo, { kind: s.kind, through: plan_date });
}

/**
 * Cancel what has not been released. Used when the source document is voided:
 * the deferral itself is reversed with the document, so anything still
 * planned has to stop, and anything already recognised stays -- it happened.
 */
export function cancelForTxn(repo, txnId, { reason = '' } = {}) {
  const list = schedulesForTxn(repo, txnId);
  let cancelled = 0;
  for (const s of list) {
    if (s.status === 'cancelled') continue;
    repo.exec("UPDATE schedule_line SET status = 'cancelled' WHERE tenant_id = :t AND schedule_id = ? AND status IN ('planned','held')", [s.id]);
    repo.update('schedule', s.id, { status: 'cancelled', updated_at: nowIso() });
    audit.record(repo, { recordType: 'schedule', recordId: s.id, action: 'cancel', changes: { reason: { from: null, to: reason } } });
    cancelled++;
  }
  return cancelled;
}

/** How much of a document's schedules has already been released. */
export const recognisedForTxn = (repo, txnId) => repo.scalar(
  `SELECT COALESCE(SUM(posted_amount), 0) v FROM schedule
   WHERE tenant_id = :t AND source_txn_id = ? AND status != 'cancelled'`, [txnId], 0);

// ---------------------------------------------------------------- report
/**
 * The waterfall: what is still sitting in deferral, and which future period
 * each slice of it belongs to. This is the schedule a controller is asked for
 * when somebody wants to know what next quarter already has in the bank.
 */
export function waterfall(repo, { kind = 'revenue', from = null, months = 12, subsidiary_id = null } = {}) {
  const start = startOfMonth(from && isValidDate(from) ? from : today());
  const buckets = [];
  for (let i = 0; i < Math.max(1, Math.min(60, Number(months) || 12)); i++) {
    const s = addMonths(start, i);
    buckets.push({ month: s.slice(0, 7), from: s, to: endOfMonth(s), amount: 0, lines: 0 });
  }
  const horizon = buckets[buckets.length - 1].to;

  const where = ['sl.tenant_id = :t', "sl.status IN ('planned','held')", "s.status = 'active'"];
  const params = [];
  if (kind) { where.push('s.kind = ?'); params.push(kind); }
  if (subsidiary_id) { where.push('s.subsidiary_id = ?'); params.push(subsidiary_id); }

  const rows = repo.query(
    `SELECT sl.plan_date, sl.amount, sl.status, s.fx_rate, s.schedule_no, s.memo, s.currency,
            s.entity_type, s.entity_id, s.target_account_id
     FROM schedule_line sl
     JOIN schedule s ON s.tenant_id = sl.tenant_id AND s.id = sl.schedule_id
     WHERE ${where.join(' AND ')}
     ORDER BY sl.plan_date`, params);

  let overdue = 0, beyond = 0, held = 0, total = 0;
  for (const r of rows) {
    const base = Money.convert(r.amount, r.fx_rate || 1);
    total += base;
    if (r.status === 'held') { held += base; continue; }
    if (r.plan_date < start) { overdue += base; continue; }
    if (r.plan_date > horizon) { beyond += base; continue; }
    const b = buckets.find((x) => r.plan_date >= x.from && r.plan_date <= x.to);
    if (b) { b.amount += base; b.lines++; } else beyond += base;
  }

  return {
    kind, from: start, months: buckets.length,
    label: kind === 'revenue' ? 'Deferred revenue' : 'Prepaid expenses',
    buckets: buckets.map((b) => ({ ...b, amount: Money.toNumber(b.amount) })),
    overdue: Money.toNumber(overdue),
    held: Money.toNumber(held),
    beyond_horizon: Money.toNumber(beyond),
    total_deferred: Money.toNumber(total),
  };
}

/** Every live schedule, newest first, for the management screen. */
export function list(repo, { kind = null, status = 'active', limit = 200, offset = 0 } = {}) {
  const where = ['s.tenant_id = :t'];
  const params = [];
  if (kind) { where.push('s.kind = ?'); params.push(kind); }
  if (status && status !== 'all') { where.push('s.status = ?'); params.push(status); }
  const rows = repo.query(
    `SELECT s.*, t.txn_no AS source_no, a.number AS target_number, a.name AS target_name
     FROM schedule s
     LEFT JOIN txn t ON t.tenant_id = s.tenant_id AND t.id = s.source_txn_id
     LEFT JOIN account a ON a.tenant_id = s.tenant_id AND a.id = s.target_account_id
     WHERE ${where.join(' AND ')}
     ORDER BY s.created_at DESC LIMIT ? OFFSET ?`, [...params, Math.min(500, Number(limit) || 200), Number(offset) || 0]);
  return {
    rows: rows.map((r) => ({
      ...r,
      remaining: r.total_amount - r.posted_amount,
      method_label: METHOD_LABEL[repo.get('schedule_template', r.template_id)?.method] || '',
    })),
    total: repo.scalar(`SELECT COUNT(*) c FROM schedule s WHERE ${where.join(' AND ')}`, params, 0),
  };
}
