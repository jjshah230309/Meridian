// Spreading shared cost. The arithmetic is easy; what matters is that the
// same cost is never spread twice, that the split follows a basis somebody
// can point at, and that the entry balances to the penny.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant } from './helpers.mjs';
import * as allocations from '../src/modules/allocations.mjs';
import * as gl from '../src/modules/gl.mjs';
import { Money, sum } from '../src/core/util.mjs';

const acct = (f, n) => f.repo.queryOne('SELECT * FROM account WHERE tenant_id = :t AND number = ?', [n]);
const thrown = (fn) => { try { fn(); } catch (e) { return e; } return null; };
const balance = (f, number, department = null) => f.repo.scalar(
  `SELECT COALESCE(SUM(jl.base_debit - jl.base_credit), 0) v FROM journal_line jl
   JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
   JOIN account a ON a.tenant_id = jl.tenant_id AND a.id = jl.account_id
   WHERE jl.tenant_id = :t AND je.status = 'posted' AND a.number = ?
     ${department ? 'AND jl.department_id = ?' : ''}`,
  department ? [number, department] : [number], 0);

function departments(f, names) {
  return names.map((name) => f.tx(() => f.repo.insert('department', {
    id: `DEPT${name}`, name, parent_id: null, subsidiary_id: null, active: 1,
  })));
}

/** Rent lands on one account with no department against it. */
function bookRent(f, amount, date = '2026-03-31') {
  return f.tx(() => gl.postJournal(f.repo, {
    subsidiary_id: f.subsidiaryId, txn_date: date, memo: 'Quarterly rent',
    lines: [
      { account_id: acct(f, '6100').id, debit: Money.parse(amount) },
      { account_id: acct(f, '1010').id, credit: Money.parse(amount) },
    ],
  }));
}

test('a fixed split moves cost onto the departments in proportion', () => {
  const f = freshTenant();
  const [sales, ops, admin] = departments(f, ['Sales', 'Ops', 'Admin']);
  bookRent(f, 9000);

  const schedule = f.tx(() => allocations.createSchedule(f.repo, {
    name: 'Rent by floor share', subsidiary_id: f.subsidiaryId, method: 'fixed',
    start_date: '2026-03-31',
    sources: [{ account_id: acct(f, '6100').id }],
    targets: [
      { department_id: sales, weight: 3 },
      { department_id: ops, weight: 5 },
      { department_id: admin, weight: 1 },
    ],
  }));

  const view = allocations.preview(f.repo, schedule.id);
  assert.equal(view.pool, Money.parse(9000));
  assert.deepEqual(view.lines.map((l) => l.amount), [Money.parse(3000), Money.parse(5000), Money.parse(1000)]);

  f.tx(() => allocations.run(f.repo, schedule.id));
  assert.equal(balance(f, '6100', sales), Money.parse(3000));
  assert.equal(balance(f, '6100', ops), Money.parse(5000));
  assert.equal(balance(f, '6100', admin), Money.parse(1000));
  assert.equal(balance(f, '6100'), Money.parse(9000), 'the total cost is unchanged — it only moved');
  assert.equal(gl.integrityCheck(f.repo).ok, true);
});

test('an odd amount is split to the penny with nothing left over', () => {
  const f = freshTenant();
  const [a, b, c] = departments(f, ['A', 'B', 'C']);
  bookRent(f, 100);
  const schedule = f.tx(() => allocations.createSchedule(f.repo, {
    name: 'Thirds', subsidiary_id: f.subsidiaryId, start_date: '2026-03-31',
    sources: [{ account_id: acct(f, '6100').id }],
    targets: [{ department_id: a, weight: 1 }, { department_id: b, weight: 1 }, { department_id: c, weight: 1 }],
  }));
  const view = allocations.preview(f.repo, schedule.id);
  assert.equal(sum(view.lines, (l) => l.amount), Money.parse(100));
  f.tx(() => allocations.run(f.repo, schedule.id));
  assert.equal(gl.integrityCheck(f.repo).ok, true);
});

test('a statistical split follows what the statistics say', () => {
  const f = freshTenant();
  const [sales, ops] = departments(f, ['Sales', 'Ops']);
  const headcount = f.tx(() => gl.createAccount(f.repo, {
    number: '9100', name: 'Headcount', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE',
    is_statistical: 1, statistical_unit: 'people',
  }));
  f.tx(() => allocations.postStatistic(f.repo, {
    account_id: headcount.id, subsidiary_id: f.subsidiaryId, txn_date: '2026-03-01',
    entries: [{ department_id: sales, quantity: 12 }, { department_id: ops, quantity: 28 }],
  }));
  bookRent(f, 4000);

  const schedule = f.tx(() => allocations.createSchedule(f.repo, {
    name: 'Rent by headcount', subsidiary_id: f.subsidiaryId, method: 'statistical',
    start_date: '2026-03-31',
    sources: [{ account_id: acct(f, '6100').id }],
    targets: [
      { department_id: sales, statistical_account_id: headcount.id },
      { department_id: ops, statistical_account_id: headcount.id },
    ],
  }));

  const view = allocations.preview(f.repo, schedule.id);
  assert.deepEqual(view.lines.map((l) => l.weight), [12, 28]);
  assert.equal(view.lines[0].amount, Money.parse(1200), '12 of 40');
  assert.equal(view.lines[1].amount, Money.parse(2800), '28 of 40');
  assert.match(view.lines[0].basis_label, /12 people/);
});

