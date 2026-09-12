// Every read endpoint, exercised once against a company with real data in it.
// This is a smoke test, not a contract test: it exists to catch the route that
// nobody opened for a month and that now throws, and to prove no GET can
// return a 500 — a read should answer, or say plainly why it will not.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { openDatabase, migrate, transaction } from '../src/core/db.mjs';
import { createServer } from '../src/server.mjs';
import { buildApi } from '../src/api.mjs';
import { provisionTenant } from '../src/modules/setup.mjs';
import { seedSampleData } from '../src/seed.mjs';
import { loadServerSecret } from '../src/core/auth.mjs';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'Correct-Horse-9';
let server, base, db, dataDir, config, cookie = null, csrf = null;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-routes-'));
  db = openDatabase(':memory:');
  migrate(db, path.join(ROOT, 'migrations'));
  const prov = transaction(db, () => provisionTenant(db, {
    name: 'Route Sweep Co', ownerEmail: 'owner@test.local', ownerPassword: PASSWORD, fiscalYear: 2026,
  }));
  await seedSampleData(db, prov.tenant.id);
  config = {
    version: 'test', dataDir, webDir: path.join(ROOT, 'src/web'),
    migrationsDir: path.join(ROOT, 'migrations'), dev: false, trustProxy: false,
    secret: loadServerSecret(dataDir),
  };
  server = createServer(config, db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email: 'owner@test.local', password: PASSWORD }),
  });
  cookie = res.headers.get('set-cookie')?.split(';')[0] ?? null;
  csrf = (await res.json())?.csrf ?? null;
  assert.ok(cookie, 'the sweep needs a session');
  assert.ok(csrf, 'the sweep needs a CSRF token to write anything');
});

after(() => {
  server?.close();
  try { db.close(); } catch { /* already closed */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** A real id from whichever table the URL prefix is about. */
function idFor(pattern) {
  const byPrefix = {
    'gl/journal': 'journal_entry', 'gl/ledger': 'account', 'hr/timesheet': 'employee',
    'hr/payroll': 'payroll_run', 'bank/reconciliations': 'reconciliation',
    'expense-reports': 'expense_report', 'work-orders': 'work_order', 'import/jobs': 'import_job',
    'service/orders': 'service_order', 'saved-searches': 'saved_search',
  };
  const seg = pattern.split('/')[3] || '';
  const two = pattern.split('/').slice(3, 5).join('/');
  const bySeg = {
    bank: 'bank_account', assets: 'fixed_asset', budgets: 'budget', projects: 'project',
    boms: 'bom', waves: 'pick_wave', campaigns: 'campaign', customers: 'customer',
    vendors: 'vendor', items: 'item', employees: 'employee', accounts: 'account',
    txn: 'txn', transactions: 'txn', opportunities: 'opportunity', leads: 'lead',
    subsidiaries: 'subsidiary', roles: 'role', users: 'app_user', periods: 'accounting_period',
    workflows: 'workflow', dashboards: 'dashboard',
  };
  const table = byPrefix[two] || bySeg[seg];
  if (!table) return null;
  try { return db.prepare(`SELECT id FROM ${table} LIMIT 1`).get()?.id ?? null; } catch { return null; }
}

test('no GET endpoint answers with a server error', async () => {
  const api = buildApi({ config });
  // Bulk data formats and the BI feeds have their own tests; this is the app's
  // own read surface.
  const skip = [/\/export\//, /\/odata/i, /\/soap/i, /\/download/, /logout/];

  const gets = api.routes.filter((r) => r.method === 'GET' && !skip.some((s) => s.test(r.pattern)));
  assert.ok(gets.length > 90, `expected a substantial read surface, found ${gets.length}`);

  const failures = [];
  let checked = 0;
  for (const route of gets) {
    const id = idFor(route.pattern);
    let unresolved = false;
    const urlPath = route.pattern.replace(/:([A-Za-z_]+)/g, () => {
      if (!id) { unresolved = true; return 'x'; }
      return id;
    });
    if (unresolved) continue;                        // nothing seeded to address
    const res = await fetch(base + urlPath, { headers: { Accept: 'application/json', Cookie: cookie } });
    checked++;
    // 400/404/422 are answers: a missing parameter or an id that is not of the
    // expected kind. Anything at 500 or above is the endpoint falling over.
    if (res.status >= 500) failures.push(`${res.status} ${route.pattern} — ${(await res.text()).slice(0, 160)}`);
  }
  assert.equal(failures.length, 0, `\n${failures.join('\n')}`);
  assert.ok(checked > 80, `expected to reach most routes, reached ${checked}`);
});

test('no write endpoint answers with a server error, whatever it is sent', async () => {
  const api = buildApi({ config });
  // Login and logout own the session and would end the sweep; provisioning
  // makes a second company; reset destroys the one under test.
  const skip = [/auth\/login/, /auth\/logout/, /\/reset/, /setup\/provision/];
  const writes = api.routes.filter((r) => r.method !== 'GET' && !skip.some((s) => s.test(r.pattern)));
  assert.ok(writes.length > 60, `expected a substantial write surface, found ${writes.length}`);

  // The shapes a careless client actually sends: nothing, the wrong container,
  // a list where an object belongs, a string where a list belongs, values that
  // are null or of the wrong type, and an id that refers to nothing.
  const bodies = [
    {}, null, 'a string', [],
    { lines: 'not-an-array' },
    { id: null, name: null, amount: null, status: null, lines: null },
    { amount: 'NaN', quantity: -1, txn_date: 'banana' },
    { entity_id: 'nope', item_id: 'nope', location_id: 'nope', account_id: 'nope' },
  ];

  const failures = [];
  for (const route of writes) {
    const id = idFor(route.pattern);
    let unresolved = false;
    const urlPath = route.pattern.replace(/:([A-Za-z_]+)/g, (_, k) => {
      if (k === 'type' || k === 'recordType') return 'customer';
      if (!id) { unresolved = true; return 'x'; }
      return id;
    });
    if (unresolved) continue;
    for (const body of bodies) {
      const res = await fetch(base + urlPath, {
        method: route.method,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf },
        body: JSON.stringify(body),
      });
      if (res.status >= 500) {
        failures.push(`${res.status} ${route.method} ${route.pattern} <- ${JSON.stringify(body).slice(0, 60)} — ${(await res.text()).slice(0, 140)}`);
      }
    }
  }
  assert.equal(failures.length, 0, `\n${failures.join('\n')}`);
});

test('the demo company it swept is internally consistent', async () => {
  const res = await fetch(`${base}/api/v1/reports/integrity`, { headers: { Accept: 'application/json', Cookie: cookie } });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ledger_balanced, true);
  assert.equal(body.rollup_drift.length, 0);
  assert.equal(body.unbalanced_entries.length, 0);
  assert.equal(body.subledgers_tied, true,
    `control accounts adrift: ${JSON.stringify(body.subledgers?.filter((s) => s.difference !== 0))}`);
});
