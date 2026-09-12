// Meridian ERP :: modules/reports
// Financial statements, aging, and the KPI feed behind the dashboard.
//
// Every statement reads the materialised gl_balance rollup, joined to
// accounting_period for date scoping. Sign convention: internally every
// balance is DEBIT-POSITIVE; presentation flips income, liability and equity
// so the reader sees the natural positive figure.
import { Money, today, addDays, startOfMonth, endOfMonth, addMonths, daysBetween, sum, groupBy, round } from '../core/util.mjs';
import { notFound, badRequest } from '../core/http.mjs';
import * as gl from './gl.mjs';
import * as books from './books.mjs';

const presentationSign = (type) => (type === 'ASSET' || type === 'EXPENSE' ? 1 : -1);

/** Resolve a from/to date range into the periods it covers. */
function periodsBetween(repo, from, to) {
  return repo.query(`SELECT * FROM accounting_period WHERE tenant_id = :t
      AND end_date >= ? AND start_date <= ? ORDER BY start_date`, [from, to]);
}

/**
 * Sum account movement over an arbitrary date window.
 *
 * Periods that fall ENTIRELY inside the window are read from the materialised
 * gl_balance rollup -- one row per account per period, so a twelve-month P&L
 * is a handful of index lookups. Periods only PARTIALLY covered (the current
 * month, a mid-month as-at date) are summed from journal detail for the exact
 * days requested. Using the rollup alone would silently drop the current
 * month from every month-to-date figure.
 *
 * Returns accountId -> { debit, credit, net } in base currency, debit-positive.
 */
/**
 * Balances for a period range.
 *
 * `bookId` names which set of books is being asked for. The primary book is
 * the ledger and needs nothing extra; any other book is the ledger PLUS the
 * differences recorded against it, laid on at the end. Doing it here means
 * every statement built on this function -- trial balance, income statement,
 * balance sheet -- becomes book-aware at once, and none of them has to know
 * how a second book is stored.
 */
function balancesFor(repo, { from = null, to, subsidiaryId = null, bookId = null }) {
  const start = from || '0000-01-01';
  const periods = repo.query(
    `SELECT id, start_date, end_date FROM accounting_period
      WHERE tenant_id = :t AND end_date >= ? AND start_date <= ? ORDER BY start_date`, [start, to]);

  const whole = []; const partial = [];
  for (const p of periods) {
    if (p.start_date >= start && p.end_date <= to) whole.push(p.id);
    else partial.push(p);
  }

  const out = {};
  const add = (accountId, d, c) => {
    const e = (out[accountId] ||= { debit: 0, credit: 0, net: 0 });
    e.debit += d || 0; e.credit += c || 0; e.net = e.debit - e.credit;
  };

  if (whole.length) {
    const chunk = 400;                       // stay well inside SQLite's parameter limit
    for (let i = 0; i < whole.length; i += chunk) {
      const ids = whole.slice(i, i + chunk);
      const params = [...ids];
      let sub = '';
      if (subsidiaryId) { sub = ' AND subsidiary_id = ?'; params.push(subsidiaryId); }
      for (const r of repo.query(
        `SELECT account_id, SUM(base_debit) d, SUM(base_credit) c FROM gl_balance
          WHERE tenant_id = :t AND period_id IN (${ids.map(() => '?').join(',')})${sub}
          GROUP BY account_id`, params)) add(r.account_id, r.d, r.c);
    }
  }

  for (const p of partial) {
    const lo = p.start_date > start ? p.start_date : start;
    const hi = p.end_date < to ? p.end_date : to;
    if (lo > hi) continue;
    const params = [p.id, lo, hi];
    let sub = '';
    if (subsidiaryId) { sub = ' AND je.subsidiary_id = ?'; params.push(subsidiaryId); }
    for (const r of repo.query(
      `SELECT jl.account_id, SUM(jl.base_debit) d, SUM(jl.base_credit) c
         FROM journal_line jl JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
        WHERE jl.tenant_id = :t AND je.status = 'posted' AND je.period_id = ?
          AND je.txn_date >= ? AND je.txn_date <= ?${sub}
        GROUP BY jl.account_id`, params)) add(r.account_id, r.d, r.c);
  }

  if (bookId) {
    const book = books.getBook(repo, bookId);
    if (book && !book.is_primary) {
      const adj = books.adjustmentBalances(repo, { book_id: book.id, from, to, subsidiaryId });
      for (const [accountId, b] of Object.entries(adj)) add(accountId, b.debit, b.credit);
    }
  }
  return out;
}

