// Meridian ERP :: core/db
// SQLite access layer, migration runner, transaction manager, and the
// tenant-scoped repository that every module is required to go through.
//
// Tenant isolation is structural, not conventional: Repo builds all SQL and
// refuses to touch a tenant-scoped table unless a tenant predicate is bound.
// Raw SQL must carry the `:t` marker, which is the only way to inject the
// caller's tenant id -- a query that forgets it throws at prepare time, not
// in production. See test/tenancy.test.mjs.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { ulid, nowIso, safeJson } from './util.mjs';

/**
 * Tables partitioned by tenant. Anything listed here demands a tenant
 * predicate when reached through Repo.
 *
 * `session` and `api_token` are the one sanctioned exception: they are looked
 * up by an unguessable credential digest BEFORE a tenant is known -- that
 * lookup is what establishes the tenant. Those two reads live in core/auth.mjs
 * and go through db.prepare directly; every other access to them, and every
 * access to everything else, goes through Repo and is scoped.
 */
export const TENANT_TABLES = new Set([
  'session',
  'app_user', 'role', 'permission', 'role_restriction', 'user_role', 'api_token',
  'audit_event', 'sequence', 'custom_field', 'saved_search', 'dashboard',
  'workflow', 'workflow_log', 'server_script', 'notification', 'search_doc',
  'subsidiary', 'currency', 'exchange_rate', 'department', 'segment_class',
  'account', 'accounting_period', 'journal_entry', 'journal_line', 'gl_balance',
  'bank_account', 'bank_txn', 'reconciliation',
  'customer', 'vendor', 'contact', 'lead', 'opportunity', 'activity',
  'support_case', 'case_message',
  'location', 'item', 'item_component', 'item_location', 'inventory_txn',
  'price_level', 'item_price', 'pricing_rule', 'approval_rule',
  'txn', 'txn_line', 'txn_link', 'tax_code',
  'employee', 'time_entry', 'time_off', 'payroll_run', 'payroll_line',
  'integration_event',
  'asset_class', 'fixed_asset', 'depreciation_line',
  'budget', 'budget_line', 'consolidation_rate',
  'project', 'project_task', 'resource_allocation', 'billing_rate',
  'expense_report', 'expense_line',
  'bom', 'bom_line', 'work_center', 'routing_step',
  'work_order', 'work_order_line', 'work_order_operation', 'quality_inspection',
  'bin', 'bin_quantity', 'inventory_lot', 'pick_wave', 'pick_task',
  'package', 'putaway_task',
  'demand_plan', 'demand_plan_line', 'supply_suggestion',
  'campaign', 'partner', 'commission',
  'sales_channel', 'channel_listing', 'cart',
  'service_asset', 'service_contract', 'service_order', 'service_line', 'technician',
  'review_cycle', 'performance_review', 'shift', 'schedule_entry',
  'attendance', 'employee_request',
  'import_job', 'import_template', 'export_definition',
  'schedule_template', 'schedule', 'schedule_line',
  'recurring_journal', 'recurring_journal_line',
  'revaluation_run', 'revaluation_line',
  'dunning_policy', 'dunning_level', 'dunning_notice',
  'payment_run', 'payment_run_line',
  'tax_return', 'tax_return_line',
  'allocation_schedule', 'allocation_source', 'allocation_target', 'allocation_run',
  'landed_cost_category', 'landed_cost', 'landed_cost_line',
  'inventory_count', 'inventory_count_line',
  'subscription', 'subscription_line', 'subscription_usage',
  'subscription_billing', 'subscription_change',
  'intercompany_txn', 'elimination_run', 'elimination_line',
  'custom_record_type', 'custom_record',
  'asset_revaluation', 'asset_transfer',
  'accounting_book', 'book_adjustment', 'book_adjustment_line', 'book_balance',
  'asset_book_rule',
]);

/**
 * Columns holding JSON documents, decoded on read and encoded on write.
 *
 * Matched by column NAME across every table, which is what makes it cheap and
 * also what makes it sharp: give a plain enum column the same name as one of
 * these in some other table and its values come back as `{}`. `jsonColumns()`
 * below exists so a test can catch that rather than a user discovering it.
 */
