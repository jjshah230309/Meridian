// The pivot builder aggregates in JS over rows platform.mjs's own query
// engine (or an odata.mjs analytic set) already fetched -- these tests exist
// to check that reuse actually carries row security and tenant scoping
// through, not just that the arithmetic is right.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant, DATE } from './helpers.mjs';
import * as pivot from '../src/modules/pivot.mjs';
import * as entities from '../src/modules/entities.mjs';
import * as inv from '../src/modules/inventory.mjs';
import * as T from '../src/modules/txn.mjs';
import * as rbac from '../src/core/rbac.mjs';
import { Repo } from '../src/core/db.mjs';
import { Money, addMonths } from '../src/core/util.mjs';

function invoicingCo() {
  const f = freshTenant();
  // freshTenant()'s repo carries a user but no resolved access, unlike a
  // real request (server.mjs always resolves one) -- give it the owner's,
  // the same way a signed-in owner's request would.
  f.repo.ctx.access = rbac.loadAccess(f.db, f.tenant.id, f.ownerId);
  Object.assign(f, f.tx(() => ({
    acme: entities.createCustomer(f.repo, { name: 'Acme Corp' }),
    globex: entities.createCustomer(f.repo, { name: 'Globex' }),
    widget: inv.createItem(f.repo, { sku: 'WID-1', name: 'Widget', type: 'noninventory', base_price: 100 }),
  })));
  return f;
}

function invoice(f, customer, amount, date = DATE) {
  return f.tx(() => T.createTxn(f.repo, 'INVOICE', {
    entity_id: customer.id, txn_date: date,
    lines: [{ item_id: f.widget.id, quantity: 1, unit_price: amount }],
  }));
}

test('a pivot by customer sums the value field correctly, with a grand total', () => {
  const f = invoicingCo();
  invoice(f, f.acme, 100);
  invoice(f, f.acme, 250);
  invoice(f, f.globex, 40);

  const result = pivot.runPivot(f.repo, rbac.loadAccess(f.db, f.tenant.id, f.ownerId), {
    source: { kind: 'record', name: 'invoice' },
    row: { field: 'entity_id' },
    values: [{ field: 'total', fn: 'sum' }, { field: 'id', fn: 'count' }],
  });

  const acmeRow = result.rows.find((r) => r.label === 'Acme Corp');
  const globexRow = result.rows.find((r) => r.label === 'Globex');
  assert.equal(acmeRow.total[0], Money.parse(350));
  assert.equal(acmeRow.total[1], 2);
  assert.equal(globexRow.total[0], Money.parse(40));
  assert.equal(result.grand_total[0], Money.parse(390));
  assert.equal(result.grand_total[1], 3);
});

test('a date row bucketed by month groups across the month, sorted chronologically', () => {
  const f = invoicingCo();
  invoice(f, f.acme, 100, '2026-01-15');
  invoice(f, f.acme, 50, '2026-01-20');
  invoice(f, f.acme, 200, '2026-03-01');

  const result = pivot.runPivot(f.repo, rbac.loadAccess(f.db, f.tenant.id, f.ownerId), {
    source: { kind: 'record', name: 'invoice' },
    row: { field: 'txn_date', bucket: 'month' },
    values: [{ field: 'total', fn: 'sum' }],
  });

  assert.deepEqual(result.rows.map((r) => r.label), ['2026-01', '2026-03']);
  assert.equal(result.rows[0].total[0], Money.parse(150));
  assert.equal(result.rows[1].total[0], Money.parse(200));
});

test('a row and a column dimension together produce one cell per combination, plus row/column totals', () => {
  const f = invoicingCo();
  invoice(f, f.acme, 100, DATE);
  invoice(f, f.acme, 20, addMonths(DATE, 1));
  invoice(f, f.globex, 40, DATE);

  const result = pivot.runPivot(f.repo, rbac.loadAccess(f.db, f.tenant.id, f.ownerId), {
    source: { kind: 'record', name: 'invoice' },
    row: { field: 'entity_id' },
    col: { field: 'txn_date', bucket: 'month' },
    values: [{ field: 'total', fn: 'sum' }],
  });

  assert.equal(result.columns.length, 2);
  const acmeRow = result.rows.find((r) => r.label === 'Acme Corp');
  const monthIdx = result.columns.findIndex((c) => c.key === DATE.slice(0, 7));
  assert.equal(acmeRow.cells[monthIdx][0], Money.parse(100));
  assert.equal(acmeRow.total[0], Money.parse(120), 'the row total must cover every column');
  const colTotal = result.column_totals[monthIdx][0];
  assert.equal(colTotal, Money.parse(140), 'the column total must cover every row');
});

