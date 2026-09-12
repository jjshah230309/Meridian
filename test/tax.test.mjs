// The sales tax return and the 1099s. The interesting part of a return is not
// the arithmetic — it is making sure a transaction is counted once, whatever
// order it was entered in and whichever quarter it was dated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant } from './helpers.mjs';
import * as tax from '../src/modules/tax.mjs';
import * as entities from '../src/modules/entities.mjs';
import * as txnMod from '../src/modules/txn.mjs';
import * as gl from '../src/modules/gl.mjs';
import { Money } from '../src/core/util.mjs';

const acct = (f, n) => f.repo.queryOne('SELECT * FROM account WHERE tenant_id = :t AND number = ?', [n]);
const thrown = (fn) => { try { fn(); } catch (e) { return e; } return null; };
const Q1 = { period_from: '2026-01-01', period_to: '2026-03-31' };
const Q2 = { period_from: '2026-04-01', period_to: '2026-06-30' };

function sale(f, { amount, date, tax_code = 'CA_SALES' }) {
  const customer = f.tx(() => entities.createCustomer(f.repo, { name: `Buyer ${date} ${amount}`, subsidiary_id: f.subsidiaryId }));
  return f.tx(() => txnMod.createTxn(f.repo, 'INVOICE', {
    entity_id: customer.id, subsidiary_id: f.subsidiaryId, txn_date: date,
    lines: [{ account_id: acct(f, '4020').id, quantity: 1, unit_price: amount, tax_code }],
  }));
}

function purchase(f, { amount, date, tax_code = 'CA_SALES', vendor = null }) {
  const v = vendor || f.tx(() => entities.createVendor(f.repo, { name: `Supplier ${date} ${amount}`, subsidiary_id: f.subsidiaryId }));
  return f.tx(() => txnMod.createTxn(f.repo, 'VENDOR_BILL', {
    entity_id: v.id, subsidiary_id: f.subsidiaryId, txn_date: date,
    lines: [{ account_id: acct(f, '6400').id, quantity: 1, unit_price: amount, tax_code }],
  }));
}

test('the return nets tax charged against tax suffered', () => {
  const f = freshTenant();
  sale(f, { amount: 10000, date: '2026-02-10' });      // 7.25% = 725.00
  purchase(f, { amount: 4000, date: '2026-02-20' });   // 7.25% = 290.00

  const view = tax.computeReturn(f.repo, Q1);
  assert.equal(view.sales_net, Money.parse(10000));
  assert.equal(view.output_tax, Money.parse(725));
  assert.equal(view.purchases_net, Money.parse(4000));
  assert.equal(view.input_tax, Money.parse(290));
  assert.equal(view.net_tax, Money.parse(435));
  assert.equal(view.txn_count, 2);
  assert.equal(view.lines.length, 1);
  assert.equal(view.lines[0].tax_code, 'CA_SALES');
});

test('a credit memo takes tax back off the return', () => {
  const f = freshTenant();
  const invoice = sale(f, { amount: 10000, date: '2026-02-10' });
  f.tx(() => txnMod.createTxn(f.repo, 'CREDIT_MEMO', {
    entity_id: invoice.entity_id, subsidiary_id: f.subsidiaryId, txn_date: '2026-03-01',
    lines: [{ account_id: acct(f, '4020').id, quantity: 1, unit_price: 2000, tax_code: 'CA_SALES' }],
  }));
  const view = tax.computeReturn(f.repo, Q1);
  assert.equal(view.sales_net, Money.parse(8000));
  assert.equal(view.output_tax, Money.parse(580), '7.25% of 8,000, not of 10,000');
});

test('filing freezes the figures and stamps everything behind them', () => {
  const f = freshTenant();
  sale(f, { amount: 10000, date: '2026-02-10' });
  purchase(f, { amount: 4000, date: '2026-02-20' });

  const filed = f.tx(() => tax.fileReturn(f.repo, { ...Q1, reference: 'HMRC-2026-Q1' }));
  assert.equal(filed.status, 'filed');
  assert.equal(filed.net_tax, Money.parse(435));
  assert.equal(filed.documents.length, 2);
  assert.equal(filed.reference, 'HMRC-2026-Q1');
  for (const d of filed.documents) assert.equal(f.repo.get('txn', d.txn_id).tax_return_id, filed.id);
});

test('nothing is ever returned twice', () => {
  const f = freshTenant();
  sale(f, { amount: 10000, date: '2026-02-10' });
  f.tx(() => tax.fileReturn(f.repo, Q1));

  // The same quarter again finds nothing left.
  assert.equal(tax.computeReturn(f.repo, Q1).txn_count, 0);
  assert.match(thrown(() => f.tx(() => tax.fileReturn(f.repo, Q2))).message, /Nothing to return/);
});

