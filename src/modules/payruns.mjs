// Meridian ERP :: modules/payruns
// Paying the suppliers, once a week, in one sitting.
//
// Paying bills one at a time works until there are two hundred of them. What
// an accounts payable clerk does is pick a date, look at everything falling
// due before it, take a few things off the list, and send one payment to each
// supplier covering whatever of theirs is left on it.
//
// The run is therefore two objects in one: a proposal that can be argued with
// before any money moves, and a record afterwards of exactly which bills each
// payment settled. The second is what a remittance advice is built from, and
// the first thing anybody asks when a supplier queries a payment.
import { ulid, Money, nowIso, today, isValidDate, daysBetween, sum } from '../core/util.mjs';
import { ValidationError, notFound, unprocessable, conflict } from '../core/http.mjs';
import { nextNumber } from '../core/seq.mjs';
import { buildReportPdf } from '../core/pdf.mjs';
import { toCsv } from '../core/csv.mjs';
import * as gl from './gl.mjs';
import * as T from './txn.mjs';
import * as audit from '../core/audit.mjs';

export const STATUSES = ['draft', 'paid', 'cancelled'];

export function getRun(repo, id) {
  const r = repo.get('payment_run', id);
  if (!r) throw notFound('Payment run not found');
  return { ...r, bank: repo.get('bank_account', r.bank_account_id), vendors: byVendor(repo, id) };
}

export const linesFor = (repo, id) => repo.query(
  `SELECT l.*, v.name AS vendor_name, v.entity_no AS vendor_no, v.payment_method, v.bank_reference,
          v.remittance_email, v.payment_hold,
          t.txn_no, t.txn_date, t.reference, t.memo AS bill_memo, t.amount_remaining
   FROM payment_run_line l
   JOIN vendor v ON v.tenant_id = l.tenant_id AND v.id = l.vendor_id
   JOIN txn t ON t.tenant_id = l.tenant_id AND t.id = l.txn_id
   WHERE l.tenant_id = :t AND l.run_id = ?
   ORDER BY v.name, l.due_date, t.txn_no`, [id]);

/** The run grouped the way it will actually be paid: one payment per vendor. */
export function byVendor(repo, id) {
  const lines = linesFor(repo, id);
  const groups = new Map();
  for (const l of lines) {
    if (!groups.has(l.vendor_id)) {
      groups.set(l.vendor_id, {
        vendor_id: l.vendor_id, vendor_name: l.vendor_name, vendor_no: l.vendor_no,
        currency: l.currency, payment_method: l.payment_method, bank_reference: l.bank_reference,
        remittance_email: l.remittance_email, payment_hold: !!l.payment_hold,
        payment_txn_id: l.payment_txn_id || null,
        lines: [], total: 0, selected_count: 0,
      });
    }
    const g = groups.get(l.vendor_id);
    g.lines.push(l);
    if (l.selected) { g.total += l.amount_pay; g.selected_count++; }
    if (l.payment_txn_id) g.payment_txn_id = l.payment_txn_id;
  }
  const out = [...groups.values()];
  for (const g of out) {
    g.payment_no = g.payment_txn_id ? repo.get('txn', g.payment_txn_id)?.txn_no || null : null;
  }
  return out.sort((a, b) => b.total - a.total || a.vendor_name.localeCompare(b.vendor_name));
}

/**
 * Build a proposal.
 *
 * Everything open and due by the cut-off goes on the list; a vendor on
 * payment hold goes on it too, but unticked and labelled, because silently
 * dropping a supplier from a run is how a held account stays held for a year
 * after the dispute was settled.
 */
