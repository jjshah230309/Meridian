// First-run setup: the only part of the system a brand-new copy exposes
// before anyone can sign in, so its guard rails matter more than most.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { openDatabase, migrate } from '../src/core/db.mjs';
import { createServer } from '../src/server.mjs';
import { loadServerSecret } from '../src/core/auth.mjs';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
let server, base, db, dataDir;

// Every test starts from a genuinely empty database: that is the state under
// test, and it cannot be shared between cases.
beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-setup-'));
  db = openDatabase(':memory:');
  migrate(db, path.join(ROOT, 'migrations'));
  server = createServer({
    version: 'test', dataDir, webDir: path.join(ROOT, 'src/web'),
    migrationsDir: path.join(ROOT, 'migrations'), dev: false, trustProxy: false,
    secret: loadServerSecret(dataDir),
  }, db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => {
  server?.close();
  try { db.close(); } catch { /* already closed */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

function client() {
  let cookie = null; let csrf = null;
  return {
    async call(method, urlPath, body) {
      const headers = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
      const res = await fetch(base + urlPath, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      if (json?.csrf) csrf = json.csrf;
      return { status: res.status, body: json, text };
    },
  };
}

const GOOD = {
  company_name: 'Larkspur Instruments Ltd',
  full_name: 'Ana Vidal',
  email: 'ana@larkspur.test',
  password: 'Larkspur-Test-2026',
  country: 'GB',
  currency: 'GBP',
  fiscal_year: 2026,
  sample_data: false,
};

test('a fresh copy reports itself unconfigured and offers the choices', async () => {
  const c = client();
  const r = await c.call('GET', '/api/v1/setup/state');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.configured, false);
  assert.ok(r.body.currencies.some((x) => x.code === 'GBP'), 'currencies must be offered');
  assert.ok(r.body.countries.some((x) => x.code === 'AE' && x.currency === 'AED'),
    'countries must carry a currency so the form can follow the choice');
});

test('setup creates a working company with its own currency and administrator', async () => {
  const c = client();
  const made = await c.call('POST', '/api/v1/setup/provision', GOOD);
  assert.equal(made.status, 200, made.text);

  // The account just created must actually be able to sign in.
  const login = await c.call('POST', '/api/v1/auth/login', { email: GOOD.email, password: GOOD.password });
  assert.equal(login.status, 200, login.text);

  const company = await c.call('GET', '/api/v1/setup/company');
  assert.equal(company.status, 200);
  const tenant = company.body.company || company.body.tenant;
  assert.equal(tenant.name, GOOD.company_name);
  assert.equal(tenant.base_currency, 'GBP', 'the chosen currency must be the base currency');

  // A company with no chart of accounts or periods cannot post anything, so
  // "empty" must still mean "ready to use".
  const accounts = await c.call('GET', '/api/v1/records/account?limit=500');
  assert.ok(accounts.body.total >= 40, `expected a full chart of accounts, saw ${accounts.body.total}`);
  const periods = await c.call('GET', '/api/v1/records/accounting_period?limit=500');
  assert.ok(periods.body.total >= 12, `expected accounting periods, saw ${periods.body.total}`);
  const roles = await c.call('GET', '/api/v1/setup/roles');
  assert.ok((roles.body.roles || roles.body).length >= 5, 'expected the default roles');

  // Starting empty means empty.
  for (const type of ['customer', 'vendor', 'item', 'invoice']) {
    const rows = await c.call('GET', `/api/v1/records/${type}?limit=5`);
    assert.equal(rows.body.total, 0, `${type} should be empty when sample data was declined`);
  }
});

test('setup can load sample data into the company it just made', async () => {
  const c = client();
  const made = await c.call('POST', '/api/v1/setup/provision', { ...GOOD, sample_data: true });
  assert.equal(made.status, 200, made.text);
  await c.call('POST', '/api/v1/auth/login', { email: GOOD.email, password: GOOD.password });

  const company = await c.call('GET', '/api/v1/setup/company');
  const tenant = company.body.company || company.body.tenant;
  assert.equal(tenant.name, GOOD.company_name, 'sample data must not rename the company');
  assert.equal(tenant.base_currency, 'GBP', 'sample data must not change the currency');

  const customers = await c.call('GET', '/api/v1/records/customer?limit=5');
  assert.ok(customers.body.total > 10, 'sample data should bring customers');
  const invoices = await c.call('GET', '/api/v1/records/invoice?limit=5');
  assert.ok(invoices.body.total > 10, 'sample data should bring trading history');

  // The sample subsidiary is named after this company, not the demo one.
  const subs = await c.call('GET', '/api/v1/records/subsidiary?limit=20');
  const names = subs.body.rows.map((s) => s.name);
  assert.ok(names.every((n) => !/northwind/i.test(n)), `sample data leaked the demo name: ${names.join(', ')}`);

  // And the books it invented must balance.
  const integrity = await c.call('GET', '/api/v1/reports/integrity');
  assert.equal(integrity.body.ledger_balanced, true);
  assert.deepEqual(integrity.body.unbalanced_entries, []);
});

test('setup refuses a second company, with or without credentials', async () => {
  const c = client();
  assert.equal((await c.call('POST', '/api/v1/setup/provision', GOOD)).status, 200);

  const again = await c.call('POST', '/api/v1/setup/provision',
    { ...GOOD, company_name: 'Somebody Else Ltd', email: 'other@elsewhere.test' });
  assert.equal(again.status, 409, 'a configured copy must not provision again');
  assert.match(again.body.error.message, /already been set up/);

  // Unauthenticated too: this route is public, so the guard is the only thing
  // standing between a stranger and a second company.
  const anon = await fetch(`${base}/api/v1/setup/provision`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...GOOD, company_name: 'Anon Ltd', email: 'anon@elsewhere.test' }),
  });
  assert.equal(anon.status, 409);

  assert.equal((await c.call('GET', '/api/v1/setup/state')).body.configured, true);
});

test('setup rejects input that would produce an unusable company', async () => {
  const c = client();
  const cases = [
    [{ ...GOOD, company_name: '' }, /name/i, 'no company name'],
    [{ ...GOOD, email: 'not-an-email' }, /email/i, 'malformed email'],
    [{ ...GOOD, password: 'short' }, /password/i, 'weak password'],
  ];
  for (const [body, pattern, label] of cases) {
    const r = await c.call('POST', '/api/v1/setup/provision', body);
    assert.ok(r.status === 400 || r.status === 422, `${label} should be rejected, got ${r.status}`);
    assert.match(JSON.stringify(r.body), pattern, `${label}: the error should say which field`);
  }
  // Nothing above may have half-created a company.
  assert.equal((await c.call('GET', '/api/v1/setup/state')).body.configured, false);
});

test('the administrator created by setup really is an administrator', async () => {
  const c = client();
  await c.call('POST', '/api/v1/setup/provision', GOOD);
  const login = await c.call('POST', '/api/v1/auth/login', { email: GOOD.email, password: GOOD.password });
  assert.equal(login.status, 200);

  // Owner-level access: can reach setup, users and the ledger.
  for (const p of ['/api/v1/setup/users', '/api/v1/setup/roles', '/api/v1/gl/accounts',
    '/api/v1/reports/balance-sheet', '/api/v1/records/customer']) {
    assert.equal((await c.call('GET', p)).status, 200, `${p} should be reachable by the owner`);
  }
  // And can actually create something.
  const made = await c.call('POST', '/api/v1/records/customer', { name: 'First Customer' });
  assert.equal(made.status, 200, made.text);
  assert.match(made.body.entity_no, /^C\d+$/, 'a created record should be numbered');
});
