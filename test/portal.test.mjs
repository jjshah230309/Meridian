// End-to-end HTTP tests for customer/vendor self-service: invite, accept,
// sign in, and -- the part that actually matters -- that a portal session
// can reach nothing beyond its own entity's documents, and that a portal
// session and a staff session can never be used in the other's place.
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
const PORTAL_PW = 'Portal-Pass-42';

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-portal-test-'));
  db = openDatabase(':memory:');
  migrate(db, path.join(ROOT, 'migrations'));
  transaction(db, () => provisionTenant(db, {
    name: 'Portal Test Co', ownerEmail: 'owner@test.local', ownerPassword: PASSWORD, fiscalYear: 2026,
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

// --- staff client (cookie meridian_sid)
function client() {
  let cookie = null; let csrf = null;
  return {
    async call(method, urlPath, body, extraHeaders = {}) {
      const headers = { Accept: 'application/json', ...extraHeaders };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      if (csrf && method !== 'GET' && !('X-CSRF-Token' in extraHeaders)) headers['X-CSRF-Token'] = csrf;
      const res = await fetch(base + urlPath, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, body: json, text };
    },
    async login(email = 'owner@test.local', password = PASSWORD) {
      const r = await this.call('POST', '/api/v1/auth/login', { email, password });
      if (r.body?.csrf) csrf = r.body.csrf;
      return r;
    },
    setCookie(c) { cookie = c; },
    getCookie() { return cookie; },
  };
}

// --- portal client (cookie meridian_portal_sid), same shape but its own state
function portalClient() {
  let cookie = null; let csrf = null;
  return {
    async call(method, urlPath, body, extraHeaders = {}) {
      const headers = { Accept: 'application/json', ...extraHeaders };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      if (csrf && method !== 'GET' && !('X-CSRF-Token' in extraHeaders)) headers['X-CSRF-Token'] = csrf;
      const res = await fetch(base + urlPath, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      // Any response that hands back a csrf token (login, accept-invite) --
      // not just login -- updates the token this client presents next, the
      // way a real client naturally would.
      if (json?.csrf) csrf = json.csrf;
      return { status: res.status, body: json, text };
    },
    async login(email, password) {
      return this.call('POST', '/api/v1/portal/login', { email, password });
    },
    setCookie(c) { cookie = c; },
    setCsrf(v) { csrf = v; },
    getCookie() { return cookie; },
  };
}

async function inviteCustomer(c, name, email) {
  const customer = (await c.call('POST', '/api/v1/records/customer', { name, terms: 'NET30' })).body;
  const invite = (await c.call('POST', `/api/v1/entities/customer/${customer.id}/portal-invite`, { email })).body;
  const token = new URL(invite.invite_link).searchParams.get('token');
  return { customer, token };
}

test('invite -> accept -> sign in, and the invoice created for that customer is visible in the portal', async () => {
  const c = client();
  await c.login();
  const { customer, token } = await inviteCustomer(c, 'Acme Corp', 'acme-portal@test.local');

  const item = (await c.call('POST', '/api/v1/records/item', { sku: 'PORTAL-1', name: 'Consulting', type: 'service', base_price: 500 })).body;
  const invoice = (await c.call('POST', '/api/v1/records/invoice', {
    entity_id: customer.id, txn_date: '2026-06-01', lines: [{ item_id: item.id, quantity: 1 }],
  })).body;

  const p = portalClient();
  const accepted = await p.call('POST', '/api/v1/portal/accept-invite', { token, password: PORTAL_PW });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.user.email, 'acme-portal@test.local');

  const docs = await p.call('GET', '/api/v1/portal/documents?kind=open');
  assert.equal(docs.status, 200);
  assert.ok(docs.body.documents.some((d) => d.id === invoice.id), 'the invoice created for this customer must be visible');

  // Logging out and back in works too.
  await p.call('POST', '/api/v1/portal/logout');
  const relogin = await p.login('acme-portal@test.local', PORTAL_PW);
  assert.equal(relogin.status, 200);
});

test('a customer cannot reach another customer\'s invoice, and gets a 404 (not a 403) doing it', async () => {
  const c = client();
  await c.login();
  const { customer: a, token: tokenA } = await inviteCustomer(c, 'Customer A', 'a-portal@test.local');
  const { customer: b } = await inviteCustomer(c, 'Customer B', 'b-portal@test.local');
  const item = (await c.call('POST', '/api/v1/records/item', { sku: 'PORTAL-2', name: 'Widget', type: 'service', base_price: 100 })).body;
  const invoiceForB = (await c.call('POST', '/api/v1/records/invoice', {
    entity_id: b.id, txn_date: '2026-06-01', lines: [{ item_id: item.id, quantity: 1 }],
  })).body;
  void a;

  const pa = portalClient();
  await pa.call('POST', '/api/v1/portal/accept-invite', { token: tokenA, password: PORTAL_PW });
  const denied = await pa.call('GET', `/api/v1/portal/documents/${invoiceForB.id}`);
  assert.equal(denied.status, 404, 'existence of another customer\'s document must not be revealed either');
});

test('a vendor portal user sees only its own purchase orders, not a customer\'s invoices or another vendor\'s orders', async () => {
  const c = client();
  await c.login();
  const vendorA = (await c.call('POST', '/api/v1/records/vendor', { name: 'Vendor A' })).body;
  const vendorB = (await c.call('POST', '/api/v1/records/vendor', { name: 'Vendor B' })).body;
  const inviteA = (await c.call('POST', `/api/v1/entities/vendor/${vendorA.id}/portal-invite`, { email: 'vendor-a@test.local' })).body;
  const tokenA = new URL(inviteA.invite_link).searchParams.get('token');
  const item = (await c.call('POST', '/api/v1/records/item', { sku: 'PORTAL-3', name: 'Part', type: 'inventory', base_price: 10, purchase_price: 5 })).body;
  const poA = (await c.call('POST', '/api/v1/records/purchase_order', { entity_id: vendorA.id, txn_date: '2026-06-01', lines: [{ item_id: item.id, quantity: 1, unit_price: 5 }] })).body;
  const poB = (await c.call('POST', '/api/v1/records/purchase_order', { entity_id: vendorB.id, txn_date: '2026-06-01', lines: [{ item_id: item.id, quantity: 1, unit_price: 5 }] })).body;

  const pv = portalClient();
  await pv.call('POST', '/api/v1/portal/accept-invite', { token: tokenA, password: PORTAL_PW });
  const docs = (await pv.call('GET', '/api/v1/portal/documents?kind=open')).body.documents;
  assert.ok(docs.some((d) => d.id === poA.id));
  assert.ok(!docs.some((d) => d.id === poB.id), 'a different vendor\'s order must not appear');

  // A customer-only route must refuse a vendor portal user.
  const statement = await pv.call('GET', '/api/v1/portal/statement');
  assert.equal(statement.status, 404);
});

test('a staff session cannot use a portal route, and a portal session cannot use a staff route', async () => {
  const c = client();
  await c.login();
  const { token } = await inviteCustomer(c, 'Cross Test Co', 'cross-portal@test.local');
  const p = portalClient();
  await p.call('POST', '/api/v1/portal/accept-invite', { token, password: PORTAL_PW });

  // The staff session's cookie (meridian_sid), presented to a portal route:
  // readPortalSession looks it up against portal_session, where it does not
  // exist, so it is exactly as unauthenticated as no cookie at all.
  const staffToPortal = await fetch(`${base}/api/v1/portal/documents`, { headers: { Cookie: c.getCookie() || '' } });
  assert.equal(staffToPortal.status, 401, 'a staff session cookie must not authenticate a portal route');

  // And the reverse: the portal session's cookie against a staff route.
  const portalToStaff = await fetch(`${base}/api/v1/records/customer`, { headers: { Cookie: p.getCookie() || '' } });
  assert.equal(portalToStaff.status, 401, 'a portal session cookie must not authenticate a staff route');
});

test('portal login locks out after repeated bad passwords, same as staff login', async () => {
  const c = client();
  await c.login();
  const { token } = await inviteCustomer(c, 'Lockout Co', 'lockout-portal@test.local');
  const p = portalClient();
  await p.call('POST', '/api/v1/portal/accept-invite', { token, password: PORTAL_PW });
  await p.call('POST', '/api/v1/portal/logout');

  let last;
  for (let i = 0; i < 8; i++) last = await p.call('POST', '/api/v1/portal/login', { email: 'lockout-portal@test.local', password: 'wrong-one' });
  assert.equal(last.status, 422);
  assert.match(last.body.error.message, /Too many attempts/);
  const evenWithRightPassword = await p.call('POST', '/api/v1/portal/login', { email: 'lockout-portal@test.local', password: PORTAL_PW });
  assert.equal(evenWithRightPassword.status, 422);
});

test('revoking portal access blocks a future sign-in', async () => {
  const c = client();
  await c.login();
  const { customer, token } = await inviteCustomer(c, 'Revoke Co', 'revoke-portal@test.local');
  const p = portalClient();
  await p.call('POST', '/api/v1/portal/accept-invite', { token, password: PORTAL_PW });
  await p.call('POST', '/api/v1/portal/logout');

  const users = (await c.call('GET', `/api/v1/entities/customer/${customer.id}/portal-users`)).body.users;
  await c.call('POST', `/api/v1/setup/portal-users/${users[0].id}/revoke`);

  const attempt = await p.call('POST', '/api/v1/portal/login', { email: 'revoke-portal@test.local', password: PORTAL_PW });
  assert.equal(attempt.status, 422);
});
