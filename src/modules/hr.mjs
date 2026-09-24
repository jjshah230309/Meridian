// Meridian ERP :: modules/hr
// SuitePeople-style employee directory, org chart, time tracking, time off
// and payroll. Payroll CALCULATES and POSTS to the GL; the actual money
// movement and statutory filing are delegated to a payroll provider through
// the integration_event outbox (see exportPayroll below).
//
// Deliberate scope note: this module does not compute statutory tax. Real
// payroll tax is jurisdiction-specific, changes yearly, and getting it wrong
// is a legal problem, not a bug. Rates are configuration, and the run is
// designed to be reconciled against the provider's own calculation.
import { ulid, nowIso, today, Money, addDays, daysBetween, sum, groupBy, round } from '../core/util.mjs';
import { notFound, unprocessable, ValidationError, conflict } from '../core/http.mjs';
import { nextNumber } from '../core/seq.mjs';
import * as audit from '../core/audit.mjs';
import { indexRecord } from '../core/search.mjs';
import * as gl from './gl.mjs';
import { postingAccounts } from './setup.mjs';
import * as platform from './platform.mjs';

export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contractor', 'intern'];
export const PAY_FREQUENCIES = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 };
export const TIME_OFF_TYPES = ['vacation', 'sick', 'personal', 'unpaid', 'parental'];

// ------------------------------------------------------------ employees
export function getEmployee(repo, id) {
  const e = repo.get('employee', id);
  if (!e) throw notFound(`Employee ${id} not found`);
  return e;
}

export function createEmployee(repo, input) {
  const fields = {};
  if (!input.first_name) fields.first_name = 'First name is required';
  if (!input.last_name) fields.last_name = 'Last name is required';
  if (input.employment_type && !EMPLOYMENT_TYPES.includes(input.employment_type)) fields.employment_type = 'Unknown employment type';
  if (input.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email)) fields.email = 'Enter a valid email address';
  if (Object.keys(fields).length) throw new ValidationError(fields);

  const subsidiaryId = input.subsidiary_id || repo.queryOne('SELECT id FROM subsidiary WHERE tenant_id = :t AND active = 1 ORDER BY created_at LIMIT 1')?.id;
  if (!subsidiaryId) throw unprocessable('No active subsidiary exists.');
  const now = nowIso();

  const id = repo.insert('employee', {
    id: ulid(), employee_no: input.employee_no || nextNumber(repo, 'employee'),
    first_name: input.first_name, last_name: input.last_name, preferred_name: input.preferred_name || '',
    email: input.email || '', work_phone: input.work_phone || '', mobile: input.mobile || '',
    title: input.title || '', department_id: input.department_id || null,
    manager_id: input.manager_id || null, subsidiary_id: subsidiaryId,
    location_id: input.location_id || null, class_id: input.class_id || null,
    hire_date: input.hire_date || today(), termination_date: null,
    employment_type: input.employment_type || 'full_time', status: 'active',
    pay_type: input.pay_type || 'salary', pay_rate: Money.parse(input.pay_rate ?? 0),
    pay_frequency: input.pay_frequency || 'monthly',
    currency: input.currency || repo.get('subsidiary', subsidiaryId)?.currency || 'USD',
    standard_hours: Number(input.standard_hours || 40),
    is_sales_rep: input.is_sales_rep ? 1 : 0, is_manager: input.is_manager ? 1 : 0,
    user_id: input.user_id || null, address: input.address || {},
    emergency_contact: input.emergency_contact || {},
    // Only the last four digits are ever accepted; see docs/SECURITY.md.
    national_id_last4: String(input.national_id_last4 || '').slice(-4),
    bank_last4: String(input.bank_last4 || '').slice(-4),
    provider_ref: input.provider_ref || '',
    pto_balance_hours: Number(input.pto_balance_hours || 0),
    notes: input.notes || '', custom: platform.validateCustom(repo, 'employee', input.custom || {}), created_at: now, updated_at: now,
  });
  audit.record(repo, { recordType: 'employee', recordId: id, action: 'create', after: { ...input, national_id_last4: undefined, bank_last4: undefined } });
  reindexEmployee(repo, id);
  return getEmployee(repo, id);
}

