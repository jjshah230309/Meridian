// Meridian ERP :: modules/budget
// Budgets, rolling forecasts and budget-versus-actual.
//
// A budget is a set of amounts per account per period, so variance is a
// straight join against the same gl_balance rollup the financial statements
// read. Forecasts are budgets with a different scenario tag: identical
// mechanics, so one screen and one report serve both.
import { ulid, Money, nowIso, sum } from '../core/util.mjs';
import { ValidationError, notFound, unprocessable } from '../core/http.mjs';
import { nextNumber } from '../core/seq.mjs';
import * as gl from './gl.mjs';
import * as audit from '../core/audit.mjs';

export const SCENARIOS = ['budget', 'forecast', 'plan'];
export const STATUSES = ['draft', 'approved', 'locked'];

export const getBudget = (repo, id) => {
  const b = repo.get('budget', id);
  if (!b) throw notFound(`Budget ${id} not found`);
  return b;
};

export function createBudget(repo, input) {
  const errors = {};
  if (!input.name) errors.name = 'Name is required';
  if (!input.fiscal_year) errors.fiscal_year = 'Fiscal year is required';
  if (input.scenario && !SCENARIOS.includes(input.scenario)) errors.scenario = `Scenario must be one of ${SCENARIOS.join(', ')}`;
  if (Object.keys(errors).length) throw new ValidationError(errors);

  const now = nowIso();
  const id = ulid();
  repo.insert('budget', {
    id,
    name: input.name,
    scenario: input.scenario || 'budget',
    fiscal_year: Number(input.fiscal_year),
    subsidiary_id: input.subsidiary_id || null,
    currency: input.currency || 'USD',
    status: 'draft',
    notes: input.notes || '',
    custom: input.custom || {},
    created_at: now, updated_at: now,
  });
  if (Array.isArray(input.lines) && input.lines.length) setLines(repo, id, input.lines);
  audit.record(repo, { recordType: 'budget', recordId: id, action: 'create' });
  return getBudget(repo, id);
}

export const linesFor = (repo, budgetId) =>
  repo.query(`SELECT bl.*, a.number AS account_number, a.name AS account_name, a.type AS account_type,
                     p.name AS period_name, p.start_date, p.end_date
              FROM budget_line bl
              JOIN account a ON a.tenant_id = bl.tenant_id AND a.id = bl.account_id
              JOIN accounting_period p ON p.tenant_id = bl.tenant_id AND p.id = bl.period_id
              WHERE bl.tenant_id = :t AND bl.budget_id = ?
              ORDER BY a.number, p.start_date`, [budgetId]);

/** Replace the budget's lines wholesale. Amounts arrive as numbers. */
export function setLines(repo, budgetId, lines) {
  if (!Array.isArray(lines)) throw new ValidationError({ lines: 'Budget lines must be a list' });
  const budget = getBudget(repo, budgetId);
  if (budget.status === 'locked') throw unprocessable(`${budget.name} is locked and cannot be edited`);

  const errors = {};
  const prepared = [];
  lines.forEach((l, i) => {
    if (!l.account_id) { errors[`lines.${i}.account_id`] = 'Account is required'; return; }
    if (!l.period_id) { errors[`lines.${i}.period_id`] = 'Period is required'; return; }
    const account = repo.get('account', l.account_id);
    if (!account) { errors[`lines.${i}.account_id`] = `Account ${l.account_id} not found`; return; }
    if (account.is_summary) { errors[`lines.${i}.account_id`] = `${account.number} is a summary account and cannot be budgeted`; return; }
    if (!repo.get('accounting_period', l.period_id)) { errors[`lines.${i}.period_id`] = `Period ${l.period_id} not found`; return; }
    prepared.push({
      id: ulid(), budget_id: budgetId,
      account_id: l.account_id, period_id: l.period_id,
      department_id: l.department_id || null, class_id: l.class_id || null, location_id: l.location_id || null,
      amount: Money.parse(l.amount),
    });
  });
  if (Object.keys(errors).length) throw new ValidationError(errors);

  repo.exec('DELETE FROM budget_line WHERE tenant_id = :t AND budget_id = ?', [budgetId]);
  for (const p of prepared) repo.insert('budget_line', p);
  repo.update('budget', budgetId, { updated_at: nowIso() });
  return { budget_id: budgetId, lines: prepared.length, total: Money.toNumber(sum(prepared, (p) => p.amount)) };
}

/**
 * Seed a budget from last year's actuals, optionally uplifted.
 * The commonest way a budget actually gets built.
 */