/**
 * The first day of the fiscal year that `date` falls in, read from the
 * company's own calendar rather than assumed to be 1 January — a company on
 * an April year end would otherwise have its year-to-date figures cut in the
 * wrong place. Falls back to the calendar year when no period covers the date.
 */
export function fiscalYearStart(repo, date) {
  const period = repo.queryOne(
    `SELECT fiscal_year FROM accounting_period WHERE tenant_id = :t
       AND start_date <= ? AND end_date >= ? ORDER BY is_adjustment LIMIT 1`, [date, date]);
  if (!period) return `${date.slice(0, 4)}-01-01`;
  return repo.scalar(
    'SELECT MIN(start_date) v FROM accounting_period WHERE tenant_id = :t AND fiscal_year = ?',
    [period.fiscal_year], `${date.slice(0, 4)}-01-01`);
}

/**
 * The accounts a financial statement is made of.
 *
 * Statistical accounts are left out on purpose. They hold quantities --
 * headcount, floor area, machine hours -- so that allocations have something
 * to divide by; forty-two employees is not forty-two dollars, and adding one
 * to a trial balance is how it stops balancing.
 */
const accountsIndex = (repo) => {
  const rows = repo.query('SELECT * FROM account WHERE tenant_id = :t AND is_statistical = 0 ORDER BY number');
  return { rows, byId: new Map(rows.map((a) => [a.id, a])) };
};

// ------------------------------------------------------- trial balance
export function trialBalance(repo, { from = null, to = null, subsidiaryId = null, bookId = null } = {}) {
  const asOf = to || today();
  const { rows: accounts } = accountsIndex(repo);
  const bal = balancesFor(repo, { from, to: asOf, subsidiaryId, bookId });
  const lines = [];
  for (const a of accounts) {
    const b = bal[a.id];
    if (!b || (b.debit === 0 && b.credit === 0)) continue;
    const net = b.net;
    lines.push({
      account_id: a.id, number: a.number, name: a.name, type: a.type, subtype: a.subtype,
      debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0,
      gross_debit: b.debit, gross_credit: b.credit,
    });
  }
  const totalDebit = sum(lines, (l) => l.debit);
  const totalCredit = sum(lines, (l) => l.credit);
  return {
    from, to: asOf, subsidiary_id: subsidiaryId, lines,
    total_debit: totalDebit, total_credit: totalCredit,
    balanced: totalDebit === totalCredit, out_of_balance: totalDebit - totalCredit,
  };
}

// ----------------------------------------------------- income statement
/**
 * P&L for a window, optionally against a comparison window.
 * Structure: Revenue - COGS = Gross Profit - OpEx = Operating Income
 *            + Other Income - Other Expense = Net Income.
 */
