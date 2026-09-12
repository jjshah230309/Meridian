// Meridian ERP :: modules/projects
// Projects, tasks, resourcing, expense reports and project billing.
//
// Profitability is computed from posted facts only -- approved time at its
// cost rate, approved expenses, and invoices actually raised against the
// project. Nothing here estimates: an unapproved timesheet is not cost yet,
// and unbilled work is shown as backlog rather than revenue, because a
// project that looks profitable on unbilled work has told you nothing.
import { ulid, Money, Qty, nowIso, today, isValidDate, sum } from '../core/util.mjs';
import { ValidationError, notFound, unprocessable } from '../core/http.mjs';
import { nextNumber } from '../core/seq.mjs';
import * as txnMod from './txn.mjs';
import * as gl from './gl.mjs';
import { postingAccounts } from './setup.mjs';
import * as audit from '../core/audit.mjs';

export const STATUSES = ['planned', 'active', 'on_hold', 'completed', 'cancelled'];
export const BILLING_TYPES = ['time_and_materials', 'fixed_price', 'milestone', 'non_billable'];

export const getProject = (repo, id) => {
  const p = repo.get('project', id);
  if (!p) throw notFound(`Project ${id} not found`);
  return p;
};

export function createProject(repo, input) {
  const errors = {};
  if (!input.name) errors.name = 'Name is required';
  if (!input.subsidiary_id) errors.subsidiary_id = 'Subsidiary is required';
  if (input.billing_type && !BILLING_TYPES.includes(input.billing_type)) {
    errors.billing_type = `Billing type must be one of ${BILLING_TYPES.join(', ')}`;
  }
  if (input.billing_type === 'fixed_price' && !Money.parse(input.fixed_fee)) {
    errors.fixed_fee = 'A fixed-price project needs a fee';
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);

  const now = nowIso();
  const id = ulid();
  repo.insert('project', {
    id,
    project_no: input.project_no || nextNumber(repo, 'project'),
    name: input.name,
    description: input.description || '',
    customer_id: input.customer_id || null,
    subsidiary_id: input.subsidiary_id,
    manager_id: input.manager_id || null,
    department_id: input.department_id || null,
    status: input.status || 'planned',
    billing_type: input.billing_type || 'time_and_materials',
    currency: input.currency || 'USD',
    start_date: input.start_date || null,
    end_date: input.end_date || null,
    estimated_hours: Qty.parse(input.estimated_hours || 0),
    budget_amount: Money.parse(input.budget_amount),
    fixed_fee: Money.parse(input.fixed_fee),
    percent_complete: 0,
    income_account_id: input.income_account_id || null,
    wip_account_id: input.wip_account_id || null,
    custom: input.custom || {},
    created_at: now, updated_at: now,
  });
  audit.record(repo, { recordType: 'project', recordId: id, action: 'create' });
  return getProject(repo, id);
}

// ------------------------------------------------------------------ tasks
export const tasksFor = (repo, projectId) =>
  repo.query('SELECT * FROM project_task WHERE tenant_id = :t AND project_id = ? ORDER BY sequence, created_at', [projectId]);

export function addTask(repo, projectId, input) {
  getProject(repo, projectId);
  if (!input.name) throw new ValidationError({ name: 'Task name is required' });
  const max = repo.queryOne('SELECT COALESCE(MAX(sequence), 0) AS m FROM project_task WHERE tenant_id = :t AND project_id = ?', [projectId]);
  const id = ulid();
  repo.insert('project_task', {
    id, project_id: projectId,
    parent_id: input.parent_id || null,
    sequence: input.sequence ?? (max.m + 10),
    name: input.name,
    description: input.description || '',
    assignee_id: input.assignee_id || null,
    status: input.status || 'not_started',
    start_date: input.start_date || null,
    end_date: input.end_date || null,
    estimated_hours: Qty.parse(input.estimated_hours || 0),
    actual_hours: 0,
    percent_complete: 0,
    is_milestone: input.is_milestone ? 1 : 0,
    milestone_amount: Money.parse(input.milestone_amount),
    milestone_billed: 0,
    predecessor_id: input.predecessor_id || null,
    created_at: nowIso(),
  });
  return repo.get('project_task', id);
}

