// Meridian ERP :: modules/bankfeeds
// Live bank feeds via GoCardless Bank Account Data (formerly Nordigen):
// link a real bank account through its hosted consent flow, then pull
// transactions into the exact same bank.importStatement() a manual CSV
// upload already goes through -- external_id is what makes either import
// idempotent, so a feed re-synced on overlapping days never duplicates a
// line a CSV import (or an earlier sync) already brought in.
import { ulid, nowIso, addDays, today } from '../core/util.mjs';
import { notFound, unprocessable, ValidationError } from '../core/http.mjs';
import { encryptSecret, decryptSecret } from '../core/auth.mjs';
import * as audit from '../core/audit.mjs';
import * as bank from './bank.mjs';

const GC_KEY = 'meridian:gocardless';
const BASE = 'https://bankaccountdata.gocardless.com/api/v2';
// A feed syncs every 6 hours (server.mjs); go back a little further than
// that on every call so a transaction that was still `pending` at the last
// sync is picked up once it books, without re-importing what already came
// in as `external_id` already makes idempotent either way.
const OVERLAP_DAYS = 7;

// ---------------------------------------------------------------- token
// GoCardless's own access token, not a Meridian session -- cached per
// secret_id (the credential identifies the GoCardless account, not this
// tenant) so a sync every few hours doesn't mint a fresh token every time.
const tokenCache = new Map(); // secret_id -> { access, expiresAt }

