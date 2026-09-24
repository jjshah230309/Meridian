// Meridian ERP :: web/views/reports
// The financial reporting suite. Every statement shares one control bar and
// one table idiom, so learning one report teaches all of them.
import { h, mount, clear } from '../dom.js';
import { icon } from '../icons.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import * as store from '../store.js';
import { empty, toast, notifyError, statusTag, facts, loading } from '../ui.js';
import { barChart, lineChart, stackedBar, legend, donut } from '../charts.js';

const CATALOGUE = [
  { id: 'income-statement', name: 'Income Statement', group: 'Financial statements', desc: 'Revenue, cost of sales and operating expenses for a period, with a prior-period comparison.', perm: 'account' },
  { id: 'balance-sheet', name: 'Balance Sheet', group: 'Financial statements', desc: 'Assets, liabilities and equity as at a date, including current-year earnings.', perm: 'account' },
  { id: 'cash-flow', name: 'Cash Flow', group: 'Financial statements', desc: 'Indirect-method cash movement, reconciled against the bank accounts.', perm: 'account' },
  { id: 'trial-balance', name: 'Trial Balance', group: 'Financial statements', desc: 'Every account with a balance, proving debits equal credits.', perm: 'account' },
  { id: 'ar-aging', name: 'Receivables Aging', group: 'Working capital', desc: 'Outstanding customer invoices bucketed by how far past due they are.', perm: 'invoice' },
  { id: 'ap-aging', name: 'Payables Aging', group: 'Working capital', desc: 'Outstanding vendor bills bucketed by due date.', perm: 'vendor_bill' },
  { id: 'inventory-valuation', name: 'Inventory Valuation', group: 'Operations', desc: 'On-hand quantity and value by item and location at moving-average cost.', perm: 'item' },
  { id: 'sales-analysis', name: 'Sales Analysis', group: 'Operations', desc: 'Revenue trend, top customers and best-selling items.', perm: 'invoice' },
  { id: 'approvals', name: 'Approval Queue', group: 'Operations', desc: 'Everything currently waiting on an approver.', perm: 'sales_order' },
  { id: 'integrity', name: 'Ledger Integrity', group: 'Controls', desc: 'Proves the balance rollup still agrees with the journal detail.', perm: 'account' },
  { id: 'audit', name: 'Audit Trail', group: 'Controls', desc: 'Every change to every record, filterable by user, action and date.', perm: 'audit_event' },
];

export async function reportsView(route, { go }) {
  const id = route.parts[1];
  if (!id) return indexView(go);
  const report = CATALOGUE.find((r) => r.id === id);
  if (!report) return h('div.page', empty('Unknown report', `No report called “${id}”.`));
  if (!store.can(report.perm)) return h('div.page', empty('Not permitted', `Your role cannot view ${report.name.toLowerCase()}.`));

  const renderers = {
    'income-statement': incomeStatement, 'balance-sheet': balanceSheet, 'cash-flow': cashFlow,
    'trial-balance': trialBalance, 'ar-aging': (o) => agingReport('ar-aging', 'Receivables Aging', 'customer', o),
    'ap-aging': (o) => agingReport('ap-aging', 'Payables Aging', 'vendor', o),
    'inventory-valuation': inventoryValuation, 'sales-analysis': salesAnalysis,
    approvals: approvalsReport, integrity: integrityReport, audit: auditReport,
  };
  return renderers[id]({ go, route });
}

function indexView(go) {
  const groups = {};
  for (const r of CATALOGUE) {
    if (!store.can(r.perm)) continue;
    (groups[r.group] ||= []).push(r);
  }
  return h('div.page',
    h('div.page-head', h('div.titles', h('h1', 'Reports'),
      h('div.page-sub', 'Everything reads live from the ledger — no overnight batch, no stale extract.'))),
    ...Object.entries(groups).map(([group, items]) => h('div', { style: { marginBottom: '20px' } },
      h('h3', { style: { textTransform: 'uppercase', fontSize: '11.5px', letterSpacing: '.05em', color: 'var(--text-faint)', marginBottom: '8px' } }, group),
      h('div.kpi-grid', ...items.map((r) => h('div.kpi.linked', { onclick: () => go(`/reports/${r.id}`) },
        h('div', { style: { fontWeight: 600, fontSize: '13.5px' } }, r.name),
        h('div.muted', { style: { fontSize: '12px', marginTop: '4px', lineHeight: 1.45 } }, r.desc)))))));
}

