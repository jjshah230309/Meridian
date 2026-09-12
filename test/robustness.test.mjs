// The two database failures that are really the caller's mistake, and the
// request bodies that are not the shape the route expected. Each of these
// used to surface as "Internal server error", which tells a user nothing and
// a developer only that something threw somewhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant } from './helpers.mjs';
import { rowList } from '../src/core/http.mjs';
import * as entities from '../src/modules/entities.mjs';

/** assert.throws does not hand back the error, and the error is the point. */
function thrown(fn) {
  try { fn(); } catch (e) { return e; }
  return assert.fail('expected this to be refused');
}

test('a duplicate on a unique index is reported, not thrown as a server error', () => {
  const f = freshTenant();
  const make = () => f.tx(() => f.repo.insert('location', {
    code: 'MAIN', name: 'Second Main', type: 'warehouse',
    subsidiary_id: f.subsidiaryId, created_at: '2026-01-01T00:00:00.000Z',
  }));
  const err = thrown(make);
  assert.equal(err.status, 422);
  assert.match(err.message, /already in use/);
  assert.match(err.message, /code/);
});

test('leaving a required column empty says which one', () => {
  const f = freshTenant();
  const customer = f.tx(() => entities.createCustomer(f.repo, { name: 'Acme', subsidiary_id: f.subsidiaryId }));
  const err = thrown(() => f.tx(() => f.repo.update('customer', customer.id, { name: null })));
  assert.equal(err.status, 422);
  assert.match(err.message, /name is required/);
});

test('a value the caller never supplied is a bad request, not a bind error', () => {
  const f = freshTenant();
  const err = thrown(() => f.repo.queryOne(
    'SELECT * FROM customer WHERE tenant_id = :t AND entity_no = ? AND name = ?', ['C1', undefined]));
  assert.equal(err.status, 400);
  assert.match(err.message, /required value was not supplied/);
});

test('an optional foreign key read straight into get() is a miss', () => {
  const f = freshTenant();
  assert.equal(f.repo.get('customer', undefined), null);
  assert.equal(f.repo.get('customer', null), null);
  assert.equal(f.repo.get('customer', ''), null);
});

test('a field that should be a list refuses anything else', () => {
  assert.deepEqual(rowList(undefined), []);
  assert.deepEqual(rowList(null), []);
  assert.deepEqual(rowList([{ a: 1 }]), [{ a: 1 }]);
  const err = thrown(() => rowList('oops', 'lines'));
  assert.equal(err.status, 400);
  assert.match(err.message, /"lines" must be a list/);
});

test('a malformed date is refused by name rather than crashing on conversion', async () => {
  const { addDays, endOfMonth, daysBetween } = await import('../src/core/util.mjs');
  for (const fn of [() => addDays('banana', 1), () => endOfMonth('0000-00-00'), () => daysBetween('2026-01-01', 'nope')]) {
    const err = thrown(fn);
    assert.equal(err.status, 400);
    assert.match(err.message, /Invalid date/);
  }
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
});
