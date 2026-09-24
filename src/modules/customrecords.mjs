// Meridian ERP :: custom records
//
// Records the product does not know about.
//
// A custom record type that behaves differently from a built-in one is worth
// very little -- the point is not to have somewhere to put the data, it is to
// have it list, search, validate, import, export, permission and audit like
// everything else. So almost nothing here is new machinery. A type is turned
// into the same descriptor the built-in records are described by, and from
// that moment the generic record layer cannot tell the difference.
//
// Two decisions worth stating.
//
// Fields reuse `custom_field` unchanged. It already describes a field's type,
// options, requiredness and what it refers to, and the coercion and rendering
// for all of that already exists. A second, parallel field table would have
// been a second thing to keep in step.
//
// Values live in one `custom_record` table, in its JSON column, rather than in
// a table per type. A table per type queries better and lives far worse: it
// means running DDL at runtime, on a tenant's behalf, inside a database shared
// with every other tenant. That is how one customer's mistake becomes
// everybody's outage.
import { ulid, nowIso } from '../core/util.mjs';
import { ValidationError, notFound, unprocessable, conflict, badRequest } from '../core/http.mjs';
import { nextNumber } from '../core/seq.mjs';
import * as audit from '../core/audit.mjs';
import { indexRecord } from '../core/search.mjs';
import * as platform from './platform.mjs';

/**
 * Custom types are addressed as `c_<name>`.
 *
 * Prefixed rather than bare so that a custom type can never collide with a
 * built-in one, whatever somebody calls it, and so that any code looking at a
 * record type can tell which kind it has without asking the database.
 */
export const PREFIX = 'c_';
export const isCustomType = (type) => typeof type === 'string' && type.startsWith(PREFIX);
export const bareName = (type) => (isCustomType(type) ? type.slice(PREFIX.length) : type);
export const qualified = (name) => PREFIX + name;

const NAME_RX = /^[a-z][a-z0-9_]{1,38}$/;
export const NAV_GROUPS = ['Financial', 'Sales', 'CRM', 'Purchasing', 'Inventory', 'Projects',
  'Manufacturing', 'Commerce', 'Service', 'People', 'Platform'];

/** Columns of `custom_record` that a type never gets to redefine. */
const RESERVED = new Set(['id', 'tenant_id', 'type_name', 'record_no', 'name',
  'subsidiary_id', 'parent_type', 'parent_id', 'custom', 'active',
  'created_at', 'created_by', 'updated_at']);

// ------------------------------------------------------------------ types
export function listTypes(repo, { includeInactive = false } = {}) {
  const where = ['tenant_id = :t'];
  if (!includeInactive) where.push('active = 1');
  return repo.query(`SELECT * FROM custom_record_type WHERE ${where.join(' AND ')} ORDER BY label`);
}

export function getType(repo, idOrName) {
  const name = bareName(idOrName);
  return repo.get('custom_record_type', idOrName)
    || repo.queryOne('SELECT * FROM custom_record_type WHERE tenant_id = :t AND name = ?', [name]);
}

export function requireType(repo, idOrName) {
  const t = getType(repo, idOrName);
  if (!t) throw notFound(`There is no custom record type called "${bareName(idOrName)}"`);
  return t;
}