/**
 * Roll actual hours and completion up from time entries.
 * Percent complete is hours-based unless every task carries an estimate,
 * in which case it is weighted by estimate -- the honest reading when a
 * one-hour task and a hundred-hour task are both "done".
 */
export function recalcProgress(repo, projectId) {
  const tasks = tasksFor(repo, projectId);
  for (const t of tasks) {
    const actual = repo.queryOne(
      'SELECT COALESCE(SUM(hours), 0) AS h FROM time_entry WHERE tenant_id = :t AND task_id = ? AND status IN (\'approved\',\'submitted\')',
      [t.id]);
    const hours = Qty.parse(actual.h || 0);
    const pct = t.status === 'complete' ? 100
      : t.estimated_hours ? Math.min(99, Math.round((hours / t.estimated_hours) * 100)) : t.percent_complete;
    repo.update('project_task', t.id, { actual_hours: hours, percent_complete: pct });
  }
  const fresh = tasksFor(repo, projectId);
  const weighted = fresh.every((t) => t.estimated_hours > 0);
  const overall = !fresh.length ? 0
    : weighted
      ? Math.round(sum(fresh, (t) => t.percent_complete * t.estimated_hours) / sum(fresh, (t) => t.estimated_hours))
      : Math.round(sum(fresh, (t) => t.percent_complete) / fresh.length);
  repo.update('project', projectId, { percent_complete: overall, updated_at: nowIso() });
  return { project_id: projectId, percent_complete: overall, tasks: fresh.length, basis: weighted ? 'estimate-weighted' : 'simple average' };
}

// ------------------------------------------------------------- resourcing
export function allocate(repo, input) {
  const errors = {};
  if (!input.project_id) errors.project_id = 'Project is required';
  if (!input.employee_id) errors.employee_id = 'Employee is required';
  if (!isValidDate(input.start_date)) errors.start_date = 'A valid start date is required';
  if (!isValidDate(input.end_date)) errors.end_date = 'A valid end date is required';
  if (input.start_date && input.end_date && input.end_date < input.start_date) {
    errors.end_date = 'The end date cannot be before the start date';
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  getProject(repo, input.project_id);

  const id = ulid();
  repo.insert('resource_allocation', {
    id, project_id: input.project_id, task_id: input.task_id || null,
    employee_id: input.employee_id,
    start_date: input.start_date, end_date: input.end_date,
    hours_per_week: Qty.parse(input.hours_per_week || 0),
    bill_rate: Money.parse(input.bill_rate), cost_rate: Money.parse(input.cost_rate),
    notes: input.notes || '', created_at: nowIso(),
  });
  return repo.get('resource_allocation', id);
}

/**
 * Utilisation per employee over a window: booked hours against capacity.
 * Over 100% means someone is double-booked, which is the number this whole
 * table exists to surface.
 */
export function utilisation(repo, { from = today(), to = today(), capacity_hours_per_week = 40 } = {}) {
  const rows = repo.query(
    `SELECT ra.employee_id, (e.first_name || ' ' || e.last_name) AS name, SUM(ra.hours_per_week) AS booked, COUNT(*) AS allocations
     FROM resource_allocation ra JOIN employee e ON e.tenant_id = ra.tenant_id AND e.id = ra.employee_id
     WHERE ra.tenant_id = :t AND ra.start_date <= ? AND ra.end_date >= ?
     GROUP BY ra.employee_id ORDER BY booked DESC`, [to, from]);
  const capacity = Qty.parse(capacity_hours_per_week);
  return rows.map((r) => ({
    employee_id: r.employee_id, name: r.name, allocations: r.allocations,
    booked_hours_per_week: Qty.toNumber(r.booked || 0),
    capacity_hours_per_week,
    utilisation_pct: capacity ? Math.round(((r.booked || 0) / capacity) * 1000) / 10 : 0,
    over_allocated: (r.booked || 0) > capacity,
  }));
}

// -------------------------------------------------------- expense reports
export const getReport = (repo, id) => {
  const r = repo.get('expense_report', id);
  if (!r) throw notFound(`Expense report ${id} not found`);
  return r;
};
export const expenseLines = (repo, reportId) =>
  repo.query('SELECT * FROM expense_line WHERE tenant_id = :t AND report_id = ? ORDER BY line_no', [reportId]);

export function createExpenseReport(repo, input) {
  const errors = {};
  if (!input.employee_id) errors.employee_id = 'Employee is required';
  if (!input.subsidiary_id) errors.subsidiary_id = 'Subsidiary is required';
  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (!lines.length) errors.lines = 'An expense report needs at least one line';
  lines.forEach((l, i) => {
    if (!isValidDate(l.expense_date)) errors[`lines.${i}.expense_date`] = 'A valid date is required';
    if (Money.parse(l.amount) <= 0) errors[`lines.${i}.amount`] = 'Amount must be greater than zero';
  });
  if (Object.keys(errors).length) throw new ValidationError(errors);

  const now = nowIso();
  const id = ulid();
  const prepared = lines.map((l, i) => ({
    id: ulid(), report_id: id, line_no: i + 1,
    expense_date: l.expense_date, category: l.category || 'other',
    account_id: l.account_id || null,
    project_id: l.project_id || input.project_id || null,
    task_id: l.task_id || null,
    description: l.description || '',
    amount: Money.parse(l.amount), tax_amount: Money.parse(l.tax_amount),
    billable: l.billable ? 1 : 0, billed_txn_id: null,
    receipt_ref: l.receipt_ref || '',
  }));
  repo.insert('expense_report', {
    id, report_no: input.report_no || nextNumber(repo, 'EXPENSE_REPORT'),
    employee_id: input.employee_id, project_id: input.project_id || null,
    subsidiary_id: input.subsidiary_id, currency: input.currency || 'USD',
    report_date: input.report_date || today(), status: 'draft',
    total: sum(prepared, (l) => l.amount + l.tax_amount),
    billable_total: sum(prepared.filter((l) => l.billable), (l) => l.amount),
    memo: input.memo || '', approved_by: null, approved_at: null, journal_entry_id: null,
    custom: input.custom || {}, created_at: now, updated_at: now,
  });
  for (const l of prepared) repo.insert('expense_line', l);
  audit.record(repo, { recordType: 'expense_report', recordId: id, action: 'create' });
  return { ...getReport(repo, id), lines: expenseLines(repo, id) };
}

export const EXPENSE_STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'reimbursed'];

