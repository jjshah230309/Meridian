// Meridian ERP :: modules/payments
// Online payment collection: a Demo provider (posts a real customer
// payment, moves no real money -- the default until Stripe is connected)
// and Stripe Checkout. Every payment, from either provider, ends up going
// through the exact same completePayment(), which is idempotent on the
// provider's own reference -- a webhook retried, or a guest hitting back
// then forward again, can never create two payments for one checkout.
import crypto from 'node:crypto';
import { ulid, nowIso, Money, timingSafeEqual } from '../core/util.mjs';
import { notFound, unprocessable, forbidden, ValidationError } from '../core/http.mjs';
import { encryptSecret, decryptSecret } from '../core/auth.mjs';
import * as audit from '../core/audit.mjs';
import * as T from './txn.mjs';

const STRIPE_KEY = 'meridian:stripe';
const PAYLINK_TTL_DAYS = 30;
// Currencies Stripe (and the wider card-network convention) express as a
// bare integer of whole units rather than the usual /100 minor unit --
// this codebase stores every currency's amount the same way (minor units,
// MONEY_SCALE=100 always), so a payment in one of these has to be
// converted on the way out to Stripe, and never otherwise.
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'TWD', 'UGX']);

export const PROVIDERS = ['demo', 'stripe'];

// --------------------------------------------------------------- settings
// Same tenant.settings JSON-column pattern setup.mjs's SMTP settings use,
// and the same reason: `tenant` is not a TENANT_TABLES row, it is the row
// that names the tenant.
export function getPaymentSettings(repo) {
  const row = repo.queryOne('SELECT settings FROM tenant WHERE id = :t');
  const p = row?.settings?.payments || {};
  return {
    provider: PROVIDERS.includes(p.provider) ? p.provider : 'demo',
    has_secret_key: !!p.secret_key_enc, has_webhook_secret: !!p.webhook_secret_enc,
    publishable_key: p.publishable_key || '', bank_account_id: p.bank_account_id || null,
  };
}

function decryptSafe(secret, encoded) {
  try { return decryptSecret(secret, encoded, STRIPE_KEY); } catch { return ''; }
}

/** The decrypted form. Only ever used server-side to call Stripe or verify its webhook. */
export function resolvePaymentSettings(repo, config) {
  const row = repo.queryOne('SELECT settings FROM tenant WHERE id = :t');
  const p = row?.settings?.payments || {};
  return {
    provider: PROVIDERS.includes(p.provider) ? p.provider : 'demo',
    secret_key: p.secret_key_enc ? decryptSafe(config.secret, p.secret_key_enc) : '',
    webhook_secret: p.webhook_secret_enc ? decryptSafe(config.secret, p.webhook_secret_enc) : '',
    publishable_key: p.publishable_key || '', bank_account_id: p.bank_account_id || null,
  };
}

export function setPaymentSettings(repo, config, patch = {}) {
  const row = repo.queryOne('SELECT settings FROM tenant WHERE id = :t');
  const settings = row?.settings || {};
  const existing = settings.payments || {};
  if (patch.provider !== undefined && !PROVIDERS.includes(patch.provider)) {
    throw new ValidationError({ provider: `Provider must be one of ${PROVIDERS.join(', ')}` });
  }
  const p = {
    provider: patch.provider !== undefined ? patch.provider : (existing.provider || 'demo'),
    publishable_key: patch.publishable_key !== undefined ? String(patch.publishable_key || '').trim() : (existing.publishable_key || ''),
    bank_account_id: patch.bank_account_id !== undefined ? (patch.bank_account_id || null) : (existing.bank_account_id || null),
    secret_key_enc: patch.clear_secret_key ? null
      : (patch.secret_key ? encryptSecret(config.secret, patch.secret_key, STRIPE_KEY) : (existing.secret_key_enc || null)),
    webhook_secret_enc: patch.clear_webhook_secret ? null
      : (patch.webhook_secret ? encryptSecret(config.secret, patch.webhook_secret, STRIPE_KEY) : (existing.webhook_secret_enc || null)),
  };
  repo.exec('UPDATE tenant SET settings = ? WHERE id = :t', [JSON.stringify({ ...settings, payments: p })]);
  audit.record(repo, { recordType: 'setup', recordId: 'payments', action: 'update', changes: { provider: { from: existing.provider || 'demo', to: p.provider } } });
  return getPaymentSettings(repo);
}

/** A quick liveness check for the "Test connection" button -- Stripe's
 * lightest read-only endpoint, and the one every Stripe integration guide
 * suggests for exactly this. */
