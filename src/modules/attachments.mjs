// Meridian ERP :: modules/attachments
// A file attached to any record or transaction -- a receipt, a signed PO, a
// contract. Bytes live in a BLOB column (migration 035); a size cap and a
// referential check on the way in keep this from becoming an unbounded or
// spoofable dumping ground.
import { ulid, nowIso } from '../core/util.mjs';
import { badRequest, notFound, forbidden, unprocessable } from '../core/http.mjs';
import * as meta from './meta.mjs';
import * as rbac from '../core/rbac.mjs';
import * as audit from '../core/audit.mjs';

export const MAX_SIZE = 20 * 1024 * 1024; // 20MB

/**
 * Resolve `record_type` to the metadata that governs it, and confirm the
 * record it names actually exists and is visible to this caller -- not just
 * that some row with that id exists in whatever table the type happens to
 * share. A transaction type shares the `txn` table across a dozen document
 * kinds, and a custom type shares `custom_record` across every one a tenant
 * has defined, so an id from one type is a real row under another type's
 * table name; without checking the row's own `type`/`type_name`, a caller
 * could attach to (or read) a record it only has permission to reach under
 * a different, looser-permissioned type name.
 */
export function resolveTarget(repo, access, recordType, recordId) {
  const m = meta.getMeta(recordType, repo);
  if (!m) throw notFound(`Unknown record type "${recordType}"`);
  const row = repo.get(m.table, recordId);
  const matches = row && (
    (m.isTransaction && row.type === m.txnType)
    || (m.isCustom && row.type_name === m.customType)
    || (!m.isTransaction && !m.isCustom)
  );
  if (!matches) throw notFound('Record not found');
  if (!rbac.canSeeRow(access, m.table, row)) throw forbidden('You do not have access to that record.');
  return { meta: m, row };
}

export function list(repo, access, recordType, recordId) {
  resolveTarget(repo, access, recordType, recordId);
  return repo.query(
    `SELECT id, record_type, record_id, filename, content_type, size, uploaded_by, created_at
     FROM attachment WHERE tenant_id = :t AND record_type = ? AND record_id = ? ORDER BY created_at DESC`,
    [recordType, recordId]);
}

/** Full row, including bytes -- for download only. */
export function get(repo, access, id) {
  const row = repo.get('attachment', id);
  if (!row) throw notFound('Attachment not found');
  resolveTarget(repo, access, row.record_type, row.record_id);
  return row;
}

export function create(repo, access, { record_type, record_id, filename, content_type, bytes }) {
  if (!filename || !String(filename).trim()) throw badRequest('A filename is required');
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw badRequest('The file is empty');
  if (bytes.length > MAX_SIZE) throw unprocessable(`That file is ${(bytes.length / 1024 / 1024).toFixed(1)}MB; the limit is ${MAX_SIZE / 1024 / 1024}MB.`);
  resolveTarget(repo, access, record_type, record_id);

  const id = ulid();
  return repo.tx(() => {
    repo.insert('attachment', {
      id, record_type, record_id,
      filename: String(filename).trim().slice(0, 255),
      content_type: content_type || 'application/octet-stream',
      size: bytes.length, bytes,
      uploaded_by: repo.ctx?.user?.id || null,
      created_at: nowIso(),
    });
    audit.record(repo, {
      recordType: record_type, recordId: record_id, action: 'attach',
      changes: { attachment: { from: null, to: filename } },
    });
    return { id, record_type, record_id, filename, content_type: content_type || 'application/octet-stream', size: bytes.length, created_at: nowIso() };
  });
}

export function remove(repo, access, id) {
  const row = repo.get('attachment', id);
  if (!row) throw notFound('Attachment not found');
  resolveTarget(repo, access, row.record_type, row.record_id);
  repo.tx(() => {
    repo.exec('DELETE FROM attachment WHERE tenant_id = :t AND id = ?', [id]);
    audit.record(repo, {
      recordType: row.record_type, recordId: row.record_id, action: 'detach',
      changes: { attachment: { from: row.filename, to: null } },
    });
  });
  return { ok: true };
}
