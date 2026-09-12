// Subscription billing. The arithmetic is the easy part; what these tests are
// really about is that a period is billed once, that a change part way through
// bills for the part it applies to, and that the invoices it produces feed
// revenue recognition rather than bypassing it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant } from './helpers.mjs';
import * as subs from '../src/modules/subscriptions.mjs';
import * as entities from '../src/modules/entities.mjs';
import * as inv from '../src/modules/inventory.mjs';
import * as schedules from '../src/modules/schedules.mjs';
import * as gl from '../src/modules/gl.mjs';
import { Money, Qty } from '../src/core/util.mjs';

const acct = (f, n) => f.repo.queryOne('SELECT * FROM account WHERE tenant_id = :t AND number = ?', [n]);
const thrown = (fn) => { try { fn(); } catch (e) { return e; } return null; };
const balance = (f, n) => f.repo.scalar(
  `SELECT COALESCE(SUM(jl.base_debit - jl.base_credit), 0) v FROM journal_line jl
   JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
   JOIN account a ON a.tenant_id = jl.tenant_id AND a.id = jl.account_id
   WHERE jl.tenant_id = :t AND je.status = 'posted' AND a.number = ?`, [n], 0);

let skuCounter = 0;
function seat(f, { price = 30, sku = null } = {}) {
  skuCounter += 1;
  return f.tx(() => inv.createItem(f.repo, {
    sku: sku || `SEAT-${skuCounter}`, name: 'Platform seat', type: 'service', base_price: price,
    income_account_id: acct(f, '4030').id,
  }));
}

function subscribe(f, opts = {}) {
  const customer = opts.customer || f.tx(() => entities.createCustomer(f.repo, {
    name: opts.name || 'Subscriber Ltd', subsidiary_id: f.subsidiaryId,
  }));
  const item = opts.item || seat(f);
  const created = f.tx(() => subs.createSubscription(f.repo, {
    customer_id: customer.id, subsidiary_id: f.subsidiaryId,
    name: 'Platform', start_date: opts.start_date || '2026-01-01',
    billing_frequency: opts.billing_frequency || 'monthly',
    billing_day: opts.billing_day ?? 0,
    term_months: opts.term_months ?? 12,
    bill_in_advance: opts.bill_in_advance,
    auto_renew: opts.auto_renew,
    lines: opts.lines || [{ item_id: item.id, quantity: 10, unit_price: 30 }],
    activate: opts.activate !== false,
  }));
  return { customer, item, subscription: created };
}

// ------------------------------------------------------------ the calendar
test('periods run from anniversary to anniversary by default', () => {
  const s = { billing_frequency: 'monthly', billing_day: 0 };
  assert.equal(subs.periodEnd(s, '2026-01-15'), '2026-02-15');
  assert.equal(subs.periodEnd({ ...s, billing_frequency: 'quarterly' }, '2026-01-15'), '2026-04-15');
  assert.equal(subs.periodEnd({ ...s, billing_frequency: 'annually' }, '2026-01-15'), '2027-01-15');
});

test('a billing day makes the first period short and the rest aligned', () => {
  const s = { billing_frequency: 'monthly', billing_day: 1 };
  assert.equal(subs.periodEnd(s, '2026-01-15'), '2026-02-01', 'a stub to bring it onto the cycle');
  assert.equal(subs.periodEnd(s, '2026-02-01'), '2026-03-01', 'then whole months');
  assert.equal(subs.periodEnd(s, '2026-03-01'), '2026-04-01');
});