test('a bill entered after the quarter was filed falls into the next return', () => {
  const f = freshTenant();
  sale(f, { amount: 10000, date: '2026-02-10' });
  const q1 = f.tx(() => tax.fileReturn(f.repo, Q1));
  assert.equal(q1.input_tax, 0);

  // A February bill turns up in May, after the quarter has gone in.
  purchase(f, { amount: 4000, date: '2026-02-25' });
  sale(f, { amount: 2000, date: '2026-05-05' });

  const view = tax.computeReturn(f.repo, Q2);
  assert.equal(view.late_count, 1, 'the February bill is late, not lost');
  assert.equal(view.late_tax, -Money.parse(290), 'and it is tax to reclaim');
  assert.equal(view.input_tax, Money.parse(290));
  assert.equal(view.output_tax, Money.parse(145));
  assert.equal(view.net_tax, -Money.parse(145), 'a refund, because of the late claim');

  const q2 = f.tx(() => tax.fileReturn(f.repo, Q2));
  assert.equal(q2.late_count, 1);
  assert.equal(q2.txn_count, 2);
});

test('two returns cannot cover the same days', () => {
  const f = freshTenant();
  sale(f, { amount: 10000, date: '2026-02-10' });
  f.tx(() => tax.fileReturn(f.repo, Q1));
  sale(f, { amount: 5000, date: '2026-03-15' });
  const err = thrown(() => f.tx(() => tax.fileReturn(f.repo, { period_from: '2026-03-01', period_to: '2026-04-30' })));
  assert.match(err.message, /already covers part of/);
});

test('unfiling releases the transactions it had claimed', () => {
  const f = freshTenant();
  sale(f, { amount: 10000, date: '2026-02-10' });
  const q1 = f.tx(() => tax.fileReturn(f.repo, Q1));
  const undone = f.tx(() => tax.unfileReturn(f.repo, q1.id, { reason: 'Wrong period' }));

  assert.equal(undone.status, 'draft');
  assert.equal(undone.documents.length, 0);
  assert.equal(tax.computeReturn(f.repo, Q1).txn_count, 1, 'back on the table');
});

test('a return cannot be unfiled behind a later one', () => {
  const f = freshTenant();
  sale(f, { amount: 10000, date: '2026-02-10' });
  const q1 = f.tx(() => tax.fileReturn(f.repo, Q1));
  sale(f, { amount: 5000, date: '2026-05-10' });
  f.tx(() => tax.fileReturn(f.repo, Q2));
  assert.match(thrown(() => f.tx(() => tax.unfileReturn(f.repo, q1.id))).message, /covers a later period/);
});

test('an exempt sale adds net turnover but no tax', () => {
  const f = freshTenant();
  sale(f, { amount: 10000, date: '2026-02-10', tax_code: 'EXEMPT' });
  const view = tax.computeReturn(f.repo, Q1);
  assert.equal(view.sales_net, Money.parse(10000));
  assert.equal(view.output_tax, 0);
  assert.equal(view.lines[0].tax_code, 'EXEMPT');
});

test('the return breaks the control account into parts that add up', () => {
  const f = freshTenant();
  sale(f, { amount: 10000, date: '2026-02-10' });
  purchase(f, { amount: 4000, date: '2026-02-20' });

  const q1 = tax.computeReturn(f.repo, Q1);
  assert.equal(q1.control_balance, q1.net_tax, 'nothing filed yet, so the account is just this return');
  assert.equal(q1.filed_total, 0);
  assert.equal(q1.other_movement, 0);

  f.tx(() => tax.fileReturn(f.repo, Q1));
  sale(f, { amount: 2000, date: '2026-05-05' });
  const q2 = tax.computeReturn(f.repo, Q2);
  assert.equal(q2.filed_total, Money.parse(435), 'the filed quarter is still sitting on the account');
  assert.equal(q2.other_movement, 0, 'nothing has been paid over yet');
  assert.equal(q2.control_balance, q2.net_tax + q2.filed_total, 'the parts add up');
});

test('a journal posted straight to the tax account shows as unaccounted movement', () => {
  const f = freshTenant();
  sale(f, { amount: 10000, date: '2026-02-10' });
  // Somebody pays the authority — or fat-fingers a journal into 2100.
  f.tx(() => gl.postJournal(f.repo, {
    subsidiary_id: f.subsidiaryId, txn_date: '2026-03-20', memo: 'Paid over to the authority',
    lines: [
      { account_id: acct(f, '2100').id, debit: Money.parse(500) },
      { account_id: acct(f, '1010').id, credit: Money.parse(500) },
    ],
  }));
  const view = tax.computeReturn(f.repo, Q1);
  assert.equal(view.other_movement, -Money.parse(500), 'the account is lighter than the return by what went out');
  assert.equal(view.control_balance, view.net_tax + view.filed_total + view.other_movement);
});

