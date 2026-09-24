// Payroll calculation: who gets paid, and for how much.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant } from './helpers.mjs';
import * as hr from '../src/modules/hr.mjs';
import { Money } from '../src/core/util.mjs';

test('an employee hired after the pay period is not paid for it', () => {
  const f = freshTenant();
  f.tx(() => hr.createEmployee(f.repo, {
    first_name: 'Future', last_name: 'Hire', subsidiary_id: f.subsidiaryId,
    hire_date: '2026-08-01', pay_type: 'salary', pay_rate: 120000, pay_frequency: 'monthly',
  }));
  assert.throws(
    () => f.tx(() => hr.calculatePayroll(f.repo, {
      subsidiary_id: f.subsidiaryId, period_start: '2026-06-01', period_end: '2026-06-30', pay_date: '2026-07-01',
    })),
    /No payable employees/,
    'a run for a period entirely before hire_date must find nobody to pay',
  );
});

test('an hourly employee is paid, and the run remembers how many hours', () => {
  const f = freshTenant();
  const emp = f.tx(() => hr.createEmployee(f.repo, {
    first_name: 'Jo', last_name: 'Hourly', subsidiary_id: f.subsidiaryId,
    hire_date: '2026-01-01', pay_type: 'hourly', pay_rate: 25,
  }));
  f.tx(() => hr.logTime(f.repo, {
    employee_id: emp.id, entry_date: '2026-06-10', hours: 16, status: 'approved',
  }));

  const run = f.tx(() => hr.calculatePayroll(f.repo, {
    subsidiary_id: f.subsidiaryId, period_start: '2026-06-01', period_end: '2026-06-30', pay_date: '2026-07-01',
  }));
  const line = run.lines.find((l) => l.employee_id === emp.id);
  assert.equal(Money.toNumber(line.gross), 400, '16 hours at $25/hr');
  assert.equal(line.hours, 16, 'the hours actually paid for must be on the line, not hardcoded to 0');
});