export function updateEmployee(repo, id, patch) {
  const before = getEmployee(repo, id);
  const allowed = ['first_name', 'last_name', 'preferred_name', 'email', 'work_phone', 'mobile', 'title',
    'department_id', 'manager_id', 'subsidiary_id', 'location_id', 'class_id', 'hire_date',
    'termination_date', 'employment_type', 'status', 'pay_type', 'pay_rate', 'pay_frequency',
    'currency', 'standard_hours', 'is_sales_rep', 'is_manager', 'user_id', 'address',
    'emergency_contact', 'national_id_last4', 'bank_last4', 'provider_ref', 'pto_balance_hours',
    'notes', 'custom'];
  const clean = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k)) continue;
    if (k === 'pay_rate') clean[k] = Money.parse(v);
    else if (k === 'national_id_last4' || k === 'bank_last4') clean[k] = String(v || '').slice(-4);
    else if (k === 'custom') clean.custom = { ...(before.custom || {}), ...platform.validateCustom(repo, 'employee', v, { partial: true }) };
    else clean[k] = v;
  }
  // Guard against an org-chart cycle.
  if (clean.manager_id && clean.manager_id !== before.manager_id) {
    let cursor = clean.manager_id; const seen = new Set([id]);
    while (cursor) {
      if (seen.has(cursor)) throw unprocessable('That reporting line would create a loop in the org chart.');
      seen.add(cursor);
      cursor = repo.get('employee', cursor)?.manager_id || null;
    }
  }
  if (clean.status === 'terminated' && !clean.termination_date && !before.termination_date) clean.termination_date = today();
  clean.updated_at = nowIso();
  repo.update('employee', id, clean);
  const after = getEmployee(repo, id);
  audit.record(repo, { recordType: 'employee', recordId: id, action: 'update', before, after });
  reindexEmployee(repo, id);
  return after;
}

export function reindexEmployee(repo, id) {
  const e = repo.get('employee', id);
  if (!e) return;
  const dept = e.department_id ? repo.get('department', e.department_id) : null;
  indexRecord(repo, 'employee', id, {
    title: `${e.preferred_name || e.first_name} ${e.last_name}`,
    subtitle: [e.title, dept?.name].filter(Boolean).join(' · '),
    body: [e.email, e.work_phone, e.mobile, e.employee_no, e.notes].filter(Boolean).join(' '),
  });
}

/** Directory with manager and department names resolved. */
export function directory(repo, { search = null, departmentId = null, managerId = null, status = 'active', limit = 500 } = {}) {
  const where = []; const params = [];
  if (status && status !== 'all') { where.push('e.status = ?'); params.push(status); }
  if (departmentId) { where.push('e.department_id = ?'); params.push(departmentId); }
  if (managerId) { where.push('e.manager_id = ?'); params.push(managerId); }
  if (search) {
    where.push('(e.first_name LIKE ? OR e.last_name LIKE ? OR e.email LIKE ? OR e.title LIKE ? OR e.employee_no LIKE ?)');
    const s = `%${search}%`; params.push(s, s, s, s, s);
  }
  return repo.query(`SELECT e.*, d.name department_name, l.name location_name,
      m.first_name manager_first, m.last_name manager_last
      FROM employee e
      LEFT JOIN department d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
      LEFT JOIN location l ON l.tenant_id = e.tenant_id AND l.id = e.location_id
      LEFT JOIN employee m ON m.tenant_id = e.tenant_id AND m.id = e.manager_id
      WHERE e.tenant_id = :t${where.length ? ' AND ' + where.join(' AND ') : ''}
      ORDER BY e.last_name, e.first_name LIMIT ?`, [...params, limit]);
}

/** Reporting tree rooted at employees with no manager. */
export function orgChart(repo) {
  const rows = repo.query(`SELECT e.id, e.first_name, e.last_name, e.preferred_name, e.title, e.manager_id, e.email,
      d.name department_name FROM employee e
      LEFT JOIN department d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
      WHERE e.tenant_id = :t AND e.status = 'active' ORDER BY e.last_name`);
  const byId = new Map(rows.map((r) => [r.id, { ...r, reports: [] }]));
  const roots = [];
  for (const e of byId.values()) {
    if (e.manager_id && byId.has(e.manager_id) && e.manager_id !== e.id) byId.get(e.manager_id).reports.push(e);
    else roots.push(e);
  }
  const countAll = (n) => { n.total_reports = n.reports.length + sum(n.reports, countAll); return n.total_reports; };
  roots.forEach(countAll);
  return roots;
}