// ------------------------------------------------------------- controls
function controlBar({ from, to, asOf, onChange, extra = [], onPrint = true, exportFn = null }) {
  const bits = [];
  if (from) bits.push(h('span.muted', { style: { fontSize: '12px' } }, 'From'), from);
  if (to) bits.push(h('span.muted', { style: { fontSize: '12px' } }, 'to'), to);
  if (asOf) bits.push(h('span.muted', { style: { fontSize: '12px' } }, 'As at'), asOf);
  for (const el of [from, to, asOf]) el?.addEventListener('change', onChange);
  return h('div.toolbar.no-print', ...bits, ...extra,
    h('div.spacer'),
    exportFn && h('div.row', { style: { gap: '4px' } },
      h('button.btn.sm', { onclick: () => exportFn('csv') }, icon('download', { size: 13 }), 'CSV'),
      h('button.btn.sm', { onclick: () => exportFn('pdf') }, 'PDF')),
    onPrint && h('button.btn.sm', { onclick: () => window.print() }, icon('printer', { size: 13 }), 'Print'));
}

const dateInput = (value) => h('input', { type: 'date', value });

/**
 * Which set of books a statement is for.
 *
 * Absent entirely when there is only the primary one, which is every company
 * that has never asked for a second — a control that offers a single choice
 * is just clutter with a label on it.
 */
function bookPicker(onChange) {
  const all = store.state.meta.books || [];
  if (all.length < 2) return { el: null, value: () => undefined };
  const sel = h('select', { style: { minWidth: '120px' } },
    ...all.map((b) => h('option', { value: b.id, selected: !!b.is_primary },
      b.is_primary ? `${b.name} (the ledger)` : b.name)));
  sel.addEventListener('change', onChange);
  return {
    el: [h('span.muted', { style: { fontSize: '12px' } }, 'Book'), sel],
    value: () => (all.find((b) => b.id === sel.value)?.is_primary ? undefined : sel.value),
    label: () => all.find((b) => b.id === sel.value)?.name || '',
  };
}

function reportPage(title, subtitle, controls, host, actions) {
  return h('div.page',
    h('div.page-head',
      h('div.titles',
        h('div.breadcrumb.no-print', h('a', { href: '#/reports', onclick: (e) => { e.preventDefault(); window.__meridianGo('/reports'); } }, 'Reports')),
        h('h1', title), h('div.page-sub', subtitle)),
      actions && h('div.page-actions.no-print', actions)),
    h('div.card', controls, host));
}

/** Two-column statement row. */
const line = (label, value, cls = '', indent = 0) => h('tr', { class: cls },
  h('td', { class: indent ? 'indent-1' : '' }, label),
  h('td.num', value));

