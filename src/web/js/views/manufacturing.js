// Meridian ERP :: web/views/manufacturing
// The shop floor: work orders through their lifecycle, and how much of what
// leaves the line is right first time.
import { h, mount } from '../dom.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import * as store from '../store.js';
import { empty, notifyError, notifyOk, confirm, statusTag, loading, modal } from '../ui.js';


// The order a work order actually moves through, so the board reads left to right.
// A work order's cost is what has actually been consumed: components issued,
// labour logged and overhead applied. There is no single total column.
const woCost = (o) => (o.component_cost || 0) + (o.labour_cost || 0) + (o.overhead_cost || 0);

const STAGES = [
  ['planned', 'Planned'],
  ['released', 'Released'],
  ['in_progress', 'In progress'],
  ['built', 'Built'],
  ['closed', 'Closed'],
];

export async function productionView(_route, { go }) {
  const host = h('div');

  async function load() {
    mount(host, loading('Reading the shop floor'));
    try {
      // The generic list returns only its own columns, which leave out cost
      // and start date; a search asks for exactly what this board shows.
      const [orders, quality] = await Promise.all([
        API.search('work_order', {
          columns: ['order_no', 'item_id', 'quantity', 'quantity_built', 'status',
            'start_date', 'due_date', 'component_cost', 'labour_cost', 'overhead_cost'],
          sort: 'due_date ASC',
        }, 200),
        API.qualitySummary().catch(() => null),
      ]);
      render(orders.rows || [], quality);
    } catch (e) { mount(host, empty('Could not load production', e.message)); }
  }

  async function act(id, action, label) {
    try {
      await action();
      notifyOk(label);
      load();
    } catch (e) { notifyError(e); }
  }

  function issueDialog(order) {
    modal({
      title: `Issue components to ${order.order_no}`,
      body: h('div',
        h('p.muted', { style: { marginTop: 0 } },
          'The bill of materials is exploded for the ordered quantity and the components are '
          + 'taken out of stock at their current cost. This posts to the ledger.')),
      actions: [
        { label: 'Cancel' },
        {
          label: 'Issue components', kind: 'primary',
          onClick: async () => {
            const res = await API.issueWorkOrder(order.id);
            notifyOk(`${fmt.money(res.total_cost ?? res.component_cost ?? 0)} of components issued.`, 'Components issued');
            load();
          },
        },
      ],
    });
  }

  function buildDialog(order) {
    const qty = h('input', {
      type: 'number', step: '0.01', min: '0',
      value: String(fmt.qty(order.quantity, 2)).replace(/,/g, ''),
      style: { width: '100%' },
    });
    modal({
      title: `Build from ${order.order_no}`,
      body: h('div',
        h('p.muted', { style: { marginTop: 0 } },
          'Finished units are received into stock at the cost of what was issued. '
          + 'Any difference between issued cost and built value posts as a variance.'),
        h('div.field', h('label', 'How many units are finished?'), qty)),
      actions: [
        { label: 'Cancel' },
        {
          label: 'Record the build', kind: 'primary',
          onClick: async () => {
            const n = Number(qty.value);
            if (!(n > 0)) { notifyError(new Error('Enter how many units were finished')); return false; }
            const res = await API.buildWorkOrder(order.id, n);
            notifyOk(`${fmt.num(n, 2)} unit(s) received at ${fmt.money(res.unit_cost ?? 0)} each.`, 'Build recorded');
            load();
          },
        },
      ],
    });
  }

  function render(orders, quality) {
    if (!orders.length) {
      mount(host, empty('No work orders yet',
        'Raise a work order to explode a bill of materials, issue its components and build the result.',
        store.can('work_order') ? h('button.btn.primary', { onclick: () => go('/new/work_order') }, 'New work order') : null));
      return;
    }

    const counts = Object.fromEntries(STAGES.map(([k]) => [k, 0]));
    for (const o of orders) if (counts[o.status] !== undefined) counts[o.status]++;

    const kpis = h('div.kpi-grid', { style: { marginBottom: '14px' } },
      ...STAGES.map(([key, label]) => h('div.kpi',
        h('div.k-label', label),
        h('div.k-value', String(counts[key] || 0)))),
      h('div.kpi',
        h('div.k-label', 'First-pass yield'),
        h('div.k-value', quality?.first_pass_yield_pct === null || quality?.first_pass_yield_pct === undefined
          ? '—' : `${quality.first_pass_yield_pct}%`),
        h('div.k-meta', quality ? `${fmt.num(quality.inspections)} inspection(s)` : 'No inspections yet')));

    const rows = orders.map((o) => {
      const actions = h('div.row', { style: { gap: '4px' } });
      const add = (label, fn, kind = 'sm') => actions.appendChild(
        h(`button.btn.${kind}`, { onclick: (e) => { e.stopPropagation(); fn(); } }, label));
      if (o.status === 'planned') add('Release', () => act(o.id, () => API.releaseWorkOrder(o.id), 'Work order released'));
      if (o.status === 'released') add('Issue', () => issueDialog(o));
      if (o.status === 'released' || o.status === 'in_progress') add('Build', () => buildDialog(o));

      return h('tr.clickable', { onclick: () => go(`/record/work_order/${o.id}`) },
        h('td', h('strong', o.order_no)),
        h('td', o.item_id_label || o.item_id || '—'),
        h('td.num', fmt.qty(o.quantity, 2)),
        h('td.num', o.quantity_built ? fmt.qty(o.quantity_built, 2) : h('span.faint', '—')),
        h('td', statusTag(o.status)),
        h('td.muted', o.start_date ? fmt.dateShort(o.start_date) : '—'),
        h('td.muted', o.due_date ? fmt.dateShort(o.due_date) : '—'),
        h('td.num', woCost(o) ? fmt.money(woCost(o)) : h('span.faint', '—')),
        h('td', actions));
    });

    const worst = (quality?.worst_items || []).map((w) => h('tr',
      h('td', w.sku || w.name),
      h('td.num', fmt.num(w.inspected, 2)),
      h('td.num', { class: w.failed ? 'num-neg' : '' }, fmt.num(w.failed, 2)),
      h('td.num', { class: w.fail_pct > 5 ? 'num-neg' : '' }, `${w.fail_pct}%`)));

    mount(host, kpis,
      h('div.card',
        h('div.card-head', h('h2', 'Work orders'),
          h('span.muted', { style: { fontSize: '12px' } }, `${orders.length}`)),
        h('div.grid-wrap', h('table.grid',
          h('thead', h('tr', h('th', 'Number'), h('th', 'Item'), h('th.num', 'Ordered'), h('th.num', 'Built'),
            h('th', 'Status'), h('th', 'Start'), h('th', 'Due'), h('th.num', 'Cost'), h('th', ''))),
          h('tbody', ...rows)))),
      worst.length
        ? h('div.card', { style: { marginTop: '14px' } },
          h('div.card-head', h('h2', 'Quality'), h('span.muted', { style: { fontSize: '12px' } }, 'Highest failure rate first')),
          h('div.grid-wrap', h('table.grid',
            h('thead', h('tr', h('th', 'Item'), h('th.num', 'Inspected'), h('th.num', 'Failed'), h('th.num', 'Fail rate'))),
            h('tbody', ...worst))))
        : null);
  }

  load();
  return h('div.page',
    h('div.page-head',
      h('div.titles', h('h1', 'Production'),
        h('div.page-sub', 'Work orders from release through issue to build, and first-pass yield')),
      h('div.page-actions',
        store.can('work_order') ? h('button.btn.primary', { onclick: () => go('/new/work_order') }, 'New work order') : null)),
    host);
}