export function seedFromActuals(repo, budgetId, { source_year = null, uplift_pct = 0, accounts = null } = {}) {
  const budget = getBudget(repo, budgetId);
  const fromYear = source_year || budget.fiscal_year - 1;
  const target = repo.query(
    'SELECT * FROM accounting_period WHERE tenant_id = :t AND fiscal_year = ? ORDER BY start_date', [budget.fiscal_year]);
  const source = repo.query(
    'SELECT * FROM accounting_period WHERE tenant_id = :t AND fiscal_year = ? ORDER BY start_date', [fromYear]);
  if (!target.length) throw unprocessable(`No accounting periods exist for ${budget.fiscal_year}. Generate them first.`);
  if (!source.length) throw unprocessable(`No accounting periods exist for ${fromYear}, so there is nothing to copy.`);

  const lines = [];
  for (let i = 0; i < target.length; i++) {
    const src = source[Math.min(i, source.length - 1)];
    const balances = repo.query(
      `SELECT b.account_id, SUM(b.base_debit - b.base_credit) AS net, a.type
       FROM gl_balance b JOIN account a ON a.tenant_id = b.tenant_id AND a.id = b.account_id
       WHERE b.tenant_id = :t AND b.period_id = ? AND a.type IN ('INCOME','EXPENSE')
         ${budget.subsidiary_id ? 'AND b.subsidiary_id = ?' : ''}
       GROUP BY b.account_id`,
      budget.subsidiary_id ? [src.id, budget.subsidiary_id] : [src.id]);
    for (const b of balances) {
      if (accounts && !accounts.includes(b.account_id)) continue;
      // Income is credit-normal and stored negative; a budget reads more
      // naturally as a positive figure for both revenue and cost.
      const magnitude = Math.abs(b.net || 0);
      if (!magnitude) continue;
      lines.push({
        account_id: b.account_id, period_id: target[i].id,
        amount: Money.toNumber(magnitude + Money.pct(magnitude, uplift_pct)),
      });
    }
  }
  const res = setLines(repo, budgetId, lines);
  return { ...res, source_year: fromYear, uplift_pct };
}

/**
 * Budget versus actual for a fiscal year.
 * Variance is signed so that "better than budget" is always positive:
 * revenue above budget and expense below budget both read as favourable.
 */
export function varianceReport(repo, { budget_id, from = null, to = null } = {}) {
  const budget = getBudget(repo, budget_id);
  const periods = repo.query(
    `SELECT * FROM accounting_period WHERE tenant_id = :t AND fiscal_year = ?
     ${from ? 'AND end_date >= ?' : ''} ${to ? 'AND start_date <= ?' : ''} ORDER BY start_date`,
    [budget.fiscal_year, ...(from ? [from] : []), ...(to ? [to] : [])]);
  const periodIds = periods.map((p) => p.id);
  if (!periodIds.length) return { budget, periods: [], rows: [], totals: null };

  const placeholders = periodIds.map(() => '?').join(',');
  const budgeted = repo.query(
    `SELECT account_id, SUM(amount) AS amount FROM budget_line
     WHERE tenant_id = :t AND budget_id = ? AND period_id IN (${placeholders}) GROUP BY account_id`,
    [budget_id, ...periodIds]);
  const actual = repo.query(
    `SELECT b.account_id, SUM(b.base_debit - b.base_credit) AS net FROM gl_balance b
     WHERE b.tenant_id = :t AND b.period_id IN (${placeholders})
       ${budget.subsidiary_id ? 'AND b.subsidiary_id = ?' : ''}
     GROUP BY b.account_id`,
    budget.subsidiary_id ? [...periodIds, budget.subsidiary_id] : periodIds);

  const budgetMap = new Map(budgeted.map((b) => [b.account_id, b.amount || 0]));
  const actualMap = new Map(actual.map((a) => [a.account_id, a.net || 0]));
  const ids = new Set([...budgetMap.keys(), ...actualMap.keys()]);

  const rows = [];
  for (const accountId of ids) {
    const account = repo.get('account', accountId);
    if (!account || !['INCOME', 'EXPENSE'].includes(account.type)) continue;
    const isIncome = account.type === 'INCOME';
    const budgetAmt = budgetMap.get(accountId) || 0;
    const actualAmt = Math.abs(actualMap.get(accountId) || 0);
    const variance = isIncome ? actualAmt - budgetAmt : budgetAmt - actualAmt;
    rows.push({
      account_id: accountId, number: account.number, name: account.name, type: account.type,
      budget: Money.toNumber(budgetAmt), actual: Money.toNumber(actualAmt),
      variance: Money.toNumber(variance),
      variance_pct: budgetAmt ? Math.round((variance / budgetAmt) * 1000) / 10 : null,
      favourable: variance >= 0,
    });
  }
  rows.sort((a, b) => a.number.localeCompare(b.number));

  const income = rows.filter((r) => r.type === 'INCOME');
  const expense = rows.filter((r) => r.type === 'EXPENSE');
  const t = (list, key) => Math.round(list.reduce((s, r) => s + r[key], 0) * 100) / 100;
  return {
    budget, periods: periods.map((p) => ({ id: p.id, name: p.name })), rows,
    totals: {
      revenue: { budget: t(income, 'budget'), actual: t(income, 'actual'), variance: t(income, 'variance') },
      expense: { budget: t(expense, 'budget'), actual: t(expense, 'actual'), variance: t(expense, 'variance') },
      net: {
        budget: t(income, 'budget') - t(expense, 'budget'),
        actual: t(income, 'actual') - t(expense, 'actual'),
        variance: t(income, 'variance') + t(expense, 'variance'),
      },
    },
  };
}

