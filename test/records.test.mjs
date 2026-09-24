// The generic record path used by every record type that has no bespoke
// handler (department, location, subsidiary, price_level, budget, and about
// fifty others) -- this is what the REST API's POST/PATCH /api/v1/records/:type
// falls through to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant } from './helpers.mjs';
import * as records from '../src/modules/records.mjs';
import * as meta from '../src/modules/meta.mjs';

test('generic create/update actually work end to end', () => {
  const f = freshTenant();
  const dept = f.tx(() => records.createRecord(f.repo, 'department', { name: 'Engineering' }));
  assert.equal(dept.name, 'Engineering');
  const updated = f.tx(() => records.updateRecord(f.repo, 'department', dept.id, { name: 'Engineering Team' }));
  assert.equal(updated.name, 'Engineering Team');
});

test('every record type with no bespoke handler goes through the generic path without crashing', () => {
  // `export { coerce } from './meta.mjs'` does not bind a local `coerce` --
  // it only forwards the name to importers of records.mjs -- so
  // genericCreate/genericUpdate's own bare `coerce(...)` calls threw
  // ReferenceError for every one of these types, with nothing (no test)
  // to catch it since every other test creates records through a type that
  // happens to have a bespoke handler.
  const f = freshTenant();
  const crashes = [];
  for (const type of meta.listRecordTypes()) {
    if (records.HANDLERS[type]) continue;
    const m = meta.getMeta(type);
    if (!m || m.isTransaction) continue;
    try {
      f.tx(() => records.createRecord(f.repo, type, {}));
    } catch (e) {
      // A ValidationError for a missing required field is the generic path
      // doing its job; a bare ReferenceError/TypeError is the bug.
      if (e instanceof ReferenceError || e instanceof TypeError) crashes.push(`${type}: ${e.constructor.name}: ${e.message}`);
    }
  }
  assert.deepEqual(crashes, []);
});
