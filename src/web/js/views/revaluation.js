// Meridian ERP :: web/views/revaluation
// What open foreign-currency balances are worth at the closing rate, against
// what the ledger is carrying them at.
//
// The screen is a working paper before it is a button. Every exposure shows
// its own two rates and the difference between them, because the number a
// controller has to defend at the audit is not "$1,240 gain" but "which
// invoices, at which rates". The run posts one entry on the closing date and
// its reversal on the first of the next month, and says so before it does it.
import { h, mount } from '../dom.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import * as store from '../store.js';
import { empty, notifyError, notifyOk, statusTag, loading, modal, facts, confirm } from '../ui.js';

const SCOPES = [
  ['receivable', 'Receivables', 'What customers owe in a currency that is not ours'],
  ['payable', 'Payables', 'What we owe suppliers abroad'],
  ['bank', 'Bank accounts', 'Cash sitting in a foreign account'],
];

/** Last day of the month `date` falls in — where a revaluation normally sits. */
function monthEnd(date) {
  const d = new Date(`${date}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

const rateText = (r) => (r ? Number(r).toFixed(4) : '—');

export async function revaluationView(route, { go }) {
  if (!store.can('revaluation_run')) {
    return h('div.page', empty('Not permitted', 'Your role cannot see currency revaluations.'));
  }
  const canRun = store.can('revaluation_run', store.LEVEL.EDIT);

  const host = h('div');
  const head = h('div');
  let asOf = monthEnd(fmt.today());
  let scopes = new Set(SCOPES.map(([k]) => k));
  let view = null;
  let runs = [];

  const dateInput = h('input', {
    type: 'date', value: asOf, style: { width: '150px' },
    onchange: (e) => { asOf = e.target.value || monthEnd(fmt.today()); load(); },
  });

  async function load() {
    mount(host, loading('Valuing the open balances'));
    try {
      const [exposures, history] = await Promise.all([
        API.fxExposures({ as_of: asOf, scopes: [...scopes].join(',') }),
        API.fxRuns({ limit: 12 }),
      ]);
      view = exposures;
      runs = history.rows || [];
      render();
    } catch (e) {
      view = null;
      mount(host, empty('Could not value the balances', e.message));
    }
  }

  function render() {
    mount(head,
      h('div.titles',
        h('h1', 'Currency Revaluation'),
        h('div.page-sub', 'Open foreign-currency balances at the closing rate, against what the ledger carries')),
      h('div.page-actions',
        h('div.field', { style: { minWidth: 0 } }, h('label', 'Value at'), dateInput),
        canRun
          ? h('button.btn.primary', {
            disabled: !view.lines.length || !!view.already,
            title: view.already ? `${view.already.run_no} already covered this date`
              : view.lines.length ? '' : 'Nothing has moved against the booked rate',
            onclick: runDialog,
          }, 'Post revaluation')
          : null));

    const chips = h('div.row.wrap', { style: { gap: '6px', marginBottom: '14px' } },
      ...SCOPES.map(([key, label, hint]) => h('button.tab', {
        class: scopes.has(key) ? 'active' : '',
        title: hint,
        onclick: () => {
          if (scopes.has(key)) { if (scopes.size === 1) return; scopes.delete(key); } else scopes.add(key);
          load();
        },
      }, label)));

    const kpis = h('div.kpi-grid', { style: { marginBottom: '14px' } },
      h('div.kpi',
        h('div.k-label', 'Net adjustment'),
        h('div.k-value', { class: view.net > 0 ? 'num-pos' : view.net < 0 ? 'num-neg' : '' },
          fmt.money(view.net, view.base_currency, { sign: true })),
        h('div.k-meta', view.net >= 0 ? 'A gain against the booked rates' : 'A loss against the booked rates')),
      h('div.kpi',
        h('div.k-label', 'Unrealised gain'),
        h('div.k-value.num-pos', fmt.money(view.gain, view.base_currency)),
        h('div.k-meta', 'Balances worth more than booked')),
      h('div.kpi',
        h('div.k-label', 'Unrealised loss'),
        h('div.k-value.num-neg', fmt.money(view.loss, view.base_currency)),
        h('div.k-meta', 'Balances worth less than booked')),
      h('div.kpi',
        h('div.k-label', 'Exposures'),
        h('div.k-value', String(view.lines.length)),
        h('div.k-meta', view.by_scope.length
          ? view.by_scope.map((s) => `${s.label.toLowerCase()} ${s.lines}`).join(' · ')
          : 'Nothing has moved')));

    if (!view.lines.length) {
      mount(host, chips, kpis,
        empty(view.already ? `${view.already.run_no} covered this date` : 'Nothing to revalue',
          `Every open balance at ${fmt.date(asOf)} is already carried at the rate on that date. Either there are no foreign-currency balances, or the rate has not moved since they were booked.`),
        historyCard());
      return;
    }

    const rows = [];
    for (const s of view.by_scope) {
      rows.push(h('tr.group-row', h('td', { colSpan: 8 },
        h('strong', s.label),
        h('span.muted', { style: { marginLeft: '8px', fontSize: '12px' } },
          `${s.lines} exposure${s.lines === 1 ? '' : 's'} · ${s.currencies.join(', ')}`),
        h('span', { style: { float: 'right' }, class: s.adjustment > 0 ? 'num-pos' : 'num-neg' },
          fmt.money(s.adjustment, view.base_currency, { sign: true })))));
      for (const l of view.lines.filter((x) => x.scope === s.scope)) {
        rows.push(h('tr',
          h('td', l.label),
          h('td', h('span.tag', l.currency)),
          h('td.num', fmt.money(l.foreign_amount, l.currency)),
          h('td.num.muted', rateText(l.rate_booked)),
          h('td.num.muted', rateText(l.rate_used)),
          h('td.num.muted', fmt.money(l.booked_base, view.base_currency)),
          h('td.num', fmt.money(l.revalued_base, view.base_currency)),
          h('td.num', h('strong', { class: l.adjustment > 0 ? 'num-pos' : 'num-neg' },
            fmt.money(l.adjustment, view.base_currency, { sign: true })))));
      }
    }

    // A revaluation restates the ledger, not the documents, so the same gap
    // is still on show once it is posted. Without saying which run covered
    // the date, the page reads as though nothing had been done.
    const done = view.already
      ? h('div.callout', { style: { marginBottom: '14px' } },
        h('strong', `${view.already.run_no} already revalued ${fmt.date(asOf)}. `),
        `It posted ${fmt.money(view.already.net, view.base_currency, { sign: true })} and reverses on ${fmt.date(view.already.reverse_on)}. `,
        'The exposures below are measured against the rates the documents were booked at, which a revaluation never changes — so they stay on show. Undo the run to value the date again.')
      : null;

    mount(host, chips, kpis, done,
      h('div.card',
        h('div.card-head', h('h2', `Exposures at ${fmt.date(asOf)}`),
          h('span.muted', { style: { fontSize: '12px' } }, `Reported in ${view.base_currency}`)),
        h('div.grid-wrap', h('table.grid',
          h('thead', h('tr',
            h('th', 'Exposure'), h('th', 'Ccy'), h('th.num', 'Balance'),
            h('th.num', 'Booked at'), h('th.num', 'Closing'),
            h('th.num', 'Carried'), h('th.num', 'Worth'), h('th.num', 'Adjustment'))),
          h('tbody', ...rows)))),
      historyCard());
  }

  function historyCard() {
    if (!runs.length) return null;
    return h('div.card', { style: { marginTop: '14px' } },
      h('div.card-head', h('h2', 'Previous runs')),
      h('div.grid-wrap', h('table.grid',
        h('thead', h('tr', h('th', 'Run'), h('th', 'Valued at'), h('th', 'Reverses'),
          h('th', 'Included'), h('th.num', 'Gain'), h('th.num', 'Loss'), h('th.num', 'Net'),
          h('th', 'Status'), h('th', ''))),
        h('tbody', ...runs.map((r) => h('tr.clickable', { onclick: () => go(`/record/revaluation_run/${r.id}`) },
          h('td', h('strong', r.run_no)),
          h('td', fmt.date(r.as_of)),
          h('td.muted', fmt.date(r.reverse_on)),
          h('td.muted', (r.scopes || []).map((x) => fmt.titleCase(x)).join(', ')),
          h('td.num.num-pos', fmt.money(r.gain, r.base_currency)),
          h('td.num.num-neg', fmt.money(r.loss, r.base_currency)),
          h('td.num', fmt.money(r.net, r.base_currency, { sign: true })),
          h('td', statusTag(r.status)),
          h('td', { onclick: (e) => e.stopPropagation() },
            canRun && r.status === 'posted'
              ? h('button.btn.sm', { onclick: () => undoRun(r) }, 'Undo')
              : null)))))));
  }

  async function undoRun(r) {
    const ok = await confirm({
      title: `Undo ${r.run_no}?`,
      message: `Both halves of the run are cancelled — the ${fmt.date(r.as_of)} adjustment and the ${fmt.date(r.reverse_on)} reversal — leaving the books where they were.`,
      detail: 'Nothing is deleted: four entries stay on the record, netting to nothing. Both dates have to be in open periods.',
      confirmLabel: 'Undo the run',
      danger: true,
    });
    if (!ok) return;
    try {
      await API.reverseFxRun(r.id, { reason: 'Undone from the revaluation screen' });
      notifyOk(`${r.run_no} undone.`);
      load();
    } catch (e) { notifyError(e); }
  }

  /** Say what will be posted, and where it reverses, before posting it. */
  function runDialog() {
    const memo = h('input', { type: 'text', placeholder: `Foreign currency revaluation at ${asOf}` });
    return modal({
      title: 'Post revaluation',
      size: 'wide',
      body: h('div',
        facts([
          ['Valued at', fmt.date(asOf)],
          ['Included', view.by_scope.map((s) => s.label).join(', ')],
          ['Unrealised gain', fmt.money(view.gain, view.base_currency)],
          ['Unrealised loss', fmt.money(view.loss, view.base_currency)],
          ['Net to post', fmt.money(view.net, view.base_currency, { sign: true })],
        ]),
        h('div.callout', { style: { marginTop: '10px' } },
          'One entry on ', h('strong', fmt.date(asOf)),
          ' restates the control and bank accounts, with the difference to Unrealised FX Gain/Loss. Its reversal posts on the first day of the next period, so the documents keep the rates they were booked at and settlement still works out the realised difference when the money arrives.'),
        h('div.field', { style: { marginTop: '10px' } }, h('label', 'Memo'), memo)),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Post it', kind: 'primary',
          onClick: async (close) => {
            try {
              const res = await API.runFxRevaluation({ as_of: asOf, scopes: [...scopes], memo: memo.value || '' });
              notifyOk(`${res.run.run_no} posted — ${fmt.money(res.run.net, res.base_currency, { sign: true })}, reversing on ${fmt.date(res.run.reverse_on)}.`,
                'Revaluation complete');
              close(true);
              load();
            } catch (e) { notifyError(e); return false; }
          },
        },
      ],
    });
  }

  load();
  return h('div.page', h('div.page-head', head), host);
}
