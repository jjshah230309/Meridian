// Meridian ERP :: modules/pivot
// A pivot table over either a record type (through the same query engine
// platform.mjs's saved searches already use, so row security and tenant
// scoping are inherited rather than re-implemented) or one of odata.mjs's
// pre-joined analytic sets (SalesFact, ProfitAndLoss, ...).
//
// Grouping and aggregation happen in JS, over the already-fetched, already
// row-secured page runSearch/an analytic set returns -- not in SQL. That
// keeps the whole thing to one small function instead of hand-rolling a
// second GROUP BY compiler with two dimensions, date bucketing and
// custom-field aggregates, and it is the same trade platform.mjs's own
// single-dimension grouping already makes, just carried one step further.
import { badRequest, notFound, forbidden, ValidationError } from '../core/http.mjs';
import * as rbac from '../core/rbac.mjs';
import { runSearch } from './platform.mjs';
import { getMeta, fieldMap, listRecordTypes } from './meta.mjs';
import * as odata from './odata.mjs';
import * as audit from '../core/audit.mjs';
import { ulid, nowIso } from '../core/util.mjs';

export const CHART_TYPES = ['none', 'bar', 'line', 'donut'];

export const AGG_FNS = ['count', 'sum', 'avg', 'min', 'max'];
export const BUCKETS = ['none', 'day', 'month', 'quarter', 'year'];
const ROW_CAP = 5000;

