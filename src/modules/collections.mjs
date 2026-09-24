// Meridian ERP :: modules/collections
// Getting paid, and knowing when to stop trying.
//
// The aging report already says who is late. What it never says is who has
// been chased, what they promised, who owns the account, and which balances
// are simply never coming. This module is the difference between a report and
// a collections desk:
//
//   * a worklist -- everyone overdue, with the state a collector works from;
//   * a statement -- what a customer owes, as they would want it laid out;
//   * a dunning ladder -- reminders that escalate on their own schedule and
//     stop when somebody promises to pay;
//   * a write-off -- admitting the money is gone, in the ledger, once;
//   * an allowance -- provisioning for the ones not yet admitted.
import { ulid, Money, nowIso, today, isValidDate, addDays, daysBetween, sum, round } from '../core/util.mjs';
import { ValidationError, notFound, unprocessable, conflict } from '../core/http.mjs';
import { nextNumber } from '../core/seq.mjs';
import { buildReportPdf, PAGE } from '../core/pdf.mjs';
import * as gl from './gl.mjs';
import * as T from './txn.mjs';
import { postingAccounts } from './setup.mjs';
import { AGING_BANDS } from './reports.mjs';
import * as audit from '../core/audit.mjs';

const OPEN_TYPES = ['INVOICE', 'CREDIT_MEMO', 'CUSTOMER_PAYMENT'];
const NEGATED = ['CREDIT_MEMO', 'CUSTOMER_PAYMENT'];

/** Which band a document falls in, given how late it is. */
export function bandFor(daysOverdue) {
  if (daysOverdue <= 0) return 0;
  for (let i = 1; i < AGING_BANDS.length; i++) if (daysOverdue <= AGING_BANDS[i].max) return i;
  return AGING_BANDS.length - 1;
}

/**
 * The currency a collections report speaks.
 *
 * The ledger carries each document at the base currency of the subsidiary it
 * was raised in, which is the right answer for the balance sheet and the
 * wrong one for a worklist: a desk holding a sterling debt and a dollar debt
 * needs one comparable number, not two bases added together. So collections
 * converts every document from its own currency at the rate on the day it is
 * being looked at -- what the debt is worth now, which is the question a
 * collector is actually asking.
 */
export const reportingCurrency = (repo) => repo.queryOne('SELECT base_currency FROM tenant WHERE id = :t')?.base_currency
  || repo.queryOne('SELECT currency FROM subsidiary WHERE tenant_id = :t ORDER BY created_at LIMIT 1')?.currency
  || 'USD';

/** Memoised `from -> to` conversion at a fixed date. */
function converter(repo, to, as_of) {
  const rates = new Map([[to, 1]]);
  return (from) => {
    if (!rates.has(from)) rates.set(from, gl.exchangeRate(repo, from, to, as_of));
    return rates.get(from);
  };
}

/** Every open document for a customer, or for all of them, as at a date. */
function openItems(repo, { as_of, customer_id = null, subsidiary_id = null, currency = null }) {
  const params = [...OPEN_TYPES, as_of];
  let where = '';
  if (customer_id) { where += ' AND t.entity_id = ?'; params.push(customer_id); }
  if (subsidiary_id) { where += ' AND t.subsidiary_id = ?'; params.push(subsidiary_id); }
  const rows = repo.query(
    `SELECT t.id, t.type, t.txn_no, t.txn_date, t.due_date, t.currency, t.fx_rate,
            t.total, t.amount_remaining, t.entity_id, t.memo, t.reference
     FROM txn t
     WHERE t.tenant_id = :t AND t.type IN (${OPEN_TYPES.map(() => '?').join(',')})
       AND t.status NOT IN ('voided','cancelled') AND t.posted = 1
       AND t.amount_remaining > 0 AND t.txn_date <= ?${where}
     ORDER BY t.entity_id, t.due_date, t.txn_date, t.txn_no`, params);

  const to = currency || reportingCurrency(repo);
  const rateTo = converter(repo, to, as_of);
  return rows.map((r) => {
    const sign = NEGATED.includes(r.type) ? -1 : 1;
    const daysOverdue = r.due_date && sign > 0 ? Math.max(0, daysBetween(r.due_date, as_of)) : 0;
    const outstanding = r.amount_remaining * sign;
    return {
      ...r, sign, outstanding,
      report_amount: Money.convert(outstanding, rateTo(r.currency)),
      days_overdue: daysOverdue, bucket: bandFor(daysOverdue),
    };
  });
}

// ------------------------------------------------------------- worklist
/**
 * Everyone with money outstanding, in the order a collector would work them:
 * furthest gone first, but a promise that has not yet come due drops an
 * account down the list rather than off it.
 */
