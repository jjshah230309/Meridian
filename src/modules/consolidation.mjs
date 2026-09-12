// Meridian ERP :: modules/consolidation
// Group reporting across subsidiaries.
//
// Three things have to happen before a set of subsidiary ledgers becomes a
// group statement, and they happen in this order:
//   1. translate each subsidiary into the parent's currency -- balance-sheet
//      accounts at the closing rate, income-statement accounts at the period
//      average, equity at the historical rate;
//   2. eliminate intercompany accounts, which net to zero across the group
//      and would otherwise inflate both sides;
//   3. take the translation difference to a cumulative translation account,
//      because steps 1 and 2 will not otherwise balance -- that difference is
//      real and belongs in equity, not swept under a rounding line.
import { Money, round } from '../core/util.mjs';
import { unprocessable, notFound } from '../core/http.mjs';
import * as gl from './gl.mjs';

/** Every subsidiary under `rootId`, parents before children. */
export function subsidiaryTree(repo, rootId = null) {
  const all = repo.query('SELECT * FROM subsidiary WHERE tenant_id = :t AND active = 1 ORDER BY name');
  const byParent = new Map();
  for (const s of all) {
    const k = s.parent_id || '__root__';
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(s);
  }
  const out = [];
  const walk = (id, depth) => {
    for (const child of byParent.get(id) || []) {
      out.push({ ...child, depth });
      walk(child.id, depth + 1);
    }
  };
  if (rootId) {
    const root = all.find((s) => s.id === rootId);
    if (!root) throw notFound(`Subsidiary ${rootId} not found`);
    out.push({ ...root, depth: 0 });
    walk(rootId, 1);
  } else {
    walk('__root__', 0);
  }
  return out;
}

/**
 * Rate to translate `from` into `to` for a period.
 * Falls back to the daily rate table when no consolidation rate is stored,
 * so a group with one currency needs no setup at all.
 */
export function translationRates(repo, periodId, from, to) {
  if (from === to) return { closing: 1, average: 1, historical: 1, source: 'same-currency' };
  const stored = repo.queryOne(
    'SELECT * FROM consolidation_rate WHERE tenant_id = :t AND period_id = ? AND from_currency = ? AND to_currency = ?',
    [periodId, from, to]);
  if (stored) {
    return {
      closing: stored.closing_rate, average: stored.average_rate,
      historical: stored.historical_rate ?? stored.closing_rate, source: 'consolidation_rate',
    };
  }
  const period = repo.get('accounting_period', periodId);
  const closing = gl.exchangeRate(repo, from, to, period?.end_date || null);
  const average = gl.exchangeRate(repo, from, to, period?.start_date || null);
  return { closing, average: (closing + average) / 2, historical: closing, source: 'exchange_rate' };
}

const RATE_FOR = (account) => {
  if (account.type === 'EQUITY') return 'historical';
  if (account.type === 'INCOME' || account.type === 'EXPENSE') return 'average';
  return 'closing';
};

/**
 * Consolidated trial balance for a period range.
 * `eliminate` drops accounts flagged intercompany; set false to see the
 * gross position, which is what you want when chasing a mismatch.
 */
export function consolidatedTrialBalance(repo, { periodIds, parentSubsidiaryId = null, eliminate = true } = {}) {
  if (!periodIds || !periodIds.length) throw unprocessable('At least one accounting period is required');
  const tree = subsidiaryTree(repo, parentSubsidiaryId);
  if (!tree.length) throw unprocessable('No active subsidiaries to consolidate');
  const parent = parentSubsidiaryId ? tree[0] : tree.find((s) => !s.parent_id) || tree[0];
  const groupCurrency = parent.currency;

  const placeholders = periodIds.map(() => '?').join(',');
  const rows = repo.query(
    `SELECT b.subsidiary_id, b.period_id, b.account_id,
            SUM(b.base_debit) AS debit, SUM(b.base_credit) AS credit
     FROM gl_balance b
     WHERE b.tenant_id = :t AND b.period_id IN (${placeholders})
       AND b.subsidiary_id IN (${tree.map(() => '?').join(',')})
     GROUP BY b.subsidiary_id, b.period_id, b.account_id`,
    [...periodIds, ...tree.map((s) => s.id)]);

  const accounts = new Map();
  const bySubsidiary = new Map(tree.map((s) => [s.id, { ...s, debit: 0, credit: 0, translated_debit: 0, translated_credit: 0 }]));
  let eliminated = 0;
  let translationDelta = 0;

  for (const r of rows) {
    const account = repo.get('account', r.account_id);
    if (!account) continue;
    const sub = bySubsidiary.get(r.subsidiary_id);
    if (!sub) continue;

    const rates = translationRates(repo, r.period_id, sub.currency, groupCurrency);
    const rate = rates[RATE_FOR(account)] ?? rates.closing;
    const debit = Money.convert(r.debit, rate);
    const credit = Money.convert(r.credit, rate);

    // Translation gain/loss is the difference between translating at this
    // account's rate and translating at the closing rate. Accumulated, that
    // is the CTA balance.
    translationDelta += (debit - credit) - Money.convert(r.debit - r.credit, rates.closing);

    sub.debit += r.debit; sub.credit += r.credit;
    sub.translated_debit += debit; sub.translated_credit += credit;

    if (eliminate && account.is_intercompany) { eliminated += Math.abs(debit - credit); continue; }

    const key = r.account_id;
    const acc = accounts.get(key) || {
      account_id: key, number: account.number, name: account.name,
      type: account.type, subtype: account.subtype, debit: 0, credit: 0,
    };
    acc.debit += debit; acc.credit += credit;
    accounts.set(key, acc);
  }

  const lines = [...accounts.values()]
    .map((a) => ({ ...a, debit: Money.toNumber(a.debit), credit: Money.toNumber(a.credit), balance: Money.toNumber(a.debit - a.credit) }))
    .filter((a) => a.debit || a.credit)
    .sort((a, b) => a.number.localeCompare(b.number));

  const totalDebit = lines.reduce((s, a) => s + a.debit, 0);
  const totalCredit = lines.reduce((s, a) => s + a.credit, 0);
  const cta = round((totalCredit - totalDebit) * 100);

  return {
    group_currency: groupCurrency,
    parent: { id: parent.id, name: parent.name },
    subsidiaries: [...bySubsidiary.values()].map((s) => ({
      id: s.id, name: s.name, currency: s.currency, depth: s.depth,
      local_balance: Money.toNumber(s.debit - s.credit),
      translated_balance: Money.toNumber(s.translated_debit - s.translated_credit),
    })),
    lines,
    totals: {
      debit: Math.round(totalDebit * 100) / 100,
      credit: Math.round(totalCredit * 100) / 100,
      eliminated: Money.toNumber(eliminated),
      cumulative_translation_adjustment: Money.toNumber(cta),
      translation_delta: Money.toNumber(round(translationDelta)),
      balanced: Math.abs(totalDebit - totalCredit) < 0.005,
    },
  };
}