// ---------------------------------------------------- income statement
async function incomeStatement({ go }) {
  const from = dateInput(fmt.startOfMonth(fmt.addMonths(fmt.today(), -2)));
  const to = dateInput(fmt.today());
  const compare = h('input', { type: 'checkbox', checked: true });
  const host = h('div');
  const book = bookPicker(() => load());

  async function load() {
    mount(host, loading());
    const days = Math.max(1, Math.round((Date.parse(to.value) - Date.parse(from.value)) / 86400000));
    const params = {
      from: from.value, to: to.value,
      subsidiary_id: store.state.subsidiary || undefined,
      book_id: book.value(),
    };
    if (compare.checked) {
      params.compare_from = fmt.addDays(from.value, -(days + 1));
      params.compare_to = fmt.addDays(from.value, -1);
    }
    const r = await API.report('income-statement', params);
    const cmp = !!r.compare_period;
    const cols = cmp ? 4 : 2;

    const sectionRows = (title, sec, negate = false) => [
      h('tr.section-head', h('td', { colspan: cols }, title)),
      ...sec.items.map((i) => h('tr',
        h('td.indent-1', h('a', {
          href: `#/account/${i.account_id}`,
          onclick: (e) => { e.preventDefault(); go(`/account/${i.account_id}`); },
        }, h('span.mono', i.number), ' ', i.name)),
        h('td.num', fmt.money(i.amount)),
        cmp && h('td.num.muted', fmt.money(i.compare)),
        cmp && h('td.num', varianceCell(i.amount, i.compare, negate)))),
      h('tr.total', h('td', `Total ${title.toLowerCase()}`),
        h('td.num', fmt.money(sec.total)),
        cmp && h('td.num.muted', fmt.money(sec.compare_total)),
        cmp && h('td.num', varianceCell(sec.total, sec.compare_total, negate))),
    ];

    const totalRow = (label, value, compareValue, cls) => h('tr', { class: cls },
      h('td', h('strong', label)),
      h('td.num', h('strong', fmt.money(value))),
      cmp && h('td.num.muted', fmt.money(compareValue)),
      cmp && h('td.num', varianceCell(value, compareValue)));

    mount(host,
      h('div.grid-wrap', h('table.grid.stmt',
        h('thead', h('tr',
          h('th', 'Account'),
          h('th.num', `${fmt.date(r.period.from)} – ${fmt.date(r.period.to)}`),
          cmp && h('th.num', `${fmt.date(r.compare_period.from)} – ${fmt.date(r.compare_period.to)}`),
          cmp && h('th.num', 'Variance'))),
        h('tbody',
          ...sectionRows('Revenue', r.revenue),
          ...sectionRows('Cost of sales', r.cogs, true),
          totalRow('Gross profit', r.gross_profit, r.compare?.gross_profit, 'total'),
          ...sectionRows('Operating expenses', r.opex, true),
          totalRow('Operating income', r.operating_income, r.compare?.operating_income, 'total'),
          ...(r.other_income.items.length ? sectionRows('Other income', r.other_income) : []),
          ...(r.other_expense.items.length ? sectionRows('Other expense', r.other_expense, true) : []),
          totalRow('Net income', r.net_income, r.compare?.net_income, 'grand')))),
      h('div.card-body', { style: { borderTop: '1px solid var(--border)' } },
        h('div.kpi-grid',
          metric('Gross margin', fmt.pct(r.gross_margin_pct)),
          metric('Operating margin', fmt.pct(r.operating_margin_pct)),
          metric('Net margin', fmt.pct(r.net_margin_pct)),
          metric('Revenue', fmt.money(r.revenue.total)))));
  }

  compare.addEventListener('change', load);
  await load();
  return reportPage('Income Statement', 'Profit and loss for the selected period',
    controlBar({
      from, to, onChange: load,
      exportFn: (format) => API.exportPack(format).catch(notifyError),
      extra: [
        ...(book.el || []),
        h('label', { style: { display: 'flex', gap: '5px', alignItems: 'center', fontSize: '12.5px' } }, compare, 'Compare to prior period'),
      ],
    }), host);
}

const metric = (label, value) => h('div.kpi', h('div.k-label', label), h('div.k-value.sm', value));

function varianceCell(current, prior, negateGood = false) {
  if (prior === null || prior === undefined) return h('span.faint', '—');
  const diff = current - prior;
  if (diff === 0) return h('span.faint', '—');
  // For cost lines, a fall is favourable, so the colour is inverted.
  const good = negateGood ? diff < 0 : diff > 0;
  const pctChange = prior ? (diff / Math.abs(prior)) * 100 : null;
  return h('span', { class: good ? 'num-pos' : 'num-neg' },
    `${diff > 0 ? '+' : '−'}${fmt.money(Math.abs(diff))}`,
    pctChange !== null ? h('span.muted', { style: { fontSize: '11px' } }, ` (${pctChange > 0 ? '+' : ''}${pctChange.toFixed(0)}%)`) : null);
}

