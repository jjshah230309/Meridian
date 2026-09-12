// Meridian ERP :: web/views/revenue
// Deferred revenue and prepaid expenses: what is still parked on the balance
// sheet, which month each slice belongs to, and the run that releases the
// ones now due.
//
// The waterfall leads because it answers the question people actually come
// here with — how much of next quarter is already sold — and the run is a
// dry-run-first action, because posting into the ledger should never be a
// surprise.
import { h, mount } from '../dom.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import * as store from '../store.js';
import { barChart } from '../charts.js';
import { empty, notifyError, notifyOk, statusTag, loading, modal, facts } from '../ui.js';

const KINDS = {
  revenue: {
    title: 'Revenue Recognition',
    sub: 'Revenue billed but not yet earned, and the months it belongs to',
    deferredLabel: 'Deferred revenue',
    runLabel: 'Recognise revenue',
    releaseVerb: 'recognised',
    empty: 'Nothing is being deferred yet',
    emptyHint: 'Give an item a revenue recognition template, then invoice it. The revenue lands in Deferred Revenue and is released month by month.',
  },
  expense: {
    title: 'Expense Amortisation',
    sub: 'Costs paid up front, and the months they cover',
    deferredLabel: 'Prepaid expenses',
    runLabel: 'Amortise expenses',
    releaseVerb: 'amortised',
    empty: 'Nothing is being amortised yet',
    emptyHint: 'Give an item a cost amortisation template, then enter a bill for it. The cost is held as a prepayment and released over the term.',
  },
};

const monthLabel = (m) => {
  const [y, mm] = String(m || '').split('-');
  const d = new Date(Date.UTC(Number(y), Number(mm) - 1, 1));
  return Number.isNaN(d.getTime()) ? m : d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
};