export function proposeRun(repo, input = {}) {
  const errors = {};
  const bank = input.bank_account_id ? repo.get('bank_account', input.bank_account_id) : null;
  if (!bank) errors.bank_account_id = 'Choose the bank account the money leaves';
  const paymentDate = input.payment_date || today();
  const payThrough = input.pay_through || paymentDate;
  if (!isValidDate(paymentDate)) errors.payment_date = 'Enter a valid payment date';
  if (!isValidDate(payThrough)) errors.pay_through = 'Enter a valid cut-off date';
  if (Object.keys(errors).length) throw new ValidationError(errors);

  const subsidiaryId = input.subsidiary_id || bank.subsidiary_id;
  const currency = bank.currency || gl.subsidiaryCurrency(repo, subsidiaryId) || 'USD';

  // A payment is made from one bank account, so it can only settle bills in
  // that account's currency. Anything else needs its own run, and saying so
  // is better than quietly converting somebody's euros into dollars.
  const params = [subsidiaryId, currency, payThrough];
  let where = '';
  if (Array.isArray(input.vendor_ids) && input.vendor_ids.length) {
    where += ` AND t.entity_id IN (${input.vendor_ids.map(() => '?').join(',')})`;
    params.push(...input.vendor_ids);
  }
  const bills = repo.query(
    `SELECT t.id, t.txn_no, t.txn_date, t.due_date, t.currency, t.amount_remaining, t.entity_id
     FROM txn t
     WHERE t.tenant_id = :t AND t.type = 'VENDOR_BILL' AND t.subsidiary_id = ?
       AND t.status NOT IN ('voided','cancelled') AND t.posted = 1
       AND t.amount_remaining > 0 AND t.currency = ?
       AND COALESCE(t.due_date, t.txn_date) <= ?${where}
     ORDER BY t.entity_id, t.due_date, t.txn_no`, params);

  if (!bills.length) {
    throw unprocessable(`Nothing is due for payment from ${bank.name} on or before ${payThrough}.`);
  }

  const now = nowIso();
  const id = ulid();
  repo.insert('payment_run', {
    id, run_no: nextNumber(repo, 'payment_run'), subsidiary_id: subsidiaryId,
    bank_account_id: bank.id, currency, payment_date: paymentDate, pay_through: payThrough,
    memo: input.memo || '', status: 'draft',
    vendor_count: 0, bill_count: 0, total: 0,
    created_at: now, created_by: repo.ctx?.user?.id || null,
  });

  const holds = new Set(repo.query('SELECT id FROM vendor WHERE tenant_id = :t AND payment_hold = 1').map((v) => v.id));
  for (const b of bills) {
    const held = holds.has(b.entity_id);
    repo.insert('payment_run_line', {
      id: ulid(), run_id: id, vendor_id: b.entity_id, txn_id: b.id, currency: b.currency,
      due_date: b.due_date || b.txn_date,
      days_overdue: b.due_date ? Math.max(0, daysBetween(b.due_date, paymentDate)) : 0,
      amount_due: b.amount_remaining, amount_pay: b.amount_remaining,
      selected: held ? 0 : 1, payment_txn_id: null,
    });
  }
  retotal(repo, id);
  audit.record(repo, {
    recordType: 'payment_run', recordId: id, action: 'create',
    changes: { bills: { from: 0, to: bills.length }, pay_through: { from: null, to: payThrough } },
  });
  return getRun(repo, id);
}

function retotal(repo, id) {
  const rows = repo.query(
    `SELECT vendor_id, selected, amount_pay FROM payment_run_line WHERE tenant_id = :t AND run_id = ?`, [id]);
  const chosen = rows.filter((r) => r.selected);
  repo.update('payment_run', id, {
    vendor_count: new Set(chosen.map((r) => r.vendor_id)).size,
    bill_count: chosen.length,
    total: sum(chosen, (r) => r.amount_pay),
  });
}

/** Tick, untick, or part-pay. The only thing a draft run is for. */
export function updateLines(repo, id, lines) {
  const run = repo.get('payment_run', id);
  if (!run) throw notFound('Payment run not found');
  if (run.status !== 'draft') throw conflict(`${run.run_no} is ${run.status} and can no longer be changed.`);
  if (!Array.isArray(lines)) throw new ValidationError({ lines: 'Send the lines to change' });

  const errors = {};
  const updates = [];
  lines.forEach((patch, i) => {
    const line = repo.get('payment_run_line', patch.id);
    if (!line || line.run_id !== id) { errors[`lines.${i}.id`] = 'That line is not part of this run'; return; }
    const selected = patch.selected === undefined ? !!line.selected : !!patch.selected;
    let amount = patch.amount_pay === undefined ? line.amount_pay : Money.parse(patch.amount_pay);
    if (amount < 0) { errors[`lines.${i}.amount_pay`] = 'A payment cannot be negative'; return; }
    if (amount > line.amount_due) {
      errors[`lines.${i}.amount_pay`] = `Only ${Money.format(line.amount_due, line.currency)} is outstanding on that bill`;
      return;
    }
    if (selected && amount === 0) { errors[`lines.${i}.amount_pay`] = 'Enter an amount, or untick the bill'; return; }
    updates.push({ id: line.id, selected: selected ? 1 : 0, amount_pay: amount });
  });
  if (Object.keys(errors).length) throw new ValidationError(errors, 'Some lines could not be changed');
  for (const u of updates) repo.update('payment_run_line', u.id, { selected: u.selected, amount_pay: u.amount_pay });
  retotal(repo, id);
  return getRun(repo, id);
}

/**
 * Commit: one payment per vendor, each applied to that vendor's chosen bills.
 *
 * Amounts are re-read from the bills at this moment rather than trusted from
 * the proposal, because a bill can be paid, credited or voided between the
 * run being built and somebody pressing the button -- and a payment applied
 * to a bill that is already settled leaves the payables control account
 * disagreeing with the bills behind it.
 */
