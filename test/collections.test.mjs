// Getting paid. The aging report says who is late; this is everything after
// that — the worklist, the letters that climb one rung at a time, the
// statement a customer actually reads, and the write-off that admits defeat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant } from './helpers.mjs';
import * as collections from '../src/modules/collections.mjs';
import * as entities from '../src/modules/entities.mjs';
import * as txnMod from '../src/modules/txn.mjs';
import * as gl from '../src/modules/gl.mjs';
import { Money, addDays, today } from '../src/core/util.mjs';

const acct = (f, n) => f.repo.queryOne('SELECT * FROM account WHERE tenant_id = :t AND number = ?', [n]);
const thrown = (fn) => { try { fn(); } catch (e) { return e; } return null; };
const balance = (f, n) => f.repo.scalar(
  `SELECT COALESCE(SUM(jl.base_debit - jl.base_credit), 0) v FROM journal_line jl
   JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
   JOIN account a ON a.tenant_id = jl.tenant_id AND a.id = jl.account_id
   WHERE jl.tenant_id = :t AND je.status = 'posted' AND a.number = ?`, [n], 0);

const NOW = '2026-06-15';

/** A customer with one invoice, dated so it is `daysLate` days past due. */
function lateInvoice(f, { name = 'Tardy Ltd', amount = 5000, daysLate = 45, terms = 'NET30' } = {}) {
  const customer = f.tx(() => entities.createCustomer(f.repo, {
    name, subsidiary_id: f.subsidiaryId, terms, email: 'ap@tardy.test',
    billing_address: { line1: '4 Slow Lane', city: 'Leeds', postcode: 'LS1 2AB', country: 'GB' },
  }));
  const dueDate = addDays(NOW, -daysLate);
  const invoice = f.tx(() => txnMod.createTxn(f.repo, 'INVOICE', {
    entity_id: customer.id, subsidiary_id: f.subsidiaryId,
    txn_date: addDays(dueDate, -30), due_date: dueDate,
    lines: [{ account_id: acct(f, '4020').id, description: 'Services', quantity: 1, unit_price: amount }],
  }));
  return { customer, invoice, dueDate };
}

test('the worklist puts the furthest gone at the top', () => {
  const f = freshTenant();
  lateInvoice(f, { name: 'A Ltd', daysLate: 10, amount: 1000 });
  lateInvoice(f, { name: 'B Ltd', daysLate: 95, amount: 400 });
  lateInvoice(f, { name: 'C Ltd', daysLate: 40, amount: 9000 });

  const w = collections.worklist(f.repo, { as_of: NOW });
  assert.deepEqual(w.rows.map((r) => r.name), ['B Ltd', 'C Ltd', 'A Ltd']);
  assert.equal(w.totals.customers, 3);
  assert.equal(w.totals.total, Money.parse(10400));
  assert.equal(w.rows[0].oldest_days, 95);
  assert.equal(w.rows[0].buckets[4], Money.parse(400), '95 days lands in 90+');
  assert.equal(w.rows[2].buckets[1], Money.parse(1000), '10 days lands in 1–30');
});

test('a customer who has promised to pay drops down the list, not off it', () => {
  const f = freshTenant();
  const late = lateInvoice(f, { name: 'Promised Ltd', daysLate: 95 });
  lateInvoice(f, { name: 'Silent Ltd', daysLate: 40 });
  f.tx(() => collections.updateCollectionState(f.repo, late.customer.id, {
    promise_date: addDays(NOW, 7), promise_amount: 5000, collection_note: 'Cheque in the post',
  }));
  const w = collections.worklist(f.repo, { as_of: NOW });
  assert.deepEqual(w.rows.map((r) => r.name), ['Silent Ltd', 'Promised Ltd']);
  assert.equal(w.totals.promised, Money.parse(5000));
});

test('a customer inside their terms is not on the worklist at all', () => {
  const f = freshTenant();
  const customer = f.tx(() => entities.createCustomer(f.repo, { name: 'Prompt Ltd', subsidiary_id: f.subsidiaryId }));
  f.tx(() => txnMod.createTxn(f.repo, 'INVOICE', {
    entity_id: customer.id, subsidiary_id: f.subsidiaryId, txn_date: NOW, due_date: addDays(NOW, 30),
    lines: [{ account_id: acct(f, '4020').id, quantity: 1, unit_price: 800 }],
  }));
  assert.equal(collections.worklist(f.repo, { as_of: NOW }).rows.length, 0);
  const all = collections.worklist(f.repo, { as_of: NOW, include_current: true });
  assert.equal(all.rows.length, 1);
  assert.equal(all.rows[0].overdue, 0);
  assert.equal(all.rows[0].total, Money.parse(800));
});