export function worklist(repo, { as_of = today(), collector_id = null, subsidiary_id = null, min_days = 1, include_current = false } = {}) {
  if (!isValidDate(as_of)) throw new ValidationError({ as_of: 'Enter a valid date' });
  const reporting = reportingCurrency(repo);
  const rateTo = converter(repo, reporting, as_of);
  const items = openItems(repo, { as_of, subsidiary_id, currency: reporting });
  const byCustomer = new Map();
  for (const i of items) {
    if (!byCustomer.has(i.entity_id)) byCustomer.set(i.entity_id, []);
    byCustomer.get(i.entity_id).push(i);
  }
  if (!byCustomer.size) return { as_of, currency: reporting, rows: [], totals: emptyTotals(reporting) };

  const ids = [...byCustomer.keys()];
  const customers = repo.query(
    `SELECT c.*, e.first_name AS collector_first, e.last_name AS collector_last
     FROM customer c LEFT JOIN employee e ON e.tenant_id = c.tenant_id AND e.id = c.collector_id
     WHERE c.tenant_id = :t AND c.id IN (${ids.map(() => '?').join(',')})`, ids);

  const lastNotices = new Map();
  for (const n of repo.query(
    `SELECT customer_id, MAX(as_of) AS as_of, MAX(level_no) AS level_no FROM dunning_notice
     WHERE tenant_id = :t AND status = 'issued' AND customer_id IN (${ids.map(() => '?').join(',')})
     GROUP BY customer_id`, ids)) lastNotices.set(n.customer_id, n);

  const rows = [];
  for (const c of customers) {
    if (collector_id && c.collector_id !== collector_id) continue;
    const own = byCustomer.get(c.id) || [];
    const buckets = AGING_BANDS.map(() => 0);
    for (const i of own) buckets[i.bucket] += i.report_amount;
    const total = sum(own, (i) => i.report_amount);
    const overdue = sum(own.filter((i) => i.days_overdue > 0), (i) => i.report_amount);
    const oldest = own.reduce((a, i) => Math.max(a, i.days_overdue), 0);
    if (!include_current && oldest < min_days) continue;
    if (total <= 0) continue;

    const notice = lastNotices.get(c.id);
    rows.push({
      customer_id: c.id, entity_no: c.entity_no, name: c.name, email: c.email, phone: c.phone,
      currency: c.currency, terms: c.terms, credit_limit: c.credit_limit, credit_hold: !!c.credit_hold,
      collector_id: c.collector_id || null,
      collector_name: c.collector_first ? `${c.collector_first} ${c.collector_last || ''}`.trim() : null,
      dunning_level: c.dunning_level || 0, dunning_policy_id: c.dunning_policy_id || null,
      no_dunning: !!c.no_dunning, collection_note: c.collection_note || '',
      promise_date: c.promise_date || null, promise_amount: c.promise_amount || 0,
      promise_kept: c.promise_date ? c.promise_date >= as_of : null,
      last_notice_date: notice?.as_of || c.last_dunned_at || null,
      last_notice_level: notice?.level_no || 0,
      documents: own.length, oldest_days: oldest,
      buckets, total, overdue,
      // Over the limit is a different conversation from merely late. `total`
      // is already in the reporting currency (openItems converted it); the
      // customer's own credit_limit is stored in their currency, so it needs
      // the same conversion before the two are comparable.
      over_limit: c.credit_limit > 0 && total > Money.convert(c.credit_limit, rateTo(c.currency)),
    });
  }

  // Worst first, but an unbroken promise waits its turn.
  rows.sort((a, b) => {
    const promised = (r) => (r.promise_date && r.promise_date >= as_of ? 1 : 0);
    return promised(a) - promised(b) || b.oldest_days - a.oldest_days || b.overdue - a.overdue;
  });

  const totals = {
    customers: rows.length,
    buckets: AGING_BANDS.map((_, i) => sum(rows, (r) => r.buckets[i])),
    total: sum(rows, (r) => r.total),
    overdue: sum(rows, (r) => r.overdue),
    on_hold: rows.filter((r) => r.credit_hold).length,
    promised: sum(rows.filter((r) => r.promise_date && r.promise_date >= as_of), (r) => r.promise_amount),
    bucket_labels: AGING_BANDS.map((b) => b.label),
    currency: reporting,
  };
  return { as_of, currency: reporting, rows, totals };
}

const emptyTotals = (currency = 'USD') => ({
  customers: 0, buckets: AGING_BANDS.map(() => 0), total: 0, overdue: 0,
  on_hold: 0, promised: 0, currency, bucket_labels: AGING_BANDS.map((b) => b.label),
});

// ------------------------------------------------------------ statement
/**
 * A statement, in either of the two shapes people ask for: the open items
 * still owed, or every movement over a period with a balance carried forward.
 */