export function headcountMetrics(repo) {
  const all = repo.query('SELECT * FROM employee WHERE tenant_id = :t');
  const active = all.filter((e) => e.status === 'active');
  const ninetyDaysAgo = addDays(today(), -90);
  return {
    headcount: active.length,
    by_type: Object.fromEntries(EMPLOYMENT_TYPES.map((t) => [t, active.filter((e) => e.employment_type === t).length])),
    by_department: Object.entries(groupBy(active, (e) => e.department_id || 'unassigned'))
      .map(([id, list]) => ({ department_id: id, name: id === 'unassigned' ? 'Unassigned' : repo.get('department', id)?.name || 'Unknown', count: list.length })),
    hires_90d: all.filter((e) => e.hire_date >= ninetyDaysAgo).length,
    terminations_90d: all.filter((e) => e.termination_date && e.termination_date >= ninetyDaysAgo).length,
    on_leave: all.filter((e) => e.status === 'on_leave').length,
    annualised_salary_cost: sum(active, (e) => (e.pay_type === 'salary' ? e.pay_rate : e.pay_rate * e.standard_hours * 52)),
  };
}

// ---------------------------------------------------------- time tracking
export function logTime(repo, input) {
  const fields = {};
  if (!input.employee_id) fields.employee_id = 'Employee is required';
  if (!input.entry_date) fields.entry_date = 'Date is required';
  const hours = Number(input.hours || 0);
  if (!(hours > 0)) fields.hours = 'Enter hours greater than zero';
  if (hours > 24) fields.hours = 'A single entry cannot exceed 24 hours';
  if (Object.keys(fields).length) throw new ValidationError(fields);

  const emp = getEmployee(repo, input.employee_id);
  const dayTotal = repo.scalar(`SELECT COALESCE(SUM(hours),0) h FROM time_entry
      WHERE tenant_id = :t AND employee_id = ? AND entry_date = ? AND status != 'rejected'`, [emp.id, input.entry_date], 0);
  if (dayTotal + hours > 24) throw new ValidationError({ hours: `That would put ${emp.first_name} at ${dayTotal + hours} hours on ${input.entry_date}` });

  // A task implies its project, and a task from another project is a typo
  // worth refusing: project cost and progress are both derived from these.
  const task = input.task_id ? repo.get('project_task', input.task_id) : null;
  if (input.task_id && !task) throw new ValidationError({ task_id: 'That task does not exist' });
  const projectId = task ? task.project_id : (input.project_id || null);
  if (input.project_id && task && task.project_id !== input.project_id) {
    throw new ValidationError({ task_id: 'That task belongs to a different project' });
  }
  if (projectId && !repo.get('project', projectId)) {
    throw new ValidationError({ project_id: 'That project does not exist' });
  }

  const now = nowIso();
  const id = repo.insert('time_entry', {
    id: ulid(), employee_id: emp.id, entry_date: input.entry_date, hours,
    customer_id: input.customer_id || null, item_id: input.item_id || null,
    project_id: projectId, task_id: input.task_id || null,
    project: input.project || '', department_id: input.department_id || emp.department_id,
    billable: input.billable ? 1 : 0, billed_txn_id: null,
    bill_rate: Money.parse(input.bill_rate ?? 0),
    cost_rate: Money.parse(input.cost_rate ?? (emp.pay_type === 'hourly' ? Money.toNumber(emp.pay_rate) : 0)),
    status: input.status || 'draft', memo: input.memo || '',
    custom: input.custom || {}, created_at: now, updated_at: now,
  });
  audit.record(repo, { recordType: 'time_entry', recordId: id, action: 'create', after: input });
  return repo.get('time_entry', id);
}

export function approveTime(repo, ids, { approve = true } = {}) {
  const list = Array.isArray(ids) ? ids : [ids];
  let n = 0;
  for (const id of list) {
    const e = repo.get('time_entry', id);
    if (!e) continue;
    if (e.status === 'approved' && approve) continue;
    repo.update('time_entry', id, {
      status: approve ? 'approved' : 'rejected',
      approved_by: repo.ctx?.user?.id || null, approved_at: nowIso(), updated_at: nowIso(),
    });
    audit.record(repo, { recordType: 'time_entry', recordId: id, action: approve ? 'approve' : 'reject' });
    n++;
  }
  return n;
}

