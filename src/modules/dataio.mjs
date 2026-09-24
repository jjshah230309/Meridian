// Meridian ERP :: modules/dataio
// The import and export engine.
//
// Imports run in two passes on purpose. The first validates every row and
// returns the errors without writing anything, so a person can fix a
// spreadsheet before it touches the ledger. The second commits, inside one
// transaction, recording every id it created -- which is what makes
// `reverseImport` possible rather than aspirational.
//
// Column mapping is guessed but never assumed: `suggestMapping` proposes,
// the caller confirms. A silent wrong guess on an amount column is far worse
// than asking.
import { ulid, Money, Qty, nowIso, today, isValidDate, sum } from '../core/util.mjs';
import { ValidationError, notFound, unprocessable, badRequest } from '../core/http.mjs';
import { nextNumber } from '../core/seq.mjs';
import { parseCsv, toCsv } from '../core/csv.mjs';
import { buildXlsx, readXlsx, currencyFormatFor } from '../core/xlsx.mjs';
import { ZipFormatError } from '../core/zip.mjs';
import { buildReportPdf, PAGE } from '../core/pdf.mjs';
import * as meta from './meta.mjs';
import * as records from './records.mjs';
import { TYPES as TXN_TYPES } from './txn.mjs';
import * as audit from '../core/audit.mjs';

export const FORMATS = ['csv', 'xlsx', 'json', 'pdf'];
export const MODES = ['add', 'update', 'upsert'];

/**
 * Business order, not alphabetical: reference data other records point to,
 * then the parties and things a transaction is about, then the transactions
 * themselves, then the postings that reference *those*. A batch import runs
 * in this order so that "customer" exists before "invoice" tries to look one
 * up -- an ordering concern only, entirely separate from per-row validation.
 * Anything not listed runs after everything listed, in the order it arrived.
 */
export const IMPORT_ORDER = [
  'subsidiary', 'location', 'department', 'class', 'currency', 'price_level', 'tax_code', 'account',
  'customer', 'vendor', 'contact', 'employee', 'item', 'bom',
  'quote', 'sales_order', 'purchase_order', 'purchase_requisition',
  'invoice', 'vendor_bill', 'item_receipt', 'credit_memo', 'vendor_credit', 'customer_deposit',
  'customer_payment', 'vendor_payment', 'journal_entry',
];
export const importRank = (recordType) => {
  const i = IMPORT_ORDER.indexOf(recordType);
  return i < 0 ? IMPORT_ORDER.length : i;
};

// --------------------------------------------------------------- mapping
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Aliases the accounting exports people actually have use for these field
// names. Shared between suggestMapping (one record type, real columns) and
// guessRecordType (every record type, scored) so the two can never quietly
// disagree about what "Customer ID" means.
const ALIASES = {
  entity_no: ['customerid', 'customernumber', 'accountnumber', 'code', 'ref'],
  // "Item Name" and "Product Name" are the two most common headers on an
  // actual item export -- QuickBooks, Xero and most inventory systems all
  // use one or the other -- and without them here the single most common
  // column in the single most common bulk-import file (an item list) went
  // unmapped, failing every row on a missing "Name".
  name: ['companyname', 'fullname', 'description', 'title', 'itemname', 'productname'],
  email: ['emailaddress', 'e-mail'],
  phone: ['telephone', 'tel', 'phonenumber', 'mobile'],
  txn_date: ['date', 'transactiondate', 'invoicedate', 'postingdate'],
  due_date: ['duedate', 'paymentdue'],
  total: ['amount', 'grosstotal', 'invoicetotal', 'value'],
  sku: ['itemcode', 'productcode', 'partnumber', 'itemnumber'],
  number: ['accountno', 'accountcode', 'glcode', 'nominalcode'],
  quantity: ['qty', 'units'],
  base_price: ['price', 'unitprice', 'listprice', 'salesprice', 'saleprice'],
  standard_cost: ['cost', 'unitcost'],
  memo: ['notes', 'note', 'comment', 'reference', 'narrative'],
};