test('a later statistical reading replaces the earlier one, not adds to it', () => {
  // postStatistic's own doc comment calls this "this month's headcount" -- a
  // reading, not a delta. weightsFor used to sum every reading ever posted
  // with no lower date bound, so a second month's headcount posting kept
  // adding onto the first month's instead of superseding it.
  const f = freshTenant();
  const [sales, ops] = departments(f, ['Sales', 'Ops']);
  const headcount = f.tx(() => gl.createAccount(f.repo, {
    number: '9100', name: 'Headcount', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE',
    is_statistical: 1, statistical_unit: 'people',
  }));
  f.tx(() => allocations.postStatistic(f.repo, {
    account_id: headcount.id, subsidiary_id: f.subsidiaryId, txn_date: '2026-03-01',
    entries: [{ department_id: sales, quantity: 12 }, { department_id: ops, quantity: 28 }],
  }));
  // Headcount changed for April: now an even split.
  f.tx(() => allocations.postStatistic(f.repo, {
    account_id: headcount.id, subsidiary_id: f.subsidiaryId, txn_date: '2026-04-01',
    entries: [{ department_id: sales, quantity: 20 }, { department_id: ops, quantity: 20 }],
  }));
  bookRent(f, 4000, '2026-04-30');

  const schedule = f.tx(() => allocations.createSchedule(f.repo, {
    name: 'Rent by headcount', subsidiary_id: f.subsidiaryId, method: 'statistical',
    start_date: '2026-03-31',
    sources: [{ account_id: acct(f, '6100').id }],
    targets: [
      { department_id: sales, statistical_account_id: headcount.id },
      { department_id: ops, statistical_account_id: headcount.id },
    ],
  }));

  const april = allocations.preview(f.repo, schedule.id, { txn_date: '2026-04-30' });
  assert.deepEqual(april.lines.map((l) => l.weight), [20, 20],
    'April must read as an even split, not 12+20 / 28+20 carried over from March');
  assert.equal(april.lines[0].amount, Money.parse(2000));
  assert.equal(april.lines[1].amount, Money.parse(2000));
});

test('a statistical account is kept out of the financial statements', async () => {
  const f = freshTenant();
  const [sales] = departments(f, ['Sales']);
  const headcount = f.tx(() => gl.createAccount(f.repo, {
    number: '9100', name: 'Headcount', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE',
    is_statistical: 1, statistical_unit: 'people',
  }));
  f.tx(() => allocations.postStatistic(f.repo, {
    account_id: headcount.id, subsidiary_id: f.subsidiaryId, txn_date: '2026-03-01',
    entries: [{ department_id: sales, quantity: 40 }],
  }));
  const reports = await import('../src/modules/reports.mjs');
  const tb = reports.trialBalance(f.repo, { to: '2026-12-31' });
  assert.ok(!tb.lines.some((l) => l.number === '9100'), 'forty people are not forty dollars');
  assert.equal(tb.balanced, true);
  const is = reports.incomeStatement(f.repo, { from: '2026-01-01', to: '2026-12-31' });
  assert.ok(!JSON.stringify(is).includes('9100'));
});

test('a clearing account leaves the original cost where it was booked', () => {
  const f = freshTenant();
  const [sales, ops] = departments(f, ['Sales', 'Ops']);
  bookRent(f, 1000);
  const schedule = f.tx(() => allocations.createSchedule(f.repo, {
    name: 'Rent, cleared', subsidiary_id: f.subsidiaryId, start_date: '2026-03-31',
    clearing_account_id: acct(f, '7040').id,
    sources: [{ account_id: acct(f, '6100').id }],
    targets: [{ department_id: sales, weight: 1 }, { department_id: ops, weight: 1 }],
  }));
  f.tx(() => allocations.run(f.repo, schedule.id));
  assert.equal(balance(f, '7040'), -Money.parse(1000), 'the credit went to the clearing account');
  assert.equal(balance(f, '6100'), Money.parse(2000), 'and the cost is now on the account twice — once as booked, once as charged');
  assert.equal(balance(f, '6100', sales), Money.parse(500));
});

test('the same cost is never allocated twice', () => {
  const f = freshTenant();
  const [a, b] = departments(f, ['A', 'B']);
  bookRent(f, 1000);
  const schedule = f.tx(() => allocations.createSchedule(f.repo, {
    name: 'Once only', subsidiary_id: f.subsidiaryId, basis: 'cumulative', start_date: '2026-03-31',
    sources: [{ account_id: acct(f, '6100').id }],
    targets: [{ department_id: a, weight: 1 }, { department_id: b, weight: 1 }],
  }));
  f.tx(() => allocations.run(f.repo, schedule.id));

  const after = allocations.preview(f.repo, schedule.id, { txn_date: '2026-04-30' });
  assert.equal(after.pool, 0, 'March has been dealt with');
  assert.match(after.reason, /Nothing has landed/);

  bookRent(f, 500, '2026-04-15');
  const april = allocations.preview(f.repo, schedule.id, { txn_date: '2026-04-30' });
  assert.equal(april.pool, Money.parse(500), 'only the new cost');
});

