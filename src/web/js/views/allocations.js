// Meridian ERP :: web/views/allocations
// Spreading shared cost across the parts of the business that caused it.
//
// The screen leads with the split itself — who gets what, and why — because
// that is the part anybody argues about. The schedule that produces it is
// underneath. A run is preview-first: the working is on screen before the
// entry exists, and the same function produces both.
import { h, mount } from '../dom.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import * as store from '../store.js';
import { empty, notifyError, notifyOk, statusTag, loading, modal, facts, confirm } from '../ui.js';

export async function allocationsView(route, { go }) {
  if (!store.can('allocation_schedule')) {
    return h('div.page', empty('Not permitted', 'Your role cannot see allocation schedules.'));
  }
  const canRun = store.can('allocation_schedule', store.LEVEL.EDIT);
  const canCreate = store.can('allocation_schedule', store.LEVEL.CREATE);
  const openId = route.parts[1] || null;

  const host = h('div');
  const head = h('div');

  async function load() {
    mount(host, loading('Reading the schedules'));
    try {
      if (openId) { renderOne(await API.allocation(openId)); return; }
      renderIndex(await API.allocations({}));
    } catch (e) { mount(host, empty('Could not open the allocations', e.message)); }
  }

  function renderIndex(data) {
    const due = data.due || [];
    mount(head,
      h('div.titles',
        h('h1', 'Cost Allocations'),
        h('div.page-sub', 'Shared cost spread across the departments that caused it, by weight or by what the statistics say')),
      h('div.page-actions',
        canCreate ? h('button.btn.primary', { onclick: () => go('/setup') }, 'New schedule') : null));

    if (!data.rows.length) {
      mount(host, empty('No allocation schedules yet',
        'A schedule says: take what landed on these accounts, and move it to these ones, in these proportions. '
        + 'The proportions are either fixed, or read from statistical accounts — headcount, floor area, machine hours — so the split follows the business.'));
      return;
    }

    const kpis = h('div.kpi-grid', { style: { marginBottom: 'var(--s5)' } },
      h('div.kpi',
        h('div.k-label', 'Schedules'),
        h('div.k-value', String(data.rows.filter((r) => r.status === 'active').length)),
        h('div.k-meta', `${data.total} in total`)),
      h('div.kpi',
        h('div.k-label', 'Due to run'),
        h('div.k-value', { class: due.length ? 'num-neg' : '' }, String(due.length)),
        h('div.k-meta', due.length ? `Earliest ${fmt.dateShort(due[0].next_date)}` : 'Everything is up to date')),
      h('div.kpi',
        h('div.k-label', 'By statistics'),
        h('div.k-value', String(data.rows.filter((r) => r.method === 'statistical').length)),
        h('div.k-meta', 'Following headcount, area or hours')));

    mount(host, kpis,
      h('div.card',
        h('div.card-head', h('h2', 'Schedules')),
        h('div.grid-wrap', h('table.grid',
          h('thead', h('tr', h('th', 'Name'), h('th', 'Split by'), h('th', 'Frequency'),
            h('th', 'Takes'), h('th', 'Next run'), h('th.num', 'Sources'), h('th.num', 'Destinations'),
            h('th.num', 'Runs'), h('th', 'Status'))),
          h('tbody', ...data.rows.map((r) => h('tr.clickable', { onclick: () => go(`/allocations/${r.id}`) },
            h('td', h('strong', r.name), r.description ? h('div.muted', { style: { fontSize: 'var(--t-xs)' } }, r.description) : null),
            h('td', r.method === 'statistical' ? h('span.tag.blue', 'Statistics') : h('span.tag', 'Fixed weights')),
            h('td.muted', fmt.titleCase(r.frequency)),
            h('td.muted', r.basis === 'cumulative' ? 'Everything unallocated' : 'The period'),
            h('td', { class: r.next_date <= fmt.today() && r.status === 'active' ? 'num-neg' : '' }, fmt.date(r.next_date)),
            h('td.num.muted', String(r.source_count)),
            h('td.num.muted', String(r.target_count)),
            h('td.num.muted', String(r.occurrences)),
            h('td', statusTag(r.status)))))))));
  }

  function renderOne(data) {
    const s = data.schedule;
    mount(head,
      h('div.titles',
        h('div.breadcrumb', h('a', { href: '#/allocations', onclick: (e) => { e.preventDefault(); go('/allocations'); } }, 'Cost Allocations')),
        h('h1', s.name, ' ', statusTag(s.status)),
        h('div.page-sub', s.description || `${fmt.titleCase(s.frequency)}, split by ${s.method === 'statistical' ? 'statistical accounts' : 'fixed weights'}`)),
      h('div.page-actions',
        canRun && s.status === 'active'
          ? h('button.btn.primary', { onclick: () => runDialog(s) }, `Allocate ${fmt.date(s.next_date)}`)
          : null));

    mount(host,
      h('div.card',
        h('div.card-head', h('h2', 'What is being spread')),
        h('div.grid-wrap', h('table.grid',
          h('thead', h('tr', h('th', 'Account'), h('th', 'Department'), h('th.num', 'Share taken'))),
          h('tbody', ...s.sources.map((src) => h('tr',
            h('td', h('span.mono', src.account_number), ' ', src.account_name),
            h('td.muted', src.department_id || '—'),
            h('td.num', `${src.percent}%`))))))),
      h('div.card',
        h('div.card-head', h('h2', 'Where it goes')),
        h('div.grid-wrap', h('table.grid',
          h('thead', h('tr', h('th', '#'), h('th', 'Account'), h('th', 'Department'),
            h('th', s.method === 'statistical' ? 'Measured by' : 'Weight'), h('th', 'Memo'))),
          h('tbody', ...s.targets.map((t) => h('tr',
            h('td.muted', String(t.line_no)),
            h('td', t.account_number ? h('span', h('span.mono', t.account_number), ' ', t.account_name) : h('span.faint', 'Same as the source')),
            h('td', t.department_name || h('span.faint', '—')),
            h('td', s.method === 'statistical'
              ? h('span', h('span.mono', t.stat_number || '—'), ' ', t.stat_name || '')
              : String(t.weight)),
            h('td.muted', t.memo || '—'))))))),
      data.runs?.length
        ? h('div.card',
          h('div.card-head', h('h2', 'Previous runs')),
          h('div.grid-wrap', h('table.grid',
            h('thead', h('tr', h('th', 'Run'), h('th', 'Date'), h('th.num', 'Amount'), h('th', 'Entry'), h('th', ''))),
            h('tbody', ...data.runs.map((r) => h('tr',
              h('td', h('strong', r.run_no)),
              h('td', fmt.date(r.txn_date)),
              h('td.num', fmt.money(r.amount)),
              h('td', r.entry_no ? h('a', {
                href: `#/journal/${r.entry_id}`,
                onclick: (e) => { e.preventDefault(); go(`/journal/${r.entry_id}`); },
              }, r.entry_no) : '—'),
              h('td', h('button.btn.sm', { onclick: () => showBasis(r) }, 'How it was split'))))))))
        : null);
  }

  const showBasis = (run) => modal({
    title: `${run.run_no} — how it was split`,
    size: 'wide',
    body: h('div',
      facts([['Amount', fmt.money(run.amount)], ['Dated', fmt.date(run.txn_date)], ['Entry', run.entry_no || '—']]),
      h('div.grid-wrap', { style: { marginTop: 'var(--s3)' } }, h('table.grid',
        h('thead', h('tr', h('th', 'Account'), h('th', 'Department'), h('th.num', 'Measured'), h('th.num', 'Share'), h('th.num', 'Amount'))),
        h('tbody', ...(run.weights || []).map((w) => h('tr',
          h('td', w.account || h('span.faint', 'Source account')),
          h('td', w.department || '—'),
          h('td.num.muted', w.measured),
          h('td.num', `${w.share}%`),
          h('td.num', fmt.money(w.amount)))))))),
    actions: [{ label: 'Close', value: null }],
  });

  function runDialog(schedule) {
    const date = h('input', { type: 'date', value: schedule.next_date });
    const memo = h('input', { type: 'text', placeholder: `${schedule.name} — ${schedule.next_date}` });
    const preview = h('div', { style: { marginTop: 'var(--s4)' } });
    let plan = null;

    const draw = async () => {
      mount(preview, loading('Working out the split'));
      try {
        plan = await API.previewAllocation(schedule.id, { txn_date: date.value });
        mount(preview, summary(plan));
      } catch (e) { plan = null; mount(preview, empty('Could not work out the split', e.message)); }
    };
    date.addEventListener('change', draw);

    const m = modal({
      title: `Allocate ${schedule.name}`,
      size: 'wide',
      body: h('div',
        h('p.muted', { style: { marginTop: 0 } },
          'Everything on the source accounts for this period is divided between the destinations and posted as one entry. Nothing is written until you post it.'),
        h('div.form-grid',
          h('div.field', h('label', 'Allocate as at'), date),
          h('div.field', h('label', 'Memo'), memo)),
        preview),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Post the allocation', kind: 'primary',
          onClick: async (close) => {
            if (!plan?.ready) { notifyError(new Error(plan?.reason || 'There is nothing to allocate.')); return false; }
            try {
              const res = await API.runAllocation(schedule.id, { txn_date: date.value, memo: memo.value || '' });
              notifyOk(`${fmt.money(res.pool)} allocated across ${res.lines.filter((l) => l.amount).length} destinations.`, 'Allocation posted');
              close(true); load();
            } catch (e) { notifyError(e); return false; }
          },
        },
      ],
    });
    draw();
    return m;
  }

  function summary(plan) {
    if (!plan.ready) return h('div.callout.warn', plan.reason || 'There is nothing to allocate for that date.');
    return h('div',
      facts([
        ['Period', `${fmt.date(plan.from)} → ${fmt.date(plan.to)}`],
        ['To allocate', fmt.money(plan.pool)],
        ['Across', `${plan.lines.filter((l) => l.amount).length} destinations`],
      ]),
      h('div.grid-wrap', { style: { marginTop: 'var(--s3)', maxHeight: '260px' } }, h('table.grid',
        h('thead', h('tr', h('th', 'Destination'), h('th.num', 'Measured'), h('th.num', 'Share'), h('th.num', 'Amount'))),
        h('tbody',
          ...plan.lines.map((l) => h('tr',
            h('td', l.target.department_name || l.target.account_name || 'Source account'),
            h('td.num.muted', l.basis_label),
            h('td.num', `${l.share}%`),
            h('td.num', h('strong', fmt.money(l.amount))))),
          h('tr.subtotal', h('td', 'Total'), h('td', ''), h('td', ''), h('td.num', fmt.money(plan.pool)))))));
  }

  load();
  return h('div.page', h('div.page-head', head), host);
}

void confirm;