export function statement(repo, customerId, { as_of = today(), from = null, kind = 'open_item' } = {}) {
  if (!isValidDate(as_of)) throw new ValidationError({ as_of: 'Enter a valid date' });
  const customer = repo.get('customer', customerId);
  if (!customer) throw notFound('Customer not found');
  const company = repo.queryOne('SELECT name, settings FROM tenant WHERE id = :t');

  // A statement is addressed to one customer, who deals in one currency --
  // theirs. Where a document was raised in some other currency it is
  // converted at the rate on the statement date, with its own amount kept
  // beside it, because "you owe us £2,000" and "you owe us $2,500" cannot
  // both go in the same column.
  const currency = customer.currency || reportingCurrency(repo);
  const rateTo = converter(repo, currency, as_of);
  const convert = (amount, from_) => Money.convert(amount, rateTo(from_));

  const open = openItems(repo, { as_of, customer_id: customerId, currency });
  const mixed = open.some((i) => i.currency !== currency);
  const buckets = AGING_BANDS.map(() => 0);
  for (const i of open) buckets[i.bucket] += i.report_amount;

  const total = sum(open, (i) => i.report_amount);
  const overdue = sum(open.filter((i) => i.days_overdue > 0), (i) => i.report_amount);
  const oldest = open.reduce((a, i) => Math.max(a, i.days_overdue), 0);
  const tail = {
    currency, mixed, buckets, bucket_labels: AGING_BANDS.map((b) => b.label),
    total, overdue, oldest_days: oldest,
  };

  if (kind === 'activity') {
    const start = from || addDays(as_of, -90);
    if (!isValidDate(start)) throw new ValidationError({ from: 'Enter a valid date' });
    const before = repo.query(
      `SELECT type, currency, total FROM txn
       WHERE tenant_id = :t AND entity_id = ? AND type IN (${OPEN_TYPES.map(() => '?').join(',')})
         AND status NOT IN ('voided','cancelled') AND posted = 1 AND txn_date < ?`,
      [customerId, ...OPEN_TYPES, start]);
    const openingBalance = sum(before, (m) => convert(m.total, m.currency) * (NEGATED.includes(m.type) ? -1 : 1));

    const moves = repo.query(
      `SELECT id, type, txn_no, txn_date, due_date, currency, total, memo, reference
       FROM txn WHERE tenant_id = :t AND entity_id = ? AND type IN (${OPEN_TYPES.map(() => '?').join(',')})
         AND status NOT IN ('voided','cancelled') AND posted = 1
         AND txn_date >= ? AND txn_date <= ?
       ORDER BY txn_date, txn_no`, [customerId, ...OPEN_TYPES, start, as_of]);

    let running = openingBalance;
    const lines = moves.map((m) => {
      const sign = NEGATED.includes(m.type) ? -1 : 1;
      const signed = convert(m.total, m.currency) * sign;
      running += signed;
      return {
        txn_id: m.id, date: m.txn_date, due_date: m.due_date, type: T.TYPES[m.type]?.label || m.type,
        reference: m.txn_no, memo: m.memo || m.reference || '',
        currency: m.currency, document_amount: m.total * sign, amount: signed, balance: running,
      };
    });
    return {
      kind, as_of, from: start, customer: publicCustomer(customer), company: company?.name || 'Meridian',
      lines, opening_balance: openingBalance, closing_balance: running,
      ...tail, mixed: mixed || moves.some((m) => m.currency !== currency),
    };
  }

  return {
    kind: 'open_item', as_of, from: null, customer: publicCustomer(customer), company: company?.name || 'Meridian',
    lines: open.map((i) => ({
      txn_id: i.id, date: i.txn_date, due_date: i.due_date, type: T.TYPES[i.type]?.label || i.type,
      reference: i.txn_no, memo: i.memo || i.reference || '',
      currency: i.currency, amount: i.sign * i.total,
      document_outstanding: i.outstanding, outstanding: i.report_amount,
      days_overdue: i.days_overdue, bucket: AGING_BANDS[i.bucket].label,
    })),
    opening_balance: 0, closing_balance: total,
    ...tail,
  };
}

const publicCustomer = (c) => ({
  id: c.id, entity_no: c.entity_no, name: c.name, email: c.email, phone: c.phone,
  currency: c.currency, terms: c.terms, billing_address: c.billing_address,
});

const money = (v, ccy) => Money.format(v, ccy);