export const JSON_COLUMNS = new Set([
  'settings', 'changes', 'options', 'definition', 'layout', 'actions', 'allowed',
  'scopes', 'custom', 'address', 'billing_address', 'shipping_address',
  'emergency_contact', 'earnings', 'payload',
  'checks', 'contents', 'lines', 'media', 'site_address', 'skills',
  'template', 'ratings', 'goals',
  'mapping', 'defaults', 'errors', 'created_ids', 'columns', 'filters',
  'documents', 'weights',
]);

/** The subset of JSON_COLUMNS holding arrays, so a failed parse yields []. */
const JSON_ARRAY_COLUMNS = new Set([
  'scopes', 'allowed', 'checks', 'contents', 'lines', 'media', 'skills',
  'template', 'ratings', 'goals', 'errors', 'created_ids', 'columns', 'filters',
]);

export class DbError extends Error {
  constructor(message, code = 'DB_ERROR') { super(message); this.name = 'DbError'; this.code = code; }
}

// ---------------------------------------------------------------- open
export function openDatabase(filePath, { verbose = false } = {}) {
  if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);

  // Durability & concurrency posture for a financial system of record:
  //  - WAL lets reporting reads run concurrently with posting writes.
  //  - synchronous=FULL means a committed ledger entry has reached the disk
  //    before we acknowledge it. Slower than NORMAL; correct for money.
  //  - foreign_keys enforces referential integrity that STRICT tables cannot.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 8000');
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA cache_size = -32000');   // ~32 MB page cache
  db.exec('PRAGMA mmap_size = 268435456');
  db.exec('PRAGMA wal_autocheckpoint = 512');

  // Column sets, read from the live schema and cached. Lets query builders
  // ask "does this table have a `custom` column?" instead of maintaining a
  // second list that can drift from the migrations.
  const columnCache = new Map();
  db.$columns = (table) => {
    let cols = columnCache.get(table);
    if (!cols) {
      cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
      columnCache.set(table, cols);
    }
    return cols;
  };
  db.$hasColumn = (table, column) => db.$columns(table).has(column);

  const stmtCache = new Map();
  db.$prepare = (sql) => {
    let s = stmtCache.get(sql);
    if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
    return s;
  };
  db.$verbose = verbose;
  db.$txDepth = 0;
  return db;
}