// -------------------------------------------------------------- the basics
test('a monthly subscription bills one period in advance', () => {
  const f = freshTenant();
  const { subscription } = subscribe(f);
  assert.equal(subscription.status, 'active');
  assert.equal(subscription.next_bill_date, '2026-01-01');
  assert.equal(subscription.mrr, Money.parse(300), 'ten seats at thirty');

  const run = f.tx(() => subs.runBilling(f.repo, { through: '2026-01-01' }));
  assert.equal(run.count, 1);
  assert.equal(run.amount, Money.parse(300));

  const invoice = f.repo.get('txn', run.invoiced[0].invoice_id);
  assert.equal(invoice.total, Money.parse(300));
  assert.equal(invoice.subscription_id, subscription.id);
  assert.equal(balance(f, '1100'), Money.parse(300), 'the customer owes January');
  assert.equal(gl.integrityCheck(f.repo).ok, true);

  const after = subs.getSubscription(f.repo, subscription.id);
  assert.equal(after.billed_through, '2026-02-01', 'January is paid for; February is next');
  assert.equal(after.next_bill_date, '2026-02-01');
});

test('running the same day again bills nothing', () => {
  const f = freshTenant();
  const { subscription } = subscribe(f);
  f.tx(() => subs.runBilling(f.repo, { through: '2026-01-01' }));
  const again = f.tx(() => subs.runBilling(f.repo, { through: '2026-01-01' }));
  assert.equal(again.count, 0);
  assert.equal(balance(f, '1100'), Money.parse(300), 'and nothing was billed twice');
  void subscription;
});

test('a run that is months late catches up on one invoice', () => {
  const f = freshTenant();
  const { subscription } = subscribe(f);
  const run = f.tx(() => subs.runBilling(f.repo, { through: '2026-03-15' }));

  assert.equal(run.count, 1, 'one invoice, not three');
  assert.equal(run.invoiced[0].periods, 3, 'carrying January, February and March');
  assert.equal(run.amount, Money.parse(900));
  const invoice = f.repo.get('txn', run.invoiced[0].invoice_id);
  const lines = f.repo.query('SELECT * FROM txn_line WHERE tenant_id = :t AND txn_id = ? ORDER BY line_no', [invoice.id]);
  assert.equal(lines.length, 3);
  assert.equal(subs.getSubscription(f.repo, subscription.id).billed_through, '2026-04-01');
});

test('every period billed is recorded, so none can be billed again', () => {
  const f = freshTenant();
  const { subscription } = subscribe(f);
  f.tx(() => subs.runBilling(f.repo, { through: '2026-03-15' }));
  const history = subs.billingHistory(f.repo, subscription.id);
  assert.deepEqual(history.map((b) => b.period_start).sort(), ['2026-01-01', '2026-02-01', '2026-03-01']);
  assert.ok(history.every((b) => b.invoice_txn_id), 'each points at the invoice that charged it');
});

test('the first period is prorated onto a fixed billing day', () => {
  const f = freshTenant();
  const { subscription } = subscribe(f, { start_date: '2026-01-15', billing_day: 1 });
  const plan = subs.previewNext(f.repo, subscription.id, { through: '2026-02-01' });

  assert.equal(plan.periods.length, 2);
  const stub = plan.periods[0];
  assert.equal(stub.period_start, '2026-01-15');
  assert.equal(stub.period_end, '2026-02-01');
  // 17 of the 31 days from 15 Jan to 15 Feb.
  assert.equal(stub.charges[0].prorated, 1);
  assert.equal(stub.total, Math.round(Money.parse(300) * (17 / 31)));
  assert.equal(plan.periods[1].total, Money.parse(300), 'then whole months');
});

test('billing in arrears invoices after the period, not before it', () => {
  const f = freshTenant();
  const { subscription } = subscribe(f, { bill_in_advance: false });
  assert.equal(subscription.next_bill_date, '2026-02-01', 'January is billed once it is over');

  assert.equal(f.tx(() => subs.runBilling(f.repo, { through: '2026-01-20' })).count, 0);
  const run = f.tx(() => subs.runBilling(f.repo, { through: '2026-02-01' }));
  assert.equal(run.count, 1);
  assert.equal(f.repo.get('txn', run.invoiced[0].invoice_id).txn_date, '2026-02-01');
});

