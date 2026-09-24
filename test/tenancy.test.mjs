// Tenant isolation and access control. A failure here is a data breach.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import url from 'node:url';
import { openDatabase, migrate, Repo, transaction, TENANT_TABLES, bindTenant, JSON_COLUMNS } from '../src/core/db.mjs';
import { provisionTenant } from '../src/modules/setup.mjs';
import * as entities from '../src/modules/entities.mjs';
import * as rbac from '../src/core/rbac.mjs';
import * as platform from '../src/modules/platform.mjs';
import * as records from '../src/modules/records.mjs';
import { freshTenant } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

function twoTenants() {
  const db = openDatabase(':memory:');
  migrate(db, path.join(ROOT, 'migrations'));
  const a = transaction(db, () => provisionTenant(db, { name: 'Alpha Ltd', ownerEmail: 'a@a.test', ownerPassword: 'Correct-Horse-9', fiscalYear: 2026 }));
  const b = transaction(db, () => provisionTenant(db, { name: 'Beta Ltd', ownerEmail: 'b@b.test', ownerPassword: 'Correct-Horse-9', fiscalYear: 2026 }));
  return {
    db,
    A: new Repo(db, a.tenant.id, { user: { id: a.ownerId } }),
    B: new Repo(db, b.tenant.id, { user: { id: b.ownerId } }),
    a, b,
  };
}

test('one tenant cannot read or write another tenant\'s records', () => {
  const { db, A, B } = twoTenants();
  const alphaCustomer = transaction(db, () => entities.createCustomer(A, { name: 'Alpha Customer' }));
  const betaCustomer = transaction(db, () => entities.createCustomer(B, { name: 'Beta Customer' }));

  assert.equal(A.get('customer', alphaCustomer.id).name, 'Alpha Customer');
  assert.equal(A.get('customer', betaCustomer.id), null, 'must not see the other tenant by id');
  assert.equal(B.get('customer', alphaCustomer.id), null);

  assert.equal(A.find('customer').length, 1);
  assert.equal(B.find('customer').length, 1);

  // Cross-tenant update is a no-op, not a silent write.
  assert.equal(A.update('customer', betaCustomer.id, { name: 'Hijacked' }), 0);
  assert.equal(B.get('customer', betaCustomer.id).name, 'Beta Customer');
  assert.equal(A.remove('customer', betaCustomer.id), 0);
});

test('the bulk-lookup helpers stay inside the tenant boundary too', () => {
  // resolveRecords/resolveTaxRates are unreferenced today (an N+1 fix nobody
  // has wired in yet), but their SQL was missing the tenant_id predicate
  // every other lookup here has -- a landmine for whoever reaches for them
  // first, since the surrounding table names alone would already make db.mjs
  // refuse to run them at all.
  const { db, A, B } = twoTenants();
  const alphaCustomer = transaction(db, () => entities.createCustomer(A, { name: 'Alpha Customer' }));
  const betaCustomer = transaction(db, () => entities.createCustomer(B, { name: 'Beta Customer' }));
  transaction(db, () => A.exec("INSERT INTO tax_code (tenant_id, code, name, rate, country, active) VALUES (:t,'STD','Standard',20,'US',1)"));
  transaction(db, () => B.exec("INSERT INTO tax_code (tenant_id, code, name, rate, country, active) VALUES (:t,'STD','Beta rate',99,'US',1)"));

  const found = records.resolveRecords(A, 'customer', [alphaCustomer.id, betaCustomer.id]);
  assert.equal(found.size, 1, 'must not resolve the other tenant\'s id');
  assert.equal(found.get(alphaCustomer.id).name, 'Alpha Customer');

  const rates = records.resolveTaxRates(A, ['STD']);
  assert.equal(rates.get('STD').rate, 20, 'must read this tenant\'s own rate for a shared code, not the other tenant\'s');
});

test('search results never cross the tenant boundary', () => {
  const { db, A, B } = twoTenants();
  transaction(db, () => entities.createCustomer(A, { name: 'Zenith Industries' }));
  transaction(db, () => entities.createCustomer(B, { name: 'Zenith Industries' }));

  const fromA = platform.runSearch(A, 'customer', { filters: [{ field: 'name', op: 'contains', value: 'Zenith' }] });
  assert.equal(fromA.total, 1);
  assert.equal(fromA.rows[0].id, A.find('customer')[0].id);
});

test('raw SQL touching a tenant table without :t is refused', () => {
  const f = freshTenant();
  const scopeError = (e) => e.code === 'TENANT_SCOPE_MISSING';
  assert.throws(() => f.repo.query('SELECT * FROM customer'), scopeError);
  assert.throws(() => f.repo.query('SELECT c.* FROM customer c JOIN txn t ON t.id = c.id'), scopeError);
  // With the marker it is allowed.
  assert.doesNotThrow(() => f.repo.query('SELECT * FROM customer WHERE tenant_id = :t'));
});

