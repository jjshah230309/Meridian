// Meridian ERP :: api_portal
// The customer/vendor self-service surface, entirely separate from the
// staff API: every route here runs against ctx.portalUser (never ctx.access
// or ctx.user), reads server.mjs's own portal-session identity block, and
// is registered with `{ portal: true }` so that branch, not the staff one,
// resolves who is calling.
import { badRequest, notFound, unprocessable, forbidden, ValidationError } from './core/http.mjs';
import { Repo } from './core/db.mjs';
import { ulid, nowIso } from './core/util.mjs';
import * as rbac from './core/rbac.mjs';
import * as auth from './core/auth.mjs';
import * as portal from './modules/portal.mjs';

const LEVEL = rbac.LEVEL;

function requirePermFor(ctx, entityType, needed) {
  rbac.require$(ctx.access, entityType, needed);
}

function findTenant(db, slugOrId) {
  return slugOrId
    ? db.prepare('SELECT * FROM tenant WHERE slug = ? OR id = ?').get(slugOrId, slugOrId)
    : db.prepare('SELECT * FROM tenant ORDER BY created_at LIMIT 1').get();
}

export function registerPortalRoutes(r, P) {
  const PP = `${P}/portal`;

  // ---------------------------------------------------------- session
  r.get(`${PP}/session`, async (ctx) => ({
    user: ctx.portalUser ? { email: ctx.portalUser.email, entity_type: ctx.portalUser.entity_type, entity_id: ctx.portalUser.entity_id } : null,
    csrf: ctx.csrf,
  }), { portal: true, public: true });

  r.post(`${PP}/login`, async (ctx) => {
    const { email, password, tenant } = ctx.body || {};
    if (!email || !password) throw new ValidationError({ email: !email ? 'Email is required' : undefined, password: !password ? 'Password is required' : undefined });
    const t = findTenant(ctx.db, tenant);
    if (!t || t.status !== 'active') throw badRequest('That company is not available.');
    const result = auth.authenticatePortalUser(ctx.db, { tenantId: t.id, email, password, ip: ctx.ip, userAgent: ctx.req.headers['user-agent'] });
    if (!result.ok) {
      const messages = {
        invalid_credentials: 'Incorrect email or password.',
        account_disabled: 'This account has been disabled.',
        invite_not_accepted: 'Please open your invitation email to set a password first.',
        account_locked: 'Too many attempts. Try again later.',
      };
      throw unprocessable(messages[result.reason] || 'Could not sign in.');
    }
    ctx.setPortalSessionCookie(result.session.token);
    return { user: { email: result.user.email, entity_type: result.user.entity_type, entity_id: result.user.entity_id }, csrf: auth.portalCsrfFor(ctx.config.secret, result.session.id) };
  }, { portal: true, public: true, rateLimit: 'auth' });

  r.post(`${PP}/logout`, async (ctx) => {
    if (ctx.portalSession) ctx.db.prepare('DELETE FROM portal_session WHERE id = ?').run(ctx.portalSession.id);
    ctx.clearPortalSessionCookie();
    return { ok: true };
  }, { portal: true, public: true });

  r.post(`${PP}/accept-invite`, async (ctx) => {
    const { tenant, token, password } = ctx.body || {};
    const t = findTenant(ctx.db, tenant);
    if (!t) throw badRequest('Unknown company.');
    const scopedRepo = new Repo(ctx.db, t.id, {});
    const user = ctx.tx(() => portal.acceptInvite(scopedRepo, { token, password }));
    const session = auth.createPortalSession(ctx.db, { tenantId: t.id, portalUserId: user.id, ip: ctx.ip, userAgent: ctx.req.headers['user-agent'] });
    ctx.setPortalSessionCookie(session.token);
    return { user: { email: user.email, entity_type: user.entity_type, entity_id: user.entity_id }, csrf: auth.portalCsrfFor(ctx.config.secret, session.id) };
  }, { portal: true, public: true, rateLimit: 'auth' });

  r.post(`${PP}/change-password`, async (ctx) => {
    if (!ctx.portalUser) throw forbidden('Not signed in');
    return ctx.tx(() => portal.setPassword(ctx.repo, ctx.portalUser.id, ctx.body || {}));
  }, { portal: true });

  // --------------------------------------------------------- documents
  r.get(`${PP}/documents`, async (ctx) => ({ documents: portal.listDocuments(ctx.repo, { kind: ctx.query.kind }) }), { portal: true });
  r.get(`${PP}/documents/:id`, async (ctx) => portal.getDocument(ctx.repo, ctx.params.id), { portal: true });
  r.get(`${PP}/statement`, async (ctx) => portal.customerStatement(ctx.repo, { as_of: ctx.query.as_of, kind: ctx.query.kind }), { portal: true });
  r.get(`${PP}/statement.pdf`, async (ctx) => {
    const buf = portal.customerStatementPdf(ctx.repo, { as_of: ctx.query.as_of });
    return { __body: buf, __contentType: 'application/pdf', __filename: 'statement.pdf', __inline: true };
  }, { portal: true });

  // ----------------------------------------------------------- staff side
  // Inviting/revoking a portal account is a staff action, so this runs
  // through the ORDINARY (non-portal) identity block, gated the same way
  // every other write to a customer or vendor record already is.
  r.get(`${P}/entities/:entityType/:id/portal-users`, async (ctx) => {
    const type = ctx.params.entityType;
    if (!['customer', 'vendor'].includes(type)) throw badRequest('Unknown entity type');
    requirePermFor(ctx, type, LEVEL.VIEW);
    return { users: portal.listForEntity(ctx.repo, type, ctx.params.id) };
  });

  r.post(`${P}/entities/:entityType/:id/portal-invite`, async (ctx) => {
    const type = ctx.params.entityType;
    if (!['customer', 'vendor'].includes(type)) throw badRequest('Unknown entity type');
    requirePermFor(ctx, type, LEVEL.FULL);
    const { email, contact_id } = ctx.body || {};
    return ctx.tx(() => {
      const { portalUser, token } = portal.invite(ctx.repo, { entity_type: type, entity_id: ctx.params.id, email, contact_id });
      const base = ctx.config.portalBaseUrl || `${ctx.req.headers['x-forwarded-proto'] || 'http'}://${ctx.req.headers.host}`;
      const link = `${base}/portal/accept?token=${token}`;
      // Queued, never sent inline -- the same rule every other email in this
      // app follows (see collections.mjs's own comment on the same point).
      ctx.repo.insert('integration_event', {
        id: ulid(), channel: 'email',
        event_type: 'portal.invite', record_type: type, record_id: ctx.params.id,
        payload: { to: email, subject: 'You have been invited to the customer portal', text: `Set your password to get started:\n${link}\n\nThis link expires in 7 days.` },
        status: 'pending', attempts: 0, last_error: '', target_url: '', created_at: nowIso(),
      });
      return { portal_user: portalUser, invite_link: link };
    });
  });

  r.post(`${P}/setup/portal-users/:id/revoke`, async (ctx) => {
    const p = ctx.repo.get('portal_user', ctx.params.id);
    if (!p) throw notFound('Portal user not found');
    requirePermFor(ctx, p.entity_type, LEVEL.FULL);
    return ctx.tx(() => portal.revoke(ctx.repo, ctx.params.id));
  });
}