// ------------------------------------------------------------- amendments
test('adding seats part way through bills for the part of the month they apply', () => {
  const f = freshTenant();
  const { subscription, item } = subscribe(f);
  f.tx(() => subs.runBilling(f.repo, { through: '2026-01-01' }));

  // Ten more seats from 15 February.
  f.tx(() => subs.amend(f.repo, subscription.id, {
    kind: 'add', effective_date: '2026-02-15',
    line: { item_id: item.id, quantity: 10, unit_price: 30 },
    note: 'Ten more for the new team',
  }));

  const plan = subs.previewNext(f.repo, subscription.id, { through: '2026-02-01' });
  const february = plan.periods[0];
  assert.equal(february.charges.length, 2, 'the original ten, and the new ten prorated');
  const added = february.charges.find((c) => c.prorated);
  assert.equal(added.period_start, '2026-02-15');
  // 14 of the 28 days in February.
  assert.equal(added.amount, Math.round(Money.parse(300) * (14 / 28)));
  assert.equal(february.total, Money.parse(300) + added.amount);
});

test('a quantity change prices each period at whatever was true during it', () => {
  const f = freshTenant();
  const { subscription } = subscribe(f);
  f.tx(() => subs.runBilling(f.repo, { through: '2026-01-01' }));
  const line = subs.linesFor(f.repo, subscription.id)[0];

  f.tx(() => subs.amend(f.repo, subscription.id, {
    kind: 'quantity', line_id: line.id, effective_date: '2026-02-01', quantity: 25,
  }));
  const after = subs.getSubscription(f.repo, subscription.id);
  assert.equal(after.mrr, Money.parse(750), 'twenty-five seats now');

  const run = f.tx(() => subs.runBilling(f.repo, { through: '2026-02-01' }));
  assert.equal(run.amount, Money.parse(750), 'February is billed at the new number');
  assert.equal(subs.billingHistory(f.repo, subscription.id).length, 2);
});

test('an amendment cannot be backdated into a period already invoiced', () => {
  const f = freshTenant();
  const { subscription } = subscribe(f);
  f.tx(() => subs.runBilling(f.repo, { through: '2026-02-01' }));
  const line = subs.linesFor(f.repo, subscription.id)[0];
  const err = thrown(() => f.tx(() => subs.amend(f.repo, subscription.id, {
    kind: 'quantity', line_id: line.id, effective_date: '2026-01-10', quantity: 5,
  })));
  assert.match(err.message, /billed to 2026-03-01/);
});

test('removing a line stops it billing but keeps it on record', () => {
  const f = freshTenant();
  const { subscription } = subscribe(f);
  f.tx(() => subs.runBilling(f.repo, { through: '2026-01-01' }));
  const line = subs.linesFor(f.repo, subscription.id)[0];

  f.tx(() => subs.amend(f.repo, subscription.id, { kind: 'remove', line_id: line.id, effective_date: '2026-02-01' }));
  const plan = subs.previewNext(f.repo, subscription.id, { through: '2026-03-01' });
  assert.equal(plan.periods.length, 0, 'nothing left to bill');
  assert.equal(subs.linesFor(f.repo, subscription.id).length, 1, 'but the line is still there');
  assert.equal(subs.linesFor(f.repo, subscription.id)[0].status, 'removed');
});

// ------------------------------------------------------------------ usage
test('metered usage is billed for the period it fell in, less what is included', () => {
  const f = freshTenant();
  const api = f.tx(() => inv.createItem(f.repo, {
    sku: 'API', name: 'API calls', type: 'service', base_price: 0.02,
    income_account_id: acct(f, '4030').id, uom: 'calls',
  }));
  const { subscription } = subscribe(f, {
    lines: [{ item_id: api.id, model: 'usage', quantity: 0, unit_price: 0.02, included_quantity: 1000, usage_uom: 'calls' }],
  });
  const line = subs.linesFor(f.repo, subscription.id)[0];

  f.tx(() => subs.recordUsage(f.repo, subscription.id, { line_id: line.id, usage_date: '2026-01-10', quantity: 1500 }));
  f.tx(() => subs.recordUsage(f.repo, subscription.id, { line_id: line.id, usage_date: '2026-01-20', quantity: 500 }));

  const plan = subs.previewNext(f.repo, subscription.id, { through: '2026-01-01' });
  const charge = plan.periods[0].charges[0];
  assert.equal(charge.quantity, Qty.parse(1000), '2,000 used less 1,000 included');
  assert.equal(charge.amount, Money.parse(20));
  assert.match(charge.detail, /2000 calls used, 1000 included/);

  f.tx(() => subs.runBilling(f.repo, { through: '2026-01-01' }));
  const used = f.repo.query('SELECT billing_id FROM subscription_usage WHERE tenant_id = :t');
  assert.ok(used.every((u) => u.billing_id), 'and the usage is stamped so it cannot be charged again');
});