test('an open-item statement lists what is outstanding and ages it', () => {
  const f = freshTenant();
  const { customer } = lateInvoice(f, { daysLate: 45, amount: 5000 });
  const s = collections.statement(f.repo, customer.id, { as_of: NOW });
  assert.equal(s.kind, 'open_item');
  assert.equal(s.lines.length, 1);
  assert.equal(s.lines[0].outstanding, Money.parse(5000));
  assert.equal(s.lines[0].days_overdue, 45);
  assert.equal(s.lines[0].bucket, '31–60');
  assert.equal(s.total, Money.parse(5000));
  assert.equal(s.overdue, Money.parse(5000));
});

test('an activity statement carries a balance forward', () => {
  const f = freshTenant();
  const { customer, invoice } = lateInvoice(f, { daysLate: 45, amount: 5000 });
  f.tx(() => txnMod.createPayment(f.repo, 'CUSTOMER_PAYMENT', {
    entity_id: customer.id, subsidiary_id: f.subsidiaryId, txn_date: addDays(NOW, -5),
    amount: 2000, account_id: acct(f, '1010').id,
    applications: [{ txn_id: invoice.id, amount: 2000 }],
  }));
  const s = collections.statement(f.repo, customer.id, { as_of: NOW, from: addDays(NOW, -120), kind: 'activity' });
  assert.equal(s.lines.length, 2, 'the invoice and the payment');
  assert.equal(s.opening_balance, 0);
  assert.equal(s.closing_balance, Money.parse(3000));
  assert.equal(s.lines[1].amount, -Money.parse(2000), 'a receipt reduces the balance');
  assert.equal(s.lines[1].balance, Money.parse(3000));
});

test('a statement renders to a PDF that is actually a PDF', () => {
  const f = freshTenant();
  const { customer } = lateInvoice(f);
  const buf = collections.statementPdf(f.repo, customer.id, { as_of: NOW });
  assert.ok(buf.length > 800);
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(buf.includes(Buffer.from('%%EOF')));
});

test('the ladder is climbed one rung at a time, however late the debt', () => {
  const f = freshTenant();
  const { customer } = lateInvoice(f, { daysLate: 120, amount: 9000 });

  const first = f.tx(() => collections.runDunning(f.repo, { as_of: NOW }));
  assert.equal(first.issued, 1);
  assert.equal(first.notices[0].level_no, 1, 'a reminder, not a final notice');
  assert.equal(f.repo.get('customer', customer.id).dunning_level, 1);
  assert.equal(f.repo.get('customer', customer.id).credit_hold, 0);

  // Same day: the cooldown holds it back.
  const again = f.tx(() => collections.runDunning(f.repo, { as_of: NOW }));
  assert.equal(again.issued, 0);
  assert.match(again.skipped[0].reason, /cooldown/);

  const second = f.tx(() => collections.runDunning(f.repo, { as_of: addDays(NOW, 8) }));
  assert.equal(second.notices[0].level_no, 2);
  const third = f.tx(() => collections.runDunning(f.repo, { as_of: addDays(NOW, 16) }));
  assert.equal(third.notices[0].level_no, 3);
  assert.equal(f.repo.get('customer', customer.id).credit_hold, 1, 'the final notice puts the account on hold');

  const fourth = f.tx(() => collections.runDunning(f.repo, { as_of: addDays(NOW, 24) }));
  assert.equal(fourth.issued, 0);
  assert.match(fourth.skipped[0].reason, /last rung/);
});

test('a debt too small or too fresh is left alone', () => {
  const f = freshTenant();
  lateInvoice(f, { name: 'Pennies Ltd', daysLate: 45, amount: 10 });
  lateInvoice(f, { name: 'Fresh Ltd', daysLate: 3, amount: 5000 });
  const run = f.tx(() => collections.runDunning(f.repo, { as_of: NOW }));
  assert.equal(run.issued, 0);
  const reasons = run.skipped.map((s) => s.reason).join(' | ');
  assert.match(reasons, /minimum/);
  assert.match(reasons, /needs 7 days/);
});

