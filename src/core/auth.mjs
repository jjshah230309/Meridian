// Meridian ERP :: core/auth
// Password hashing, sessions, CSRF, and API tokens.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ulid, randomToken, sha256, nowIso, timingSafeEqual } from './util.mjs';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const SESSION_COOKIE = 'meridian_sid';
export const SESSION_TTL_HOURS = 12;
const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MINUTES = 15;

/** Process-wide secret used to derive CSRF tokens. Persisted, 0600. */
export function loadServerSecret(dataDir) {
  const p = path.join(dataDir, 'secret.key');
  try {
    const v = fs.readFileSync(p, 'utf8').trim();
    if (v.length >= 43) return v;
  } catch { /* create below */ }
  const secret = randomToken(32);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(p, secret, { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* windows */ }
  return secret;
}

// ------------------------------------------------------------ passwords
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  try {
    const test = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }).toString('hex');
    return timingSafeEqual(test, hash);
  } catch { return false; }
}

export function passwordProblems(pw) {
  const p = String(pw || '');
  const out = [];
  if (p.length < 10) out.push('must be at least 10 characters');
  if (!/[a-z]/.test(p)) out.push('needs a lowercase letter');
  if (!/[A-Z]/.test(p)) out.push('needs an uppercase letter');
  if (!/[0-9]/.test(p)) out.push('needs a digit');
  if (/^(password|meridian|welcome|12345)/i.test(p)) out.push('is too common');
  return out;
}

// ------------------------------------------------------------- sessions
/** The raw token goes to the client; only its digest is stored. */
export function createSession(db, { tenantId, userId, ip = '', userAgent = '', ttlHours = SESSION_TTL_HOURS }) {
  const token = randomToken(32);
  const id = sha256(token);
  const now = new Date();
  const expires = new Date(now.getTime() + ttlHours * 3600_000);
  db.prepare(`INSERT INTO session (id, tenant_id, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, tenantId, userId, now.toISOString(), expires.toISOString(), now.toISOString(), ip, String(userAgent).slice(0, 250));
  return { token, id, expiresAt: expires.toISOString() };
}

export function readSession(db, token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM session WHERE id = ?').get(sha256(token));
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) {
    db.prepare('DELETE FROM session WHERE id = ?').run(row.id);
    return null;
  }
  const now = nowIso();
  // Touch at most once a minute to avoid a write on every request.
  if (Date.parse(now) - Date.parse(row.last_seen_at) > 60_000) {
    db.prepare('UPDATE session SET last_seen_at = ? WHERE id = ?').run(now, row.id);
  }
  return row;
}

export const destroySession = (db, token) => { if (token) db.prepare('DELETE FROM session WHERE id = ?').run(sha256(token)); };
export const destroyUserSessions = (db, tenantId, userId) =>
  db.prepare('DELETE FROM session WHERE tenant_id = ? AND user_id = ?').run(tenantId, userId);
export const purgeExpiredSessions = (db) =>
  db.prepare('DELETE FROM session WHERE expires_at < ?').run(nowIso()).changes;

// ----------------------------------------------------------------- CSRF
// Double-submit, stateless: the token is an HMAC over the session id, so it
// is unforgeable without the server secret and needs no extra storage.
// Required on every state-changing request that authenticates via cookie.
export const csrfFor = (secret, sessionId) =>
  crypto.createHmac('sha256', secret).update('csrf:' + sessionId).digest('base64url');

export const csrfValid = (secret, sessionId, presented) =>
  !!presented && timingSafeEqual(csrfFor(secret, sessionId), presented);

// ----------------------------------------------------------- login flow
export function authenticate(db, { tenantId, email, password, ip, userAgent }) {
  const user = db.prepare('SELECT * FROM app_user WHERE tenant_id = ? AND lower(email) = lower(?)').get(tenantId, String(email || ''));
  // Verify the password (or a decoy hash of identical cost) before branching
  // on account state. Disabled and locked accounts used to skip this and
  // return immediately, so they answered measurably faster than a wrong
  // password or a missing account -- letting an unauthenticated caller learn
  // which of the four cases applies from timing alone, on top of the reason.
  const passwordOk = user
    ? verifyPassword(password, user.password_hash, user.password_salt)
    : (crypto.scryptSync('decoy', 'decoy', SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }), false);
  if (!user) return { ok: false, reason: 'invalid_credentials' };
  if (user.status !== 'active') return { ok: false, reason: 'account_disabled' };
  if (user.locked_until && Date.parse(user.locked_until) > Date.now()) {
    return { ok: false, reason: 'account_locked', until: user.locked_until };
  }
  if (!passwordOk) {
    const failed = (user.failed_logins || 0) + 1;
    const lock = failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MINUTES * 60000).toISOString() : null;
    db.prepare('UPDATE app_user SET failed_logins = ?, locked_until = ? WHERE tenant_id = ? AND id = ?')
      .run(failed, lock, tenantId, user.id);
    return { ok: false, reason: lock ? 'account_locked' : 'invalid_credentials', until: lock };
  }
  db.prepare('UPDATE app_user SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE tenant_id = ? AND id = ?')
    .run(nowIso(), tenantId, user.id);
  const session = createSession(db, { tenantId, userId: user.id, ip, userAgent });
  return { ok: true, user, session };
}

// ----------------------------------------------------------- API tokens
export function issueApiToken(db, { tenantId, userId, name, scopes = ['*'], expiresAt = null }) {
  const raw = 'mrd_' + randomToken(24);
  const id = ulid();
  db.prepare(`INSERT INTO api_token (id, tenant_id, user_id, name, token_hash, prefix, scopes, created_at, expires_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, tenantId, userId, name, sha256(raw), raw.slice(0, 12), JSON.stringify(scopes), nowIso(), expiresAt);
  return { id, token: raw, prefix: raw.slice(0, 12) };   // shown once, never recoverable
}

export function readApiToken(db, raw) {
  if (!raw || !raw.startsWith('mrd_')) return null;
  const row = db.prepare('SELECT * FROM api_token WHERE token_hash = ?').get(sha256(raw));
  if (!row || row.revoked_at) return null;
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return null;
  db.prepare('UPDATE api_token SET last_used_at = ? WHERE tenant_id = ? AND id = ?').run(nowIso(), row.tenant_id, row.id);
  return row;
}