test('an unknown dataset, a missing row field, or no value at all is a 4xx, not a 500', () => {
  const f = invoicingCo();
  const access = rbac.loadAccess(f.db, f.tenant.id, f.ownerId);
  assert.throws(() => pivot.runPivot(f.repo, access, { source: { kind: 'record', name: 'not_a_type' }, row: { field: 'x' }, values: [{ field: 'total', fn: 'sum' }] }),
    (e) => e.status >= 400 && e.status < 500);
  assert.throws(() => pivot.runPivot(f.repo, access, { source: { kind: 'record', name: 'invoice' }, values: [{ field: 'total', fn: 'sum' }] }),
    (e) => e.status >= 400 && e.status < 500);
  assert.throws(() => pivot.runPivot(f.repo, access, { source: { kind: 'record', name: 'invoice' }, row: { field: 'entity_id' }, values: [] }),
    (e) => e.status >= 400 && e.status < 500);
});

test('row security restricts a pivot the same way it restricts a list', () => {
  const f = invoicingCo();
  // A second customer the rep does not own.
  const other = f.tx(() => entities.createCustomer(f.repo, { name: 'Someone Else\'s Account', owner_id: f.ownerId }));
  const repId = f.tx(() => {
    const id = f.repo.insert('app_user', {
      email: 'rep@test.local', name: 'Rep', status: 'active', is_owner: 0,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    f.repo.exec('INSERT INTO user_role (tenant_id, user_id, role_id) VALUES (:t,?,?)', [id, f.roleIds['Sales Rep']]);
    f.repo.exec('UPDATE customer SET owner_id = ? WHERE tenant_id = :t AND id IN (?, ?)', [id, f.acme.id, f.globex.id]);
    return id;
  });
  const repAccess = rbac.loadAccess(f.db, f.tenant.id, repId);

  const ownerView = pivot.runPivot(f.repo, rbac.loadAccess(f.db, f.tenant.id, f.ownerId), {
    source: { kind: 'record', name: 'customer' }, row: { field: 'id' }, values: [{ field: 'id', fn: 'count' }],
  });
  const repView = pivot.runPivot(f.repo, repAccess, {
    source: { kind: 'record', name: 'customer' }, row: { field: 'id' }, values: [{ field: 'id', fn: 'count' }],
  });
  assert.equal(ownerView.row_count, 3, 'the owner sees every customer');
  assert.equal(repView.row_count, 2, 'the rep sees only the customers assigned to them');
  void other;
});

test('a pivot never crosses the tenant boundary', () => {
  const a = invoicingCo();
  const b = invoicingCo();
  invoice(a, a.acme, 999);
  invoice(b, b.acme, 1);

  const resultA = pivot.runPivot(a.repo, rbac.loadAccess(a.db, a.tenant.id, a.ownerId), {
    source: { kind: 'record', name: 'invoice' }, row: { field: 'entity_id' }, values: [{ field: 'total', fn: 'sum' }],
  });
  assert.equal(resultA.grand_total[0], Money.parse(999));
});

test('an analytic set needs account view permission, which a role without it does not have', () => {
  const f = invoicingCo();
  invoice(f, f.acme, 100);
  const repId = f.tx(() => {
    const id = f.repo.insert('app_user', {
      email: 'rep2@test.local', name: 'Rep', status: 'active', is_owner: 0,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    f.repo.exec('INSERT INTO user_role (tenant_id, user_id, role_id) VALUES (:t,?,?)', [id, f.roleIds['Sales Rep']]);
    return id;
  });
  const repAccess = rbac.loadAccess(f.db, f.tenant.id, repId);
  assert.throws(() => pivot.runPivot(f.repo, repAccess, {
    source: { kind: 'analytic', name: 'SalesFact' }, row: { field: 'CustomerName' }, values: [{ field: 'LineAmount', fn: 'sum' }],
  }), (e) => e.status === 403 || e.status === 400);

  const ok = pivot.runPivot(f.repo, rbac.loadAccess(f.db, f.tenant.id, f.ownerId), {
    source: { kind: 'analytic', name: 'SalesFact' }, row: { field: 'CustomerName' }, values: [{ field: 'LineAmount', fn: 'sum' }],
  });
  assert.ok(ok.rows.length >= 1);
});

test('a saved custom report can only be changed by its owner or someone with full access', () => {
  const f = invoicingCo();
  invoice(f, f.acme, 100);
  const definition = { source: { kind: 'record', name: 'invoice' }, row: { field: 'entity_id' }, values: [{ field: 'total', fn: 'sum' }] };
  const report = f.tx(() => pivot.createReport(f.repo, { name: 'Sales by customer', definition, is_public: false }));
  assert.equal(report.owner_id, f.ownerId);

  const otherId = f.tx(() => f.repo.insert('app_user', {
    email: 'other@test.local', name: 'Other', status: 'active', is_owner: 0,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }));
  const otherAccess = rbac.loadAccess(f.db, f.tenant.id, otherId);
  const otherRepo = new Repo(f.db, f.tenant.id, { user: { id: otherId }, access: otherAccess });
  assert.throws(() => f.tx(() => pivot.updateReport(otherRepo, report.id, { name: 'Hijacked' })), /owner/);

  const updated = f.tx(() => pivot.updateReport(f.repo, report.id, { name: 'Renamed' }));
  assert.equal(updated.name, 'Renamed');
});
