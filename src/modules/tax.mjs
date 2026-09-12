// Meridian ERP :: modules/tax
// The sales tax return, and the 1099s.
//
// Tax charged on sales and tax suffered on purchases both land on one control
// account, which nets to what is owed. That number is the easy part. The hard
// part is everything around it: which transactions it came from, whether the
// bill somebody entered a fortnight after the quarter closed has been claimed
// yet, and being able to answer both two years later when the filing is
// audited.
//
// So a return is a snapshot with its workings attached, and filing it stamps
// every transaction it counted. Each transaction is therefore counted once
// and exactly once: a late one falls into the next return, which is what the
// authority expects anyway.
import { ulid, Money, nowIso, today, isValidDate, sum } from '../core/util.mjs';
import { ValidationError, notFound, unprocessable, conflict } from '../core/http.mjs';
import { nextNumber } from '../core/seq.mjs';
import { buildReportPdf } from '../core/pdf.mjs';
import { toCsv } from '../core/csv.mjs';
import * as gl from './gl.mjs';
import * as audit from '../core/audit.mjs';

/** Sales add to the tax owed; purchases and credits take it away. */
const SALES = ['INVOICE', 'CREDIT_MEMO'];
const PURCHASES = ['VENDOR_BILL', 'VENDOR_RETURN'];
const NEGATED = ['CREDIT_MEMO', 'VENDOR_RETURN'];

export const FORMS = ['1099-NEC', '1099-MISC'];
/** The boxes anybody actually uses, in the order the forms print them. */
export const FORM_BOXES = {
  '1099-NEC': [['1', 'Nonemployee compensation'], ['4', 'Federal income tax withheld']],
  '1099-MISC': [['1', 'Rents'], ['2', 'Royalties'], ['3', 'Other income'],
    ['6', 'Medical and health care payments'], ['7', 'Direct sales'], ['10', 'Gross proceeds to an attorney']],
};
/** Below this in a calendar year, no form is required. */
export const REPORTING_THRESHOLD = 60000;   // $600.00 in minor units

// ------------------------------------------------------------- the return
/**
 * Everything not yet returned, up to `period_to`.
 *
 * Inclusion is deliberately not "dated in the period". It is "dated on or
 * before the period end, and never returned" -- so a bill entered late
 * against a quarter already filed lands in this one instead of falling down
 * the gap between them.
 */
