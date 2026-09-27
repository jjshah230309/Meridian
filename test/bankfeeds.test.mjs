// Live bank feeds via GoCardless Bank Account Data. Every test runs against
// an injected fetchImpl standing in for GoCardless -- the same trade
// payments.test.mjs makes for Stripe -- rather than a live account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant, DATE } from './helpers.mjs';
import * as bankfeeds from '../src/modules/bankfeeds.mjs';

const CONFIG = { secret: 'a-fake-server-secret-at-least-32-bytes-long-1234' };

function account(f) {
  return f.repo.queryOne('SELECT * FROM bank_account WHERE tenant_id = :t LIMIT 1');
}

/** A minimal in-memory stand-in for GoCardless's v2 API, tracking calls made to it. */
function fakeGoCardless({ rateLimitOn = null } = {}) {
  const calls = [];
  let requisitionCounter = 0;
  const requisitions = new Map(); // id -> { status, accounts }
  const fetchImpl = async (fetchUrl, opts = {}) => {
    calls.push({ url: fetchUrl, opts });
    const path = fetchUrl.replace('https://bankaccountdata.gocardless.com/api/v2', '');
    if (rateLimitOn && path.startsWith(rateLimitOn)) {
      return { ok: false, status: 429, headers: { get: () => '60' }, json: async () => ({}) };
    }
    if (path === '/token/new/') {
      const body = JSON.parse(opts.body);
      if (body.secret_id !== 'sid_good') return { ok: false, status: 401, json: async () => ({ detail: 'Wrong credentials' }) };
      return { ok: true, status: 200, json: async () => ({ access: 'access_token_abc', access_expires: 86400 }) };
    }
    if (path.startsWith('/institutions/')) {
      return { ok: true, status: 200, json: async () => ([{ id: 'REVOLUT_REVOGB21', name: 'Revolut', bic: 'REVOGB21', logo: '', transaction_total_days: 90 }]) };
    }
    if (path === '/requisitions/') {
      const id = `req_${++requisitionCounter}`;
      requisitions.set(id, { status: 'CR', accounts: [] });
      return { ok: true, status: 201, json: async () => ({ id, link: `https://ob.gocardless.com/psd2/start/${id}` }) };
    }
    if (/^\/requisitions\/(req_\d+)\/$/.test(path)) {
      const id = path.match(/req_\d+/)[0];
      const req = requisitions.get(id);
      if (!req) return { ok: false, status: 404, json: async () => ({ detail: 'not found' }) };
      return { ok: true, status: 200, json: async () => ({ status: req.status, accounts: req.accounts }) };
    }
    if (/^\/accounts\/(acct_\w+)\/details\/$/.test(path)) {
      return { ok: true, status: 200, json: async () => ({ account: { institution_id: 'REVOLUT_REVOGB21' } }) };
    }
    if (/^\/accounts\/(acct_\w+)\/transactions\/\?date_from=/.test(path)) {
      return { ok: true, status: 200, json: async () => ({ transactions: { booked: [], pending: [] } }) };
    }
    throw new Error(`fakeGoCardless: unhandled path ${path}`);
  };
  return {
    calls, fetchImpl,
    completeRequisition(id, accountId) { requisitions.set(id, { status: 'LN', accounts: [accountId] }); },
  };
}

test('getting a token caches it, and a wrong secret is refused with a readable message', async () => {
  const f = freshTenant();
  f.tx(() => bankfeeds.setFeedSettings(f.repo, CONFIG, { secret_id: 'sid_good', secret_key: 'key_good' }));
  const gc = fakeGoCardless();

  const list = await bankfeeds.listInstitutions(f.repo, CONFIG, 'gb', { fetchImpl: gc.fetchImpl });
  assert.equal(list[0].name, 'Revolut');
  const tokenCalls = gc.calls.filter((c) => c.url.endsWith('/token/new/'));
  assert.equal(tokenCalls.length, 1);

  // A second call within the token's lifetime must not mint a new one.
  await bankfeeds.listInstitutions(f.repo, CONFIG, 'gb', { fetchImpl: gc.fetchImpl });
  assert.equal(gc.calls.filter((c) => c.url.endsWith('/token/new/')).length, 1, 'the cached token must be reused');

  const badGc = fakeGoCardless();
  await assert.rejects(
    () => bankfeeds.testConnection('sid_bad', 'key_bad', { fetchImpl: badGc.fetchImpl }),
    /Wrong credentials/);
});