/**
 * Move a claim along. The states are deliberately few: an employee submits,
 * somebody decides, and the company eventually pays. Approval is the moment
 * the cost becomes the company's — that is where it hits the ledger, as an
 * expense owed to the person who spent the money, not as cash leaving.
 */
export function submitExpenseReport(repo, id) {
  const report = getReport(repo, id);
  if (report.status !== 'draft' && report.status !== 'rejected') {
    throw unprocessable(`${report.report_no} is ${report.status} and cannot be submitted again.`);
  }
  if (!expenseLines(repo, id).length) throw unprocessable(`${report.report_no} has no lines to claim.`);
  repo.update('expense_report', id, { status: 'submitted', updated_at: nowIso() });
  audit.record(repo, { recordType: 'expense_report', recordId: id, action: 'submit' });
  return { ...getReport(repo, id), lines: expenseLines(repo, id) };
}

export function decideExpenseReport(repo, id, { approve = true, note = '' } = {}) {
  const report = getReport(repo, id);
  if (report.status !== 'submitted') {
    throw unprocessable(`${report.report_no} is ${report.status}; only a submitted claim can be decided.`);
  }
  const now = nowIso();
  if (!approve) {
    repo.update('expense_report', id, {
      status: 'rejected', memo: note ? `${report.memo}${report.memo ? ' — ' : ''}${note}`.trim() : report.memo,
      updated_at: now,
    });
    audit.record(repo, { recordType: 'expense_report', recordId: id, action: 'reject', changes: { status: { from: 'submitted', to: 'rejected' } } });
    return { ...getReport(repo, id), lines: expenseLines(repo, id) };
  }

  const acc = postingAccounts(repo);
  const lines = expenseLines(repo, id);
  const owed = acc.accrued_liabilities || acc.employer_tax_payable;
  if (!owed) throw unprocessable('No liability account is configured to hold what the company owes the claimant.');

  // One debit per account rather than one per receipt: a claim with six taxi
  // fares should not put six identical lines through the ledger.
  const byAccount = new Map();
  for (const l of lines) {
    const account = l.account_id || acc.travel || acc.cogs;
    if (!account) throw unprocessable(`Line ${l.line_no} has no expense account, and there is no default to fall back on.`);
    byAccount.set(account, (byAccount.get(account) || 0) + l.amount + l.tax_amount);
  }
  const journal = [
    ...[...byAccount].map(([account_id, amount]) => ({ account_id, debit: amount, credit: 0, memo: `Expenses ${report.report_no}` })),
    {
      account_id: owed, debit: 0, credit: report.total,
      entity_type: 'employee', entity_id: report.employee_id,
      memo: `Owed to claimant — ${report.report_no}`,
    },
  ];
  const entry = gl.postJournal(repo, {
    subsidiary_id: report.subsidiary_id, txn_date: report.report_date, currency: report.currency,
    memo: `Expense report ${report.report_no}`,
    source_type: 'expense_report', source_id: id, lines: journal,
  });

  repo.update('expense_report', id, {
    status: 'approved', approved_by: repo.ctx?.user?.id || null, approved_at: now,
    journal_entry_id: entry.id, updated_at: now,
  });
  audit.record(repo, { recordType: 'expense_report', recordId: id, action: 'approve', changes: { journal_entry: { from: null, to: entry.entry_no } } });
  return { ...getReport(repo, id), lines: expenseLines(repo, id) };
}

