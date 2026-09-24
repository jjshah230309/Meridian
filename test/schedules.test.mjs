// Revenue recognition and expense amortisation. Cash and the profit and loss
// disagree on purpose here: a year of support billed up front is one invoice
// and twelve months of revenue, and a year of insurance paid in January is
// one bill and twelve months of expense.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant } from './helpers.mjs';
import * as schedules from '../src/modules/schedules.mjs';
import * as entities from '../src/modules/entities.mjs';
import * as inventory from '../src/modules/inventory.mjs';
import * as txnMod from '../src/modules/txn.mjs';
import * as gl from '../src/modules/gl.mjs';
import { Money, sum } from '../src/core/util.mjs';

const acct = (f, n) => f.repo.queryOne('SELECT id FROM account WHERE tenant_id = :t AND number = ?', [n])?.id;
const balance = (f, n) => f.repo.scalar(
  `SELECT COALESCE(SUM(jl.base_debit - jl.base_credit), 0) v FROM journal_line jl
   JOIN journal_entry je ON je.id = jl.entry_id JOIN account a ON a.id = jl.account_id
   WHERE jl.tenant_id = :t AND je.status = 'posted' AND a.number = ?`, [n], 0);

function supportSale(f, { method = 'straight_monthly', start_rule = 'transaction_date', price = 1200, line = {} } = {}) {
  const template = f.tx(() => schedules.createTemplate(f.repo, {
    name: 'Support plan', kind: 'revenue', method, term_months: 12, start_rule,
  }));
  const customer = f.tx(() => entities.createCustomer(f.repo, { name: 'Acme', subsidiary_id: f.subsidiaryId }));
  const item = f.tx(() => inventory.createItem(f.repo, {
    sku: 'SUP', name: 'Support plan', type: 'service', base_price: price,
    income_account_id: acct(f, '4020'), revenue_template_id: template.id,
  }));
  const invoice = f.tx(() => txnMod.createTxn(f.repo, 'INVOICE', {
    entity_id: customer.id, subsidiary_id: f.subsidiaryId, txn_date: '2026-01-01',
    lines: [{ item_id: item.id, quantity: 1, unit_price: price, ...line }],
  }));
  return { template, customer, item, invoice };
}

test('an invoice under a schedule defers the revenue instead of earning it', () => {
  const f = freshTenant();
  const { invoice } = supportSale(f);
  assert.equal(balance(f, '1100'), Money.parse(1200), 'the customer still owes it');
  assert.equal(balance(f, '2300'), Money.parse(-1200), 'and it sits in deferred revenue');
  assert.equal(balance(f, '4020'), 0, 'nothing has been earned yet');
  assert.equal(gl.integrityCheck(f.repo).ok, true);

  const s = schedules.getSchedule(f.repo, schedules.schedulesForTxn(f.repo, invoice.id)[0].id);
  assert.equal(s.lines.length, 12);
  assert.equal(sum(s.lines, (l) => l.amount), Money.parse(1200), 'the slices add up to the invoice');
  assert.equal(s.lines[0].plan_date, '2026-01-31');
  assert.equal(s.lines[11].plan_date, '2026-12-31');
});

test('a run releases only what is due, and the ledger follows', () => {
  const f = freshTenant();
  supportSale(f);
  const run = f.tx(() => schedules.runRecognition(f.repo, { kind: 'revenue', through: '2026-03-31' }));
  assert.equal(run.posted, 3, 'one journal per month');
  assert.equal(run.amount, 300);
  assert.equal(balance(f, '2300'), Money.parse(-900));
  assert.equal(balance(f, '4020'), Money.parse(-300));
  assert.equal(gl.integrityCheck(f.repo).ok, true);

  // Running again over the same window must not release anything twice.
  const again = f.tx(() => schedules.runRecognition(f.repo, { kind: 'revenue', through: '2026-03-31' }));
  assert.equal(again.posted, 0);
  assert.equal(balance(f, '4020'), Money.parse(-300));
});

test('a schedule completes exactly, to the penny', () => {
  const f = freshTenant();
  // 1000 over 12 does not divide evenly; the slices still have to total 1000.
  const { invoice } = supportSale(f, { price: 1000 });
  const s = schedules.getSchedule(f.repo, schedules.schedulesForTxn(f.repo, invoice.id)[0].id);
  assert.equal(sum(s.lines, (l) => l.amount), Money.parse(1000));
  f.tx(() => schedules.runRecognition(f.repo, { kind: 'revenue', through: '2026-12-31' }));
  assert.equal(balance(f, '2300'), 0);
  assert.equal(balance(f, '4020'), Money.parse(-1000));
  assert.equal(f.repo.get('schedule', s.id).status, 'complete');
});

