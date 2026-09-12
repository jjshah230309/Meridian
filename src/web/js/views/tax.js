// Meridian ERP :: web/views/tax
// The sales tax return, and the year's 1099s.
//
// A return screen has to answer two questions at once: what is the number,
// and where did it come from. So the boxes lead, the tax codes explain them,
// and the transactions behind them are one click away — including the late
// ones, which are called out by name because a figure that includes a bill
// from two quarters ago is otherwise inexplicable.
import { h, mount } from '../dom.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import * as store from '../store.js';
import { empty, notifyError, notifyOk, statusTag, loading, modal, facts, confirm } from '../ui.js';

const TABS = [['return', 'Sales tax'], ['1099', '1099']];

/** The quarter `date` falls in, as a from/to pair. */
function quarterOf(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const q = Math.floor(d.getUTCMonth() / 3);
  const from = new Date(Date.UTC(d.getUTCFullYear(), q * 3, 1));
  const to = new Date(Date.UTC(d.getUTCFullYear(), q * 3 + 3, 0));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export async function taxView(route, { go }) {
  if (!store.can('tax_return')) {
    return h('div.page', empty('Not permitted', 'Your role cannot see tax returns.'));
  }
  const canFile = store.can('tax_return', store.LEVEL.CREATE);
  const canUnfile = store.can('tax_return', store.LEVEL.FULL);

  let tab = TABS.some(([k]) => k === route.parts[1]) ? route.parts[1] : 'return';
  // Open on the quarter in progress. It is the one with unreturned
  // transactions in it; the previous one has usually gone in already.
  const now = fmt.today();
  let period = quarterOf(now);
  let year = Number(now.slice(0, 4));

  const host = h('div');
  const head = h('div');
  let data = null;

  const tabs = () => h('div.tabs', { style: { marginBottom: '14px' } },
    ...TABS.map(([k, label]) => h('button.tab', {
      class: k === tab ? 'active' : '',
      onclick: () => { if (k === tab) return; tab = k; go(k === 'return' ? '/tax' : `/tax/${k}`); },
    }, label)));

  async function load() {
    mount(host, loading(tab === '1099' ? 'Totalling what was paid' : 'Reading the tax on every transaction'));
    try {
      if (tab === '1099') {
        data = await API.report1099({ year, include_below: true });
        render1099();
      } else {
        const [preview, history] = await Promise.all([
          API.taxReturnPreview({ period_from: period.from, period_to: period.to }),
          API.taxReturns({ limit: 12 }),
        ]);
        data = { preview, history: history.rows || [] };
        renderReturn();
      }
    } catch (e) {
      mount(host, empty('Could not work out the tax', e.message));
    }
  }

  // --------------------------------------------------------- sales tax
  function renderReturn() {
    const v = data.preview;
    const owed = v.net_tax >= 0;
    const from = h('input', {
      type: 'date', value: period.from, style: { width: '145px' },
      onchange: (e) => { period = { ...period, from: e.target.value }; load(); },
    });
    const to = h('input', {
      type: 'date', value: period.to, style: { width: '145px' },
      onchange: (e) => { period = { ...period, to: e.target.value }; load(); },
    });

    mount(head,
      h('div.titles',
        h('h1', 'Tax'),
        h('div.page-sub', 'Tax charged on sales against tax suffered on purchases, and the 1099s at year end')),
      h('div.page-actions',
        h('div.field', h('label', 'From'), from),
        h('div.field', h('label', 'To'), to),
        canFile
          ? h('button.btn.primary', {
            disabled: !v.txn_count,
            title: v.txn_count ? '' : 'Nothing is outstanding for that period',
            onclick: () => fileDialog(v),
          }, 'File the return')
          : null));

    const kpis = h('div.kpi-grid', { style: { marginBottom: '14px' } },
      h('div.kpi',
        h('div.k-label', 'Tax on sales'),
        h('div.k-value', fmt.moneyCompact(v.output_tax, v.currency)),
        h('div.k-meta', `${fmt.moneyCompact(v.sales_net, v.currency)} of net sales`)),
      h('div.kpi',
        h('div.k-label', 'Tax on purchases'),
        h('div.k-value', fmt.moneyCompact(v.input_tax, v.currency)),
        h('div.k-meta', `${fmt.moneyCompact(v.purchases_net, v.currency)} of net purchases`)),
      h('div.kpi',
        h('div.k-label', owed ? 'Payable' : 'Reclaimable'),
        h('div.k-value', { class: owed ? 'num-neg' : 'num-pos' }, fmt.money(Math.abs(v.net_tax), v.currency)),
        h('div.k-meta', `${v.txn_count} transaction${v.txn_count === 1 ? '' : 's'} in this return`)),
      h('div.kpi',
        h('div.k-label', 'Brought in late'),
        h('div.k-value', String(v.late_count)),
        h('div.k-meta', v.late_count
          ? `${fmt.money(v.late_tax, v.currency, { sign: true })} from before ${fmt.dateShort(v.period_from)}`
          : 'Nothing missed from earlier periods')));

    const hasControl = v.control_balance !== null;

    mount(host, tabs(), kpis,
      v.late_count
        ? h('div.callout', { style: { marginBottom: '14px' } },
          h('strong', `${v.late_count} transaction${v.late_count === 1 ? '' : 's'} dated before ${fmt.date(v.period_from)} had never been returned. `),
          'They are included here rather than left behind a filed quarter, which is how the authority expects a late claim to be made.')
        : null,
      hasControl
        ? h('div.card', { style: { marginBottom: '14px' } },
          h('div.card-head', h('h2', 'The tax account, broken down'),
            h('span.muted', { style: { fontSize: '12px' } }, `Account 2100 at ${fmt.date(v.period_to)}`)),
          h('div.grid-wrap', h('table.grid',
            h('tbody',
              h('tr', h('td', 'Accruing in this return'), h('td.num', fmt.money(v.net_tax, v.currency))),
              h('tr', h('td', 'Returns already filed, not yet paid over'), h('td.num', fmt.money(v.filed_total, v.currency))),
              h('tr', h('td',
                'Payments to the authority and other journals',
                h('div.muted', { style: { fontSize: '11.5px' } },
                  'Anything on the account that no return accounts for. It should be the money actually paid over — a figure you do not recognise belongs somewhere else.')),
                h('td.num', { class: v.other_movement ? '' : 'muted' }, fmt.money(v.other_movement, v.currency))),
              h('tr.subtotal', h('td', 'Carried on the account'), h('td.num', fmt.money(v.control_balance, v.currency)))))))
        : null,
      !v.txn_count
        ? empty('Nothing to return for that period',
          'Every taxable transaction dated on or before the end date has already been included in a filed return.')
        : h('div.card',
          h('div.card-head', h('h2', `By tax code, ${fmt.date(v.period_from)} to ${fmt.date(v.period_to)}`),
            h('button.btn.sm', { onclick: () => documentsDialog(v) }, `${v.txn_count} transactions`)),
          h('div.grid-wrap', h('table.grid',
            h('thead', h('tr', h('th', 'Code'), h('th', 'Description'), h('th.num', 'Rate'),
              h('th.num', 'Sales net'), h('th.num', 'Tax on sales'),
              h('th.num', 'Purchases net'), h('th.num', 'Tax on purchases'))),
            h('tbody',
              ...v.lines.map((l) => h('tr',
                h('td', h('span.mono', l.tax_code)),
                h('td.muted', l.name),
                h('td.num.muted', `${l.rate}%`),
                h('td.num', fmt.money(l.sales_net, v.currency)),
                h('td.num', fmt.money(l.output_tax, v.currency)),
                h('td.num', fmt.money(l.purchases_net, v.currency)),
                h('td.num', fmt.money(l.input_tax, v.currency)))),
              h('tr.subtotal',
                h('td', 'Total'), h('td', ''), h('td', ''),
                h('td.num', fmt.money(v.sales_net, v.currency)),
                h('td.num', fmt.money(v.output_tax, v.currency)),
                h('td.num', fmt.money(v.purchases_net, v.currency)),
                h('td.num', fmt.money(v.input_tax, v.currency)))))),
          h('div.card-body',
            h('div.row', { style: { justifyContent: 'flex-end', gap: '14px', alignItems: 'baseline' } },
              h('span.muted', owed ? 'Net payable to the authority' : 'Net reclaimable from the authority'),
              h('span', { style: { fontSize: '17px', fontWeight: 600 }, class: owed ? 'num-neg' : 'num-pos' },
                fmt.money(Math.abs(v.net_tax), v.currency))))),
      historyCard());
  }

  function historyCard() {
    const rows = data.history || [];
    if (!rows.length) return null;
    return h('div.card', { style: { marginTop: '14px' } },
      h('div.card-head', h('h2', 'Filed returns')),
      h('div.grid-wrap', h('table.grid',
        h('thead', h('tr', h('th', 'Return'), h('th', 'Period'), h('th.num', 'Tax on sales'),
          h('th.num', 'Tax on purchases'), h('th.num', 'Net'), h('th.num', 'Late items'),
          h('th', 'Reference'), h('th', 'Status'), h('th', ''))),
        h('tbody', ...rows.map((r) => h('tr.clickable', { onclick: () => go(`/record/tax_return/${r.id}`) },
          h('td', h('strong', r.return_no)),
          h('td', `${fmt.dateShort(r.period_from)} → ${fmt.dateShort(r.period_to)}`),
          h('td.num', fmt.money(r.output_tax, r.currency)),
          h('td.num', fmt.money(r.input_tax, r.currency)),
          h('td.num', h('strong', fmt.money(r.net_tax, r.currency, { sign: true }))),
          h('td.num.muted', r.late_count ? String(r.late_count) : '—'),
          h('td.muted', r.reference || '—'),
          h('td', statusTag(r.status)),
          h('td', { onclick: (e) => e.stopPropagation() },
            h('div.row', { style: { gap: '4px' } },
              h('button.btn.sm', { onclick: () => API.taxReturnPdf(r.id).catch(notifyError) }, 'PDF'),
              canUnfile && r.status === 'filed'
                ? h('button.btn.sm', { onclick: () => unfile(r) }, 'Unfile')
                : null)))))))); 
  }

  function documentsDialog(v) {
    const m = modal({
      title: `${v.txn_count} transactions in this return`,
      size: 'wide',
      body: h('div',
        h('p.muted', { style: { marginTop: 0 } },
          'Everything taxable that has not been returned yet, whatever its date. A row marked late is dated before the period and was entered after the quarter covering it had already gone in.'),
        h('div.grid-wrap', { style: { maxHeight: '340px' } }, h('table.grid',
          h('thead', h('tr', h('th', 'Document'), h('th', 'Date'), h('th', 'Type'),
            h('th.num', 'Net'), h('th.num', 'Tax'), h('th.num', 'Effect on return'), h('th', ''))),
          h('tbody', ...v.documents.map((d) => h('tr.clickable', {
            onclick: () => { m.close(); go(`/txn/${d.txn_id}`); },
          },
          h('td', h('strong', d.txn_no)),
          h('td', fmt.date(d.txn_date)),
          h('td.muted', fmt.titleCase(String(d.type).replace(/_/g, ' ').toLowerCase())),
          h('td.num', fmt.money(d.net, v.currency)),
          h('td.num', fmt.money(d.tax, v.currency)),
          h('td.num', { class: d.effect >= 0 ? '' : 'num-pos' }, fmt.money(d.effect, v.currency, { sign: true })),
          h('td', d.late ? h('span.tag.amber', 'Late') : null))))))),
      actions: [{ label: 'Close', value: null }],
    });
    return m;
  }

  function fileDialog(v) {
    const reference = h('input', { type: 'text', placeholder: 'The authority’s receipt or submission id' });
    const note = h('input', { type: 'text', placeholder: 'Anything worth remembering about this filing' });
    const owed = v.net_tax >= 0;
    return modal({
      title: `File ${fmt.date(v.period_from)} to ${fmt.date(v.period_to)}`,
      body: h('div',
        facts([
          ['Tax on sales', fmt.money(v.output_tax, v.currency)],
          ['Tax on purchases', fmt.money(v.input_tax, v.currency)],
          [owed ? 'Payable' : 'Reclaimable', fmt.money(Math.abs(v.net_tax), v.currency)],
          ['Transactions', String(v.txn_count)],
          ['Of those, late', v.late_count ? `${v.late_count} (${fmt.money(v.late_tax, v.currency, { sign: true })})` : 'none'],
        ]),
        h('div.callout', { style: { marginTop: '10px' } },
          'Filing freezes these figures and marks every transaction behind them, so none of them can appear on another return. Anything entered afterwards against this period falls into the next one, which is what the authority expects of a late claim.'),
        h('div.field', { style: { marginTop: '10px' } }, h('label', 'Authority reference'), reference),
        h('div.field', h('label', 'Note'), note)),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'File it', kind: 'primary',
          onClick: async (close) => {
            try {
              const filed = await API.fileTaxReturn({
                period_from: v.period_from, period_to: v.period_to,
                reference: reference.value || '', note: note.value || '',
              });
              notifyOk(`${filed.return_no} filed — ${fmt.money(filed.net_tax, filed.currency, { sign: true })} across ${filed.txn_count} transactions.`,
                'Return filed');
              close(true); load();
            } catch (e) { notifyError(e); return false; }
          },
        },
      ],
    });
  }

  async function unfile(r) {
    const ok = await confirm({
      title: `Unfile ${r.return_no}?`,
      message: 'Every transaction it claimed goes back on the table and will be picked up by the next return.',
      detail: 'Use this only where the return was never actually submitted, or was submitted in error.',
      confirmLabel: 'Unfile it', danger: true,
    });
    if (!ok) return;
    try {
      await API.unfileTaxReturn(r.id, { reason: 'Unfiled from the tax screen' });
      notifyOk(`${r.return_no} unfiled.`);
      load();
    } catch (e) { notifyError(e); }
  }

  // -------------------------------------------------------------- 1099
  function render1099() {
    const r = data;
    const yearInput = h('input', {
      type: 'number', value: String(year), min: '2000', max: '2100', style: { width: '90px' }, class: 'num',
      onchange: (e) => { year = Number(e.target.value) || year; load(); },
    });

    mount(head,
      h('div.titles',
        h('h1', 'Tax'),
        h('div.page-sub', 'Tax charged on sales against tax suffered on purchases, and the 1099s at year end')),
      h('div.page-actions',
        h('div.field', h('label', 'Year'), yearInput),
        h('button.btn', { onclick: () => API.export1099(year, 'pdf').catch(notifyError) }, 'Summary PDF'),
        h('button.btn.primary', { onclick: () => API.export1099(year, 'csv').catch(notifyError) }, 'Export for filing')));

    const reportable = r.rows.filter((x) => x.reportable);
    const kpis = h('div.kpi-grid', { style: { marginBottom: '14px' } },
      h('div.kpi',
        h('div.k-label', 'Reportable suppliers'),
        h('div.k-value', String(r.vendor_count)),
        h('div.k-meta', `Paid ${fmt.money(r.threshold)} or more in ${r.year}`)),
      h('div.kpi',
        h('div.k-label', 'Total reported'),
        h('div.k-value', fmt.moneyCompact(r.total)),
        h('div.k-meta', 'Cash paid, not bills entered')),
      h('div.kpi',
        h('div.k-label', 'Below the threshold'),
        h('div.k-value', String(r.below_threshold)),
        h('div.k-meta', 'Flagged, but no form required')),
      h('div.kpi',
        h('div.k-label', 'Missing details'),
        h('div.k-value', { class: r.incomplete ? 'num-neg' : '' }, String(r.incomplete)),
        h('div.k-meta', r.incomplete ? 'A form needs a tax number and an address' : 'Every form can be filed')));

    if (!r.rows.length) {
      mount(host, tabs(), kpis,
        empty(`No reportable suppliers in ${r.year}`,
          'Flag a supplier as a 1099 vendor on their record and their payments for the year appear here.'));
      return;
    }

    mount(host, tabs(), kpis,
      r.incomplete
        ? h('div.callout.warn', { style: { marginBottom: '14px' } },
          h('strong', `${r.incomplete} supplier${r.incomplete === 1 ? '' : 's'} cannot be filed yet. `),
          'A 1099 needs both a tax number and a postal address. They are marked below.')
        : null,
      h('div.card',
        h('div.card-head', h('h2', `Payments in ${r.year}`),
          h('span.muted', { style: { fontSize: '12px' } }, 'Cash basis — a December bill paid in January is next year’s form')),
        h('div.grid-wrap', h('table.grid',
          h('thead', h('tr', h('th', 'Supplier'), h('th', 'Tax number'), h('th', 'Form'),
            h('th', 'Box'), h('th.num', 'Payments'), h('th.num', 'Paid'), h('th', ''))),
          h('tbody',
            ...r.rows.map((x) => h('tr.clickable', { onclick: () => go(`/record/vendor/${x.vendor_id}`) },
              h('td', h('strong', x.name), h('div.muted', { style: { fontSize: '11.5px' } }, x.entity_no)),
              h('td', x.tax_number ? h('span.mono', x.tax_number) : h('span.tag.red', 'Missing')),
              h('td.muted', x.tax_form || '1099-NEC'),
              h('td.muted', x.tax_form_box || '1'),
              h('td.num.muted', String(x.payments)),
              h('td.num', h('strong', fmt.money(x.paid))),
              h('td', x.reportable
                ? (x.missing.length
                  ? h('span.tag.amber', { title: `Missing ${x.missing.join(' and ')}` }, `No ${x.missing[0]}`)
                  : h('span.tag.green', 'Ready'))
                : h('span.faint', 'Below threshold')))),
            reportable.length
              ? h('tr.subtotal',
                h('td', 'Reportable total'), h('td', ''), h('td', ''), h('td', ''),
                h('td.num', String(reportable.reduce((a, x) => a + x.payments, 0))),
                h('td.num', fmt.money(r.total)), h('td', ''))
              : null)))));
  }

  load();
  return h('div.page', h('div.page-head', head), host);
}