/** Match one record type's fields against a header list, without deciding anything. */
function matchHeaders(recordType, headers, repo = null, prefetched = null) {
  const m = prefetched || meta.getMeta(recordType, repo);
  const fields = (m?.fields || []).filter((f) => !f.readOnly);
  const mapping = {};
  const unmatched = [];
  for (const h of headers) {
    const n = norm(h);
    if (!n) continue;
    const hit = fields.find((f) => norm(f.name) === n)
      || fields.find((f) => norm(f.label) === n)
      || fields.find((f) => (ALIASES[f.name] || []).some((a) => norm(a) === n));
    if (!hit && /^custom[._]/i.test(h)) { mapping[h] = h.replace(/^custom[._]/i, 'custom.'); continue; }
    if (hit) mapping[h] = hit.name; else unmatched.push(h);
  }
  return { m, fields, mapping, unmatched };
}

/**
 * Propose a header -> field mapping.
 * Matches on the field name, its label, and a small set of the aliases
 * accounting exports actually use.
 */
export function suggestMapping(recordType, headers) {
  const m = meta.getMeta(recordType);
  if (!m) throw notFound(`Unknown record type "${recordType}"`);
  const { fields, mapping, unmatched } = matchHeaders(recordType, headers);
  return {
    record_type: recordType, mapping, unmatched,
    fields: fields.map((f) => ({ name: f.name, label: f.label, type: f.type, required: !!f.required, ref: f.ref || null })),
  };
}

/**
 * Which record type a sheet is probably meant for -- one score per type,
 * ranked, never assumed. Used by the bulk-import screen to pre-fill a
 * sensible guess per sheet or file, which the person confirms or changes;
 * it is never trusted to commit anything on its own.
 *
 * Scored on two things: how many of the sheet's columns match that type's
 * fields (as a fraction, so a type with three matching columns out of three
 * beats one with three matching out of thirty), and a bonus when the sheet
 * or file's own name reads like that type's name -- a tab called "Vendor
 * Bills" naming itself is a stronger signal than any column ever is.
 */
