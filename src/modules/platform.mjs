// Meridian ERP :: modules/platform
// The customisation engine -- Meridian's answer to SuiteFlow/SuiteScript.
//
//   Custom fields  : per-tenant columns on any record, stored in a JSON
//                    column, with optional read-time formulas.
//   Saved searches : a safe query builder over the metadata registry.
//   Workflows      : declarative automation on record events.
//   Server scripts : optional, sandboxed, disabled by default.
//
// Everything tenant-authored is expressed as data evaluated by core/expr,
// never as code we hand to the JavaScript engine. That is what keeps one
// tenant's automation from becoming another tenant's incident.
import { ulid, nowIso, today, Money, Qty, addDays, safeJson, sum } from '../core/util.mjs';
import { notFound, unprocessable, badRequest, ValidationError, HttpError } from '../core/http.mjs';
import { compile, evalSafe, test as exprTest, validate as validateExpr, truthy } from '../core/expr.mjs';
import * as audit from '../core/audit.mjs';
import { getMeta, fieldMap, RECORDS, listRecordTypes, REF_LABEL, refTypeFor } from './meta.mjs';
import { rowFilter } from '../core/rbac.mjs';

// =====================================================================
// CUSTOM FIELDS
// =====================================================================

const NAME_RX = /^[a-z][a-z0-9_]{1,38}$/;

export function listCustomFields(repo, recordType = null) {
  return recordType
    ? repo.query('SELECT * FROM custom_field WHERE tenant_id = :t AND record_type = ? AND active = 1 ORDER BY display_order, label', [recordType])
    : repo.query('SELECT * FROM custom_field WHERE tenant_id = :t ORDER BY record_type, display_order, label');
}

export function createCustomField(repo, input) {
  const fields = {};
  if (!input.record_type || !getMeta(input.record_type, repo)) fields.record_type = 'Choose a record type this field applies to';
  if (!NAME_RX.test(String(input.name || ''))) fields.name = 'Use lowercase letters, digits and underscores, starting with a letter';
  if (!input.label) fields.label = 'Label is required';
  if (!input.type) fields.type = 'Field type is required';
  if (input.type === 'formula') {
    const v = validateExpr(input.formula || '');
    if (!v.ok) fields.formula = v.error;
  }
  // A custom field may not shadow a built-in column.
  if (input.record_type && input.name && fieldMap(input.record_type, repo)[input.name]) {
    fields.name = `"${input.name}" is already a standard field on ${getMeta(input.record_type, repo).label}`;
  }
  if (Object.keys(fields).length) throw new ValidationError(fields);
  if (repo.queryOne('SELECT id FROM custom_field WHERE tenant_id = :t AND record_type = ? AND name = ?', [input.record_type, input.name])) {
    throw new ValidationError({ name: `A field named "${input.name}" already exists on that record` });
  }

  const id = repo.insert('custom_field', {
    id: ulid(), record_type: input.record_type, name: input.name, label: input.label,
    type: input.type, options: input.options || [], ref_type: input.ref_type || null,
    formula: input.formula || null, required: input.required ? 1 : 0,
    help_text: input.help_text || '', display_order: Number(input.display_order || 0),
    show_in_list: input.show_in_list ? 1 : 0, active: 1, created_at: nowIso(),
  });
  audit.record(repo, { recordType: 'custom_field', recordId: id, action: 'create', after: input });
  return repo.get('custom_field', id);
}

export function updateCustomField(repo, id, patch) {
  const before = repo.get('custom_field', id);
  if (!before) throw notFound('Custom field not found');
  if (patch.formula !== undefined && patch.formula) {
    const v = validateExpr(patch.formula);
    if (!v.ok) throw new ValidationError({ formula: v.error });
  }
  // Renaming would orphan every stored value.
  if (patch.name && patch.name !== before.name) throw unprocessable('A custom field cannot be renamed once created. Deactivate it and add a new one.');
  const allowed = ['label', 'type', 'options', 'ref_type', 'formula', 'required', 'help_text', 'display_order', 'show_in_list', 'active'];
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  repo.update('custom_field', id, clean);
  const after = repo.get('custom_field', id);
  audit.record(repo, { recordType: 'custom_field', recordId: id, action: 'update', before, after });
  return after;
}