test('usage entirely within the allowance is shown but charges nothing', () => {
  const f = freshTenant();
  const api = f.tx(() => inv.createItem(f.repo, { sku: 'API', name: 'API calls', type: 'service', base_price: 0.02, income_account_id: acct(f, '4030').id }));
  const { subscription } = subscribe(f, {
    lines: [{ item_id: api.id, model: 'usage', quantity: 0, unit_price: 0.02, included_quantity: 1000, usage_uom: 'calls' }],
  });
  const line = subs.linesFor(f.repo, subscription.id)[0];
  f.tx(() => subs.recordUsage(f.repo, subscription.id, { line_id: line.id, usage_date: '2026-01-10', quantity: 400 }));
  const charge = subs.previewNext(f.repo, subscription.id, { through: '2026-01-01' }).periods[0].charges[0];
  assert.equal(charge.amount, 0);
  assert.match(charge.detail, /all within the 1000 included/);
});

test('billing a period whose usage stayed inside the allowance raises no invoice', () => {
  const f = freshTenant();
  const api = f.tx(() => inv.createItem(f.repo, { sku: 'API-ALLOW', name: 'API calls', type: 'service', base_price: 0.02, income_account_id: acct(f, '4030').id }));
  const { subscription } = subscribe(f, {
    lines: [{ item_id: api.id, model: 'usage', quantity: 0, unit_price: 0.02, included_quantity: 1000, usage_uom: 'calls' }],
  });
  const line = subs.linesFor(f.repo, subscription.id)[0];
  f.tx(() => subs.recordUsage(f.repo, subscription.id, { line_id: line.id, usage_date: '2026-01-10', quantity: 400 }));

  const run = f.tx(() => subs.runBilling(f.repo, { through: '2026-01-01', id: subscription.id }));
  assert.equal(run.count, 1, 'the period was processed');
  assert.equal(run.invoiced[0].invoice_id, null, 'but nothing was invoiced');
  assert.match(run.invoiced[0].note, /within the included allowance/);
  assert.equal(f.repo.scalar('SELECT COUNT(*) c FROM txn WHERE tenant_id = :t AND subscription_id = ?', [subscription.id], 0), 0);

  // The period is still recorded, which is what stops it being billed twice
  // once the customer starts using more than they are allowed.
  const billed = f.repo.query('SELECT * FROM subscription_billing WHERE tenant_id = :t');
  assert.equal(billed.length, 1);
  assert.equal(billed[0].invoice_txn_id, null);
  assert.ok(f.repo.queryOne('SELECT billing_id FROM subscription_usage WHERE tenant_id = :t').billing_id);
  assert.equal(f.repo.get('subscription', subscription.id).billed_through, '2026-02-01');

  const again = f.tx(() => subs.runBilling(f.repo, { through: '2026-01-01', id: subscription.id }));
  assert.equal(again.count, 0, 'and running it again bills nothing');
});