export function computeReturn(repo, { period_from, period_to, subsidiary_id = null, country = null } = {}) {
  if (!isValidDate(period_from)) throw new ValidationError({ period_from: 'Enter a valid start date' });
  if (!isValidDate(period_to)) throw new ValidationError({ period_to: 'Enter a valid end date' });
  if (period_to < period_from) throw new ValidationError({ period_to: 'The period ends before it starts' });

  const sub = subsidiary_id || repo.queryOne('SELECT id FROM subsidiary WHERE tenant_id = :t ORDER BY created_at LIMIT 1')?.id;
  if (!sub) throw unprocessable('No subsidiary is set up to file for.');
  const currency = gl.subsidiaryCurrency(repo, sub) || 'USD';

  const types = [...SALES, ...PURCHASES];
  const rows = repo.query(
    `SELECT t.id, t.type, t.txn_no, t.txn_date, t.entity_id, t.fx_rate,
            l.tax_code, l.tax_rate, l.tax_amount, l.amount
     FROM txn t JOIN txn_line l ON l.tenant_id = t.tenant_id AND l.txn_id = t.id
     WHERE t.tenant_id = :t AND t.subsidiary_id = ? AND t.type IN (${types.map(() => '?').join(',')})
       AND t.status NOT IN ('voided','cancelled') AND t.posted = 1
       AND t.tax_return_id IS NULL AND t.txn_date <= ?
     ORDER BY t.txn_date, t.txn_no, l.line_no`, [sub, ...types, period_to]);

  const codes = new Map();
  for (const c of repo.query('SELECT code, name, rate, country FROM tax_code WHERE tenant_id = :t')) codes.set(c.code, c);

  const byCode = new Map();
  const documents = new Map();
  let lateCount = 0; let lateTax = 0;

  for (const r of rows) {
    const code = r.tax_code || '';
    const meta = codes.get(code);
    // A return is filed with one authority. A line taxed in another country's
    // code belongs on that country's return, not this one.
    if (country && meta && meta.country && meta.country !== country) continue;
    if (!code && !r.tax_amount) continue;

    const sign = NEGATED.includes(r.type) ? -1 : 1;
    const isSale = SALES.includes(r.type);
    const net = Money.convert(r.amount * sign, r.fx_rate || 1);
    const tax = Money.convert(r.tax_amount * sign, r.fx_rate || 1);

    if (!byCode.has(code)) {
      byCode.set(code, {
        tax_code: code || '(none)', name: meta?.name || 'No tax code', rate: meta?.rate ?? r.tax_rate ?? 0,
        sales_net: 0, output_tax: 0, purchases_net: 0, input_tax: 0,
      });
    }
    const b = byCode.get(code);
    if (isSale) { b.sales_net += net; b.output_tax += tax; } else { b.purchases_net += net; b.input_tax += tax; }

    if (!documents.has(r.id)) {
      const late = r.txn_date < period_from;
      documents.set(r.id, {
        txn_id: r.id, txn_no: r.txn_no, type: r.type, txn_date: r.txn_date, late,
        net: 0, tax: 0, effect: 0,
      });
      if (late) lateCount++;
    }
    const d = documents.get(r.id);
    d.net += net;
    d.tax += tax;
    // Tax charged on a sale is owed; tax suffered on a purchase is reclaimed.
    d.effect += isSale ? tax : -tax;
    if (d.late) lateTax += isSale ? tax : -tax;
  }

  const lines = [...byCode.values()].sort((a, b) => b.output_tax + b.input_tax - (a.output_tax + a.input_tax));
  const salesNet = sum(lines, (l) => l.sales_net);
  const outputTax = sum(lines, (l) => l.output_tax);
  const purchasesNet = sum(lines, (l) => l.purchases_net);
  const inputTax = sum(lines, (l) => l.input_tax);

  return {
    period_from, period_to, subsidiary_id: sub, country: country || '', currency,
    lines,
    documents: [...documents.values()].sort((a, b) => (a.txn_date < b.txn_date ? -1 : 1)),
    sales_net: salesNet, output_tax: outputTax,
    purchases_net: purchasesNet, input_tax: inputTax,
    net_tax: outputTax - inputTax,
    late_count: lateCount, late_tax: lateTax,
    txn_count: documents.size,
    ...reconciliation(repo, sub, period_to, outputTax - inputTax),
  };
}

/**
 * How the tax control account is made up.
 *
 * The account carries every return ever filed until the money is actually
 * paid over, plus whatever is accruing in the open period. So the question is
 * not "does the control equal this return" -- it never does -- but "does the
 * control break down into parts anybody can name". Three numbers that add up,
 * and a remainder that is settlements to the authority and any journal posted
 * straight to the account. A remainder nobody expected is exactly the thing
 * worth finding before a return goes in.
 */
function reconciliation(repo, subsidiaryId, asOf, netTax) {
  const control = controlBalance(repo, subsidiaryId, asOf);
  if (control === null) return { control_balance: null, filed_total: 0, other_movement: 0 };
  const filed = repo.scalar(
    `SELECT COALESCE(SUM(net_tax), 0) v FROM tax_return
     WHERE tenant_id = :t AND subsidiary_id = ? AND status = 'filed' AND period_to <= ?`,
    [subsidiaryId, asOf], 0);
  return {
    control_balance: control,
    filed_total: filed,
    other_movement: control - netTax - filed,
  };
}

/** What the sales tax control account is carrying, as a positive liability. */
function controlBalance(repo, subsidiaryId, asOf) {
  const account = repo.queryOne("SELECT id FROM account WHERE tenant_id = :t AND number = '2100'");
  if (!account) return null;
  const carried = repo.scalar(
    `SELECT COALESCE(SUM(jl.base_debit - jl.base_credit), 0) v FROM journal_line jl
     JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
     WHERE jl.tenant_id = :t AND jl.account_id = ? AND je.status = 'posted'
       AND je.subsidiary_id = ? AND je.txn_date <= ?`,
    [account.id, subsidiaryId, asOf], 0);
  return carried === 0 ? 0 : -carried;
}

