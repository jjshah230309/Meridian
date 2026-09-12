// An expense claim's life: written up, submitted, decided, paid. Approval is
// the point the cost becomes the company's, so that is where the ledger moves;
// reimbursement is only cash. Before this existed a claim could be created and
// then never went anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant, DATE } from './helpers.mjs';
import * as projects from '../src/modules/projects.mjs';
import * as hr from '../src/modules/hr.mjs';
import * as gl from '../src/modules/gl.mjs';
import { Money } from '../src/core/util.mjs';

function claim(f, { billable = 0 } = {}) {
  const employee = f.tx(() => hr.createEmployee(f.repo, {
    first_name: 'Rae', last_name: 'Okafor', email: 'rae@test.local',
    hire_date: '2026-01-05', subsidiary_id: f.subsidiaryId,
  }));
  const report = f.tx(() => projects.createExpenseReport(f.repo, {
    employee_id: employee.id, subsidiary_id: f.subsidiaryId, report_date: DATE,
    memo: 'Customer visit',
    lines: [
      { expense_date: DATE, category: 'travel', description: 'Rail fare', amount: 140, tax_amount: 28, billable, account_id: f.posting.travel },
      { expense_date: DATE, category: 'meals', description: 'Dinner', amount: 60, billable, account_id: f.posting.travel },
    ],
  }));
  return { employee, report };
}

const balance = (f, accountId) => f.repo.scalar(
  `SELECT COALESCE(SUM(jl.base_debit - jl.base_credit), 0) v
   FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
   WHERE jl.tenant_id = :t AND je.status = 'posted' AND jl.account_id = ?`, [accountId], 0);

test('a claim totals its lines including tax', () => {
  const f = freshTenant();
  const { report } = claim(f);
  assert.equal(report.total, Money.parse(228));
  assert.equal(report.status, 'draft');
});

test('a draft claim posts nothing until somebody approves it', () => {
  const f = freshTenant();
  const { report } = claim(f);
  f.tx(() => projects.submitExpenseReport(f.repo, report.id));
  assert.equal(projects.getReport(f.repo, report.id).status, 'submitted');
  assert.equal(balance(f, f.posting.travel) || 0, 0, 'submitting is not an accounting event');

  const approved = f.tx(() => projects.decideExpenseReport(f.repo, report.id, { approve: true }));
  assert.equal(approved.status, 'approved');
  assert.ok(approved.journal_entry_id, 'approval writes a journal entry');
  assert.equal(balance(f, f.posting.travel), Money.parse(228), 'the cost is recognised');
  assert.equal(balance(f, f.posting.accrued_liabilities), -Money.parse(228), 'and it is owed to the claimant');
  assert.ok(gl.integrityCheck(f.repo).ok);
});

test('reimbursement moves cash and clears what was owed', () => {
  const f = freshTenant();
  const { report } = claim(f);
  f.tx(() => projects.submitExpenseReport(f.repo, report.id));
  f.tx(() => projects.decideExpenseReport(f.repo, report.id, { approve: true }));
  f.tx(() => projects.reimburseExpenseReport(f.repo, report.id, { paid_date: DATE }));

  assert.equal(projects.getReport(f.repo, report.id).status, 'reimbursed');
  assert.equal(balance(f, f.posting.accrued_liabilities) || 0, 0, 'nothing is still owed');
  assert.equal(balance(f, f.posting.bank), -Money.parse(228), 'the money has left the bank');
  assert.equal(balance(f, f.posting.travel), Money.parse(228), 'the expense is recognised once, not twice');
  assert.ok(gl.integrityCheck(f.repo).ok);
});

test('a rejected claim can be corrected and sent again', () => {
  const f = freshTenant();
  const { report } = claim(f);
  f.tx(() => projects.submitExpenseReport(f.repo, report.id));
  const rejected = f.tx(() => projects.decideExpenseReport(f.repo, report.id, { approve: false, note: 'No receipt for the dinner' }));
  assert.equal(rejected.status, 'rejected');
  assert.match(rejected.memo, /No receipt/);
  assert.equal(balance(f, f.posting.travel) || 0, 0, 'a rejected claim never reaches the ledger');

  f.tx(() => projects.submitExpenseReport(f.repo, report.id));
  assert.equal(projects.getReport(f.repo, report.id).status, 'submitted');
});

test('the steps cannot be taken out of order', () => {
  const f = freshTenant();
  const { report } = claim(f);
  assert.throws(() => f.tx(() => projects.decideExpenseReport(f.repo, report.id, { approve: true })), /only a submitted claim/);
  assert.throws(() => f.tx(() => projects.reimburseExpenseReport(f.repo, report.id)), /only an approved claim/);

  f.tx(() => projects.submitExpenseReport(f.repo, report.id));
  f.tx(() => projects.decideExpenseReport(f.repo, report.id, { approve: true }));
  assert.throws(() => f.tx(() => projects.decideExpenseReport(f.repo, report.id, { approve: true })), /only a submitted claim/);
  f.tx(() => projects.reimburseExpenseReport(f.repo, report.id));
  assert.throws(() => f.tx(() => projects.reimburseExpenseReport(f.repo, report.id)), /only an approved claim/);
});