test('usage cannot be recorded into a period already billed', () => {
  const f = freshTenant();
  const api = f.tx(() => inv.createItem(f.repo, { sku: 'API', name: 'API calls', type: 'service', base_price: 0.02, income_account_id: acct(f, '4030').id }));
  const { subscription } = subscribe(f, {
    lines: [{ item_id: api.id, model: 'usage', quantity: 0, unit_price: 0.02, usage_uom: 'calls' }],
  });
  const line = subs.linesFor(f.repo, subscription.id)[0];
  f.tx(() => subs.recordUsage(f.repo, subscription.id, { line_id: line.id, usage_date: '2026-01-10', quantity: 100 }));
  f.tx(() => subs.runBilling(f.repo, { through: '2026-01-01' }));
  const err = thrown(() => f.tx(() => subs.recordUsage(f.repo, subscription.id, {
    line_id: line.id, usage_date: '2026-01-20', quantity: 50,
  })));
  assert.match(err.message, /already billed/);
});

// -------------------------------------------------------------- one-offs
test('a one-time charge is billed once and never again', () => {
  const f = freshTenant();
  const item = seat(f);
  const setup = f.tx(() => inv.createItem(f.repo, { sku: 'SETUP', name: 'Onboarding', type: 'service', base_price: 500, income_account_id: acct(f, '4020').id }));
  const { subscription } = subscribe(f, {
    item,
    lines: [
      { item_id: item.id, quantity: 10, unit_price: 30 },
      { item_id: setup.id, model: 'one_time', quantity: 1, unit_price: 500 },
    ],
  });

  const first = f.tx(() => subs.runBilling(f.repo, { through: '2026-01-01' }));
  assert.equal(first.amount, Money.parse(800), 'three hundred of seats and the five hundred setup');

  const second = f.tx(() => subs.runBilling(f.repo, { through: '2026-02-01' }));
  assert.equal(second.amount, Money.parse(300), 'the setup fee does not come round again');
  void subscription;
});

// ------------------------------------------------------- revenue and term
test('a subscription invoice defers revenue when the item says it should', () => {
  const f = freshTenant();
  const template = f.tx(() => schedules.createTemplate(f.repo, {
    name: 'Monthly service', kind: 'revenue', method: 'straight_daily',
    term_months: 12, start_rule: 'service_start',
  }));
  const item = f.tx(() => inv.createItem(f.repo, {
    sku: 'PLAT', name: 'Platform', type: 'service', base_price: 1200,
    income_account_id: acct(f, '4030').id, revenue_template_id: template.id,
  }));
  const { subscription } = subscribe(f, {
    item, billing_frequency: 'annually',
    lines: [{ item_id: item.id, quantity: 1, unit_price: 1200 }],
  });

  f.tx(() => subs.runBilling(f.repo, { through: '2026-01-01' }));
  assert.equal(balance(f, '1100'), Money.parse(1200), 'the customer owes the year');
  assert.equal(balance(f, '2300'), -Money.parse(1200), 'and none of it is earned yet');
  assert.equal(balance(f, '4030'), 0);

  const schedule = schedules.schedulesForTxn(f.repo, f.repo.queryOne(
    'SELECT id FROM txn WHERE tenant_id = :t AND subscription_id = ?', [subscription.id]).id);
  assert.equal(schedule.length, 1, 'billing a year created a schedule to earn it over one');
  assert.equal(gl.integrityCheck(f.repo).ok, true);
});

test('a term that ends renews itself, or expires', () => {
  const f = freshTenant();
  const { subscription } = subscribe(f, { term_months: 2, billing_frequency: 'monthly' });
  assert.equal(subscription.end_date, '2026-02-28');

  f.tx(() => subs.runBilling(f.repo, { through: '2026-03-01' }));
  const renewed = subs.getSubscription(f.repo, subscription.id);
  assert.equal(renewed.status, 'active');
  assert.equal(renewed.renewal_count, 1);
  assert.ok(renewed.end_date > '2026-02-28', 'the term was extended');

  const other = subscribe(f, { name: 'No Renew Ltd', term_months: 2, auto_renew: false }).subscription;
  f.tx(() => subs.runBilling(f.repo, { through: '2026-03-01', id: other.id }));
  assert.equal(subs.getSubscription(f.repo, other.id).status, 'expired');
});

