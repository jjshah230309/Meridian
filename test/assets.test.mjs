// Selling an asset. The gain or the loss is the whole point of the entry, and
// it was landing in Shipping Income -- the first OTHER_INCOME account in the
// chart -- while the "Gain / loss on disposal" field on the asset class, which
// is on the form and which the demo fills in, was read by nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant } from './helpers.mjs';
import * as assets from '../src/modules/assets.mjs';
import * as gl from '../src/modules/gl.mjs';
import { ulid, nowIso, Money } from '../src/core/util.mjs';

const num = (f, n) => f.repo.queryOne('SELECT id FROM account WHERE tenant_id = :t AND number = ?', [n])?.id;

function laptopFleet(f, { disposal_account_id } = {}) {
  const classId = f.tx(() => f.repo.insert('asset_class', {
    id: ulid(), name: 'Computers', method: 'STRAIGHT_LINE', life_months: 36,
    salvage_pct: 0, declining_rate: 2,
    asset_account_id: num(f, '1500'),
    accum_account_id: num(f, '1590'),
    expense_account_id: num(f, '6800'),
    disposal_account_id: disposal_account_id ?? null,
    created_at: nowIso(),
  }));
  const asset = f.tx(() => assets.createAsset(f.repo, {
    name: 'Laptop fleet', class_id: classId, subsidiary_id: f.subsidiaryId,
    cost: 36000, acquisition_date: '2026-01-15', in_service_date: '2026-01-15',
  }));
  f.tx(() => assets.placeInService(f.repo, asset.id, { in_service_date: '2026-01-15' }));
  f.tx(() => assets.runDepreciation(f.repo, { through: '2026-06-30' }));
  return { classId, asset };
}

const balance = (f, accountId) => f.repo.scalar(
  `SELECT COALESCE(SUM(jl.base_debit - jl.base_credit), 0) v FROM journal_line jl
   JOIN journal_entry je ON je.id = jl.entry_id
   WHERE jl.tenant_id = :t AND je.status = 'posted' AND jl.account_id = ?`, [accountId], 0);

test('a gain on disposal does not land in shipping income', () => {
  const f = freshTenant();
  const { asset } = laptopFleet(f);
  const shipping = num(f, '4950');
  // Six months at 1,000 leaves a book value of 30,000; 33,000 is a 3,000 gain.
  const out = f.tx(() => assets.disposeAsset(f.repo, asset.id, { disposal_date: '2026-07-15', proceeds: 33000 }));
  assert.equal(out.gain, 3000);
  assert.equal(balance(f, shipping), 0);
  assert.equal(balance(f, num(f, '7050')), Money.parse(-out.gain));
  assert.equal(gl.integrityCheck(f.repo).ok, true);
});

test("the asset class's own disposal account is used when it names one", () => {
  const f = freshTenant();
  const interest = num(f, '7010');
  const { asset } = laptopFleet(f, { disposal_account_id: interest });
  const out = f.tx(() => assets.disposeAsset(f.repo, asset.id, { disposal_date: '2026-07-15', proceeds: 1000 }));
  assert.ok(out.gain < 0, 'scrapped well below book value');
  assert.equal(balance(f, interest), Money.parse(-out.gain));
});

test('proceeds land in the bank without the caller naming an account', () => {
  const f = freshTenant();
  const { asset } = laptopFleet(f);
  f.tx(() => assets.disposeAsset(f.repo, asset.id, { disposal_date: '2026-07-15', proceeds: 30000 }));
  assert.equal(balance(f, f.posting.bank), Money.parse(30000));
  assert.equal(gl.integrityCheck(f.repo).ok, true);
});

test('a disposed asset leaves the register and stops depreciating', () => {
  const f = freshTenant();
  const { asset } = laptopFleet(f);
  f.tx(() => assets.disposeAsset(f.repo, asset.id, { disposal_date: '2026-07-15', proceeds: 30000 }));
  assert.equal(assets.register(f.repo).assets.length, 0);
  assert.equal(f.tx(() => assets.runDepreciation(f.repo, { through: '2026-12-31' })).posted, 0);
  assert.throws(() => f.tx(() => assets.disposeAsset(f.repo, asset.id, { disposal_date: '2026-08-01' })), /already disposed/);
});