/**
 * Straight-line rolling forecast: actuals for closed periods, budget for the
 * rest of the year. What a CFO wants when asked "where do we land?".
 */
export function fullYearForecast(repo, { budget_id }) {
  const budget = getBudget(repo, budget_id);
  const periods = repo.query(
    'SELECT * FROM accounting_period WHERE tenant_id = :t AND fiscal_year = ? ORDER BY start_date', [budget.fiscal_year]);
  const out = [];
  for (const p of periods) {
    const closed = p.status !== 'open';
    const budgetRow = repo.queryOne(
      'SELECT COALESCE(SUM(bl.amount), 0) AS amt FROM budget_line bl JOIN account a ON a.tenant_id = bl.tenant_id AND a.id = bl.account_id WHERE bl.tenant_id = :t AND bl.budget_id = ? AND bl.period_id = ? AND a.type = ?',
      [budget_id, p.id, 'INCOME']);
    const budgetExp = repo.queryOne(
      'SELECT COALESCE(SUM(bl.amount), 0) AS amt FROM budget_line bl JOIN account a ON a.tenant_id = bl.tenant_id AND a.id = bl.account_id WHERE bl.tenant_id = :t AND bl.budget_id = ? AND bl.period_id = ? AND a.type = ?',
      [budget_id, p.id, 'EXPENSE']);
    const actualRow = repo.queryOne(
      `SELECT COALESCE(SUM(CASE WHEN a.type = 'INCOME' THEN b.base_credit - b.base_debit ELSE 0 END), 0) AS revenue,
              COALESCE(SUM(CASE WHEN a.type = 'EXPENSE' THEN b.base_debit - b.base_credit ELSE 0 END), 0) AS expense
       FROM gl_balance b JOIN account a ON a.tenant_id = b.tenant_id AND a.id = b.account_id
       WHERE b.tenant_id = :t AND b.period_id = ?`, [p.id]);
    const useActual = closed || (actualRow.revenue || actualRow.expense);
    out.push({
      period_id: p.id, name: p.name, closed, basis: useActual ? 'actual' : 'budget',
      revenue: Money.toNumber(useActual ? actualRow.revenue : budgetRow.amt),
      expense: Money.toNumber(useActual ? actualRow.expense : budgetExp.amt),
    });
  }
  for (const r of out) r.net = Math.round((r.revenue - r.expense) * 100) / 100;
  return {
    budget, periods: out,
    full_year: {
      revenue: Math.round(out.reduce((s, r) => s + r.revenue, 0) * 100) / 100,
      expense: Math.round(out.reduce((s, r) => s + r.expense, 0) * 100) / 100,
      net: Math.round(out.reduce((s, r) => s + r.net, 0) * 100) / 100,
      actual_periods: out.filter((r) => r.basis === 'actual').length,
    },
  };
}

export function setStatus(repo, id, status) {
  if (!STATUSES.includes(status)) throw new ValidationError({ status: `Status must be one of ${STATUSES.join(', ')}` });
  const before = getBudget(repo, id);
  repo.update('budget', id, { status, updated_at: nowIso() });
  audit.record(repo, { recordType: 'budget', recordId: id, action: 'status', changes: { status: { from: before.status, to: status } } });
  return getBudget(repo, id);
}