test('suspended and cancelled subscriptions stop billing', () => {
  const f = freshTenant();
  const { subscription } = subscribe(f);
  f.tx(() => subs.suspend(f.repo, subscription.id, { reason: 'Payment dispute' }));
  assert.equal(f.tx(() => subs.runBilling(f.repo, { through: '2026-06-01' })).count, 0);

  f.tx(() => subs.resume(f.repo, subscription.id));
  assert.ok(f.tx(() => subs.runBilling(f.repo, { through: '2026-02-01' })).count > 0);

  f.tx(() => subs.cancel(f.repo, subscription.id, { effective_date: '2026-03-01', reason: 'Moved supplier' }));
  const cancelled = subs.getSubscription(f.repo, subscription.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.next_bill_date, null);
  assert.equal(f.tx(() => subs.runBilling(f.repo, { through: '2026-12-01' })).count, 0);
});

test('a draft bills nothing however overdue it looks', () => {
  const f = freshTenant();
  const { subscription } = subscribe(f, { activate: false });
  assert.equal(subscription.status, 'draft');
  assert.equal(f.tx(() => subs.runBilling(f.repo, { through: '2026-06-01' })).count, 0);
  f.tx(() => subs.activate(f.repo, subscription.id));
  assert.ok(f.tx(() => subs.runBilling(f.repo, { through: '2026-01-01' })).count > 0);
});

test('billing into a closed period is held back and said so', () => {
  const f = freshTenant();
  const { subscription } = subscribe(f);
  const jan = f.repo.queryOne("SELECT * FROM accounting_period WHERE tenant_id = :t AND start_date = '2026-01-01'");
  f.tx(() => gl.closePeriod(f.repo, jan.id, { force: true }));

  const run = f.tx(() => subs.runBilling(f.repo, { through: '2026-01-01' }));
  assert.equal(run.count, 0);
  assert.match(run.skipped[0].reason, /closed/);
  assert.equal(subs.getSubscription(f.repo, subscription.id).billed_through, '2026-01-01', 'and nothing moved');
});

test('what the preview says is what the run bills', () => {
  const f = freshTenant();
  const { subscription } = subscribe(f, { start_date: '2026-01-10', billing_day: 1 });
  const preview = f.tx(() => subs.runBilling(f.repo, { through: '2026-03-01', dry_run: true }));
  assert.equal(preview.dry_run, true);
  assert.equal(f.repo.scalar("SELECT COUNT(*) c FROM txn WHERE tenant_id = :t AND type = 'INVOICE'", [], 0), 0);

  const real = f.tx(() => subs.runBilling(f.repo, { through: '2026-03-01' }));
  assert.equal(real.amount, preview.amount);
  assert.equal(real.invoiced[0].periods, preview.invoiced[0].periods);
  void subscription;
});

test('the terms behind an invoice already sent cannot be changed', () => {
  const f = freshTenant();
  const { subscription } = subscribe(f);
  f.tx(() => subs.runBilling(f.repo, { through: '2026-01-01' }));
  assert.match(thrown(() => f.tx(() => subs.updateSubscription(f.repo, subscription.id, { billing_frequency: 'annually' }))).message,
    /cannot change now/);
  assert.match(thrown(() => f.tx(() => subs.updateSubscription(f.repo, subscription.id, { lines: [] }))).message,
    /amendment/);
  // The things that do not affect what was billed are still editable.
  const renamed = f.tx(() => subs.updateSubscription(f.repo, subscription.id, { name: 'Platform — renamed', po_number: 'PO-991' }));
  assert.equal(renamed.name, 'Platform — renamed');
});