export function statementPdf(repo, customerId, opts = {}) {
  const s = statement(repo, customerId, opts);
  const ccy = s.currency;
  const addr = s.customer.billing_address || {};
  const where = [addr.line1, addr.line2, addr.city, addr.state, addr.postcode, addr.country].filter(Boolean).join(', ');

  const columns = s.kind === 'activity'
    ? [
      { key: 'date', label: 'Date', type: 'date', width: 62 },
      { key: 'type', label: 'Type', width: 92 },
      { key: 'reference', label: 'Reference', width: 82 },
      { key: 'memo', label: 'Detail' },
      ...(s.mixed ? [
        { key: 'currency', label: 'Ccy', width: 34 },
        { key: 'document_amount', label: 'In currency', type: 'money', width: 78 },
      ] : []),
      { key: 'amount', label: `Amount (${ccy})`, type: 'money', width: 82 },
      { key: 'balance', label: 'Balance', type: 'money', width: 82 },
    ]
    : [
      { key: 'date', label: 'Date', type: 'date', width: 62 },
      { key: 'type', label: 'Type', width: 92 },
      { key: 'reference', label: 'Reference', width: 82 },
      { key: 'due_date', label: 'Due', type: 'date', width: 62 },
      { key: 'days_overdue', label: 'Days late', type: 'number', width: 58 },
      { key: 'memo', label: 'Detail' },
      ...(s.mixed ? [
        { key: 'currency', label: 'Ccy', width: 34 },
        { key: 'document_outstanding', label: 'In currency', type: 'money', width: 78 },
      ] : []),
      { key: 'outstanding', label: `Outstanding (${ccy})`, type: 'money', width: 92 },
    ];

  const rows = s.lines.map((l) => ({
    ...l,
    amount: l.amount === undefined ? undefined : Money.toNumber(l.amount),
    balance: l.balance === undefined ? undefined : Money.toNumber(l.balance),
    outstanding: l.outstanding === undefined ? undefined : Money.toNumber(l.outstanding),
    document_outstanding: l.document_outstanding === undefined ? undefined : Money.toNumber(l.document_outstanding),
    document_amount: l.document_amount === undefined ? undefined : Money.toNumber(l.document_amount),
    days_overdue: l.days_overdue || undefined,
  }));

  const agingRow = {};
  s.bucket_labels.forEach((label, i) => { agingRow[`b${i}`] = Money.toNumber(s.buckets[i]); });

  return buildReportPdf({
    title: 'Statement of account',
    subtitle: `${s.customer.name}${s.customer.entity_no ? ` · ${s.customer.entity_no}` : ''} — as at ${s.as_of}`,
    currency: ccy,
    footer: `${s.company} · ${s.kind === 'activity' ? `activity from ${s.from}` : 'open items'}`,
    size: PAGE.A4_LANDSCAPE,
    sections: [
      {
        paragraphs: [
          where || '',
          s.kind === 'activity'
            ? `Balance brought forward at ${s.from}: ${money(s.opening_balance, ccy)}.`
            : `Every item below was outstanding at ${s.as_of}. Payments received after that date are not reflected.`,
          s.mixed
            ? `This account holds documents in ${[...new Set(s.lines.map((l) => l.currency))].join(', ')}. Totals are stated in ${ccy}, with each document's own amount shown beside it.`
            : '',
        ].filter(Boolean),
      },
      {
        title: s.kind === 'activity' ? 'Activity' : 'Open items',
        columns, rows,
        totals: s.kind === 'activity'
          ? { balance: Money.toNumber(s.closing_balance) }
          : { outstanding: Money.toNumber(s.total) },
      },
      {
        title: 'Aged analysis',
        columns: s.bucket_labels.map((label, i) => ({ key: `b${i}`, label, type: 'money' })),
        rows: [agingRow],
        note: s.overdue
          ? `${money(s.overdue, ccy)} of the balance is past its due date, the oldest by ${s.oldest_days} days.`
          : 'Nothing on the account is past its due date.',
      },
    ],
  });
}

// -------------------------------------------------------------- dunning
export const policies = (repo) => repo.query(
  `SELECT p.*, (SELECT COUNT(*) FROM dunning_level l WHERE l.tenant_id = p.tenant_id AND l.policy_id = p.id) AS levels
   FROM dunning_policy p WHERE p.tenant_id = :t ORDER BY p.is_default DESC, p.name`);

export function getPolicy(repo, id) {
  const p = repo.get('dunning_policy', id);
  if (!p) throw notFound('Dunning policy not found');
  return { ...p, levels: levelsFor(repo, id) };
}

export const levelsFor = (repo, id) => repo.query(
  'SELECT * FROM dunning_level WHERE tenant_id = :t AND policy_id = ? ORDER BY level_no', [id]);

export const defaultPolicy = (repo) => repo.queryOne(
  `SELECT * FROM dunning_policy WHERE tenant_id = :t AND active = 1
   ORDER BY is_default DESC, created_at LIMIT 1`);

function validateLevels(levels) {
  if (!Array.isArray(levels) || !levels.length) throw new ValidationError({ levels: 'A policy needs at least one level' });
  const errors = {};
  const seen = new Set();
  let previousDays = -1;
  levels.forEach((l, i) => {
    const no = Number(l.level_no) || i + 1;
    if (seen.has(no)) errors[`levels.${i}.level_no`] = `Level ${no} is listed twice`;
    seen.add(no);
    if (!l.name) errors[`levels.${i}.name`] = 'Name is required';
    const days = Number(l.days_overdue) || 0;
    if (days < 0) errors[`levels.${i}.days_overdue`] = 'Days overdue cannot be negative';
    // A ladder that does not climb is not a ladder: level 2 firing at the
    // same age as level 1 means every account jumps straight to the top.
    if (days <= previousDays) errors[`levels.${i}.days_overdue`] = 'Each level has to be later than the one before it';
    previousDays = days;
  });
  if (Object.keys(errors).length) throw new ValidationError(errors, 'Some dunning levels are invalid');
  return levels.map((l, i) => ({
    level_no: Number(l.level_no) || i + 1,
    name: String(l.name).trim(),
    days_overdue: Number(l.days_overdue) || 0,
    subject: l.subject || '',
    body: l.body || '',
    credit_hold: l.credit_hold ? 1 : 0,
    charge_interest: l.charge_interest ? 1 : 0,
  }));
}