export function incomeStatement(repo, { from, to, subsidiaryId = null, compareFrom = null, compareTo = null, bookId = null } = {}) {
  const start = from || startOfMonth(today());
  const end = to || today();
  const { rows: accounts } = accountsIndex(repo);
  const cur = balancesFor(repo, { from: start, to: end, subsidiaryId, bookId });
  const cmp = compareFrom ? balancesFor(repo, { from: compareFrom, to: compareTo || compareFrom, subsidiaryId, bookId }) : null;

  const section = (predicate) => {
    const items = accounts
      .filter((a) => !a.is_summary && predicate(a))
      .map((a) => {
        const amount = (cur[a.id]?.net || 0) * presentationSign(a.type);
        const compare = cmp ? (cmp[a.id]?.net || 0) * presentationSign(a.type) : null;
        return { account_id: a.id, number: a.number, name: a.name, subtype: a.subtype, amount, compare, variance: cmp ? amount - compare : null };
      })
      .filter((x) => x.amount !== 0 || (x.compare ?? 0) !== 0);
    return { items, total: sum(items, (i) => i.amount), compare_total: cmp ? sum(items, (i) => i.compare) : null };
  };

  const revenue = section((a) => a.type === 'INCOME' && a.subtype !== 'OTHER_INCOME');
  const cogs = section((a) => a.type === 'EXPENSE' && a.subtype === 'COGS');
  const opex = section((a) => a.type === 'EXPENSE' && ['OPERATING_EXPENSE', 'PAYROLL_EXPENSE'].includes(a.subtype));
  const otherIncome = section((a) => a.type === 'INCOME' && a.subtype === 'OTHER_INCOME');
  const otherExpense = section((a) => a.type === 'EXPENSE' && a.subtype === 'OTHER_EXPENSE');

  const grossProfit = revenue.total - cogs.total;
  const operatingIncome = grossProfit - opex.total;
  const netIncome = operatingIncome + otherIncome.total - otherExpense.total;
  const cmpGross = cmp ? revenue.compare_total - cogs.compare_total : null;
  const cmpOperating = cmp ? cmpGross - opex.compare_total : null;
  const cmpNet = cmp ? cmpOperating + otherIncome.compare_total - otherExpense.compare_total : null;

  return {
    period: { from: start, to: end },
    compare_period: compareFrom ? { from: compareFrom, to: compareTo || compareFrom } : null,
    subsidiary_id: subsidiaryId,
    revenue, cogs, opex, other_income: otherIncome, other_expense: otherExpense,
    gross_profit: grossProfit, gross_margin_pct: revenue.total ? round((grossProfit / revenue.total) * 1000) / 10 : 0,
    operating_income: operatingIncome,
    operating_margin_pct: revenue.total ? round((operatingIncome / revenue.total) * 1000) / 10 : 0,
    net_income: netIncome,
    net_margin_pct: revenue.total ? round((netIncome / revenue.total) * 1000) / 10 : 0,
    compare: cmp ? { gross_profit: cmpGross, operating_income: cmpOperating, net_income: cmpNet } : null,
  };
}

// -------------------------------------------------------- balance sheet
/**
 * Balance sheet as at a date. Current-period earnings are computed from the
 * income accounts rather than assumed to be closed, so the statement balances
 * on any date, mid-year included.
 */
