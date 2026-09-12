// Meridian ERP :: web/views/dashboard
// Role-aware KPI dashboard. Tiles are drag-reorderable and the layout is
// stored per user, so the first screen of the day is the one they arranged.
import { h, mount, clear } from '../dom.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import * as store from '../store.js';
import { empty, toast, notifyError, modal, statusTag, moneyCell } from '../ui.js';
import { icon } from '../icons.js';
import { barChart, lineChart, stackedBar, legend, donut, sparkline } from '../charts.js';
import { availableTours, completedTours, startTour, isTourDone } from '../tour.js';

/** Every widget the catalogue offers. `span` is in grid columns. */
const WIDGETS = {
  cash_balance: { title: 'Cash on hand', perm: 'account', span: 1, kpi: (d) => ({ value: fmt.moneyCompact(d.cash_balance), meta: `Working capital ${fmt.moneyCompact(d.working_capital)}`, link: '/bank' }) },
  revenue_mtd: { title: 'Revenue month to date', perm: 'invoice', span: 1, kpi: (d) => ({ value: fmt.moneyCompact(d.revenue_mtd), meta: changeMeta(d.revenue_change_pct, 'vs last month'), spark: d.revenue_trend?.map((m) => m.revenue) }) },
  gross_margin: { title: 'Gross margin', perm: 'account', span: 1, kpi: (d) => ({ value: fmt.pct(d.gross_margin_pct), meta: `Gross profit ${fmt.moneyCompact(d.gross_profit_mtd)} MTD` }) },
  net_income: { title: 'Net income MTD', perm: 'account', span: 1, kpi: (d) => ({ value: fmt.moneyCompact(d.net_income_mtd), meta: `Expenses ${fmt.moneyCompact(d.expenses_mtd)}` }) },
  ar_overdue: { title: 'Overdue receivables', perm: 'invoice', span: 1, kpi: (d) => ({ value: fmt.moneyCompact(d.ar_overdue), meta: `${fmt.pct(d.ar_overdue_pct)} of ${fmt.moneyCompact(d.ar_total)} open`, tone: d.ar_overdue_pct > 25 ? 'neg' : '', link: '/reports/ar-aging' }) },
  ap_due: { title: 'Payables outstanding', perm: 'vendor_bill', span: 1, kpi: (d) => ({ value: fmt.moneyCompact(d.ap_total), meta: `${fmt.moneyCompact(d.ap_overdue)} overdue`, link: '/reports/ap-aging' }) },
  dso: { title: 'Days sales outstanding', perm: 'invoice', span: 1, kpi: (d) => ({ value: d.dso === null ? '—' : `${d.dso} days`, meta: 'Trailing 90 days' }) },
  open_orders: { title: 'Open sales orders', perm: 'sales_order', span: 1, kpi: (d) => ({ value: String(d.open_orders_count), meta: fmt.moneyCompact(d.open_orders_value) + ' to fulfil', link: '/list/sales_order' }) },
  pipeline: { title: 'Open pipeline', perm: 'opportunity', span: 1, kpi: (d) => ({ value: fmt.moneyCompact(d.pipeline_value), meta: `${fmt.moneyCompact(d.weighted_pipeline)} weighted`, link: '/pipeline' }) },
  inventory: { title: 'Inventory value', perm: 'item', span: 1, kpi: (d) => ({ value: fmt.moneyCompact(d.inventory_value), meta: 'At moving average cost', link: '/inventory' }) },
  approvals: { title: 'Awaiting approval', perm: 'sales_order', span: 1, kpi: (d) => ({ value: String(d.pending_approvals), meta: d.pending_approvals ? 'Needs your attention' : 'All clear', tone: d.pending_approvals ? 'warn' : '', link: '/reports/approvals' }) },
  cases: { title: 'Open support cases', perm: 'support_case', span: 1, kpi: (d) => ({ value: String(d.open_cases), meta: 'Unresolved', link: '/list/support_case' }) },
  headcount: { title: 'Headcount', perm: 'employee', span: 1, kpi: (d) => ({ value: String(d.headcount), meta: 'Active employees', link: '/hr/directory' }) },
  current_ratio: { title: 'Current ratio', perm: 'account', span: 1, kpi: (d) => ({ value: d.current_ratio === null ? '—' : d.current_ratio.toFixed(2), meta: `Assets ${fmt.moneyCompact(d.total_assets)}` }) },

  revenue_trend: { title: 'Revenue, last 12 months', perm: 'invoice', span: 3, panel: revenueTrendPanel },
  ar_aging: { title: 'Receivables aging', perm: 'invoice', span: 2, panel: arAgingPanel },
  top_customers: { title: 'Top customers', perm: 'customer', span: 2, panel: topCustomersPanel },
  reorder: { title: 'Reorder alerts', perm: 'item', span: 2, panel: reorderPanel },
  approvals_list: { title: 'Approval queue', perm: 'sales_order', span: 2, panel: approvalsPanel },
  cases_list: { title: 'Support queue', perm: 'support_case', span: 2, panel: casesPanel },
};

