// Meridian ERP :: api_payments
// Online payment collection: settings (owner-only, same gate as SMTP),
// checkout from the staff app, the portal, or a signed guest pay link, and
// the Stripe webhook. Kept in its own file for the same reason api_ops.mjs
// and api_portal.mjs are: buildApi stays a single, short call.
import { badRequest, notFound, unprocessable, forbidden, ValidationError } from './core/http.mjs';
import * as rbac from './core/rbac.mjs';
import * as audit from './core/audit.mjs';
import { Repo } from './core/db.mjs';
import * as payments from './modules/payments.mjs';
import * as T from './modules/txn.mjs';

const LEVEL = rbac.LEVEL;

function originOf(ctx) {
  return ctx.config.portalBaseUrl || `${ctx.req.headers['x-forwarded-proto'] || 'http'}://${ctx.req.headers.host}`;
}

export function registerPaymentRoutes(r, P) {
  // ------------------------------------------------------------- settings
  r.get(`${P}/setup/payment-settings`, async (ctx) => {
    rbac.require$(ctx.access, 'setup', LEVEL.VIEW);
    return payments.getPaymentSettings(ctx.repo);
  });

  r.put(`${P}/setup/payment-settings`, async (ctx) => {
    if (!ctx.user?.is_owner) throw forbidden('Only the account owner can change how payments are collected.');
    return ctx.tx(() => {
      const saved = payments.setPaymentSettings(ctx.repo, ctx.config, ctx.body || {});
      return saved;
    });
  });

  r.post(`${P}/setup/payment-settings/test`, async (ctx) => {
    if (!ctx.user?.is_owner) throw forbidden('Only the account owner can test the connection.');
    const resolved = payments.resolvePaymentSettings(ctx.repo, ctx.config);
    return payments.testStripeConnection(ctx.body?.secret_key || resolved.secret_key);
  });

  // -------------------------------------------------------------- staff
  r.post(`${P}/txn/:id/pay-link`, async (ctx) => {
    const t = T.requireTxn(ctx.repo, ctx.params.id, 'INVOICE');
    rbac.require$(ctx.access, 'invoice', LEVEL.VIEW);
    if (!rbac.canSeeRow(ctx.access, 'txn', t)) throw forbidden('You do not have access to that invoice.');
    return { url: `${originOf(ctx)}/pay/${payments.newPayLink(ctx.config.secret, { tenantId: ctx.repo.tenantId, invoiceId: t.id })}` };
  });

  r.post(`${P}/txn/:id/email-pay-link`, async (ctx) => {
    const t = T.requireTxn(ctx.repo, ctx.params.id, 'INVOICE');
    rbac.require$(ctx.access, 'invoice', LEVEL.EDIT);
    if (!rbac.canSeeRow(ctx.access, 'txn', t)) throw forbidden('You do not have access to that invoice.');
    return ctx.tx(() => payments.emailPayLink(ctx.repo, ctx.config, t.id, { baseUrl: originOf(ctx) }));
  });

  // -------------------------------------------------------------- portal
  r.post(`${P}/portal/documents/:id/checkout`, async (ctx) => {
    if (!ctx.portalUser) throw forbidden('Not signed in');
    if (ctx.portalUser.entity_type !== 'customer') throw notFound('Not available');
    const invoice = T.getTxn(ctx.repo, ctx.params.id);
    if (!invoice || invoice.entity_id !== ctx.portalUser.entity_id) throw notFound('Invoice not found');
    const base = originOf(ctx);
    // Not wrapped in ctx.tx: createCheckout awaits an outbound Stripe call
    // for the stripe provider, and transaction() refuses an async callback
    // outright (SQLite writes are sync by design) -- its own write, a
    // single payment_intent insert, is already atomic on its own.
    return payments.createCheckout(ctx.repo, ctx.config, {
      invoiceId: invoice.id,
      successUrl: `${base}/portal/document/${invoice.id}?paid=1`,
      cancelUrl: `${base}/portal/document/${invoice.id}`,
    });
  }, { portal: true });

  // --------------------------------------------------------------- guest
  // Nothing here checks a session at all -- the signed token in the URL is
  // the entire credential, the same trade every "reset your password"
  // email link makes. A guest never sees anything about the invoice this
  // route does not itself return.
  function guestInvoice(ctx) {
    const claim = payments.verifyPayLink(ctx.config.secret, ctx.params.token);
    if (!claim) throw notFound('This link is invalid or has expired.');
    const repo = new Repo(ctx.db, claim.tenantId, {});
    const invoice = T.getTxn(repo, claim.invoiceId);
    if (!invoice || invoice.type !== 'INVOICE') throw notFound('This link is invalid or has expired.');
    return { repo, invoice };
  }

  r.get(`${P}/pay/:token`, async (ctx) => {
    const { repo, invoice } = guestInvoice(ctx);
    const settings = payments.getPaymentSettings(repo);
    return {
      txn_no: invoice.txn_no, total: invoice.total, amount_remaining: invoice.amount_remaining,
      currency: invoice.currency, due_date: invoice.due_date, status: invoice.status,
      company: repo.queryOne('SELECT name FROM tenant WHERE id = :t')?.name || 'Meridian',
      provider: settings.provider,
    };
  }, { public: true });

  r.post(`${P}/pay/:token/checkout`, async (ctx) => {
    const { repo, invoice } = guestInvoice(ctx);
    const base = originOf(ctx);
    return payments.createCheckout(repo, ctx.config, {
      invoiceId: invoice.id,
      successUrl: `${base}/pay/${ctx.params.token}?paid=1`,
      cancelUrl: `${base}/pay/${ctx.params.token}`,
    });
  }, { public: true });

  // Confirming a demo payment needs no session either way -- knowing the
  // intent id (a ulid, generated server-side, never guessable) is exactly
  // as much authority as the checkout that created it already had, and no
  // real money moves regardless.
  r.post(`${P}/payments/demo/:intentId/confirm`, async (ctx) => {
    const intent = ctx.db.prepare('SELECT * FROM payment_intent WHERE id = ?').get(ctx.params.intentId);
    if (!intent) throw notFound('Payment session not found');
    const repo = new Repo(ctx.db, intent.tenant_id, {});
    return ctx.tx(() => payments.confirmDemo(repo, intent.id));
  }, { public: true });

  // -------------------------------------------------------------- webhook
  r.post(`${P}/payments/webhook/stripe/:tenantId`, async (ctx) => {
    const tenant = ctx.db.prepare('SELECT * FROM tenant WHERE id = ?').get(ctx.params.tenantId);
    if (!tenant) throw notFound('Unknown company');
    const repo = new Repo(ctx.db, tenant.id, {});
    const sig = ctx.req.headers['stripe-signature'];
    return ctx.tx(() => payments.handleStripeWebhook(repo, ctx.config, ctx.body, sig));
  }, { public: true, rawBody: true });
}
