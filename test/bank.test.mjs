// Statement import has to be idempotent (uploading the same file twice must
// not duplicate cash) without failing outright the moment two lines in the
// SAME file happen to collide on the same fallback key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant } from './helpers.mjs';
import * as bank from '../src/modules/bank.mjs';

function account(f) {
  return f.repo.queryOne('SELECT * FROM bank_account WHERE tenant_id = :t LIMIT 1');
}

test('two lines with no external_id that collide on the fallback key are deduplicated, not crashed on', () => {
  // importStatement snapshots existing external_ids once before the loop, for
  // one query instead of one per line. Without also tracking ids inserted
  // during this same call, two lines that fall back to the same
  // date/amount/description key both pass the "already there?" check and the
  // second insert collides on bank_txn's unique index, failing the whole
  // upload instead of importing one and skipping the duplicate.
  const f = freshTenant();
  const ba = account(f);
  const line = { date: '2026-03-01', amount: 12.5, description: 'Card purchase' };
  const res = f.tx(() => bank.importStatement(f.repo, ba.id, [line, { ...line }]));
  assert.equal(res.imported, 1);
  assert.equal(res.skipped, 1);
  const rows = f.repo.query('SELECT * FROM bank_txn WHERE tenant_id = :t AND bank_account_id = ?', [ba.id]);
  assert.equal(rows.length, 1);
});

test('re-importing the same statement skips every line the second time', () => {
  const f = freshTenant();
  const ba = account(f);
  const lines = [
    { date: '2026-03-01', amount: 12.5, description: 'Card purchase' },
    { date: '2026-03-02', amount: -40, description: 'ATM withdrawal' },
  ];
  const first = f.tx(() => bank.importStatement(f.repo, ba.id, lines));
  assert.equal(first.imported, 2);
  const second = f.tx(() => bank.importStatement(f.repo, ba.id, lines));
  assert.equal(second.imported, 0);
  assert.equal(second.skipped, 2);
});

test('a statement with more lines than a single IN (...) can safely hold still imports', () => {
  const f = freshTenant();
  const ba = account(f);
  const lines = Array.from({ length: 1200 }, (_, i) => ({
    date: '2026-04-01', amount: 1 + i, description: `Line ${i}`,
  }));
  const res = f.tx(() => bank.importStatement(f.repo, ba.id, lines));
  assert.equal(res.imported, 1200);
  assert.equal(res.skipped, 0);
});
