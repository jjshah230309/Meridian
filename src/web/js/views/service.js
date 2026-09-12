// Meridian ERP :: web/views/service
// The dispatch board: who is going where today, what is still unassigned, and
// which contracts are about to lapse.
import { h, mount } from '../dom.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import * as store from '../store.js';
import { empty, notifyError, notifyOk, statusTag, loading, modal } from '../ui.js';

const cash = (v) => fmt.money(Math.round((Number(v) || 0) * 100));
const PRIORITY_TONE = { emergency: 'red', high: 'amber', normal: '', low: '' };
const clock = (iso) => (iso ? String(iso).slice(11, 16) : '—');
// Whole days from today to an ISO date, floored at zero.
const daysUntil = (d) => Math.max(0, Math.round((Date.parse(`${d}T00:00:00Z`) - Date.now()) / 86400000));

export async function dispatchView(_route, { go }) {
  const dateInput = h('input', { type: 'date', value: fmt.today(), style: { width: '150px' } });
  const host = h('div');

  async function load() {
    mount(host, loading('Building the board'));
    try {
      const [board, renewals] = await Promise.all([
        API.dispatchBoard(dateInput.value),
        API.serviceRenewals().catch(() => ({ contracts: [] })),
      ]);
      render(board, renewals.contracts || []);
    } catch (e) { mount(host, empty('Could not load the board', e.message)); }
  }
  dateInput.addEventListener('change', load);

  function assignDialog(job) {
    const start = h('input', { type: 'datetime-local', value: `${dateInput.value}T09:00`, style: { width: '100%' } });
    const end = h('input', { type: 'datetime-local', value: `${dateInput.value}T11:00`, style: { width: '100%' } });
    const techSel = h('select', { style: { width: '100%' } }, h('option', { value: '' }, 'Loading…'));

    // Only offer people who are actually free in the window being booked.
    const refreshTechs = async () => {
      try {
        const { technicians } = await API.availableTechnicians(start.value, end.value);
        mount(techSel, ...(technicians.length
          ? technicians.map((t) => h('option', { value: t.technician_id },
            `${t.name}${t.match_pct < 100 ? ` · ${t.match_pct}% skill match` : ''}`))
          : [h('option', { value: '' }, 'Nobody is free in that window')]));
      } catch (e) { mount(techSel, h('option', { value: '' }, e.message)); }
    };
    start.addEventListener('change', refreshTechs);
    end.addEventListener('change', refreshTechs);
    refreshTechs();

    modal({
      title: `Schedule ${job.order_no}`,
      body: h('div',
        h('p.muted', { style: { marginTop: 0 } }, `${job.customer} · ${fmt.titleCase(job.type || 'visit')}`),
        h('div.field', h('label', 'From'), start),
        h('div.field', h('label', 'To'), end),
        h('div.field', h('label', 'Technician'), techSel,
          h('div.help', 'Only people free for the whole window are listed, best skill match first.'))),
      actions: [
        { label: 'Cancel' },
        {
          label: 'Schedule', kind: 'primary',
          onClick: async () => {
            if (!techSel.value) { notifyError(new Error('Pick a technician')); return false; }
            await API.scheduleServiceOrder(job.id, {
              technician_id: techSel.value, scheduled_start: start.value, scheduled_end: end.value,
            });
            notifyOk('Job scheduled');
            load();
          },
        },
      ],
    });
  }

  async function setStatus(job, status, label) {
    try { await API.serviceOrderStatus(job.id, status); notifyOk(label); load(); }
    catch (e) { notifyError(e); }
  }

  function jobCard(job, { assignable = false } = {}) {
    const actions = h('div.row', { style: { gap: '4px', marginTop: '6px' } });
    if (assignable) {
      actions.appendChild(h('button.btn.sm', { onclick: () => assignDialog(job) }, 'Schedule'));
    } else {
      if (job.status === 'scheduled') actions.appendChild(h('button.btn.sm', { onclick: () => setStatus(job, 'in_progress', 'Job started') }, 'Start'));
      if (job.status === 'in_progress') actions.appendChild(h('button.btn.sm', { onclick: () => setStatus(job, 'completed', 'Job completed') }, 'Complete'));
    }
    actions.appendChild(h('button.btn.sm', { onclick: () => go(`/record/service_order/${job.id}`) }, 'Open'));

    return h('div.job-card',
      h('div.row', { style: { justifyContent: 'space-between', gap: '6px' } },
        h('strong', job.order_no),
        h('span.tag', { class: PRIORITY_TONE[job.priority] || '' }, fmt.titleCase(job.priority || 'normal'))),
      h('div', { style: { fontSize: '12.5px', marginTop: '2px' } }, job.customer || '—'),
      h('div.muted', { style: { fontSize: '11.5px' } },
        assignable ? fmt.titleCase(job.type || 'visit') : `${clock(job.start)}–${clock(job.end)} · ${fmt.titleCase(job.type || 'visit')}`),
      job.description ? h('div.muted', { style: { fontSize: '11.5px', marginTop: '3px' } }, job.description) : null,
      h('div', { style: { marginTop: '4px' } }, statusTag(job.status)),
      actions);
  }

  function render(board, renewals) {
    const kpis = h('div.kpi-grid', { style: { marginBottom: '14px' } },
      h('div.kpi', h('div.k-label', 'Jobs today'), h('div.k-value', String(board.counts.total))),
      h('div.kpi', h('div.k-label', 'Unassigned'),
        h('div.k-value', { class: board.counts.unassigned ? 'num-neg' : '' }, String(board.counts.unassigned))),
      h('div.kpi', h('div.k-label', 'Emergency'),
        h('div.k-value', { class: board.counts.emergency ? 'num-neg' : '' }, String(board.counts.emergency))),
      h('div.kpi', h('div.k-label', 'Technicians out'), h('div.k-value', String(board.technicians.length))));

    const columns = [
      ...(board.unassigned.length ? [h('div.board-col',
        h('div.board-col-head', h('strong', 'Unassigned'), h('span.tag.amber', String(board.unassigned.length))),
        ...board.unassigned.map((j) => jobCard(j, { assignable: true })))] : []),
      ...board.technicians.map((t) => h('div.board-col',
        h('div.board-col-head', h('strong', t.name), h('span.tag', String(t.jobs.length))),
        ...t.jobs.map((j) => jobCard(j)))),
    ];

    const renewalRows = renewals.map((c) => h('tr.clickable',
      { onclick: () => go(`/record/service_contract/${c.id}`) },
      h('td', h('strong', c.contract_no)),
      h('td', c.customer),
      h('td', c.name),
      h('td.muted', fmt.dateShort(c.end_date)),
      h('td.num', { class: daysUntil(c.end_date) < 30 ? 'num-neg' : '' }, `${daysUntil(c.end_date)} days`),
      h('td.num', { class: (c.utilisation_pct ?? 0) > 90 ? 'num-neg' : '' },
        c.utilisation_pct === null || c.utilisation_pct === undefined ? '—' : `${c.utilisation_pct}%`),
      h('td.num', cash(c.amount))));

    mount(host, kpis,
      columns.length
        ? h('div.board', ...columns)
        : empty('Nothing booked for this day', 'Jobs scheduled for this date will appear here, one column per technician.'),
      renewalRows.length
        ? h('div.card', { style: { marginTop: '14px' } },
          h('div.card-head', h('h2', 'Contracts up for renewal'),
            h('span.muted', { style: { fontSize: '12px' } }, 'Next 90 days')),
          h('div.grid-wrap', h('table.grid',
            h('thead', h('tr', h('th', 'Contract'), h('th', 'Customer'), h('th', 'Plan'),
              h('th', 'Ends'), h('th.num', 'Remaining'), h('th.num', 'Visits used'), h('th.num', 'Value'))),
            h('tbody', ...renewalRows))))
        : null);
  }

  load();
  return h('div.page',
    h('div.page-head',
      h('div.titles', h('h1', 'Dispatch'),
        h('div.page-sub', 'Who is going where, and what still needs a technician')),
      h('div.page-actions', dateInput,
        store.can('service_order') ? h('button.btn.primary', { onclick: () => go('/new/service_order') }, 'New job') : null)),
    host);
}
