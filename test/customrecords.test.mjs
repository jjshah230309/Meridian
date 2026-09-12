// Records the product does not know about.
//
// The point of these is not that the data can be stored -- any JSON column
// does that. It is that a custom record behaves like a built-in one: it
// validates, it lists, it searches, it permissions, it audits, and one type's
// records never leak into another's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant } from './helpers.mjs';
import * as cr from '../src/modules/customrecords.mjs';
import * as platform from '../src/modules/platform.mjs';
import * as records from '../src/modules/records.mjs';
import * as meta from '../src/modules/meta.mjs';

const thrown = (fn) => { try { fn(); } catch (e) { return e; } return null; };

function certificates(f, extra = {}) {
  const type = f.tx(() => cr.createType(f.repo, {
    name: 'calibration_cert', label: 'Calibration Certificate',
    plural: 'Calibration Certificates', nav_group: 'Inventory',
    description: 'Proof that a gauge reads true.', ...extra,
  }));
  const field = (input) => f.tx(() => platform.createCustomField(f.repo, {
    record_type: cr.qualified('calibration_cert'), ...input,
  }));
  field({ name: 'serial', label: 'Serial number', type: 'text', required: true, show_in_list: 1, display_order: 1 });
  field({ name: 'expires_on', label: 'Expires', type: 'date', show_in_list: 1, display_order: 2 });
  field({ name: 'passed', label: 'Passed', type: 'checkbox', display_order: 3 });
  return type;
}

// -------------------------------------------------------------- the type
test('a type is addressed with a prefix so it cannot collide with a built-in', () => {
  const f = freshTenant();
  certificates(f);
  assert.equal(cr.qualified('calibration_cert'), 'c_calibration_cert');
  assert.ok(cr.isCustomType('c_calibration_cert'));
  assert.equal(cr.isCustomType('customer'), false);
  // A type called "customer" is still its own thing and shadows nothing.
  f.tx(() => cr.createType(f.repo, { name: 'customer', label: 'Customer Survey' }));
  assert.equal(meta.getMeta('customer', f.repo).table, 'customer', 'the built-in still wins its own name');
  assert.equal(meta.getMeta('c_customer', f.repo).label, 'Customer Survey');
});

test('a bad machine name is refused with a name somebody can act on', () => {
  const f = freshTenant();
  for (const bad of ['Calibration Cert', '1cert', 'a', '', 'cert-type', 'cert!']) {
    const e = thrown(() => f.tx(() => cr.createType(f.repo, { name: bad, label: 'X' })));
    assert.ok(e, `${bad} should be refused`);
  }
});

test('a name in the wrong case is corrected rather than rejected', () => {
  const f = freshTenant();
  const t = f.tx(() => cr.createType(f.repo, { name: '  CALIBRATION_CERT  ', label: 'X' }));
  assert.equal(t.name, 'calibration_cert');
});

test('two types cannot share a name', () => {
  const f = freshTenant();
  certificates(f);
  const e = thrown(() => f.tx(() => cr.createType(f.repo, { name: 'calibration_cert', label: 'Another' })));
  assert.match(JSON.stringify(e.details), /already exists/);
});

test('the name cannot change once records are filed under it', () => {
  const f = freshTenant();
  const t = certificates(f);
  const e = thrown(() => f.tx(() => cr.updateType(f.repo, t.id, { name: 'something_else' })));
  assert.match(e.message, /cannot change/);
  // Everything else about it can.
  const updated = f.tx(() => cr.updateType(f.repo, t.id, { label: 'Gauge Certificate', nav_group: 'Manufacturing' }));
  assert.equal(updated.label, 'Gauge Certificate');
  assert.equal(updated.nav_group, 'Manufacturing');
});

// -------------------------------------------------------- the descriptor
test('a type describes itself the way a built-in record does', () => {
  const f = freshTenant();
  certificates(f);
  const d = meta.getMeta('c_calibration_cert', f.repo);

  assert.equal(d.table, 'custom_record');
  assert.equal(d.label, 'Calibration Certificate');
  assert.equal(d.permission, 'custom_record');
  assert.equal(d.group, 'Inventory');
  // Its own fields are there alongside the standard ones.
  const names = d.fields.map((x) => x.name);
  assert.ok(names.includes('name'));
  assert.ok(names.includes('serial'));
  assert.ok(names.includes('expires_on'));
  assert.ok(names.includes('created_at'));
  // And the ones it defined are marked as living in the JSON column.
  assert.equal(d.fields.find((x) => x.name === 'serial').inCustom, true);
  assert.equal(d.fields.find((x) => x.name === 'name').inCustom, undefined);
  // Fields flagged for the list turn into columns.
  assert.ok(d.listColumns.includes('serial'));
});