// ------------------------------------------------------- balance sheet
async function balanceSheet({ go }) {
  const asOf = dateInput(fmt.today());
  const host = h('div');
  const book = bookPicker(() => load());

  async function load() {
    mount(host, loading());
    const r = await API.report('balance-sheet', {
      as_of: asOf.value, subsidiary_id: store.state.subsidiary || undefined, book_id: book.value(),
    });
    const sec = (title, s, extraRows = [], total = s.total) => [
      h('tr.section-head', h('td', { colspan: 2 }, title)),
      ...s.items.map((i) => h('tr',
        h('td.indent-1', h('a', { href: `#/account/${i.account_id}`, onclick: (e) => { e.preventDefault(); go(`/account/${i.account_id}`); } }, h('span.mono', i.number), ' ', i.name)),
        h('td.num', fmt.money(i.amount)))),
      ...extraRows,
      h('tr.total', h('td', `Total ${title.toLowerCase()}`), h('td.num', fmt.money(total))),
    ];

    mount(host,
      h('div.grid-wrap', h('table.grid.stmt',
        h('thead', h('tr', h('th', 'Account'), h('th.num', { style: { width: '190px' } }, `As at ${fmt.date(r.as_of)}`))),
        h('tbody',
          ...sec('Current assets', r.current_assets),
          ...(r.fixed_assets.items.length ? sec('Non-current assets', r.fixed_assets) : []),
          h('tr.grand', h('td', h('strong', 'Total assets')), h('td.num', h('strong', fmt.money(r.total_assets)))),
          ...sec('Current liabilities', r.current_liabilities),
          ...(r.long_term_liabilities.items.length ? sec('Non-current liabilities', r.long_term_liabilities) : []),
          h('tr.total', h('td', h('strong', 'Total liabilities')), h('td.num', h('strong', fmt.money(r.total_liabilities)))),
          ...sec('Equity', r.equity, [
            // Profit sits in equity from the day it is earned. Until a year is
            // formally closed no account holds it, so it is shown on its own
            // two lines rather than quietly folded into the total.
            r.equity.retained_earnings_prior_years
              ? h('tr', h('td.indent-1', 'Retained earnings (prior years)'), h('td.num', fmt.money(r.equity.retained_earnings_prior_years)))
              : null,
            h('tr', h('td.indent-1', 'Current year earnings'), h('td.num', fmt.money(r.equity.current_year_earnings))),
          ].filter(Boolean), r.equity.total),
          h('tr.grand', h('td', h('strong', 'Total liabilities and equity')), h('td.num', h('strong', fmt.money(r.total_liabilities_and_equity))))))),
      h('div.card-body', { style: { borderTop: '1px solid var(--border)' } },
        h('div.kpi-grid',
          metric('Working capital', fmt.money(r.working_capital)),
          metric('Current ratio', r.current_ratio === null ? '—' : r.current_ratio.toFixed(2)),
          metric('Balanced', r.balanced ? h('span.tag.green', 'Yes') : h('span.tag.red', fmt.money(r.out_of_balance) + ' out')))));
  }

  await load();
  return reportPage('Balance Sheet', 'Financial position as at a date',
    controlBar({ asOf, onChange: load, exportFn: (format) => API.exportPack(format).catch(notifyError), extra: book.el || [] }), host);
}

// ----------------------------------------------------------- cash flow
async function cashFlow() {
  const from = dateInput(fmt.startOfMonth(fmt.addMonths(fmt.today(), -2)));
  const to = dateInput(fmt.today());
  const host = h('div');

  async function load() {
    mount(host, loading());
    const r = await API.report('cash-flow', { from: from.value, to: to.value, subsidiary_id: store.state.subsidiary || undefined });
    const group = (title, items, total) => [
      h('tr.section-head', h('td', { colspan: 2 }, title)),
      ...items.map((i) => h('tr', h('td.indent-1', h('span.mono', i.number), ' ', i.name), h('td.num', fmt.money(i.amount)))),
      h('tr.total', h('td', `Net cash from ${title.toLowerCase()}`), h('td.num', fmt.money(total))),
    ];
    mount(host,
      h('div.grid-wrap', h('table.grid.stmt',
        h('thead', h('tr', h('th', ''), h('th.num', { style: { width: '190px' } }, `${fmt.date(r.period.from)} – ${fmt.date(r.period.to)}`))),
        h('tbody',
          h('tr.section-head', h('td', { colspan: 2 }, 'Operating activities')),
          h('tr', h('td.indent-1', 'Net income'), h('td.num', fmt.money(r.net_income))),
          ...r.operating_adjustments.map((i) => h('tr', h('td.indent-1', h('span.mono', i.number), ' ', i.name), h('td.num', fmt.money(i.amount)))),
          h('tr.total', h('td', 'Net cash from operating activities'), h('td.num', fmt.money(r.operating_cash_flow))),
          ...(r.investing_items.length ? group('Investing activities', r.investing_items, r.investing_cash_flow) : []),
          ...(r.financing_items.length ? group('Financing activities', r.financing_items, r.financing_cash_flow) : []),
          h('tr.grand', h('td', h('strong', 'Net change in cash')), h('td.num', h('strong', fmt.money(r.net_change_in_cash)))),
          h('tr', h('td', 'Cash at start of period'), h('td.num', fmt.money(r.opening_cash))),
          h('tr.total', h('td', h('strong', 'Cash at end of period')), h('td.num', h('strong', fmt.money(r.closing_cash))))))),
      !r.reconciles ? h('div.card-body', { style: { borderTop: '1px solid var(--border)' } },
        h('div.tag.amber', 'The classified movement does not tie to the bank movement. Check that every balance-sheet account has a cash-flow category set.')) : null);
  }

  await load();
  return reportPage('Cash Flow', 'Indirect method', controlBar({ from, to, onChange: load, exportFn: (format) => API.exportPack(format).catch(notifyError) }), host);
}