// ------------------------------------------------------------- warehouse

export async function warehouseView(_route, { go }) {
  const host = h('div');

  async function load() {
    mount(host, loading('Reading the warehouse'));
    try {
      const [workload, waves] = await Promise.all([
        API.warehouseWorkload(),
        API.search('pick_wave', {
          columns: ['wave_no', 'status', 'location_id', 'order_count', 'line_count', 'released_at', 'created_at'],
          sort: 'created_at DESC',
        }, 100),
      ]);
      render(workload, waves.rows || []);
    } catch (e) { mount(host, empty('Could not load the warehouse', e.message)); }
  }

  async function act(fn, label) {
    try { await fn(); notifyOk(label); load(); } catch (e) { notifyError(e); }
  }

  function render(workload, waves) {
    const kpis = h('div.kpi-grid', { style: { marginBottom: '14px' } },
      h('div.kpi', h('div.k-label', 'Open waves'), h('div.k-value', String(workload.waves.length))),
      h('div.kpi', h('div.k-label', 'Awaiting put-away'),
        h('div.k-value', String(workload.pending_putaway)),
        h('div.k-meta', 'Received but not shelved')),
      h('div.kpi', h('div.k-label', 'Short picks'),
        h('div.k-value', { class: workload.short_picks.length ? 'num-neg' : '' }, String(workload.short_picks.length)),
        h('div.k-meta', 'Not enough stock in the bin')),
      h('div.kpi', h('div.k-label', 'Lines to pick'),
        h('div.k-value', String(workload.waves.reduce((a, w) => a + (w.lines - w.picked), 0)))));

    const waveRows = waves.map((w) => {
      const live = workload.waves.find((x) => x.id === w.id);
      const done = live ? live.picked : 0;
      const total = live ? live.lines : 0;
      const actions = h('div.row', { style: { gap: '4px' } });
      const add = (label, fn) => actions.appendChild(
        h('button.btn.sm', { onclick: (e) => { e.stopPropagation(); fn(); } }, label));
      // open -> picking -> picked -> packed -> shipped, per WAVE_STATUSES.
      if (w.status === 'open') add('Release', () => act(() => API.releaseWave(w.id), 'Wave released to the floor'));
      if (w.status === 'picked') add('Pack', () => act(() => API.packWave(w.id), 'Wave packed'));
      if (w.status === 'packed') add('Ship', () => act(() => API.shipWave(w.id), 'Wave shipped'));

      return h('tr.clickable', { onclick: () => go(`/record/pick_wave/${w.id}`) },
        h('td', h('strong', w.wave_no)),
        h('td', statusTag(w.status)),
        h('td.num', String(live?.orders ?? w.order_count ?? '—')),
        h('td.num', total ? `${done} / ${total}` : '—'),
        h('td', total ? h('div.bar', h('div.bar-fill', { style: { width: `${Math.round((done / total) * 100)}%` } })) : ''),
        h('td.muted', w.location_id_label || '—'),
        h('td.muted', w.created_at ? fmt.relative(w.created_at) : '—'),
        h('td', actions));
    });

    const shortRows = workload.short_picks.map((s) => h('tr',
      h('td', h('strong', s.sku)),
      h('td', s.name),
      h('td.num', fmt.num(s.wanted, 2)),
      h('td.num.num-neg', fmt.num(s.picked ?? 0, 2)),
      h('td.num.num-neg', fmt.num((s.wanted || 0) - (s.picked || 0), 2))));

    mount(host, kpis,
      workload.pending_putaway
        ? h('div.callout',
          h('strong', `${workload.pending_putaway} received line(s) are waiting to be put away. `),
          'Generating put-away tasks assigns each one a bin.',
          h('button.btn.sm', {
            style: { marginLeft: '8px' },
            onclick: () => act(() => API.generatePutaway(), 'Put-away tasks generated'),
          }, 'Generate put-away'))
        : null,
      h('div.card',
        h('div.card-head', h('h2', 'Pick waves'), h('span.muted', { style: { fontSize: '12px' } }, `${waves.length}`)),
        waveRows.length
          ? h('div.grid-wrap', h('table.grid',
            h('thead', h('tr', h('th', 'Wave'), h('th', 'Status'), h('th.num', 'Orders'),
              h('th.num', 'Picked'), h('th', ''), h('th', 'Location'), h('th', 'Created'), h('th', ''))),
            h('tbody', ...waveRows)))
          : h('div', { style: { padding: '12px' } },
            h('p.muted', { style: { margin: 0 } }, 'No waves yet. A wave groups orders so they can be picked in one trip.'))),
      shortRows.length
        ? h('div.card', { style: { marginTop: '14px' } },
          h('div.card-head', h('h2', 'Short picks'),
            h('span.muted', { style: { fontSize: '12px' } }, 'The bin did not hold enough')),
          h('div.grid-wrap', h('table.grid',
            h('thead', h('tr', h('th', 'SKU'), h('th', 'Item'), h('th.num', 'Wanted'), h('th.num', 'Picked'), h('th.num', 'Short by'))),
            h('tbody', ...shortRows))))
        : null);
  }

  load();
  return h('div.page',
    h('div.page-head',
      h('div.titles', h('h1', 'Warehouse'),
        h('div.page-sub', 'Put-away, pick waves, packing and shipping'))),
    host);
}
