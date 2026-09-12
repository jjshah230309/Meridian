// Meridian ERP :: web/views/subscriptions
// Recurring revenue, and the run that turns it into invoices.
//
// The index leads with what a subscription business is actually run on —
// monthly recurring revenue, what is due to bill, what is up for renewal —
// because those are the three numbers somebody opens this screen for. The
// contracts are underneath.
//
// A billing run is preview-first: every period it would charge, on screen,
// before an invoice exists.
import { h, mount, clear } from '../dom.js';
import { icon } from '../icons.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import * as store from '../store.js';
import { empty, notifyError, notifyOk, statusTag, loading, modal, facts, fieldControl } from '../ui.js';

const FREQ_LABEL = { monthly: 'Monthly', quarterly: 'Quarterly', annually: 'Annually' };
const MODEL_LABEL = { recurring: 'Recurring', one_time: 'One-off', usage: 'Metered' };

export async function subscriptionsView(route, { go }) {
  if (!store.can('subscription')) {
    return h('div.page', empty('Not permitted', 'Your role cannot see subscriptions.'));
  }
  const canEdit = store.can('subscription', store.LEVEL.EDIT);
  const canCreate = store.can('subscription', store.LEVEL.CREATE);
  const canBill = canEdit && store.can('invoice', store.LEVEL.CREATE);
  const openId = route.parts[1] && route.parts[1] !== 'new' ? route.parts[1] : null;

  const host = h('div');
  const head = h('div');
  let filter = 'active';

  async function load() {
    mount(host, loading('Reading the contracts'));
    try {
      if (openId) { renderOne(await API.subscription(openId)); return; }
      renderIndex(await API.subscriptions({ status: filter }));
    } catch (e) { mount(host, empty('Could not open subscriptions', e.message)); }
  }

  // --------------------------------------------------------------- index
  function renderIndex(data) {
    const due = data.due || [];
    const rr = data.revenue;
    mount(head,
      h('div.titles',
        h('h1', 'Subscriptions'),
        h('div.page-sub', 'What recurs, what it is worth a month, and what is due to be invoiced')),
      h('div.page-actions',
        canCreate ? h('button.btn', { onclick: () => editor(null) }, 'New subscription') : null,
        canBill
          ? h('button.btn.primary', {
            disabled: !due.length,
            title: due.length ? '' : 'Nothing is due to bill today',
            onclick: () => billingDialog(),
          }, due.length ? `Bill ${due.length}` : 'Bill due')
          : null));

    if (!data.rows.length && filter === 'active') {
      mount(host, empty('No subscriptions yet',
        'A subscription is a contract with a term, a price that can change part way through, and seats that come and go. '
        + 'The invoices fall out of it — one per run, carrying every period owed.',
        canCreate ? h('button.btn.primary', { onclick: () => editor(null) }, 'New subscription') : null));
      return;
    }

    const kpis = h('div.kpi-grid', { style: { marginBottom: 'var(--s5)' } },
      h('div.kpi',
        h('div.k-label', 'Monthly recurring'),
        h('div.k-value', fmt.moneyCompact(rr.mrr, rr.currency)),
        h('div.k-meta', `${rr.subscriptions} active · ${fmt.money(rr.average, rr.currency)} average`)),
      h('div.kpi',
        h('div.k-label', 'Annual run rate'),
        h('div.k-value', fmt.moneyCompact(rr.arr, rr.currency)),
        h('div.k-meta', `Monthly value, twelve times over, in ${rr.currency}`)),
      h('div.kpi',
        h('div.k-label', 'Due to bill'),
        h('div.k-value', { class: due.length ? 'num-neg' : '' }, String(due.length)),
        h('div.k-meta', due.length ? `Earliest ${fmt.dateShort(due[0].next_bill_date)}` : 'Everything is up to date')),
      h('div.kpi',
        h('div.k-label', 'Renewing in 90 days'),
        h('div.k-value', String(rr.renewals_due.length)),
        h('div.k-meta', rr.renewals_due.filter((x) => !x.auto_renew).length
          ? `${rr.renewals_due.filter((x) => !x.auto_renew).length} will not renew on their own`
          : 'All set to renew automatically')));

    const rateWarning = rr.missing_rates?.length
      ? h('div.callout.warn', { style: { marginBottom: 'var(--s5)' } },
        'These totals leave out contracts in ', h('strong', rr.missing_rates.join(', ')),
        `: there is no exchange rate into ${rr.currency} on or before today. `,
        'Add one under Setup → Exchange Rates and the figures will include them.')
      : null;

    const tabs = h('div.tabs', { style: { marginBottom: 'var(--s5)' } },
      ...[['active', 'Active'], ['draft', 'Draft'], ['suspended', 'Suspended'],
        ['cancelled', 'Cancelled'], ['expired', 'Expired'], ['all', 'All']]
        .map(([k, label]) => h('button.tab', {
          class: k === filter ? 'active' : '',
          onclick: () => { if (k === filter) return; filter = k; load(); },
        }, label)));

    mount(host, kpis, rateWarning, tabs,
      h('div.card',
        h('div.card-head', h('h2', 'Contracts'),
          h('span.muted', { style: { fontSize: 'var(--t-sm)' } }, `${data.total} ${filter === 'all' ? 'in total' : filter}`)),
        data.rows.length
          ? h('div.grid-wrap', h('table.grid',
            h('thead', h('tr', h('th', 'Subscription'), h('th', 'Customer'), h('th', 'Bills'),
              h('th', 'Term ends'), h('th', 'Next bill'), h('th.num', 'Lines'),
              h('th.num', 'Monthly'), h('th', 'Status'))),
            h('tbody', ...data.rows.map((s) => h('tr.clickable', { onclick: () => go(`/subscriptions/${s.id}`) },
              h('td', h('strong', s.subscription_no), s.name ? h('div.muted', { style: { fontSize: 'var(--t-xs)' } }, s.name) : null),
              h('td', s.customer_name, h('div.muted', { style: { fontSize: 'var(--t-xs)' } }, s.customer_no)),
              h('td.muted', FREQ_LABEL[s.billing_frequency] || s.billing_frequency,
                s.bill_in_advance ? '' : h('span.tag', { style: { marginLeft: 'var(--s1)' } }, 'arrears')),
              h('td.muted', s.end_date ? fmt.date(s.end_date) : h('span.faint', 'Evergreen')),
              h('td', { class: s.next_bill_date && s.next_bill_date <= fmt.today() && s.status === 'active' ? 'num-neg' : '' },
                s.next_bill_date ? fmt.date(s.next_bill_date) : h('span.faint', '—')),
              h('td.num.muted', String(s.line_count)),
              h('td.num', h('strong', fmt.money(s.mrr, s.currency))),
              h('td', statusTag(s.status)))))))
          : h('div.card-body', h('div.muted', `Nothing ${filter === 'all' ? 'here' : `is ${filter}`}.`))),
      rr.renewals_due.length
        ? h('div.card', { style: { marginTop: 'var(--s4)' } },
          h('div.card-head', h('h2', 'Coming up for renewal'),
            h('span.muted', { style: { fontSize: 'var(--t-sm)' } }, 'Within ninety days')),
          h('div.grid-wrap', h('table.grid',
            h('thead', h('tr', h('th', 'Subscription'), h('th', 'Customer'), h('th', 'Term ends'), h('th.num', 'Monthly'), h('th', 'Renews'))),
            h('tbody', ...rr.renewals_due.map((x) => h('tr.clickable', { onclick: () => go(`/subscriptions/${x.subscription_id}`) },
              h('td', h('strong', x.subscription_no)),
              h('td', x.customer_name),
              h('td', fmt.date(x.end_date)),
              h('td.num', fmt.money(x.mrr, x.currency)),
              h('td', x.auto_renew ? h('span.tag.green', 'Automatically') : h('span.tag.amber', 'Needs a decision'))))))))
        : null);
  }

  // ----------------------------------------------------------------- one
  function renderOne(data) {
    const s = data.subscription;
    const live = s.status === 'active';
    mount(head,
      h('div.titles',
        h('div.breadcrumb', h('a', { href: '#/subscriptions', onclick: (e) => { e.preventDefault(); go('/subscriptions'); } }, 'Subscriptions')),
        h('h1', s.subscription_no, ' ', statusTag(s.status)),
        h('div.page-sub',
          `${s.customer?.name || ''} · ${FREQ_LABEL[s.billing_frequency]} ${s.bill_in_advance ? 'in advance' : 'in arrears'}`
          + (s.end_date ? ` · term ends ${s.end_date}` : ' · evergreen'))),
      h('div.page-actions',
        canEdit && ['draft', 'active', 'suspended'].includes(s.status)
          ? h('button.btn', { onclick: () => editor(s) }, 'Edit') : null,
        canEdit && s.status === 'draft' ? h('button.btn', { onclick: () => activate(s) }, 'Activate') : null,
        canEdit && live ? h('button.btn', { onclick: () => amendDialog(s) }, 'Amend') : null,
        canEdit && live ? h('button.btn', { onclick: () => suspend(s) }, 'Suspend') : null,
        canEdit && s.status === 'suspended' ? h('button.btn', { onclick: () => resume(s) }, 'Resume') : null,
        canEdit && ['active', 'suspended', 'draft'].includes(s.status)
          ? h('button.btn.danger', { onclick: () => cancelDialog(s) }, 'Cancel') : null,
        canBill && live && s.next_bill_date
          ? h('button.btn.primary', { onclick: () => billingDialog(s) }, 'Bill it') : null));

    const usageLines = s.lines.filter((l) => l.model === 'usage' && l.status === 'active');

    mount(host,
      h('div.card',
        h('div.card-head', h('h2', s.name || 'Contract')),
        h('div.card-body',
          facts([
            ['Customer', s.customer?.name || '—'],
            ['Monthly value', fmt.money(s.mrr, s.currency)],
            ['Started', fmt.date(s.start_date)],
            ['Term ends', s.end_date ? fmt.date(s.end_date) : 'Evergreen'],
            ['Billed to', s.billed_through ? fmt.date(s.billed_through) : 'Nothing yet'],
            ['Next bill', s.next_bill_date ? fmt.date(s.next_bill_date) : '—'],
            ['Renews', s.auto_renew ? `Automatically, ${s.renewal_term_months || s.term_months} months at a time` : 'Not automatically'],
            ['Renewals so far', String(s.renewal_count)],
            ['PO number', s.po_number || '—'],
          ]))),

      h('div.card',
        h('div.card-head', h('h2', 'What is being sold')),
        h('div.grid-wrap', h('table.grid',
          h('thead', h('tr', h('th', '#'), h('th', 'Item'), h('th', 'Model'), h('th.num', 'Quantity'),
            h('th.num', 'Unit price'), h('th', 'From'), h('th', 'To'), h('th.num', 'Per period'))),
          h('tbody', ...s.lines.map((l) => h('tr', { style: l.status === 'removed' ? { opacity: '.55' } : {} },
            h('td.muted', String(l.line_no)),
            h('td', h('strong', l.sku), ' ', l.description),
            h('td', h('span.tag', MODEL_LABEL[l.model] || l.model),
              l.status === 'removed' ? h('span.tag.red', { style: { marginLeft: 'var(--s1)' } }, 'removed') : null),
            h('td.num', l.model === 'usage' ? h('span.faint', 'metered') : fmt.qty(l.quantity)),
            h('td.num', fmt.money(l.unit_price, s.currency),
              l.model === 'usage' && l.usage_uom ? h('div.muted', { style: { fontSize: 'var(--t-xs)' } }, `per ${l.usage_uom}`) : null),
            h('td.muted', fmt.dateShort(l.start_date)),
            h('td.muted', l.end_date ? fmt.dateShort(l.end_date) : h('span.faint', '—')),
            h('td.num', l.model === 'recurring'
              ? fmt.money(Math.round(l.quantity / 1e6 * l.unit_price * (1 - (l.discount_pct || 0) / 100)), s.currency)
              : h('span.faint', '—')))))))),

      usageLines.length
        ? h('div.card',
          h('div.card-head', h('h2', 'Metered usage'),
            canEdit && live
              ? h('button.btn.sm', { onclick: () => usageDialog(s, usageLines) }, 'Record usage')
              : null),
          data.usage.length
            ? h('div.grid-wrap', { style: { maxHeight: '260px' } }, h('table.grid',
              h('thead', h('tr', h('th', 'Date'), h('th', 'Line'), h('th.num', 'Quantity'), h('th', 'Note'), h('th', 'Billed'))),
              h('tbody', ...data.usage.map((u) => h('tr',
                h('td', fmt.date(u.usage_date)),
                h('td.muted', u.description),
                h('td.num', `${fmt.qty(u.quantity)} ${u.usage_uom || ''}`),
                h('td.muted', u.memo || '—'),
                h('td', u.billing_id ? h('span.tag.green', 'Invoiced') : h('span.tag.amber', 'Not yet')))))))
            : h('div.card-body', h('div.muted', 'Nothing metered yet this period.')))
        : null,

      data.billing.length
        ? h('div.card',
          h('div.card-head', h('h2', 'What has been billed'),
            h('span.muted', { style: { fontSize: 'var(--t-sm)' } }, `${data.billing.length} period${data.billing.length === 1 ? '' : 's'}`)),
          h('div.grid-wrap', { style: { maxHeight: '360px' } }, h('table.grid',
            h('thead', h('tr', h('th', 'Period'), h('th', 'Item'), h('th.num', 'Quantity'),
              h('th.num', 'Amount'), h('th', 'Invoice'))),
            h('tbody', ...data.billing.map((b) => h('tr.clickable', {
              onclick: () => b.invoice_txn_id && go(`/txn/${b.invoice_txn_id}`),
            },
            h('td', `${fmt.dateShort(b.period_start)} → ${fmt.dateShort(fmt.addDays(b.period_end, -1))}`,
              b.prorated ? h('span.tag.amber', { style: { marginLeft: 'var(--s1)' } }, `${Math.round(b.proration * 100)}%`) : null),
            h('td.muted', b.sku),
            h('td.num.muted', fmt.qty(b.quantity)),
            h('td.num', fmt.money(b.amount, s.currency)),
            h('td', b.txn_no ? h('span.mono', b.txn_no) : h('span.faint', '—'))))))))
        : null,

      s.changes.length
        ? h('div.card',
          h('div.card-head', h('h2', 'Amendments')),
          h('div.grid-wrap', h('table.grid',
            h('thead', h('tr', h('th', 'Effective'), h('th', 'Change'), h('th', 'From'), h('th', 'To'), h('th', 'Note'))),
            h('tbody', ...s.changes.map((c) => h('tr',
              h('td', fmt.date(c.effective_date)),
              h('td', h('span.tag', fmt.titleCase(c.kind))),
              h('td.muted', c.from_value || '—'),
              h('td.muted', c.to_value || '—'),
              h('td.muted', c.note || '—')))))))
        : null);
  }

  // ------------------------------------------------------------- actions
  const activate = async (s) => {
    try { await API.activateSubscription(s.id); notifyOk(`${s.subscription_no} is live.`); load(); }
    catch (e) { notifyError(e); }
  };
  const resume = async (s) => {
    try { await API.resumeSubscription(s.id); notifyOk(`${s.subscription_no} is billing again.`); load(); }
    catch (e) { notifyError(e); }
  };

  async function suspend(s) {
    const reason = h('input', { type: 'text', placeholder: 'A dispute, a payment problem…' });
    modal({
      title: `Suspend ${s.subscription_no}`, size: 'narrow',
      body: h('div',
        h('p.muted', { style: { marginTop: 0 } },
          'Billing stops. The contract stays live and can be resumed, and nothing already invoiced changes.'),
        h('div.field', h('label', 'Why'), reason)),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Suspend it', kind: 'primary',
          onClick: async (close) => {
            try {
              await API.suspendSubscription(s.id, { reason: reason.value || '' });
              notifyOk(`${s.subscription_no} suspended.`); close(true); load();
            } catch (e) { notifyError(e); return false; }
          },
        },
      ],
    });
  }

  async function cancelDialog(s) {
    const when = h('input', { type: 'date', value: fmt.today() });
    const reason = h('input', { type: 'text', placeholder: 'Moved supplier, went under, no longer needed…' });
    modal({
      title: `Cancel ${s.subscription_no}`,
      body: h('div',
        h('p.muted', { style: { marginTop: 0 } },
          'Billing stops on the date you give. What has already been billed stays billed — whether the customer gets any of it back is a commercial decision, so raise a credit memo if they should.'),
        h('div.form-grid',
          h('div.field', h('label', 'Effective from'), when),
          h('div.field', h('label', 'Why'), reason))),
      actions: [
        { label: 'Keep it', value: null },
        {
          label: 'Cancel the subscription', kind: 'danger',
          onClick: async (close) => {
            try {
              await API.cancelSubscription(s.id, { effective_date: when.value, reason: reason.value || '' });
              notifyOk(`${s.subscription_no} cancelled.`); close(true); load();
            } catch (e) { notifyError(e); return false; }
          },
        },
      ],
    });
  }

  async function usageDialog(s, lines) {
    const lineSel = h('select', ...lines.map((l) => h('option', { value: l.id }, `${l.sku} — ${l.description}`)));
    const when = h('input', { type: 'date', value: fmt.today() });
    const quantity = h('input', { type: 'number', step: 'any', class: 'num' });
    const memo = h('input', { type: 'text', placeholder: 'Where the figure came from' });
    modal({
      title: 'Record usage',
      body: h('div',
        h('p.muted', { style: { marginTop: 0 } },
          'Metered usage is charged for the period it falls in, less whatever allowance the line includes. It cannot be recorded into a period already invoiced.'),
        h('div.form-grid',
          h('div.field.full', h('label', 'Line'), lineSel),
          h('div.field', h('label', 'Date'), when),
          h('div.field', h('label', 'Quantity'), quantity),
          h('div.field.full', h('label', 'Note'), memo))),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Record it', kind: 'primary',
          onClick: async (close) => {
            try {
              await API.recordUsage(s.id, {
                line_id: lineSel.value, usage_date: when.value,
                quantity: Number(quantity.value) || 0, memo: memo.value || '',
              });
              notifyOk('Usage recorded.'); close(true); load();
            } catch (e) { notifyError(e); return false; }
          },
        },
      ],
    });
  }

  async function amendDialog(s) {
    const kind = h('select',
      h('option', { value: 'quantity' }, 'Change a quantity'),
      h('option', { value: 'price' }, 'Change a price'),
      h('option', { value: 'add' }, 'Add a line'),
      h('option', { value: 'remove' }, 'Remove a line'));
    const active = s.lines.filter((l) => l.status === 'active');
    const lineSel = h('select', ...active.map((l) => h('option', { value: l.id }, `${l.sku} — ${l.description}`)));
    const when = h('input', { type: 'date', value: s.billed_through || fmt.today() });
    const value = h('input', { type: 'number', step: 'any', class: 'num' });
    const note = h('input', { type: 'text', placeholder: 'Why it changed' });
    const itemSel = h('select', h('option', { value: '' }, '— item —'));
    const addQty = h('input', { type: 'number', step: 'any', class: 'num', value: '1' });
    const addPrice = h('input', { type: 'number', step: '0.01', class: 'num' });
    const detail = h('div');

    store.refOptions('item').then((options) => {
      for (const o of options) itemSel.appendChild(h('option', { value: o.value }, o.label));
    });

    const draw = () => {
      clear(detail);
      if (kind.value === 'add') {
        detail.appendChild(h('div.form-grid',
          h('div.field.full', h('label', 'Item'), itemSel),
          h('div.field', h('label', 'Quantity'), addQty),
          h('div.field', h('label', 'Unit price per period'), addPrice)));
      } else {
        detail.appendChild(h('div.form-grid',
          h('div.field.full', h('label', 'Line'), lineSel),
          kind.value === 'remove' ? null
            : h('div.field', h('label', kind.value === 'price' ? 'New unit price' : 'New quantity'), value)));
      }
    };
    kind.addEventListener('change', draw);
    draw();

    modal({
      title: `Amend ${s.subscription_no}`,
      body: h('div',
        h('p.muted', { style: { marginTop: 0 } },
          'An amendment carries a date. Everything already billed stays billed; the next run prices the part of the period before the change at the old figure and the part after it at the new one.'),
        h('div.form-grid',
          h('div.field', h('label', 'What is changing'), kind),
          h('div.field', h('label', 'Effective from'), when)),
        detail,
        h('div.field', h('label', 'Note'), note)),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Apply the amendment', kind: 'primary',
          onClick: async (close) => {
            const body = { kind: kind.value, effective_date: when.value, note: note.value || '' };
            if (kind.value === 'add') {
              body.line = { item_id: itemSel.value, quantity: Number(addQty.value) || 0, unit_price: Number(addPrice.value) || 0 };
            } else {
              body.line_id = lineSel.value;
              if (kind.value === 'quantity') body.quantity = Number(value.value) || 0;
              if (kind.value === 'price') body.unit_price = Number(value.value) || 0;
            }
            try {
              await API.amendSubscription(s.id, body);
              notifyOk('Amendment applied.'); close(true); load();
            } catch (e) { notifyError(e); return false; }
          },
        },
      ],
    });
  }

  // ------------------------------------------------------------ billing
  function billingDialog(single = null) {
    const through = h('input', { type: 'date', value: fmt.today() });
    const preview = h('div', { style: { marginTop: 'var(--s4)' } });
    let plan = null;

    const draw = async () => {
      mount(preview, loading('Working out what would be invoiced'));
      try {
        plan = await API.billSubscriptions({ through: through.value, id: single?.id || null, dry_run: true });
        mount(preview, summary(plan));
      } catch (e) { plan = null; mount(preview, empty('Could not preview the run', e.message)); }
    };
    through.addEventListener('change', draw);

    const m = modal({
      title: single ? `Bill ${single.subscription_no}` : 'Bill subscriptions',
      size: 'wide',
      body: h('div',
        h('p.muted', { style: { marginTop: 0 } },
          'One invoice per subscription, carrying every period it owes — so a contract three months behind produces one invoice with three months on it, not three invoices to reconcile. A period already billed is never billed again.'),
        h('div.field', h('label', 'Bill everything due up to'), through),
        preview),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Raise the invoices', kind: 'primary',
          onClick: async (close) => {
            if (!plan?.count) { notifyError(new Error('There is nothing to bill for that date.')); return false; }
            try {
              const res = await API.billSubscriptions({ through: through.value, id: single?.id || null });
              notifyOk(`${res.count} invoice${res.count === 1 ? '' : 's'} raised, ${fmt.money(res.amount)} in total.`, 'Billing complete');
              close(true); load();
            } catch (e) { notifyError(e); return false; }
          },
        },
      ],
    });
    draw();
    return m;
  }

  /** One total per currency, because that is how the invoices go out. */
  function totalsByCurrency(rows) {
    const totals = new Map();
    for (const r of rows) totals.set(r.currency, (totals.get(r.currency) || 0) + r.amount);
    const parts = [...totals.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (!parts.length) return '—';
    if (parts.length === 1) return fmt.money(parts[0][1], parts[0][0]);
    return h('span', ...parts.map(([ccy, amt], i) => h('span',
      i ? h('span.faint', ' · ') : null, fmt.money(amt, ccy))));
  }

  function summary(plan) {
    if (!plan.count && !plan.skipped.length) {
      return h('div.muted', { style: { padding: 'var(--s3) 0' } }, 'Nothing falls due on or before that date.');
    }
    return h('div',
      plan.count
        ? h('div',
          facts([
            ['Invoices', String(plan.count)],
            // Each invoice is raised in its own customer's currency, so there
            // is no single total to give: adding pounds to dollars would make
            // a number that is not owed by anybody.
            ['Total', totalsByCurrency(plan.invoiced)],
            ['Periods', String(plan.invoiced.reduce((a, i) => a + i.periods, 0))],
          ]),
          h('div.grid-wrap', { style: { marginTop: 'var(--s3)', maxHeight: '260px' } }, h('table.grid',
            h('thead', h('tr', h('th', 'Subscription'), h('th', 'Customer'), h('th', 'Dated'),
              h('th.num', 'Periods'), h('th.num', 'Lines'), h('th.num', 'Amount'))),
            h('tbody', ...plan.invoiced.map((i) => h('tr',
              h('td', h('strong', i.subscription_no)),
              h('td', i.customer_name),
              h('td', fmt.date(i.txn_date)),
              h('td.num', String(i.periods)),
              h('td.num.muted', String(i.lines)),
              h('td.num', fmt.money(i.amount, i.currency))))))))
        : null,
      plan.skipped.length
        ? h('div.callout.warn', { style: { marginTop: 'var(--s3)' } },
          h('strong', `${plan.skipped.length} passed over. `),
          plan.skipped.map((s) => `${s.subscription_no} — ${s.reason}`).join('; '), '.')
        : null);
  }

  // ------------------------------------------------------------- editor
  async function editor(existing) {
    await store.ensureRefs(['customer', 'item']);
    const controls = {};
    const headerHost = h('div.form-grid');
    const fields = [
      { name: 'customer_id', label: 'Customer', type: 'reference', ref: 'customer', required: true },
      { name: 'name', label: 'Name', type: 'text', help: 'What this contract is called on an invoice.' },
      { name: 'start_date', label: 'Starts', type: 'date', required: true },
      { name: 'billing_frequency', label: 'Bills', type: 'select', options: ['monthly', 'quarterly', 'annually'] },
      {
        name: 'billing_day', label: 'On day of month', type: 'number',
        help: '1 to 28 to put every customer on one date — the first period is then short and prorated. 0 bills on the start date’s anniversary.',
      },
      { name: 'term_months', label: 'Term (months)', type: 'number', help: '0 for evergreen: it runs until somebody cancels it.' },
      { name: 'bill_in_advance', label: 'Bill for the period ahead', type: 'checkbox' },
      { name: 'auto_renew', label: 'Renew automatically at the end of the term', type: 'checkbox' },
      { name: 'po_number', label: 'PO number', type: 'text' },
      { name: 'memo', label: 'Memo', type: 'longtext', full: true },
    ];
    const defaults = {
      start_date: fmt.today(), billing_frequency: 'monthly', billing_day: 1,
      term_months: 12, bill_in_advance: 1, auto_renew: 1,
    };
    for (const f of fields) {
      const ctl = fieldControl(f, existing?.[f.name] ?? defaults[f.name] ?? '', null);
      controls[f.name] = ctl;
      headerHost.appendChild(ctl.el);
    }

    function blank() { return { item_id: '', description: '', model: 'recurring', quantity: 1, unit_price: '', included_quantity: '', usage_uom: '' }; }
    // Only lines that are still live come back for editing: a removed line is
    // kept for the invoices that point at it, not for changing.
    let lines = (existing?.lines || []).filter((l) => l.status !== 'removed').map((l) => ({
      item_id: l.item_id, description: l.description, model: l.model,
      quantity: l.model === 'usage' ? 0 : l.quantity / fmt.QTY_SCALE,
      unit_price: l.unit_price / fmt.MONEY_SCALE,
      included_quantity: l.included_quantity ? l.included_quantity / fmt.QTY_SCALE : '',
      usage_uom: l.usage_uom || '',
    }));
    if (!lines.length) lines = [blank()];
    const body = h('tbody');
    const itemOptions = await store.refOptions('item');

    function draw() {
      clear(body);
      lines.forEach((l, i) => {
        const item = h('select', { onchange: (e) => {
          l.item_id = e.target.value;
          const opt = itemOptions.find((o) => o.value === e.target.value);
          if (opt && !l.unit_price) { l.unit_price = (opt.row.base_price || 0) / 100; draw(); }
        } },
        h('option', { value: '' }, '— item —'),
        ...itemOptions.map((o) => h('option', { value: o.value, selected: o.value === l.item_id }, o.label)));
        const model = h('select', { onchange: (e) => { l.model = e.target.value; draw(); } },
          ...Object.entries(MODEL_LABEL).map(([v, label]) => h('option', { value: v, selected: v === l.model }, label)));
        const qty = h('input', {
          type: 'number', step: 'any', class: 'num', value: l.quantity,
          disabled: l.model === 'usage',
          oninput: (e) => { l.quantity = e.target.value; },
        });
        const price = h('input', { type: 'number', step: '0.01', class: 'num', value: l.unit_price, oninput: (e) => { l.unit_price = e.target.value; } });
        const included = h('input', {
          type: 'number', step: 'any', class: 'num', value: l.included_quantity,
          disabled: l.model !== 'usage', placeholder: l.model === 'usage' ? 'free allowance' : '',
          oninput: (e) => { l.included_quantity = e.target.value; },
        });
        body.appendChild(h('tr',
          h('td', { style: { width: '26px' } }, h('span.faint', String(i + 1))),
          h('td', { style: { minWidth: '220px' } }, item),
          h('td', { style: { width: '120px' } }, model),
          h('td', { style: { width: '90px' } }, qty),
          h('td', { style: { width: '110px' } }, price),
          h('td', { style: { width: '110px' } }, included),
          h('td', { style: { width: '28px' } }, h('button.rm', {
            onclick: () => { lines.splice(i, 1); if (!lines.length) lines.push(blank()); draw(); },
          }, icon('x', { size: 13 })))));
      });
    }
    draw();

    return modal({
      title: existing ? `Edit ${existing.subscription_no}` : 'New subscription',
      size: 'wide',
      body: h('div',
        headerHost,
        // Once a period has been invoiced, what is being sold can only change
        // with a date on it — otherwise an invoice already sent would stop
        // matching the contract that produced it.
        existing?.billed_through
          ? h('div.callout', { style: { marginTop: 'var(--s5)' } },
            'Billed to ', h('strong', fmt.date(existing.billed_through)),
            '. The terms above that decide what has already been charged are fixed now, and lines change with an ',
            h('strong', 'amendment'), ' so the change carries a date.')
          : h('div',
            h('div.row', { style: { justifyContent: 'space-between', alignItems: 'center', margin: 'var(--s5) 0 var(--s2)' } },
              h('h3', { style: { margin: 0, fontSize: 'var(--t-md)' } }, 'What is being sold'),
              h('button.btn.sm', { onclick: () => { lines.push(blank()); draw(); } }, icon('plus', { size: 13 }), 'Add line')),
            h('div.grid-wrap', h('table.lines-table',
              h('thead', h('tr', h('th', ''), h('th', 'Item'), h('th', 'Model'), h('th', 'Quantity'),
                h('th', 'Price per period'), h('th', 'Included'), h('th', ''))),
              body)),
            h('div.callout', { style: { marginTop: 'var(--s4)' } },
              'A ', h('strong', 'recurring'), ' line bills the same amount every period. A ',
              h('strong', 'one-off'), ' line bills once, at the start. A ', h('strong', 'metered'),
              ' line bills for what was recorded against it, less whatever allowance you include.'))),
      actions: existing
        ? [
          { label: 'Cancel', value: null },
          { label: 'Save', kind: 'primary', onClick: (close) => save(false, close) },
          ...(existing.status === 'draft'
            ? [{ label: 'Save and activate', kind: 'primary', onClick: (close) => save(true, close) }]
            : []),
        ]
        : [
          { label: 'Cancel', value: null },
          {
            label: 'Create as draft',
            onClick: (close) => save(false, close),
          },
          {
            label: 'Create and activate', kind: 'primary',
            onClick: (close) => save(true, close),
          },
        ],
    });

    async function save(activateIt, close) {
      const payload = {
        ...Object.fromEntries(fields.map((f) => [f.name, controls[f.name].get()])),
        bill_in_advance: !!controls.bill_in_advance.get(),
        auto_renew: !!controls.auto_renew.get(),
        activate: activateIt,
        lines: lines.filter((l) => l.item_id).map((l) => ({
          item_id: l.item_id, model: l.model,
          quantity: l.model === 'usage' ? 0 : Number(l.quantity) || 0,
          unit_price: Number(l.unit_price) || 0,
          included_quantity: Number(l.included_quantity) || 0,
        })),
      };
      try {
        if (existing) {
          // Lines are only sent while nothing has been billed. After that a
          // change has to carry a date, which is what an amendment is for.
          if (existing.billed_through) delete payload.lines;
          delete payload.activate;
          const saved = await API.updateSubscription(existing.id, payload);
          if (activateIt) await API.activateSubscription(existing.id);
          notifyOk(`${saved.subscription_no} saved${activateIt ? ' and live' : ''}.`);
          close(true);
          load();
        } else {
          const created = await API.createSubscription(payload);
          notifyOk(`${created.subscription_no} created${activateIt ? ' and live' : ' as a draft'}.`);
          close(true);
          go(`/subscriptions/${created.id}`);
        }
      } catch (e) { notifyError(e); return false; }
      return true;
    }
  }

  load();
  return h('div.page', h('div.page-head', head), host);
}