// ------------------------------------------------------- trial balance
async function trialBalance({ go }) {
  const to = dateInput(fmt.today());
  const host = h('div');
  const book = bookPicker(() => load());
  async function load() {
    mount(host, loading());
    const r = await API.report('trial-balance', {
      to: to.value, subsidiary_id: store.state.subsidiary || undefined, book_id: book.value(),
    });
    mount(host,
      h('div.grid-wrap', h('table.grid',
        h('thead', h('tr', h('th', 'Account'), h('th', 'Name'), h('th', 'Type'), h('th.num', 'Debit'), h('th.num', 'Credit'))),
        h('tbody', ...r.lines.map((l) => h('tr.clickable', { onclick: () => go(`/account/${l.account_id}`) },
          h('td', h('span.mono', l.number)),
          h('td', l.name),
          h('td.muted', fmt.titleCase(l.type)),
          h('td.num', l.debit ? fmt.money(l.debit) : ''),
          h('td.num', l.credit ? fmt.money(l.credit) : '')))),
        h('tfoot', h('tr',
          h('td', { colspan: 3 }, r.balanced ? h('span.tag.green', 'In balance') : h('span.tag.red', `Out by ${fmt.money(Math.abs(r.out_of_balance))}`)),
          h('td.num', fmt.money(r.total_debit)),
          h('td.num', fmt.money(r.total_credit)))))));
  }
  await load();
  return reportPage('Trial Balance', 'Every account carrying a balance',
    controlBar({ asOf: to, onChange: load, exportFn: (format) => API.exportPack(format).catch(notifyError), extra: book.el || [] }), host);
}