export function guessRecordType(headers, hintName = '', { repo = null, permit = null } = {}) {
  const hint = norm(hintName);
  const validHeaders = Math.max(1, headers.filter((h) => norm(h)).length);
  const candidates = meta.listRecordTypes(repo)
    .filter((t) => !permit || permit(t))
    .map((t) => {
      const info = meta.getMeta(t, repo);
      if (!info || !info.fields?.length) return null;
      const { fields, mapping } = matchHeaders(t, headers, repo, info);
      const matched = Object.keys(mapping).length;
      if (!matched) return null;
      // Recall -- how much of *this sheet* the type explains -- carries the
      // score, not how much of the type's own field list got used. A real
      // customer export is often just Name, Email, Phone: three matches out
      // of customer's twenty-odd fields, dividing by field count, used to
      // score below a four-field type like "role" that happens to share
      // two of those names. What a sheet actually is depends on whether its
      // own columns make sense together, not on how large the target
      // record type happens to be.
      const recall = matched / validHeaders;
      // A small bonus for also being a good fit for the type itself, so two
      // types tied on recall (both explain 100% of the sheet) are broken
      // toward the closer match rather than left to mapping-key order.
      const coverage = matched / Math.max(1, fields.length);
      const nameScore = hint && (norm(info.label) === hint || norm(info.plural) === hint) ? 0.5
        : hint && (norm(info.label).includes(hint) || hint.includes(norm(info.label))) ? 0.2 : 0;
      const requiredFields = fields.filter((f) => f.required).map((f) => f.name);
      const requiredMatched = requiredFields.filter((r) => Object.values(mapping).includes(r)).length;
      return {
        record_type: t, label: info.plural, score: Math.min(1, recall * 0.85 + coverage * 0.15 + nameScore),
        matched_fields: matched, total_fields: fields.length,
        required_fields: requiredFields.length, required_matched: requiredMatched,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.required_matched - a.required_matched);
  return candidates;
}

// ------------------------------------------------------------ coercion
const TRUEISH = new Set(['1', 'true', 'yes', 'y', 't', 'on', 'active']);
const FALSEISH = new Set(['0', 'false', 'no', 'n', 'f', 'off', 'inactive', '']);

/**
 * What type of record a `refFrom` reference points to, for one row.
 *
 * Two different things share this mechanism. A transaction's entity_id
 * (driven by entity_type) has no column of its own to map -- entity_type is
 * derived at creation time, not something a spreadsheet supplies, exactly as
 * createTxn itself fills it in from the transaction type rather than from
 * input. An invoice is always about a customer, a vendor bill always about a
 * vendor, so the importer assumes the same default createTxn would.
 *
 * A contact's company_id (driven by company_type) is different: company_type
 * varies per row and IS a column the sheet can supply, mapped like any other
 * field. That value has to be read straight out of this row -- there is no
 * document-type default to fall back on, because "contact" is not even a
 * transaction type.
 */
function refTypeFor(field, m, row, map) {
  const header = Object.keys(map).find((h) => map[h] === field.refFrom);
  if (header && row[header] !== undefined && row[header] !== '') {
    const discriminator = (m?.fields || []).find((f) => f.name === field.refFrom);
    const raw = String(row[header]).trim();
    if (discriminator?.options?.length) {
      return discriminator.options.find((o) => norm(o) === norm(raw)) || null;
    }
    return raw || null;
  }
  return (m?.txnType && TXN_TYPES[m.txnType]?.entity) || null;
}

/** Turn one CSV string into the value the column actually wants. */
function coerce(field, raw, repo, m = null, row = null, map = null) {
  const v = typeof raw === 'string' ? raw.trim() : raw;
  if (v === '' || v === null || v === undefined) return { ok: true, value: null };

  switch (field.type) {
    // Amounts and quantities go back out as the number the file said. The row
    // is handed to the same create/update path the REST API uses, and that
    // path scales into minor units itself -- returning minor units here scaled
    // everything a second time, so a 49.99 price imported as 4,999.00.
    case 'money': {
      // Money.parse/Qty.parse are deliberately forgiving for real callers
      // (a coerced default of 0 is fine once a value is already known-valid)
      // and so collapse anything unparseable to 0 rather than NaN -- which
      // means `Number.isFinite(n)` below can never actually be false. Without
      // this digit check, an imported cell like "N/A" or "TBD" silently
      // became a real, committed amount of zero instead of a caught error.
      if (!/\d/.test(v)) return { ok: false, message: `"${v}" is not an amount` };
      return { ok: true, value: Money.toNumber(Money.parse(v)) };
    }
    case 'qty': {
      if (!/\d/.test(v)) return { ok: false, message: `"${v}" is not a quantity` };
      return { ok: true, value: Qty.toNumber(Qty.parse(v)) };
    }
    case 'number': case 'percent': {
      const n = Number(String(v).replace(/[,%\s]/g, ''));
      if (!Number.isFinite(n)) return { ok: false, message: `"${v}" is not a number` };
      return { ok: true, value: n };
    }
    case 'checkbox': {
      const s = String(v).toLowerCase();
      if (TRUEISH.has(s)) return { ok: true, value: 1 };
      if (FALSEISH.has(s)) return { ok: true, value: 0 };
      return { ok: false, message: `"${v}" is not yes/no` };
    }
    case 'date': case 'datetime': {
      const iso = parseDateLoose(v);
      if (!iso) return { ok: false, message: `"${v}" is not a date the importer recognises (try YYYY-MM-DD)` };
      return { ok: true, value: field.type === 'date' ? iso.slice(0, 10) : iso };
    }
    case 'select': {
      if (!field.options?.length) return { ok: true, value: String(v) };
      const hit = field.options.find((o) => norm(o) === norm(v));
      if (!hit) return { ok: false, message: `"${v}" must be one of: ${field.options.filter(Boolean).join(', ')}` };
      return { ok: true, value: hit };
    }
    case 'reference': {
      const refType = field.ref || (field.refFrom ? refTypeFor(field, m, row, map) : null);
      const resolved = resolveRef(repo, refType, v);
      if (!resolved) {
        return refType
          ? { ok: false, message: `No ${refType} matches "${v}"` }
          : { ok: false, message: `"${v}" cannot be resolved: ${field.label} needs to know which type of record it refers to` };
      }
      return { ok: true, value: resolved };
    }
    case 'json':
      try { return { ok: true, value: typeof v === 'object' ? v : JSON.parse(v) }; }
      catch { return { ok: true, value: { value: String(v) } }; }
    default:
      return { ok: true, value: String(v) };
  }
}

/**
 * Dates as they actually arrive: ISO, Excel serials, slash-separated forms
 * and "15 Jan 2026".
 *
 * 03/04/2026 is genuinely ambiguous and no parser can resolve it from the
 * value alone. Where one part is above 12 that part is the day; otherwise
 * this assumes day-first, and `dateAmbiguity` below reports how many rows
 * were guessed so the importer can warn rather than quietly book a year of
 * transactions into the wrong months.
 */
export function parseDateLoose(v) {
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(s)) {
    const d = new Date(s.replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  // Excel serial date
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const ms = (Number(s) - 25569) * 86400000;
    return new Date(ms).toISOString();
  }
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
  if (m) {
    let a = Number(m[1]), b = Number(m[2]), y = Number(m[3]);
    if (y < 100) y += y < 70 ? 2000 : 1900;
    let day, month;
    if (a > 12) { day = a; month = b; }          // first part cannot be a month
    else if (b > 12) { day = b; month = a; }     // second part cannot be a month
    else { day = a; month = b; }                 // ambiguous: day-first
    const d = new Date(Date.UTC(y, month - 1, day));
    return Number.isNaN(d.getTime()) || d.getUTCMonth() !== month - 1 ? null : d.toISOString();
  }
  m = /^(\d{1,2})[ -]([A-Za-z]{3,})[ -](\d{2,4})$/.exec(s);
  if (m) {
    const d = new Date(`${m[2]} ${m[1]}, ${m[3].length === 2 ? '20' + m[3] : m[3]} UTC`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const fallback = new Date(s);
  return Number.isNaN(fallback.getTime()) ? null : fallback.toISOString();
}

/** True when a slash date could be read either way and was guessed day-first. */
export function isAmbiguousSlashDate(v) {
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(String(v ?? '').trim());
  return !!m && Number(m[1]) <= 12 && Number(m[2]) <= 12 && Number(m[1]) !== Number(m[2]);
}

/** Look a reference up by id, then by its natural key, then by name. */
function resolveRef(repo, refType, value) {
  if (!refType) return null;
  const def = meta.REF_LABEL[refType];
  const table = def?.table || meta.getMeta(refType)?.table || refType;
  const v = String(value).trim();
  const direct = repo.queryOne(`SELECT id FROM ${table} WHERE tenant_id = :t AND id = ?`, [v]);
  if (direct) return direct.id;

  const cols = repo.db.$columns(table);
  const candidates = ['entity_no', 'sku', 'number', 'code', 'asset_tag', 'contract_no',
    'project_no', 'order_no', 'txn_no', 'name', 'email'].filter((c) => cols.has(c));
  for (const c of candidates) {
    const hit = repo.queryOne(`SELECT id FROM ${table} WHERE tenant_id = :t AND ${c} = ? LIMIT 1`, [v]);
    if (hit) return hit.id;
  }
  // Last resort: case-insensitive name match.
  if (cols.has('name')) {
    const hit = repo.queryOne(`SELECT id FROM ${table} WHERE tenant_id = :t AND lower(name) = lower(?) LIMIT 1`, [v]);
    if (hit) return hit.id;
  }
  return null;
}

// --------------------------------------------------------------- import
/**
 * Validate a file against a record type. Writes nothing.
 * Returns per-row errors keyed by source line so the UI can point at them.
 */
export function validateImport(repo, { record_type, text, parsed: given = null, mapping = null, defaults = {}, mode = 'add', key_field = '', delimiter = null }) {
  const m = meta.getMeta(record_type);
  if (!m) throw notFound(`Unknown record type "${record_type}"`);
  if (!MODES.includes(mode)) throw badRequest(`mode must be one of ${MODES.join(', ')}`);

  // `parsed` -- an already-{headers, rows} structure, from a spreadsheet
  // sheet the caller read separately -- takes priority over raw CSV `text`
  // so every caller downstream of this line (coercion, key matching, the
  // preview, the commit) works identically for a CSV row and a spreadsheet
  // row. Neither format knows the other exists.
  const parsed = given || parseCsv(text, { delimiter });
  if (!parsed.rows.length) throw unprocessable('That file has a header but no data rows');

  const map = mapping || suggestMapping(record_type, parsed.headers).mapping;
  const fields = meta.fieldMap(record_type);
  const required = m.fields.filter((f) => f.required && !f.readOnly).map((f) => f.name);
  const mappedFields = new Set([...Object.values(map), ...Object.keys(defaults)]);

  const errors = [];
  const prepared = [];
  // Slash dates where both parts could be a month were guessed day-first.
  let ambiguousDates = 0;
  const missingRequired = required.filter((r) => !mappedFields.has(r));
  if (missingRequired.length && mode !== 'update') {
    for (const r of missingRequired) {
      errors.push({ line: 1, field: r, message: `Required field "${fields[r]?.label || r}" is not mapped to any column` });
    }
  }
  if ((mode === 'update' || mode === 'upsert') && !key_field) {
    errors.push({ line: 1, field: 'key_field', message: 'Updating needs a key field to match existing records on' });
  }

  for (const row of parsed.rows) {
    const values = {};
    let rowFailed = false;
    for (const [header, fieldName] of Object.entries(map)) {
      if (!fieldName) continue;
      const raw = row[header];
      if (fieldName.startsWith('custom.')) {
        values.custom = { ...(values.custom || {}), [fieldName.slice(7)]: raw === '' ? null : raw };
        continue;
      }
      const field = fields[fieldName];
      if (!field) { errors.push({ line: row.__line, field: fieldName, message: `"${fieldName}" is not a field on ${m.label}` }); rowFailed = true; continue; }
      if (field.readOnly) continue;
      const res = coerce(field, raw, repo, m, row, map);
      if (!res.ok) { errors.push({ line: row.__line, field: fieldName, column: header, value: raw, message: res.message }); rowFailed = true; continue; }
      if ((field.type === 'date' || field.type === 'datetime') && isAmbiguousSlashDate(raw)) ambiguousDates++;
      if (res.value !== null) values[fieldName] = res.value;
    }
    for (const [k, v] of Object.entries(defaults)) if (values[k] === undefined) values[k] = v;

    for (const r of required) {
      if (mode === 'update') break;
      if (values[r] === undefined || values[r] === null || values[r] === '') {
        errors.push({ line: row.__line, field: r, message: `${fields[r]?.label || r} is required and this row has no value for it` });
        rowFailed = true;
      }
    }

    let existingId = null;
    if (key_field && (mode === 'update' || mode === 'upsert')) {
      const keyValue = values[key_field] ?? row[Object.keys(map).find((h) => map[h] === key_field)];
      if (keyValue) {
        const hit = repo.queryOne(`SELECT id FROM ${m.table} WHERE tenant_id = :t AND ${key_field} = ? LIMIT 1`, [keyValue]);
        existingId = hit?.id || null;
      }
      if (mode === 'update' && !existingId) {
        errors.push({ line: row.__line, field: key_field, message: `No existing ${m.label} has ${key_field} = "${keyValue}"` });
        rowFailed = true;
      }
    }
    if (!rowFailed) prepared.push({ line: row.__line, values, existingId });
  }

  return {
    record_type, mode, key_field,
    headers: parsed.headers, mapping: map, delimiter: parsed.delimiter,
    ambiguous_dates: ambiguousDates,
    total_rows: parsed.rows.length,
    valid_rows: prepared.length,
    // How many of the good rows land on a record that already exists -- the
    // difference between "importing 400 customers" and "editing 400 customers".
    match_count: prepared.filter((p) => p.existingId).length,
    error_rows: parsed.rows.length - prepared.length,
    errors: errors.slice(0, 500),
    error_count: errors.length,
    preview: prepared.slice(0, 20).map((p) => ({ line: p.line, action: p.existingId ? 'update' : 'create', values: p.values })),
    _prepared: prepared,
  };
}

/**
 * Commit an import. Everything happens in one transaction: a file that fails
 * halfway leaves no partial ledger behind.
 */
export function commitImport(repo, { record_type, text, parsed = null, mapping = null, defaults = {}, mode = 'add', key_field = '', delimiter = null, filename = '', format = 'csv', stop_on_error = true, actor = null }) {
  const validation = validateImport(repo, { record_type, text, parsed, mapping, defaults, mode, key_field, delimiter });
  if (stop_on_error && validation.error_count) {
    throw unprocessable(`${validation.error_count} row${validation.error_count === 1 ? '' : 's'} would not import. Fix them, or re-run with stop_on_error off to import the rest.`);
  }
  const m = meta.getMeta(record_type);

  return repo.tx(() => {
    const jobId = ulid();
    const createdIds = [];
    let created = 0, updated = 0;
    const runtimeErrors = [];

    for (const row of validation._prepared) {
      try {
        // Both branches go through the same dispatch the REST API uses, so an
        // imported record is numbered, validated and audited identically.
        if (m.isTransaction) {
          const doc = records.createRecord(repo, record_type, { ...row.values, lines: row.values.lines || [] });
          createdIds.push(doc.id); created++;
          continue;
        }
        if (row.existingId) {
          records.updateRecord(repo, record_type, row.existingId, row.values);
          updated++;
        } else {
          const made = records.createRecord(repo, record_type, row.values);
          createdIds.push(made.id); created++;
        }
      } catch (e) {
        runtimeErrors.push({ line: row.line, message: e.message });
        if (stop_on_error) throw e;
      }
    }

    repo.insert('import_job', {
      id: jobId, job_no: nextNumber(repo, 'import_job'),
      record_type, filename, format, mode, key_field,
      mapping: validation.mapping, defaults,
      status: runtimeErrors.length ? 'failed' : 'committed',
      total_rows: validation.total_rows,
      valid_rows: validation.valid_rows,
      error_rows: validation.error_rows + runtimeErrors.length,
      created_count: created, updated_count: updated,
      errors: [...validation.errors, ...runtimeErrors].slice(0, 500),
      created_ids: createdIds,
      created_by: actor || null,
      created_at: nowIso(), completed_at: nowIso(),
    });
    audit.record(repo, {
      recordType: 'import_job', recordId: jobId, action: 'import',
      changes: { record_type: { from: null, to: record_type }, created: { from: 0, to: created }, updated: { from: 0, to: updated } },
    });
    return {
      job_id: jobId, record_type, created, updated,
      skipped: validation.error_rows,
      errors: [...validation.errors, ...runtimeErrors].slice(0, 100),
    };
  });
}

/**
 * Undo an import by deleting exactly what it created.
 * Updates are not reversed -- the previous values are in the audit trail but
 * restoring them silently could clobber edits made since, so that is a
 * deliberate manual decision rather than a button.
 */
export function reverseImport(repo, jobId) {
  const job = repo.get('import_job', jobId);
  if (!job) throw notFound(`Import ${jobId} not found`);
  if (job.status === 'reversed') throw unprocessable('That import has already been reversed');
  const m = meta.getMeta(job.record_type);
  if (!m) throw unprocessable(`Record type ${job.record_type} no longer exists`);
  const ids = Array.isArray(job.created_ids) ? job.created_ids : [];
  if (!ids.length) throw unprocessable('That import created no records, so there is nothing to reverse');

  return repo.tx(() => {
    let removed = 0;
    const blocked = [];
    for (const id of ids) {
      try {
        // `posted` is a flag on the row, not a status value — reading it as a
        // status meant this never fired, and an imported invoice that had
        // already hit the ledger was destroyed along with everything that
        // pointed at it.
        const history = records.blockersFor(repo, job.record_type, id);
        if (history) { blocked.push({ id, reason: history }); continue; }
        repo.remove(m.table, id);
        removed++;
      } catch (e) {
        blocked.push({ id, reason: e.message });
      }
    }
    repo.update('import_job', jobId, { status: 'reversed' });
    audit.record(repo, { recordType: 'import_job', recordId: jobId, action: 'reverse', changes: { removed: { from: 0, to: removed } } });
    return { job_id: jobId, removed, blocked };
  });
}

/** A ready-to-fill template file for a record type. */
// ------------------------------------------------------------- spreadsheets
/**
 * Enumerate a workbook's sheets, with a record-type guess for each -- the
 * first thing the bulk-import screen needs before anybody has mapped a
 * single column. Wraps core/xlsx.mjs's reader and adds nothing of its own
 * except the guess and a repo-aware permission filter, so this stays a thin
 * front door onto one xlsx parser rather than a second one.
 */
export function readWorkbook(repo, buffer, { headerRow = {}, permit = null } = {}) {
  const out = parseWorkbook(buffer, headerRow);
  return {
    sheets: out.sheets.map((sheet) => ({
      name: sheet.name,
      headers: sheet.headers,
      row_count: sheet.row_count,
      header_row: sheet.header_row,
      truncated: !!sheet.truncated,
      unreadable: !!sheet.unreadable,
      // Deliberately no `rows` here: this is a preview for the sheet picker,
      // called once per file before anybody has chosen anything, and a
      // workbook can hold years of rows across several tabs. Sending them
      // all back just to list tab names would make "add another file" the
      // slow part of the screen. readWorkbookSheet below is where the real
      // data comes from, fetched only for the one sheet actually being
      // imported.
      guesses: sheet.unreadable ? [] : guessRecordType(sheet.headers, sheet.name, { repo, permit }).slice(0, 5),
    })),
  };
}

const parseWorkbook = (buffer, headerRow) => {
  try { return readXlsx(buffer, { headerRow }); }
  catch (e) { if (e instanceof ZipFormatError) throw unprocessable(e.message); throw e; }
};

/**
 * One sheet's actual headers and rows -- what an import needs, as opposed to
 * what a picker needs. Kept as its own function rather than folded into
 * readWorkbook precisely so that listing a workbook's tabs never has to pay
 * for parsing every row of every tab first.
 */
export function readWorkbookSheet(buffer, sheetName, { headerRow = {} } = {}) {
  const out = parseWorkbook(buffer, headerRow);
  const sheet = sheetName ? out.sheets.find((s) => s.name === sheetName) : out.sheets[0];
  if (!sheet) throw notFound(sheetName ? `No sheet named "${sheetName}" in that file` : 'That file has no sheets');
  if (sheet.unreadable) throw unprocessable(`The sheet "${sheet.name}" could not be read from that workbook`);
  return sheet;
}

/**
 * The one-sheet equivalent of readWorkbook, for a plain CSV/TSV file -- so
 * the bulk-import screen can treat "a workbook" and "a bare text file" as
 * the same thing: something with one or more sheets, each with a guess.
 */
export function describeText(repo, text, { delimiter = null, permit = null, hintName = '' } = {}) {
  const parsed = parseCsv(text, { delimiter });
  if (!parsed.rows.length) throw unprocessable('That file has a header but no data rows');
  return {
    sheets: [{
      name: null, headers: parsed.headers, row_count: parsed.rows.length,
      header_row: 1, truncated: !!parsed.truncated, unreadable: false,
      guesses: guessRecordType(parsed.headers, hintName, { repo, permit }).slice(0, 5),
    }],
  };
}

/**
 * Run several imports as one batch: reference data first, transactions
 * last, so a row that names a customer finds one already there.
 *
 * Each item still runs through the exact single-item validateImport /
 * commitImport pair, in its own transaction -- a batch is an ordering and
 * a combined report on top of imports that are otherwise completely
 * ordinary, not a new kind of import with its own rules. If item 4 of 9
 * fails, items 1-3 stay committed and individually reversible; the report
 * says plainly which succeeded.
 */
export function runBatchValidate(repo, items) {
  const ordered = [...items].sort((a, b) => importRank(a.record_type) - importRank(b.record_type));
  return ordered.map((item) => {
    try {
      const report = validateImport(repo, item);
      delete report._prepared;
      return { ...item.tag, record_type: item.record_type, ok: true, report };
    } catch (e) {
      return { ...item.tag, record_type: item.record_type, ok: false, error: e.message };
    }
  });
}

export function runBatchCommit(repo, items, { actor = null } = {}) {
  const ordered = [...items].sort((a, b) => importRank(a.record_type) - importRank(b.record_type));
  const results = [];
  for (const item of ordered) {
    try {
      const res = commitImport(repo, { ...item, actor });
      results.push({ ...item.tag, record_type: item.record_type, ok: true, ...res });
    } catch (e) {
      // One sheet failing does not unwind the sheets already committed --
      // each is its own transaction and its own reversible job, exactly as
      // if it had been imported on its own a moment earlier.
      results.push({ ...item.tag, record_type: item.record_type, ok: false, error: e.message });
    }
  }
  return {
    results,
    created: results.reduce((a, r) => a + (r.created || 0), 0),
    updated: results.reduce((a, r) => a + (r.updated || 0), 0),
    failed: results.filter((r) => !r.ok).length,
  };
}

export function importTemplate(repo, recordType, { format = 'csv' } = {}) {
  const m = meta.getMeta(recordType);
  if (!m) throw notFound(`Unknown record type "${recordType}"`);
  const fields = m.fields.filter((f) => !f.readOnly && f.type !== 'formula');
  const columns = fields.map((f) => ({
    key: f.name,
    label: f.required ? `${f.label} *` : f.label,
    type: f.type,
  }));
  // One example row that documents the expected shape of each column.
  const example = {};
  for (const f of fields) {
    example[f.name] = f.type === 'date' ? today()
      : f.type === 'datetime' ? nowIso()
        : f.type === 'money' ? '1234.56'
          : f.type === 'qty' || f.type === 'number' ? '1'
            : f.type === 'percent' ? '10'
              : f.type === 'checkbox' ? 'yes'
                : f.type === 'select' ? (f.options?.find(Boolean) || '')
                  : f.type === 'reference' ? `<${f.ref} name or code>`
                    : f.type === 'email' ? 'name@example.com'
                      : '';
  }
  if (format === 'xlsx') {
    return {
      buffer: buildXlsx([
        {
          name: m.plural.slice(0, 31),
          title: `${m.plural} import template`,
          subtitle: 'Required columns are marked *. Delete this example row before importing.',
          columns, rows: [example], autofilter: false,
        },
        {
          name: 'Field guide',
          title: 'What each column expects',
          columns: [
            { key: 'label', label: 'Column', type: 'text' },
            { key: 'type', label: 'Type', type: 'text' },
            { key: 'required', label: 'Required', type: 'text' },
            { key: 'notes', label: 'Notes', type: 'text' },
          ],
          rows: fields.map((f) => ({
            label: f.label, type: f.type, required: f.required ? 'Yes' : '',
            notes: f.type === 'reference' ? `Match by id, code or name of a ${f.ref}`
              : f.type === 'select' ? `One of: ${(f.options || []).filter(Boolean).join(', ')}`
                : f.type === 'date' ? 'YYYY-MM-DD preferred'
                  : f.help || '',
          })),
          autofilter: false,
        },
      ], { title: `${m.plural} import template` }),
      filename: `${recordType}-import-template.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }
  return {
    text: toCsv([example], columns),
    filename: `${recordType}-import-template.csv`,
    contentType: 'text/csv; charset=utf-8',
  };
}

// --------------------------------------------------------------- export
/** Turn stored values into what a person should see in a spreadsheet. */
function presentRow(row, columns, fieldMap) {
  const out = {};
  for (const c of columns) {
    const f = fieldMap[c.key];
    let v = c.key.startsWith('custom.') ? row.custom?.[c.key.slice(7)] : row[c.key];
    if (f?.type === 'reference' && row[`${c.key}_label`]) v = row[`${c.key}_label`];
    else if (f?.type === 'money') v = Money.toNumber(v);
    else if (f?.type === 'qty') v = Qty.toNumber(v);
    else if (f?.type === 'checkbox') v = !!v;
    out[c.key] = v ?? null;
  }
  return out;
}

/**
 * Build an export in any supported format from a set of rows.
 * Column types come from the record metadata, which is what lets the xlsx
 * carry real dates and currency rather than strings that look like them.
 */
export function buildExport({ format = 'xlsx', recordType = null, columns, rows, title, subtitle, currency = 'USD', totals = null, sheets = null }) {
  const fm = recordType ? meta.fieldMap(recordType) : {};
  const cols = columns.map((c) => {
    const key = typeof c === 'string' ? c : c.key;
    const f = fm[key];
    return {
      key,
      label: (typeof c === 'object' && c.label) || f?.label || key,
      type: (typeof c === 'object' && c.type) || f?.type || 'text',
    };
  });
  const presented = rows.map((r) => presentRow(r, cols, fm));
  const stamp = today();
  const base = (recordType || 'export').replace(/[^a-z0-9_-]/gi, '');

  if (format === 'csv') {
    return {
      text: toCsv(presented, cols),
      filename: `${base}-${stamp}.csv`,
      contentType: 'text/csv; charset=utf-8',
    };
  }
  if (format === 'json') {
    return {
      text: JSON.stringify({ record_type: recordType, generated_at: nowIso(), columns: cols, rows: presented }, null, 2),
      filename: `${base}-${stamp}.json`,
      contentType: 'application/json',
    };
  }
  if (format === 'xlsx') {
    const sheetList = sheets || [{
      name: title || base, title: title || null, subtitle: subtitle || null,
      columns: cols, rows: presented, totals,
    }];
    return {
      buffer: buildXlsx(sheetList, { currencyFormat: currencyFormatFor(currency), title: title || base }),
      filename: `${base}-${stamp}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }
  if (format === 'pdf') {
    const sheetList = sheets || [{
      title: title || base, subtitle: subtitle || null, columns: cols, rows: presented, totals,
    }];
    return {
      buffer: buildReportPdf({
        title: title || base,
        subtitle: subtitle || '',
        currency,
        footer: `Meridian ERP · ${stamp}`,
        // Landscape once a table has enough columns that portrait would
        // squeeze every one of them into an ellipsis.
        size: cols.length > 6 ? PAGE.A4_LANDSCAPE : PAGE.A4,
        sections: sheetList.map((sh) => ({
          title: sheetList.length > 1 ? (sh.title || sh.name) : null,
          subtitle: sheetList.length > 1 ? sh.subtitle : null,
          columns: sh.columns, rows: sh.rows, totals: sh.totals, note: sh.note,
        })),
      }),
      filename: `${base}-${stamp}.pdf`,
      contentType: 'application/pdf',
    };
  }
  throw badRequest(`Unsupported export format "${format}". Use csv, xlsx, json or pdf.`);
}