export function getReturn(repo, id) {
  const r = repo.get('tax_return', id);
  if (!r) throw notFound('Tax return not found');
  return {
    ...r,
    lines: repo.query('SELECT * FROM tax_return_line WHERE tenant_id = :t AND return_id = ? ORDER BY tax_code', [id]),
    documents: repo.query(
      `SELECT id AS txn_id, txn_no, type, txn_date, tax_total, total FROM txn
       WHERE tenant_id = :t AND tax_return_id = ? ORDER BY txn_date, txn_no`, [id]),
  };
}

export const history = (repo, { limit = 24 } = {}) => repo.query(
  'SELECT * FROM tax_return WHERE tenant_id = :t ORDER BY period_to DESC, created_at DESC LIMIT ?',
  [Number(limit) || 24]);

/**
 * File it. The figures are frozen and every transaction behind them is
 * stamped, so the same tax can never appear on two returns.
 */
export function fileReturn(repo, input = {}) {
  const view = computeReturn(repo, input);
  if (!view.txn_count) {
    throw unprocessable(`Nothing to return for ${view.period_from} to ${view.period_to}: no taxable transaction is outstanding.`);
  }
  const overlapping = repo.queryOne(
    `SELECT return_no FROM tax_return WHERE tenant_id = :t AND subsidiary_id = ? AND status = 'filed'
       AND period_from <= ? AND period_to >= ?`, [view.subsidiary_id, view.period_to, view.period_from]);
  if (overlapping) {
    throw conflict(`${overlapping.return_no} already covers part of ${view.period_from} to ${view.period_to}. File the next period instead.`);
  }

  const id = ulid();
  const returnNo = nextNumber(repo, 'tax_return');
  const now = nowIso();
  repo.insert('tax_return', {
    id, return_no: returnNo, subsidiary_id: view.subsidiary_id, country: view.country,
    currency: view.currency, period_from: view.period_from, period_to: view.period_to,
    sales_net: view.sales_net, output_tax: view.output_tax,
    purchases_net: view.purchases_net, input_tax: view.input_tax, net_tax: view.net_tax,
    late_count: view.late_count, late_tax: view.late_tax, txn_count: view.txn_count,
    status: 'filed', reference: input.reference || '', note: input.note || '',
    created_at: now, created_by: repo.ctx?.user?.id || null,
    filed_at: now, filed_by: repo.ctx?.user?.id || null,
  });
  for (const l of view.lines) repo.insert('tax_return_line', { id: ulid(), return_id: id, ...l });
  for (const d of view.documents) repo.update('txn', d.txn_id, { tax_return_id: id });

  audit.record(repo, {
    recordType: 'tax_return', recordId: id, action: 'file',
    changes: {
      return_no: { from: null, to: returnNo },
      period: { from: null, to: `${view.period_from} to ${view.period_to}` },
      net_tax: { from: null, to: Money.toNumber(view.net_tax) },
      transactions: { from: 0, to: view.txn_count },
    },
  });
  return getReturn(repo, id);
}

/**
 * Unfile. A return sent in error releases its transactions, so the next one
 * picks them up again exactly as if it had never happened.
 */
export function unfileReturn(repo, id, { reason = '' } = {}) {
  const r = repo.get('tax_return', id);
  if (!r) throw notFound('Tax return not found');
  if (r.status !== 'filed') throw conflict(`${r.return_no} is not filed.`);
  const later = repo.queryOne(
    `SELECT return_no FROM tax_return WHERE tenant_id = :t AND subsidiary_id = ? AND status = 'filed'
       AND period_from > ? ORDER BY period_from LIMIT 1`, [r.subsidiary_id, r.period_to]);
  if (later) {
    throw conflict(`${later.return_no} covers a later period and was filed after this one. Unfile that first, or the two would overlap.`);
  }
  repo.exec('UPDATE txn SET tax_return_id = NULL WHERE tenant_id = :t AND tax_return_id = ?', [id]);
  repo.update('tax_return', id, { status: 'draft', filed_at: null, filed_by: null });
  audit.record(repo, {
    recordType: 'tax_return', recordId: id, action: 'unfile',
    changes: { status: { from: 'filed', to: 'draft' }, reason: { from: null, to: reason || 'Filed in error' } },
  });
  return getReturn(repo, id);
}