// ---------------------------------------------------------------- aging
async function agingReport(endpoint, title, entityType, { go }) {
  const asOf = dateInput(fmt.today());
  const host = h('div');
  async function load() {
    mount(host, loading());
    const r = await API.report(endpoint, { as_of: asOf.value, subsidiary_id: store.state.subsidiary || undefined });
    if (!r.entities.length) { mount(host, empty('Nothing outstanding', 'Every document in this ledger is settled.')); return; }
    const segs = r.bucket_labels.map((label, i) => ({ label, value: r.bucket_totals[i] }));
    mount(host,
      h('div.card-body', { style: { borderBottom: '1px solid var(--border)' } },
        stackedBar(segs), legend(segs),
        h('div.row', { style: { marginTop: '10px', gap: '24px' } },
          h('div', h('div.muted', { style: { fontSize: '11px' } }, 'TOTAL OUTSTANDING'), h('div', { style: { fontSize: '17px', fontWeight: 600 } }, fmt.money(r.total))),
          h('div', h('div.muted', { style: { fontSize: '11px' } }, 'OVERDUE'), h('div', { style: { fontSize: '17px', fontWeight: 600 }, class: r.overdue_pct > 25 ? 'num-neg' : '' }, `${fmt.money(r.overdue_total)} (${fmt.pct(r.overdue_pct)})`)),
          h('div', h('div.muted', { style: { fontSize: '11px' } }, 'DOCUMENTS'), h('div', { style: { fontSize: '17px', fontWeight: 600 } }, String(r.document_count))))),
      h('div.grid-wrap', h('table.grid',
        h('thead', h('tr', h('th', fmt.titleCase(entityType)), ...r.bucket_labels.map((l) => h('th.num', l)), h('th.num', 'Total'))),
        h('tbody', ...r.entities.flatMap((e) => [
          h('tr.clickable', {
            onclick: () => { const open = host.querySelectorAll(`tr[data-parent="${e.entity_id}"]`); open.forEach((x) => x.classList.toggle('hidden')); },
          },
            h('td', h('strong', e.entity_name), ' ', h('span.faint', e.entity_no)),
            ...e.buckets.map((b, i) => h('td.num', { class: i > 0 && b ? 'num-neg' : '' }, b ? fmt.money(b) : h('span.faint', '—'))),
            h('td.num', h('strong', fmt.money(e.total)))),
          ...e.documents.map((d) => h('tr.hidden', { dataset: { parent: e.entity_id }, class: 'clickable', onclick: () => go(`/txn/${d.id}`) },
            h('td', { style: { paddingLeft: '24px' } }, h('span.mono', d.txn_no), ' ', h('span.muted', `due ${fmt.date(d.due_date)}`), d.days_overdue ? h('span.tag.red', { style: { marginLeft: '6px' } }, `${d.days_overdue}d`) : null),
            ...r.bucket_labels.map((_, i) => h('td.num.muted', i === d.bucket ? fmt.money(d.amount_remaining) : '')),
            h('td.num.muted', fmt.money(d.amount_remaining)))),
        ])),
        h('tfoot', h('tr', h('td', 'Total'),
          ...r.bucket_totals.map((b) => h('td.num', fmt.money(b))),
          h('td.num', fmt.money(r.total)))))));
  }
  await load();
  return reportPage(title, 'Click a row to reveal the underlying documents',
    controlBar({ asOf, onChange: load, exportFn: (format) => API.exportFile(entityType === 'customer' ? 'invoice' : 'vendor_bill', format).catch(notifyError) }), host);
}

// --------------------------------------------------- inventory valuation
async function inventoryValuation({ go }) {
  const asOf = dateInput(fmt.today());
  const host = h('div');
  async function load() {
    mount(host, loading());
    const r = await API.valuation({ as_of: asOf.value, location_id: store.state.subsidiary ? undefined : undefined });
    if (!r.rows.length) { mount(host, empty('No stock on hand', 'Receive inventory to see a valuation.')); return; }
    mount(host,
      h('div.grid-wrap', h('table.grid',
        h('thead', h('tr', h('th', 'SKU'), h('th', 'Item'), h('th', 'Category'), h('th', 'Location'), h('th.num', 'On hand'), h('th.num', 'Avg cost'), h('th.num', 'Value'))),
        h('tbody', ...r.rows.map((x) => h('tr.clickable', { onclick: () => go(`/record/item/${x.item_id}`) },
          h('td', h('span.mono', x.sku)),
          h('td', x.item_name),
          h('td.muted', x.category || '—'),
          h('td.muted', x.location_name),
          h('td.num', fmt.qty(x.qty_on_hand)),
          h('td.num', fmt.money(x.avg_cost)),
          h('td.num', h('strong', fmt.money(x.total_value)))))),
        h('tfoot', h('tr', h('td', { colspan: 4 }, `${r.rows.length} positions`),
          h('td.num', fmt.qty(r.total_qty)), h('td', ''), h('td.num', fmt.money(r.total_value)))))));
  }
  await load();
  return reportPage('Inventory Valuation', 'On-hand stock at moving-average cost', controlBar({ asOf, onChange: load, exportFn: (format) => API.exportFile('item', format).catch(notifyError) }), host);
}