test('bindTenant interleaves the tenant parameter with caller placeholders', () => {
  const out = bindTenant('SELECT * FROM x WHERE a = ? AND tenant_id = :t AND b = ?', 'T1', ['A', 'B']);
  assert.equal(out.sql, 'SELECT * FROM x WHERE a = ? AND tenant_id = ? AND b = ?');
  assert.deepEqual(out.params, ['A', 'T1', 'B']);
});

test('a `:t` inside a string literal is left alone', () => {
  const out = bindTenant("SELECT ':t' AS lit WHERE tenant_id = :t", 'T1', []);
  assert.equal(out.sql, "SELECT ':t' AS lit WHERE tenant_id = ?");
  assert.deepEqual(out.params, ['T1']);
});

test('an unknown table is rejected by the repository', () => {
  const f = freshTenant();
  assert.throws(() => f.repo.find('sqlite_master'), /Unknown or non-tenant table/);
  assert.throws(() => f.repo.insert('schema_migration', {}), /Unknown or non-tenant table/);
});

test('filter and sort columns are validated, not interpolated', () => {
  const f = freshTenant();
  assert.throws(() => f.repo.find('customer', { where: { 'name; DROP TABLE customer': 'x' } }), /Illegal column/);
  assert.throws(() => f.repo.find('customer', { order: 'name); DELETE FROM customer --' }), /Illegal sort column/);
  assert.throws(() => f.repo.find('customer', { columns: ['name', '1=1'] }), /Illegal column/);
  assert.throws(() => platform.runSearch(f.repo, 'customer', { filters: [{ field: 'nope', op: 'eq', value: 1 }] }), /not a field/);
  assert.throws(() => platform.runSearch(f.repo, 'customer', { sort: 'name; DROP TABLE customer' }), /not a field/);
});

test('every tenant-scoped table is declared', () => {
  const f = freshTenant();
  const tables = f.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  const withTenantCol = tables.filter((t) => {
    const cols = f.db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    return cols.includes('tenant_id');
  });
  for (const t of withTenantCol) {
    assert.ok(TENANT_TABLES.has(t), `table "${t}" has tenant_id but is missing from TENANT_TABLES`);
  }
});