// ------------------------------------------------------------ migrate
export function migrate(db, migrationsDir) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)`);
  const applied = new Set(db.prepare('SELECT name FROM schema_migration').all().map((r) => r.name));
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const ran = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migration (name, applied_at, checksum) VALUES (?,?,?)')
        .run(f, nowIso(), String(sql.length));
      db.exec('COMMIT');
      ran.push(f);
    } catch (e) {
      db.exec('ROLLBACK');
      throw new DbError(`Migration ${f} failed: ${e.message}`, 'MIGRATION_FAILED');
    }
  }
  return ran;
}

// -------------------------------------------------------- transactions
/**
 * Run `fn` inside a transaction. Nested calls become SAVEPOINTs, so a module
 * can compose (post a journal inside creating an invoice inside a workflow)
 * and the whole tree still commits or rolls back as one unit.
 */
export function transaction(db, fn) {
  const depth = db.$txDepth++;
  const sp = `sp_${depth}`;
  if (depth === 0) db.exec('BEGIN IMMEDIATE'); else db.exec(`SAVEPOINT ${sp}`);
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      throw new DbError('transaction() callback must be synchronous — SQLite writes here are sync by design', 'ASYNC_TXN');
    }
    if (depth === 0) db.exec('COMMIT'); else db.exec(`RELEASE ${sp}`);
    db.$txDepth--;
    return out;
  } catch (e) {
    try { if (depth === 0) db.exec('ROLLBACK'); else { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); } }
    catch { /* connection already unwound */ }
    db.$txDepth--;
    throw e;
  }
}

// ------------------------------------------------------- row marshalling
function decodeRow(row) {
  if (!row) return row;
  const out = {};
  for (const k of Object.keys(row)) {
    out[k] = JSON_COLUMNS.has(k) && typeof row[k] === 'string' ? safeJson(row[k], JSON_ARRAY_COLUMNS.has(k) ? [] : {}) : row[k];
  }
  return out;
}
function encodeValue(col, v) {
  if (v === undefined) return null;
  if (v === null) return null;
  if (JSON_COLUMNS.has(col) && typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

/**
 * Rewrite a raw statement, replacing every `:t` with a bound parameter holding
 * the caller's tenant id, interleaved correctly with the caller's own `?`s.
 * String literals and comments are skipped so a `:t` inside text is untouched.
 */
export function bindTenant(sql, tenantId, params) {
  const out = []; const finalParams = []; let pi = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {                       // string / quoted ident
      const q = c; let j = i + 1;
      while (j < sql.length) { if (sql[j] === q) { if (sql[j + 1] === q) j += 2; else { j++; break; } } else j++; }
      out.push(sql.slice(i, j)); i = j; continue;
    }
    if (c === '-' && sql[i + 1] === '-') {              // line comment
      const j = sql.indexOf('\n', i); const end = j === -1 ? sql.length : j + 1;
      out.push(sql.slice(i, end)); i = end; continue;
    }
    if (c === ':' && sql[i + 1] === 't' && !/[a-zA-Z0-9_]/.test(sql[i + 2] || '')) {
      out.push('?'); finalParams.push(tenantId); i += 2; continue;
    }
    if (c === '?') { out.push('?'); finalParams.push(params[pi++]); i++; continue; }
    out.push(c); i++;
  }
  if (pi < params.length) finalParams.push(...params.slice(pi));  // trailing extras
  return { sql: out.join(''), params: finalParams };
}

const TABLE_REF = /\b(?:from|join|into|update)\s+["`]?([a-z_][a-z0-9_]*)["`]?/gi;
function assertTenantScoped(sql) {
  const tables = new Set();
  for (const m of sql.matchAll(TABLE_REF)) tables.add(m[1].toLowerCase());
  for (const t of tables) {
    if (TENANT_TABLES.has(t) && !/:t\b/.test(sql)) {
      throw new DbError(`Query touches tenant-scoped table "${t}" without a :t predicate. Refusing to run.`, 'TENANT_SCOPE_MISSING');
    }
  }
}

/**
 * Two database failures are really bad requests, and both reach the caller as
 * a bare 500 unless they are named here.
 *
 * A parameter that is `undefined` means the statement was told to expect a
 * value the caller never supplied -- nearly always a required field missing
 * from a request body. SQLite says "cannot be bound to parameter 3", which
 * identifies neither the field nor the request.
 *
 * A constraint failure is the shape of the data, not a fault in the server:
 * a NOT NULL column left empty, a duplicate on a unique index, a reference to
 * something that is not there.
 *
 * `status` is all the router needs to answer properly; core/db deliberately
 * does not import core/http, which would be a cycle through core/util.
 */
function bindable(params, sql) {
  for (let i = 0; i < params.length; i++) {
    if (params[i] === undefined) {
      const err = new DbError(`A required value was not supplied (parameter ${i + 1} of ${params.length}).`, 'MISSING_VALUE');
      err.status = 400;
      err.sql = sql;
      throw err;
    }
  }
  return params;
}

const CONSTRAINT = [
  [/NOT NULL constraint failed: [^.\s]+\.(\S+)/, (m) => `${m[1]} is required.`],
  [/UNIQUE constraint failed: (.+)/, (m) => `That ${m[1].split(',').map((c) => c.trim().split('.').pop()).filter((c) => c !== 'tenant_id').join(' and ')} is already in use.`],
  [/CHECK constraint failed: (\S+)/, (m) => `That value is not allowed here (${m[1]}).`],
  [/FOREIGN KEY constraint failed/, () => 'That refers to a record which does not exist.'],
];

function rethrow(err) {
  for (const [re, message] of CONSTRAINT) {
    const m = re.exec(String(err?.message || ''));
    if (m) {
      const out = new DbError(message(m), 'CONSTRAINT');
      out.status = 422;
      out.cause = err;
      throw out;
    }
  }
  throw err;
}

/** Run a prepared statement with both guards in place. */
function runStatement(stmt, params, sql, method = 'run') {
  bindable(params, sql);
  try { return stmt[method](...params); }
  catch (err) { return rethrow(err); }
}

// ---------------------------------------------------------------- Repo
/**
 * Tenant-scoped data access. Constructed once per request by the router and
 * handed to every module. It is the only sanctioned path to the database.
 */
export class Repo {
  constructor(db, tenantId, ctx = {}) {
    if (!tenantId) throw new DbError('Repo requires a tenant id', 'NO_TENANT');
    this.db = db;
    this.tenantId = tenantId;
    this.ctx = ctx;                    // { user, roles, permissions, restrictions, ip, requestId }
  }

  // -- raw ---------------------------------------------------------------
  /** SELECT many. `sql` must reference the tenant via `:t`. */
  query(sql, params = []) {
    assertTenantScoped(sql);
    const b = bindTenant(sql, this.tenantId, params);
    return runStatement(this.db.$prepare(b.sql), b.params, b.sql, 'all').map(decodeRow);
  }
  /** SELECT one. */
  queryOne(sql, params = []) {
    assertTenantScoped(sql);
    const b = bindTenant(sql, this.tenantId, params);
    const r = runStatement(this.db.$prepare(b.sql), b.params, b.sql, 'get');
    return r ? decodeRow(r) : null;
  }
  /** Scalar helper: first column of first row. */
  scalar(sql, params = [], fallback = null) {
    const r = this.queryOne(sql, params);
    if (!r) return fallback;
    const v = Object.values(r)[0];
    return v === null || v === undefined ? fallback : v;
  }
  /** INSERT/UPDATE/DELETE. */
  exec(sql, params = []) {
    assertTenantScoped(sql);
    const b = bindTenant(sql, this.tenantId, params);
    return runStatement(this.db.$prepare(b.sql), b.params, b.sql);
  }

  // -- CRUD --------------------------------------------------------------
  get(table, id, idColumn = 'id') {
    this.#assertTable(table);
    // A missing id is a miss, not a crash: callers everywhere read an optional
    // foreign key straight into get(), and SQLite refuses to bind undefined
    // with an error that says nothing about which record was being looked for.
    //
    // The same goes for an id that is the wrong shape entirely. Ids arrive
    // from request bodies, so one can be an object, an array or a boolean;
    // SQLite cannot bind any of those and throws a driver-level TypeError,
    // which surfaces as a 500 for what is only ever a record that is not
    // there. Every id in this schema is TEXT, so anything that is not a
    // string or a number cannot match a row.
    if (id === null || id === undefined || id === '') return null;
    const kind = typeof id;
    if (kind !== 'string' && kind !== 'number' && kind !== 'bigint') return null;
    if (kind === 'number' && !Number.isFinite(id)) return null;
    return this.queryOne(`SELECT * FROM ${table} WHERE tenant_id = :t AND ${idColumn} = ?`, [id]);
  }

  /**
   * find(table, {where, order, limit, offset, columns, search})
   * `where` values may be scalars, arrays (IN), or {op, value} descriptors.
   */
  find(table, opts = {}) {
    this.#assertTable(table);
    const { sql, params } = this.#buildSelect(table, opts);
    return this.query(sql, params);
  }

  findOne(table, opts = {}) {
    const rows = this.find(table, { ...opts, limit: 1 });
    return rows[0] || null;
  }

  count(table, where = {}) {
    this.#assertTable(table);
    const w = this.#buildWhere(where);
    return Number(this.scalar(`SELECT COUNT(*) c FROM ${table} WHERE tenant_id = :t ${w.sql}`, w.params, 0));
  }

  insert(table, values) {
    this.#assertTable(table);
    const row = { ...values, tenant_id: this.tenantId };
    if (!row.id) row.id = ulid();
    const cols = Object.keys(row).filter((k) => row[k] !== undefined);
    const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
    runStatement(this.db.$prepare(sql), cols.map((c) => encodeValue(c, row[c])), sql);
    return row.id;
  }

  update(table, id, patch, idColumn = 'id') {
    this.#assertTable(table);
    const cols = Object.keys(patch).filter((k) => k !== 'tenant_id' && k !== idColumn && patch[k] !== undefined);
    if (!cols.length) return 0;
    const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE tenant_id = ? AND ${idColumn} = ?`;
    const r = runStatement(this.db.$prepare(sql), [...cols.map((c) => encodeValue(c, patch[c])), this.tenantId, id], sql);
    return Number(r.changes);
  }

  upsert(table, keyCols, values) {
    this.#assertTable(table);
    const row = { ...values, tenant_id: this.tenantId };
    const cols = Object.keys(row).filter((k) => row[k] !== undefined);
    const updates = cols.filter((c) => !keyCols.includes(c) && c !== 'tenant_id');
    const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})
      ON CONFLICT (${['tenant_id', ...keyCols].join(',')}) DO UPDATE SET ${updates.map((c) => `${c} = excluded.${c}`).join(', ')}`;
    runStatement(this.db.$prepare(sql), cols.map((c) => encodeValue(c, row[c])), sql);
  }

  remove(table, id, idColumn = 'id') {
    this.#assertTable(table);
    const sql = `DELETE FROM ${table} WHERE tenant_id = ? AND ${idColumn} = ?`;
    const r = runStatement(this.db.$prepare(sql), [this.tenantId, id], sql);
    return Number(r.changes);
  }

  tx(fn) { return transaction(this.db, fn); }

  // -- internals ---------------------------------------------------------
  #assertTable(table) {
    if (!TENANT_TABLES.has(table)) throw new DbError(`Unknown or non-tenant table: ${table}`, 'BAD_TABLE');
  }

  #buildWhere(where = {}, alias = '') {
    const p = alias ? `${alias}.` : '';
    const parts = []; const params = [];
    for (const [k, v] of Object.entries(where)) {
      if (v === undefined) continue;
      if (!/^[a-z_][a-z0-9_]*$/i.test(k)) throw new DbError(`Illegal column in filter: ${k}`, 'BAD_COLUMN');
      if (v === null) { parts.push(`${p}${k} IS NULL`); continue; }
      if (Array.isArray(v)) {
        if (!v.length) { parts.push('0=1'); continue; }
        parts.push(`${p}${k} IN (${v.map(() => '?').join(',')})`); params.push(...v); continue;
      }
      if (typeof v === 'object' && v.op) {
        const OPS = { eq: '=', ne: '!=', lt: '<', lte: '<=', gt: '>', gte: '>=', like: 'LIKE', notlike: 'NOT LIKE' };
        const op = OPS[v.op];
        if (!op) throw new DbError(`Illegal operator: ${v.op}`, 'BAD_OP');
        if (v.op === 'like' || v.op === 'notlike') { parts.push(`${p}${k} ${op} ?`); params.push(`%${v.value}%`); }
        else { parts.push(`${p}${k} ${op} ?`); params.push(v.value); }
        continue;
      }
      parts.push(`${p}${k} = ?`); params.push(encodeValue(k, v));
    }
    return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', params };
  }

  #buildSelect(table, opts) {
    const cols = opts.columns?.length
      ? opts.columns.map((c) => { if (!/^[a-z_][a-z0-9_]*$/i.test(c)) throw new DbError(`Illegal column: ${c}`, 'BAD_COLUMN'); return c; }).join(',')
      : '*';
    const w = this.#buildWhere(opts.where || {});
    let sql = `SELECT ${cols} FROM ${table} WHERE tenant_id = :t${w.sql}`;
    const params = [...w.params];
    if (opts.order) {
      const specs = String(opts.order).split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
        const [c, dir = 'asc'] = s.split(/\s+/);
        if (!/^[a-z_][a-z0-9_]*$/i.test(c)) throw new DbError(`Illegal sort column: ${c}`, 'BAD_COLUMN');
        return `${c} ${dir.toLowerCase() === 'desc' ? 'DESC' : 'ASC'}`;
      });
      if (specs.length) sql += ` ORDER BY ${specs.join(', ')}`;
    }
    if (opts.limit) { sql += ' LIMIT ?'; params.push(Math.min(Number(opts.limit), 10000)); }
    if (opts.offset) { sql += ' OFFSET ?'; params.push(Number(opts.offset)); }
    return { sql, params };
  }
}