test('recurring revenue is the monthly value of what recurs', () => {
  const f = freshTenant();
  const item = seat(f);
  const setup = f.tx(() => inv.createItem(f.repo, { sku: 'SETUP', name: 'Onboarding', type: 'service', base_price: 5000, income_account_id: acct(f, '4020').id }));
  subscribe(f, { item, lines: [
    { item_id: item.id, quantity: 10, unit_price: 30 },
    { item_id: setup.id, model: 'one_time', quantity: 1, unit_price: 5000 },
  ] });
  // An annual subscription counts as a twelfth of its price each month.
  subscribe(f, {
    name: 'Annual Ltd', item, billing_frequency: 'annually',
    lines: [{ item_id: item.id, quantity: 1, unit_price: 1200 }],
  });

  const rr = subs.recurringRevenue(f.repo, { as_of: '2026-01-15' });
  assert.equal(rr.subscriptions, 2);
  assert.equal(rr.mrr, Money.parse(400), '300 monthly plus 1200 a year');
  assert.equal(rr.arr, Money.parse(4800));
  assert.equal(rr.by_customer.length, 2);
});

test('recurring revenue puts every currency into one before adding it up', () => {
  const f = freshTenant();
  const item = seat(f);
  f.tx(() => f.repo.exec(
    `INSERT INTO exchange_rate (tenant_id, from_currency, to_currency, rate_date, rate, source)
     VALUES (:t,?,?,?,?,'test')`, ['GBP', 'USD', '2026-01-01', 1.25]));

  subscribe(f, { item, lines: [{ item_id: item.id, quantity: 10, unit_price: 30 }] });
  const gbp = f.tx(() => entities.createCustomer(f.repo, {
    name: 'Sterling Ltd', subsidiary_id: f.subsidiaryId, currency: 'GBP',
  }));
  subscribe(f, { customer: gbp, item, lines: [{ item_id: item.id, quantity: 10, unit_price: 40 }] });

  const rr = subs.recurringRevenue(f.repo, { as_of: '2026-01-15' });
  assert.equal(rr.currency, 'USD');
  // 300 dollars, plus 400 pounds at 1.25 — not 700 of nothing in particular.
  assert.equal(rr.mrr, Money.parse(800));
  assert.deepEqual(rr.missing_rates, []);
  const sterling = rr.by_customer.find((r) => r.currency === 'GBP');
  assert.equal(sterling.mrr, Money.parse(400), 'the contract is still shown in its own currency');
  assert.equal(sterling.mrr_base, Money.parse(500));
});

test('a contract in a currency with no rate is left out and named', () => {
  const f = freshTenant();
  const item = seat(f);
  subscribe(f, { item, lines: [{ item_id: item.id, quantity: 10, unit_price: 30 }] });
  const yen = f.tx(() => entities.createCustomer(f.repo, {
    name: 'Yen KK', subsidiary_id: f.subsidiaryId, currency: 'JPY',
  }));
  subscribe(f, { customer: yen, item, lines: [{ item_id: item.id, quantity: 10, unit_price: 40 }] });

  const rr = subs.recurringRevenue(f.repo, { as_of: '2026-01-15' });
  assert.equal(rr.mrr, Money.parse(300), 'the total is the part that could be converted');
  assert.deepEqual(rr.missing_rates, ['JPY'], 'and says which currency it could not');
  assert.equal(rr.by_customer.find((r) => r.currency === 'JPY').mrr_base, null);
});

test('a subscription with no lines cannot be activated', () => {
  const f = freshTenant();
  const customer = f.tx(() => entities.createCustomer(f.repo, { name: 'Empty Ltd', subsidiary_id: f.subsidiaryId }));
  assert.match(thrown(() => f.tx(() => subs.createSubscription(f.repo, {
    customer_id: customer.id, start_date: '2026-01-01', lines: [],
  }))).fields.lines, /at least one line/);
});

test('a line cannot start before the subscription it is on', () => {
  const f = freshTenant();
  const customer = f.tx(() => entities.createCustomer(f.repo, { name: 'Early Ltd', subsidiary_id: f.subsidiaryId }));
  const item = seat(f);
  assert.match(thrown(() => f.tx(() => subs.createSubscription(f.repo, {
    customer_id: customer.id, start_date: '2026-01-01',
    lines: [{ item_id: item.id, quantity: 1, unit_price: 10, start_date: '2025-06-01' }],
  }))).fields['lines.0.start_date'], /cannot start before/);
});