test('a promise to pay stops the letters until the date passes', () => {
  const f = freshTenant();
  const { customer } = lateInvoice(f, { daysLate: 45, amount: 9000 });
  f.tx(() => collections.updateCollectionState(f.repo, customer.id, { promise_date: addDays(NOW, 5), promise_amount: 9000 }));
  assert.equal(f.tx(() => collections.runDunning(f.repo, { as_of: NOW })).issued, 0);
  assert.equal(f.tx(() => collections.runDunning(f.repo, { as_of: addDays(NOW, 6) })).issued, 1, 'the promise came and went');
});

test('an account marked do not chase never gets a letter', () => {
  const f = freshTenant();
  const { customer } = lateInvoice(f, { daysLate: 200, amount: 40000 });
  f.tx(() => collections.updateCollectionState(f.repo, customer.id, { no_dunning: true }));
  const run = f.tx(() => collections.runDunning(f.repo, { as_of: NOW }));
  assert.equal(run.issued, 0);
  assert.match(run.skipped[0].reason, /do not chase/);
});

test('the letter says the numbers, and keeps saying them afterwards', () => {
  const f = freshTenant();
  const { customer } = lateInvoice(f, { name: 'Verbose Ltd', daysLate: 45, amount: 5000 });
  const run = f.tx(() => collections.runDunning(f.repo, { as_of: NOW }));
  const notice = collections.getNotice(f.repo, run.notices[0].id);
  assert.match(notice.body, /\$5,000\.00/);
  assert.match(notice.body, /45 days past due/);
  assert.ok(!notice.body.includes('{{'), 'every placeholder was filled');
  assert.equal(notice.documents.length, 1);
  assert.equal(notice.documents[0].outstanding, Money.parse(5000));
  assert.equal(notice.total_overdue, Money.parse(5000));

  // Paying afterwards does not rewrite what was sent.
  f.tx(() => txnMod.createPayment(f.repo, 'CUSTOMER_PAYMENT', {
    entity_id: customer.id, subsidiary_id: f.subsidiaryId, txn_date: NOW,
    amount: 5000, account_id: acct(f, '1010').id,
  }));
  assert.equal(collections.getNotice(f.repo, notice.id).total_overdue, Money.parse(5000));
});

test('a notice renders to a letter', () => {
  const f = freshTenant();
  lateInvoice(f, { daysLate: 45, amount: 5000 });
  const run = f.tx(() => collections.runDunning(f.repo, { as_of: NOW }));
  const buf = collections.noticePdf(f.repo, run.notices[0].id);
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(buf.length > 800);
});

test('withdrawing a notice puts the customer back a rung', () => {
  const f = freshTenant();
  const { customer } = lateInvoice(f, { daysLate: 120, amount: 9000 });
  f.tx(() => collections.runDunning(f.repo, { as_of: NOW }));
  const second = f.tx(() => collections.runDunning(f.repo, { as_of: addDays(NOW, 8) }));
  assert.equal(f.repo.get('customer', customer.id).dunning_level, 2);

  f.tx(() => collections.cancelNotice(f.repo, second.notices[0].id, { reason: 'Sent in error' }));
  assert.equal(f.repo.get('customer', customer.id).dunning_level, 1, 'back to the reminder');
  const next = f.tx(() => collections.runDunning(f.repo, { as_of: addDays(NOW, 20) }));
  assert.equal(next.notices[0].level_no, 2, 'and level two is offered again');
});

test('a policy has to climb', () => {
  const f = freshTenant();
  const err = thrown(() => f.tx(() => collections.createPolicy(f.repo, {
    name: 'Flat', levels: [
      { level_no: 1, name: 'One', days_overdue: 30 },
      { level_no: 2, name: 'Two', days_overdue: 30 },
    ],
  })));
  assert.match(err.fields['levels.1.days_overdue'], /later than the one before/);
});

test('a custom policy is followed instead of the default', () => {
  const f = freshTenant();
  const { customer } = lateInvoice(f, { daysLate: 45, amount: 9000 });
  const policy = f.tx(() => collections.createPolicy(f.repo, {
    name: 'Gentle', min_balance: 0, cooldown_days: 1,
    levels: [{ level_no: 1, name: 'A quiet word', days_overdue: 40, subject: 'About {{account}}', body: 'You owe {{overdue}}.' }],
  }));
  f.tx(() => collections.updateCollectionState(f.repo, customer.id, { dunning_policy_id: policy.id }));
  const run = f.tx(() => collections.runDunning(f.repo, { as_of: NOW }));
  assert.equal(run.notices[0].level_name, 'A quiet word');
  assert.match(collections.getNotice(f.repo, run.notices[0].id).body, /You owe \$9,000\.00\./);
});