export function commitRun(repo, id, { payment_date = null } = {}) {
  const run = repo.get('payment_run', id);
  if (!run) throw notFound('Payment run not found');
  if (run.status !== 'draft') throw conflict(`${run.run_no} has already been ${run.status}.`);
  const date = payment_date || run.payment_date;
  if (!isValidDate(date)) throw new ValidationError({ payment_date: 'Enter a valid payment date' });
  gl.requireOpenPeriod(repo, date);

  const groups = byVendor(repo, id).filter((g) => g.selected_count > 0);
  if (!groups.length) throw unprocessable(`Nothing is ticked on ${run.run_no}. Select at least one bill before paying.`);

  const payments = [];
  const dropped = [];
  for (const g of groups) {
    const applications = [];
    for (const l of g.lines) {
      if (!l.selected) continue;
      const bill = repo.get('txn', l.txn_id);
      if (!bill || bill.status === 'voided' || bill.status === 'cancelled') {
        dropped.push({ vendor: g.vendor_name, txn_no: l.txn_no, reason: 'the bill was voided since the run was built' });
        continue;
      }
      const payable = Math.min(l.amount_pay, bill.amount_remaining);
      if (payable <= 0) {
        dropped.push({ vendor: g.vendor_name, txn_no: l.txn_no, reason: 'the bill was settled since the run was built' });
        continue;
      }
      if (payable !== l.amount_pay) {
        dropped.push({
          vendor: g.vendor_name, txn_no: l.txn_no,
          reason: `part-settled since the run was built; ${Money.format(payable, l.currency)} paid instead of ${Money.format(l.amount_pay, l.currency)}`,
        });
        repo.update('payment_run_line', l.id, { amount_pay: payable });
      }
      applications.push({ line_id: l.id, txn_id: l.txn_id, amount: Money.toNumber(payable) });
    }
    if (!applications.length) continue;

    const payment = T.createPayment(repo, 'VENDOR_PAYMENT', {
      entity_id: g.vendor_id, subsidiary_id: run.subsidiary_id, txn_date: date,
      currency: run.currency, amount: sum(applications, (a) => a.amount),
      memo: run.memo ? `${run.run_no} — ${run.memo}` : `Payment run ${run.run_no}`,
      reference: run.run_no,
      applications: applications.map(({ txn_id, amount }) => ({ txn_id, amount })),
      custom: { bank_account_id: run.bank_account_id, payment_run_id: id },
    });
    repo.update('txn', payment.id, { payment_run_id: id });
    for (const a of applications) repo.update('payment_run_line', a.line_id, { payment_txn_id: payment.id });
    payments.push({
      vendor_id: g.vendor_id, vendor_name: g.vendor_name, txn_id: payment.id,
      txn_no: payment.txn_no, amount: payment.total, bills: applications.length,
    });
  }

  if (!payments.length) throw unprocessable(`Nothing on ${run.run_no} is still payable — every bill on it has been settled or voided since it was built.`);

  retotal(repo, id);
  repo.update('payment_run', id, {
    status: 'paid', payment_date: date, paid_at: nowIso(), paid_by: repo.ctx?.user?.id || null,
  });
  audit.record(repo, {
    recordType: 'payment_run', recordId: id, action: 'pay',
    changes: {
      payments: { from: 0, to: payments.length },
      total: { from: null, to: Money.toNumber(sum(payments, (p) => p.amount)) },
    },
  });
  return { run: getRun(repo, id), payments, dropped };
}

/** Abandon a draft. A committed run is history and stays put. */
export function cancelRun(repo, id, { reason = '' } = {}) {
  const run = repo.get('payment_run', id);
  if (!run) throw notFound('Payment run not found');
  if (run.status === 'paid') throw conflict(`${run.run_no} has been paid. Void the individual payments instead.`);
  if (run.status === 'cancelled') throw conflict(`${run.run_no} is already cancelled.`);
  repo.update('payment_run', id, { status: 'cancelled' });
  audit.record(repo, {
    recordType: 'payment_run', recordId: id, action: 'cancel',
    changes: { status: { from: 'draft', to: 'cancelled' }, reason: { from: null, to: reason || 'Abandoned' } },
  });
  return getRun(repo, id);
}

export const history = (repo, { status = null, limit = 30 } = {}) => repo.query(
  `SELECT r.*, b.name AS bank_name FROM payment_run r
   LEFT JOIN bank_account b ON b.tenant_id = r.tenant_id AND b.id = r.bank_account_id
   WHERE r.tenant_id = :t${status && status !== 'all' ? ' AND r.status = ?' : ''}
   ORDER BY r.payment_date DESC, r.run_no DESC LIMIT ?`,
  status && status !== 'all' ? [status, Number(limit) || 30] : [Number(limit) || 30]);

