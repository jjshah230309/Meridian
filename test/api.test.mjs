// End-to-end HTTP tests against a real server instance: authentication,
// CSRF, permissions and the document lifecycle over the wire.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { openDatabase, migrate, transaction } from '../src/core/db.mjs';
import { createServer } from '../src/server.mjs';
import { provisionTenant } from '../src/modules/setup.mjs';
import { loadServerSecret } from '../src/core/auth.mjs';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
let server, base, db, dataDir;
const PASSWORD = 'Correct-Horse-9';

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-test-'));
  db = openDatabase(':memory:');
  migrate(db, path.join(ROOT, 'migrations'));
  transaction(db, () => provisionTenant(db, {
    name: 'API Test Co', ownerEmail: 'owner@test.local', ownerPassword: PASSWORD, fiscalYear: 2026,
  }));
  const config = {
    version: 'test', dataDir, webDir: path.join(ROOT, 'src/web'),
    migrationsDir: path.join(ROOT, 'migrations'), dev: false, trustProxy: false,
    secret: loadServerSecret(dataDir),
  };
  server = createServer(config, db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  try { db.close(); } catch { /* already closed */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

// --- a tiny cookie-aware client
function client() {
  let cookie = null; let csrf = null;
  return {
    get csrf() { return csrf; },
    async call(method, urlPath, body, extraHeaders = {}) {
      const headers = { Accept: 'application/json', ...extraHeaders };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      if (csrf && method !== 'GET' && !('X-CSRF-Token' in extraHeaders)) headers['X-CSRF-Token'] = csrf;
      const res = await fetch(base + urlPath, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, body: json, text, headers: res.headers };
    },
    async login(email = 'owner@test.local', password = PASSWORD) {
      const r = await this.call('POST', '/api/v1/auth/login', { email, password });
      if (r.body?.csrf) csrf = r.body.csrf;
      return r;
    },
  };
}

test('health is public', async () => {
  const c = client();
  const r = await c.call('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('protected routes require authentication', async () => {
  const c = client();
  for (const p of ['/api/v1/meta', '/api/v1/records/customer', '/api/v1/reports/dashboard']) {
    const r = await c.call('GET', p);
    assert.equal(r.status, 401, `${p} must require a session`);
  }
});

test('bad credentials are rejected with a neutral message', async () => {
  const c = client();
  const r = await c.call('POST', '/api/v1/auth/login', { email: 'owner@test.local', password: 'wrong-password' });
  assert.equal(r.status, 401);
  assert.match(r.body.error.message, /do not match/);
  const unknown = await c.call('POST', '/api/v1/auth/login', { email: 'nobody@test.local', password: 'whatever123' });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.error.message, r.body.error.message, 'must not reveal whether the account exists');
});

test('login establishes a session and returns permissions', async () => {
  const c = client();
  const r = await c.login();
  assert.equal(r.status, 200);
  assert.equal(r.body.user.email, 'owner@test.local');
  assert.ok(r.body.csrf, 'a CSRF token is issued');
  assert.ok(r.body.permissions.journal_entry >= 4);
  assert.match(r.headers.get('set-cookie'), /HttpOnly/);
  assert.match(r.headers.get('set-cookie'), /SameSite=Strict/);
});

test('a state-changing request without the CSRF token is refused', async () => {
  const c = client();
  await c.login();
  const r = await c.call('POST', '/api/v1/records/customer', { name: 'CSRF Test' }, { 'X-CSRF-Token': '' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'CSRF_FAILED');
});

test('a cross-origin write is refused even with a valid token', async () => {
  const c = client();
  await c.login();
  const r = await c.call('POST', '/api/v1/records/customer', { name: 'Evil' }, { Origin: 'http://evil.example' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'BAD_ORIGIN');
});

test('security headers are present on every response', async () => {
  const c = client();
  const r = await c.call('GET', '/health');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('metadata describes the records this role can see', async () => {
  const c = client();
  await c.login();
  const r = await c.call('GET', '/api/v1/meta');
  assert.equal(r.status, 200);
  assert.ok(Object.keys(r.body.records).length > 30);
  assert.ok(r.body.records.invoice.isTransaction);
  assert.equal(r.body.scripts_enabled, false);
  assert.ok(Array.isArray(r.body.currencies));
});

test('a record can be created, read, listed, updated and deactivated', async () => {
  const c = client();
  await c.login();

  const created = await c.call('POST', '/api/v1/records/customer', {
    name: 'Wayne Enterprises', email: 'ap@wayne.test', terms: 'NET45',
  });
  assert.equal(created.status, 200);
  const id = created.body.id;
  assert.ok(id);

  const read = await c.call('GET', `/api/v1/records/customer/${id}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.record.name, 'Wayne Enterprises');
  assert.ok(read.body.related.financials, 'related data is included');

  const list = await c.call('GET', '/api/v1/records/customer?q=Wayne');
  assert.equal(list.body.total, 1);

  const patched = await c.call('PATCH', `/api/v1/records/customer/${id}`, { terms: 'NET60' });
  assert.equal(patched.body.terms, 'NET60');

  const removed = await c.call('DELETE', `/api/v1/records/customer/${id}`);
  assert.equal(removed.status, 200);
  assert.ok(removed.body.deactivated, 'entities are deactivated, never destroyed');
});

test('validation errors identify the offending field', async () => {
  const c = client();
  await c.login();
  const r = await c.call('POST', '/api/v1/records/customer', { email: 'not-an-email' });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'VALIDATION_FAILED');
  assert.ok(r.body.error.fields.name || r.body.error.fields.email);
});

test('the full order-to-cash flow works over HTTP', async () => {
  const c = client();
  await c.login();

  const customer = (await c.call('POST', '/api/v1/records/customer', { name: 'Stark Industries', terms: 'NET30' })).body;
  const vendor = (await c.call('POST', '/api/v1/records/vendor', { name: 'Parts Co' })).body;
  const item = (await c.call('POST', '/api/v1/records/item', {
    sku: 'API-1', name: 'Gadget', type: 'inventory', base_price: 200, purchase_price: 80,
  })).body;
  const location = (await c.call('GET', '/api/v1/meta')).body.locations[0];

  const po = (await c.call('POST', '/api/v1/records/purchase_order', {
    entity_id: vendor.id, txn_date: '2026-06-01', location_id: location.id,
    lines: [{ item_id: item.id, quantity: 40, unit_price: 80 }],
  })).body;
  assert.equal(po.status, 'open');

  const receipt = (await c.call('POST', `/api/v1/txn/${po.id}/transform/ITEM_RECEIPT`, { txn_date: '2026-06-05' })).body;
  assert.equal(receipt.posted, 1);

  const avail = (await c.call('GET', `/api/v1/inventory/availability/${item.id}`)).body;
  assert.equal(avail.total_on_hand, 40_000_000);

  const so = (await c.call('POST', '/api/v1/records/sales_order', {
    entity_id: customer.id, txn_date: '2026-06-10', location_id: location.id,
    lines: [{ item_id: item.id, quantity: 5 }],
  })).body;
  assert.equal(so.total, 100000, '5 x $200 in minor units');

  const preview = (await c.call('GET', `/api/v1/txn/${so.id}/transform/FULFILLMENT`)).body;
  assert.equal(preview.lines.length, 1);
  assert.equal(preview.lines[0].quantity, 5_000_000);

  await c.call('POST', `/api/v1/txn/${so.id}/transform/FULFILLMENT`, { txn_date: '2026-06-11' });
  const invoice = (await c.call('POST', `/api/v1/txn/${so.id}/transform/INVOICE`, { txn_date: '2026-06-12' })).body;
  assert.equal(invoice.total, 100000);

  const payment = (await c.call('POST', '/api/v1/payments', {
    type: 'CUSTOMER_PAYMENT', entity_id: customer.id, txn_date: '2026-06-20', amount: 1000,
    applications: [{ txn_id: invoice.id, amount: 1000 }],
  })).body;
  assert.equal(payment.posted, 1);

  const settled = (await c.call('GET', `/api/v1/txn/${invoice.id}`)).body;
  assert.equal(settled.status, 'paid');
  assert.equal(settled.amount_remaining, 0);
  assert.ok(settled.journal, 'the invoice exposes its journal entry');

  const integrity = (await c.call('GET', '/api/v1/reports/integrity')).body;
  assert.ok(integrity.ok, 'the ledger stays consistent through the whole flow');
});

test('a restricted role is refused, with a readable reason', async () => {
  const c = client();
  await c.login();

  const roles = (await c.call('GET', '/api/v1/setup/roles')).body.roles;
  const warehouse = roles.find((r) => r.name === 'Warehouse');
  await c.call('POST', '/api/v1/setup/users', {
    name: 'Wendy Warehouse', email: 'wendy@test.local', password: PASSWORD, role_ids: [warehouse.id],
  });

  const w = client();
  await w.login('wendy@test.local', PASSWORD);
  const denied = await w.call('GET', '/api/v1/records/journal_entry');
  assert.equal(denied.status, 403);
  assert.match(denied.body.error.message, /does not have/i);

  const allowed = await w.call('GET', '/api/v1/records/item');
  assert.equal(allowed.status, 200);

  // The metadata a restricted user receives omits what they cannot see.
  const meta = (await w.call('GET', '/api/v1/meta')).body;
  assert.ok(!meta.records.journal_entry, 'hidden record types are absent from metadata');
  assert.ok(meta.records.item);
});

test('unknown routes and methods return structured errors', async () => {
  const c = client();
  await c.login();
  const missing = await c.call('GET', '/api/v1/nonexistent');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');

  const wrongMethod = await c.call('DELETE', '/api/v1/meta');
  assert.equal(wrongMethod.status, 405);
});

test('CSV export returns a downloadable file', async () => {
  const c = client();
  await c.login();
  await c.call('POST', '/api/v1/records/customer', { name: 'Export Target', email: 'e@x.test' });
  const r = await c.call('GET', '/api/v1/export/customer');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename=/);
  assert.match(r.text, /Number,Name,Email/);
});

test('logout invalidates the session', async () => {
  const c = client();
  await c.login();
  assert.equal((await c.call('GET', '/api/v1/auth/session')).status, 200);
  await c.call('POST', '/api/v1/auth/logout');
  assert.equal((await c.call('GET', '/api/v1/auth/session')).status, 401);
});

test('static assets are served and path traversal is blocked', async () => {
  const c = client();
  const index = await c.call('GET', '/');
  assert.equal(index.status, 200);
  assert.match(index.text, /Meridian ERP/);

  const css = await c.call('GET', '/css/app.css');
  assert.equal(css.status, 200);

  for (const attack of ['/../package.json', '/css/../../package.json', '/%2e%2e/package.json']) {
    const r = await c.call('GET', attack);
    assert.ok(r.status === 403 || r.status === 404 || !r.text.includes('"name": "meridian-erp"'),
      `traversal via ${attack} must not serve project files`);
  }
});

test('every record type in the metadata can actually be listed', async () => {
  // A blanket smoke test: the registry advertises ~39 record types, and each
  // must survive a real list, search, CSV export and detail read. This is the
  // test that catches "works for customers, 500s for workflows".
  const c = client();
  await c.login();
  const meta = (await c.call('GET', '/api/v1/meta')).body;
  const types = Object.keys(meta.records);
  assert.ok(types.length >= 35, `expected the full registry, saw ${types.length}`);

  const failures = [];
  for (const type of types) {
    const list = await c.call('GET', `/api/v1/records/${type}?limit=3`);
    if (list.status !== 200) { failures.push(`${type}: list → ${list.status} ${list.body?.error?.message || ''}`); continue; }

    const search = await c.call('POST', '/api/v1/search', { record_type: type, definition: {}, limit: 3 });
    if (search.status !== 200) { failures.push(`${type}: search → ${search.status} ${search.body?.error?.message || ''}`); continue; }

    const free = await c.call('GET', `/api/v1/records/${type}?q=a&limit=3`);
    if (free.status !== 200) { failures.push(`${type}: free-text → ${free.status} ${free.body?.error?.message || ''}`); continue; }

    const csv = await c.call('GET', `/api/v1/export/${type}`);
    if (csv.status !== 200) { failures.push(`${type}: export → ${csv.status}`); continue; }

    const first = list.body.rows?.[0];
    if (first) {
      const detail = await c.call('GET', `/api/v1/records/${type}/${first.id}`);
      if (detail.status !== 200) failures.push(`${type}: detail → ${detail.status} ${detail.body?.error?.message || ''}`);
    }
  }
  assert.deepEqual(failures, [], `record types failed:\n  ${failures.join('\n  ')}`);
});

test('the metadata registry matches the real schema', async () => {
  // Every declared field must be a real column, and every column a list or
  // sort refers to must be a declared field. Both directions have bitten:
  // a listColumn nobody declared makes an explicit-column search throw, and
  // a declared field with no column makes a create fail at the INSERT.
  const meta = await import('../src/modules/meta.mjs');
  const problems = [];
  for (const type of meta.listRecordTypes()) {
    const m = meta.getMeta(type);
    const columns = new Set(db.prepare(`PRAGMA table_info(${m.table})`).all().map((c) => c.name));
    if (!columns.size) { problems.push(`${type}: table ${m.table} does not exist`); continue; }

    const declared = new Set(m.fields.map((f) => f.name));
    for (const f of m.fields) {
      // Formula fields are computed, and a transaction's lines live elsewhere.
      if (f.type === 'formula' || f.virtual) continue;
      if (!columns.has(f.name)) problems.push(`${type}: field "${f.name}" has no column on ${m.table}`);
    }
    for (const c of m.listColumns || []) {
      if (c === 'id' || c.startsWith('custom.')) continue;
      if (!declared.has(c)) problems.push(`${type}: listColumns has "${c}", which is not a declared field`);
    }
    const sortCol = String(m.defaultSort || '').split(/\s+/)[0];
    if (sortCol && sortCol !== 'id' && !declared.has(sortCol)) {
      problems.push(`${type}: defaultSort uses "${sortCol}", which is not a declared field`);
    }
    for (const f of m.searchFields || []) {
      if (!declared.has(f)) problems.push(`${type}: searchFields has "${f}", which is not a declared field`);
    }
    if (m.title && !declared.has(m.title)) problems.push(`${type}: title field "${m.title}" is not declared`);
  }
  assert.deepEqual(problems, [], `metadata does not match the schema:\n  ${problems.join('\n  ')}`);
});

test('every record type survives a search that names its own columns', async () => {
  // The generic list quietly drops a column it cannot resolve; an explicit
  // column list does not, so this is where a bad listColumns actually breaks.
  const c = client();
  await c.login();
  const meta = (await c.call('GET', '/api/v1/meta')).body;
  const failures = [];
  for (const [type, m] of Object.entries(meta.records)) {
    const res = await c.call('POST', '/api/v1/search',
      { record_type: type, definition: { columns: m.listColumns }, limit: 2 });
    if (res.status !== 200) failures.push(`${type}: ${res.status} ${res.body?.error?.message || ''}`);
  }
  assert.deepEqual(failures, [], `explicit-column searches failed:\n  ${failures.join('\n  ')}`);
});

test('every report endpoint responds', async () => {
  const c = client();
  await c.login();
  const reports = ['dashboard', 'income-statement', 'balance-sheet', 'cash-flow', 'trial-balance',
    'ar-aging', 'ap-aging', 'revenue-trend', 'top-customers', 'top-items', 'integrity'];
  for (const r of reports) {
    const res = await c.call('GET', `/api/v1/reports/${r}`);
    assert.equal(res.status, 200, `/reports/${r} returned ${res.status}: ${res.body?.error?.message || ''}`);
  }
  for (const p of ['/api/v1/crm/pipeline', '/api/v1/crm/forecast', '/api/v1/crm/support/metrics',
    '/api/v1/hr/directory', '/api/v1/hr/orgchart', '/api/v1/bank/accounts',
    '/api/v1/inventory/reorder', '/api/v1/inventory/valuation', '/api/v1/audit',
    '/api/v1/notifications', '/api/v1/saved-searches', '/api/v1/setup/company',
    '/api/v1/setup/roles', '/api/v1/setup/users', '/api/v1/gl/accounts', '/api/v1/gl/periods']) {
    const res = await c.call('GET', p);
    assert.equal(res.status, 200, `${p} returned ${res.status}: ${res.body?.error?.message || ''}`);
  }
});