/** Datasets a caller may pivot, filtered by what they can already see. */
export function listDatasets(repo, access) {
  const out = [];
  for (const type of listRecordTypes()) {
    const m = getMeta(type);
    if (rbac.levelFor(access, m.permission) < rbac.LEVEL.VIEW) continue;
    out.push({
      kind: 'record', name: type, title: m.plural,
      fields: m.fields.filter((f) => f.type !== 'formula').map((f) => ({ name: f.name, label: f.label, type: f.type })),
    });
  }
  for (const [name, def] of Object.entries(odata.ANALYTIC_SETS)) {
    if (rbac.levelFor(access, 'account') < rbac.LEVEL.VIEW) continue;
    out.push({ kind: 'analytic', name, title: def.title, fields: def.columns.map((c) => ({ name: c.name, label: c.name, type: c.type })) });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

function bucketDate(value, bucket) {
  if (!value || !bucket || bucket === 'none') return value;
  const s = String(value);
  if (bucket === 'day') return s.slice(0, 10);
  if (bucket === 'month') return s.slice(0, 7);
  if (bucket === 'year') return s.slice(0, 4);
  if (bucket === 'quarter') {
    const month = Number(s.slice(5, 7)) || 1;
    return `${s.slice(0, 4)}-Q${Math.ceil(month / 3)}`;
  }
  return value;
}

function keyFor(row, dim) {
  if (!dim) return '__all__';
  const label = row[`${dim.field}_label`];
  const raw = row[dim.field];
  const bucketed = bucketDate(raw, dim.bucket);
  return { key: bucketed, label: dim.bucket && dim.bucket !== 'none' ? bucketed : (label ?? raw ?? '(none)') };
}

function newAgg(fn) {
  if (fn === 'count') return { fn, n: 0 };
  if (fn === 'min') return { fn, v: null };
  if (fn === 'max') return { fn, v: null };
  return { fn, sum: 0, n: 0 };
}
function feedAgg(agg, value) {
  const n = Number(value) || 0;
  if (agg.fn === 'count') { agg.n++; return; }
  if (agg.fn === 'min') { agg.v = agg.v === null ? n : Math.min(agg.v, n); return; }
  if (agg.fn === 'max') { agg.v = agg.v === null ? n : Math.max(agg.v, n); return; }
  agg.sum += n; agg.n++;
}
function readAgg(agg) {
  if (agg.fn === 'count') return agg.n;
  if (agg.fn === 'min' || agg.fn === 'max') return agg.v || 0;
  if (agg.fn === 'avg') return agg.n ? agg.sum / agg.n : 0;
  return agg.sum;
}

/**
 * `def`: { source: {kind, name}, row: {field, bucket?}, col: {field, bucket?}|null,
 *          values: [{field, fn, label?}], filters?: [...] (record sources only) }
 */
export function runPivot(repo, access, def = {}) {
  const source = def.source || {};
  if (!source.kind || !source.name) throw new ValidationError({ source: 'Choose a dataset' });
  if (!def.row?.field) throw new ValidationError({ row: 'Choose a row field' });
  const values = (Array.isArray(def.values) ? def.values : []).filter((v) => v?.field && AGG_FNS.includes(v.fn));
  if (!values.length) throw new ValidationError({ values: 'Choose at least one value to aggregate' });

  let rows;
  let fm = null;
  if (source.kind === 'record') {
    const m = getMeta(source.name);
    if (!m) throw notFound(`Unknown record type "${source.name}"`);
    rbac.require$(access, m.permission, rbac.LEVEL.VIEW);
    fm = fieldMap(source.name, repo);
    const needed = new Set(['id', def.row.field, def.col?.field, ...values.map((v) => v.field)].filter(Boolean));
    const result = runSearch(repo, source.name, { columns: [...needed], filters: def.filters || [] }, { access, limit: ROW_CAP });
    rows = result.rows;
  } else if (source.kind === 'analytic') {
    const analytic = odata.ANALYTIC_SETS[source.name];
    if (!analytic) throw notFound(`Unknown dataset "${source.name}"`);
    rbac.require$(access, 'account', rbac.LEVEL.VIEW);
    rows = analytic.rows(repo, {}).slice(0, ROW_CAP);
  } else {
    throw badRequest(`Unknown dataset kind "${source.kind}"`);
  }

  const rowOrder = []; const rowLabels = new Map();
  const colOrder = def.col ? [] : ['__all__']; const colLabels = new Map([['__all__', '']]);
  const cells = new Map(); // rowKey -> colKey -> [agg per value]
  const rowTotals = new Map(); // rowKey -> [agg per value] (across all columns)
  const colTotals = new Map(); // colKey -> [agg per value]
  const grand = values.map((v) => newAgg(v.fn));

  for (const r of rows) {
    const rk = keyFor(r, def.row);
    const ck = def.col ? keyFor(r, def.col) : { key: '__all__', label: '' };
    if (!rowLabels.has(rk.key)) { rowLabels.set(rk.key, rk.label); rowOrder.push(rk.key); }
    if (def.col && !colLabels.has(ck.key)) { colLabels.set(ck.key, ck.label); colOrder.push(ck.key); }

    if (!cells.has(rk.key)) cells.set(rk.key, new Map());
    const byCol = cells.get(rk.key);
    if (!byCol.has(ck.key)) byCol.set(ck.key, values.map((v) => newAgg(v.fn)));
    if (!rowTotals.has(rk.key)) rowTotals.set(rk.key, values.map((v) => newAgg(v.fn)));
    if (!colTotals.has(ck.key)) colTotals.set(ck.key, values.map((v) => newAgg(v.fn)));

    const cellAggs = byCol.get(ck.key);
    const rowAggs = rowTotals.get(rk.key);
    const colAggs = colTotals.get(ck.key);
    values.forEach((v, i) => {
      const raw = r[v.field];
      feedAgg(cellAggs[i], raw);
      feedAgg(rowAggs[i], raw);
      feedAgg(colAggs[i], raw);
      feedAgg(grand[i], raw);
    });
  }

  // Sort rows/cols: dates ascending, everything else by total of the first
  // value descending, so the biggest contributor leads the table.
  const isDateBucket = def.row.bucket && def.row.bucket !== 'none';
  rowOrder.sort(isDateBucket ? (a, b) => String(a).localeCompare(String(b)) : (a, b) => readAgg(rowTotals.get(b)[0]) - readAgg(rowTotals.get(a)[0]));
  if (def.col) {
    const isColDate = def.col.bucket && def.col.bucket !== 'none';
    colOrder.sort(isColDate ? (a, b) => String(a).localeCompare(String(b)) : (a, b) => readAgg(colTotals.get(b)[0]) - readAgg(colTotals.get(a)[0]));
  }

  const table = rowOrder.map((rk) => ({
    key: rk, label: rowLabels.get(rk),
    cells: colOrder.map((ck) => (cells.get(rk).get(ck) || values.map((v) => newAgg(v.fn))).map(readAgg)),
    total: rowTotals.get(rk).map(readAgg),
  }));

  return {
    source, row: def.row, col: def.col, values,
    columns: colOrder.map((ck) => ({ key: ck, label: colLabels.get(ck) })),
    rows: table,
    column_totals: colOrder.map((ck) => (colTotals.get(ck) || values.map((v) => newAgg(v.fn))).map(readAgg)),
    grand_total: grand.map(readAgg),
    row_count: rows.length, truncated: rows.length >= ROW_CAP,
  };
}

// ===================================================================
// SAVED CUSTOM REPORTS
// ===================================================================

export const listReports = (repo) => repo.query(
  `SELECT * FROM custom_report WHERE tenant_id = :t AND (is_public = 1 OR owner_id = ?) ORDER BY name`,
  [repo.ctx?.user?.id || '']);

export function getReport(repo, id) {
  const r = repo.get('custom_report', id);
  if (!r) throw notFound('Report not found');
  return r;
}

/** An owned record can be changed by its owner, or by someone with FULL. */
function assertCanEdit(repo, report) {
  const userId = repo.ctx?.user?.id || null;
  if (report.owner_id && report.owner_id !== userId && rbac.levelFor(repo.ctx?.access, 'saved_search') < rbac.LEVEL.FULL) {
    throw forbidden('Only the owner of this report, or someone with full access, can change it.');
  }
}

export function createReport(repo, input) {
  if (!input.name) throw new ValidationError({ name: 'Name is required' });
  // Fail fast on a broken definition rather than at run time.
  runPivot(repo, repo.ctx?.access, input.definition || {});
  const now = nowIso();
  const id = repo.insert('custom_report', {
    id: ulid(), name: input.name, definition: input.definition || {},
    chart: CHART_TYPES.includes(input.chart) ? input.chart : 'none',
    owner_id: repo.ctx?.user?.id || null,
    is_public: input.is_public === false ? 0 : 1,
    created_at: now, updated_at: now,
  });
  audit.record(repo, { recordType: 'custom_report', recordId: id, action: 'create', after: input });
  return getReport(repo, id);
}

export function updateReport(repo, id, patch) {
  const before = getReport(repo, id);
  assertCanEdit(repo, before);
  if (patch.definition) runPivot(repo, repo.ctx?.access, patch.definition);
  repo.update('custom_report', id, {
    name: patch.name ?? before.name,
    definition: patch.definition ?? before.definition,
    chart: patch.chart !== undefined ? (CHART_TYPES.includes(patch.chart) ? patch.chart : 'none') : before.chart,
    is_public: patch.is_public === undefined ? before.is_public : (patch.is_public ? 1 : 0),
    updated_at: nowIso(),
  });
  audit.record(repo, { recordType: 'custom_report', recordId: id, action: 'update', before });
  return getReport(repo, id);
}

export function deleteReport(repo, id) {
  const before = getReport(repo, id);
  assertCanEdit(repo, before);
  repo.remove('custom_report', id);
  audit.record(repo, { recordType: 'custom_report', recordId: id, action: 'delete', before });
  return { deleted: true };
}