/** What is waiting to be paid, whether or not a run has been built for it. */
export function dueSummary(repo, { pay_through = today(), subsidiary_id = null } = {}) {
  if (!isValidDate(pay_through)) throw new ValidationError({ pay_through: 'Enter a valid date' });
  const params = [pay_through];
  const rows = repo.query(
    `SELECT t.currency, t.subsidiary_id, COUNT(*) AS bills, COUNT(DISTINCT t.entity_id) AS vendors,
            SUM(t.amount_remaining) AS total,
            SUM(CASE WHEN t.due_date < ? THEN t.amount_remaining ELSE 0 END) AS overdue
     FROM txn t
     WHERE t.tenant_id = :t AND t.type = 'VENDOR_BILL' AND t.status NOT IN ('voided','cancelled')
       AND t.posted = 1 AND t.amount_remaining > 0
       AND COALESCE(t.due_date, t.txn_date) <= ?${subsidiary_id ? ' AND t.subsidiary_id = ?' : ''}
     GROUP BY t.currency, t.subsidiary_id ORDER BY total DESC`,
    subsidiary_id ? [...params, pay_through, subsidiary_id] : [...params, pay_through]);
  return { pay_through, groups: rows, total_bills: sum(rows, (r) => r.bills) };
}

// -------------------------------------------------------- remittance
/** The advice a supplier needs to work out what the payment was for. */
export function remittancePdf(repo, id, vendorId) {
  const run = getRun(repo, id);
  const group = run.vendors.find((g) => g.vendor_id === vendorId);
  if (!group) throw notFound('That supplier is not on this run');
  const vendor = repo.get('vendor', vendorId);
  const company = repo.queryOne('SELECT name FROM tenant WHERE id = :t')?.name || 'Meridian';
  const paid = group.lines.filter((l) => l.selected);
  const addr = vendor?.address || {};
  const where = [addr.line1, addr.line2, addr.city, addr.state, addr.postcode, addr.country].filter(Boolean).join(', ');

  return buildReportPdf({
    title: 'Remittance advice',
    subtitle: `${vendor?.name || ''} — ${run.payment_date}${group.payment_no ? ` — ${group.payment_no}` : ''}`,
    currency: run.currency,
    footer: `${company} · ${run.run_no}`,
    sections: [
      {
        paragraphs: [
          where,
          '',
          `We have paid ${Money.format(group.total, run.currency)} to your account on ${run.payment_date}${group.bank_reference ? `, quoting reference ${group.bank_reference}` : ''}. It settles the invoices listed below.`,
          run.status === 'paid' ? '' : 'This advice is provisional: the run has not yet been committed.',
        ].filter((x) => x !== undefined),
      },
      {
        title: 'Invoices settled',
        columns: [
          { key: 'txn_no', label: 'Our reference', width: 90 },
          { key: 'reference', label: 'Your invoice', width: 100 },
          { key: 'txn_date', label: 'Dated', type: 'date', width: 66 },
          { key: 'due_date', label: 'Due', type: 'date', width: 66 },
          { key: 'bill_memo', label: 'Detail' },
          { key: 'amount_due', label: 'Invoice', type: 'money', width: 78 },
          { key: 'amount_pay', label: 'Paid', type: 'money', width: 78 },
        ],
        rows: paid.map((l) => ({
          ...l,
          amount_due: Money.toNumber(l.amount_due),
          amount_pay: Money.toNumber(l.amount_pay),
        })),
        totals: { amount_pay: Money.toNumber(group.total) },
        note: paid.some((l) => l.amount_pay < l.amount_due)
          ? 'Where the paid column is less than the invoice, the balance remains outstanding and will follow.'
          : null,
      },
    ],
  });
}

/**
 * A payment file for the bank, as CSV.
 *
 * No bank protocol is assumed: this is the columns every treasury upload
 * screen asks for, in the order they ask for them, which is a file a clerk
 * can map once and use every week.
 */
export function paymentFile(repo, id) {
  const run = getRun(repo, id);
  const rows = run.vendors
    .filter((g) => g.selected_count > 0 && !g.payment_hold)
    .map((g) => ({
      'Payment date': run.payment_date,
      Beneficiary: g.vendor_name,
      'Beneficiary ref': g.vendor_no || '',
      'Bank reference': g.bank_reference || '',
      Method: g.payment_method || 'bank_transfer',
      Currency: run.currency,
      Amount: Money.toNumber(g.total).toFixed(2),
      Reference: `${run.run_no} ${g.payment_no || ''}`.trim(),
      Invoices: g.lines.filter((l) => l.selected).map((l) => l.reference || l.txn_no).join(' '),
    }));
  const columns = ['Payment date', 'Beneficiary', 'Beneficiary ref', 'Bank reference',
    'Method', 'Currency', 'Amount', 'Reference', 'Invoices'];
  return {
    filename: `${run.run_no.toLowerCase()}-payments.csv`,
    contentType: 'text/csv; charset=utf-8',
    text: toCsv(rows, columns),
  };
}
