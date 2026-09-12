// Billing work that is not a catalogue item: project hours, project expenses,
// and a field-service visit. Each of these produces invoice lines with no
// item on them, and a line with neither an item nor an account is refused --
// so before this, a time-and-materials project and a completed service job
// were both dead ends unless the caller happened to pass a service item.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant, DATE } from './helpers.mjs';
import * as projects from '../src/modules/projects.mjs';
import * as service from '../src/modules/service.mjs';
import * as warehouse from '../src/modules/warehouse.mjs';
import * as entities from '../src/modules/entities.mjs';
import * as hr from '../src/modules/hr.mjs';
import * as txnMod from '../src/modules/txn.mjs';
import * as gl from '../src/modules/gl.mjs';
import * as inventory from '../src/modules/inventory.mjs';
import * as commerce from '../src/modules/commerce.mjs';
import { ulid, nowIso, Money } from '../src/core/util.mjs';

function customer(f, name = 'Northwind Labs') {
  return f.tx(() => entities.createCustomer(f.repo, { name, subsidiary_id: f.subsidiaryId }));
}

function billableProject(f, { income_account_id = null } = {}) {
  const c = customer(f);
  const employee = f.tx(() => hr.createEmployee(f.repo, {
    first_name: 'Ida', last_name: 'Mensah', email: 'ida@test.local',
    hire_date: '2026-01-05', subsidiary_id: f.subsidiaryId,
  }));
  const project = f.tx(() => projects.createProject(f.repo, {
    name: 'Rollout', subsidiary_id: f.subsidiaryId, customer_id: c.id,
    billing_type: 'time_and_materials', status: 'active', income_account_id,
  }));
  f.tx(() => f.repo.insert('time_entry', {
    id: ulid(), employee_id: employee.id, entry_date: DATE, hours: 6,
    project_id: project.id, billable: 1, status: 'approved',
    bill_rate: Money.parse(150), cost_rate: Money.parse(60),
    created_at: nowIso(), updated_at: nowIso(),
  }));
  return { project, employee, customer: c };
}

const postedTo = (f, accountId) => f.repo.scalar(
  `SELECT COALESCE(SUM(jl.base_credit - jl.base_debit), 0) v
   FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
   WHERE jl.tenant_id = :t AND je.status = 'posted' AND jl.account_id = ?`, [accountId], 0);

test('a time-and-materials project bills its hours without a service item', () => {
  const f = freshTenant();
  const { project } = billableProject(f);
  const { invoice } = f.tx(() => projects.billProject(f.repo, project.id, { txn_date: DATE }));
  const lines = txnMod.getTxn(f.repo, invoice.id).lines;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].item_id, null);
  assert.equal(lines[0].account_id, f.posting.service_revenue);
  assert.equal(invoice.total, Money.parse(900));
});

test("the project's own income account wins over the company default", () => {
  const f = freshTenant();
  const other = f.repo.queryOne("SELECT id FROM account WHERE tenant_id = :t AND number = '4950'");
  const { project } = billableProject(f, { income_account_id: other.id });
  const { invoice } = f.tx(() => projects.billProject(f.repo, project.id, { txn_date: DATE }));
  assert.equal(txnMod.getTxn(f.repo, invoice.id).lines[0].account_id, other.id);
});

test('billed hours are marked, so the same hour is never invoiced twice', () => {
  const f = freshTenant();
  const { project } = billableProject(f);
  f.tx(() => projects.billProject(f.repo, project.id, { txn_date: DATE }));
  assert.equal(projects.unbilled(f.repo, project.id).time.length, 0);
  assert.throws(() => f.tx(() => projects.billProject(f.repo, project.id, { txn_date: DATE })),
    /Nothing is currently billable/);
});

test('a project invoice posts revenue and leaves the books tied', () => {
  const f = freshTenant();
  const { project } = billableProject(f);
  const { invoice } = f.tx(() => projects.billProject(f.repo, project.id, { txn_date: DATE }));
  assert.equal(txnMod.getTxn(f.repo, invoice.id).posted, 1);
  assert.equal(postedTo(f, f.posting.service_revenue), Money.parse(900));
  assert.equal(gl.integrityCheck(f.repo).ok, true);
});

test('a completed service visit invoices its labour line', () => {
  const f = freshTenant();
  const c = customer(f, 'Harbour Foods');
  const order = f.tx(() => service.createOrder(f.repo, {
    customer_id: c.id, subsidiary_id: f.subsidiaryId, order_type: 'repair', description: 'Chiller down',
  }));
  f.tx(() => service.addLines(f.repo, order.id, [
    { line_type: 'labour', description: 'On-site diagnosis', quantity: 2, unit_price: 120, unit_cost: 45 },
  ]));
  f.tx(() => service.setStatus(f.repo, order.id, 'complete'));
  const { invoice } = f.tx(() => service.invoiceOrder(f.repo, order.id, { txn_date: DATE }));
  const lines = txnMod.getTxn(f.repo, invoice.id).lines;
  assert.equal(lines[0].item_id, null);
  assert.equal(lines[0].account_id, f.posting.service_revenue);
  assert.equal(invoice.total, Money.parse(240));
  assert.equal(service.getOrder(f.repo, order.id).status, 'invoiced');
});

test('racking a location with its first bin turns bin tracking on', () => {
  const f = freshTenant();
  assert.equal(f.repo.get('location', f.location.id).uses_bins, 0);
  f.tx(() => warehouse.createBin(f.repo, { location_id: f.location.id, code: 'A-01-01', bin_type: 'picking' }));
  assert.equal(f.repo.get('location', f.location.id).uses_bins, 1);
});

test('a converted cart is billed at the price the shopper was shown', () => {
  const f = freshTenant();
  const c = customer(f, 'Web Shopper');
  const item = f.tx(() => inventory.createItem(f.repo, {
    sku: 'WIDGET-1', name: 'Widget', type: 'inventory', sales_price: 200, purchase_price: 80,
  }));
  const channel = f.tx(() => commerce.createChannel(f.repo, {
    name: 'Online', subsidiary_id: f.subsidiaryId, location_id: f.location.id,
  }));
  const cartId = ulid();
  f.tx(() => f.repo.insert('cart', {
    id: cartId, channel_id: channel.id, customer_id: c.id, email: 'shopper@test.local',
    status: 'open', currency: 'USD', subtotal: Money.parse(150),
    // Discounted at checkout: the order must not quietly revert to list price.
    lines: [{ item_id: item.id, name: 'Widget', quantity: 1, unit_price: 150 }],
    converted_txn_id: null, created_at: nowIso(), updated_at: nowIso(),
  }));
  const { order } = f.tx(() => commerce.convertCart(f.repo, cartId, { txn_date: DATE }));
  assert.equal(txnMod.getTxn(f.repo, order.id).lines[0].unit_price, Money.parse(150));
});