export function returnPdf(repo, id) {
  const r = getReturn(repo, id);
  const sub = repo.get('subsidiary', r.subsidiary_id);
  const company = repo.queryOne('SELECT name FROM tenant WHERE id = :t')?.name || 'Meridian';
  const owed = r.net_tax >= 0;

  return buildReportPdf({
    title: 'Sales tax return',
    subtitle: `${sub?.name || company} — ${r.period_from} to ${r.period_to} — ${r.return_no}`,
    currency: r.currency,
    footer: `${company} · ${r.status === 'filed' ? `filed ${String(r.filed_at || '').slice(0, 10)}` : 'draft'}`,
    sections: [
      {
        paragraphs: [
          owed
            ? `${Money.format(r.net_tax, r.currency)} is due to the authority for this period: ${Money.format(r.output_tax, r.currency)} charged on sales, less ${Money.format(r.input_tax, r.currency)} suffered on purchases.`
            : `${Money.format(-r.net_tax, r.currency)} is reclaimable for this period: ${Money.format(r.input_tax, r.currency)} suffered on purchases, against ${Money.format(r.output_tax, r.currency)} charged on sales.`,
          r.late_count
            ? `${r.late_count} transaction${r.late_count === 1 ? '' : 's'} dated before ${r.period_from} had never been returned and ${r.late_count === 1 ? 'is' : 'are'} included here, carrying ${Money.format(r.late_tax, r.currency)} of tax.`
            : '',
          r.reference ? `Authority reference: ${r.reference}.` : '',
        ].filter(Boolean),
      },
      {
        title: 'By tax code',
        columns: [
          { key: 'tax_code', label: 'Code', width: 70 },
          { key: 'name', label: 'Description' },
          { key: 'rate', label: 'Rate', type: 'percent', decimals: 2, width: 52 },
          { key: 'sales_net', label: 'Sales net', type: 'money', width: 84 },
          { key: 'output_tax', label: 'Tax on sales', type: 'money', width: 84 },
          { key: 'purchases_net', label: 'Purchases net', type: 'money', width: 90 },
          { key: 'input_tax', label: 'Tax on purchases', type: 'money', width: 96 },
        ],
        rows: r.lines.map((l) => ({
          ...l,
          sales_net: Money.toNumber(l.sales_net), output_tax: Money.toNumber(l.output_tax),
          purchases_net: Money.toNumber(l.purchases_net), input_tax: Money.toNumber(l.input_tax),
        })),
        totals: {
          sales_net: Money.toNumber(r.sales_net), output_tax: Money.toNumber(r.output_tax),
          purchases_net: Money.toNumber(r.purchases_net), input_tax: Money.toNumber(r.input_tax),
        },
        note: `Net ${owed ? 'payable' : 'reclaimable'}: ${Money.format(Math.abs(r.net_tax), r.currency)} across ${r.txn_count} transaction${r.txn_count === 1 ? '' : 's'}.`,
      },
    ],
  });
}

// ---------------------------------------------------------------- 1099
/**
 * What was actually paid to each reportable supplier in a calendar year.
 *
 * Cash basis, deliberately: a 1099 reports money that moved, not bills that
 * were entered. A supplier billed in December and paid in January is on next
 * year's form, and totalling the bills instead is the classic way to file a
 * figure the supplier disagrees with.
 */