test('role permissions gate access by level', () => {
  const f = freshTenant();
  const access = rbac.loadAccess(f.db, f.tenant.id, f.ownerId);
  assert.ok(access.isOwner);
  assert.ok(rbac.can(access, 'journal_entry', rbac.LEVEL.FULL));

  // A sales rep sees their pipeline but not the ledger.
  const repId = f.tx(() => {
    const id = f.repo.insert('app_user', {
      email: 'rep@test.local', name: 'Rep', status: 'active', is_owner: 0,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    f.repo.exec('INSERT INTO user_role (tenant_id, user_id, role_id) VALUES (:t,?,?)', [id, f.roleIds['Sales Rep']]);
    return id;
  });
  const repAccess = rbac.loadAccess(f.db, f.tenant.id, repId);
  assert.equal(repAccess.isOwner, false);
  assert.ok(rbac.can(repAccess, 'opportunity', rbac.LEVEL.EDIT));
  assert.ok(!rbac.can(repAccess, 'journal_entry', rbac.LEVEL.VIEW));
  assert.ok(!rbac.can(repAccess, 'employee', rbac.LEVEL.VIEW));
  assert.throws(() => rbac.require$(repAccess, 'journal_entry', rbac.LEVEL.VIEW), /does not have/);
});

test('row-level "own records only" produces a SQL predicate', () => {
  const f = freshTenant();
  const access = {
    isOwner: false, user: { id: 'U1' }, permissions: { customer: 4 },
    restrictions: { owner: { allowed: null, ownOnly: true } },
  };
  const filter = rbac.rowFilter(access, 'customer');
  assert.match(filter.sql, /owner_id = \?/);
  assert.deepEqual(filter.params, ['U1']);
  assert.equal(rbac.canSeeRow(access, 'customer', { owner_id: 'U1' }), true);
  assert.equal(rbac.canSeeRow(access, 'customer', { owner_id: 'U2' }), false);
});

test('subsidiary restriction scopes assigned rows but keeps shared ones', () => {
  const access = {
    isOwner: false, user: { id: 'U1' }, permissions: { txn: 4 },
    restrictions: { subsidiary: { allowed: new Set(['S1']), ownOnly: false } },
  };
  const filter = rbac.rowFilter(access, 'txn', { alias: 't' });
  assert.match(filter.sql, /t\.subsidiary_id IN \(\?\)/);
  assert.equal(rbac.canSeeRow(access, 'txn', { subsidiary_id: 'S1' }), true);
  assert.equal(rbac.canSeeRow(access, 'txn', { subsidiary_id: 'S2' }), false);
  assert.equal(rbac.canSeeRow(access, 'txn', { subsidiary_id: null }), true, 'shared rows stay visible');
});

// time_entry/time_off carry no owner_id/assigned_to/created_by column, only
// employee_id -- canSeeRow used to only ever look at those three columns, so
// its own-only check always fell through to "visible" for these two tables
// no matter whose record it was, even though the list view's SQL filter
// correctly scoped to the caller's own employee_id. A row that the SQL
// filter would exclude must also fail the single-row check, and vice versa.
test('own-only restriction agrees between the SQL filter and the single-row check for employee-owned tables', () => {
  const access = {
    isOwner: false, user: { id: 'U1', employee_id: 'E1' }, permissions: { time_entry: 4, time_off: 4 },
    restrictions: { owner: { allowed: null, ownOnly: true } },
  };
  for (const table of ['time_entry', 'time_off']) {
    const filter = rbac.rowFilter(access, table, { alias: 't' });
    assert.match(filter.sql, /t\.employee_id = \?/, `${table} filters by employee_id`);
    assert.deepEqual(filter.params, ['E1']);
    assert.equal(rbac.canSeeRow(access, table, { employee_id: 'E1' }), true, `${table}: own record stays visible`);
    assert.equal(rbac.canSeeRow(access, table, { employee_id: 'E2' }), false, `${table}: someone else's record must be denied`);
  }

  // No linked employee record at all: nothing is "mine", so the filter must
  // exclude everything rather than silently allowing the whole table through.
  const unlinked = { isOwner: false, user: { id: 'U2' }, permissions: { time_entry: 4 }, restrictions: { owner: { allowed: null, ownOnly: true } } };
  assert.match(rbac.rowFilter(unlinked, 'time_entry').sql, /0=1/);
  assert.equal(rbac.canSeeRow(unlinked, 'time_entry', { employee_id: 'E1' }), false);
});

// The dimension-restriction allowlist inside rowFilter used to be a hand
// maintained list of ~12 tables; `project` carries subsidiary_id and
// department_id but was never added to it, so a subsidiary restriction
// silently produced no SQL predicate for it while canSeeRow (which reads
// columns off the row directly, not a list) correctly enforced the same
// restriction on a single fetch. Passing `db` makes rowFilter ask the real
// schema instead.
test('dimension restrictions apply to any table that actually has the column, not just a hand-maintained list', () => {
  const f = freshTenant();
  const access = {
    isOwner: false, user: { id: 'U1' }, permissions: { project: 4 },
    restrictions: { subsidiary: { allowed: new Set(['S1']), ownOnly: false } },
  };
  const withoutDb = rbac.rowFilter(access, 'project', { alias: 'r' });
  assert.equal(withoutDb.sql, '', 'without a schema handle, project was never in the fallback allowlist either');

  const withDb = rbac.rowFilter(access, 'project', { alias: 'r', db: f.db });
  assert.match(withDb.sql, /r\.subsidiary_id IN \(\?\)/, 'with the real schema, the restriction is enforced');
  assert.deepEqual(withDb.params, ['S1']);

  assert.equal(rbac.canSeeRow(access, 'project', { subsidiary_id: 'S1' }), true);
  assert.equal(rbac.canSeeRow(access, 'project', { subsidiary_id: 'S2' }), false, 'canSeeRow already enforced this; the SQL filter must match it');
});

// A column whose name is in JSON_COLUMNS is decoded as JSON in EVERY table,
// because the decoder matches on the name alone. Give a plain enum column one
// of those names somewhere else and its values silently come back as `{}` —
// which is exactly how `allocation_schedule.basis` broke once. A JSON column
// declares a JSON default, so the schema itself can be asked.
test('no plain column shares a name with a JSON column', () => {
  const f = freshTenant();
  const tables = f.db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  const offenders = [];
  for (const { name: table } of tables) {
    for (const col of f.db.prepare(`PRAGMA table_info(${table})`).all()) {
      if (!JSON_COLUMNS.has(col.name)) continue;
      if (col.dflt_value === null) continue;
      const dflt = String(col.dflt_value).replace(/^'|'$/g, '');
      if (dflt === '') continue;
      try { JSON.parse(dflt); } catch { offenders.push(`${table}.${col.name} defaults to ${col.dflt_value}`); }
    }
  }
  assert.deepEqual(offenders, [], 'these columns are decoded as JSON but are not JSON');
});

// An id reaches `get()` straight from a request body on dozens of paths, so it
// can be any shape a JSON document can hold. SQLite refuses to bind an object
// and throws a driver-level TypeError, which reaches the client as a 500 for
// what is only ever a record that is not there. This was a real 500 on
// POST /subscriptions/bill with `{"id": {}}`.
test('an id of the wrong shape is a miss, not a crash', () => {
  const f = freshTenant();
  for (const bad of [{}, [], true, false, NaN, Infinity, -Infinity, () => {}, Symbol('x')]) {
    assert.equal(f.repo.get('customer', bad), null, `${String(bad)} should be a miss`);
  }
  // A real id still works, and a string that simply is not there still misses.
  assert.equal(f.repo.get('customer', 'nope'), null);
});