/** Weekly timesheet grid for one employee. */
export function timesheet(repo, employeeId, weekStart) {
  const weekEnd = addDays(weekStart, 6);
  const entries = repo.query(`SELECT te.*, c.name customer_name FROM time_entry te
      LEFT JOIN customer c ON c.tenant_id = te.tenant_id AND c.id = te.customer_id
      WHERE te.tenant_id = :t AND te.employee_id = ? AND te.entry_date BETWEEN ? AND ?
      ORDER BY te.entry_date`, [employeeId, weekStart, weekEnd]);
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  return {
    employee: getEmployee(repo, employeeId),
    week_start: weekStart, week_end: weekEnd, days,
    entries,
    total_hours: sum(entries, (e) => e.hours),
    billable_hours: sum(entries.filter((e) => e.billable), (e) => e.hours),
    by_day: Object.fromEntries(days.map((d) => [d, sum(entries.filter((e) => e.entry_date === d), (x) => x.hours)])),
  };
}

// -------------------------------------------------------------- time off
export function requestTimeOff(repo, input) {
  const fields = {};
  if (!input.employee_id) fields.employee_id = 'Employee is required';
  if (!input.start_date) fields.start_date = 'Start date is required';
  if (!input.end_date) fields.end_date = 'End date is required';
  if (input.start_date && input.end_date && input.end_date < input.start_date) fields.end_date = 'End date cannot precede the start date';
  if (Object.keys(fields).length) throw new ValidationError(fields);

  const emp = getEmployee(repo, input.employee_id);
  const days = daysBetween(input.start_date, input.end_date) + 1;
  const hours = Number(input.hours || days * (emp.standard_hours / 5));

  const overlap = repo.queryOne(`SELECT * FROM time_off WHERE tenant_id = :t AND employee_id = ?
      AND status IN ('pending','approved') AND start_date <= ? AND end_date >= ?`,
    [emp.id, input.end_date, input.start_date]);
  if (overlap) throw conflict(`${emp.first_name} already has ${overlap.type} booked from ${overlap.start_date} to ${overlap.end_date}.`);

  const id = repo.insert('time_off', {
    id: ulid(), employee_id: emp.id, type: TIME_OFF_TYPES.includes(input.type) ? input.type : 'vacation',
    start_date: input.start_date, end_date: input.end_date, hours,
    status: 'pending', approver_id: emp.manager_id || null, note: input.note || '', created_at: nowIso(),
  });
  audit.record(repo, { recordType: 'time_off', recordId: id, action: 'create', after: { ...input, hours } });
  return repo.get('time_off', id);
}

export function decideTimeOff(repo, id, approve) {
  const r = repo.get('time_off', id);
  if (!r) throw notFound('Time off request not found');
  if (r.status !== 'pending') throw unprocessable(`That request is already ${r.status}.`);
  repo.update('time_off', id, { status: approve ? 'approved' : 'rejected', approver_id: repo.ctx?.user?.id || r.approver_id, approved_at: nowIso() });
  if (approve && r.type !== 'unpaid') {
    const emp = repo.get('employee', r.employee_id);
    repo.update('employee', r.employee_id, { pto_balance_hours: Math.max(0, (emp?.pto_balance_hours || 0) - r.hours), updated_at: nowIso() });
  }
  audit.record(repo, { recordType: 'time_off', recordId: id, action: approve ? 'approve' : 'reject', before: r });
  return repo.get('time_off', id);
}

// --------------------------------------------------------------- payroll
/**
 * Calculate a payroll run. Employee/employer tax rates come from tenant
 * settings; they are a placeholder for a real engine and are labelled as
 * such in the UI. Nothing is posted until approvePayroll().
 */
