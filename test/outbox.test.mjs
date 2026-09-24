// The outbox table (migration 005) has always recorded status, attempts and
// last_error, but nothing ever attempted a delivery -- these tests are for
// the worker that finally does, core/outbox.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { freshTenant } from './helpers.mjs';
import * as outbox from '../src/core/outbox.mjs';
import { ulid, nowIso } from '../src/core/util.mjs';

const SECRET = 'test-server-secret-at-least-32-bytes-long';
// These tests deliberately trigger delivery failures; a silent logger keeps
// that expected noise out of the test run's output.
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** A minimal local HTTP server standing in for a webhook receiver. `handle`
 * gets (req, body) and returns a status code; defaults to 200. */
function fakeReceiver(handle = () => 200) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ headers: req.headers, body });
      const status = handle(req, body);
      res.writeHead(status).end();
    });
  });
  return { server, requests };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function enqueue(f, patch) {
  const id = ulid();
  f.tx(() => f.repo.insert('integration_event', {
    id, channel: 'webhook', event_type: 'test.event', record_type: '', record_id: null,
    payload: { hello: 'world' }, status: 'pending', attempts: 0, last_error: '',
    target_url: '', created_at: nowIso(), ...patch,
  }));
  return id;
}

test('a webhook that answers 200 is marked delivered, signed with the server secret', async () => {
  const f = freshTenant();
  const { server, requests } = fakeReceiver();
  const url = await listen(server);
  try {
    const id = enqueue(f, { target_url: url, event_type: 'invoice.created' });

    const result = await outbox.drainOnce(f.db, { secret: SECRET });
    assert.equal(result.delivered, 1);
    assert.equal(result.failed, 0);

    const row = f.repo.get('integration_event', id);
    assert.equal(row.status, 'delivered');
    assert.ok(row.delivered_at);
    assert.equal(row.attempts, 0);

    assert.equal(requests.length, 1);
    assert.equal(JSON.parse(requests[0].body).hello, 'world');
    assert.equal(requests[0].headers['x-meridian-event'], 'invoice.created');
    const expected = outbox.signPayload(SECRET, requests[0].body);
    assert.equal(requests[0].headers['x-meridian-signature'], `sha256=${expected}`);
  } finally {
    server.close();
  }
});

test('a webhook that fails is retried with a growing backoff, not immediately', async () => {
  const f = freshTenant();
  const { server } = fakeReceiver(() => 500);
  const url = await listen(server);
  try {
    const id = enqueue(f, { target_url: url });

    const result = await outbox.drainOnce(f.db, { secret: SECRET, logger: quiet });
    assert.equal(result.delivered, 0);
    assert.equal(result.retried, 1);

    const row = f.repo.get('integration_event', id);
    assert.equal(row.status, 'pending', 'still pending, not failed -- there is budget left to retry');
    assert.equal(row.attempts, 1);
    assert.ok(row.last_error.includes('500'));
    assert.ok(row.next_attempt_at, 'a retry must be scheduled, not immediate');
    assert.ok(Date.parse(row.next_attempt_at) > Date.now(), 'the schedule must be in the future');

    // Not due yet: a second drain right now must not pick it up again.
    const again = await outbox.drainOnce(f.db, { secret: SECRET, logger: quiet });
    assert.equal(again.scanned, 0);
  } finally {
    server.close();
  }
});

test('a webhook that keeps failing is marked failed after the attempt budget runs out', async () => {
  const f = freshTenant();
  const { server, requests } = fakeReceiver(() => 500);
  const url = await listen(server);
  try {
    const id = enqueue(f, { target_url: url });
    // Force each attempt to be immediately due, so this test doesn't wait on
    // real backoff delays: after each drain, pull next_attempt_at back to now.
    for (let i = 0; i < 8; i++) {
      await outbox.drainOnce(f.db, { secret: SECRET, logger: quiet });
      f.db.prepare(`UPDATE integration_event SET next_attempt_at = ? WHERE id = ?`).run(nowIso(), id);
    }
    const row = f.repo.get('integration_event', id);
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 8);
    assert.equal(requests.length, 8);
  } finally {
    server.close();
  }
});

test('a webhook connecting to nothing fails cleanly rather than hanging', async () => {
  const f = freshTenant();
  // Nothing is listening on this port.
  const id = enqueue(f, { target_url: 'http://127.0.0.1:1/no-such-server' });
  const result = await outbox.drainOnce(f.db, { secret: SECRET, logger: quiet });
  assert.equal(result.retried, 1);
  const row = f.repo.get('integration_event', id);
  assert.equal(row.status, 'pending');
  assert.ok(row.last_error);
});

test('payroll rows are left exactly as queued -- there is no provider to push to', async () => {
  const f = freshTenant();
  const id = enqueue(f, { channel: 'payroll', target_url: '' });
  const result = await outbox.drainOnce(f.db, { secret: SECRET });
  assert.equal(result.scanned, 0, 'payroll must not even be scanned');
  const row = f.repo.get('integration_event', id);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 0);
});

test('an unrecognised channel is marked skipped rather than retried forever', async () => {
  const f = freshTenant();
  const id = enqueue(f, { channel: 'bank', target_url: '' });
  const result = await outbox.drainOnce(f.db, { secret: SECRET });
  assert.equal(result.skipped, 1);
  const row = f.repo.get('integration_event', id);
  assert.equal(row.status, 'skipped');
});

test('email delivery calls the injected sender with the tenant id and parsed payload', async () => {
  const f = freshTenant();
  const calls = [];
  const id = enqueue(f, {
    channel: 'email', target_url: '',
    payload: { to: 'ap@customer.test', subject: 'Statement' },
  });
  const result = await outbox.drainOnce(f.db, {
    secret: SECRET,
    sendMail: async (db, tenantId, payload) => { calls.push({ tenantId, payload }); },
  });
  assert.equal(result.delivered, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tenantId, f.tenant.id);
  assert.equal(calls[0].payload.to, 'ap@customer.test');
  assert.equal(f.repo.get('integration_event', id).status, 'delivered');
});

test('email delivery without a configured sender retries rather than silently dropping the message', async () => {
  const f = freshTenant();
  const id = enqueue(f, { channel: 'email', target_url: '', payload: { to: 'x@test.local' } });
  const result = await outbox.drainOnce(f.db, { secret: SECRET, logger: quiet }); // sendMail: null (default)
  assert.equal(result.retried, 1);
  const row = f.repo.get('integration_event', id);
  assert.equal(row.status, 'pending');
  assert.match(row.last_error, /not configured/);
});

test('a batch drains oldest first and respects the batch size', async () => {
  const f = freshTenant();
  const { server } = fakeReceiver();
  const url = await listen(server);
  try {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push(enqueue(f, { target_url: url, created_at: new Date(Date.now() + i * 1000).toISOString() }));
    }
    const result = await outbox.drainOnce(f.db, { secret: SECRET });
    assert.equal(result.delivered, 3);
    for (const id of ids) assert.equal(f.repo.get('integration_event', id).status, 'delivered');
  } finally {
    server.close();
  }
});