test('a daily schedule pro-rates the part months exactly', () => {
  const f = freshTenant();
  const { invoice } = supportSale(f, {
    method: 'straight_daily', start_rule: 'service_start', price: 3650,
    line: { service_start: '2026-02-15', service_end: '2027-02-14' },
  });
  const s = schedules.getSchedule(f.repo, schedules.schedulesForTxn(f.repo, invoice.id)[0].id);
  assert.equal(s.start_date, '2026-02-15');
  assert.equal(s.end_date, '2027-02-14');
  assert.equal(s.lines[0].plan_date, '2026-02-28');
  assert.equal(s.lines[0].amount, Money.parse(140), '14 days of February at 10 a day');
  assert.equal(s.lines[1].amount, Money.parse(310), 'all of March');
  assert.equal(sum(s.lines, (l) => l.amount), Money.parse(3650));
});

test('a bill under an amortisation schedule is a prepayment until the months arrive', () => {
  const f = freshTenant();
  const template = f.tx(() => schedules.createTemplate(f.repo, {
    name: 'Annual insurance', kind: 'expense', method: 'straight_monthly', term_months: 12, start_rule: 'transaction_date',
  }));
  const vendor = f.tx(() => entities.createVendor(f.repo, { name: 'Broker', subsidiary_id: f.subsidiaryId }));
  const item = f.tx(() => inventory.createItem(f.repo, {
    sku: 'INS', name: 'Liability cover', type: 'service', purchase_price: 2400,
    expense_account_id: acct(f, '6700'), expense_template_id: template.id,
  }));
  f.tx(() => txnMod.createTxn(f.repo, 'VENDOR_BILL', {
    entity_id: vendor.id, subsidiary_id: f.subsidiaryId, txn_date: '2026-01-01',
    lines: [{ item_id: item.id, quantity: 1, unit_price: 2400 }],
  }));
  assert.equal(balance(f, '1250'), Money.parse(2400), 'held as prepaid');
  assert.equal(balance(f, '6700'), 0, 'not an expense yet');

  const run = f.tx(() => schedules.runRecognition(f.repo, { kind: 'expense', through: '2026-06-30' }));
  assert.equal(run.posted, 6);
  assert.equal(balance(f, '1250'), Money.parse(1200));
  assert.equal(balance(f, '6700'), Money.parse(1200));
  assert.equal(gl.integrityCheck(f.repo).ok, true);
});

test('a run leaves a closed period alone and says so', () => {
  const f = freshTenant();
  supportSale(f);
  const jan = f.repo.queryOne("SELECT * FROM accounting_period WHERE tenant_id = :t AND start_date = '2026-01-01'");
  f.tx(() => gl.closePeriod(f.repo, jan.id, { force: true }));
  const run = f.tx(() => schedules.runRecognition(f.repo, { kind: 'revenue', through: '2026-03-31' }));
  assert.equal(run.posted, 2, 'February and March still go');
  assert.equal(run.deferred.length, 1);
  assert.match(run.deferred[0].reason, /closed/);
  assert.equal(balance(f, '4020'), Money.parse(-200));
  // The January slice is untouched and waiting, not lost.
  assert.equal(schedules.due(f.repo, { kind: 'revenue', through: '2026-03-31' }).length, 1);
});

test('a document with revenue already recognised cannot be voided away', () => {
  const f = freshTenant();
  const { invoice } = supportSale(f);
  f.tx(() => schedules.runRecognition(f.repo, { kind: 'revenue', through: '2026-02-28' }));
  assert.throws(() => f.tx(() => txnMod.voidTxn(f.repo, invoice.id, { reason: 'mistake' })),
    /already recognised/);
  assert.equal(txnMod.getTxn(f.repo, invoice.id).status !== 'voided', true);
});

test('voiding before anything is recognised cancels the schedule with it', () => {
  const f = freshTenant();
  const { invoice } = supportSale(f);
  f.tx(() => txnMod.voidTxn(f.repo, invoice.id, { reason: 'wrong customer' }));
  const s = schedules.schedulesForTxn(f.repo, invoice.id)[0];
  assert.equal(s.status, 'cancelled');
  assert.equal(schedules.due(f.repo, { kind: 'revenue', through: '2027-12-31' }).length, 0);
  assert.equal(balance(f, '2300'), 0, 'the deferral reversed with the invoice');
  assert.equal(gl.integrityCheck(f.repo).ok, true);
});

test('a line can override the item and name its own service window', () => {
  const f = freshTenant();
  const other = f.tx(() => schedules.createTemplate(f.repo, {
    name: 'Six months', kind: 'revenue', method: 'straight_monthly', term_months: 6, start_rule: 'service_start',
  }));
  const { invoice } = supportSale(f, {
    line: { schedule_template_id: other.id, service_start: '2026-03-01', service_end: '2026-08-31' },
  });
  const s = schedules.getSchedule(f.repo, schedules.schedulesForTxn(f.repo, invoice.id)[0].id);
  assert.equal(s.template_id, other.id);
  assert.equal(s.lines.length, 6);
  assert.equal(s.start_date, '2026-03-01');
  assert.equal(s.end_date, '2026-08-31');
});

