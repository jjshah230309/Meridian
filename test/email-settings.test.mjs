// Tenant SMTP settings: stored encrypted on tenant.settings, resolved for
// the outbox drainer, and exposed over HTTP as owner-only with the
// password never read back. Plus one full end-to-end test proving the
// whole chain -- settings -> queue -> drain -> a real socket -- works
// together, not just each piece in isolation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { openDatabase, migrate, transaction } from '../src/core/db.mjs';
import { createServer } from '../src/server.mjs';
import { provisionTenant } from '../src/modules/setup.mjs';
import { loadServerSecret } from '../src/core/auth.mjs';
import { freshTenant } from './helpers.mjs';
import * as setup from '../src/modules/setup.mjs';
import * as outbox from '../src/core/outbox.mjs';
import { ulid, nowIso } from '../src/core/util.mjs';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------- module-level
test('email settings round-trip, and the password is never handed back', () => {
  const f = freshTenant();
  const config = { secret: 'a-fake-server-secret-at-least-32-bytes-long' };

  assert.equal(setup.getEmailSettings(f.repo).has_password, false);

  const saved = setup.setEmailSettings(f.repo, config, {
    host: 'smtp.example.test', port: 587, secure: false,
    username: 'bot@example.test', password: 'hunter2', from_address: 'billing@example.test', from_name: 'Billing',
  });
  assert.equal(saved.has_password, true);
  assert.equal(saved.password, undefined, 'setEmailSettings\'s own return value must not carry the password either');

  const read = setup.getEmailSettings(f.repo);
  assert.equal(read.host, 'smtp.example.test');
  assert.equal(read.has_password, true);
  assert.equal(JSON.stringify(read).includes('hunter2'), false);

  // The truly raw column value, bypassing Repo's own JSON decoding --
  // exactly what a database dump or a bug in some other reader would see --
  // still must not contain the plaintext password.
  const raw = f.db.prepare('SELECT settings FROM tenant WHERE id = ?').get(f.tenant.id);
  assert.equal(raw.settings.includes('hunter2'), false);

  const resolved = setup.resolveEmailSettings(f.repo, config);
  assert.equal(resolved.password, 'hunter2', 'only the drainer\'s own resolver decrypts it');
  assert.equal(resolved.from, 'Billing <billing@example.test>');
});

test('a password left out of the patch is kept, not cleared', () => {
  const f = freshTenant();
  const config = { secret: 'a-fake-server-secret-at-least-32-bytes-long' };
  setup.setEmailSettings(f.repo, config, { host: 'smtp.example.test', username: 'bot@example.test', password: 'hunter2', from_address: 'a@example.test' });
  setup.setEmailSettings(f.repo, config, { host: 'smtp2.example.test' }); // no password field at all
  const resolved = setup.resolveEmailSettings(f.repo, config);
  assert.equal(resolved.password, 'hunter2');
  assert.equal(resolved.host, 'smtp2.example.test');
});

test('clear_password actually clears it', () => {
  const f = freshTenant();
  const config = { secret: 'a-fake-server-secret-at-least-32-bytes-long' };
  setup.setEmailSettings(f.repo, config, { host: 'smtp.example.test', username: 'bot@example.test', password: 'hunter2', from_address: 'a@example.test' });
  setup.setEmailSettings(f.repo, config, { clear_password: true });
  assert.equal(setup.getEmailSettings(f.repo).has_password, false);
  assert.equal(setup.resolveEmailSettings(f.repo, config).password, '');
});

test('resolveEmailSettings is null until a host is configured', () => {
  const f = freshTenant();
  assert.equal(setup.resolveEmailSettings(f.repo, { secret: 'x'.repeat(32) }), null);
});

