// What "delete" is allowed to mean. A record that has moved money or stock is
// part of the account of what happened, and destroying it leaves the ledger
// describing figures that are no longer in the journal. These tests exist
// because deleting a posted journal entry used to succeed, silently, and take
// the balance rollup out of agreement with the detail.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { openDatabase, migrate, transaction, Repo } from '../src/core/db.mjs';
import { createServer } from '../src/server.mjs';
import { provisionTenant } from '../src/modules/setup.mjs';
import { loadServerSecret, hashPassword } from '../src/core/auth.mjs';
import { ulid, nowIso, Money } from '../src/core/util.mjs';
import * as gl from '../src/modules/gl.mjs';
import * as entities from '../src/modules/entities.mjs';
import * as T from '../src/modules/txn.mjs';
import * as inv from '../src/modules/inventory.mjs';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'Correct-Horse-9';
const DATE = '2026-06-15';
let server, base, db, dataDir, repo, tenantId, ownerId, posting, staffId;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-del-'));
  db = openDatabase(':memory:');
  migrate(db, path.join(ROOT, 'migrations'));
  const prov = transaction(db, () => provisionTenant(db, {
    name: 'Deletion Co', ownerEmail: 'owner@test.local', ownerPassword: PASSWORD, fiscalYear: 2026,
  }));
  tenantId = prov.tenant.id; ownerId = prov.ownerId;
  repo = new Repo(db, tenantId, { user: { id: ownerId, name: 'Owner' } });
  posting = (await import('../src/modules/setup.mjs')).postingAccounts(repo);

  // a second user who is not the owner, so they can be switched off
  const { hash, salt } = hashPassword(PASSWORD);
  staffId = ulid();
  db.prepare(`INSERT INTO app_user (id, tenant_id, email, name, password_hash, password_salt,
      status, is_owner, failed_logins, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(staffId, tenantId, 'staff@test.local', 'Staff', hash, salt, 'active', 0, 0, nowIso(), nowIso());
  const role = db.prepare('SELECT id FROM role WHERE tenant_id = ? LIMIT 1').get(tenantId);
  db.prepare('INSERT INTO user_role (tenant_id, user_id, role_id) VALUES (?,?,?)').run(tenantId, staffId, role.id);

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

function client() {
  let cookie = null; let csrf = null;
  return {
    async call(method, p, body) {
      const headers = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
      const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      const text = await res.text(); let json = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, body: json, text };
    },
    async login(email) {
      const r = await this.call('POST', '/api/v1/auth/login', { email, password: PASSWORD });
      csrf = r.body?.csrf_token ?? r.body?.csrf;
      return r;
    },
  };
}

test('a posted journal entry cannot be deleted, only reversed', async () => {
  const entry = transaction(db, () => gl.postJournal(repo, {
    subsidiary_id: repo.queryOne('SELECT id FROM subsidiary WHERE tenant_id = :t').id,
    txn_date: DATE, memo: 'Capital introduced',
    lines: [
      { account_id: posting.bank, debit: Money.parse(5000) },
      { account_id: posting.retained_earnings, credit: Money.parse(5000) },
    ],
  }));
  const c = client();
  await c.login('owner@test.local');

  const res = await c.call('DELETE', `/api/v1/records/journal_entry/${entry.id}`);
  assert.equal(res.status, 422);
  assert.match(res.body.error.message, /Reverse it instead/);
  assert.ok(repo.get('journal_entry', entry.id), 'the entry is still there');

  const check = gl.integrityCheck(repo);
  assert.ok(check.ok, 'the books are untouched');
  assert.equal(check.rollup_drift.length, 0);
});

test('a record that has posted or moved stock refuses deletion', async () => {
  const customer = transaction(db, () => entities.createCustomer(repo, { name: 'Refusal Ltd' }));
  const item = transaction(db, () => inv.createItem(repo, { sku: 'DEL-1', name: 'Widget', type: 'inventory', base_price: 100 }));
  const location = repo.queryOne('SELECT id FROM location WHERE tenant_id = :t LIMIT 1');
  transaction(db, () => {
    const r = inv.moveStock(repo, {
      item_id: item.id, location_id: location.id, qty_delta: 10_000_000,
      unit_cost: Money.parse(40), type: 'receipt', txn_date: DATE,
    });
    // Book the opening stock so the inventory account and the shelf agree.
    gl.postJournal(repo, {
      subsidiary_id: repo.queryOne('SELECT id FROM subsidiary WHERE tenant_id = :t').id,
      txn_date: DATE, memo: 'Opening stock',
      lines: [
        { account_id: posting.inventory, debit: r.value_delta },
        { account_id: posting.retained_earnings, credit: r.value_delta },
      ],
    });
  });
  const invoice = transaction(db, () => T.createTxn(repo, 'INVOICE', {
    entity_id: customer.id, txn_date: DATE, location_id: location.id,
    lines: [{ item_id: item.id, quantity: 2, unit_price: 100 }],
  }));
  const c = client();
  await c.login('owner@test.local');

  // The customer has history, so it is switched off rather than destroyed.
  const cust = await c.call('DELETE', `/api/v1/records/customer/${customer.id}`);
  assert.equal(cust.status, 200);
  assert.equal(cust.body.deactivated, customer.id);
  assert.equal(repo.get('customer', customer.id).status, 'inactive');

  // And the invoice it raised is still readable.
  assert.ok(repo.get('txn', invoice.id));
  assert.ok(gl.integrityCheck(repo).ok);
});

test('switching a user off ends their session at once', async () => {
  const staff = client();
  const login = await staff.login('staff@test.local');
  assert.equal(login.status, 200);
  assert.equal((await staff.call('GET', '/api/v1/records/customer?limit=1')).status, 200);

  const owner = client();
  await owner.login('owner@test.local');
  const off = await owner.call('DELETE', `/api/v1/records/app_user/${staffId}`);
  assert.equal(off.status, 200, off.text);
  assert.equal(off.body.deactivated, staffId, 'a user is disabled, never deleted');
  assert.equal(repo.get('app_user', staffId).status, 'disabled');

  const after = await staff.call('GET', '/api/v1/records/customer?limit=1');
  assert.equal(after.status, 401, 'the open browser tab stops working immediately');
  assert.equal(repo.scalar('SELECT COUNT(*) c FROM session WHERE tenant_id = :t AND user_id = ?', [staffId], 0), 0,
    'and the session row is gone');
});

test('a disabled user cannot sign back in', async () => {
  const res = await client().login('staff@test.local');
  assert.equal(res.status, 401);
});