/** Pay the claimant. The expense was recognised at approval; this is cash. */
export function reimburseExpenseReport(repo, id, { paid_date = today(), account_id = null } = {}) {
  const report = getReport(repo, id);
  if (report.status !== 'approved') {
    throw unprocessable(`${report.report_no} is ${report.status}; only an approved claim can be reimbursed.`);
  }
  const acc = postingAccounts(repo);
  const owed = acc.accrued_liabilities || acc.employer_tax_payable;
  const cash = account_id || acc.bank;
  if (!owed || !cash) throw unprocessable('A bank account and a liability account are both needed to reimburse a claim.');

  const entry = gl.postJournal(repo, {
    subsidiary_id: report.subsidiary_id, txn_date: paid_date, currency: report.currency,
    memo: `Reimbursement of ${report.report_no}`,
    source_type: 'expense_report', source_id: id,
    lines: [
      { account_id: owed, debit: report.total, credit: 0, entity_type: 'employee', entity_id: report.employee_id, memo: 'Claim settled' },
      { account_id: cash, debit: 0, credit: report.total, memo: `Reimbursement ${report.report_no}` },
    ],
  });
  repo.update('expense_report', id, { status: 'reimbursed', updated_at: nowIso() });
  audit.record(repo, { recordType: 'expense_report', recordId: id, action: 'reimburse', changes: { journal_entry: { from: null, to: entry.entry_no } } });
  return { ...getReport(repo, id), lines: expenseLines(repo, id) };
}