test('writing off an invoice closes it and books the loss', () => {
  const f = freshTenant();
  const { invoice } = lateInvoice(f, { daysLate: 200, amount: 5000 });
  const arBefore = balance(f, '1100');

  const res = f.tx(() => collections.writeOff(f.repo, invoice.id, { as_of: NOW, reason: 'Company dissolved' }));
  assert.equal(res.invoice.amount_remaining, 0);
  assert.equal(res.invoice.status, 'paid');
  assert.equal(balance(f, '1100'), arBefore - Money.parse(5000), 'the receivable is gone');
  assert.equal(balance(f, '6900'), Money.parse(5000), 'and it is an expense');
  assert.equal(balance(f, '1010'), 0, 'no cash moved');
  assert.equal(gl.integrityCheck(f.repo).ok, true);
  assert.equal(gl.tieOuts(f.repo).find((t) => t.name === 'Receivables').difference, 0);
});

test('a partial write-off leaves the rest outstanding', () => {
  const f = freshTenant();
  const { invoice } = lateInvoice(f, { daysLate: 200, amount: 5000 });
  f.tx(() => collections.writeOff(f.repo, invoice.id, { as_of: NOW, amount: 1500, reason: 'Settled short' }));
  assert.equal(f.repo.get('txn', invoice.id).amount_remaining, Money.parse(3500));
  assert.equal(balance(f, '6900'), Money.parse(1500));
});

test('a write-off can go against the allowance instead of the expense', () => {
  const f = freshTenant();
  const { invoice } = lateInvoice(f, { daysLate: 200, amount: 5000 });
  f.tx(() => collections.writeOff(f.repo, invoice.id, { as_of: NOW, use_allowance: true }));
  assert.equal(balance(f, '1150'), Money.parse(5000), 'the allowance absorbs it');
  assert.equal(balance(f, '6900'), 0, 'the expense was taken when it was provided for');
});

test('a write-off is refused where there is nothing to write off', () => {
  const f = freshTenant();
  const { invoice } = lateInvoice(f, { daysLate: 200, amount: 5000 });
  f.tx(() => collections.writeOff(f.repo, invoice.id, { as_of: NOW }));
  assert.match(thrown(() => f.tx(() => collections.writeOff(f.repo, invoice.id, { as_of: NOW }))).message, /nothing left outstanding/);

  const { invoice: other } = lateInvoice(f, { name: 'Other Ltd', daysLate: 200, amount: 100 });
  assert.match(
    thrown(() => f.tx(() => collections.writeOff(f.repo, other.id, { as_of: NOW, amount: 500 }))).fields.amount,
    /only \$100\.00 outstanding/);
});

test('the allowance is topped up to what the aging implies', () => {
  const f = freshTenant();
  lateInvoice(f, { name: 'Recent Ltd', daysLate: 10, amount: 10000 });   // 1–30 at 1%
  lateInvoice(f, { name: 'Ancient Ltd', daysLate: 200, amount: 4000 });  // 90+  at 50%

  const preview = collections.allowance(f.repo, { as_of: NOW, dry_run: true });
  assert.equal(preview.target, Money.parse(2100), '1% of 10,000 plus 50% of 4,000');
  assert.equal(preview.held, 0);
  assert.equal(preview.movement, Money.parse(2100));
  assert.equal(preview.posted, false);

  const run = f.tx(() => collections.allowance(f.repo, { as_of: NOW }));
  assert.equal(run.posted, true);
  assert.equal(balance(f, '1150'), -Money.parse(2100), 'a contra-asset sits as a credit');
  assert.equal(balance(f, '6900'), Money.parse(2100));
  assert.equal(gl.integrityCheck(f.repo).ok, true);
});

test('running the allowance again moves only the difference', () => {
  const f = freshTenant();
  const { customer } = lateInvoice(f, { name: 'Ancient Ltd', daysLate: 200, amount: 4000 });
  f.tx(() => collections.allowance(f.repo, { as_of: NOW }));
  assert.equal(balance(f, '1150'), -Money.parse(2000));

  // Half of it turns up. The provision should fall to match.
  const inv = f.repo.queryOne('SELECT id FROM txn WHERE tenant_id = :t AND type = \'INVOICE\' AND entity_id = ?', [customer.id]);
  f.tx(() => txnMod.createPayment(f.repo, 'CUSTOMER_PAYMENT', {
    entity_id: customer.id, subsidiary_id: f.subsidiaryId, txn_date: NOW,
    amount: 2000, account_id: acct(f, '1010').id, applications: [{ txn_id: inv.id, amount: 2000 }],
  }));
  const second = f.tx(() => collections.allowance(f.repo, { as_of: NOW }));
  assert.equal(second.held, Money.parse(2000));
  assert.equal(second.target, Money.parse(1000));
  assert.equal(second.movement, -Money.parse(1000), 'the provision is released, not doubled');
  assert.equal(balance(f, '1150'), -Money.parse(1000));
});