export function balanceSheet(repo, { asOf = null, subsidiaryId = null, bookId = null } = {}) {
  const date = asOf || today();
  const { rows: accounts } = accountsIndex(repo);
  const bal = balancesFor(repo, { to: date, subsidiaryId, bookId });

  const section = (predicate) => {
    const items = accounts.filter((a) => !a.is_summary && predicate(a)).map((a) => ({
      account_id: a.id, number: a.number, name: a.name, subtype: a.subtype,
      amount: (bal[a.id]?.net || 0) * presentationSign(a.type),
    })).filter((x) => x.amount !== 0);
    return { items, total: sum(items, (i) => i.amount) };
  };

  const CURRENT_ASSET = ['BANK', 'AR', 'INVENTORY', 'OTHER_CURRENT_ASSET'];
  const CURRENT_LIABILITY = ['AP', 'CREDIT_CARD', 'OTHER_CURRENT_LIABILITY', 'PAYROLL_LIABILITY', 'TAX_LIABILITY'];

  const currentAssets = section((a) => a.type === 'ASSET' && CURRENT_ASSET.includes(a.subtype));
  const fixedAssets = section((a) => a.type === 'ASSET' && !CURRENT_ASSET.includes(a.subtype));
  const currentLiabilities = section((a) => a.type === 'LIABILITY' && CURRENT_LIABILITY.includes(a.subtype));
  const longTermLiabilities = section((a) => a.type === 'LIABILITY' && !CURRENT_LIABILITY.includes(a.subtype));
  const equity = section((a) => a.type === 'EQUITY');

  // Everything posted to profit and loss before the current fiscal year.
  const fyStartForPrior = fiscalYearStart(repo, date);
  const balancesBefore = fyStartForPrior > '0001-01-01'
    ? balancesFor(repo, { to: addDays(fyStartForPrior, -1), subsidiaryId, bookId })
    : {};

  // Profit belongs to the owners, so it has to reach equity or the sheet does
  // not balance. Everything earned before this fiscal year is retained
  // earnings whether or not a closing entry was ever posted; this year's
  // profit is shown separately, the way a reader expects to see it.
  const fyStart = fyStartForPrior;
  const priorEarnings = -sum(
    accounts.filter((a) => !a.is_summary && (a.type === 'INCOME' || a.type === 'EXPENSE')),
    (a) => (balancesBefore[a.id]?.net || 0)) || 0;      // never report a negative zero
  const currentEarnings = incomeStatement(repo, { from: fyStart, to: date, subsidiaryId }).net_income;

  const totalAssets = currentAssets.total + fixedAssets.total;
  const totalLiabilities = currentLiabilities.total + longTermLiabilities.total;
  const totalEquity = equity.total + priorEarnings + currentEarnings;

  return {
    as_of: date, subsidiary_id: subsidiaryId,
    current_assets: currentAssets, fixed_assets: fixedAssets,
    current_liabilities: currentLiabilities, long_term_liabilities: longTermLiabilities,
    // `items` stays a list of real accounts; the two earnings figures are
    // reported beside it because no account holds them until a year is closed.
    equity: {
      ...equity,
      posted_total: equity.total,
      total: equity.total + priorEarnings + currentEarnings,
      retained_earnings_prior_years: priorEarnings,
      current_year_earnings: currentEarnings,
    },
    total_assets: totalAssets, total_liabilities: totalLiabilities, total_equity: totalEquity,
    total_liabilities_and_equity: totalLiabilities + totalEquity,
    balanced: totalAssets === totalLiabilities + totalEquity,
    out_of_balance: totalAssets - (totalLiabilities + totalEquity),
    working_capital: currentAssets.total - currentLiabilities.total,
    current_ratio: currentLiabilities.total ? round((currentAssets.total / currentLiabilities.total) * 100) / 100 : null,
  };
}

// ------------------------------------------------------------ cash flow
/** Indirect-method cash flow: net income adjusted for working-capital moves. */
export function cashFlow(repo, { from, to, subsidiaryId = null } = {}) {
  const start = from || startOfMonth(today());
  const end = to || today();
  const { rows: accounts } = accountsIndex(repo);
  const movement = balancesFor(repo, { from: start, to: end, subsidiaryId });

  const pl = incomeStatement(repo, { from: start, to: end, subsidiaryId });
  const byCategory = { operating: [], investing: [], financing: [] };
  let cashMovement = 0;

  for (const a of accounts) {
    if (a.is_summary) continue;
    const net = movement[a.id]?.net || 0;
    if (!net) continue;
    if (a.subtype === 'BANK') { cashMovement += net; continue; }
    if (a.type === 'INCOME' || a.type === 'EXPENSE') continue;    // already in net income
    // A rise in an asset consumes cash; a rise in a liability provides it.
    const effect = a.type === 'ASSET' ? -net : -net;
    const category = a.cash_flow_category || (a.type === 'ASSET' ? 'operating' : a.type === 'EQUITY' ? 'financing' : 'operating');
    byCategory[category] ||= [];
    byCategory[category].push({ account_id: a.id, number: a.number, name: a.name, amount: effect });
  }

  const operating = pl.net_income + sum(byCategory.operating, (x) => x.amount);
  const investing = sum(byCategory.investing, (x) => x.amount);
  const financing = sum(byCategory.financing, (x) => x.amount);

  const openingCash = sum(accounts.filter((a) => a.subtype === 'BANK'),
    (a) => (balancesFor(repo, { to: addDays(start, -1), subsidiaryId })[a.id]?.net || 0));

  return {
    period: { from: start, to: end },
    net_income: pl.net_income,
    operating_adjustments: byCategory.operating,
    investing_items: byCategory.investing,
    financing_items: byCategory.financing,
    operating_cash_flow: operating, investing_cash_flow: investing, financing_cash_flow: financing,
    net_change_in_cash: operating + investing + financing,
    computed_cash_movement: cashMovement,
    opening_cash: openingCash, closing_cash: openingCash + cashMovement,
    // These agree when every balance-sheet movement is classified. A gap
    // points at an unclassified account rather than a broken ledger.
    reconciles: Math.abs((operating + investing + financing) - cashMovement) <= 1,
  };
}