test('starting a link, then completing it after the user finishes on GoCardless, links the bank account', async () => {
  const f = freshTenant();
  const ba = account(f);
  f.tx(() => bankfeeds.setFeedSettings(f.repo, CONFIG, { secret_id: 'sid_good', secret_key: 'key_good' }));
  const gc = fakeGoCardless();

  const { link } = await bankfeeds.startLink(f.repo, CONFIG, { bankAccountId: ba.id, institutionId: 'REVOLUT_REVOGB21', redirectUrl: 'https://app.test/#/bank-feed-return', fetchImpl: gc.fetchImpl });
  assert.match(link, /^https:\/\/ob\.gocardless\.com/);

  const pending = f.repo.queryOne('SELECT * FROM bank_feed WHERE tenant_id = :t AND bank_account_id = ?', [ba.id]);
  assert.equal(pending.status, 'pending');

  // Not yet finished on GoCardless's side.
  const stillPending = await bankfeeds.completeLink(f.repo, CONFIG, pending.requisition_id, { fetchImpl: gc.fetchImpl });
  assert.equal(stillPending.status, 'pending');

  gc.completeRequisition(pending.requisition_id, 'acct_123');
  const linked = await bankfeeds.completeLink(f.repo, CONFIG, pending.requisition_id, { fetchImpl: gc.fetchImpl });
  assert.equal(linked.status, 'linked');
  assert.equal(linked.external_account_id, 'acct_123');
});

test('syncing imports booked transactions, a re-sync does not duplicate them, and pending transactions are never imported', async () => {
  const f = freshTenant();
  const ba = account(f);
  f.tx(() => bankfeeds.setFeedSettings(f.repo, CONFIG, { secret_id: 'sid_good', secret_key: 'key_good' }));
  const gc = fakeGoCardless();
  await bankfeeds.startLink(f.repo, CONFIG, { bankAccountId: ba.id, institutionId: 'REVOLUT_REVOGB21', redirectUrl: 'https://app.test', fetchImpl: gc.fetchImpl });
  const feedRow = f.repo.queryOne('SELECT * FROM bank_feed WHERE tenant_id = :t AND bank_account_id = ?', [ba.id]);
  gc.completeRequisition(feedRow.requisition_id, 'acct_123');
  await bankfeeds.completeLink(f.repo, CONFIG, feedRow.requisition_id, { fetchImpl: gc.fetchImpl });

  // Override the transactions endpoint for this test with real booked + pending lines.
  const booked = [
    { transactionId: 'tx1', bookingDate: DATE, transactionAmount: { amount: '-12.50', currency: ba.currency }, remittanceInformationUnstructured: 'Coffee' },
    { transactionId: 'tx2', bookingDate: DATE, transactionAmount: { amount: '100.00', currency: ba.currency }, remittanceInformationUnstructured: 'Deposit' },
  ];
  const pending = [{ transactionId: 'tx3', transactionAmount: { amount: '-5.00', currency: ba.currency } }];
  const withTxns = { ...gc, fetchImpl: async (url, opts) => {
    if (/\/transactions\/\?date_from=/.test(url)) return { ok: true, status: 200, json: async () => ({ transactions: { booked, pending } }) };
    return gc.fetchImpl(url, opts);
  } };

  const first = await bankfeeds.syncFeed(f.repo, CONFIG, ba.id, { fetchImpl: withTxns.fetchImpl });
  assert.equal(first.imported, 2);
  assert.equal(first.pending, 1);

  const rows = f.repo.query("SELECT * FROM bank_txn WHERE tenant_id = :t AND bank_account_id = ?", [ba.id]);
  assert.equal(rows.length, 2, 'the pending transaction must never be imported');
  assert.ok(rows.every((r) => r.external_id !== 'tx3'));

  const second = await bankfeeds.syncFeed(f.repo, CONFIG, ba.id, { fetchImpl: withTxns.fetchImpl });
  assert.equal(second.imported, 0, 'a re-sync over the same window must not duplicate what is already there');
  assert.equal(second.skipped, 2);

  const feed = f.repo.queryOne('SELECT * FROM bank_feed WHERE tenant_id = :t AND bank_account_id = ?', [ba.id]);
  assert.ok(feed.last_synced_at);
});

