// Meridian ERP :: web/views/projects
// The project portfolio: what every engagement is costing, what it has earned
// and who is booked on it. Margin is the number people come here for, so it
// leads.
import { h, mount } from '../dom.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import * as store from '../store.js';
import { empty, notifyError, notifyOk, confirm, statusTag, loading } from '../ui.js';

// The ops endpoints report money in major units, not the minor units the
// record API uses, so it has to be scaled back before formatting.
const cash = (v) => fmt.money(Math.round((Number(v) || 0) * 100));
const pct = (v) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(1)}%`);

export async function projectsView(_route, { go }) {
  const statusSel = h('select', { style: { width: '160px' } },
    h('option', { value: '' }, 'All projects'),
    ...['planned', 'active', 'on_hold', 'completed', 'cancelled'].map((s) =>
      h('option', { value: s }, fmt.titleCase(s))));

  const host = h('div');

  async function load() {
    mount(host, loading('Working out where every project stands'));
    try {
      const [portfolio, util] = await Promise.all([
        API.projectPortfolio(statusSel.value || undefined),
        API.projectUtilisation(),
      ]);
      render(portfolio, util);
    } catch (e) { mount(host, empty('Could not load the portfolio', e.message)); }
  }
  statusSel.addEventListener('change', load);

  function render({ projects, totals }, util) {
    if (!projects.length) {
      mount(host, empty('No projects yet',
        'Create a project to track its budget, time, expenses and margin.',
        h('button.btn.primary', { onclick: () => go('/new/project') }, 'New project')));
      return;
    }

    const kpis = h('div.kpi-grid', { style: { marginBottom: '14px' } },
      h('div.kpi', h('div.k-label', 'Recognised revenue'), h('div.k-value', cash(totals.revenue)),
        h('div.k-meta', `${totals.count} project${totals.count === 1 ? '' : 's'}`)),
      h('div.kpi', h('div.k-label', 'Cost to date'), h('div.k-value', cash(totals.cost))),
      h('div.kpi', h('div.k-label', 'Margin'),
        h('div.k-value', { class: totals.margin < 0 ? 'num-neg' : '' }, cash(totals.margin)),
        h('div.k-meta', totals.revenue ? `${((totals.margin / totals.revenue) * 100).toFixed(1)}% of revenue` : '—')),
      h('div.kpi', h('div.k-label', 'Over budget'),
        h('div.k-value', { class: totals.over_budget ? 'num-neg' : '' }, String(totals.over_budget)),
        h('div.k-meta', 'Projects past their budget')));

    // Sorted worst-margin-first by the server: the ones that need attention.
    const rows = projects.map((p) => h('tr.clickable',
      { onclick: () => go(`/record/project/${p.project.id}`) },
      h('td', h('strong', p.project.project_no)),
      h('td', p.project.name),
      h('td', h('span.tag', fmt.titleCase(p.project.billing_type || '—'))),
      h('td', progressBar(p.project.percent_complete)),
      h('td.num', fmt.num(p.hours, 1)),
      h('td.num', cash(p.total_cost)),
      h('td.num', cash(p.recognised_revenue)),
      h('td.num', { class: p.margin < 0 ? 'num-neg' : 'num-pos' }, cash(p.margin)),
      h('td.num', { class: p.margin_pct !== null && p.margin_pct < 0 ? 'num-neg' : '' }, pct(p.margin_pct)),
      h('td.num', p.unbilled_value > 0
        ? h('a', {
          href: '#', title: 'Bill the time and expenses that have not been invoiced',
          onclick: async (e) => { e.preventDefault(); e.stopPropagation(); await billProject(p); },
        }, cash(p.unbilled_value))
        : h('span.faint', '—')),
      h('td', budgetCell(p))));

    async function billProject(p) {
      const ok = await confirm({
        title: `Bill ${cash(p.unbilled_value)} on ${p.project.project_no}?`,
        message: 'An invoice is raised for the unbilled time, expenses and milestones on this project.',
        confirmLabel: 'Create invoice',
      });
      if (!ok) return;
      try {
        const res = await API.billProject(p.project.id);
        notifyOk(`Invoice ${res.invoice?.txn_no || ''} raised.`, 'Project billed');
        load();
      } catch (e) { notifyError(e); }
    }

    const utilRows = (util.rows || []).map((r) => h('tr',
      h('td', r.name),
      h('td.num', fmt.num(r.booked_hours_per_week, 1)),
      h('td.num', fmt.num(r.capacity_hours_per_week, 1)),
      h('td.num', { class: r.over_allocated ? 'num-neg' : '' }, pct(r.utilisation_pct)),
      h('td', h('div.bar', h('div.bar-fill', {
        class: r.over_allocated ? 'over' : '',
        style: { width: `${Math.min(100, Number(r.utilisation_pct) || 0)}%` },
      })))));

    mount(host, kpis,
      h('div.card',
        h('div.card-head', h('h2', 'Portfolio'),
          h('span.muted', { style: { fontSize: '12px' } }, 'Thinnest margin first')),
        h('div.grid-wrap', h('table.grid',
          h('thead', h('tr', h('th', 'Number'), h('th', 'Project'), h('th', 'Billing'), h('th', 'Progress'),
            h('th.num', 'Hours'), h('th.num', 'Cost'), h('th.num', 'Revenue'),
            h('th.num', 'Margin'), h('th.num', 'Margin %'), h('th.num', 'Unbilled'), h('th', 'Budget'))),
          h('tbody', ...rows)))),
      utilRows.length
        ? h('div.card', { style: { marginTop: '14px' } },
          h('div.card-head', h('h2', 'Who is booked'),
            h('span.muted', { style: { fontSize: '12px' } }, 'Allocated hours against capacity')),
          h('div.grid-wrap', h('table.grid',
            h('thead', h('tr', h('th', 'Person'), h('th.num', 'Booked h/wk'), h('th.num', 'Capacity'),
              h('th.num', 'Utilisation'), h('th', ''))),
            h('tbody', ...utilRows))))
        : null);
  }

  load();
  return h('div.page',
    h('div.page-head',
      h('div.titles', h('h1', 'Projects'),
        h('div.page-sub', 'Budget, time, expenses and margin across every engagement')),
      h('div.page-actions', statusSel,
        store.can('project') ? h('button.btn.primary', { onclick: () => go('/new/project') }, 'New project') : null)),
    host);
}

const progressBar = (p) => {
  const v = Math.max(0, Math.min(100, Number(p) || 0));
  return h('div.bar', { title: `${v.toFixed(0)}% complete` }, h('div.bar-fill', { style: { width: `${v}%` } }));
};

function budgetCell(p) {
  if (!p.budget) return h('span.faint', '—');
  const used = p.budget_used_pct ?? 0;
  return h('span', { class: p.over_budget ? 'num-neg' : '' },
    `${cash(p.budget)} · ${used.toFixed(0)}% used`);
}