export function report1099(repo, { year = new Date().getUTCFullYear(), subsidiary_id = null, threshold = REPORTING_THRESHOLD, include_below = false } = {}) {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 1900 || y > 2999) throw new ValidationError({ year: 'Enter a four-digit year' });
  const from = `${y}-01-01`;
  const to = `${y}-12-31`;
  const limit = Number(threshold);
  if (!Number.isFinite(limit) || limit < 0) throw new ValidationError({ threshold: 'Enter a threshold of zero or more' });

  const params = [from, to];
  const rows = repo.query(
    `SELECT v.id AS vendor_id, v.entity_no, v.name, v.legal_name, v.tax_number, v.address,
            v.tax_form, v.tax_form_box, v.email,
            COALESCE(SUM(CAST(ROUND(t.total * t.fx_rate) AS INTEGER)), 0) AS paid,
            COUNT(t.id) AS payments
     FROM vendor v
     LEFT JOIN txn t ON t.tenant_id = v.tenant_id AND t.entity_id = v.id
       AND t.type = 'VENDOR_PAYMENT' AND t.status NOT IN ('voided','cancelled') AND t.posted = 1
       AND t.txn_date >= ? AND t.txn_date <= ?${subsidiary_id ? ' AND t.subsidiary_id = ?' : ''}
     WHERE v.tenant_id = :t AND v.is_1099 = 1
     GROUP BY v.id ORDER BY paid DESC, v.name`,
    subsidiary_id ? [...params, subsidiary_id] : params);

  const all = rows.map((r) => ({
    ...r,
    reportable: r.paid >= limit,
    // A form needs somewhere to send it and a number to put on it. Saying so
    // now beats finding out in January.
    missing: [!r.tax_number && 'tax number', !r.address?.line1 && 'address'].filter(Boolean),
  }));
  const reportable = all.filter((r) => r.reportable);
  return {
    year: y, from, to, threshold: limit,
    rows: include_below ? all : reportable,
    below_threshold: all.length - reportable.length,
    total: sum(reportable, (r) => r.paid),
    vendor_count: reportable.length,
    incomplete: reportable.filter((r) => r.missing.length).length,
  };
}

/** The year's forms as a CSV, in the column order filing software expects. */
export function csv1099(repo, opts = {}) {
  const report = report1099(repo, opts);
  const rows = report.rows.map((r) => ({
    Form: r.tax_form || '1099-NEC',
    Box: r.tax_form_box || '1',
    'Payer TIN': '',
    'Recipient name': r.legal_name || r.name,
    'Recipient TIN': r.tax_number || '',
    'Account number': r.entity_no || '',
    Street: r.address?.line1 || '',
    City: r.address?.city || '',
    State: r.address?.state || '',
    Postcode: r.address?.postcode || '',
    Country: r.address?.country || '',
    Amount: Money.toNumber(r.paid).toFixed(2),
    Payments: String(r.payments),
  }));
  const columns = ['Form', 'Box', 'Payer TIN', 'Recipient name', 'Recipient TIN', 'Account number',
    'Street', 'City', 'State', 'Postcode', 'Country', 'Amount', 'Payments'];
  return {
    filename: `1099-${report.year}.csv`,
    contentType: 'text/csv; charset=utf-8',
    text: toCsv(rows, columns),
  };
}

export function pdf1099(repo, opts = {}) {
  const report = report1099(repo, opts);
  const company = repo.queryOne('SELECT name FROM tenant WHERE id = :t')?.name || 'Meridian';
  return buildReportPdf({
    title: `1099 summary ${report.year}`,
    subtitle: `${company} — payments made between ${report.from} and ${report.to}`,
    footer: `${company} · threshold ${Money.format(report.threshold)}`,
    sections: [
      {
        paragraphs: [
          `${report.vendor_count} supplier${report.vendor_count === 1 ? '' : 's'} were paid ${Money.format(report.threshold)} or more during ${report.year}, ${Money.format(report.total)} in total.`,
          report.below_threshold
            ? `${report.below_threshold} further reportable supplier${report.below_threshold === 1 ? ' was' : 's were'} paid less than the threshold and need no form.`
            : '',
          report.incomplete
            ? `${report.incomplete} of them ${report.incomplete === 1 ? 'is' : 'are'} missing a tax number or an address. A form cannot be filed without both.`
            : '',
        ].filter(Boolean),
      },
      {
        title: 'Reportable suppliers',
        columns: [
          { key: 'entity_no', label: 'Account', width: 62 },
          { key: 'name', label: 'Supplier' },
          { key: 'tax_number', label: 'Tax number', width: 96 },
          { key: 'tax_form', label: 'Form', width: 68 },
          { key: 'tax_form_box', label: 'Box', width: 38 },
          { key: 'payments', label: 'Payments', type: 'number', width: 62 },
          { key: 'paid', label: 'Paid', type: 'money', width: 90 },
        ],
        rows: report.rows.map((r) => ({ ...r, paid: Money.toNumber(r.paid) })),
        totals: { paid: Money.toNumber(report.total) },
      },
    ],
  });
}