test('a 429 from GoCardless is surfaced readably, and syncing an unlinked feed is refused', async () => {
  const f = freshTenant();
  const ba = account(f);
  f.tx(() => bankfeeds.setFeedSettings(f.repo, CONFIG, { secret_id: 'sid_good', secret_key: 'key_good' }));
  const gc = fakeGoCardless({ rateLimitOn: '/institutions/' });
  await assert.rejects(() => bankfeeds.listInstitutions(f.repo, CONFIG, 'gb', { fetchImpl: gc.fetchImpl }), /rate-limiting/);

  await assert.rejects(() => bankfeeds.syncFeed(f.repo, CONFIG, ba.id, { fetchImpl: gc.fetchImpl }), /No bank feed is connected/);
});

test('an expired or rejected requisition is recorded as such, not left "pending" forever', async () => {
  const f = freshTenant();
  const ba = account(f);
  f.tx(() => bankfeeds.setFeedSettings(f.repo, CONFIG, { secret_id: 'sid_good', secret_key: 'key_good' }));
  const gc = fakeGoCardless();
  await bankfeeds.startLink(f.repo, CONFIG, { bankAccountId: ba.id, institutionId: 'REVOLUT_REVOGB21', redirectUrl: 'https://app.test', fetchImpl: gc.fetchImpl });
  const feedRow = f.repo.queryOne('SELECT * FROM bank_feed WHERE tenant_id = :t AND bank_account_id = ?', [ba.id]);
  // Simulate GoCardless reporting the requisition expired.
  const reqId = feedRow.requisition_id;
  const expiredGc = { fetchImpl: async (url, opts) => {
    if (new RegExp(`/requisitions/${reqId}/$`).test(url)) return { ok: true, status: 200, json: async () => ({ status: 'EX', accounts: [] }) };
    return gc.fetchImpl(url, opts);
  } };
  const result = await bankfeeds.completeLink(f.repo, CONFIG, reqId, { fetchImpl: expiredGc.fetchImpl });
  assert.equal(result.status, 'expired');
});

test('secrets are never returned by getFeedSettings, only whether they are set', async () => {
  const f = freshTenant();
  assert.equal(bankfeeds.getFeedSettings(f.repo).has_credentials, false);
  f.tx(() => bankfeeds.setFeedSettings(f.repo, CONFIG, { secret_id: 'sid_good', secret_key: 'key_good' }));
  const settings = bankfeeds.getFeedSettings(f.repo);
  assert.equal(settings.has_credentials, true);
  assert.equal(settings.secret_key, undefined);
  assert.equal(JSON.stringify(settings).includes('key_good'), false);
});

test('disconnecting removes the feed, and a second sync attempt is refused', async () => {
  const f = freshTenant();
  const ba = account(f);
  f.tx(() => bankfeeds.setFeedSettings(f.repo, CONFIG, { secret_id: 'sid_good', secret_key: 'key_good' }));
  const gc = fakeGoCardless();
  await bankfeeds.startLink(f.repo, CONFIG, { bankAccountId: ba.id, institutionId: 'REVOLUT_REVOGB21', redirectUrl: 'https://app.test', fetchImpl: gc.fetchImpl });
  const feedRow = f.repo.queryOne('SELECT * FROM bank_feed WHERE tenant_id = :t AND bank_account_id = ?', [ba.id]);
  gc.completeRequisition(feedRow.requisition_id, 'acct_999');
  await bankfeeds.completeLink(f.repo, CONFIG, feedRow.requisition_id, { fetchImpl: gc.fetchImpl });

  f.tx(() => bankfeeds.disconnect(f.repo, ba.id));
  assert.equal(f.repo.queryOne('SELECT * FROM bank_feed WHERE tenant_id = :t AND bank_account_id = ?', [ba.id]), null);
  await assert.rejects(() => bankfeeds.syncFeed(f.repo, CONFIG, ba.id, { fetchImpl: gc.fetchImpl }), /No bank feed is connected/);
});