// ---------------------------------------------------------------- aging
/**
 * Aging bands. Each band covers `(previous.max, max]` days past due, so a
 * document 16 days late lands in "1–30" and one 61 days late in "61–90".
 * Getting these boundaries right matters: collections teams work the buckets.
 */
export const AGING_BANDS = [
  { label: 'Current', max: 0 },
  { label: '1\u201330', max: 30 },
  { label: '31\u201360', max: 60 },
  { label: '61\u201390', max: 90 },
  { label: '90+', max: Infinity },
];

function aging(repo, type, entityTable, { asOf = null, subsidiaryId = null } = {}) {
  const date = asOf || today();
  const params = [type, date];
  let where = '';
  if (subsidiaryId) { where = ' AND t.subsidiary_id = ?'; params.push(subsidiaryId); }
  const rows = repo.query(`SELECT t.id, t.txn_no, t.txn_date, t.due_date, t.currency, t.total,
      t.amount_applied, t.amount_remaining, t.entity_id, e.name entity_name, e.entity_no
      FROM txn t JOIN ${entityTable} e ON e.tenant_id = t.tenant_id AND e.id = t.entity_id
      WHERE t.tenant_id = :t AND t.type = ? AND t.amount_remaining > 0
        AND t.status NOT IN ('voided','cancelled') AND t.txn_date <= ?${where}
      ORDER BY e.name, t.due_date`, params);

  const bandFor = (dueDate) => {
    const overdue = dueDate ? daysBetween(dueDate, date) : 0;
    if (overdue <= 0) return 0;
    for (let i = 1; i < AGING_BANDS.length; i++) if (overdue <= AGING_BANDS[i].max) return i;
    return AGING_BANDS.length - 1;
  };

  const byEntity = new Map();
  for (const r of rows) {
    if (!byEntity.has(r.entity_id)) {
      byEntity.set(r.entity_id, {
        entity_id: r.entity_id, entity_name: r.entity_name, entity_no: r.entity_no,
        buckets: AGING_BANDS.map(() => 0), total: 0, documents: [],
      });
    }
    const e = byEntity.get(r.entity_id);
    const b = bandFor(r.due_date);
    e.buckets[b] += r.amount_remaining;
    e.total += r.amount_remaining;
    e.documents.push({ ...r, bucket: b, days_overdue: r.due_date ? Math.max(0, daysBetween(r.due_date, date)) : 0 });
  }

  const entities = [...byEntity.values()].sort((a, b) => b.total - a.total);
  const totals = AGING_BANDS.map((_, i) => sum(entities, (e) => e.buckets[i]));
  const grand = sum(totals, (x) => x);
  const overdue = sum(totals.slice(1), (x) => x);
  return {
    as_of: date, bucket_labels: AGING_BANDS.map((b) => b.label),
    bucket_days: AGING_BANDS.map((b) => (b.max === Infinity ? null : b.max)),
    entities, bucket_totals: totals, total: grand,
    overdue_total: overdue,
    overdue_pct: grand ? round((overdue / grand) * 1000) / 10 : 0,
    document_count: rows.length,
  };
}

export const arAging = (repo, opts) => aging(repo, 'INVOICE', 'customer', opts);
export const apAging = (repo, opts) => aging(repo, 'VENDOR_BILL', 'vendor', opts);

