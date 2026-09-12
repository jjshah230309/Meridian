// When an asset stops being worth what the books say.
//
// The arithmetic is easy. What these tests are really about is the one rule
// people get wrong: an upward revaluation is equity, not profit, except where
// it reverses a loss the same asset was charged with earlier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant } from './helpers.mjs';
import * as av from '../src/modules/assetvalue.mjs';
import * as assets from '../src/modules/assets.mjs';
import * as gl from '../src/modules/gl.mjs';
import { Money, ulid, nowIso } from '../src/core/util.mjs';

const acct = (f, n) => f.repo.queryOne('SELECT * FROM account WHERE tenant_id = :t AND number = ?', [n]);
const thrown = (fn) => { try { fn(); } catch (e) { return e; } return null; };

const balance = (f, number) => f.repo.scalar(
  `SELECT COALESCE(SUM(jl.base_debit - jl.base_credit), 0) v FROM journal_line jl
   JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
   JOIN account a ON a.tenant_id = jl.tenant_id AND a.id = jl.account_id
   WHERE jl.tenant_id = :t AND je.status = 'posted' AND a.number = ?`, [number], 0);

/** A machine costing 60,000 over 60 months, with a year already charged. */
function machine(f, { cost = 60000, life = 60, depreciateMonths = 12 } = {}) {
  const cls = f.tx(() => f.repo.insert('asset_class', {
    id: ulid(), name: 'Plant', method: 'STRAIGHT_LINE', life_months: life,
    asset_account_id: acct(f, '1500').id, accum_account_id: acct(f, '1590').id,
    expense_account_id: acct(f, '6800').id, active: 1, created_at: nowIso(),
  }));
  const asset = f.tx(() => assets.createAsset(f.repo, {
    name: 'Line 4 press', class_id: cls, subsidiary_id: f.subsidiaryId,
    acquisition_date: '2026-01-01', in_service_date: '2026-01-01',
    cost, life_months: life, method: 'STRAIGHT_LINE',
    asset_account_id: acct(f, '1500').id, accum_account_id: acct(f, '1590').id,
    expense_account_id: acct(f, '6800').id,
  }));
  f.tx(() => assets.placeInService(f.repo, asset.id, { in_service_date: '2026-01-01' }));
  if (depreciateMonths) {
    f.tx(() => assets.runDepreciation(f.repo, { through: `2026-${String(depreciateMonths).padStart(2, '0')}-31` }));
  }
  return assets.getAsset(f.repo, asset.id);
}

// ------------------------------------------------------------- the rule
test('the split between equity and profit is the whole of the judgement', () => {
  // Writing up, nothing charged before: all equity, because nothing has been
  // earned until it is sold.
  assert.deepEqual(av.splitAdjustment({ adjustment: 1000, reserve: 0, impaired: 0 }),
    { to_reserve: 1000, to_income: 0 });

  // Writing up an asset that was impaired: income first, up to what was
  // charged, and the rest to reserve.
  assert.deepEqual(av.splitAdjustment({ adjustment: 1000, reserve: 0, impaired: 400 }),
    { to_reserve: 600, to_income: 400 });
  assert.deepEqual(av.splitAdjustment({ adjustment: 300, reserve: 0, impaired: 400 }),
    { to_reserve: 0, to_income: 300 }, 'never reverses more than was charged');

  // Writing down: the reserve goes first, then it becomes a loss.
  assert.deepEqual(av.splitAdjustment({ adjustment: -1000, reserve: 600 }),
    { to_reserve: -600, to_income: -400 });
  assert.deepEqual(av.splitAdjustment({ adjustment: -1000, reserve: 0 }),
    { to_reserve: 0, to_income: -1000 });
  assert.deepEqual(av.splitAdjustment({ adjustment: -400, reserve: 600 }),
    { to_reserve: -400, to_income: 0 }, 'a reserve big enough absorbs it all');

  // Nothing is nothing.
  assert.deepEqual(av.splitAdjustment({ adjustment: 0, reserve: 500 }), { to_reserve: 0, to_income: 0 });
});