// ------------------------------------------------------- sales analysis
async function salesAnalysis({ go }) {
  const [trend, customers, items] = await Promise.all([
    API.report('revenue-trend', { months: 12 }),
    API.report('top-customers', { limit: 15, days: 365 }),
    API.report('top-items', { limit: 15, days: 365 }),
  ]);
  const host = h('div.card-body',
    h('h3', { style: { marginBottom: '8px' } }, 'Revenue, last 12 months'),
    lineChart(trend.months.map((m) => ({ label: fmt.monthLabel(m.month), value: m.revenue })), { height: 200 }),
    h('div.split', { style: { marginTop: '18px' } },
      h('div',
        h('h3', { style: { marginBottom: '8px' } }, 'Top customers'),
        h('table.grid.compact',
          h('thead', h('tr', h('th', 'Customer'), h('th.num', 'Invoices'), h('th.num', 'Revenue'))),
          h('tbody', ...customers.rows.map((c) => h('tr.clickable', { onclick: () => go(`/record/customer/${c.id}`) },
            h('td', c.name), h('td.num.muted', String(c.orders)), h('td.num', fmt.money(c.revenue, c.currency))))))),
      h('div',
        h('h3', { style: { marginBottom: '8px' } }, 'Best sellers'),
        h('table.grid.compact',
          h('thead', h('tr', h('th', 'Item'), h('th.num', 'Units'), h('th.num', 'Revenue'))),
          h('tbody', ...items.rows.map((i) => h('tr.clickable', { onclick: () => go(`/record/item/${i.id}`) },
            h('td', h('span.mono', i.sku), ' ', i.name), h('td.num.muted', fmt.qty(i.qty_sold)), h('td.num', fmt.money(i.revenue)))))))));
  return reportPage('Sales Analysis', 'Trailing twelve months', h('div'), host);
}

// ------------------------------------------------------------ approvals
async function approvalsReport({ go }) {
  const { rows } = await API.drilldown('pending_approvals');
  const host = rows.length
    ? h('div.grid-wrap', h('table.grid',
      h('thead', h('tr', h('th', 'Document'), h('th', 'Type'), h('th', 'Entity'), h('th', 'Date'), h('th.num', 'Total'), h('th', ''))),
      h('tbody', ...rows.map((t) => h('tr.clickable', { onclick: () => go(`/txn/${t.id}`) },
        h('td', h('span.mono', t.txn_no)),
        h('td.muted', fmt.titleCase(t.type.replace(/_/g, ' ').toLowerCase())),
        h('td', t.entity_name || '—'),
        h('td', fmt.date(t.txn_date)),
        h('td.num', fmt.money(t.total, t.currency)),
        h('td', { style: { textAlign: 'right' } }, h('button.btn.sm.primary', {
          onclick: async (e) => {
            e.stopPropagation();
            try { await API.approve(t.id, {}); toast(`${t.txn_no} approved`, { kind: 'success' }); window.__meridianGo('/reports/approvals'); location.reload(); }
            catch (err) { notifyError(err); }
          },
        }, 'Approve'))))))) 
    : empty('Nothing is waiting', 'Approval rules route documents here when they match. Set them up under Setup → Approval Rules.');
  return reportPage('Approval Queue', `${rows.length} document${rows.length === 1 ? '' : 's'} awaiting a decision`, h('div'), host);
}

async function integrityReport() {
  const r = await API.report('integrity');
  return reportPage('Ledger Integrity', `Checked ${fmt.dateTime(r.checked_at)}`, h('div'),
    h('div.card-body',
      h('div', { style: { marginBottom: '14px' } }, r.ok
        ? h('span.tag.green', icon('check', { size: 14 }), ' All checks passed')
        : h('span.tag.red', 'Attention needed')),
      facts([
        ['Total debits', fmt.money(r.ledger_total_debits)],
        ['Total credits', fmt.money(r.ledger_total_credits)],
        ['Ledger balanced', r.ledger_balanced ? h('span.tag.green', 'Yes') : h('span.tag.red', 'No')],
        ['Entries that do not balance', String(r.unbalanced_entries.length)],
        ['Rollup rows drifting from detail', String(r.rollup_drift.length)],
        ['Journal lines with no account', String(r.orphan_lines)],
      ]),
      h('div.muted', { style: { marginTop: '14px', fontSize: '12px', maxWidth: '640px', lineHeight: 1.55 } },
        'Meridian maintains a materialised balance per account and period so reports do not scan the journal. This check re-derives those balances from the underlying journal lines and compares them. A non-zero drift means the rollup and the detail disagree, which should never happen — rebuild the balances from Setup if it does.'),
      (r.subledgers || []).length ? h('div', { style: { marginTop: '20px' } },
        h('h3', { style: { fontSize: '13px', marginBottom: '6px' } }, 'Control accounts'),
        h('div.muted', { style: { fontSize: '12px', maxWidth: '640px', lineHeight: 1.55, marginBottom: '10px' } },
          'A ledger can balance perfectly and still be wrong. These compare each control account with the records that are supposed to explain it — the invoices behind receivables, the bills behind payables, the stock on the shelf behind inventory.'),
        h('table.grid.compact',
          h('thead', h('tr', h('th', 'Control account'), h('th', 'Explained by'),
            h('th.num', 'Ledger'), h('th.num', 'Subledger'), h('th.num', 'Difference'))),
          h('tbody', ...r.subledgers.map((sl) => h('tr',
            h('td', sl.account), h('td.muted', sl.explain),
            h('td.num', fmt.money(sl.control)), h('td.num', fmt.money(sl.subledger)),
            h('td.num', sl.difference === 0
              ? h('span.tag.green', 'Tied')
              : h('span.num-neg', fmt.money(sl.difference)))))))) : null,
      r.unbalanced_entries.length ? h('table.grid.compact', { style: { marginTop: '14px' } },
        h('thead', h('tr', h('th', 'Entry'), h('th', 'Date'), h('th.num', 'Debits'), h('th.num', 'Credits'))),
        h('tbody', ...r.unbalanced_entries.map((e) => h('tr',
          h('td', h('span.mono', e.entry_no)), h('td', fmt.date(e.txn_date)),
          h('td.num', fmt.money(e.d)), h('td.num', fmt.money(e.c)))))) : null));
}