test('an unknown type describes itself as nothing rather than throwing', () => {
  const f = freshTenant();
  assert.equal(meta.getMeta('c_nope', f.repo), null);
  // Without a repo a custom type simply is not knowable, and says so.
  assert.equal(meta.getMeta('c_calibration_cert'), null);
});

// ------------------------------------------------------------- records
test('a record validates against the fields its type defines', () => {
  const f = freshTenant();
  certificates(f);
  const e = thrown(() => f.tx(() => records.createRecord(f.repo, 'c_calibration_cert', {
    name: 'Gauge 4 annual',
  })));
  assert.match(JSON.stringify(e.details), /Serial number is required/);
});

test('a record stores its own fields and reads back flat', () => {
  const f = freshTenant();
  certificates(f);
  const made = f.tx(() => records.createRecord(f.repo, 'c_calibration_cert', {
    name: 'Gauge 4 annual', serial: 'GA-4471', expires_on: '2027-03-31', passed: true,
  }));
  assert.equal(made.name, 'Gauge 4 annual');
  assert.equal(made.custom.serial, 'GA-4471');

  const back = cr.getRecord(f.repo, 'c_calibration_cert', made.id);
  assert.equal(back.serial, 'GA-4471', 'read back as one flat record');
  assert.equal(back.expires_on, '2027-03-31');
});

test('a patch changes what it names and leaves the rest alone', () => {
  const f = freshTenant();
  certificates(f);
  const made = f.tx(() => records.createRecord(f.repo, 'c_calibration_cert', {
    name: 'Gauge 4', serial: 'GA-4471', expires_on: '2027-03-31',
  }));
  const after = f.tx(() => records.updateRecord(f.repo, 'c_calibration_cert', made.id, { expires_on: '2028-03-31' }));
  assert.equal(after.custom.expires_on, '2028-03-31');
  assert.equal(after.custom.serial, 'GA-4471', 'the field the patch did not mention survives');
});

test('one type never sees another type’s records', () => {
  const f = freshTenant();
  certificates(f);
  f.tx(() => cr.createType(f.repo, { name: 'subcontractor', label: 'Approved Subcontractor' }));
  f.tx(() => records.createRecord(f.repo, 'c_calibration_cert', { name: 'Gauge 4', serial: 'GA-1' }));
  f.tx(() => records.createRecord(f.repo, 'c_calibration_cert', { name: 'Gauge 5', serial: 'GA-2' }));
  f.tx(() => records.createRecord(f.repo, 'c_subcontractor', { name: 'Hale Electrical' }));

  assert.equal(cr.listRecords(f.repo, 'c_calibration_cert').total, 2);
  assert.equal(cr.listRecords(f.repo, 'c_subcontractor').total, 1);
  // And they share a table, which is exactly why the filter matters.
  assert.equal(f.repo.scalar('SELECT COUNT(*) c FROM custom_record WHERE tenant_id = :t', [], 0), 3);
});

test('fetching a record of the wrong type is a miss, not somebody else’s data', () => {
  const f = freshTenant();
  certificates(f);
  f.tx(() => cr.createType(f.repo, { name: 'subcontractor', label: 'Approved Subcontractor' }));
  const cert = f.tx(() => records.createRecord(f.repo, 'c_calibration_cert', { name: 'Gauge 4', serial: 'GA-1' }));
  const e = thrown(() => cr.getRecord(f.repo, 'c_subcontractor', cert.id));
  assert.equal(e.status, 404);
});

test('a numbered type gives its records document numbers', () => {
  const f = freshTenant();
  certificates(f, { numbered: true, number_prefix: 'CAL-' });
  const a = f.tx(() => records.createRecord(f.repo, 'c_calibration_cert', { name: 'One', serial: 'S1' }));
  const b = f.tx(() => records.createRecord(f.repo, 'c_calibration_cert', { name: 'Two', serial: 'S2' }));
  assert.equal(a.record_no, 'CAL-00001');
  assert.equal(b.record_no, 'CAL-00002');
  assert.equal(meta.getMeta('c_calibration_cert', f.repo).title, 'record_no');
});

test('an unnumbered type does not invent numbers nobody asked for', () => {
  const f = freshTenant();
  certificates(f);
  const a = f.tx(() => records.createRecord(f.repo, 'c_calibration_cert', { name: 'One', serial: 'S1' }));
  assert.equal(a.record_no, '');
});