test('a period that ends before it starts is refused', () => {
  const f = freshTenant();
  assert.match(thrown(() => tax.computeReturn(f.repo, { period_from: '2026-06-30', period_to: '2026-01-01' })).fields.period_to,
    /ends before it starts/);
});

test('the filed return renders to a PDF', () => {
  const f = freshTenant();
  sale(f, { amount: 10000, date: '2026-02-10' });
  purchase(f, { amount: 4000, date: '2026-02-20' });
  const filed = f.tx(() => tax.fileReturn(f.repo, Q1));
  const buf = tax.returnPdf(f.repo, filed.id);
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(buf.length > 900);
});

// ------------------------------------------------------------------ 1099
function paidSupplier(f, name, amounts, { is_1099 = true, year = 2026, ...rest } = {}) {
  const v = f.tx(() => entities.createVendor(f.repo, {
    name, subsidiary_id: f.subsidiaryId, is_1099,
    tax_number: '12-3456789', address: { line1: '1 Contractor Way', city: 'Austin', state: 'TX', postcode: '73301', country: 'US' },
    ...rest,
  }));
  amounts.forEach((amount, i) => {
    const date = `${year}-0${(i % 9) + 1}-15`;
    const b = purchase(f, { amount, date, tax_code: 'EXEMPT', vendor: v });
    f.tx(() => txnMod.createPayment(f.repo, 'VENDOR_PAYMENT', {
      entity_id: v.id, subsidiary_id: f.subsidiaryId, txn_date: date, amount,
      applications: [{ txn_id: b.id, amount }],
    }));
  });
  return v;
}

test('the 1099 totals what was actually paid, not what was billed', () => {
  const f = freshTenant();
  const v = paidSupplier(f, 'Hensley Consulting', [4000, 3500]);
  purchase(f, { amount: 9000, date: '2026-11-01', tax_code: 'EXEMPT', vendor: v });  // billed, unpaid

  const report = tax.report1099(f.repo, { year: 2026 });
  assert.equal(report.vendor_count, 1);
  assert.equal(report.rows[0].paid, Money.parse(7500), 'the unpaid bill is next year’s problem');
  assert.equal(report.rows[0].payments, 2);
  assert.equal(report.total, Money.parse(7500));
});

test('a supplier below the threshold needs no form', () => {
  const f = freshTenant();
  paidSupplier(f, 'Small Fry Ltd', [400]);
  paidSupplier(f, 'Big Fish Ltd', [5000]);

  const report = tax.report1099(f.repo, { year: 2026 });
  assert.deepEqual(report.rows.map((r) => r.name), ['Big Fish Ltd']);
  assert.equal(report.below_threshold, 1);

  const all = tax.report1099(f.repo, { year: 2026, include_below: true });
  assert.equal(all.rows.length, 2);
  assert.equal(all.rows.find((r) => r.name === 'Small Fry Ltd').reportable, false);
});

test('a supplier not flagged for 1099 is not on it at all', () => {
  const f = freshTenant();
  paidSupplier(f, 'Ordinary Supplies', [50000], { is_1099: false });
  assert.equal(tax.report1099(f.repo, { year: 2026 }).rows.length, 0);
});

test('payments in another year belong to that year', () => {
  const f = freshTenant();
  paidSupplier(f, 'Across The Line', [5000], { year: 2026 });
  assert.equal(tax.report1099(f.repo, { year: 2026 }).total, Money.parse(5000));
  assert.equal(tax.report1099(f.repo, { year: 2025 }).vendor_count, 0);
});

test('a supplier missing a tax number or an address is flagged before January', () => {
  const f = freshTenant();
  paidSupplier(f, 'No Papers Inc', [5000], { tax_number: '', address: {} });
  const report = tax.report1099(f.repo, { year: 2026 });
  assert.equal(report.incomplete, 1);
  assert.deepEqual(report.rows[0].missing, ['tax number', 'address']);
});

test('the 1099 export has a row per supplier in the columns filing software wants', () => {
  const f = freshTenant();
  paidSupplier(f, 'Hensley Consulting', [4000, 3500]);
  paidSupplier(f, 'Marsh Legal LLP', [12000], { tax_form: '1099-MISC', tax_form_box: '10' });

  const file = tax.csv1099(f.repo, { year: 2026 });
  const lines = file.text.trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /Recipient TIN/);
  assert.match(file.text, /1099-MISC,10/);
  assert.match(file.text, /12000\.00/);
  assert.match(file.text, /7500\.00/);
  assert.equal(file.filename, '1099-2026.csv');
});

test('the 1099 summary renders to a PDF', () => {
  const f = freshTenant();
  paidSupplier(f, 'Hensley Consulting', [4000, 3500]);
  const buf = tax.pdf1099(f.repo, { year: 2026 });
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(buf.length > 900);
});

test('a nonsense year is refused', () => {
  const f = freshTenant();
  assert.match(thrown(() => tax.report1099(f.repo, { year: 'last' })).fields.year, /four-digit year/);
});