test('a period cannot be allocated twice by the same schedule', () => {
  const f = freshTenant();
  const [a, b] = departments(f, ['A', 'B']);
  bookRent(f, 1000);
  const schedule = f.tx(() => allocations.createSchedule(f.repo, {
    name: 'Rent', subsidiary_id: f.subsidiaryId, start_date: '2026-03-31',
    sources: [{ account_id: acct(f, '6100').id }],
    targets: [{ department_id: a, weight: 1 }, { department_id: b, weight: 1 }],
  }));
  f.tx(() => allocations.run(f.repo, schedule.id));
  bookRent(f, 400);
  assert.match(thrown(() => f.tx(() => allocations.run(f.repo, schedule.id, { txn_date: '2026-03-31' }))).message,
    /already allocated/);
});

test('the calendar advances by the frequency', () => {
  const f = freshTenant();
  const [a, b] = departments(f, ['A', 'B']);
  bookRent(f, 1200);
  const schedule = f.tx(() => allocations.createSchedule(f.repo, {
    name: 'Quarterly', subsidiary_id: f.subsidiaryId, frequency: 'quarterly', start_date: '2026-03-31',
    sources: [{ account_id: acct(f, '6100').id }],
    targets: [{ department_id: a, weight: 1 }, { department_id: b, weight: 1 }],
  }));
  assert.equal(schedule.next_date, '2026-03-31');
  f.tx(() => allocations.run(f.repo, schedule.id));
  assert.equal(allocations.getSchedule(f.repo, schedule.id).next_date, '2026-06-30');
});

test('a split with one destination is refused', () => {
  const f = freshTenant();
  const [a] = departments(f, ['A']);
  assert.match(thrown(() => f.tx(() => allocations.createSchedule(f.repo, {
    name: 'Not a split', subsidiary_id: f.subsidiaryId, start_date: '2026-03-31',
    sources: [{ account_id: acct(f, '6100').id }],
    targets: [{ department_id: a, weight: 1 }],
  }))).fields.targets, /at least two destinations/);
});

test('a statistical account cannot be a source, and a real one cannot be a basis', () => {
  const f = freshTenant();
  const [a, b] = departments(f, ['A', 'B']);
  const headcount = f.tx(() => gl.createAccount(f.repo, {
    number: '9100', name: 'Headcount', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE', is_statistical: 1,
  }));
  assert.match(thrown(() => f.tx(() => allocations.createSchedule(f.repo, {
    name: 'Wrong way round', subsidiary_id: f.subsidiaryId, start_date: '2026-03-31',
    sources: [{ account_id: headcount.id }],
    targets: [{ department_id: a, weight: 1 }, { department_id: b, weight: 1 }],
  }))).fields['sources.0.account_id'], /statistical/);

  assert.match(thrown(() => f.tx(() => allocations.createSchedule(f.repo, {
    name: 'Also wrong', subsidiary_id: f.subsidiaryId, method: 'statistical', start_date: '2026-03-31',
    sources: [{ account_id: acct(f, '6100').id }],
    targets: [
      { department_id: a, statistical_account_id: acct(f, '6110').id },
      { department_id: b, statistical_account_id: acct(f, '6110').id },
    ],
  }))).fields['targets.0.statistical_account_id'], /not a statistical account/);
});

test('a schedule that has run is not deletable', () => {
  const f = freshTenant();
  const [a, b] = departments(f, ['A', 'B']);
  bookRent(f, 1000);
  const schedule = f.tx(() => allocations.createSchedule(f.repo, {
    name: 'Rent', subsidiary_id: f.subsidiaryId, start_date: '2026-03-31',
    sources: [{ account_id: acct(f, '6100').id }],
    targets: [{ department_id: a, weight: 1 }, { department_id: b, weight: 1 }],
  }));
  f.tx(() => allocations.run(f.repo, schedule.id));
  assert.match(thrown(() => f.tx(() => allocations.deleteSchedule(f.repo, schedule.id))).message, /End it instead/);
});

test('the run keeps the basis it used', () => {
  const f = freshTenant();
  const [a, b] = departments(f, ['A', 'B']);
  bookRent(f, 1000);
  const schedule = f.tx(() => allocations.createSchedule(f.repo, {
    name: 'Rent', subsidiary_id: f.subsidiaryId, start_date: '2026-03-31',
    sources: [{ account_id: acct(f, '6100').id }],
    targets: [{ department_id: a, weight: 3 }, { department_id: b, weight: 1 }],
  }));
  const res = f.tx(() => allocations.run(f.repo, schedule.id));
  const stored = allocations.getRun(f.repo, res.run.id);
  assert.equal(stored.weights.length, 2);
  assert.equal(stored.weights[0].share, 75);
  assert.equal(stored.amount, Money.parse(1000));
  assert.ok(stored.entry.entry_no);
});