// A money field that stored 710 instead of 71000 would show as £7.10 and be
// wrong in every report that touched it. Coercion goes through the same
// validator every other custom field in the product uses.
test('values are coerced the way they are everywhere else', () => {
  const f = freshTenant();
  const t = f.tx(() => cr.createType(f.repo, { name: 'subbie', label: 'Subcontractor' }));
  const field = (input) => f.tx(() => platform.createCustomField(f.repo, {
    record_type: cr.qualified('subbie'), ...input,
  }));
  field({ name: 'day_rate', label: 'Day rate', type: 'money' });
  field({ name: 'vetted', label: 'Vetted', type: 'checkbox' });
  field({ name: 'headcount', label: 'Headcount', type: 'number' });
  void t;

  const made = f.tx(() => records.createRecord(f.repo, 'c_subbie', {
    name: 'Hale Electrical', day_rate: 620, vetted: 'on', headcount: '14',
  }));
  assert.equal(made.custom.day_rate, 62000, 'money is held in minor units');
  assert.equal(made.custom.vetted, 1, 'a checkbox is 1 or 0');
  assert.equal(made.custom.headcount, 14, 'a number is a number');

  // And a value that cannot be what it claims to be is refused.
  const e = thrown(() => f.tx(() => records.createRecord(f.repo, 'c_subbie', {
    name: 'Bad', headcount: 'quite a lot',
  })));
  assert.match(JSON.stringify(e.details), /must be a number/);
});

// ---------------------------------------------------------------- search
test('a custom type is searchable through the ordinary search path', () => {
  const f = freshTenant();
  certificates(f);
  f.tx(() => records.createRecord(f.repo, 'c_calibration_cert', { name: 'Gauge 4 annual', serial: 'GA-4471' }));
  f.tx(() => records.createRecord(f.repo, 'c_calibration_cert', { name: 'Gauge 9 annual', serial: 'GA-9002' }));

  const all = platform.runSearch(f.repo, 'c_calibration_cert', {}, { limit: 50 });
  assert.equal(all.total, 2);

  // Filtering on a field the type invented, which lives in the JSON column.
  const one = platform.runSearch(f.repo, 'c_calibration_cert',
    { filters: [{ field: 'serial', op: 'eq', value: 'GA-9002' }] }, { limit: 50 });
  assert.equal(one.total, 1);
  assert.equal(one.rows[0].name, 'Gauge 9 annual');
});

// A register of certificates is looked up by serial number far more often
// than by whatever somebody typed in the name box, and the serial lives in
// the JSON column rather than in one of its own.
test('a type is searchable by the fields it invented, not only by its name', () => {
  const f = freshTenant();
  certificates(f);
  const d = meta.getMeta('c_calibration_cert', f.repo);
  assert.ok(d.searchFields.includes('serial'), 'the text fields it defined are searchable');
  assert.ok(!d.searchFields.includes('passed'), 'a checkbox is not');
  assert.ok(!d.searchFields.includes('expires_on'), 'nor is a date');
});

// ---------------------------------------------------------------- deleting
test('a type with records in it will not be deleted out from under them', () => {
  const f = freshTenant();
  certificates(f);
  f.tx(() => records.createRecord(f.repo, 'c_calibration_cert', { name: 'One', serial: 'S1' }));
  const e = thrown(() => f.tx(() => cr.deleteType(f.repo, 'calibration_cert')));
  assert.match(e.message, /Deactivate the type instead/);
});

test('an empty type can be deleted, and takes its field definitions with it', () => {
  const f = freshTenant();
  const t = certificates(f);
  assert.equal(cr.fieldsOfType(f.repo, 'calibration_cert').length, 3);
  f.tx(() => cr.deleteType(f.repo, t.id));
  assert.equal(cr.getType(f.repo, 'calibration_cert'), null);
  assert.equal(cr.fieldsOfType(f.repo, 'calibration_cert').length, 0);
});

test('a deactivated type keeps its records and stops appearing', () => {
  const f = freshTenant();
  const t = certificates(f);
  f.tx(() => records.createRecord(f.repo, 'c_calibration_cert', { name: 'One', serial: 'S1' }));
  f.tx(() => cr.updateType(f.repo, t.id, { active: false }));
  assert.equal(cr.listTypes(f.repo).length, 0);
  assert.equal(cr.listTypes(f.repo, { includeInactive: true }).length, 1);
  assert.equal(cr.listRecords(f.repo, 'c_calibration_cert').total, 1, 'the data is still there');
});

// ----------------------------------------------------------------- audit
test('changes to a custom record are audited under its own type', () => {
  const f = freshTenant();
  certificates(f);
  const made = f.tx(() => records.createRecord(f.repo, 'c_calibration_cert', { name: 'One', serial: 'S1' }));
  f.tx(() => records.updateRecord(f.repo, 'c_calibration_cert', made.id, { name: 'One (reissued)' }));
  const events = f.repo.query(
    'SELECT * FROM audit_event WHERE tenant_id = :t AND record_type = ? ORDER BY at',
    ['c_calibration_cert']);
  assert.equal(events.length, 2);
  // Both land in the same second, so the order they come back in is not
  // something to assert on.
  assert.deepEqual(events.map((e) => e.action).sort(), ['create', 'update']);
});