test('an impairment cannot write an asset up', () => {
  const e = thrown(() => av.splitAdjustment({ adjustment: 500, kind: 'impairment' }));
  assert.match(e.message, /writes an asset down/);
});

// ------------------------------------------------------------ carrying
test('what it is worth comes from depreciation posted, not from the plan', () => {
  const f = freshTenant();
  const a = machine(f);
  const state = av.carryingAmount(f.repo, a.id);
  assert.equal(state.cost, Money.parse(60000));
  assert.equal(state.depreciated, Money.parse(12000), 'twelve months of a five-year life');
  assert.equal(state.carrying, Money.parse(48000));
});

// ---------------------------------------------------------- impairment
test('an impairment is a loss, and it lands in the income statement', () => {
  const f = freshTenant();
  const a = machine(f);

  const r = f.tx(() => av.revalue(f.repo, a.id, {
    kind: 'impairment', new_value: 30000, effective_date: '2026-12-31',
    reason: 'Product discontinued; the line will never earn it back.',
  }));

  assert.equal(r.kind, 'impairment');
  assert.equal(r.carrying_before, Money.parse(48000));
  assert.equal(r.carrying_after, Money.parse(30000));
  assert.equal(r.adjustment, -Money.parse(18000));
  assert.equal(r.to_income, -Money.parse(18000));
  assert.equal(r.to_reserve, 0);

  assert.equal(balance(f, '7060'), Money.parse(18000), 'charged to the loss account');
  assert.equal(balance(f, '3850'), 0, 'and nothing to equity');
  const entry = gl.getJournalEntry(f.repo, r.journal_entry_id);
  assert.equal(entry.total_debit, entry.total_credit);
});

test('what is left to depreciate is spread over the life that remains', () => {
  const f = freshTenant();
  const a = machine(f);
  f.tx(() => av.revalue(f.repo, a.id, { kind: 'impairment', new_value: 24000, effective_date: '2026-12-31' }));

  const unposted = assets.scheduleFor(f.repo, a.id).filter((l) => !l.posted);
  assert.equal(unposted.length, 48, 'four years left of a five-year life');
  assert.equal(unposted[0].amount, Money.parse(500), '24,000 over 48 months');
  // And the total still comes out exactly right, with the rounding absorbed.
  const total = unposted.reduce((s, l) => s + l.amount, 0);
  assert.equal(total, Money.parse(24000));
});

test('depreciation already charged is never touched', () => {
  const f = freshTenant();
  const a = machine(f);
  const postedBefore = assets.scheduleFor(f.repo, a.id).filter((l) => l.posted);
  f.tx(() => av.revalue(f.repo, a.id, { kind: 'impairment', new_value: 24000, effective_date: '2026-12-31' }));
  const postedAfter = assets.scheduleFor(f.repo, a.id).filter((l) => l.posted);

  assert.equal(postedAfter.length, postedBefore.length);
  assert.deepEqual(postedAfter.map((l) => l.amount), postedBefore.map((l) => l.amount),
    'it was right when it was charged');
});

// --------------------------------------------------------- revaluation
test('writing an asset up goes to equity, because nothing has been sold', () => {
  const f = freshTenant();
  const a = machine(f);

  const r = f.tx(() => av.revalue(f.repo, a.id, {
    new_value: 55000, effective_date: '2026-12-31', reason: 'Market for these has risen.',
  }));

  assert.equal(r.adjustment, Money.parse(7000));
  assert.equal(r.to_reserve, Money.parse(7000));
  assert.equal(r.to_income, 0);
  assert.equal(balance(f, '3850'), -Money.parse(7000), 'a credit balance in equity');
  assert.equal(balance(f, '7060'), 0, 'and nothing through profit');
});