export function deleteCustomField(repo, id) {
  const before = repo.get('custom_field', id);
  if (!before) throw notFound('Custom field not found');
  // Values stay on the records; deactivating keeps history readable.
  repo.update('custom_field', id, { active: 0 });
  audit.record(repo, { recordType: 'custom_field', recordId: id, action: 'deactivate', before });
  return true;
}

/** Validate and coerce a record's custom values against its field definitions. */
export function validateCustom(repo, recordType, values = {}) {
  const defs = listCustomFields(repo, recordType);
  const out = {}; const errors = {};
  for (const d of defs) {
    if (d.type === 'formula') continue;                 // computed on read
    let v = values[d.name];
    if (v === undefined) v = null;
    if (d.required && (v === null || v === '')) { errors[`custom.${d.name}`] = `${d.label} is required`; continue; }
    if (v === null || v === '') { out[d.name] = null; continue; }
    switch (d.type) {
      case 'number': {
        const n = Number(v);
        if (!Number.isFinite(n)) { errors[`custom.${d.name}`] = `${d.label} must be a number`; continue; }
        out[d.name] = n; break;
      }
      case 'money': out[d.name] = Money.parse(v); break;
      case 'checkbox': out[d.name] = truthy(v) ? 1 : 0; break;
      case 'date':
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) { errors[`custom.${d.name}`] = `${d.label} must be a date (YYYY-MM-DD)`; continue; }
        out[d.name] = String(v); break;
      case 'select': {
        const opts = Array.isArray(d.options) ? d.options : [];
        if (opts.length && !opts.includes(v)) { errors[`custom.${d.name}`] = `${d.label} must be one of: ${opts.join(', ')}`; continue; }
        out[d.name] = String(v); break;
      }
      case 'multiselect': {
        const arr = Array.isArray(v) ? v : [v];
        const opts = Array.isArray(d.options) ? d.options : [];
        const bad = opts.length ? arr.filter((x) => !opts.includes(x)) : [];
        if (bad.length) { errors[`custom.${d.name}`] = `${d.label}: unknown option ${bad.join(', ')}`; continue; }
        out[d.name] = arr; break;
      }
      default: out[d.name] = String(v).slice(0, 8000);
    }
  }
  // Preserve values from fields that were later deactivated.
  for (const [k, v] of Object.entries(values || {})) if (!(k in out) && !defs.some((d) => d.name === k)) out[k] = v;
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return out;
}

/** Evaluate formula custom fields for a record, non-destructively. */
export function decorateCustom(repo, recordType, record) {
  if (!record) return record;
  const defs = listCustomFields(repo, recordType).filter((d) => d.type === 'formula' && d.formula);
  if (!defs.length) return record;
  const custom = { ...(record.custom || {}) };
  const scope = { ...record, custom, today: today() };
  for (const d of defs) custom[d.name] = evalSafe(d.formula, scope, null);
  return { ...record, custom };
}

// =====================================================================
// SAVED SEARCHES / QUERY ENGINE
// =====================================================================

export const OPERATORS = {
  eq: { label: 'is', sql: '= ?' },
  ne: { label: 'is not', sql: '!= ?' },
  gt: { label: 'greater than', sql: '> ?' },
  gte: { label: 'at least', sql: '>= ?' },
  lt: { label: 'less than', sql: '< ?' },
  lte: { label: 'at most', sql: '<= ?' },
  contains: { label: 'contains', sql: 'LIKE ?', wrap: (v) => `%${v}%` },
  starts: { label: 'starts with', sql: 'LIKE ?', wrap: (v) => `${v}%` },
  empty: { label: 'is empty', sql: "IS NULL OR %COL% = ''", noValue: true },
  notempty: { label: 'is not empty', sql: "IS NOT NULL AND %COL% != ''", noValue: true },
  in: { label: 'is any of', sql: 'IN', multi: true },
  between: { label: 'between', sql: 'BETWEEN ? AND ?', pair: true },
};

/**
 * Execute a saved-search definition.
 *
 * Column and field names are validated against the metadata registry, never
 * interpolated from user input, so the builder cannot be turned into a SQL
 * injection. Custom fields are addressed as `custom.<name>` and resolved
 * through json_extract.
 */