export function calculatePayroll(repo, input) {
  const fields = {};
  if (!input.period_start) fields.period_start = 'Period start is required';
  if (!input.period_end) fields.period_end = 'Period end is required';
  if (!input.pay_date) fields.pay_date = 'Pay date is required';
  if (Object.keys(fields).length) throw new ValidationError(fields);

  const subsidiaryId = input.subsidiary_id || repo.queryOne('SELECT id FROM subsidiary WHERE tenant_id = :t AND active = 1 ORDER BY created_at LIMIT 1')?.id;
  const subsidiary = repo.get('subsidiary', subsidiaryId);
  if (!subsidiary) throw unprocessable('No subsidiary available for payroll.');

  const dup = repo.queryOne(`SELECT * FROM payroll_run WHERE tenant_id = :t AND subsidiary_id = ?
      AND period_start = ? AND period_end = ? AND status != 'failed'`, [subsidiaryId, input.period_start, input.period_end]);
  if (dup) throw conflict(`Payroll run ${dup.run_no} already covers ${input.period_start} to ${input.period_end}.`);

  const settings = { employee_tax_pct: 22, employer_tax_pct: 7.65, ...(input.rates || {}) };
  const employees = repo.query(`SELECT * FROM employee WHERE tenant_id = :t AND subsidiary_id = ? AND status IN ('active','on_leave')
      AND employment_type != 'contractor' AND (termination_date IS NULL OR termination_date >= ?)
      AND (hire_date IS NULL OR hire_date <= ?)`, [subsidiaryId, input.period_start, input.period_end]);
  if (!employees.length) throw unprocessable('No payable employees found for this subsidiary and period.');

  const now = nowIso();
  const runId = ulid();
  const lines = [];
  for (const e of employees) {
    let gross;
    let hours = 0;
    if (e.pay_type === 'salary') {
      gross = round(e.pay_rate / (PAY_FREQUENCIES[e.pay_frequency] || 12));
    } else {
      hours = repo.scalar(`SELECT COALESCE(SUM(hours),0) h FROM time_entry
          WHERE tenant_id = :t AND employee_id = ? AND entry_date BETWEEN ? AND ? AND status = 'approved'`,
        [e.id, input.period_start, input.period_end], 0);
      gross = round(e.pay_rate * hours);
    }
    if (gross <= 0) continue;
    const employeeTax = Money.pct(gross, settings.employee_tax_pct);
    const employerTax = Money.pct(gross, settings.employer_tax_pct);
    const deductions = Money.parse(0);
    lines.push({
      id: ulid(), employee_id: e.id, hours, overtime_hours: 0,
      gross, employee_tax: employeeTax, employer_tax: employerTax, deductions,
      net: gross - employeeTax - deductions, department_id: e.department_id,
      earnings: { base: Money.toNumber(gross), pay_type: e.pay_type, frequency: e.pay_frequency },
    });
  }

  if (!lines.length) {
    throw unprocessable(
      `${employees.length} employee${employees.length === 1 ? ' has' : 's have'} no pay for `
      + `${input.period_start} to ${input.period_end}. Salaried staff need a pay rate, and hourly `
      + 'staff need approved time in the period.');
  }

  const totals = {
    gross: sum(lines, (l) => l.gross), employee_tax: sum(lines, (l) => l.employee_tax),
    employer_tax: sum(lines, (l) => l.employer_tax), deductions: sum(lines, (l) => l.deductions),
    net: sum(lines, (l) => l.net),
  };

  repo.insert('payroll_run', {
    id: runId, run_no: nextNumber(repo, 'payroll_run'), subsidiary_id: subsidiaryId,
    period_start: input.period_start, period_end: input.period_end, pay_date: input.pay_date,
    status: 'calculated', currency: subsidiary.currency,
    total_gross: totals.gross, total_employee_tax: totals.employee_tax,
    total_employer_tax: totals.employer_tax, total_deductions: totals.deductions, total_net: totals.net,
    employee_count: lines.length, journal_entry_id: null,
    provider: input.provider || 'none', provider_ref: '', provider_status: '',
    created_at: now, updated_at: now,
  });
  for (const l of lines) repo.insert('payroll_line', { ...l, run_id: runId });

  audit.record(repo, { recordType: 'payroll_run', recordId: runId, action: 'calculate', changes: { employees: { from: null, to: lines.length }, gross: { from: null, to: Money.toNumber(totals.gross) } } });
  return getPayrollRun(repo, runId);
}

export function getPayrollRun(repo, id) {
  const r = repo.get('payroll_run', id);
  if (!r) return null;
  r.lines = repo.query(`SELECT pl.*, e.first_name, e.last_name, e.employee_no, e.title, d.name department_name
      FROM payroll_line pl JOIN employee e ON e.tenant_id = pl.tenant_id AND e.id = pl.employee_id
      LEFT JOIN department d ON d.tenant_id = pl.tenant_id AND d.id = pl.department_id
      WHERE pl.tenant_id = :t AND pl.run_id = ? ORDER BY e.last_name`, [id]);
  return r;
}

