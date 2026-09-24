// Direct unit tests for src/core/auth.mjs's login flow. A login response
// that answers in a measurably different time, or with a different reason,
// for "no such account" versus "this account exists but is disabled/locked"
// hands an unauthenticated caller a way to enumerate real accounts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as auth from '../src/core/auth.mjs';
import { freshTenant } from './helpers.mjs';

/** Count crypto.scryptSync calls made while `fn` runs, without touching real timing. */
function countScryptCalls(fn) {
  let calls = 0;
  const real = crypto.scryptSync;
  crypto.scryptSync = (...args) => { calls++; return real(...args); };
  try { return { result: fn(), calls: () => calls }; }
  finally { crypto.scryptSync = real; }
}

test('a disabled account pays for a password hash instead of returning on a fast path', () => {
  const f = freshTenant();
  const { hash, salt } = auth.hashPassword('Correct-Horse-9');
  f.tx(() => f.repo.insert('app_user', {
    id: 'disabled-user', email: 'disabled@test.local', name: 'Disabled User',
    password_hash: hash, password_salt: salt, status: 'disabled', is_owner: 0,
    locale: 'en-US', timezone: 'UTC', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }));

  const { result, calls } = countScryptCalls(() =>
    auth.authenticate(f.db, { tenantId: f.tenant.id, email: 'disabled@test.local', password: 'whatever123' }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'account_disabled');
  assert.equal(calls(), 1, 'a disabled account must pay for one password hash, exactly like a wrong password does');
});

test('a locked account pays for a password hash instead of returning on a fast path', () => {
  const f = freshTenant();
  const { hash, salt } = auth.hashPassword('Correct-Horse-9');
  f.tx(() => f.repo.insert('app_user', {
    id: 'locked-user', email: 'locked@test.local', name: 'Locked User',
    password_hash: hash, password_salt: salt, status: 'active', is_owner: 0,
    locked_until: new Date(Date.now() + 60_000).toISOString(),
    locale: 'en-US', timezone: 'UTC', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }));

  const { result, calls } = countScryptCalls(() =>
    auth.authenticate(f.db, { tenantId: f.tenant.id, email: 'locked@test.local', password: 'whatever123' }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'account_locked');
  assert.equal(calls(), 1, 'a locked account must pay for one password hash, exactly like a wrong password does');
});

test('an unknown email and a wrong password both pay for exactly one hash of the same cost', () => {
  const f = freshTenant();

  const unknown = countScryptCalls(() =>
    auth.authenticate(f.db, { tenantId: f.tenant.id, email: 'nobody@test.local', password: 'whatever123' }));
  assert.equal(unknown.result.reason, 'invalid_credentials');
  assert.equal(unknown.calls(), 1);

  const wrong = countScryptCalls(() =>
    auth.authenticate(f.db, { tenantId: f.tenant.id, email: 'owner@test.local', password: 'wrong-password-x' }));
  assert.equal(wrong.result.reason, 'invalid_credentials');
  assert.equal(wrong.calls(), 1);
});

test('a correct password on an active, unlocked account still succeeds', () => {
  const f = freshTenant();
  const result = auth.authenticate(f.db, { tenantId: f.tenant.id, email: 'owner@test.local', password: 'Correct-Horse-9' });
  assert.equal(result.ok, true);
  assert.ok(result.session);
});