// ------------------------------------------------------- sales analysis
export function revenueByMonth(repo, { months = 12, subsidiaryId = null } = {}) {
  const start = startOfMonth(addMonths(today(), -(months - 1)));
  const params = [start];
  let where = '';
  if (subsidiaryId) { where = ' AND t.subsidiary_id = ?'; params.push(subsidiaryId); }
  const rows = repo.query(`SELECT substr(t.txn_date,1,7) month,
      SUM(CASE WHEN t.type='INVOICE' THEN t.total ELSE -t.total END) revenue, COUNT(*) count
      FROM txn t WHERE t.tenant_id = :t AND t.type IN ('INVOICE','CREDIT_MEMO')
      AND t.status NOT IN ('voided','cancelled') AND t.txn_date >= ?${where}
      GROUP BY month ORDER BY month`, params);
  const map = Object.fromEntries(rows.map((r) => [r.month, r]));
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const m = addMonths(startOfMonth(today()), -i).slice(0, 7);
    out.push({ month: m, revenue: map[m]?.revenue || 0, count: map[m]?.count || 0 });
  }
  return out;
}

export function topCustomers(repo, { limit = 10, days = 365 } = {}) {
  return repo.query(`SELECT c.id, c.name, c.entity_no, c.currency,
      SUM(CASE WHEN t.type='INVOICE' THEN t.total ELSE -t.total END) revenue,
      COUNT(DISTINCT t.id) orders,
      MAX(t.txn_date) last_order
      FROM txn t JOIN customer c ON c.tenant_id = t.tenant_id AND c.id = t.entity_id
      WHERE t.tenant_id = :t AND t.type IN ('INVOICE','CREDIT_MEMO')
        AND t.status NOT IN ('voided','cancelled') AND t.txn_date >= ?
      GROUP BY c.id ORDER BY revenue DESC LIMIT ?`, [addDays(today(), -days), limit]);
}

export function topItems(repo, { limit = 10, days = 365 } = {}) {
  return repo.query(`SELECT i.id, i.sku, i.name, i.uom,
      SUM(tl.quantity) qty_sold, SUM(tl.amount) revenue,
      SUM(tl.quantity * tl.unit_cost / 1000000) est_cost
      FROM txn_line tl
      JOIN txn t ON t.tenant_id = tl.tenant_id AND t.id = tl.txn_id
      JOIN item i ON i.tenant_id = tl.tenant_id AND i.id = tl.item_id
      WHERE tl.tenant_id = :t AND t.type = 'INVOICE' AND t.status NOT IN ('voided','cancelled')
        AND t.txn_date >= ?
      GROUP BY i.id ORDER BY revenue DESC LIMIT ?`, [addDays(today(), -days), limit]);
}