const DEFAULT_LAYOUT = ['cash_balance', 'revenue_mtd', 'gross_margin', 'ar_overdue', 'open_orders', 'pipeline',
  'revenue_trend', 'ar_aging', 'top_customers', 'approvals_list', 'reorder', 'cases_list'];

const changeMeta = (pct, suffix) => {
  if (pct === null || pct === undefined) return suffix;
  const up = pct >= 0;
  return h('span',
    h('span', { class: up ? 'num-pos' : 'num-neg', style: { display: 'inline-flex', alignItems: 'center', gap: '2px' } },
      icon(up ? 'trending-up' : 'trending-down', { size: 13 }), `${Math.abs(pct).toFixed(1)}%`),
    ' ', h('span.muted', suffix));
};

export async function dashboardView(_r, { go }) {
  const [data, saved] = await Promise.all([
    API.dashboard(store.state.subsidiary ? { subsidiary_id: store.state.subsidiary } : {}),
    API.dashboardLayout().catch(() => ({ layout: null })),
  ]);

  let layout = (Array.isArray(saved?.layout) && saved.layout.length ? saved.layout : DEFAULT_LAYOUT)
    .filter((k) => WIDGETS[k] && store.can(WIDGETS[k].perm));
  if (!layout.length) layout = ['cash_balance'];

  const grid = h('div.kpi-grid', { dataset: { tour: 'dashboard-grid' } });
  const render = () => {
    clear(grid);
    layout.forEach((key, index) => {
      const w = WIDGETS[key];
      if (!w) return;
      const node = w.panel ? w.panel(data, go) : kpiTile(key, w, data, go);
      if (w.span >= 2) node.classList.add('widget');
      if (w.span >= 3) node.classList.add('wide');
      makeDraggable(node, index);
      grid.appendChild(node);
    });
  };

  let dragFrom = null;
  function makeDraggable(node, index) {
    node.draggable = true;
    node.addEventListener('dragstart', (e) => { dragFrom = index; node.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    node.addEventListener('dragend', () => { node.classList.remove('dragging'); grid.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target')); });
    node.addEventListener('dragover', (e) => { e.preventDefault(); node.classList.add('drop-target'); });
    node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
    node.addEventListener('drop', async (e) => {
      e.preventDefault();
      node.classList.remove('drop-target');
      if (dragFrom === null || dragFrom === index) return;
      const [moved] = layout.splice(dragFrom, 1);
      layout.splice(index, 0, moved);
      dragFrom = null;
      render();
      try { await API.saveDashboard(layout); } catch (err) { notifyError(err); }
    });
  }

  render();

  const onboarding = h('div', { style: { marginBottom: 'var(--s4)' } });
  const drawOnboarding = () => {
    clear(onboarding);
    const card = gettingStarted(go, drawOnboarding);
    if (card) onboarding.appendChild(card);
  };
  drawOnboarding();
  window.addEventListener('meridian:tour-progress', drawOnboarding);

  const el = h('div.page',
    h('div.page-head',
      h('div.titles',
        h('h1', greeting(), ', ', store.state.user.name.split(' ')[0]),
        h('div.page-sub', `${store.state.tenant.name} · ${fmt.date(data.period.today)}`)),
      h('div.page-actions',
        h('button.btn', { onclick: () => customise() }, icon('plus', { size: 14 }), 'Add widget'),
        h('button.btn', { onclick: () => window.__meridianGo('/reports') }, icon('bar-chart', { size: 14 }), 'Reports'))),
    onboarding,
    grid);

  function customise() {
    const available = Object.entries(WIDGETS).filter(([k, w]) => store.can(w.perm));
    const boxes = available.map(([k, w]) => {
      const cb = h('input', { type: 'checkbox', checked: layout.includes(k) });
      return { key: k, cb, el: h('label', cb, h('span', w.title)) };
    });
    modal({
      title: 'Dashboard widgets',
      body: h('div', h('div.muted', { style: { marginBottom: '10px' } }, 'Choose what appears on your home screen. Drag tiles to reorder them.'),
        h('div.col-picker', ...boxes.map((b) => b.el))),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Save layout', kind: 'primary',
          onClick: async () => {
            const chosen = boxes.filter((b) => b.cb.checked).map((b) => b.key);
            layout = [...layout.filter((k) => chosen.includes(k)), ...chosen.filter((k) => !layout.includes(k))];
            render();
            await API.saveDashboard(layout);
            toast('Dashboard saved', { kind: 'success' });
          },
        },
      ],
    });
  }

  return { el, cleanup: () => window.removeEventListener('meridian:tour-progress', drawOnboarding) };
}

/**
 * The panel that teaches, and then goes away.
 *
 * It is on the dashboard rather than behind a menu because the first screen of
 * the first morning is the only moment somebody is definitely looking. It
 * disappears on its own when the tours are done, and can be dismissed at any
 * point -- an onboarding banner that outstays its welcome is worse than none,
 * and the Learning centre keeps everything it offered.
 */
function gettingStarted(go, redraw) {
  if (store.getPref('onboarding.hidden', false)) return null;
  const tours = availableTours();
  if (!tours.length) return null;
  const done = completedTours();
  const remaining = tours.filter((t) => !done.includes(t.id));
  if (!remaining.length) return null;                       // finished: gone for good

  const pct = Math.round(((tours.length - remaining.length) / tours.length) * 100);
  return h('div.card.accent',
    h('div.card-head',
      h('h2', icon('graduation-cap', { size: 15 }), 'Getting started'),
      h('div.actions',
        h('span.muted', { style: { fontSize: 'var(--t-sm)' } }, `${tours.length - remaining.length} of ${tours.length}`),
        h('button.btn.sm', { onclick: () => go('/learn') }, 'Learning centre'),
        h('button.btn.sm.ghost', {
          title: 'Hide this panel',
          onclick: () => { store.setPref('onboarding.hidden', true); redraw(); },
        }, icon('x', { size: 13 })))),
    h('div.card-body',
      h('div.progress', { style: { marginBottom: 'var(--s3)' } }, h('i', { style: { width: `${pct}%` } })),
      h('div.checklist', ...tours.map((t) => h('button.check-row', {
        class: isTourDone(t.id) ? 'done' : '',
        onclick: () => startTour(t.id),
      },
        h('span.check-mark', icon('check', { size: 11, strokeWidth: 2.6 })),
        h('span', { style: { minWidth: 0 } },
          h('div.check-title', t.title),
          h('div.check-sub', `${t.minutes} min · ${t.blurb}`)),
        icon('chevron-right', { size: 15, className: 'go' }))))));
}

const greeting = () => {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
};

function kpiTile(key, w, data, go) {
  const k = w.kpi(data);
  const tile = h('div.kpi', { class: k.link ? 'linked' : '', onclick: k.link ? () => go(k.link) : null },
    h('div.drag', { title: 'Drag to rearrange' }, icon('grip', { size: 13 })),
    h('div.k-label', w.title),
    h('div.k-value', { class: k.tone === 'neg' ? 'num-neg' : k.tone === 'warn' ? '' : '' }, k.value),
    h('div.k-meta', k.meta),
    k.spark && h('div', { style: { marginTop: '6px', color: 'var(--accent)' } }, sparkline(k.spark)));
  if (k.tone === 'warn') tile.querySelector('.k-value').style.color = 'var(--warn)';
  return tile;
}

const panel = (title, actions, body) => h('div.card',
  h('div.card-head', h('div.drag', { title: 'Drag to rearrange', style: { position: 'static', marginRight: '2px' } }, icon('grip', { size: 13 })), h('h2', title), actions && h('div.actions', actions)),
  body);

function revenueTrendPanel(data) {
  const rows = data.revenue_trend || [];
  return panel('Revenue, last 12 months',
    h('span.muted', { style: { fontSize: '12px' } }, `${fmt.money(rows.reduce((a, r) => a + r.revenue, 0))} total`),
    h('div.card-body', lineChart(rows.map((m) => ({ label: fmt.monthLabel(m.month), value: m.revenue })), { height: 190 })));
}

function arAgingPanel(data) {
  const buckets = data.ar_buckets || [];
  return panel('Receivables aging', null,
    h('div.card-body',
      stackedBar(buckets.map((b) => ({ label: b.label, value: b.value }))),
      legend(buckets.map((b) => ({ label: b.label, value: b.value }))),
      h('div.row', { style: { marginTop: '12px', justifyContent: 'space-between' } },
        h('span.muted', 'Total outstanding'),
        h('strong', fmt.money(data.ar_total)))));
}

function topCustomersPanel(data, go) {
  const rows = data.top_customers || [];
  return panel('Top customers, last 12 months', null,
    rows.length ? h('div.grid-wrap', h('table.grid.compact',
      h('tbody', ...rows.map((r) => h('tr.clickable', { onclick: () => go(`/record/customer/${r.id}`) },
        h('td', r.name),
        h('td.num.muted', `${r.orders} inv`),
        h('td.num', fmt.money(r.revenue, r.currency))))))) : h('div.card-body', h('div.muted', 'No invoiced revenue yet.')));
}

function reorderPanel(data, go) {
  const body = h('div.card-body', h('span.spinner'));
  const card = panel('Reorder alerts', h('button.btn.sm', { onclick: () => go('/inventory') }, 'Open'), body);
  API.reorder().then(({ suggestions }) => {
    if (!suggestions.length) { mount(body, h('div.muted', 'Every stocked item is above its reorder point.')); return; }
    mount(body);
    body.classList.add('flush');
    body.appendChild(h('div.grid-wrap', h('table.grid.compact',
      h('tbody', ...suggestions.slice(0, 7).map((s) => h('tr.clickable', { onclick: () => go(`/record/item/${s.item_id}`) },
        h('td', h('span.tag', { class: s.severity === 'stockout' ? 'red' : s.severity === 'critical' ? 'amber' : '' }, s.severity === 'stockout' ? 'Out' : s.severity === 'critical' ? 'Critical' : 'Low')),
        h('td', h('span.mono', s.sku)),
        h('td.muted', s.location_code),
        h('td.num', fmt.qty(s.qty_available), ' left'),
        h('td.num', h('strong', 'order ', fmt.qty(s.suggested_qty)))))))));
  }).catch(() => mount(body, h('div.muted', 'Could not load reorder data.')));
  return card;
}

function approvalsPanel(data, go) {
  const body = h('div.card-body', h('span.spinner'));
  const card = panel('Approval queue', null, body);
  API.drilldown('pending_approvals').then(({ rows }) => {
    if (!rows.length) { mount(body, h('div.muted', 'Nothing is waiting for approval.')); return; }
    mount(body);
    body.classList.add('flush');
    body.appendChild(h('div.grid-wrap', h('table.grid.compact',
      h('tbody', ...rows.slice(0, 7).map((t) => h('tr.clickable', { onclick: () => go(`/txn/${t.id}`) },
        h('td', h('span.mono', t.txn_no)),
        h('td', t.entity_name || '—'),
        h('td.num', fmt.money(t.total, t.currency)),
        h('td', h('span.tag.amber', 'Pending'))))))));
  }).catch(() => mount(body, h('div.muted', '—')));
  return card;
}

function casesPanel(data, go) {
  const body = h('div.card-body', h('span.spinner'));
  const card = panel('Support queue', h('button.btn.sm', { onclick: () => go('/list/support_case') }, 'All cases'), body);
  API.supportMetrics().then((m) => {
    mount(body,
      h('div.row', { style: { gap: '20px', flexWrap: 'wrap' } },
        donut(Object.entries(m.by_priority).map(([label, value]) => ({ label: fmt.titleCase(label), value })),
          { size: 118, centre: { value: String(m.open_count), label: 'open' } }),
        h('dl.facts', { style: { flex: 1, minWidth: '170px' } },
          h('dt', 'SLA breached'), h('dd', { class: m.sla_breached ? 'num-neg' : '' }, String(m.sla_breached)),
          h('dt', 'Unassigned'), h('dd', String(m.unassigned)),
          h('dt', 'Resolved (30d)'), h('dd', String(m.resolved_last_30)),
          h('dt', 'Avg resolution'), h('dd', m.avg_resolution_hours ? `${m.avg_resolution_hours} h` : '—'),
          h('dt', 'Oldest open'), h('dd', `${m.oldest_open_days} d`))));
  }).catch(() => mount(body, h('div.muted', '—')));
  return card;
}

export async function notFoundView() {
  return h('div.page', empty('Page not found', 'That address does not match anything in Meridian.',
    h('div.row', { style: { justifyContent: 'center' } },
      h('button.btn.primary', { onclick: () => window.__meridianGo('/') }, 'Back to dashboard'),
      h('button.btn', { onclick: () => window.__meridianGo('/learn') }, 'Learning centre')),
    'search'));
}