async function getToken(secretId, secretKey, fetchImpl) {
  const cached = tokenCache.get(secretId);
  if (cached && Date.parse(cached.expiresAt) > Date.now() + 60_000) return cached.access;
  const res = await fetchImpl(`${BASE}/token/new/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret_id: secretId, secret_key: secretKey }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw unprocessable(body?.detail || body?.summary || `GoCardless rejected those credentials (${res.status}).`);
  tokenCache.set(secretId, { access: body.access, expiresAt: new Date(Date.now() + (body.access_expires || 86400) * 1000).toISOString() });
  return body.access;
}

async function gcFetch(path, { secretId, secretKey, fetchImpl, method = 'GET', body } = {}) {
  const access = await getToken(secretId, secretKey, fetchImpl);
  const res = await fetchImpl(`${BASE}${path}`, {
    method, headers: { Authorization: `Bearer ${access}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 429) {
    const retryAfter = res.headers.get?.('retry-after') || res.headers.get?.('Retry-After');
    throw unprocessable(`GoCardless is rate-limiting this account${retryAfter ? ` — try again in ${retryAfter}s` : ' — try again later'}.`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw unprocessable(json?.detail || json?.summary || `GoCardless returned an error (${res.status}).`);
  return json;
}

// -------------------------------------------------------------- settings
export function getFeedSettings(repo) {
  const row = repo.queryOne('SELECT settings FROM tenant WHERE id = :t');
  const g = row?.settings?.bank_feeds || {};
  return { has_credentials: !!(g.secret_id && g.secret_key_enc) };
}

export function resolveFeedSettings(repo, config) {
  const row = repo.queryOne('SELECT settings FROM tenant WHERE id = :t');
  const g = row?.settings?.bank_feeds || {};
  if (!g.secret_id) return null;
  let secretKey = '';
  try { secretKey = g.secret_key_enc ? decryptSecret(config.secret, g.secret_key_enc, GC_KEY) : ''; } catch { secretKey = ''; }
  if (!secretKey) return null;
  return { secretId: g.secret_id, secretKey };
}

export function setFeedSettings(repo, config, patch = {}) {
  const row = repo.queryOne('SELECT settings FROM tenant WHERE id = :t');
  const settings = row?.settings || {};
  const existing = settings.bank_feeds || {};
  const g = {
    secret_id: patch.secret_id !== undefined ? String(patch.secret_id || '').trim() : (existing.secret_id || ''),
    secret_key_enc: patch.clear_secret_key ? null
      : (patch.secret_key ? encryptSecret(config.secret, patch.secret_key, GC_KEY) : (existing.secret_key_enc || null)),
  };
  repo.exec('UPDATE tenant SET settings = ? WHERE id = :t', [JSON.stringify({ ...settings, bank_feeds: g })]);
  audit.record(repo, { recordType: 'setup', recordId: 'bank_feeds', action: 'update', changes: {} });
  return getFeedSettings(repo);
}

export async function testConnection(secretId, secretKey, { fetchImpl = fetch } = {}) {
  if (!secretId || !secretKey) throw new ValidationError({ secret_id: 'Enter both the secret id and secret key' });
  await getToken(secretId, secretKey, fetchImpl);
  return { ok: true };
}

// ------------------------------------------------------------ linking
export async function listInstitutions(repo, config, country, { fetchImpl = fetch } = {}) {
  const settings = resolveFeedSettings(repo, config);
  if (!settings) throw unprocessable('Connect a GoCardless Bank Account Data account first, under Setup → Integrations.');
  const list = await gcFetch(`/institutions/?country=${encodeURIComponent(country || 'gb')}`, { ...settings, fetchImpl });
  return list.map((i) => ({ id: i.id, name: i.name, bic: i.bic || '', logo: i.logo || '', transaction_days: i.transaction_total_days }));
}

/** Start the hosted consent flow. The bank account is only linked once startLinkCallback runs, after the user completes it there. */
export async function startLink(repo, config, { bankAccountId, institutionId, redirectUrl, fetchImpl = fetch }) {
  const ba = repo.get('bank_account', bankAccountId);
  if (!ba) throw notFound('Bank account not found');
  const settings = resolveFeedSettings(repo, config);
  if (!settings) throw unprocessable('Connect a GoCardless Bank Account Data account first.');

  const req = await gcFetch('/requisitions/', {
    ...settings, fetchImpl, method: 'POST',
    body: { redirect: redirectUrl, institution_id: institutionId, reference: bankAccountId },
  });

  const now = nowIso();
  const existing = repo.queryOne('SELECT * FROM bank_feed WHERE tenant_id = :t AND bank_account_id = ?', [bankAccountId]);
  if (existing) {
    repo.update('bank_feed', existing.id, {
      requisition_id: req.id, institution_id: institutionId, institution_name: '',
      external_account_id: null, status: 'pending', last_error: '', updated_at: now,
    });
  } else {
    repo.insert('bank_feed', {
      id: ulid(), bank_account_id: bankAccountId, requisition_id: req.id,
      institution_id: institutionId, institution_name: '', external_account_id: null,
      status: 'pending', last_synced_at: null, last_error: '', access_expires_at: null,
      created_at: now, updated_at: now,
    });
  }
  return { link: req.link };
}

/** Called when the user lands back from GoCardless's consent page. */
export async function completeLink(repo, config, requisitionId, { fetchImpl = fetch } = {}) {
  const feed = repo.queryOne('SELECT * FROM bank_feed WHERE tenant_id = :t AND requisition_id = ?', [requisitionId]);
  if (!feed) throw notFound('No pending bank feed link matches that requisition.');
  const settings = resolveFeedSettings(repo, config);
  if (!settings) throw unprocessable('Bank feed credentials are no longer configured.');

  const req = await gcFetch(`/requisitions/${requisitionId}/`, { ...settings, fetchImpl });
  if (req.status !== 'LN' || !req.accounts?.length) {
    repo.update('bank_feed', feed.id, { status: req.status === 'RJ' || req.status === 'EX' ? 'expired' : 'pending', updated_at: nowIso() });
    return repo.get('bank_feed', feed.id);
  }
  const accountId = req.accounts[0];
  const details = await gcFetch(`/accounts/${accountId}/details/`, { ...settings, fetchImpl }).catch(() => ({}));
  repo.update('bank_feed', feed.id, {
    external_account_id: accountId, status: 'linked',
    institution_name: details?.account?.institution_id || feed.institution_id,
    updated_at: nowIso(),
  });
  return repo.get('bank_feed', feed.id);
}

export function disconnect(repo, bankAccountId) {
  const feed = repo.queryOne('SELECT * FROM bank_feed WHERE tenant_id = :t AND bank_account_id = ?', [bankAccountId]);
  if (!feed) throw notFound('No bank feed is connected to that account.');
  repo.remove('bank_feed', feed.id);
  audit.record(repo, { recordType: 'bank_account', recordId: bankAccountId, action: 'disconnect_feed', changes: {} });
  return { ok: true };
}

// -------------------------------------------------------------- syncing
/** Pull transactions since the last sync (with overlap) and import them. */
export async function syncFeed(repo, config, bankAccountId, { fetchImpl = fetch } = {}) {
  const feed = repo.queryOne('SELECT * FROM bank_feed WHERE tenant_id = :t AND bank_account_id = ?', [bankAccountId]);
  if (!feed) throw notFound('No bank feed is connected to that account.');
  if (feed.status !== 'linked') throw unprocessable(`This feed is ${feed.status}. Reconnect it first.`);
  const settings = resolveFeedSettings(repo, config);
  if (!settings) throw unprocessable('Bank feed credentials are no longer configured.');

  const since = feed.last_synced_at ? addDays(feed.last_synced_at.slice(0, 10), -OVERLAP_DAYS) : addDays(today(), -90);
  let data;
  try {
    data = await gcFetch(`/accounts/${feed.external_account_id}/transactions/?date_from=${since}`, { ...settings, fetchImpl });
  } catch (e) {
    repo.update('bank_feed', feed.id, { status: 'error', last_error: e.message.slice(0, 400), updated_at: nowIso() });
    throw e;
  }

  const booked = data?.transactions?.booked || [];
  const ba = repo.get('bank_account', bankAccountId);
  // Only booked lines -- a `pending` one can still change amount or vanish
  // before it books, and importing it now under its temporary id would
  // either duplicate it or import a line that never actually happened.
  const lines = booked
    .filter((t) => t.transactionAmount?.currency === ba.currency)
    .map((t) => ({
      date: t.bookingDate || t.valueDate, amount: t.transactionAmount.amount,
      description: t.remittanceInformationUnstructured || (t.remittanceInformationUnstructuredArray || []).join(' ') || t.additionalInformation || '',
      reference: t.checkId || t.entryReference || '',
      external_id: t.transactionId || t.internalTransactionId,
    }))
    .filter((l) => l.external_id);

  // The whole batch is one write: syncFeed itself is async (it just
  // awaited GoCardless above) and so cannot be wrapped in repo.tx() by its
  // caller, the same reason createCheckout/startLink aren't -- so the
  // atomicity has to live here instead, around the part that's actually
  // synchronous.
  const result = repo.tx(() => {
    const imported = lines.length ? bank.importStatement(repo, bankAccountId, lines, { source: 'gocardless' }) : { imported: 0, skipped: 0, total: 0 };
    repo.update('bank_feed', feed.id, { status: 'linked', last_synced_at: nowIso(), last_error: '', updated_at: nowIso() });
    return imported;
  });
  return { ...result, pending: (data?.transactions?.pending || []).length };
}

export function listFeeds(repo) {
  return repo.query('SELECT * FROM bank_feed WHERE tenant_id = :t');
}

/** Every linked feed, across every tenant -- the background job's own entry point. */
export function dueFeeds(db) {
  return db.prepare(`SELECT bf.*, ba.currency FROM bank_feed bf
      JOIN bank_account ba ON ba.tenant_id = bf.tenant_id AND ba.id = bf.bank_account_id
      WHERE bf.status = 'linked'`).all();
}