// ------------------------------------------------------------- KPI feed
/** Everything the dashboard widgets need, in one round trip. */
export function dashboard(repo, { subsidiaryId = null } = {}) {
  const now = today();
  const monthStart = startOfMonth(now);
  const lastMonthStart = startOfMonth(addMonths(now, -1));
  const lastMonthEnd = endOfMonth(lastMonthStart);

  const pl = incomeStatement(repo, { from: monthStart, to: now, subsidiaryId, compareFrom: lastMonthStart, compareTo: lastMonthEnd });
  const bs = balanceSheet(repo, { asOf: now, subsidiaryId });
  const ar = arAging(repo, { asOf: now, subsidiaryId });
  const ap = apAging(repo, { asOf: now, subsidiaryId });

  const cash = sum(repo.query(`SELECT a.id FROM account a WHERE a.tenant_id = :t AND a.subtype = 'BANK'`),
    (a) => (gl.balanceMap(repo, { subsidiaryId })[a.id] || 0));

  const openOrders = repo.queryOne(`SELECT COUNT(*) c, COALESCE(SUM(total),0) v FROM txn
      WHERE tenant_id = :t AND type='SALES_ORDER' AND status IN ('open','partially_fulfilled','pending_approval')`);
  const pendingApprovals = repo.scalar(`SELECT COUNT(*) c FROM txn WHERE tenant_id = :t AND approval_status = 'pending'`, [], 0);
  const inventoryValue = repo.scalar('SELECT COALESCE(SUM(total_value),0) v FROM item_location WHERE tenant_id = :t', [], 0);
  const openCases = repo.scalar(`SELECT COUNT(*) c FROM support_case WHERE tenant_id = :t AND status NOT IN ('resolved','closed')`, [], 0);
  const headcount = repo.scalar(`SELECT COUNT(*) c FROM employee WHERE tenant_id = :t AND status='active'`, [], 0);
  const pipelineValue = repo.scalar(`SELECT COALESCE(SUM(amount),0) v FROM opportunity WHERE tenant_id = :t AND stage NOT IN ('closed_won','closed_lost')`, [], 0);
  const weightedPipeline = repo.scalar(`SELECT COALESCE(SUM(weighted_amount),0) v FROM opportunity WHERE tenant_id = :t AND stage NOT IN ('closed_won','closed_lost')`, [], 0);

  // Days sales outstanding, on trailing 90-day revenue.
  const rev90 = repo.scalar(`SELECT COALESCE(SUM(total),0) v FROM txn WHERE tenant_id = :t AND type='INVOICE'
      AND status NOT IN ('voided','cancelled') AND txn_date >= ?`, [addDays(now, -90)], 0);
  const dso = rev90 ? round((ar.total / rev90) * 90) : null;

  return {
    generated_at: new Date().toISOString(),
    period: { month_start: monthStart, today: now },
    revenue_mtd: pl.revenue.total,
    revenue_last_month: pl.revenue.compare_total,
    revenue_change_pct: pl.revenue.compare_total ? round(((pl.revenue.total - pl.revenue.compare_total) / Math.abs(pl.revenue.compare_total)) * 1000) / 10 : null,
    gross_profit_mtd: pl.gross_profit, gross_margin_pct: pl.gross_margin_pct,
    net_income_mtd: pl.net_income, expenses_mtd: pl.opex.total + pl.cogs.total,
    cash_balance: cash, working_capital: bs.working_capital, current_ratio: bs.current_ratio,
    total_assets: bs.total_assets, total_liabilities: bs.total_liabilities, total_equity: bs.total_equity,
    ar_total: ar.total, ar_overdue: ar.overdue_total, ar_overdue_pct: ar.overdue_pct,
    ap_total: ap.total, ap_overdue: ap.overdue_total,
    dso,
    open_orders_count: openOrders?.c || 0, open_orders_value: openOrders?.v || 0,
    pending_approvals: pendingApprovals,
    inventory_value: inventoryValue,
    open_cases: openCases, headcount,
    pipeline_value: pipelineValue, weighted_pipeline: weightedPipeline,
    revenue_trend: revenueByMonth(repo, { months: 12, subsidiaryId }),
    ar_buckets: ar.bucket_totals.map((v, i) => ({ label: ar.bucket_labels[i], value: v })),
    top_customers: topCustomers(repo, { limit: 5, days: 365 }),
  };
}

/** Detail rows behind a KPI, so a number on the dashboard is clickable. */
export function drillDown(repo, metric, opts = {}) {
  switch (metric) {
    case 'ar_overdue': return arAging(repo, opts).entities.flatMap((e) => e.documents.filter((d) => d.bucket > 0));
    case 'ap_overdue': return apAging(repo, opts).entities.flatMap((e) => e.documents.filter((d) => d.bucket > 0));
    case 'open_orders': return repo.query(`SELECT t.*, c.name entity_name FROM txn t LEFT JOIN customer c ON c.tenant_id=t.tenant_id AND c.id=t.entity_id
        WHERE t.tenant_id = :t AND t.type='SALES_ORDER' AND t.status IN ('open','partially_fulfilled') ORDER BY t.txn_date DESC LIMIT 200`);
    case 'pending_approvals': return repo.query(`SELECT t.*, c.name entity_name FROM txn t LEFT JOIN customer c ON c.tenant_id=t.tenant_id AND c.id=t.entity_id
        WHERE t.tenant_id = :t AND t.approval_status='pending' ORDER BY t.txn_date DESC LIMIT 200`);
    default: throw badRequest(`No drill-down defined for "${metric}"`);
  }
}