export function createPolicy(repo, input) {
  if (!input.name) throw new ValidationError({ name: 'Name is required' });
  const levels = validateLevels(input.levels);
  const now = nowIso();
  const id = ulid();
  if (input.is_default) repo.exec('UPDATE dunning_policy SET is_default = 0 WHERE tenant_id = :t');
  repo.insert('dunning_policy', {
    id, name: String(input.name).trim(), description: input.description || '',
    min_balance: Money.parse(input.min_balance || 0), cooldown_days: Number(input.cooldown_days) || 7,
    is_default: input.is_default ? 1 : 0, active: input.active === undefined ? 1 : (input.active ? 1 : 0),
    created_at: now, updated_at: now,
  });
  for (const l of levels) repo.insert('dunning_level', { id: ulid(), policy_id: id, ...l });
  audit.record(repo, { recordType: 'dunning_policy', recordId: id, action: 'create', after: input });
  return getPolicy(repo, id);
}

export function updatePolicy(repo, id, patch) {
  const before = getPolicy(repo, id);
  const changes = { updated_at: nowIso() };
  for (const k of ['name', 'description']) if (patch[k] !== undefined) changes[k] = patch[k];
  if (patch.min_balance !== undefined) changes.min_balance = Money.parse(patch.min_balance);
  if (patch.cooldown_days !== undefined) changes.cooldown_days = Number(patch.cooldown_days) || 0;
  if (patch.active !== undefined) changes.active = patch.active ? 1 : 0;
  if (patch.is_default !== undefined) {
    changes.is_default = patch.is_default ? 1 : 0;
    if (patch.is_default) repo.exec('UPDATE dunning_policy SET is_default = 0 WHERE tenant_id = :t');
  }
  repo.update('dunning_policy', id, changes);
  if (patch.levels !== undefined) {
    const levels = validateLevels(patch.levels);
    repo.exec('DELETE FROM dunning_level WHERE tenant_id = :t AND policy_id = ?', [id]);
    for (const l of levels) repo.insert('dunning_level', { id: ulid(), policy_id: id, ...l });
  }
  audit.record(repo, { recordType: 'dunning_policy', recordId: id, action: 'update', before, after: patch });
  return getPolicy(repo, id);
}

/** Fill a letter template. Unknown placeholders are left visible, not blanked. */
export function render(template, values) {
  return String(template || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, key) => (
    values[key] === undefined || values[key] === null ? whole : String(values[key])
  ));
}

/**
 * Who is due a letter, and which one.
 *
 * A customer climbs one rung at a time: reaching sixty days late does not
 * skip the reminder, because a final notice nobody was warned about is how
 * you lose a customer who simply mislaid an invoice.
 */
export function dunningCandidates(repo, { as_of = today(), policy_id = null, customer_ids = null, subsidiary_id = null } = {}) {
  const work = worklist(repo, { as_of, subsidiary_id, min_days: 1 });
  const fallback = policy_id ? getPolicy(repo, policy_id) : defaultPolicy(repo);
  const policyCache = new Map();
  const policyFor = (id) => {
    const key = id || fallback?.id;
    if (!key) return null;
    if (!policyCache.has(key)) {
      const p = repo.get('dunning_policy', key);
      policyCache.set(key, p ? { ...p, levels: levelsFor(repo, key) } : null);
    }
    return policyCache.get(key);
  };

  const out = [];
  for (const r of work.rows) {
    if (customer_ids && !customer_ids.includes(r.customer_id)) continue;
    const reason = (why) => out.push({ ...r, eligible: false, reason: why });

    if (r.no_dunning) { reason('the account is marked do not chase'); continue; }
    const policy = policyFor(policy_id || r.dunning_policy_id);
    if (!policy) { reason('no dunning policy is set up'); continue; }
    if (!policy.active) { reason(`${policy.name} is not active`); continue; }
    if (r.overdue < policy.min_balance) {
      reason(`${Money.format(r.overdue)} is below the ${Money.format(policy.min_balance)} minimum`); continue;
    }
    // A promise still in the future is the answer to the last letter.
    if (r.promise_date && r.promise_date >= as_of) { reason(`payment promised for ${r.promise_date}`); continue; }
    if (r.last_notice_date && daysBetween(r.last_notice_date, as_of) < policy.cooldown_days) {
      reason(`chased ${daysBetween(r.last_notice_date, as_of)} days ago, inside the ${policy.cooldown_days}-day cooldown`); continue;
    }

    const current = Math.max(r.dunning_level || 0, r.last_notice_level || 0);
    const next = policy.levels.find((l) => l.level_no > current);
    if (!next) { reason('already at the last rung of the ladder'); continue; }
    if (r.oldest_days < next.days_overdue) {
      reason(`${next.name} needs ${next.days_overdue} days; the oldest item is ${r.oldest_days}`); continue;
    }
    out.push({ ...r, eligible: true, policy_id: policy.id, policy_name: policy.name, level: next });
  }
  return { as_of, candidates: out.filter((c) => c.eligible), skipped: out.filter((c) => !c.eligible) };
}