export async function revenueView(route, { go }) {
  let kind = route.parts[1] === 'amortisation' ? 'expense' : 'revenue';
  const host = h('div');
  const head = h('div');

  const tabs = () => h('div.tabs', { style: { marginBottom: '14px' } },
    ...Object.keys(KINDS).map((k) => h('button.tab', {
      class: k === kind ? 'active' : '',
      onclick: () => { if (k === kind) return; kind = k; go(k === 'revenue' ? '/revenue' : '/revenue/amortisation'); },
    }, KINDS[k].title)));

  async function load() {
    mount(host, loading('Reading the schedules'));
    try {
      const [wf, list, dueRows] = await Promise.all([
        API.scheduleWaterfall({ kind, months: 12 }),
        API.schedules({ kind, status: 'active', limit: 200 }),
        API.schedulesDue({ kind }),
      ]);
      render(wf, list, dueRows.rows || []);
    } catch (e) {
      mount(host, empty('Could not load the schedules', e.message));
    }
  }

  function render(wf, list, dueRows) {
    const cfg = KINDS[kind];
    mount(head,
      h('div.titles', h('h1', cfg.title), h('div.page-sub', cfg.sub)),
      h('div.page-actions',
        store.can('schedule', store.LEVEL.EDIT)
          ? h('button.btn.primary', {
            disabled: !dueRows.length,
            title: dueRows.length ? '' : 'Nothing is due to be released',
            onclick: () => runDialog(dueRows),
          }, cfg.runLabel)
          : null));

    if (!list.rows.length && !wf.total_deferred) {
      mount(host, tabs(), empty(cfg.empty, cfg.emptyHint,
        store.can('schedule_template', store.LEVEL.CREATE)
          ? h('button.btn.primary', { onclick: () => go('/new/schedule_template') }, 'New schedule template')
          : null));
      return;
    }

    // Base currency: a due list can span a dollar contract and a sterling one.
    const dueTotal = dueRows.reduce((a, r) => a + (r.base_amount || 0), 0);
    const kpis = h('div.kpi-grid', { style: { marginBottom: '14px' } },
      h('div.kpi',
        h('div.k-label', cfg.deferredLabel),
        h('div.k-value', fmt.moneyCompact(Math.round(wf.total_deferred * 100))),
        h('div.k-meta', `${list.total} live schedule${list.total === 1 ? '' : 's'}`)),
      h('div.kpi',
        h('div.k-label', 'Due to release'),
        h('div.k-value', { class: dueTotal ? 'num-pos' : '' }, fmt.money(dueTotal)),
        h('div.k-meta', dueRows.length ? `${dueRows.length} slice${dueRows.length === 1 ? '' : 's'} on or before today` : 'Nothing outstanding')),
      h('div.kpi',
        h('div.k-label', 'Next twelve months'),
        h('div.k-value', fmt.moneyCompact(Math.round(wf.buckets.reduce((a, b) => a + b.amount, 0) * 100))),
        h('div.k-meta', 'Already contracted')),
      h('div.kpi',
        h('div.k-label', 'Held back'),
        h('div.k-value', fmt.moneyCompact(Math.round(wf.held * 100))),
        h('div.k-meta', 'Waiting on completion')));

    const chart = wf.buckets.some((b) => b.amount)
      ? barChart(wf.buckets.map((b) => ({
        label: monthLabel(b.month),
        value: b.amount,
        tip: `${b.month}: ${fmt.money(Math.round(b.amount * 100))} across ${b.lines} slice${b.lines === 1 ? '' : 's'}`,
      })), { height: 190, format: (v) => fmt.moneyCompact(Math.round(v * 100)) })
      : h('div.muted', { style: { padding: '28px 0', textAlign: 'center' } }, 'Nothing falls in the next twelve months.');

    const overdueNote = wf.overdue
      ? h('span.tag.amber', `${fmt.money(Math.round(wf.overdue * 100))} past due`)
      : h('span.muted', { style: { fontSize: '12px' } }, 'By the month the slice falls');

    const rows = list.rows.map((s) => {
      const pct = s.total_amount ? Math.round((s.posted_amount / s.total_amount) * 100) : 0;
      return h('tr.clickable', { onclick: () => go(`/record/schedule/${s.id}`) },
        h('td', h('strong', s.schedule_no)),
        h('td', s.memo || '—'),
        h('td.muted', s.source_no || '—'),
        h('td.muted', s.target_number ? `${s.target_number} ${s.target_name}` : '—'),
        h('td.muted', `${fmt.date(s.start_date)} → ${fmt.date(s.end_date)}`),
        h('td.num', fmt.money(s.total_amount, s.currency)),
        h('td.num', fmt.money(s.posted_amount, s.currency)),
        h('td.num', h('strong', fmt.money(s.remaining, s.currency))),
        h('td', h('div.bar', { title: `${pct}% released` }, h('div.bar-fill', { style: { width: `${pct}%` } }))));
    });

    mount(host, tabs(), kpis,
      h('div.card',
        h('div.card-head', h('h2', `${cfg.deferredLabel} by month`), overdueNote),
        chart),
      h('div.card', { style: { marginTop: '14px' } },
        h('div.card-head', h('h2', 'Live schedules'),
          h('span.muted', { style: { fontSize: '12px' } }, `${list.total} active`)),
        h('div.grid-wrap', h('table.grid',
          h('thead', h('tr', h('th', 'Number'), h('th', 'Description'), h('th', 'Source'),
            h('th', 'Recognises to'), h('th', 'Period'), h('th.num', 'Total'),
            h('th.num', 'Released'), h('th.num', 'Remaining'), h('th', 'Progress'))),
          h('tbody', ...rows)))));
  }

  /** Preview first, then post. Nobody should write to the ledger blind. */
  function runDialog(dueRows) {
    const cfg = KINDS[kind];
    const through = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
    const preview = h('div', { style: { marginTop: '12px' } });
    let plan = null;

    const runPreview = async () => {
      mount(preview, loading('Working out what would post'));
      try {
        plan = await API.runRecognition({ kind, through: through.value, dry_run: true });
        mount(preview, planSummary(plan, cfg));
      } catch (e) { plan = null; mount(preview, empty('Could not preview the run', e.message)); }
    };
    through.addEventListener('change', runPreview);

    const m = modal({
      title: cfg.runLabel,
      size: 'wide',
      body: h('div',
        h('p.muted', { style: { marginTop: 0 } },
          `Every slice dated on or before this day is released. Slices whose period is closed are listed and left alone.`),
        h('div.field', h('label', 'Release everything up to'), through),
        preview),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Post entries', kind: 'primary',
          onClick: async (close) => {
            if (!plan || !plan.entries.length) { notifyError(new Error('There is nothing to post for that date.')); return false; }
            try {
              const res = await API.runRecognition({ kind, through: through.value });
              notifyOk(`${fmt.money(Math.round(res.amount * 100))} ${cfg.releaseVerb} across ${res.posted} journal ${res.posted === 1 ? 'entry' : 'entries'}.`,
                'Run complete');
              close(true);
              load();
            } catch (e) { notifyError(e); return false; }
          },
        },
      ],
    });
    runPreview();
    return m;
  }

  function planSummary(plan, cfg) {
    if (!plan.entries.length && !plan.deferred.length) {
      return h('div.muted', { style: { padding: '10px 0' } }, 'Nothing falls due on or before that date.');
    }
    const rows = plan.entries.map((e) => h('tr',
      h('td', fmt.date(e.date)),
      h('td.muted', `${e.lines} slice${e.lines === 1 ? '' : 's'}`),
      h('td', e.currency),
      h('td.num', fmt.money(Math.round(e.amount * 100), e.currency)),
      h('td.num', fmt.money(Math.round(e.base_amount * 100)))));
    const total = plan.entries.reduce((a, e) => a + e.base_amount, 0);
    return h('div',
      plan.entries.length
        ? h('div',
          facts([['Journal entries', String(plan.entries.length)],
            ['Total to be ' + cfg.releaseVerb, fmt.money(Math.round(total * 100))]]),
          h('div.grid-wrap', { style: { marginTop: '8px', maxHeight: '220px' } },
            h('table.grid',
              h('thead', h('tr', h('th', 'Posting date'), h('th', 'Slices'), h('th', 'Ccy'),
                h('th.num', 'Amount'), h('th.num', 'Base'))),
              h('tbody', ...rows))))
        : null,
      plan.deferred.length
        ? h('div.callout.warn', { style: { marginTop: '10px' } },
          h('strong', `${plan.deferred.length} group${plan.deferred.length === 1 ? '' : 's'} held back. `),
          plan.deferred.map((d) => `${fmt.date(d.plan_date)} — ${d.reason}`).join('; '),
          '. Reopen the period, or run again once it is open.')
        : null);
  }

  load();
  return h('div.page', h('div.page-head', head), host);
}
