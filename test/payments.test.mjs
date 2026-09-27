// Online payment collection: a Demo provider that posts a real customer
// payment while moving no real money, Stripe (checkout request shape and
// webhook verification, against injected fetch/signatures rather than a
// live account), idempotency, and the signed guest pay-link.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { freshTenant, DATE } from './helpers.mjs';
import { openDatabase, migrate, transaction } from '../src/core/db.mjs';
import { createServer } from '../src/server.mjs';
import { provisionTenant } from '../src/modules/setup.mjs';
import { loadServerSecret } from '../src/core/auth.mjs';
import * as payments from '../src/modules/payments.mjs';
import * as entities from '../src/modules/entities.mjs';
import * as inv from '../src/modules/inventory.mjs';
import * as T from '../src/modules/txn.mjs';
import { Money } from '../src/core/util.mjs';

const CONFIG = { secret: 'a-fake-server-secret-at-least-32-bytes-long-1234' };

function invoicingCo() {
  const f = freshTenant();
  Object.assign(f, f.tx(() => ({
    customer: entities.createCustomer(f.repo, { name: 'Acme Corp', email: 'ap@acme.test' }),
    item: inv.createItem(f.repo, { sku: 'SVC-1', name: 'Consulting', type: 'service', base_price: 500 }),
  })));
  return f;
}

function makeInvoice(f, amount = 500) {
  return f.tx(() => T.createTxn(f.repo, 'INVOICE', {
    entity_id: f.customer.id, txn_date: DATE, lines: [{ item_id: f.item.id, quantity: 1, unit_price: amount }],
  }));
}

// --------------------------------------------------------------- settings
test('payment settings round-trip encrypted, and the secret is never handed back', () => {
  const f = invoicingCo();
  assert.equal(payments.getPaymentSettings(f.repo).provider, 'demo', 'demo is the default until connected');

  const saved = f.tx(() => payments.setPaymentSettings(f.repo, CONFIG, {
    provider: 'stripe', secret_key: 'sk_test_abc123', webhook_secret: 'whsec_xyz', publishable_key: 'pk_test_1',
  }));
  assert.equal(saved.provider, 'stripe');
  assert.equal(saved.has_secret_key, true);
  assert.equal(saved.secret_key, undefined);

  const resolved = payments.resolvePaymentSettings(f.repo, CONFIG);
  assert.equal(resolved.secret_key, 'sk_test_abc123');
  assert.equal(resolved.webhook_secret, 'whsec_xyz');
});

// --------------------------------------------------------------- demo flow
// createCheckout is async (the stripe branch awaits an outbound call), so
// -- like the real routes -- it is never wrapped in repo.tx(): transaction()
// refuses an async callback outright, and its own write (one payment_intent
// insert) is already atomic without one.
test('a demo checkout posts a real customer payment applied to the invoice', async () => {
  const f = invoicingCo();
  const invoice = makeInvoice(f, 500);
  const checkout = await payments.createCheckout(f.repo, CONFIG, { invoiceId: invoice.id, successUrl: 'https://x/success', cancelUrl: 'https://x/cancel' });
  assert.equal(checkout.provider, 'demo');

  const { payment } = f.tx(() => payments.confirmDemo(f.repo, checkout.intent_id));
  assert.equal(payment.type, 'CUSTOMER_PAYMENT');
  assert.equal(payment.posted, 1);

  const settled = T.getTxn(f.repo, invoice.id);
  assert.equal(settled.status, 'paid');
  assert.equal(settled.amount_remaining, 0);
});

test('confirming the same checkout twice produces exactly one payment', async () => {
  const f = invoicingCo();
  const invoice = makeInvoice(f, 200);
  const checkout = await payments.createCheckout(f.repo, CONFIG, { invoiceId: invoice.id, successUrl: 'https://x', cancelUrl: 'https://x' });
  const first = f.tx(() => payments.confirmDemo(f.repo, checkout.intent_id));
  const second = f.tx(() => payments.confirmDemo(f.repo, checkout.intent_id));
  assert.equal(first.payment.id, second.payment.id, 'the second confirmation must return the same payment, not create another');

  const paymentCount = f.repo.scalar(
    "SELECT COUNT(*) c FROM txn WHERE tenant_id = :t AND type = 'CUSTOMER_PAYMENT' AND entity_id = ?", [f.customer.id], 0);
  assert.equal(paymentCount, 1);
});

test('a checkout on an invoice with nothing outstanding is refused', async () => {
  const f = invoicingCo();
  const invoice = makeInvoice(f, 100);
  const checkout = await payments.createCheckout(f.repo, CONFIG, { invoiceId: invoice.id, successUrl: 'https://x', cancelUrl: 'https://x' });
  f.tx(() => payments.confirmDemo(f.repo, checkout.intent_id));
  await assert.rejects(() => payments.createCheckout(f.repo, CONFIG, { invoiceId: invoice.id, successUrl: 'https://x', cancelUrl: 'https://x' }), /nothing outstanding/);
});

