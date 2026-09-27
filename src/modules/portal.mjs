// Meridian ERP :: modules/portal
// Customer and vendor self-service: a portal_user is not an app_user -- it
// has no role, no permission row, and every query here is scoped by
// entity_id in the SQL itself rather than through rbac's row filters, which
// know nothing about portal identities at all. A customer can only ever
// see documents where `entity_id = portalUser.entity_id`; there is no
// permission check to bypass because there is no other path to the data.
import { ulid, nowIso, addDays, randomToken, sha256 } from '../core/util.mjs';
import { notFound, unprocessable, ValidationError } from '../core/http.mjs';
import { hashPassword, verifyPassword, passwordProblems } from '../core/auth.mjs';
import * as audit from '../core/audit.mjs';
import * as T from './txn.mjs';
import * as collections from './collections.mjs';

const ENTITY_TYPES = ['customer', 'vendor'];
const INVITE_TTL_DAYS = 7;

const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));

// ------------------------------------------------------------- staff side
export function listForEntity(repo, entityType, entityId) {
  return repo.query('SELECT id, email, status, last_login_at, created_at FROM portal_user WHERE tenant_id = :t AND entity_type = ? AND entity_id = ? ORDER BY created_at DESC', [entityType, entityId]);
}

/**
 * Invite a contact to the portal. Returns the raw invite token once -- the
 * caller (the API route) is what queues the actual email through the
 * outbox, the same "never send inline" rule every other email in this app
 * follows.
 */
export function invite(repo, { entity_type, entity_id, email, contact_id = null }) {
  if (!ENTITY_TYPES.includes(entity_type)) throw new ValidationError({ entity_type: 'Must be customer or vendor' });
  const entity = repo.get(entity_type, entity_id);
  if (!entity) throw notFound(`${entity_type === 'customer' ? 'Customer' : 'Vendor'} not found`);
  if (!emailOk(email)) throw new ValidationError({ email: 'Enter a valid email address' });

  const existing = repo.queryOne('SELECT * FROM portal_user WHERE tenant_id = :t AND lower(email) = lower(?)', [email]);
  if (existing && existing.status === 'active') throw new ValidationError({ email: 'That email already has an active portal account' });
  if (existing && existing.entity_id !== entity_id) {
    throw new ValidationError({ email: 'That email is already invited for a different account' });
  }

  const rawToken = randomToken(24);
  const now = nowIso();
  const patch = {
    entity_type, entity_id, contact_id, email, status: 'invited',
    invite_token_hash: sha256(rawToken), invite_expires_at: addDays(now.slice(0, 10), INVITE_TTL_DAYS),
    invited_by: repo.ctx?.user?.id || null, updated_at: now,
  };
  let id;
  if (existing) { id = existing.id; repo.update('portal_user', id, patch); }
  else { id = repo.insert('portal_user', { id: ulid(), password_hash: null, password_salt: null, failed_logins: 0, created_at: now, ...patch }); }

  audit.record(repo, { recordType: entity_type, recordId: entity_id, action: 'portal_invite', changes: { email: { from: null, to: email } } });
  return { portalUser: repo.get('portal_user', id), token: rawToken };
}

export function revoke(repo, portalUserId) {
  const p = repo.get('portal_user', portalUserId);
  if (!p) throw notFound('Portal user not found');
  repo.update('portal_user', portalUserId, { status: 'revoked', updated_at: nowIso() });
  audit.record(repo, { recordType: p.entity_type, recordId: p.entity_id, action: 'portal_revoke', changes: { email: { from: p.email, to: null } } });
  return repo.get('portal_user', portalUserId);
}

// ------------------------------------------------------------ portal side
export function acceptInvite(repo, { token, password }) {
  const problems = passwordProblems(password);
  if (problems.length) throw new ValidationError({ password: `Password ${problems.join(', ')}` });
  const p = repo.queryOne("SELECT * FROM portal_user WHERE tenant_id = :t AND invite_token_hash = ? AND status = 'invited'", [sha256(token)]);
  if (!p) throw notFound('That invitation link is invalid or has already been used.');
  if (Date.parse(p.invite_expires_at) < Date.now()) throw unprocessable('That invitation has expired. Ask to be invited again.');
  const { hash, salt } = hashPassword(password);
  repo.update('portal_user', p.id, {
    password_hash: hash, password_salt: salt, status: 'active',
    invite_token_hash: null, invite_expires_at: null, updated_at: nowIso(),
  });
  return repo.get('portal_user', p.id);
}

export function setPassword(repo, portalUserId, { current_password, new_password }) {
  const p = repo.get('portal_user', portalUserId);
  if (!p) throw notFound('Portal user not found');
  if (!verifyPassword(current_password, p.password_hash, p.password_salt)) throw new ValidationError({ current_password: 'That is not your current password' });
  const problems = passwordProblems(new_password);
  if (problems.length) throw new ValidationError({ new_password: `Password ${problems.join(', ')}` });
  const { hash, salt } = hashPassword(new_password);
  repo.update('portal_user', portalUserId, { password_hash: hash, password_salt: salt, updated_at: nowIso() });
  return { ok: true };
}

function requirePortalUser(repo) {
  const p = repo.ctx?.portalUser;
  if (!p) throw notFound('Not signed in');
  return p;
}

/** The subset of a document worth showing to the entity it belongs to -- never the whole txn row. */
const PUBLIC_FIELDS = ['id', 'type', 'txn_no', 'txn_date', 'due_date', 'currency', 'total', 'amount_remaining', 'status', 'memo', 'reference'];
const publicDoc = (t) => Object.fromEntries(PUBLIC_FIELDS.map((f) => [f, t[f]]));

const DOC_TYPES = {
  customer: { open: ['INVOICE', 'CREDIT_MEMO'], payments: ['CUSTOMER_PAYMENT'] },
  vendor: { open: ['PURCHASE_ORDER', 'VENDOR_BILL'], payments: ['VENDOR_PAYMENT'] },
};

export function listDocuments(repo, { kind = 'open' } = {}) {
  const p = requirePortalUser(repo);
  const types = DOC_TYPES[p.entity_type][kind === 'payments' ? 'payments' : 'open'];
  const rows = T.listTxns(repo, { entityId: p.entity_id, types, limit: 200 }).rows;
  return rows.map(publicDoc);
}

export function getDocument(repo, id) {
  const p = requirePortalUser(repo);
  const t = T.getTxn(repo, id);
  // A 404, not a 403 -- a portal user should never be able to tell "that
  // isn't yours" apart from "that doesn't exist" for someone else's document.
  if (!t || t.entity_id !== p.entity_id) throw notFound('Document not found');
  return { ...publicDoc(t), lines: (t.lines || []).map((l) => ({ description: l.description, quantity: l.quantity, unit_price: l.unit_price, amount: l.amount })) };
}

export function customerStatement(repo, opts = {}) {
  const p = requirePortalUser(repo);
  if (p.entity_type !== 'customer') throw notFound('Not available');
  return collections.statement(repo, p.entity_id, opts);
}

export function customerStatementPdf(repo, opts = {}) {
  const p = requirePortalUser(repo);
  if (p.entity_type !== 'customer') throw notFound('Not available');
  return collections.statementPdf(repo, p.entity_id, opts);
}