// ---------------------------------------------------------------- audit
async function auditReport({ go }) {
  const from = dateInput(fmt.addDays(fmt.today(), -30));
  const to = dateInput(fmt.today());
  const financialOnly = h('input', { type: 'checkbox' });
  const actionSel = h('select', { style: { width: '140px' } },
    h('option', { value: '' }, 'Any action'),
    ...['create', 'update', 'delete', 'post', 'void', 'approve', 'reject', 'reverse', 'close', 'login', 'transform'].map((a) => h('option', { value: a }, fmt.titleCase(a))));
  const host = h('div');

  async function load() {
    mount(host, loading());
    const r = await API.audit({
      from: from.value, to: to.value, limit: 300,
      action: actionSel.value || undefined,
      financial: financialOnly.checked ? 'true' : undefined,
    });
    mount(host,
      h('div.grid-wrap', h('table.grid',
        h('thead', h('tr', h('th', 'When'), h('th', 'User'), h('th', 'Action'), h('th', 'Record'), h('th', 'Changes'), h('th', 'IP'))),
        h('tbody', ...r.rows.map((a) => h('tr', { class: a.record_id ? 'clickable' : '', onclick: () => a.record_id && openAudit(a, go) },
          h('td.nowrap', fmt.dateTime(a.at)),
          h('td', a.user_label || 'system'),
          h('td', h('span.tag', { class: a.financial ? 'amber' : '' }, fmt.titleCase(a.action))),
          h('td.muted', fmt.titleCase(a.record_type)),
          h('td', h('span.cell-truncate', changeText(a.changes))),
          h('td.faint.mono', { style: { fontSize: '11px' } }, a.ip || '—')))))),
      h('div.card-foot', `${fmt.num(r.total)} events in range`));
  }

  for (const el of [actionSel, financialOnly]) el.addEventListener('change', load);
  await load();
  return reportPage('Audit Trail', 'Every mutation, immutable and attributable',
    controlBar({
      from, to, onChange: load,
      exportFn: (format) => API.exportFile('audit_event', format).catch(notifyError),
      extra: [actionSel, h('label', { style: { display: 'flex', gap: '5px', alignItems: 'center', fontSize: '12.5px' } }, financialOnly, 'Financial only')],
    }), host);
}

const changeText = (changes) => Object.entries(changes || {})
  .filter(([k]) => k !== '__note')
  .slice(0, 3)
  .map(([k, v]) => `${fmt.titleCase(k)}: ${v.from ?? '—'} → ${v.to ?? '—'}`)
  .join('  ·  ') || '—';

function openAudit(a, go) {
  const target = a.record_type === 'journal_entry' ? `/journal/${a.record_id}`
    : ['invoice', 'sales_order', 'quote', 'purchase_order', 'vendor_bill', 'customer_payment', 'vendor_payment', 'fulfillment', 'item_receipt'].includes(a.record_type) ? `/txn/${a.record_id}`
      : `/record/${a.record_type}/${a.record_id}`;
  go(target);
}