test('writing back up after an impairment reverses through profit first', () => {
  const f = freshTenant();
  const a = machine(f);

  // Down 18,000 — all of it a loss.
  f.tx(() => av.revalue(f.repo, a.id, { kind: 'impairment', new_value: 30000, effective_date: '2026-12-31' }));
  assert.equal(balance(f, '7060'), Money.parse(18000));

  // Then back up 25,000. The first 18,000 undoes the loss; the rest is a gain
  // nobody has realised, so it goes to the reserve.
  const up = f.tx(() => av.revalue(f.repo, a.id, { new_value: 55000, effective_date: '2027-01-31' }));
  assert.equal(up.adjustment, Money.parse(25000));
  assert.equal(up.to_income, Money.parse(18000));
  assert.equal(up.to_reserve, Money.parse(7000));

  assert.equal(balance(f, '7060'), 0, 'the loss is fully reversed and no more');
  assert.equal(balance(f, '3850'), -Money.parse(7000));
});

test('writing down an asset that was written up eats the reserve first', () => {
  const f = freshTenant();
  const a = machine(f);

  f.tx(() => av.revalue(f.repo, a.id, { new_value: 55000, effective_date: '2026-12-31' }));
  assert.equal(balance(f, '3850'), -Money.parse(7000));

  // Down 15,000: the 7,000 reserve goes, and the remaining 8,000 is a loss.
  const down = f.tx(() => av.revalue(f.repo, a.id, { new_value: 40000, effective_date: '2027-01-31' }));
  assert.equal(down.to_reserve, -Money.parse(7000));
  assert.equal(down.to_income, -Money.parse(8000));
  assert.equal(balance(f, '3850'), 0, 'the reserve is gone');
  assert.equal(balance(f, '7060'), Money.parse(8000));
});

// -------------------------------------------------------------- guards
test('an asset cannot be carried at less than nothing', () => {
  const f = freshTenant();
  const a = machine(f);
  const e = thrown(() => f.tx(() => av.revalue(f.repo, a.id, { new_value: -100, effective_date: '2026-12-31' })));
  assert.match(e.message, /less than nothing/);
});

test('revaluing to what it already is says so rather than posting nothing', () => {
  const f = freshTenant();
  const a = machine(f);
  const e = thrown(() => f.tx(() => av.revalue(f.repo, a.id, { new_value: 48000, effective_date: '2026-12-31' })));
  assert.match(e.message, /nothing to change/);
});

test('a draft asset is not revalued, it is corrected', () => {
  const f = freshTenant();
  const cls = f.tx(() => f.repo.insert('asset_class', {
    id: ulid(), name: 'Plant', method: 'STRAIGHT_LINE', life_months: 60,
    asset_account_id: acct(f, '1500').id, accum_account_id: acct(f, '1590').id,
    expense_account_id: acct(f, '6800').id, active: 1, created_at: nowIso(),
  }));
  const draft = f.tx(() => assets.createAsset(f.repo, {
    name: 'Not yet', class_id: cls, subsidiary_id: f.subsidiaryId,
    acquisition_date: '2026-01-01', cost: 1000, life_months: 60,
    asset_account_id: acct(f, '1500').id, accum_account_id: acct(f, '1590').id,
    expense_account_id: acct(f, '6800').id,
  }));
  const e = thrown(() => f.tx(() => av.revalue(f.repo, draft.id, { new_value: 900, effective_date: '2026-06-30' })));
  assert.match(e.message, /not in service yet/);
});

// An empty box in a form arrives as null, not as the default the function
// signature declares, and these columns are NOT NULL. This was a real 422.
test('an empty reason is an empty reason, not a constraint error', () => {
  const f = freshTenant();
  const a = machine(f);
  const r = f.tx(() => av.revalue(f.repo, a.id, {
    kind: 'impairment', new_value: 30000, effective_date: '2026-12-31',
    reason: null, memo: null,
  }));
  assert.equal(r.reason, '');
  assert.equal(r.memo, '');
});

// ------------------------------------------------------------ reversal
test('reversing puts the asset and the ledger back', () => {
  const f = freshTenant();
  const a = machine(f);
  const r = f.tx(() => av.revalue(f.repo, a.id, { kind: 'impairment', new_value: 30000, effective_date: '2026-12-31' }));
  assert.equal(av.carryingAmount(f.repo, a.id).carrying, Money.parse(30000));

  f.tx(() => av.reverseRevaluation(f.repo, r.id, { reason: 'Valuation was wrong' }));
  assert.equal(f.repo.get('asset_revaluation', r.id).status, 'reversed');
  assert.equal(av.carryingAmount(f.repo, a.id).carrying, Money.parse(48000), 'back where it was');
  assert.equal(balance(f, '7060'), 0, 'and the loss is cancelled');
});

