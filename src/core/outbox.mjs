// Meridian ERP :: core/outbox
// Delivers rows queued in integration_event: a webhook POST, or (through
// core/smtp.mjs) an email. This is the worker the table's own header
// comment in migrations/005_hr.sql always assumed existed -- "Deliveries
// are recorded so retries are idempotent and auditable" -- but until this
// file, nothing ever attempted one.
//
// Deliberately NOT delivered here: channel === 'payroll'. There is no
// payroll provider integration in this codebase (see the README's "no
// statutory tax engine" scope note) -- that channel is a pull surface for
// a provider that polls GET /setup/integration-events, not a push target.
// Draining it here would fabricate a delivery that doesn't correspond to
// anything real, so payroll rows are left exactly as queued.
//
// Runs across every tenant, so it works in raw SQL against `db` rather
// than through a tenant-scoped Repo -- the same reasoning as server.mjs's
// existing housekeeping job.
import crypto from 'node:crypto';
import { nowIso } from './util.mjs';
import { logger as defaultLogger } from './logger.mjs';

const MAX_ATTEMPTS = 8;
const BATCH_SIZE = 20;
const TIMEOUT_MS = 10_000;
const KNOWN_CHANNELS = new Set(['webhook', 'email']);

/** Exponential backoff capped at an hour, with a little jitter so a burst
 * of failures doesn't all retry in lockstep. */
function backoffMs(attempts) {
  return Math.min(2 ** attempts * 30_000, 3_600_000) + Math.floor(Math.random() * 1000);
}

/** HMAC over the raw request body, the same construction auth.csrfFor uses
 * for CSRF -- so a webhook receiver can verify a payload came from this
 * server and was not altered in transit, without either side needing a
 * secret beyond the one this install already generates and keeps at
 * <data>/secret.key. */
export const signPayload = (secret, body) =>
  crypto.createHmac('sha256', secret).update(body).digest('hex');

async function deliverWebhook(row, { secret, fetchImpl }) {
  const body = row.payload; // already a JSON string; sign exactly what is sent
  const res = await fetchImpl(row.target_url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Meridian-Event': row.event_type,
      'X-Meridian-Signature': `sha256=${signPayload(secret, body)}`,
    },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`webhook responded ${res.status}`);
}

async function deliverEmail(row, { db, sendMail }) {
  // core/smtp.mjs's tenant-settings-aware sender, injected rather than
  // imported directly: outbox.mjs has no hard dependency on smtp.mjs, so a
  // webhook-only test can drain a batch with no SMTP code loaded at all,
  // and a deployment that never configures email never pays for it either.
  if (!sendMail) throw new Error('email is not configured for this install');
  await sendMail(db, row.tenant_id, JSON.parse(row.payload));
}

/**
 * Attempt delivery of every due row, once. Called on a timer in production
 * (see server.mjs) and directly, awaited, in tests -- so a test never has
 * to wait on the real interval to see whether a row was delivered.
 */
export async function drainOnce(db, {
  fetchImpl = fetch, secret = '', sendMail = null, now = nowIso, logger = defaultLogger,
} = {}) {
  const cutoff = now();
  const rows = db.prepare(
    `SELECT * FROM integration_event
     WHERE status = 'pending' AND channel != 'payroll'
       AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY created_at LIMIT ?`,
  ).all(cutoff, BATCH_SIZE);

  let delivered = 0, retried = 0, failed = 0, skipped = 0;
  for (const row of rows) {
    if (!KNOWN_CHANNELS.has(row.channel)) {
      db.prepare(`UPDATE integration_event SET status = 'skipped' WHERE tenant_id = ? AND id = ?`)
        .run(row.tenant_id, row.id);
      skipped++;
      continue;
    }
    try {
      if (row.channel === 'webhook') await deliverWebhook(row, { secret, fetchImpl });
      else await deliverEmail(row, { db, sendMail });
      db.prepare(`UPDATE integration_event SET status = 'delivered', delivered_at = ? WHERE tenant_id = ? AND id = ?`)
        .run(now(), row.tenant_id, row.id);
      delivered++;
    } catch (e) {
      const attempts = row.attempts + 1;
      const lastError = String(e?.message || e).slice(0, 2000);
      if (attempts >= MAX_ATTEMPTS) {
        db.prepare(`UPDATE integration_event SET status = 'failed', attempts = ?, last_error = ? WHERE tenant_id = ? AND id = ?`)
          .run(attempts, lastError, row.tenant_id, row.id);
        failed++;
      } else {
        const nextAt = new Date(Date.parse(now()) + backoffMs(attempts)).toISOString();
        db.prepare(`UPDATE integration_event SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE tenant_id = ? AND id = ?`)
          .run(attempts, lastError, nextAt, row.tenant_id, row.id);
        retried++;
      }
      logger.warn(`outbox: ${row.channel} delivery to tenant ${row.tenant_id} failed`, e);
    }
  }
  return { scanned: rows.length, delivered, retried, failed, skipped };
}