// -------------------------------------------------------------- stripe shape
test('a Stripe checkout request has the right shape, including zero-decimal currency conversion', async () => {
  const f = invoicingCo();
  f.tx(() => payments.setPaymentSettings(f.repo, CONFIG, { provider: 'stripe', secret_key: 'sk_test_1' }));
  const invoice = makeInvoice(f, 1234.56);

  let captured = null; let sessionSeq = 0;
  const fetchImpl = async (fetchUrl, opts) => {
    captured = { url: fetchUrl, opts };
    const id = `cs_test_${++sessionSeq}`;
    return { ok: true, json: async () => ({ id, url: `https://checkout.stripe.com/${id}` }) };
  };
  const checkout = await payments.createCheckout(f.repo, CONFIG, {
    invoiceId: invoice.id, successUrl: 'https://x/success', cancelUrl: 'https://x/cancel', fetchImpl,
  });
  assert.equal(checkout.provider, 'stripe');
  assert.equal(checkout.redirect_url, 'https://checkout.stripe.com/cs_test_1');
  assert.equal(captured.url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(captured.opts.headers.Authorization, 'Bearer sk_test_1');
  assert.ok(captured.opts.headers['Idempotency-Key']);
  const body = new URLSearchParams(captured.opts.body);
  assert.equal(body.get('line_items[0][price_data][currency]'), invoice.currency.toLowerCase());
  assert.equal(Number(body.get('line_items[0][price_data][unit_amount]')), invoice.amount_remaining, 'a normal currency sends its minor-unit amount as-is');

  const intent = f.repo.queryOne("SELECT * FROM payment_intent WHERE tenant_id = :t AND provider_ref = 'cs_test_1'");
  assert.ok(intent, 'the session id must be recorded so the webhook can find it later');

  // A zero-decimal currency (JPY) is sent as whole yen, not yen x100.
  f.tx(() => f.repo.exec(
    'INSERT INTO exchange_rate (tenant_id, from_currency, to_currency, rate_date, rate) VALUES (:t,?,?,?,?)',
    ['JPY', 'USD', DATE, 0.0067]));
  const jpyInvoice = f.tx(() => T.createTxn(f.repo, 'INVOICE', {
    entity_id: f.customer.id, currency: 'JPY', txn_date: DATE, lines: [{ item_id: f.item.id, quantity: 1, unit_price: 1000 }],
  }));
  await payments.createCheckout(f.repo, CONFIG, { invoiceId: jpyInvoice.id, successUrl: 'https://x', cancelUrl: 'https://x', fetchImpl });
  const jpyBody = new URLSearchParams(captured.opts.body);
  assert.equal(Number(jpyBody.get('line_items[0][price_data][unit_amount]')), Money.toNumber(jpyInvoice.amount_remaining));
});

test('a Stripe error response is surfaced, not thrown as a 500', async () => {
  const f = invoicingCo();
  f.tx(() => payments.setPaymentSettings(f.repo, CONFIG, { provider: 'stripe', secret_key: 'sk_test_bad' }));
  const invoice = makeInvoice(f, 100);
  const fetchImpl = async () => ({ ok: false, json: async () => ({ error: { message: 'Invalid API key provided' } }) });
  await assert.rejects(
    () => payments.createCheckout(f.repo, CONFIG, { invoiceId: invoice.id, successUrl: 'https://x', cancelUrl: 'https://x', fetchImpl }),
    /Invalid API key/);
});

// -------------------------------------------------------------- webhook
test('a webhook with a valid signature completes the matching payment; a bad or stale one is refused', () => {
  const f = invoicingCo();
  f.tx(() => payments.setPaymentSettings(f.repo, CONFIG, { provider: 'stripe', secret_key: 'sk_test_1', webhook_secret: 'whsec_test_1' }));
  const invoice = makeInvoice(f, 300);
  f.tx(() => f.repo.insert('payment_intent', {
    id: 'pi_1', provider: 'stripe', provider_ref: 'cs_webhook_1', invoice_id: invoice.id, customer_id: f.customer.id,
    amount: invoice.amount_remaining, currency: invoice.currency, status: 'created', payment_txn_id: null,
    created_at: new Date().toISOString(), completed_at: null,
  }));

  const rawBody = Buffer.from(JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_webhook_1', payment_status: 'paid' } } }));
  const sign = (secret, t, body) => `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

  assert.throws(() => f.tx(() => payments.handleStripeWebhook(f.repo, CONFIG, rawBody, sign('wrong-secret', Math.floor(Date.now() / 1000), rawBody))), /Invalid webhook signature/);
  assert.throws(() => f.tx(() => payments.handleStripeWebhook(f.repo, CONFIG, rawBody, sign('whsec_test_1', Math.floor(Date.now() / 1000) - 10_000, rawBody))), /Invalid webhook signature/);

  const result = f.tx(() => payments.handleStripeWebhook(f.repo, CONFIG, rawBody, sign('whsec_test_1', Math.floor(Date.now() / 1000), rawBody)));
  assert.equal(result.handled, true);
  assert.equal(T.getTxn(f.repo, invoice.id).status, 'paid');

  // Redelivering the same webhook must not post a second payment.
  f.tx(() => payments.handleStripeWebhook(f.repo, CONFIG, rawBody, sign('whsec_test_1', Math.floor(Date.now() / 1000), rawBody)));
  const paymentCount = f.repo.scalar("SELECT COUNT(*) c FROM txn WHERE tenant_id = :t AND type = 'CUSTOMER_PAYMENT'", [], 0);
  assert.equal(paymentCount, 1);
});

// -------------------------------------------------------------- pay link
test('a pay link opens exactly the invoice it was signed for, and refuses a tampered or expired one', () => {
  const f = invoicingCo();
  const invoice = makeInvoice(f, 100);
  const token = payments.newPayLink(CONFIG.secret, { tenantId: f.tenant.id, invoiceId: invoice.id });
  const claim = payments.verifyPayLink(CONFIG.secret, token);
  assert.deepEqual(claim, { tenantId: f.tenant.id, invoiceId: invoice.id });

  assert.equal(payments.verifyPayLink(CONFIG.secret, token + 'x'), null, 'a tampered token must be refused');
  assert.equal(payments.verifyPayLink('a-completely-different-secret-at-least-32-bytes', token), null);

  const expired = payments.signPayLink(CONFIG.secret, { tenantId: f.tenant.id, invoiceId: invoice.id, expiresAt: '2020-01-01T00:00:00.000Z' });
  assert.equal(payments.verifyPayLink(CONFIG.secret, expired), null, 'an expired link must be refused');

  // A link signed for a different invoice cannot be swapped in.
  const other = makeInvoice(f, 50);
  const otherToken = payments.newPayLink(CONFIG.secret, { tenantId: f.tenant.id, invoiceId: other.id });
  assert.notEqual(payments.verifyPayLink(CONFIG.secret, otherToken).invoiceId, invoice.id);
});

// ----------------------------------------------------------- end-to-end http
const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
let server, base, db, dataDir;
const PASSWORD = 'Correct-Horse-9';

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-payments-test-'));
  db = openDatabase(':memory:');
  migrate(db, path.join(ROOT, 'migrations'));
  transaction(db, () => provisionTenant(db, { name: 'Payments HTTP Co', ownerEmail: 'owner@test.local', ownerPassword: PASSWORD, fiscalYear: 2026 }));
  const config = { version: 'test', dataDir, webDir: path.join(ROOT, 'src/web'), migrationsDir: path.join(ROOT, 'migrations'), dev: false, trustProxy: false, secret: loadServerSecret(dataDir) };
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
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      if (json?.csrf) csrf = json.csrf;
      return { status: res.status, body: json };
    },
    login(email = 'owner@test.local', password = PASSWORD) { return this.call('POST', '/api/v1/auth/login', { email, password }); },
  };
}

test('a guest pay link works end to end: view, start a demo checkout, confirm, and the invoice shows paid', async () => {
  const c = client();
  await c.login();
  const customer = (await c.call('POST', '/api/v1/records/customer', { name: 'Guest Pay Co' })).body;
  const item = (await c.call('POST', '/api/v1/records/item', { sku: 'PAY-1', name: 'Service', type: 'service', base_price: 250 })).body;
  const invoice = (await c.call('POST', '/api/v1/records/invoice', { entity_id: customer.id, txn_date: '2026-06-01', lines: [{ item_id: item.id, quantity: 1 }] })).body;
  const link = (await c.call('POST', `/api/v1/txn/${invoice.id}/pay-link`, {})).body;
  const token = link.url.split('/pay/')[1];

  const view = await fetch(`${base}/api/v1/pay/${token}`);
  assert.equal(view.status, 200);
  const viewBody = await view.json();
  assert.equal(viewBody.txn_no, invoice.txn_no);

  const checkoutRes = await fetch(`${base}/api/v1/pay/${token}/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const checkout = await checkoutRes.json();
  assert.equal(checkout.provider, 'demo');

  const confirmRes = await fetch(`${base}/api/v1/payments/demo/${checkout.intent_id}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(confirmRes.status, 200);

  const settled = (await c.call('GET', `/api/v1/txn/${invoice.id}`)).body;
  assert.equal(settled.status, 'paid');
});

test('a wrong or missing pay-link token gets a 404 from the guest routes, not a 500', async () => {
  const bad = await fetch(`${base}/api/v1/pay/not-a-real-token`);
  assert.equal(bad.status, 404);
});
