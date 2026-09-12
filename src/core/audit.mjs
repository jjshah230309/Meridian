// Meridian ERP :: core/audit
// Append-only audit trail. Financial mutations are always recorded; the
// `financial` flag drives the retention policy and the SOC 2 evidence export.
import { ulid, nowIso, isPlainObject } from './util.mjs';

const FINANCIAL_TYPES = new Set([
  'journal_entry', 'invoice', 'vendor_bill', 'customer_payment', 'vendor_payment',
  'credit_memo', 'accounting_period', 'account', 'payroll_run', 'fulfillment',
  'item_receipt', 'inventory_adjustment', 'reconciliation', 'bank_txn',
]);

/** Fields never written into the audit diff. */
const REDACT = new Set(['password_hash', 'password_salt', 'token_hash', 'national_id_last4', 'bank_last4']);

/** Shallow diff of two records, ignoring noise columns. */
export function diff(before, after) {
  const out = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    if (REDACT.has(k) || k === 'updated_at' || k === 'tenant_id') continue;
    const a = before?.[k]; const b = after?.[k];
    const av = isPlainObject(a) || Array.isArray(a) ? JSON.stringify(a) : a;
    const bv = isPlainObject(b) || Array.isArray(b) ? JSON.stringify(b) : b;
    if (av === bv) continue;
    if ((av ?? null) === null && (bv ?? null) === null) continue;
    out[k] = { from: av ?? null, to: bv ?? null };
  }
  return out;
}

/**
 * Write an audit row. Called inside the same transaction as the mutation so
 * a rolled-back change leaves no audit ghost, and a committed change can
 * never lack its trail.
 */
export function record(repo, { recordType, recordId, action, before, after, changes, note }) {
  const ctx = repo.ctx || {};
  const body = changes ?? (before || after ? diff(before, after) : {});
  if (note) body.__note = { from: null, to: note };
  repo.db.$prepare(`INSERT INTO audit_event
      (id, tenant_id, at, user_id, user_label, record_type, record_id, action, changes, ip, request_id, financial)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ulid(), repo.tenantId, nowIso(), ctx.user?.id ?? null, ctx.user?.name || ctx.user?.email || 'system',
      recordType, recordId ?? null, action, JSON.stringify(body), ctx.ip || '', ctx.requestId || '',
      FINANCIAL_TYPES.has(recordType) ? 1 : 0);
}

/** Audit history for one record, newest first. */
export const historyFor = (repo, recordType, recordId, limit = 100) =>
  repo.query(`SELECT * FROM audit_event WHERE tenant_id = :t AND record_type = ? AND record_id = ?
              ORDER BY at DESC LIMIT ?`, [recordType, recordId, limit]);