/**
 * Approve and post a payroll run.
 *   Dr Salaries & Wages      gross
 *   Dr Employer Payroll Tax  employer tax
 *     Cr Employee Tax Withheld  employee tax
 *     Cr Employer Tax Payable   employer tax
 *     Cr Payroll Liabilities    net pay (cleared when the provider funds it)
 */
export function approvePayroll(repo, id) {
  const run = getPayrollRun(repo, id);
  if (!run) throw notFound('Payroll run not found');
  if (run.status === 'posted') throw conflict(`${run.run_no} has already been posted.`);
  if (run.status !== 'calculated' && run.status !== 'approved') throw unprocessable(`${run.run_no} is ${run.status} and cannot be posted.`);

  const acc = postingAccounts(repo);
  const payrollLiability = repo.queryOne("SELECT id FROM account WHERE tenant_id = :t AND number = '2200'")?.id;
  const lines = [
    { account_id: acc.salaries, debit: run.total_gross, credit: 0, memo: `Payroll ${run.run_no} gross` },
    { account_id: acc.employer_tax, debit: run.total_employer_tax, credit: 0, memo: 'Employer payroll taxes' },
    { account_id: acc.payroll_withheld, debit: 0, credit: run.total_employee_tax, memo: 'Employee tax withheld' },
    { account_id: acc.employer_tax_payable, debit: 0, credit: run.total_employer_tax, memo: 'Employer tax payable' },
    { account_id: payrollLiability, debit: 0, credit: run.total_net, memo: 'Net pay owed to employees' },
  ].filter((l) => l.debit || l.credit);
  if (lines.length < 2) throw unprocessable(`${run.run_no} has nothing to post — its gross pay is zero.`);

  const entry = gl.postJournal(repo, {
    subsidiary_id: run.subsidiary_id, txn_date: run.pay_date, currency: run.currency,
    memo: `Payroll ${run.run_no} — ${run.period_start} to ${run.period_end}`,
    source_type: 'payroll', source_id: id, lines,
  });

  repo.update('payroll_run', id, { status: 'posted', journal_entry_id: entry.id, updated_at: nowIso() });
  audit.record(repo, { recordType: 'payroll_run', recordId: id, action: 'post', changes: { journal_entry: { from: null, to: entry.entry_no }, net: { from: null, to: Money.toNumber(run.total_net) } } });
  return getPayrollRun(repo, id);
}

/**
 * Payroll integration hook. Queues the run for an external provider via the
 * outbox rather than calling out inline: the ledger transaction must not
 * depend on a third party being reachable. A worker drains the outbox.
 */
export function exportPayroll(repo, id, { provider = 'generic', targetUrl = '' } = {}) {
  const run = getPayrollRun(repo, id);
  if (!run) throw notFound('Payroll run not found');
  if (run.status !== 'posted') throw unprocessable(`${run.run_no} must be posted before it can be sent to a provider.`);

  const payload = {
    run_no: run.run_no, period: { start: run.period_start, end: run.period_end }, pay_date: run.pay_date,
    currency: run.currency, totals: { gross: run.total_gross, net: run.total_net, employee_tax: run.total_employee_tax, employer_tax: run.total_employer_tax },
    employees: run.lines.map((l) => ({
      employee_no: l.employee_no, provider_ref: repo.get('employee', l.employee_id)?.provider_ref || null,
      gross: l.gross, employee_tax: l.employee_tax, employer_tax: l.employer_tax, net: l.net,
    })),
  };
  const eventId = repo.insert('integration_event', {
    id: ulid(), channel: 'payroll', event_type: 'payroll.run.submitted',
    record_type: 'payroll_run', record_id: id, payload, status: 'pending',
    attempts: 0, last_error: '', target_url: targetUrl, created_at: nowIso(),
  });
  repo.update('payroll_run', id, { provider, provider_status: 'queued', exported_at: nowIso(), updated_at: nowIso() });
  audit.record(repo, { recordType: 'payroll_run', recordId: id, action: 'export', changes: { provider: { from: null, to: provider } } });
  return { event_id: eventId, payload };
}