export function createType(repo, input = {}) {
  const errors = {};
  const name = String(input.name || '').trim().toLowerCase();
  if (!NAME_RX.test(name)) {
    errors.name = 'Use lowercase letters, digits and underscores, starting with a letter (2 to 39 characters)';
  }
  if (!input.label) errors.label = 'Give it a name people will read';
  if (input.nav_group && !NAV_GROUPS.includes(input.nav_group)) {
    errors.nav_group = `Choose one of ${NAV_GROUPS.join(', ')}`;
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  if (repo.queryOne('SELECT id FROM custom_record_type WHERE tenant_id = :t AND name = ?', [name])) {
    throw new ValidationError({ name: `A custom record type called "${name}" already exists` });
  }

  const now = nowIso();
  const id = repo.insert('custom_record_type', {
    id: ulid(), name, label: input.label,
    plural: input.plural || `${input.label}s`,
    description: input.description || '',
    icon: input.icon || '▤',
    nav_group: input.nav_group || 'Platform',
    numbered: input.numbered ? 1 : 0,
    number_prefix: input.number_prefix || '',
    title_field: input.title_field || 'name',
    show_in_nav: input.show_in_nav === false ? 0 : 1,
    active: 1, created_at: now, created_by: repo.ctx?.user?.id || null, updated_at: now,
  });
  // A numbered type needs its own sequence before the first record asks for
  // a number, because `nextNumber` only knows the prefixes built into the
  // product and this one was invented five seconds ago.
  if (input.numbered) {
    repo.exec(
      'INSERT INTO sequence (tenant_id, name, prefix, next_value, padding) VALUES (:t,?,?,1,5) ON CONFLICT DO NOTHING',
      [`c_${name}`, input.number_prefix || '']);
  }
  audit.record(repo, { recordType: 'custom_record_type', recordId: id, action: 'create', after: input });
  return repo.get('custom_record_type', id);
}

const EDITABLE_TYPE_FIELDS = ['label', 'plural', 'description', 'icon', 'nav_group',
  'numbered', 'number_prefix', 'title_field', 'show_in_nav', 'active'];

export function updateType(repo, id, patch = {}) {
  const before = requireType(repo, id);
  if (patch.name !== undefined && patch.name !== before.name) {
    // The name is the address. Every record of the type, every custom field
    // on it and every saved search over it is filed under it.
    throw unprocessable(`A custom record type's name cannot change once it exists — ${before.name} is what its records, fields and searches are filed under. Create a new type if you need a different name.`);
  }
  if (patch.nav_group !== undefined && !NAV_GROUPS.includes(patch.nav_group)) {
    throw new ValidationError({ nav_group: `Choose one of ${NAV_GROUPS.join(', ')}` });
  }
  const values = { updated_at: nowIso() };
  for (const f of EDITABLE_TYPE_FIELDS) {
    if (patch[f] === undefined) continue;
    values[f] = ['numbered', 'show_in_nav', 'active'].includes(f) ? (patch[f] ? 1 : 0) : patch[f];
  }
  repo.update('custom_record_type', before.id, values);
  audit.record(repo, { recordType: 'custom_record_type', recordId: before.id, action: 'update', before, after: patch });
  return repo.get('custom_record_type', before.id);
}

export function deleteType(repo, id) {
  const t = requireType(repo, id);
  const count = repo.scalar('SELECT COUNT(*) c FROM custom_record WHERE tenant_id = :t AND type_name = ?', [t.name], 0);
  if (count) {
    throw conflict(`${t.label} has ${count} record${count === 1 ? '' : 's'}. Deactivate the type instead — deleting it would take them with it, and they are somebody's data.`);
  }
  repo.exec('DELETE FROM custom_field WHERE tenant_id = :t AND record_type = ?', [qualified(t.name)]);
  repo.exec('DELETE FROM custom_record_type WHERE tenant_id = :t AND id = ?', [t.id]);
  audit.record(repo, { recordType: 'custom_record_type', recordId: t.id, action: 'delete', before: t });
  return { deleted: true };
}

/** The fields a type defines, in display order. */
export const fieldsOfType = (repo, name) => repo.query(
  `SELECT * FROM custom_field WHERE tenant_id = :t AND record_type = ? AND active = 1
   ORDER BY display_order, label`, [qualified(bareName(name))]);

// ------------------------------------------------------------- descriptor
/**
 * Turn a type into the descriptor the rest of the system already understands.
 *
 * This is the whole trick. From here on, list views, the record screen,
 * search, CSV import and export, saved searches and permissions all work on a
 * custom record without a line of code that knows it is custom.
 */
export function describeType(repo, typeOrName) {
  const t = getType(repo, typeOrName);
  if (!t) return null;

  const F = (name, label, type, extra = {}) => ({ name, label, type, ...extra });
  const fields = [
    F('name', t.title_field === 'name' ? 'Name' : 'Title', 'text', { required: true, width: 240 }),
  ];
  if (t.numbered) {
    fields.unshift(F('record_no', 'Number', 'text', { readOnly: true, width: 120 }));
  }

  const custom = fieldsOfType(repo, t.name);
  for (const c of custom) {
    fields.push(F(c.name, c.label, c.type, {
      required: !!c.required,
      options: c.options || [],
      ref: c.ref_type || undefined,
      help: c.help_text || undefined,
      formula: c.formula || undefined,
      readOnly: c.type === 'formula',
      // Values live in the JSON column, so the record layer has to be told
      // where to read and write them.
      inCustom: true,
      showInList: !!c.show_in_list,
    }));
  }

  fields.push(
    F('subsidiary_id', 'Subsidiary', 'reference', { ref: 'subsidiary', section: 'Classification' }),
    F('active', 'Active', 'checkbox', { width: 80 }),
    F('created_at', 'Created', 'datetime', { readOnly: true, section: 'System' }),
    F('updated_at', 'Last modified', 'datetime', { readOnly: true, section: 'System' }),
  );

  const listed = custom.filter((c) => c.show_in_list).map((c) => c.name).slice(0, 4);
  return {
    table: 'custom_record',
    customType: t.name,
    label: t.label,
    plural: t.plural || `${t.label}s`,
    group: t.nav_group || 'Platform',
    icon: t.icon || '▤',
    // One permission covers every custom type. Giving each its own would mean
    // a role screen that grows without limit and an administrator who stops
    // reading it.
    permission: 'custom_record',
    title: t.numbered ? 'record_no' : 'name',
    defaultSort: 'created_at DESC',
    isCustom: true,
    description: t.description || '',
    fields,
    listColumns: [...(t.numbered ? ['record_no'] : []), 'name', ...listed, 'created_at'],
    // Searchable by the fields it invented, not only by its name. A register
    // of certificates is looked up by serial number far more often than by
    // whatever somebody typed in the name box.
    searchFields: ['name', 'record_no',
      ...custom.filter((c) => ['text', 'longtext', 'select'].includes(c.type)).map((c) => c.name)],
    // Every query on this table has to be confined to one type, or a list of
    // calibration certificates would show somebody's subcontractors too.
    baseFilter: { type_name: t.name },
  };
}

/** Every custom type as a descriptor, for navigation and record-type lists. */
export function describeAll(repo) {
  const out = {};
  for (const t of listTypes(repo)) {
    const d = describeType(repo, t.name);
    if (d) out[qualified(t.name)] = d;
  }
  return out;
}

// ----------------------------------------------------------------- records
const splitValues = (descriptor, body) => {
  const columns = {};
  const custom = {};
  for (const f of descriptor.fields) {
    if (f.readOnly || !(f.name in body)) continue;
    if (f.inCustom) custom[f.name] = body[f.name];
    else columns[f.name] = body[f.name];
  }
  return { columns, custom };
};

/**
 * The columns this table owns, validated here; the type's own fields, handed
 * to the same validator every other custom field in the product goes through.
 *
 * That matters for more than tidiness: it is what turns a money field's "710"
 * into 71000 minor units, a checkbox's "on" into 1, and a date that is not one
 * into an error. Doing it again here would be a second implementation to keep
 * in step, and it would drift.
 */
function validateColumns(descriptor, columns) {
  const errors = {};
  for (const f of descriptor.fields) {
    if (!f.required || f.readOnly || f.inCustom) continue;
    const v = columns[f.name];
    if (v === null || v === undefined || v === '') errors[f.name] = `${f.label} is required`;
  }
  return errors;
}

export function createRecord(repo, type, body = {}) {
  const d = describeType(repo, type);
  if (!d) throw badRequest(`There is no custom record type called "${bareName(type)}"`);
  const { columns, custom } = splitValues(d, body);
  const errors = validateColumns(d, columns);
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const values = platform.validateCustom(repo, qualified(bareName(type)), custom);

  const t = requireType(repo, type);
  const now = nowIso();
  const id = repo.insert('custom_record', {
    id: ulid(),
    type_name: t.name,
    record_no: t.numbered ? nextNumber(repo, `c_${t.name}`) : '',
    name: columns.name || '',
    subsidiary_id: columns.subsidiary_id || null,
    parent_type: body.parent_type || null,
    parent_id: body.parent_id || null,
    custom: values,
    active: columns.active === undefined ? 1 : (columns.active ? 1 : 0),
    created_at: now, created_by: repo.ctx?.user?.id || null, updated_at: now,
  });

  const row = repo.get('custom_record', id);
  audit.record(repo, { recordType: qualified(t.name), recordId: id, action: 'create', after: body });
  indexRecord(repo, qualified(t.name), id, {
    title: row.record_no ? `${row.record_no} · ${row.name}` : row.name,
    subtitle: t.label,
    body: [row.name, ...Object.values(values || {}).map((v) => (v == null ? '' : String(v)))].join(' '),
  });
  return row;
}

export function updateRecord(repo, type, id, body = {}) {
  const d = describeType(repo, type);
  if (!d) throw badRequest(`There is no custom record type called "${bareName(type)}"`);
  const before = repo.get('custom_record', id);
  if (!before || before.type_name !== bareName(type)) throw notFound(`${d.label} not found`);

  const { columns, custom } = splitValues(d, body);
  // A patch names some fields, not all of them. Merging before validating
  // means a form that sends one field does not blank the rest, and a required
  // field already filled in does not suddenly complain.
  const errors = validateColumns(d, { ...before, ...columns });
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const merged = { ...(before.custom || {}), ...platform.validateCustom(repo, qualified(bareName(type)), custom, { partial: true }) };

  const values = { updated_at: nowIso(), custom: merged };
  if ('name' in columns) values.name = columns.name || '';
  if ('subsidiary_id' in columns) values.subsidiary_id = columns.subsidiary_id || null;
  if ('active' in columns) values.active = columns.active ? 1 : 0;
  if ('parent_type' in body) values.parent_type = body.parent_type || null;
  if ('parent_id' in body) values.parent_id = body.parent_id || null;

  repo.update('custom_record', id, values);
  const row = repo.get('custom_record', id);
  audit.record(repo, { recordType: qualified(before.type_name), recordId: id, action: 'update', before, after: body });
  indexRecord(repo, qualified(before.type_name), id, {
    title: row.record_no ? `${row.record_no} · ${row.name}` : row.name,
    subtitle: d.label,
    body: [row.name, ...Object.values(merged || {}).map((v) => (v == null ? '' : String(v)))].join(' '),
  });
  return row;
}

export function deleteRecord(repo, type, id) {
  const before = repo.get('custom_record', id);
  if (!before || before.type_name !== bareName(type)) throw notFound('Record not found');
  repo.exec('DELETE FROM custom_record WHERE tenant_id = :t AND id = ?', [id]);
  audit.record(repo, { recordType: qualified(before.type_name), recordId: id, action: 'delete', before });
  return { deleted: true };
}

/**
 * Records of one type.
 *
 * `custom` is flattened onto each row so a list or an export sees one flat
 * record, the way it does for everything else.
 */
export function listRecords(repo, type, { search = null, active = null, limit = 200, offset = 0 } = {}) {
  const t = requireType(repo, type);
  const where = ['tenant_id = :t', 'type_name = ?'];
  const params = [t.name];
  if (active !== null) { where.push('active = ?'); params.push(active ? 1 : 0); }
  if (search) {
    where.push('(name LIKE ? OR record_no LIKE ? OR custom LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  const total = repo.scalar(`SELECT COUNT(*) c FROM custom_record WHERE ${where.join(' AND ')}`, params, 0);
  const rows = repo.query(
    `SELECT * FROM custom_record WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, Math.min(limit, 1000), offset]);
  return { rows: rows.map(flatten), total, type: describeType(repo, t.name) };
}

export function getRecord(repo, type, id) {
  const row = repo.get('custom_record', id);
  if (!row || row.type_name !== bareName(type)) throw notFound('Record not found');
  return flatten(row);
}

/** One flat record: the columns, with the JSON values alongside them. */
export function flatten(row) {
  if (!row) return row;
  const { custom, ...rest } = row;
  return { ...rest, ...(custom || {}), custom };
}