/** Consolidated income statement and balance sheet in one pass. */
export function consolidatedStatements(repo, { fiscalYear = null, from = null, to = null, parentSubsidiaryId = null, eliminate = true } = {}) {
  const periods = repo.query(
    `SELECT * FROM accounting_period WHERE tenant_id = :t
     ${fiscalYear ? 'AND fiscal_year = ?' : ''}
     ${from ? 'AND end_date >= ?' : ''} ${to ? 'AND start_date <= ?' : ''}
     ORDER BY start_date`,
    [...(fiscalYear ? [fiscalYear] : []), ...(from ? [from] : []), ...(to ? [to] : [])]);
  if (!periods.length) throw unprocessable('No accounting periods match that range');

  const tb = consolidatedTrialBalance(repo, { periodIds: periods.map((p) => p.id), parentSubsidiaryId, eliminate });
  const pick = (types) => tb.lines.filter((l) => types.includes(l.type));
  const income = pick(['INCOME']).map((l) => ({ ...l, amount: -l.balance }));
  const expense = pick(['EXPENSE']).map((l) => ({ ...l, amount: l.balance }));
  const assets = pick(['ASSET']).map((l) => ({ ...l, amount: l.balance }));
  const liabilities = pick(['LIABILITY']).map((l) => ({ ...l, amount: -l.balance }));
  const equity = pick(['EQUITY']).map((l) => ({ ...l, amount: -l.balance }));
  const t = (list) => Math.round(list.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const netIncome = t(income) - t(expense);

  return {
    period_range: { from: periods[0].start_date, to: periods[periods.length - 1].end_date, periods: periods.length },
    group_currency: tb.group_currency,
    subsidiaries: tb.subsidiaries,
    income_statement: {
      revenue: income, expenses: expense,
      total_revenue: t(income), total_expenses: t(expense), net_income: netIncome,
    },
    balance_sheet: {
      assets, liabilities, equity,
      total_assets: t(assets), total_liabilities: t(liabilities),
      total_equity: t(equity) + netIncome + tb.totals.cumulative_translation_adjustment,
      cumulative_translation_adjustment: tb.totals.cumulative_translation_adjustment,
      balanced: Math.abs(t(assets) - (t(liabilities) + t(equity) + netIncome + tb.totals.cumulative_translation_adjustment)) < 0.05,
    },
    eliminations: { applied: eliminate, amount: tb.totals.eliminated },
  };
}

export function setRate(repo, { period_id, from_currency, to_currency, closing_rate, average_rate, historical_rate = null }) {
  if (!repo.get('accounting_period', period_id)) throw notFound(`Period ${period_id} not found`);
  repo.exec(
    `INSERT INTO consolidation_rate (tenant_id, period_id, from_currency, to_currency, closing_rate, average_rate, historical_rate)
     VALUES (:t, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, period_id, from_currency, to_currency)
     DO UPDATE SET closing_rate = excluded.closing_rate, average_rate = excluded.average_rate, historical_rate = excluded.historical_rate`,
    [period_id, from_currency, to_currency, Number(closing_rate), Number(average_rate), historical_rate === null ? null : Number(historical_rate)]);
  return translationRates(repo, period_id, from_currency, to_currency);
}