test('the provision matrix is the caller’s to set, within reason', () => {
  const f = freshTenant();
  lateInvoice(f, { daysLate: 200, amount: 4000 });
  const strict = collections.allowance(f.repo, { as_of: NOW, matrix: [0, 0, 0, 0, 100], dry_run: true });
  assert.equal(strict.target, Money.parse(4000));
  assert.match(thrown(() => collections.allowance(f.repo, { as_of: NOW, matrix: [0, 0, 0, 0, 250] })).fields.matrix,
    /between 0 and 100/);
});

test('a template leaves an unknown placeholder visible rather than blanking it', () => {
  assert.equal(collections.render('Owed {{overdue}} by {{nobody}}', { overdue: '$10.00' }), 'Owed $10.00 by {{nobody}}');
});

test('a statement in two currencies states its totals in one of them', () => {
  const f = freshTenant();
  f.tx(() => f.repo.exec(
    `INSERT INTO exchange_rate (tenant_id, from_currency, to_currency, rate_date, rate) VALUES (:t,?,?,?,?)`,
    ['GBP', 'USD', '2026-01-01', 1.25]));
  const customer = f.tx(() => entities.createCustomer(f.repo, { name: 'Both Ltd', subsidiary_id: f.subsidiaryId }));
  const raise = (currency, amount) => f.tx(() => txnMod.createTxn(f.repo, 'INVOICE', {
    entity_id: customer.id, subsidiary_id: f.subsidiaryId, currency,
    txn_date: addDays(NOW, -60), due_date: addDays(NOW, -30),
    lines: [{ account_id: acct(f, '4020').id, quantity: 1, unit_price: amount }],
  }));
  raise('USD', 1000);
  raise('GBP', 2000);

  const s = collections.statement(f.repo, customer.id, { as_of: NOW });
  assert.equal(s.mixed, true);
  assert.equal(s.currency, 'USD', 'the base currency, since the documents disagree');
  const sterling = s.lines.find((l) => l.currency === 'GBP');
  assert.equal(sterling.document_outstanding, Money.parse(2000), '£2,000 on the document');
  assert.equal(sterling.outstanding, Money.parse(2500), 'and $2,500 in the total');
  assert.equal(s.total, Money.parse(3500));

  const buf = collections.statementPdf(f.repo, customer.id, { as_of: NOW });
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
});

test('a single-currency statement speaks that currency', () => {
  const f = freshTenant();
  const { customer } = lateInvoice(f, { amount: 5000 });
  const s = collections.statement(f.repo, customer.id, { as_of: NOW });
  assert.equal(s.mixed, false);
  assert.equal(s.currency, 'USD');
  assert.equal(s.lines[0].outstanding, s.lines[0].document_outstanding);
});

test('a letter to a sterling customer is written in sterling', () => {
  const f = freshTenant();
  f.tx(() => f.repo.exec(
    `INSERT INTO exchange_rate (tenant_id, from_currency, to_currency, rate_date, rate) VALUES (:t,?,?,?,?)`,
    ['GBP', 'USD', '2026-01-01', 1.25]));
  const customer = f.tx(() => entities.createCustomer(f.repo, {
    name: 'Brit Ltd', subsidiary_id: f.subsidiaryId, currency: 'GBP',
  }));
  f.tx(() => txnMod.createTxn(f.repo, 'INVOICE', {
    entity_id: customer.id, subsidiary_id: f.subsidiaryId, currency: 'GBP',
    txn_date: addDays(NOW, -60), due_date: addDays(NOW, -45),
    lines: [{ account_id: acct(f, '4020').id, quantity: 1, unit_price: 2000 }],
  }));
  const run = f.tx(() => collections.runDunning(f.repo, { as_of: NOW }));
  const notice = collections.getNotice(f.repo, run.notices[0].id);
  assert.equal(notice.currency, 'GBP');
  assert.equal(notice.total_overdue, Money.parse(2000), 'the debt is £2,000, not its dollar value');
  assert.match(notice.body, /£2,000\.00/);

  // The worklist still ranks in the reporting currency, so the two differ.
  const w = collections.worklist(f.repo, { as_of: NOW });
  assert.equal(w.currency, 'USD');
  assert.equal(w.rows[0].overdue, Money.parse(2500));
});