// ---------------------------------------------------------- HTTP-level
let server, base, db, dataDir;
const PASSWORD = 'Correct-Horse-9';

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-email-settings-'));
  db = openDatabase(':memory:');
  migrate(db, path.join(ROOT, 'migrations'));
  transaction(db, () => provisionTenant(db, {
    name: 'Email Settings Co', ownerEmail: 'owner@test.local', ownerPassword: PASSWORD, fiscalYear: 2026,
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
    async call(method, urlPath, body) {
      const headers = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
      const res = await fetch(base + urlPath, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      let json = null;
      try { json = await res.json(); } catch { /* no body */ }
      return { status: res.status, body: json };
    },
    async login(email = 'owner@test.local', password = PASSWORD) {
      const r = await this.call('POST', '/api/v1/auth/login', { email, password });
      if (r.body?.csrf) csrf = r.body.csrf;
      return r;
    },
  };
}

// These HTTP tests share one server/tenant (see before()/after() above), so
// each one sets the full state it depends on explicitly rather than relying
// on execution order or what an earlier test happened to leave behind --
// "no host configured" runs first for real rather than by coincidence of
// file order, and the fake-SMTP test clears username/password itself so an
// earlier test's saved credentials can't leak into it and trip the
// STARTTLS-required gate against a fake server that offers no AUTH at all.

test('POST .../test without a configured host is refused, not a hang or a 500', async () => {
  const c = client();
  await c.login();
  const test = await c.call('POST', '/api/v1/setup/email-settings/test', { to: 'someone@example.test' });
  assert.equal(test.status, 422);
});

test('GET/PUT /setup/email-settings works and never returns the password', async () => {
  const c = client();
  await c.login();

  const before = await c.call('GET', '/api/v1/setup/email-settings');
  assert.equal(before.status, 200);
  assert.equal(before.body.has_password, false);

  const put = await c.call('PUT', '/api/v1/setup/email-settings', {
    host: 'smtp.example.test', port: 587, username: 'bot@example.test', password: 'hunter2', from_address: 'billing@example.test',
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.has_password, true);
  assert.equal(JSON.stringify(put.body).includes('hunter2'), false);

  const after = await c.call('GET', '/api/v1/setup/email-settings');
  assert.equal(after.body.host, 'smtp.example.test');
  assert.equal(JSON.stringify(after.body).includes('hunter2'), false);
});

test('only the owner can change email settings', async () => {
  const c = client();
  await c.login();
  const roles = (await c.call('GET', '/api/v1/setup/roles')).body.roles;
  const admin = roles.find((r) => r.name === 'Administrator') || roles[0];
  await c.call('PUT', `/api/v1/setup/roles/${admin.id}/permissions`, { permissions: { setup: 4 } });
  await c.call('POST', '/api/v1/setup/users', { name: 'Not Owner', email: 'notowner@test.local', password: PASSWORD, role_ids: [admin.id] });

  const other = client();
  await other.login('notowner@test.local', PASSWORD);
  const put = await other.call('PUT', '/api/v1/setup/email-settings', { host: 'smtp.example.test' });
  assert.equal(put.status, 403);
});

test('POST /setup/email-settings/test sends a real message through a fake SMTP server', async () => {
  const received = [];
  const fake = net.createServer((socket) => {
    socket.on('error', () => {}); // the client destroys its socket once done; that is not a test failure
    socket.write('220 fake.smtp ready\r\n');
    let buf = '', dataBuf = '', inData = false;
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 2);
        if (inData) {
          if (line === '.') { inData = false; received.push(dataBuf); socket.write('250 OK\r\n'); continue; }
          dataBuf += (dataBuf ? '\r\n' : '') + line; continue;
        }
        if (/^EHLO/i.test(line)) socket.write('250 fake.smtp\r\n');
        else if (/^DATA/i.test(line)) { dataBuf = ''; inData = true; socket.write('354 go\r\n'); }
        else socket.write('250 OK\r\n');
      }
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  try {
    const c = client();
    await c.login();
    await c.call('PUT', '/api/v1/setup/email-settings', {
      // Explicitly no username/password: an earlier test in this shared
      // tenant may have saved credentials, and this fake server offers no
      // AUTH at all -- leftover credentials would trip the "refuse to
      // authenticate without STARTTLS" guard in core/smtp.mjs.
      host: '127.0.0.1', port: fake.address().port, from_address: 'billing@example.test',
      username: '', clear_password: true,
    });
    const test = await c.call('POST', '/api/v1/setup/email-settings/test', { to: 'someone@example.test' });
    assert.equal(test.status, 200);
    assert.equal(received.length, 1);
    assert.match(received[0], /Subject: Meridian test email/);
  } finally {
    fake.close();
  }
});

// -------------------------------------------------- end-to-end via outbox
test('a queued email is actually delivered once SMTP settings are configured, through the same path server.mjs uses', async () => {
  const f = freshTenant();
  const config = { secret: 'a-fake-server-secret-at-least-32-bytes-long' };
  setup.setEmailSettings(f.repo, config, { host: '127.0.0.1', port: 0, from_address: 'billing@example.test' });

  const received = [];
  const fake = net.createServer((socket) => {
    socket.on('error', () => {}); // the client destroys its socket once done; that is not a test failure
    socket.write('220 fake.smtp ready\r\n');
    let buf = '', dataBuf = '', inData = false;
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 2);
        if (inData) {
          if (line === '.') { inData = false; received.push(dataBuf); socket.write('250 OK\r\n'); continue; }
          dataBuf += (dataBuf ? '\r\n' : '') + line; continue;
        }
        if (/^EHLO/i.test(line)) socket.write('250 fake.smtp\r\n');
        else if (/^DATA/i.test(line)) { dataBuf = ''; inData = true; socket.write('354 go\r\n'); }
        else socket.write('250 OK\r\n');
      }
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  // Point the just-saved settings at the fake server's real port -- setup
  // above used port 0 as a placeholder since the port is only known now.
  setup.setEmailSettings(f.repo, config, { port: fake.address().port });

  try {
    f.tx(() => f.repo.insert('integration_event', {
      id: ulid(), channel: 'email', event_type: 'test.email', record_type: '', record_id: null,
      payload: { to: 'someone@example.test', subject: 'Hello from the outbox', text: 'body text' },
      status: 'pending', attempts: 0, last_error: '', target_url: '', created_at: nowIso(),
    }));

    // The same closure server.mjs's own drain interval builds -- a Repo
    // for the event's tenant, resolveEmailSettings, then smtp.sendMail.
    const { Repo } = await import('../src/core/db.mjs');
    const smtp = await import('../src/core/smtp.mjs');
    const sendQueuedEmail = async (queueDb, tenantId, payload) => {
      const repo = new Repo(queueDb, tenantId);
      const settings = setup.resolveEmailSettings(repo, config);
      await smtp.sendMail(settings, { from: settings.from, to: payload.to, subject: payload.subject, text: payload.text });
    };

    const result = await outbox.drainOnce(f.db, { secret: config.secret, sendMail: sendQueuedEmail });
    assert.equal(result.delivered, 1);
    assert.equal(received.length, 1);
    assert.match(received[0], /Subject: Hello from the outbox/);
    assert.match(received[0], /body text/);
  } finally {
    fake.close();
  }
});