export async function testStripeConnection(secretKey, { fetchImpl = fetch } = {}) {
  if (!secretKey) throw new ValidationError({ secret_key: 'Enter a secret key first' });
  const res = await fetchImpl('https://api.stripe.com/v1/balance', {
    method: 'GET', headers: { Authorization: `Bearer ${secretKey}` }, signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw unprocessable(body?.error?.message || `Stripe rejected that key (${res.status}).`);
  return { ok: true, livemode: !!body.livemode };
}

// ---------------------------------------------------------------- checkout
function amountForStripe(minorUnits, currency) {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? Math.round(Money.toNumber(minorUnits)) : minorUnits;
}

/**
 * Start a checkout for one invoice. Demo creates a payment_intent and hands
 * back enough to render a same-page confirmation; Stripe creates a real
 * Checkout Session and hands back its hosted URL to redirect to.
 */
export async function createCheckout(repo, config, { invoiceId, successUrl, cancelUrl, fetchImpl = fetch }) {
  const invoice = T.getTxn(repo, invoiceId);
  if (!invoice || invoice.type !== 'INVOICE') throw notFound('Invoice not found');
  if (!(invoice.amount_remaining > 0)) throw unprocessable(`${invoice.txn_no} has nothing outstanding to pay.`);

  const settings = resolvePaymentSettings(repo, config);
  const amount = invoice.amount_remaining;
  const currency = invoice.currency;

  if (settings.provider === 'stripe') {
    if (!settings.secret_key) throw unprocessable('Stripe is not connected yet. Finish connecting it under Setup → Integrations → Payments.');
    const id = ulid();
    const form = new URLSearchParams();
    form.set('mode', 'payment');
    form.append('payment_method_types[]', 'card');
    form.set('line_items[0][price_data][currency]', currency.toLowerCase());
    form.set('line_items[0][price_data][product_data][name]', `Invoice ${invoice.txn_no}`);
    form.set('line_items[0][price_data][unit_amount]', String(amountForStripe(amount, currency)));
    form.set('line_items[0][quantity]', '1');
    form.set('success_url', successUrl);
    form.set('cancel_url', cancelUrl);
    form.set('metadata[tenant_id]', repo.tenantId);
    form.set('metadata[invoice_id]', invoiceId);
    form.set('metadata[payment_intent_id]', id);
    const res = await fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.secret_key}`, 'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': id,
      },
      body: form.toString(), signal: AbortSignal.timeout(15_000),
    });
    const session = await res.json().catch(() => ({}));
    if (!res.ok) throw unprocessable(session?.error?.message || 'Stripe could not start a checkout for this invoice.');
    repo.insert('payment_intent', {
      id, provider: 'stripe', provider_ref: session.id, invoice_id: invoiceId, customer_id: invoice.entity_id,
      amount, currency, status: 'created', payment_txn_id: null, created_at: nowIso(), completed_at: null,
    });
    return { provider: 'stripe', redirect_url: session.url, intent_id: id };
  }

  // Demo: nothing external, nothing charged -- confirmed by the caller
  // hitting confirmDemo below, same as a real gateway confirming a payment.
  const id = ulid();
  repo.insert('payment_intent', {
    id, provider: 'demo', provider_ref: `demo_${id}`, invoice_id: invoiceId, customer_id: invoice.entity_id,
    amount, currency, status: 'created', payment_txn_id: null, created_at: nowIso(), completed_at: null,
  });
  return { provider: 'demo', intent_id: id, amount, currency, invoice_no: invoice.txn_no };
}

export function getIntent(repo, id) {
  const intent = repo.get('payment_intent', id);
  if (!intent) throw notFound('Payment session not found');
  return intent;
}

export function confirmDemo(repo, intentId) {
  const intent = getIntent(repo, intentId);
  if (intent.provider !== 'demo') throw unprocessable('That is not a demo payment session.');
  return completePayment(repo, intent);
}

/**
 * Turn a completed checkout into a real customer payment, applied to the
 * invoice it was for. Idempotent: a webhook delivered twice, or two
 * confirmations racing, both land on the same already-completed intent and
 * neither creates a second payment.
 */
export function completePayment(repo, intentOrId) {
  return repo.tx(() => {
    const intent = typeof intentOrId === 'string' ? getIntent(repo, intentOrId) : intentOrId;
    if (intent.status === 'completed') return { intent, payment: repo.get('txn', intent.payment_txn_id) };
    if (intent.status !== 'created') throw unprocessable(`This payment session is ${intent.status}, not payable.`);

    // bank_account_id is the only setting this needs, and it isn't
    // encrypted, so this reads the plain settings rather than decrypting
    // secrets it has no use for.
    const settings = getPaymentSettings(repo);
    const payment = T.createPayment(repo, 'CUSTOMER_PAYMENT', {
      entity_id: intent.customer_id, amount: Money.toNumber(intent.amount), currency: intent.currency,
      applications: [{ txn_id: intent.invoice_id, amount: Money.toNumber(intent.amount) }],
      bank_account_id: settings.bank_account_id || undefined, undeposited: !settings.bank_account_id,
      payment_method: 'card', reference: `${intent.provider}:${intent.provider_ref}`,
    });
    repo.update('payment_intent', intent.id, { status: 'completed', payment_txn_id: payment.id, completed_at: nowIso() });
    audit.record(repo, { recordType: 'invoice', recordId: intent.invoice_id, action: 'online_payment', changes: { payment: { from: null, to: payment.txn_no } } });
    return { intent: repo.get('payment_intent', intent.id), payment };
  });
}

// ---------------------------------------------------------------- webhook
/** Stripe's own construction: `t=<unix>,v1=<hmac>`, over `${t}.${rawBody}`. */
export function verifyStripeSignature(secret, rawBody, header, { toleranceSeconds = 300 } = {}) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(String(header).split(',').map((kv) => {
    const i = kv.indexOf('='); return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)];
  }));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSeconds) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return timingSafeEqual(expected, v1);
}

export function handleStripeWebhook(repo, config, rawBody, signatureHeader) {
  const settings = resolvePaymentSettings(repo, config);
  if (!verifyStripeSignature(settings.webhook_secret, rawBody, signatureHeader)) {
    throw forbidden('Invalid webhook signature.');
  }
  let event;
  try { event = JSON.parse(rawBody.toString('utf8')); } catch { throw unprocessable('Malformed webhook payload.'); }
  if (event.type !== 'checkout.session.completed') return { received: true, handled: false };
  const session = event.data?.object;
  if (session?.payment_status !== 'paid') return { received: true, handled: false };
  const intent = repo.queryOne("SELECT * FROM payment_intent WHERE tenant_id = :t AND provider = 'stripe' AND provider_ref = ?", [session.id]);
  if (!intent) return { received: true, handled: false }; // a session this tenant's data doesn't recognise -- nothing to do, not an error
  completePayment(repo, intent);
  return { received: true, handled: true };
}

// -------------------------------------------------------------- pay links
/** A signed, time-limited link to one invoice -- no portal login needed. */
export function signPayLink(secret, { tenantId, invoiceId, expiresAt }) {
  const payload = Buffer.from(JSON.stringify({ t: tenantId, i: invoiceId, e: expiresAt })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function newPayLink(secret, { tenantId, invoiceId }) {
  const expiresAt = new Date(Date.now() + PAYLINK_TTL_DAYS * 86400_000).toISOString();
  return signPayLink(secret, { tenantId, invoiceId, expiresAt });
}

/** Returns `{ tenantId, invoiceId }`, or null if the token is invalid, tampered with, or expired. */
export function verifyPayLink(secret, token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (!timingSafeEqual(expected, sig)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (!data?.t || !data?.i || !data?.e) return null;
  if (Date.parse(data.e) < Date.now()) return null;
  return { tenantId: data.t, invoiceId: data.i };
}

/** Queue an email with the invoice's pay link -- never sent inline, the same rule collections.mjs's own emails follow. */
export function emailPayLink(repo, config, invoiceId, { baseUrl } = {}) {
  const invoice = T.getTxn(repo, invoiceId);
  if (!invoice || invoice.type !== 'INVOICE') throw notFound('Invoice not found');
  if (!invoice.entity?.email) throw unprocessable(`${invoice.entity?.name || 'This customer'} has no email address on file.`);
  const link = `${baseUrl}/pay/${newPayLink(config.secret, { tenantId: repo.tenantId, invoiceId })}`;
  const id = ulid();
  repo.insert('integration_event', {
    id, channel: 'email', event_type: 'payments.pay_link.email',
    record_type: 'invoice', record_id: invoiceId,
    payload: {
      to: invoice.entity.email, subject: `Invoice ${invoice.txn_no} — pay online`,
      text: `${Money.format(invoice.amount_remaining, invoice.currency)} is due on invoice ${invoice.txn_no}.\n\nPay it online:\n${link}\n\nThis link expires in ${PAYLINK_TTL_DAYS} days.`,
    },
    status: 'pending', attempts: 0, last_error: '', target_url: '', created_at: nowIso(),
  });
  audit.record(repo, { recordType: 'invoice', recordId: invoiceId, action: 'email-pay-link', changes: { to: { from: null, to: invoice.entity.email } } });
  return { queued: true, id, to: invoice.entity.email, link };
}
