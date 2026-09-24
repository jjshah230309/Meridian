// Attachments: a file on any record or transaction. HTTP-level tests since
// the interesting bugs here are at the boundary -- base64 in, real bytes
// out, permission and record_type/record_id spoofing, and the raw-BLOB path
// through core/db.mjs's Repo that migration 035 exercises for the first
// time in this codebase.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { openDatabase, migrate, transaction } from '../src/core/db.mjs';
import { createServer } from '../src/server.mjs';
import { provisionTenant } from '../src/modules/setup.mjs';
import { loadServerSecret } from '../src/core/auth.mjs';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
let server, base, db, dataDir;
const PASSWORD = 'Correct-Horse-9';

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-attach-'));
  db = openDatabase(':memory:');
  migrate(db, path.join(ROOT, 'migrations'));
  transaction(db, () => provisionTenant(db, {
    name: 'Attachments Co', ownerEmail: 'owner@test.local', ownerPassword: PASSWORD, fiscalYear: 2026,
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

function client() {
  let cookie = null; let csrf = null;
  return {
    async call(method, urlPath, body, extraHeaders = {}) {
      const headers = { Accept: 'application/json', ...extraHeaders };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
      const res = await fetch(base + urlPath, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const buf = Buffer.from(await res.arrayBuffer());
      let json = null;
      try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
      return { status: res.status, body: json, buf, headers: res.headers };
    },
    async login(email = 'owner@test.local', password = PASSWORD, tenant = undefined) {
      // With no `tenant`, login resolves to the very first tenant ever
      // created -- fine for every other test here, but the tenant-isolation
      // test below logs into a *second* tenant, which needs it named explicitly.
      const r = await this.call('POST', '/api/v1/auth/login', { email, password, tenant });
      if (r.body?.csrf) csrf = r.body.csrf;
      return r;
    },
  };
}

test('upload, list and download round-trip exact bytes', async () => {
  const c = client();
  await c.login();
  const customer = (await c.call('POST', '/api/v1/records/customer', { name: 'Attach Co', terms: 'NET30' })).body;

  const original = crypto.randomBytes(4096); // binary, not text -- proves the BLOB path, not a string coincidence
  const created = await c.call('POST', '/api/v1/attachments', {
    record_type: 'customer', record_id: customer.id,
    filename: 'contract.pdf', content_type: 'application/pdf', data: original.toString('base64'),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.filename, 'contract.pdf');
  assert.equal(created.body.size, original.length);

  const list = await c.call('GET', `/api/v1/attachments?record_type=customer&record_id=${customer.id}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.rows.length, 1);
  assert.equal(list.body.rows[0].id, created.body.id);
  assert.equal(list.body.rows[0].bytes, undefined, 'the list must not carry the bytes down the wire');

  const dl = await c.call('GET', `/api/v1/attachments/${created.body.id}`);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/pdf');
  assert.ok(dl.headers.get('content-disposition').includes('contract.pdf'));
  assert.ok(original.equals(dl.buf), 'downloaded bytes must match exactly what was uploaded');
});

test('a filename with a quote and non-ASCII characters does not break the download', async () => {
  const c = client();
  await c.login();
  const customer = (await c.call('POST', '/api/v1/records/customer', { name: 'Quote Co', terms: 'NET30' })).body;
  const created = await c.call('POST', '/api/v1/attachments', {
    record_type: 'customer', record_id: customer.id,
    filename: 'résumé "final".pdf', data: Buffer.from('hi').toString('base64'),
  });
  assert.equal(created.status, 201);
  const dl = await c.call('GET', `/api/v1/attachments/${created.body.id}`);
  assert.equal(dl.status, 200);
  const cd = dl.headers.get('content-disposition');
  assert.ok(!/[\r\n]/.test(cd));
  assert.ok(cd.includes("filename*=UTF-8''"));
});

test('deleting an attachment removes it and is audited', async () => {
  const c = client();
  await c.login();
  const customer = (await c.call('POST', '/api/v1/records/customer', { name: 'Delete Co', terms: 'NET30' })).body;
  const created = await c.call('POST', '/api/v1/attachments', {
    record_type: 'customer', record_id: customer.id, filename: 'x.txt', data: Buffer.from('x').toString('base64'),
  });
  const del = await c.call('DELETE', `/api/v1/attachments/${created.body.id}`);
  assert.equal(del.status, 200);
  const dl = await c.call('GET', `/api/v1/attachments/${created.body.id}`);
  assert.equal(dl.status, 404);

  const audit = await c.call('GET', `/api/v1/records/customer/${customer.id}`);
  const actions = audit.body.audit.map((a) => a.action);
  assert.ok(actions.includes('attach'));
  assert.ok(actions.includes('detach'));
});

test('uploading needs EDIT on the parent type; listing and downloading only need VIEW', async () => {
  const c = client();
  await c.login();
  const customer = (await c.call('POST', '/api/v1/records/customer', { name: 'Perm Co', terms: 'NET30' })).body;
  const created = await c.call('POST', '/api/v1/attachments', {
    record_type: 'customer', record_id: customer.id, filename: 'x.txt', data: Buffer.from('x').toString('base64'),
  });

  const roles = (await c.call('GET', '/api/v1/setup/roles')).body.roles;
  const warehouse = roles.find((r) => r.name === 'Warehouse');
  // View-only on customer: can see it and its attachments, cannot change either.
  await c.call('PUT', `/api/v1/setup/roles/${warehouse.id}/permissions`, { permissions: { customer: 1 } });
  await c.call('POST', '/api/v1/setup/users', {
    name: 'Viewer', email: 'viewer@test.local', password: PASSWORD, role_ids: [warehouse.id],
  });

  const v = client();
  await v.login('viewer@test.local', PASSWORD);

  const list = await v.call('GET', `/api/v1/attachments?record_type=customer&record_id=${customer.id}`);
  assert.equal(list.status, 200, 'VIEW is enough to list');

  const dl = await v.call('GET', `/api/v1/attachments/${created.body.id}`);
  assert.equal(dl.status, 200, 'VIEW is enough to download');

  const upload = await v.call('POST', '/api/v1/attachments', {
    record_type: 'customer', record_id: customer.id, filename: 'y.txt', data: Buffer.from('y').toString('base64'),
  });
  assert.equal(upload.status, 403, 'VIEW is not enough to upload');

  const del = await v.call('DELETE', `/api/v1/attachments/${created.body.id}`);
  assert.equal(del.status, 403, 'VIEW is not enough to delete');
});

test('a record_id that does not belong to the claimed record_type is refused, not silently attached', async () => {
  const c = client();
  await c.login();
  const customer = (await c.call('POST', '/api/v1/records/customer', { name: 'Spoof Co', terms: 'NET30' })).body;
  const item = (await c.call('POST', '/api/v1/records/item', {
    sku: 'SPOOF-1', name: 'Spoof Item', type: 'inventory', base_price: 10,
  })).body;

  // The row is real, but under a different record_type than claimed --
  // sharing an id namespace with 'customer' must not be enough.
  const upload = await c.call('POST', '/api/v1/attachments', {
    record_type: 'customer', record_id: item.id, filename: 'x.txt', data: Buffer.from('x').toString('base64'),
  });
  assert.equal(upload.status, 404);

  const bogus = await c.call('POST', '/api/v1/attachments', {
    record_type: 'customer', record_id: 'not-a-real-id', filename: 'x.txt', data: Buffer.from('x').toString('base64'),
  });
  assert.equal(bogus.status, 404);
});

test('one transaction type sharing the txn table with another cannot be spoofed either', async () => {
  const c = client();
  await c.login();
  const item = (await c.call('POST', '/api/v1/records/item', {
    sku: 'TXN-SPOOF', name: 'Spoof Widget', type: 'inventory', base_price: 10, purchase_price: 5,
  })).body;
  const customer = (await c.call('POST', '/api/v1/records/customer', { name: 'TxnSpoof Co', terms: 'NET30' })).body;
  const invoice = (await c.call('POST', '/api/v1/records/invoice', {
    entity_id: customer.id, txn_date: '2026-06-01', lines: [{ item_id: item.id, quantity: 1, rate: 10 }],
  })).body;

  // invoice.id is a real row in `txn`, but its type is INVOICE, not QUOTE --
  // claiming quote must not resolve to it.
  const upload = await c.call('POST', '/api/v1/attachments', {
    record_type: 'quote', record_id: invoice.id, filename: 'x.txt', data: Buffer.from('x').toString('base64'),
  });
  assert.equal(upload.status, 404);

  // The real type works.
  const ok = await c.call('POST', '/api/v1/attachments', {
    record_type: 'invoice', record_id: invoice.id, filename: 'x.txt', data: Buffer.from('x').toString('base64'),
  });
  assert.equal(ok.status, 201);
});

test('a file over the size cap is refused', async () => {
  const c = client();
  await c.login();
  const customer = (await c.call('POST', '/api/v1/records/customer', { name: 'Big Co', terms: 'NET30' })).body;
  const { MAX_SIZE } = await import('../src/modules/attachments.mjs');
  const oversized = Buffer.alloc(MAX_SIZE + 1024, 'x'); // a real round trip, not a mocked boundary check
  const upload = await c.call('POST', '/api/v1/attachments', {
    record_type: 'customer', record_id: customer.id, filename: 'huge.bin', data: oversized.toString('base64'),
  });
  assert.equal(upload.status, 422);
});

test('an empty upload is refused', async () => {
  const c = client();
  await c.login();
  const customer = (await c.call('POST', '/api/v1/records/customer', { name: 'Empty Co', terms: 'NET30' })).body;
  const upload = await c.call('POST', '/api/v1/attachments', {
    record_type: 'customer', record_id: customer.id, filename: 'empty.txt', data: '',
  });
  assert.equal(upload.status, 400);
});

test('attachments are tenant-isolated', async () => {
  const c = client();
  await c.login();
  const customer = (await c.call('POST', '/api/v1/records/customer', { name: 'Iso Co', terms: 'NET30' })).body;
  const created = await c.call('POST', '/api/v1/attachments', {
    record_type: 'customer', record_id: customer.id, filename: 'secret.txt', data: Buffer.from('secret').toString('base64'),
  });

  // A second, entirely separate tenant on the same database.
  const secondTenant = transaction(db, () => provisionTenant(db, {
    name: 'Other Co', ownerEmail: 'other-owner@test.local', ownerPassword: PASSWORD, fiscalYear: 2026,
  }));
  const other = client();
  await other.login('other-owner@test.local', PASSWORD, secondTenant.tenant.id);
  const dl = await other.call('GET', `/api/v1/attachments/${created.body.id}`);
  assert.equal(dl.status, 404, 'a row keyed by (tenant_id, id) must not be reachable from another tenant');
});