export function runSearch(repo, recordType, definition = {}, { access = null, limit = null, offset = 0 } = {}) {
  const meta = getMeta(recordType, repo);
  if (!meta) throw badRequest(`Unknown record type "${recordType}"`);
  const fm = fieldMap(recordType, repo);
  const customDefs = Object.fromEntries(listCustomFields(repo, recordType).map((d) => [d.name, d]));

  /** Resolve a field reference to a SQL expression. */
  const colSql = (name) => {
    if (name.startsWith('custom.')) {
      const key = name.slice(7);
      if (!customDefs[key]) throw badRequest(`Unknown custom field "${key}"`);
      if (!repo.db.$hasColumn(meta.table, 'custom')) throw badRequest(`${meta.label} does not support custom fields`);
      return `json_extract(r.custom, '$.${key}')`;
    }
    if (name === 'id') return 'r.id';
    if (!fm[name]) throw badRequest(`"${name}" is not a field on ${meta.label}`);
    if (fm[name].inCustom) return `json_extract(r.custom, '$.${name}')`;
    return `r.${name}`;
  };

  const selectCols = (definition.columns?.length ? definition.columns : meta.listColumns)
    .filter((c) => c === 'id' || fm[c] || (c.startsWith('custom.') && customDefs[c.slice(7)]));

  // Polymorphic references (txn.entity_id) need their discriminator column to
  // know which table to resolve against, so pull it even when not displayed.
  const discriminators = new Set();
  for (const c of selectCols) {
    const f = fm[c];
    if (f?.refFrom && fm[f.refFrom] && !selectCols.includes(f.refFrom)) discriminators.add(f.refFrom);
  }
  const selectSql = ['r.id',
    ...selectCols.filter((c) => c !== 'id').map((c) => `${colSql(c)} AS "${c}"`),
    ...[...discriminators].map((c) => `${colSql(c)} AS "${c}"`)].join(', ');

  const where = []; const params = [];
  if (meta.txnType) { where.push('r.type = ?'); params.push(meta.txnType); }
  // Every custom type shares one table, so a query that did not say which
  // type it meant would show a register of calibration certificates somebody
  // else's list of subcontractors.
  if (meta.customType) { where.push('r.type_name = ?'); params.push(meta.customType); }

  for (const f of definition.filters || []) {
    if (!f?.field) continue;
    const op = OPERATORS[f.op || 'eq'];
    if (!op) throw badRequest(`Unknown operator "${f.op}"`);
    const col = colSql(f.field);
    if (op.noValue) { where.push(`(${col} ${op.sql.replace(/%COL%/g, col)})`); continue; }
    if (op.multi) {
      const vals = Array.isArray(f.value) ? f.value : String(f.value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!vals.length) { where.push('0=1'); continue; }
      where.push(`${col} IN (${vals.map(() => '?').join(',')})`); params.push(...vals); continue;
    }
    if (op.pair) {
      const [a, b] = Array.isArray(f.value) ? f.value : String(f.value ?? '').split(',');
      where.push(`${col} BETWEEN ? AND ?`); params.push(coerce(f, a), coerce(f, b)); continue;
    }
    where.push(`${col} ${op.sql}`);
    params.push(op.wrap ? op.wrap(f.value) : coerce(f, f.value));
  }

  function coerce(f, v) {
    const def = f.field.startsWith('custom.') ? customDefs[f.field.slice(7)] : fm[f.field];
    if (!def) return v;
    if (def.type === 'money') return Money.parse(v);
    if (def.type === 'qty') return Qty.parse(v);
    if (def.type === 'checkbox') return truthy(v) ? 1 : 0;
    return v;
  }

  // Row-level security, applied here rather than trusted to callers.
  const rf = rowFilter(access, meta.table, { alias: 'r' });

  // Sorting is validated the same way as columns.
  let orderSql = meta.defaultSort ? `r.${meta.defaultSort}` : 'r.id DESC';
  if (definition.sort) {
    const [col, dir = 'ASC'] = String(definition.sort).split(/\s+/);
    orderSql = `${colSql(col)} ${String(dir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`;
  }

  const whereSql = where.length ? ' AND ' + where.join(' AND ') : '';
  const cap = Math.min(Number(limit || definition.limit || 100), 5000);
  // Only some tables carry a `custom` JSON column; ask the schema rather than
  // assuming, or every list of a table without one 500s.
  const customSql = repo.db.$hasColumn(meta.table, 'custom') ? ', r.custom' : '';
  const rows = repo.query(
    `SELECT ${selectSql}${customSql} FROM ${meta.table} r WHERE r.tenant_id = :t${whereSql}${rf.sql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
    [...params, ...rf.params, cap, Number(offset || 0)]);
  const total = repo.scalar(
    `SELECT COUNT(*) c FROM ${meta.table} r WHERE r.tenant_id = :t${whereSql}${rf.sql}`,
    [...params, ...rf.params], 0);

  // Grouped result: totals per group for the summary rows in the grid.
  let groups = null;
  if (definition.group) {
    const g = colSql(definition.group);
    const agg = (definition.aggregate || []).filter((a) => fm[a.field] && ['sum', 'avg', 'min', 'max'].includes(a.fn));
    const aggSql = agg.map((a) => `${a.fn.toUpperCase()}(${colSql(a.field)}) AS "${a.fn}_${a.field}"`).join(', ');
    groups = repo.query(
      `SELECT ${g} AS group_key, COUNT(*) AS group_count${aggSql ? ', ' + aggSql : ''}
       FROM ${meta.table} r WHERE r.tenant_id = :t${whereSql}${rf.sql} GROUP BY ${g} ORDER BY group_count DESC LIMIT 200`,
      [...params, ...rf.params]);
  }

  const decorated = rows.map((r) => decorateCustom(repo, recordType, r));
  resolveReferences(repo, recordType, selectCols, decorated);

  return {
    record_type: recordType, columns: selectCols, rows: decorated,
    total, limit: cap, offset: Number(offset || 0), groups,
  };
}

/**
 * Attach `<column>_label` for every reference column in the result set.
 * Ids are gathered across the whole page and resolved with one query per
 * referenced table, so a 500-row list costs a handful of lookups rather
 * than 500 round trips.
 */
export function resolveReferences(repo, recordType, columns, rows) {
  if (!rows.length) return rows;
  const fm = fieldMap(recordType);
  const wanted = columns.filter((c) => fm[c] && (fm[c].ref || fm[c].refFrom));
  if (!wanted.length) return rows;

  // column -> refType -> Set(ids)
  const needed = new Map();
  for (const col of wanted) {
    const byType = new Map();
    for (const row of rows) {
      const id = row[col];
      if (!id) continue;
      const type = refTypeFor(fm[col], row);
      if (!type || !REF_LABEL[type]) continue;
      if (!byType.has(type)) byType.set(type, new Set());
      byType.get(type).add(id);
    }
    if (byType.size) needed.set(col, byType);
  }
  if (!needed.size) return rows;

  // Resolve each referenced table once, caching across columns.
  const cache = new Map();                       // `${type}:${id}` -> label
  for (const byType of needed.values()) {
    for (const [type, ids] of byType) {
      const spec = REF_LABEL[type];
      const missing = [...ids].filter((id) => !cache.has(`${type}:${id}`));
      for (let i = 0; i < missing.length; i += 400) {
        const chunk = missing.slice(i, i + 400);
        const found = repo.query(
          `SELECT ${spec.cols.join(',')} FROM ${spec.table}
            WHERE tenant_id = :t AND id IN (${chunk.map(() => '?').join(',')})`, chunk);
        for (const r of found) cache.set(`${type}:${r.id}`, spec.label(r));
      }
    }
  }

  for (const row of rows) {
    for (const col of needed.keys()) {
      const id = row[col];
      if (!id) continue;
      const type = refTypeFor(fm[col], row);
      const label = type ? cache.get(`${type}:${id}`) : null;
      if (label) row[`${col}_label`] = label;
    }
  }
  return rows;
}

export function saveSearch(repo, input) {
  const fields = {};
  if (!input.name) fields.name = 'Name is required';
  if (!input.record_type || !getMeta(input.record_type)) fields.record_type = 'Choose a record type';
  if (Object.keys(fields).length) throw new ValidationError(fields);
  // Fail fast on a broken definition rather than at run time.
  runSearch(repo, input.record_type, input.definition || {}, { limit: 1 });
  const now = nowIso();
  const id = repo.insert('saved_search', {
    id: ulid(), name: input.name, record_type: input.record_type,
    definition: input.definition || {}, owner_id: repo.ctx?.user?.id || null,
    is_public: input.is_public === false ? 0 : 1, is_system: 0, created_at: now, updated_at: now,
  });
  audit.record(repo, { recordType: 'saved_search', recordId: id, action: 'create', after: input });
  return repo.get('saved_search', id);
}

export function updateSavedSearch(repo, id, patch) {
  const before = repo.get('saved_search', id);
  if (!before) throw notFound('Saved search not found');
  if (before.is_system) throw unprocessable('Built-in searches cannot be modified. Save a copy instead.');
  if (patch.definition) runSearch(repo, patch.record_type || before.record_type, patch.definition, { limit: 1 });
  repo.update('saved_search', id, {
    name: patch.name ?? before.name, definition: patch.definition ?? before.definition,
    is_public: patch.is_public === undefined ? before.is_public : (patch.is_public ? 1 : 0),
    updated_at: nowIso(),
  });
  audit.record(repo, { recordType: 'saved_search', recordId: id, action: 'update', before });
  return repo.get('saved_search', id);
}

// =====================================================================
// WORKFLOWS
// =====================================================================

export const TRIGGERS = ['before_create', 'after_create', 'before_update', 'after_update', 'on_approve', 'on_post'];

export const ACTION_TYPES = {
  set_field: { label: 'Set a field', params: ['field', 'value'], phase: 'before' },
  block: { label: 'Block the save with a message', params: ['message'], phase: 'before' },
  require_approval: { label: 'Route for approval', params: [], phase: 'before' },
  create_task: { label: 'Create a follow-up task', params: ['subject', 'due_in_days', 'assign_to'] },
  notify: { label: 'Send an in-app notification', params: ['title', 'body', 'user', 'severity'] },
  webhook: { label: 'Queue an outbound webhook', params: ['url', 'event_type'] },
  log: { label: 'Write to the workflow log', params: ['message'] },
};

export function createWorkflow(repo, input) {
  const fields = {};
  if (!input.name) fields.name = 'Name is required';
  if (!input.record_type || !getMeta(input.record_type)) fields.record_type = 'Choose a record type';
  if (!TRIGGERS.includes(input.trigger)) fields.trigger = `Trigger must be one of: ${TRIGGERS.join(', ')}`;
  if (input.condition) {
    const v = validateExpr(input.condition);
    if (!v.ok) fields.condition = v.error;
  }
  const actions = Array.isArray(input.actions) ? input.actions : [];
  if (!actions.length) fields.actions = 'Add at least one action';
  actions.forEach((a, i) => {
    if (!ACTION_TYPES[a.type]) fields[`actions.${i}`] = `Unknown action "${a.type}"`;
    else if (ACTION_TYPES[a.type].phase === 'before' && !String(input.trigger).startsWith('before')) {
      fields[`actions.${i}`] = `"${ACTION_TYPES[a.type].label}" only works on a before_create or before_update trigger`;
    }
  });
  if (Object.keys(fields).length) throw new ValidationError(fields);

  const now = nowIso();
  const id = repo.insert('workflow', {
    id: ulid(), name: input.name, description: input.description || '',
    record_type: input.record_type, trigger: input.trigger, condition: input.condition || '',
    actions, status: input.status || 'draft', priority: Number(input.priority || 100),
    run_count: 0, created_at: now, updated_at: now,
  });
  audit.record(repo, { recordType: 'workflow', recordId: id, action: 'create', after: input });
  return repo.get('workflow', id);
}

export function updateWorkflow(repo, id, patch) {
  const before = repo.get('workflow', id);
  if (!before) throw notFound('Workflow not found');
  if (patch.condition) {
    const v = validateExpr(patch.condition);
    if (!v.ok) throw new ValidationError({ condition: v.error });
  }
  const allowed = ['name', 'description', 'record_type', 'trigger', 'condition', 'actions', 'status', 'priority'];
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  clean.updated_at = nowIso();
  repo.update('workflow', id, clean);
  audit.record(repo, { recordType: 'workflow', recordId: id, action: 'update', before, after: repo.get('workflow', id) });
  return repo.get('workflow', id);
}

/**
 * Run every released workflow matching (recordType, trigger).
 *
 * `before_*` triggers may mutate `record` in place or block the save.
 * `after_*` triggers get a frozen view and may only create side effects.
 * A failing workflow is logged and skipped -- tenant automation must not be
 * able to take down a posting run.
 */
export function dispatch(repo, recordType, trigger, record, { before = null, mutable = null } = {}) {
  const workflows = repo.query(`SELECT * FROM workflow WHERE tenant_id = :t AND record_type = ? AND trigger = ?
      AND status = 'released' ORDER BY priority, name`, [recordType, trigger]);
  if (!workflows.length) return { ran: 0, blocked: null, changes: {} };

  const scope = buildScope(repo, recordType, record, before);
  const changes = {};
  let blocked = null; let ran = 0;

  for (const wf of workflows) {
    const started = Date.now();
    try {
      if (wf.condition && !exprTest(wf.condition, scope)) {
        logWorkflow(repo, wf, record, 'skipped', 'Condition not met', Date.now() - started);
        continue;
      }
      for (const action of (wf.actions || [])) {
        const outcome = runAction(repo, wf, action, scope, { record, mutable, recordType });
        if (outcome?.blocked) { blocked = outcome.blocked; break; }
        if (outcome?.field) { changes[outcome.field] = outcome.value; scope[outcome.field] = outcome.value; }
      }
      repo.exec('UPDATE workflow SET run_count = run_count + 1 WHERE tenant_id = :t AND id = ?', [wf.id]);
      logWorkflow(repo, wf, record, 'matched', blocked ? `Blocked: ${blocked}` : 'Actions executed', Date.now() - started);
      ran++;
      if (blocked) break;
    } catch (e) {
      logWorkflow(repo, wf, record, 'error', e.message.slice(0, 400), Date.now() - started);
    }
  }
  return { ran, blocked, changes };
}

function buildScope(repo, recordType, record, before) {
  const meta = getMeta(recordType);
  const scope = { ...record, custom: record?.custom || {}, today: today(), record_type: recordType };
  // Money fields are exposed in natural units so conditions read naturally:
  //   total > 10000  rather than  total > 1000000
  for (const f of meta?.fields || []) {
    if (f.type === 'money' && typeof record?.[f.name] === 'number') scope[f.name] = Money.toNumber(record[f.name]);
    if (f.type === 'qty' && typeof record?.[f.name] === 'number') scope[f.name] = Qty.toNumber(record[f.name]);
  }
  scope.old = before ? { ...before } : null;
  scope.is_new = !before;
  scope.changed = before ? Object.fromEntries(Object.keys(record || {}).filter((k) => record[k] !== before[k]).map((k) => [k, true])) : {};
  scope.user = repo.ctx?.user ? { id: repo.ctx.user.id, name: repo.ctx.user.name, email: repo.ctx.user.email } : null;
  return scope;
}

function runAction(repo, wf, action, scope, { record, mutable, recordType }) {
  const val = (expr, fallback = '') => {
    if (expr === undefined || expr === null) return fallback;
    if (typeof expr === 'string' && expr.startsWith('=')) return evalSafe(expr.slice(1), scope, fallback);
    return expr;
  };
  switch (action.type) {
    case 'block':
      return { blocked: String(val(action.message, 'This record was blocked by a workflow rule.')) };
    case 'set_field': {
      if (!action.field) return null;
      const value = val(action.value, null);
      if (mutable) mutable[action.field] = value;
      return { field: action.field, value };
    }
    case 'require_approval':
      if (mutable) { mutable.approval_status = 'pending'; mutable.status = 'pending_approval'; }
      return { field: 'approval_status', value: 'pending' };
    case 'create_task': {
      repo.insert('activity', {
        id: ulid(), type: 'task', subject: String(val(action.subject, `Follow up: ${wf.name}`)).slice(0, 250),
        notes: `Created by workflow "${wf.name}"`, related_type: recordType, related_id: record?.id || null,
        owner_id: repo.ctx?.user?.id || null,
        assigned_to: action.assign_to === 'owner' ? (record?.owner_id || repo.ctx?.user?.id) : (action.assign_to || repo.ctx?.user?.id) || null,
        priority: action.priority || 'normal',
        due_date: addDays(today(), Number(action.due_in_days || 3)),
        start_at: null, completed_at: null, status: 'open', custom: {},
        created_at: nowIso(), updated_at: nowIso(),
      });
      return null;
    }
    case 'notify': {
      repo.insert('notification', {
        id: ulid(),
        user_id: action.user === 'owner' ? (record?.owner_id || null) : (action.user || repo.ctx?.user?.id || null),
        title: String(val(action.title, wf.name)).slice(0, 200),
        body: String(val(action.body, '')).slice(0, 1000),
        severity: action.severity || 'info',
        link: record?.id ? `#/${recordType}/${record.id}` : '',
        created_at: nowIso(),
      });
      return null;
    }
    case 'webhook': {
      // Queued, never called inline: the ledger must not wait on the network.
      repo.insert('integration_event', {
        id: ulid(), channel: 'webhook', event_type: action.event_type || `${recordType}.${wf.trigger}`,
        record_type: recordType, record_id: record?.id || null,
        payload: { workflow: wf.name, record }, status: 'pending', attempts: 0,
        last_error: '', target_url: String(action.url || ''), created_at: nowIso(),
      });
      return null;
    }
    case 'log':
    default:
      return null;
  }
}