/** Issue the letters. Nothing is sent anywhere -- they are produced, recorded and printable. */
export function runDunning(repo, { as_of = today(), policy_id = null, customer_ids = null, subsidiary_id = null, dry_run = false } = {}) {
  const { candidates, skipped } = dunningCandidates(repo, { as_of, policy_id, customer_ids, subsidiary_id });
  if (dry_run) {
    return {
      as_of, dry_run: true, issued: candidates.length, skipped,
      notices: candidates.map((c) => ({
        customer_id: c.customer_id, customer_name: c.name, level_no: c.level.level_no,
        level_name: c.level.name, overdue: c.overdue, oldest_days: c.oldest_days,
        credit_hold: !!c.level.credit_hold,
      })),
    };
  }

  const notices = [];
  const now = nowIso();
  for (const c of candidates) {
    // The letter is written to the customer, so it speaks their currency --
    // not the reporting currency the worklist ranks them in. A sterling
    // customer told they owe dollars will simply write back to ask why.
    const view = statement(repo, c.customer_id, { as_of });
    const items = view.lines.filter((l) => l.days_overdue > 0);
    const values = {
      account: c.entity_no || c.name, customer: c.name,
      overdue: Money.format(view.overdue, view.currency),
      balance: Money.format(view.total, view.currency),
      oldest_days: String(view.oldest_days), as_of, level: String(c.level.level_no),
      last_notice_date: c.last_notice_date || 'our earlier letter',
      documents: String(items.length),
    };
    const noticeNo = nextNumber(repo, 'dunning_notice');
    const id = ulid();
    repo.insert('dunning_notice', {
      id, notice_no: noticeNo, customer_id: c.customer_id, policy_id: c.policy_id,
      level_no: c.level.level_no, level_name: c.level.name, as_of,
      currency: view.currency,
      total_due: view.total, total_overdue: view.overdue, oldest_days: view.oldest_days,
      document_count: items.length,
      subject: render(c.level.subject, values), body: render(c.level.body, values),
      documents: items.map((i) => ({
        txn_id: i.txn_id, txn_no: i.reference, type: i.type, txn_date: i.date, due_date: i.due_date,
        currency: i.currency, outstanding: i.outstanding, document_outstanding: i.document_outstanding,
        days_overdue: i.days_overdue,
      })),
      status: 'issued', created_at: now, created_by: repo.ctx?.user?.id || null,
    });

    const customerChanges = { dunning_level: c.level.level_no, last_dunned_at: as_of, updated_at: now };
    if (c.level.credit_hold) customerChanges.credit_hold = 1;
    repo.update('customer', c.customer_id, customerChanges);
    notices.push({
      id, notice_no: noticeNo, customer_id: c.customer_id, customer_name: c.name,
      level_no: c.level.level_no, level_name: c.level.name, currency: view.currency,
      overdue: view.overdue, oldest_days: view.oldest_days, credit_hold: !!c.level.credit_hold,
    });
  }

  if (notices.length) {
    audit.record(repo, {
      recordType: 'dunning_notice', recordId: null, action: 'run',
      changes: { as_of: { from: null, to: as_of }, notices: { from: 0, to: notices.length } },
    });
  }
  return { as_of, dry_run: false, issued: notices.length, notices, skipped };
}

export function getNotice(repo, id) {
  const n = repo.get('dunning_notice', id);
  if (!n) throw notFound('Dunning notice not found');
  return { ...n, customer: repo.get('customer', n.customer_id) };
}

export const noticeHistory = (repo, { customer_id = null, limit = 50 } = {}) => repo.query(
  `SELECT n.*, c.name AS customer_name, c.entity_no
   FROM dunning_notice n JOIN customer c ON c.tenant_id = n.tenant_id AND c.id = n.customer_id
   WHERE n.tenant_id = :t${customer_id ? ' AND n.customer_id = ?' : ''}
   ORDER BY n.as_of DESC, n.notice_no DESC LIMIT ?`,
  customer_id ? [customer_id, Number(limit) || 50] : [Number(limit) || 50]);

/**
 * Withdraw a notice that should not have gone out. The customer drops back to
 * the highest rung still standing, so the next run does not skip ahead.
 */
export function cancelNotice(repo, id, { reason = '' } = {}) {
  const n = repo.get('dunning_notice', id);
  if (!n) throw notFound('Dunning notice not found');
  if (n.status === 'cancelled') throw conflict(`${n.notice_no} is already cancelled.`);
  repo.update('dunning_notice', id, { status: 'cancelled' });
  const standing = repo.queryOne(
    `SELECT MAX(level_no) AS level_no, MAX(as_of) AS as_of FROM dunning_notice
     WHERE tenant_id = :t AND customer_id = ? AND status = 'issued'`, [n.customer_id]);
  repo.update('customer', n.customer_id, {
    dunning_level: standing?.level_no || 0,
    last_dunned_at: standing?.as_of || null,
    updated_at: nowIso(),
  });
  audit.record(repo, {
    recordType: 'dunning_notice', recordId: id, action: 'cancel',
    changes: { status: { from: 'issued', to: 'cancelled' }, reason: { from: null, to: reason || 'Withdrawn' } },
  });
  return getNotice(repo, id);
}