test('a superseded revaluation cannot be reversed on its own', () => {
  const f = freshTenant();
  const a = machine(f);
  const first = f.tx(() => av.revalue(f.repo, a.id, { kind: 'impairment', new_value: 30000, effective_date: '2026-12-31' }));
  f.tx(() => av.revalue(f.repo, a.id, { new_value: 35000, effective_date: '2027-01-31' }));

  const e = thrown(() => f.tx(() => av.reverseRevaluation(f.repo, first.id)));
  assert.match(e.message, /superseded/);
});

// ------------------------------------------------------------ transfer
test('moving an asset between departments only changes whose charge it is', () => {
  const f = freshTenant();
  const a = machine(f);
  const dept = f.tx(() => f.repo.insert('department', {
    id: ulid(), name: 'Finishing', active: 1,
  }));
  const before = f.repo.scalar('SELECT COUNT(*) c FROM journal_entry WHERE tenant_id = :t', [], 0);

  const out = f.tx(() => av.transfer(f.repo, a.id, {
    transfer_date: '2027-01-01', to_department_id: dept, reason: 'Line reorganised',
  }));
  assert.equal(out.asset.department_id, dept);
  assert.equal(f.repo.scalar('SELECT COUNT(*) c FROM journal_entry WHERE tenant_id = :t', [], 0), before,
    'nothing is posted: the asset is worth exactly what it was');
});

test('moving it between companies moves the value too', () => {
  const f = freshTenant();
  const a = machine(f);
  const uk = f.tx(() => f.repo.insert('subsidiary', {
    id: ulid(), name: 'Test Co Two', legal_name: '', parent_id: f.subsidiaryId,
    currency: 'USD', country: 'US', tax_number: '', address: {},
    is_elimination: 0, active: 1, created_at: nowIso(),
  }));

  f.tx(() => av.transfer(f.repo, a.id, { transfer_date: '2027-01-01', to_subsidiary_id: uk }));
  const moved = assets.getAsset(f.repo, a.id);
  assert.equal(moved.subsidiary_id, uk);

  // One company is owed what the other now holds.
  const dueFrom = f.repo.scalar(
    `SELECT COALESCE(SUM(jl.base_debit - jl.base_credit), 0) v FROM journal_line jl
     JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
     JOIN account ac ON ac.tenant_id = jl.tenant_id AND ac.id = jl.account_id
     WHERE jl.tenant_id = :t AND je.subsidiary_id = ? AND ac.number = '1190'`, [f.subsidiaryId], 0);
  assert.equal(dueFrom, Money.parse(48000), 'the old company is owed the carrying amount');
  // And the asset arrives at its real age, not as if it were new.
  const cost = f.repo.scalar(
    `SELECT COALESCE(SUM(jl.base_debit - jl.base_credit), 0) v FROM journal_line jl
     JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
     JOIN account ac ON ac.tenant_id = jl.tenant_id AND ac.id = jl.account_id
     WHERE jl.tenant_id = :t AND je.subsidiary_id = ? AND ac.number = '1590'`, [uk], 0);
  assert.equal(cost, -Money.parse(12000), 'carrying its accumulated depreciation with it');
});

test('the ledger still balances after all of it', () => {
  const f = freshTenant();
  const a = machine(f);
  f.tx(() => av.revalue(f.repo, a.id, { kind: 'impairment', new_value: 30000, effective_date: '2026-12-31' }));
  f.tx(() => av.revalue(f.repo, a.id, { new_value: 55000, effective_date: '2027-01-31' }));
  const check = gl.integrityCheck(f.repo);
  assert.ok(check.ok, JSON.stringify(check.unbalanced_entries));
  assert.ok(check.ledger_balanced);
});