function logWorkflow(repo, wf, record, result, message, durationMs) {
  repo.db.$prepare(`INSERT INTO workflow_log (id, tenant_id, workflow_id, record_type, record_id, at, result, message, duration_ms)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(ulid(), repo.tenantId, wf.id, wf.record_type, record?.id || null, nowIso(), result, String(message).slice(0, 500), durationMs);
}

/** Dry-run a workflow against a real record, without side effects. */
export function testWorkflow(repo, id, recordId) {
  const wf = repo.get('workflow', id);
  if (!wf) throw notFound('Workflow not found');
  const meta = getMeta(wf.record_type);
  if (!meta) throw badRequest('That workflow targets an unknown record type');
  const record = repo.get(meta.table, recordId);
  if (!record) throw notFound(`No ${meta.label} with id ${recordId}`);
  const scope = buildScope(repo, wf.record_type, record, null);
  let matched, error = null;
  try { matched = wf.condition ? exprTest(wf.condition, scope) : true; }
  catch (e) { matched = false; error = e.message; }
  return {
    workflow: wf.name, record_id: recordId, matched, error,
    scope_preview: Object.fromEntries(Object.entries(scope).filter(([, v]) => typeof v !== 'object').slice(0, 40)),
    would_run: matched ? (wf.actions || []).map((a) => ({ type: a.type, label: ACTION_TYPES[a.type]?.label || a.type })) : [],
  };
}

// =====================================================================
// SERVER SCRIPTS (opt-in)
// =====================================================================

/**
 * SuiteScript-style server scripts.
 *
 * DISABLED unless MERIDIAN_ENABLE_SCRIPTS=1. `node:vm` is an isolation
 * mechanism, NOT a security boundary -- a determined script can escape it.
 * It is therefore appropriate only for single-tenant deployments where the
 * script author already has server access, and it is documented that way.
 * Multi-tenant deployments should use workflows, which are safe by design.
 */
export const scriptsEnabled = () => process.env.MERIDIAN_ENABLE_SCRIPTS === '1';

export async function runServerScript(repo, script, context = {}) {
  if (!scriptsEnabled()) {
    throw new HttpError(403, 'Server scripts are disabled. Set MERIDIAN_ENABLE_SCRIPTS=1 to enable them, and read docs/SECURITY.md first — this feature is not multi-tenant safe.', 'SCRIPTS_DISABLED');
  }
  const vm = await import('node:vm');
  const logs = [];
  const sandbox = {
    record: structuredClone(context.record || {}),
    old: structuredClone(context.before || null),
    user: repo.ctx?.user ? { id: repo.ctx.user.id, name: repo.ctx.user.name } : null,
    today: today(),
    log: (...a) => { if (logs.length < 100) logs.push(a.map(String).join(' ')); },
    result: {},
  };
  const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  try {
    new vm.Script(script.code, { filename: `script:${script.name}` })
      .runInContext(ctx, { timeout: Math.min(script.timeout_ms || 250, 2000), breakOnSigint: true });
    return { ok: true, result: sandbox.result, record: sandbox.record, logs };
  } catch (e) {
    return { ok: false, error: e.message, logs };
  }
}

// =====================================================================
// NOTIFICATIONS
// =====================================================================

export const listNotifications = (repo, userId, { unreadOnly = false, limit = 50 } = {}) =>
  repo.query(`SELECT * FROM notification WHERE tenant_id = :t AND (user_id = ? OR user_id IS NULL)
      ${unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT ?`, [userId, limit]);

// Scoped to the reader: a notification belongs to one person (or to everyone,
// when user_id is null), and dismissing somebody else's approval alert is not
// a thing one colleague gets to do to another.
export const markNotificationRead = (repo, id, userId) =>
  repo.exec('UPDATE notification SET read_at = ? WHERE tenant_id = :t AND id = ? AND (user_id = ? OR user_id IS NULL)',
    [nowIso(), id, userId]).changes;

export const markAllRead = (repo, userId) =>
  repo.exec('UPDATE notification SET read_at = ? WHERE tenant_id = :t AND (user_id = ? OR user_id IS NULL) AND read_at IS NULL', [nowIso(), userId]).changes;