// ------------------------------------------------------------- billing
/** Everything on a project that could be invoiced but has not been. */
export function unbilled(repo, projectId) {
  const project = getProject(repo, projectId);
  const time = repo.query(
    `SELECT te.*, (e.first_name || ' ' || e.last_name) AS employee_name FROM time_entry te
     LEFT JOIN employee e ON e.tenant_id = te.tenant_id AND e.id = te.employee_id
     WHERE te.tenant_id = :t AND te.project_id = ? AND te.billable = 1
       AND te.status = 'approved' AND (te.billed_txn_id IS NULL OR te.billed_txn_id = '')
     ORDER BY te.entry_date`, [projectId]);
  const expenses = repo.query(
    `SELECT el.*, er.employee_id FROM expense_line el
     JOIN expense_report er ON er.tenant_id = el.tenant_id AND er.id = el.report_id
     WHERE el.tenant_id = :t AND el.project_id = ? AND el.billable = 1
       AND er.status IN ('approved','reimbursed') AND (el.billed_txn_id IS NULL OR el.billed_txn_id = '')
     ORDER BY el.expense_date`, [projectId]);
  const milestones = repo.query(
    `SELECT * FROM project_task WHERE tenant_id = :t AND project_id = ?
       AND is_milestone = 1 AND status = 'complete' AND milestone_billed = 0
     ORDER BY sequence`, [projectId]);

  // time_entry.hours is a REAL count of hours; bill_rate is minor units per hour.
  const lineValue = (t) => Math.round((t.hours || 0) * (t.bill_rate || 0));
  const timeValue = sum(time, lineValue);
  return {
    project,
    time: time.map((t) => ({
      id: t.id, date: t.entry_date, employee: t.employee_name, hours: t.hours,
      rate: Money.toNumber(t.bill_rate), amount: Money.toNumber(lineValue(t)),
    })),
    expenses: expenses.map((e) => ({ id: e.id, date: e.expense_date, description: e.description, amount: Money.toNumber(e.amount) })),
    milestones: milestones.map((m) => ({ id: m.id, name: m.name, amount: Money.toNumber(m.milestone_amount) })),
    totals: {
      time: Money.toNumber(timeValue),
      expenses: Money.toNumber(sum(expenses, (e) => e.amount)),
      milestones: Money.toNumber(sum(milestones, (m) => m.milestone_amount)),
    },
  };
}

/**
 * Raise an invoice for everything unbilled, and mark the source records so
 * the same hour is never billed twice. The marking and the invoice happen in
 * one transaction for exactly that reason.
 */
export function billProject(repo, projectId, { txn_date = today(), include_time = true, include_expenses = true, include_milestones = true, service_item_id = null, memo = '' } = {}) {
  const project = getProject(repo, projectId);
  if (!project.customer_id) throw unprocessable(`${project.project_no} has no customer, so it cannot be invoiced`);
  if (project.billing_type === 'non_billable') throw unprocessable(`${project.project_no} is marked non-billable`);

  const work = unbilled(repo, projectId);
  const lines = [];
  const timeIds = [], expenseIds = [], milestoneIds = [];

  // Most project work is hours and receipts, not catalogue items, so the
  // usual line here carries no item at all. A transaction line still has to
  // say where the money lands: without a service item, name the project's own
  // income account (or the company's service revenue account) explicitly,
  // otherwise every T&M invoice fails validation before it is written.
  const revenueAccount = service_item_id
    ? null
    : (project.income_account_id || postingAccounts(repo).service_revenue || null);
  if (!service_item_id && !revenueAccount) {
    throw unprocessable(`${project.project_no} cannot be invoiced: set a service item or an income account on the project first`);
  }
  const billingLine = (description, quantity, rate) => ({
    item_id: service_item_id || null,
    account_id: service_item_id ? null : revenueAccount,
    description, quantity, rate,
  });

  if (include_time) {
    for (const t of work.time) {
      lines.push(billingLine(`${t.date} — ${t.employee || 'Time'} (${t.hours}h)`, t.hours, t.rate));
      timeIds.push(t.id);
    }
  }
  if (include_expenses) {
    for (const e of work.expenses) {
      lines.push(billingLine(`Expense ${e.date} — ${e.description}`, 1, e.amount));
      expenseIds.push(e.id);
    }
  }
  if (include_milestones) {
    for (const m of work.milestones) {
      lines.push(billingLine(`Milestone — ${m.name}`, 1, m.amount));
      milestoneIds.push(m.id);
    }
  }
  if (!lines.length) throw unprocessable(`Nothing is currently billable on ${project.project_no}`);

  return repo.tx(() => {
    const invoice = txnMod.createTxn(repo, 'INVOICE', {
      entity_id: project.customer_id, subsidiary_id: project.subsidiary_id,
      currency: project.currency, txn_date,
      memo: memo || `${project.project_no} ${project.name}`,
      project_id: projectId, lines,
    });
    for (const id of timeIds) repo.update('time_entry', id, { billed_txn_id: invoice.id });
    for (const id of expenseIds) repo.update('expense_line', id, { billed_txn_id: invoice.id });
    for (const id of milestoneIds) repo.update('project_task', id, { milestone_billed: 1 });
    audit.record(repo, {
      recordType: 'project', recordId: projectId, action: 'bill',
      changes: { invoice: { from: null, to: invoice.txn_no }, lines: { from: 0, to: lines.length } },
    });
    return { invoice, billed: { time: timeIds.length, expenses: expenseIds.length, milestones: milestoneIds.length } };
  });
}