export function noticePdf(repo, id) {
  const n = getNotice(repo, id);
  const c = n.customer || {};
  const addr = c.billing_address || {};
  const company = repo.queryOne('SELECT name FROM tenant WHERE id = :t')?.name || 'Meridian';
  const where = [addr.line1, addr.line2, addr.city, addr.state, addr.postcode, addr.country].filter(Boolean).join(', ');
  const docs = Array.isArray(n.documents) ? n.documents : [];

  return buildReportPdf({
    title: n.subject || `${n.level_name} — account ${c.entity_no || ''}`.trim(),
    subtitle: `${c.name || ''} — ${n.as_of} — notice ${n.notice_no}`,
    currency: n.currency,
    footer: `${company} · ${n.level_name} · ${n.notice_no}`,
    sections: [
      { paragraphs: [where, '', `Dear ${c.name || 'Sir or Madam'},`, '', n.body, '', 'Yours faithfully,', company].filter((x) => x !== undefined) },
      {
        title: 'Items outstanding',
        columns: [
          { key: 'txn_no', label: 'Document', width: 80 },
          { key: 'txn_date', label: 'Dated', type: 'date', width: 66 },
          { key: 'due_date', label: 'Due', type: 'date', width: 66 },
          { key: 'days_overdue', label: 'Days late', type: 'number', width: 58 },
          { key: 'outstanding', label: 'Outstanding', type: 'money', width: 84 },
        ],
        rows: docs.map((d) => ({ ...d, outstanding: Money.toNumber(d.outstanding) })),
        totals: { outstanding: Money.toNumber(sum(docs, (d) => d.outstanding)) },
        note: n.total_due !== n.total_overdue
          ? `The balance on the account is ${Money.format(n.total_due, n.currency)}; the items above are the part of it now past due.`
          : null,
      },
    ],
  });
}

// ------------------------------------------------------- collector state
export function updateCollectionState(repo, customerId, patch) {
  const c = repo.get('customer', customerId);
  if (!c) throw notFound('Customer not found');
  const changes = { updated_at: nowIso() };
  if (patch.collector_id !== undefined) changes.collector_id = patch.collector_id || null;
  if (patch.dunning_policy_id !== undefined) changes.dunning_policy_id = patch.dunning_policy_id || null;
  if (patch.no_dunning !== undefined) changes.no_dunning = patch.no_dunning ? 1 : 0;
  if (patch.credit_hold !== undefined) changes.credit_hold = patch.credit_hold ? 1 : 0;
  if (patch.collection_note !== undefined) changes.collection_note = String(patch.collection_note || '').slice(0, 2000);
  if (patch.promise_date !== undefined) {
    if (patch.promise_date && !isValidDate(patch.promise_date)) throw new ValidationError({ promise_date: 'Enter a valid date' });
    changes.promise_date = patch.promise_date || null;
  }
  if (patch.promise_amount !== undefined) changes.promise_amount = Money.parse(patch.promise_amount || 0);
  if (patch.dunning_level !== undefined) changes.dunning_level = Math.max(0, Number(patch.dunning_level) || 0);
  repo.update('customer', customerId, changes);
  audit.record(repo, { recordType: 'customer', recordId: customerId, action: 'collections', before: c, after: { ...c, ...changes } });
  return repo.get('customer', customerId);
}

// ------------------------------------------------------------ write-off
/**
 * Admit the money is not coming.
 *
 * It settles as a payment would -- same application, same relief of the
 * receivable at the rate it was booked at, same closing of the document -- but
 * the debit is the loss rather than the bank. Against the allowance if one has
 * been provided for, otherwise straight to Bad Debt Expense.
 */