test('over_limit compares the credit limit in the same currency as the balance it is judged against', () => {
  // `total` on the worklist is already converted to the reporting currency;
  // credit_limit is stored in the customer's own currency. Comparing them
  // directly either wrongly flags a customer who is well within a foreign
  // credit limit, or misses one who has genuinely gone over it.
  const f = freshTenant();
  f.tx(() => f.repo.exec(
    `INSERT INTO exchange_rate (tenant_id, from_currency, to_currency, rate_date, rate) VALUES (:t,?,?,?,?)`,
    ['GBP', 'USD', '2026-01-01', 1.25]));
  const customer = f.tx(() => entities.createCustomer(f.repo, {
    name: 'Brit Ltd', subsidiary_id: f.subsidiaryId, currency: 'GBP', credit_limit: 2200,
  }));
  f.tx(() => txnMod.createTxn(f.repo, 'INVOICE', {
    entity_id: customer.id, subsidiary_id: f.subsidiaryId, currency: 'GBP',
    txn_date: addDays(NOW, -60), due_date: addDays(NOW, -45),
    lines: [{ account_id: acct(f, '4020').id, quantity: 1, unit_price: 2000 }],
  }));

  // £2,000 owed against a £2,200 limit: genuinely under, in the customer's
  // own currency. In the reporting currency that is $2,500 against a raw
  // 2200 -- which reads as over the limit unless 2200 is converted too.
  const w = collections.worklist(f.repo, { as_of: NOW });
  assert.equal(w.rows[0].over_limit, false, '£2,000 against a £2,200 limit is under, not over');
});

test('a customer whose own currency has no exchange rate does not take the whole worklist down', () => {
  // A customer's currency is set for quoting purposes and need not match
  // anything they have actually been invoiced in -- so, unlike an open
  // document's own currency (which had to clear this same lookup to post at
  // all), there is no guarantee a rate to the reporting currency exists. One
  // customer's missing FX setup must not crash the worklist for every
  // customer on it.
  const f = freshTenant();
  // No JPY -> USD rate is ever inserted.
  const customer = f.tx(() => entities.createCustomer(f.repo, {
    name: 'Yen Co', subsidiary_id: f.subsidiaryId, currency: 'JPY', credit_limit: 500000,
  }));
  f.tx(() => txnMod.createTxn(f.repo, 'INVOICE', {
    // Invoiced in USD (the reporting currency), so the invoice itself never
    // needs a JPY rate to post -- only the credit_limit comparison does.
    entity_id: customer.id, subsidiary_id: f.subsidiaryId, currency: 'USD',
    txn_date: addDays(NOW, -60), due_date: addDays(NOW, -45),
    lines: [{ account_id: acct(f, '4020').id, quantity: 1, unit_price: 2000 }],
  }));

  const w = collections.worklist(f.repo, { as_of: NOW });
  assert.equal(w.rows.length, 1);
  assert.equal(w.rows[0].over_limit, false, 'an unknown rate must not be reported as over the limit');
  assert.equal(w.rows[0].over_limit_unknown, true, 'the row should say the limit could not be checked');
});

test('a letter lists what it is chasing, and the items add up to the figure in it', () => {
  const f = freshTenant();
  const { customer } = lateInvoice(f, { name: 'Mixed Ltd', daysLate: 45, amount: 5000 });
  // A second invoice, not yet due. It belongs on a statement, not in a chase.
  f.tx(() => txnMod.createTxn(f.repo, 'INVOICE', {
    entity_id: customer.id, subsidiary_id: f.subsidiaryId, txn_date: NOW, due_date: addDays(NOW, 20),
    lines: [{ account_id: acct(f, '4020').id, quantity: 1, unit_price: 800 }],
  }));
  const run = f.tx(() => collections.runDunning(f.repo, { as_of: NOW }));
  const notice = collections.getNotice(f.repo, run.notices[0].id);

  assert.equal(notice.documents.length, 1, 'only the overdue one');
  assert.equal(notice.total_overdue, Money.parse(5000));
  assert.equal(notice.total_due, Money.parse(5800), 'the balance is still stated in full');
  assert.equal(notice.documents.reduce((a, d) => a + d.outstanding, 0), notice.total_overdue);
  assert.match(notice.body, /\$5,000\.00/);
});