test('a held schedule waits for somebody to say the work is done', () => {
  const f = freshTenant();
  const { invoice } = supportSale(f, { method: 'on_completion' });
  const s = schedules.getSchedule(f.repo, schedules.schedulesForTxn(f.repo, invoice.id)[0].id);
  assert.equal(s.lines.length, 1);
  assert.equal(s.lines[0].status, 'held');
  assert.equal(f.tx(() => schedules.runRecognition(f.repo, { kind: 'revenue', through: '2027-12-31' })).posted, 0);

  f.tx(() => schedules.releaseHeld(f.repo, s.id, { plan_date: '2026-06-30' }));
  assert.equal(balance(f, '4020'), Money.parse(-1200));
  assert.equal(f.repo.get('schedule', s.id).status, 'complete');
  assert.equal(gl.integrityCheck(f.repo).ok, true);
});

test('two schedules booked at different fx rates each post at their own rate, not the first one in the group', () => {
  // runRecognition groups slices due on the same date into one journal entry
  // regardless of which schedule they came from. It used to post the whole
  // group at a single fx_rate (whichever schedule sorted first), converting
  // every line as if it had been booked at that one rate.
  const f = freshTenant({ currency: 'USD' });
  f.tx(() => {
    f.repo.exec(`INSERT OR REPLACE INTO exchange_rate (tenant_id, from_currency, to_currency, rate_date, rate)
                 VALUES (:t,'EUR','USD',?,?)`, ['2026-01-01', 1.0]);
    f.repo.exec(`INSERT OR REPLACE INTO exchange_rate (tenant_id, from_currency, to_currency, rate_date, rate)
                 VALUES (:t,'EUR','USD',?,?)`, ['2026-01-15', 2.0]);
  });
  const template = f.tx(() => schedules.createTemplate(f.repo, {
    name: 'Support plan', kind: 'revenue', method: 'straight_monthly', term_months: 1, start_rule: 'transaction_date',
  }));
  const customer = f.tx(() => entities.createCustomer(f.repo, { name: 'Europa GmbH', currency: 'EUR', subsidiary_id: f.subsidiaryId }));
  const item = f.tx(() => inventory.createItem(f.repo, {
    sku: 'SUP', name: 'Support plan', type: 'service', base_price: 100,
    income_account_id: acct(f, '4020'), revenue_template_id: template.id,
  }));
  // Invoice A books at rate 1.00 (100 EUR = $100); invoice B two weeks later
  // books at rate 2.00 (100 EUR = $200) -- same schedule, different rate.
  f.tx(() => txnMod.createTxn(f.repo, 'INVOICE', {
    entity_id: customer.id, subsidiary_id: f.subsidiaryId, txn_date: '2026-01-01', currency: 'EUR',
    lines: [{ item_id: item.id, quantity: 1, unit_price: 100 }],
  }));
  f.tx(() => txnMod.createTxn(f.repo, 'INVOICE', {
    entity_id: customer.id, subsidiary_id: f.subsidiaryId, txn_date: '2026-01-15', currency: 'EUR',
    lines: [{ item_id: item.id, quantity: 1, unit_price: 100 }],
  }));
  // Both invoices deferred correctly at their own rate when booked -- $100 +
  // $200 -- which the grouped release below must also honour.
  assert.equal(balance(f, '2300'), Money.parse(-300), 'both invoices must have deferred at their own rate when booked');

  // Each schedule's own slicing lands on a different date; force them due on
  // the same date so runRecognition groups them into one journal entry.
  f.tx(() => f.repo.exec("UPDATE schedule_line SET plan_date = '2026-01-31' WHERE tenant_id = :t AND status = 'planned'"));

  const run = f.tx(() => schedules.runRecognition(f.repo, { kind: 'revenue', through: '2026-01-31' }));
  assert.equal(run.posted, 1, 'both schedules must land in one journal entry');
  assert.equal(-balance(f, '4020'), Money.parse(300), '$100 + $200 recognised, not $100 + $100');
  assert.equal(balance(f, '2300'), 0, 'both schedules release in full, in one month, so nothing stays deferred');
  assert.equal(gl.integrityCheck(f.repo).ok, true);
});

test('the waterfall reports base currency and reconciles to the deferred balance', () => {
  const f = freshTenant();
  supportSale(f);
  f.tx(() => schedules.runRecognition(f.repo, { kind: 'revenue', through: '2026-03-31' }));
  const w = schedules.waterfall(f.repo, { kind: 'revenue', from: '2026-04-01', months: 12 });
  const bucketSum = w.buckets.reduce((a, b) => a + b.amount, 0);
  assert.equal(Math.round((bucketSum + w.overdue + w.held + w.beyond_horizon) * 100), Money.parse(900));
  assert.equal(w.total_deferred, 900);
  assert.equal(-balance(f, '2300'), Money.parse(w.total_deferred), 'the report agrees with the ledger');
});
