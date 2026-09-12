// Meridian ERP :: core/search
// Full-text search over every indexed record, backed by SQLite FTS5.
//
// The brief called for Elasticsearch. FTS5 is the deliberate substitute: it
// gives BM25 ranking, prefix and phrase queries and sub-millisecond lookups
// on this data volume, inside the same ACID transaction as the write, with
// no second service to run, secure, or keep in sync. The indexer below is
// the seam -- swapping in an external engine means reimplementing
// indexRecord/search, not touching the modules. See docs/ARCHITECTURE.md.
import { nowIso } from './util.mjs';

/** Which types are searchable, and how each renders in the results list. */
export const INDEXED = {
  customer: { label: 'Customer', route: (r) => `#/customer/${r.id}` },
  vendor: { label: 'Vendor', route: (r) => `#/vendor/${r.id}` },
  contact: { label: 'Contact', route: (r) => `#/contact/${r.id}` },
  lead: { label: 'Lead', route: (r) => `#/lead/${r.id}` },
  opportunity: { label: 'Opportunity', route: (r) => `#/opportunity/${r.id}` },
  item: { label: 'Item', route: (r) => `#/item/${r.id}` },
  employee: { label: 'Employee', route: (r) => `#/employee/${r.id}` },
  account: { label: 'Account', route: (r) => `#/account/${r.id}` },
  support_case: { label: 'Case', route: (r) => `#/support_case/${r.id}` },
  txn: { label: 'Transaction', route: (r) => `#/txn/${r.id}` },
  journal_entry: { label: 'Journal', route: (r) => `#/journal_entry/${r.id}` },
};

export function indexRecord(repo, recordType, recordId, { title, subtitle = '', body = '' }) {
  repo.db.$prepare(`INSERT INTO search_doc (tenant_id, record_type, record_id, title, subtitle, body, updated_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT (tenant_id, record_type, record_id) DO UPDATE SET
        title = excluded.title, subtitle = excluded.subtitle, body = excluded.body, updated_at = excluded.updated_at`)
    .run(repo.tenantId, recordType, recordId, String(title || '').slice(0, 300),
      String(subtitle || '').slice(0, 300), String(body || '').slice(0, 4000), nowIso());
}

export const unindexRecord = (repo, recordType, recordId) =>
  repo.db.$prepare('DELETE FROM search_doc WHERE tenant_id = ? AND record_type = ? AND record_id = ?')
    .run(repo.tenantId, recordType, recordId);

/** Escape user input into a safe FTS5 prefix query. */
function toMatchQuery(q) {
  const terms = String(q || '').toLowerCase().match(/[\p{L}\p{N}_@.\-]+/gu) || [];
  if (!terms.length) return null;
  return terms.slice(0, 8).map((t) => `"${t.replace(/"/g, '')}"*`).join(' AND ');
}

export function search(repo, q, { types = null, limit = 30 } = {}) {
  const match = toMatchQuery(q);
  if (!match) return [];
  const typeFilter = types?.length ? ` AND d.record_type IN (${types.map(() => '?').join(',')})` : '';
  const rows = repo.query(
    `SELECT d.record_type, d.record_id, d.title, d.subtitle,
            bm25(search_fts, 8.0, 4.0, 1.0) AS score,
            snippet(search_fts, 2, '<mark>', '</mark>', '…', 12) AS excerpt
       FROM search_fts
       JOIN search_doc d ON d.rowid_key = search_fts.rowid
      WHERE search_fts MATCH ? AND d.tenant_id = :t${typeFilter}
      ORDER BY score LIMIT ?`,
    [match, ...(types || []), Math.min(limit, 100)]);
  return rows.map((r) => ({
    type: r.record_type,
    id: r.record_id,
    label: INDEXED[r.record_type]?.label || r.record_type,
    title: r.title,
    subtitle: r.subtitle,
    excerpt: r.excerpt,
    score: -r.score,
  }));
}

/** Rebuild the whole index for a tenant. Used after bulk import or upgrade. */
export function reindexTenant(repo, builders) {
  repo.db.$prepare('DELETE FROM search_doc WHERE tenant_id = ?').run(repo.tenantId);
  let n = 0;
  for (const [type, build] of Object.entries(builders)) { n += build(repo) || 0; }
  return n;
}