/**
 * Profitability: billed revenue against labour cost and expenses.
 * Fixed-price projects recognise the fee against percent complete, which is
 * the only reading that does not swing wildly month to month.
 */
export function profitability(repo, projectId) {
  const project = getProject(repo, projectId);

  const labour = repo.queryOne(
    `SELECT COALESCE(SUM(hours), 0) AS hours,
            COALESCE(SUM(CAST(ROUND(hours * cost_rate) AS INTEGER)), 0) AS cost,
            COALESCE(SUM(CASE WHEN billable = 1 THEN CAST(ROUND(hours * bill_rate) AS INTEGER) ELSE 0 END), 0) AS billable_value
     FROM time_entry WHERE tenant_id = :t AND project_id = ? AND status = 'approved'`, [projectId]);
  const expense = repo.queryOne(
    `SELECT COALESCE(SUM(el.amount), 0) AS cost
     FROM expense_line el JOIN expense_report er ON er.tenant_id = el.tenant_id AND er.id = el.report_id
     WHERE el.tenant_id = :t AND el.project_id = ? AND er.status IN ('approved','reimbursed')`, [projectId]);
  const invoiced = repo.queryOne(
    `SELECT COALESCE(SUM(CASE WHEN type = 'INVOICE' THEN total ELSE -total END), 0) AS revenue
     FROM txn WHERE tenant_id = :t AND project_id = ? AND type IN ('INVOICE','CREDIT_MEMO') AND status != 'voided'`, [projectId]);

  const cost = (labour.cost || 0) + (expense.cost || 0);
  const recognised = project.billing_type === 'fixed_price'
    ? Money.pct(project.fixed_fee, project.percent_complete)
    : (invoiced.revenue || 0);
  const margin = recognised - cost;

  return {
    project: { id: project.id, project_no: project.project_no, name: project.name, billing_type: project.billing_type, percent_complete: project.percent_complete },
    hours: Qty.toNumber(Qty.parse(labour.hours || 0)),
    labour_cost: Money.toNumber(labour.cost || 0),
    expense_cost: Money.toNumber(expense.cost || 0),
    total_cost: Money.toNumber(cost),
    invoiced: Money.toNumber(invoiced.revenue || 0),
    recognised_revenue: Money.toNumber(recognised),
    unbilled_value: Money.toNumber(Math.max(0, (labour.billable_value || 0) - (invoiced.revenue || 0))),
    margin: Money.toNumber(margin),
    margin_pct: recognised ? Math.round((margin / recognised) * 1000) / 10 : null,
    budget: Money.toNumber(project.budget_amount),
    budget_used_pct: project.budget_amount ? Math.round((cost / project.budget_amount) * 1000) / 10 : null,
    over_budget: project.budget_amount > 0 && cost > project.budget_amount,
  };
}

/** Portfolio view: one row per project, sorted worst margin first. */
export function portfolio(repo, { status = null } = {}) {
  const projects = repo.query(
    `SELECT id FROM project WHERE tenant_id = :t ${status ? 'AND status = ?' : ''} ORDER BY created_at DESC`,
    status ? [status] : []);
  const rows = projects.map((p) => profitability(repo, p.id));
  rows.sort((a, b) => (a.margin_pct ?? 999) - (b.margin_pct ?? 999));
  return {
    projects: rows,
    totals: {
      count: rows.length,
      revenue: Math.round(rows.reduce((s, r) => s + r.recognised_revenue, 0) * 100) / 100,
      cost: Math.round(rows.reduce((s, r) => s + r.total_cost, 0) * 100) / 100,
      margin: Math.round(rows.reduce((s, r) => s + r.margin, 0) * 100) / 100,
      over_budget: rows.filter((r) => r.over_budget).length,
    },
  };
}