export function writeOff(repo, txnId, { amount = null, as_of = today(), reason = '', use_allowance = false } = {}) {
  const invoice = repo.get('txn', txnId);
  if (!invoice) throw notFound('Invoice not found');
  if (invoice.type !== 'INVOICE') throw unprocessable(`${invoice.txn_no} is not an invoice. Only an invoice can be written off.`);
  if (invoice.status === 'voided' || invoice.status === 'cancelled') throw unprocessable(`${invoice.txn_no} is ${invoice.status}.`);
  if (invoice.amount_remaining <= 0) throw unprocessable(`${invoice.txn_no} has nothing left outstanding.`);
  if (!isValidDate(as_of)) throw new ValidationError({ as_of: 'Enter a valid date' });

  const value = amount === null || amount === undefined || amount === '' ? invoice.amount_remaining : Money.parse(amount);
  if (value <= 0) throw new ValidationError({ amount: 'Enter an amount greater than zero' });
  if (value > invoice.amount_remaining) {
    throw new ValidationError({ amount: `${invoice.txn_no} has only ${Money.format(invoice.amount_remaining, invoice.currency)} outstanding` });
  }

  const acc = postingAccounts(repo);
  const account = use_allowance ? acc.allowance_doubtful : acc.bad_debt;
  if (!account) {
    throw unprocessable(use_allowance
      ? 'No Allowance for Doubtful Accounts is configured. Add account 1150 to the chart.'
      : 'No Bad Debt Expense account is configured. Add account 6900 to the chart.');
  }

  const payment = T.createPayment(repo, 'CUSTOMER_PAYMENT', {
    entity_id: invoice.entity_id, subsidiary_id: invoice.subsidiary_id,
    txn_date: as_of, currency: invoice.currency, amount: Money.toNumber(value),
    memo: reason ? `Bad debt write-off — ${reason}` : `Bad debt write-off — ${invoice.txn_no}`,
    reference: invoice.txn_no,
    applications: [{ txn_id: invoice.id, amount: Money.toNumber(value) }],
    custom: { write_off_account_id: account, write_off: true, write_off_reason: reason || '' },
  });
  audit.record(repo, {
    recordType: 'txn', recordId: invoice.id, action: 'write_off',
    changes: {
      amount: { from: null, to: Money.toNumber(value) },
      account: { from: null, to: use_allowance ? 'allowance' : 'bad debt expense' },
      document: { from: null, to: payment.txn_no },
      reason: { from: null, to: reason || '' },
    },
  });
  return { invoice: repo.get('txn', invoice.id), write_off: payment };
}

// ------------------------------------------------------------ allowance
/**
 * The default provision matrix: how much of each aging bucket is expected
 * never to arrive. Deliberately conservative and deliberately editable --
 * every business has its own history, and this is a starting point, not a
 * claim about anybody's customers.
 */
export const DEFAULT_MATRIX = [0, 1, 5, 20, 50];

/**
 * Top the allowance up (or release it) to what the aged balance implies.
 *
 * The allowance is a standing provision, not a period entry, so it is not
 * reversed: each run adjusts it to the new target and books the difference.
 */
export function allowance(repo, { as_of = today(), matrix = DEFAULT_MATRIX, subsidiary_id = null, dry_run = false, memo = '' } = {}) {
  if (!isValidDate(as_of)) throw new ValidationError({ as_of: 'Enter a valid date' });
  const pct = AGING_BANDS.map((_, i) => {
    const v = Number(matrix?.[i]);
    if (!Number.isFinite(v) || v < 0 || v > 100) throw new ValidationError({ matrix: 'Each rate must be a percentage between 0 and 100' });
    return v;
  });

  const work = worklist(repo, { as_of, subsidiary_id, include_current: true, min_days: 0 });
  const bands = AGING_BANDS.map((b, i) => {
    const balance = work.totals.buckets[i];
    return { label: b.label, rate: pct[i], balance, provision: Math.round((balance * pct[i]) / 100) };
  });
  const target = sum(bands, (b) => b.provision);

  const acc = postingAccounts(repo);
  const allowanceAccount = acc.allowance_doubtful;
  const expenseAccount = acc.bad_debt;
  if (!allowanceAccount || !expenseAccount) {
    throw unprocessable('Provisioning needs both an Allowance for Doubtful Accounts (1150) and a Bad Debt Expense (6900) account.');
  }
  // The allowance is a contra-asset: it sits on the books as a credit, so its
  // debit-positive balance is negative and the provision is its mirror.
  const carried = repo.scalar(
    `SELECT COALESCE(SUM(jl.base_debit - jl.base_credit), 0) v FROM journal_line jl
     JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
     WHERE jl.tenant_id = :t AND jl.account_id = ? AND je.status = 'posted' AND je.txn_date <= ?`,
    [allowanceAccount, as_of], 0);
  const held = carried === 0 ? 0 : -carried;
  const movement = target - held;

  const result = {
    as_of, bands, target, held, movement,
    coverage_pct: work.totals.total ? round((target / work.totals.total) * 1000) / 10 : 0,
    receivables: work.totals.total, dry_run: !!dry_run, posted: false, entry: null,
  };
  if (dry_run || !movement) return result;

  const entry = gl.postJournal(repo, {
    subsidiary_id: subsidiary_id || repo.queryOne('SELECT id FROM subsidiary WHERE tenant_id = :t ORDER BY created_at LIMIT 1')?.id,
    txn_date: as_of, memo: memo || `Allowance for doubtful accounts at ${as_of}`,
    source_type: 'allowance',
    lines: movement > 0
      ? [
        { account_id: expenseAccount, debit: movement, memo: 'Increase in provision' },
        { account_id: allowanceAccount, credit: movement, memo: `Provision at ${as_of}` },
      ]
      : [
        { account_id: allowanceAccount, debit: -movement, memo: `Provision released at ${as_of}` },
        { account_id: expenseAccount, credit: -movement, memo: 'Release of provision' },
      ],
  });
  audit.record(repo, {
    recordType: 'journal_entry', recordId: entry.id, action: 'allowance',
    changes: {
      target: { from: Money.toNumber(held), to: Money.toNumber(target) },
      movement: { from: null, to: Money.toNumber(movement) },
    },
  });
  return { ...result, posted: true, entry };
}
