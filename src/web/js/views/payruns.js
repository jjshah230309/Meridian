// Meridian ERP :: web/views/payruns
// Pay Bills: what is due, what this run will pay, and one payment per
// supplier once it is committed.
//
// The screen exists because the decision is made per supplier and the money
// moves per supplier, but the argument is per bill. So the list groups by
// supplier with the bills underneath, everything is ticked by default, and
// unticking is the whole interaction. Nothing posts until the run is
// committed, and the total in the header moves as you go so you always know
// what you are about to send.
import { h, mount } from '../dom.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import * as store from '../store.js';
import { empty, notifyError, notifyOk, statusTag, loading, modal, facts, confirm } from '../ui.js';

const daysTone = (d) => (d >= 30 ? 'num-neg' : d > 0 ? '' : 'muted');

export async function payrunsView(route, { go }) {
  if (!store.can('payment_run')) {
    return h('div.page', empty('Not permitted', 'Your role cannot see payment runs.'));
  }
  const canBuild = store.can('payment_run', store.LEVEL.CREATE);
  const canPay = store.can('payment_run', store.LEVEL.EDIT) && store.can('vendor_payment', store.LEVEL.CREATE);

  const host = h('div');
  const head = h('div');
  const openId = route.parts[1] && route.parts[1] !== 'new' ? route.parts[1] : null;

  async function load() {
    mount(host, loading('Reading what is due'));
    try {
      if (openId) { renderRun(await API.paymentRun(openId)); return; }
      const data = await API.paymentRuns({ limit: 20 });
      renderIndex(data);
    } catch (e) {
      mount(host, empty('Could not open the payment runs', e.message));
    }
  }

  // --------------------------------------------------------------- index
  function renderIndex(data) {
    const due = data.due;
    const runs = data.rows || [];
    mount(head,
      h('div.titles',
        h('h1', 'Pay Bills'),
        h('div.page-sub', 'What is due to suppliers, and the runs that have paid it')),
      h('div.page-actions',
        canBuild ? h('button.btn.primary', { onclick: () => proposeDialog(due) }, 'New payment run') : null));

    const groups = due.groups || [];
    const kpis = h('div.kpi-grid', { style: { marginBottom: '14px' } },
      ...groups.slice(0, 2).map((g) => h('div.kpi',
        h('div.k-label', `Due in ${g.currency}`),
        h('div.k-value', fmt.moneyCompact(g.total, g.currency)),
        h('div.k-meta', `${g.bills} bill${g.bills === 1 ? '' : 's'} · ${g.vendors} supplier${g.vendors === 1 ? '' : 's'}`))),
      h('div.kpi',
        h('div.k-label', 'Already overdue'),
        h('div.k-value', { class: groups.some((g) => g.overdue) ? 'num-neg' : '' },
          fmt.moneyCompact(groups.reduce((a, g) => a + g.overdue, 0))),
        h('div.k-meta', 'Past the date the supplier expected it')),
      h('div.kpi',
        h('div.k-label', 'Runs in progress'),
        h('div.k-value', String(runs.filter((r) => r.status === 'draft').length)),
        h('div.k-meta', runs.length ? `${runs.length} on record` : 'None yet')));

    if (!groups.length && !runs.length) {
      mount(host, empty('Nothing is due to suppliers',
        'A payment run gathers every unpaid bill falling due by a date you choose, groups them by supplier, and sends one payment to each. It fills up as bills are entered.'));
      return;
    }

    mount(host, kpis,
      runs.length
        ? h('div.card',
          h('div.card-head', h('h2', 'Payment runs')),
          h('div.grid-wrap', h('table.grid',
            h('thead', h('tr', h('th', 'Run'), h('th', 'Payment date'), h('th', 'Paid from'),
              h('th', 'Bills due by'), h('th.num', 'Suppliers'), h('th.num', 'Bills'),
              h('th.num', 'Total'), h('th', 'Status'))),
            h('tbody', ...runs.map((r) => h('tr.clickable', { onclick: () => go(`/paybills/${r.id}`) },
              h('td', h('strong', r.run_no)),
              h('td', fmt.date(r.payment_date)),
              h('td.muted', r.bank_name || '—'),
              h('td.muted', fmt.date(r.pay_through)),
              h('td.num', String(r.vendor_count)),
              h('td.num', String(r.bill_count)),
              h('td.num', h('strong', fmt.money(r.total, r.currency))),
              h('td', statusTag(r.status))))))))
        : empty('No payment runs yet', 'Build one from the bills now due.',
          canBuild ? h('button.btn.primary', { onclick: () => proposeDialog(due) }, 'New payment run') : null));
  }

  function proposeDialog(due) {
    const banks = (store.state.meta.bank_accounts || []).filter((b) => b.active !== 0);
    const bank = h('select', ...(banks.length
      ? banks.map((b) => h('option', { value: b.id }, `${b.name} · ${b.currency}`))
      : [h('option', { value: '' }, 'No bank account set up')]));
    const payDate = h('input', { type: 'date', value: fmt.today() });
    const through = h('input', { type: 'date', value: fmt.today() });
    const memo = h('input', { type: 'text', placeholder: 'Weekly supplier run' });

    return modal({
      title: 'New payment run',
      body: h('div',
        h('p.muted', { style: { marginTop: 0 } },
          'Every unpaid bill falling due on or before the cut-off, in the currency of the account paying it, goes on the list. You can take things off before anything is paid.'),
        h('div.form-grid',
          h('div.field', h('label', 'Pay from'), bank),
          h('div.field', h('label', 'Payment date'), payDate),
          h('div.field', h('label', 'Include bills due by'), through,
            h('div.help', 'Usually the date of the next run, so nothing falls between the two.')),
          h('div.field.full', h('label', 'Memo'), memo)),
        due.groups?.length
          ? h('div.callout', { style: { marginTop: '10px' } },
            due.groups.map((g) => `${fmt.money(g.total, g.currency)} across ${g.bills} bill${g.bills === 1 ? '' : 's'} in ${g.currency}`).join('; '),
            ' is due today.')
          : null),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Build the run', kind: 'primary',
          onClick: async (close) => {
            try {
              const run = await API.createPaymentRun({
                bank_account_id: bank.value, payment_date: payDate.value,
                pay_through: through.value, memo: memo.value || '',
              });
              notifyOk(`${run.run_no} proposes ${fmt.money(run.total, run.currency)} to ${run.vendor_count} supplier${run.vendor_count === 1 ? '' : 's'}.`,
                'Run built');
              close(true);
              go(`/paybills/${run.id}`);
            } catch (e) { notifyError(e); return false; }
          },
        },
      ],
    });
  }

  // ----------------------------------------------------------- one run
  function renderRun(run) {
    const draft = run.status === 'draft';
    const editable = draft && canPay;
    mount(head,
      h('div.titles',
        h('div.breadcrumb', h('a', { href: '#/paybills', onclick: (e) => { e.preventDefault(); go('/paybills'); } }, 'Pay Bills')),
        h('h1', run.run_no, ' ', statusTag(run.status)),
        h('div.page-sub',
          `${run.bank?.name || 'Bank account'} · paying ${fmt.date(run.payment_date)} · bills due by ${fmt.date(run.pay_through)}`)),
      h('div.page-actions',
        h('button.btn.sm', { onclick: () => API.paymentFileCsv(run.id).catch(notifyError) }, 'Payment file'),
        draft && canPay ? h('button.btn', { onclick: () => cancelRun(run) }, 'Abandon') : null,
        draft && canPay
          ? h('button.btn.primary', { disabled: !run.bill_count, onclick: () => payDialog(run) },
            `Pay ${fmt.money(run.total, run.currency)}`)
          : null));

    // Local edits are batched: ticking twenty boxes should be one request at
    // the end, not twenty round trips with the total flickering between them.
    const pending = new Map();
    const totalBox = h('span');
    const runningTotal = () => run.vendors.reduce((a, g) => a + g.lines.reduce((b, l) => {
      const p = pending.get(l.id) || {};
      const selected = p.selected ?? !!l.selected;
      const amount = p.amount_pay ?? l.amount_pay;
      return b + (selected ? amount : 0);
    }, 0), 0);
    const refreshTotal = () => {
      mount(totalBox, h('strong', fmt.money(runningTotal(), run.currency)));
      saveBtn.disabled = !pending.size;
      saveBtn.textContent = pending.size ? `Save ${pending.size} change${pending.size === 1 ? '' : 's'}` : 'No changes';
    };
    const saveBtn = h('button.btn.sm.accent', {
      onclick: async () => {
        try {
          await API.updatePaymentRunLines(run.id, [...pending.entries()].map(([id, p]) => ({ id, ...p })));
          notifyOk('Run updated.');
          load();
        } catch (e) { notifyError(e); }
      },
    }, 'No changes');

    const groupCards = run.vendors.map((g) => {
      const rows = g.lines.map((l) => {
        const tick = h('input', {
          type: 'checkbox', checked: !!l.selected, disabled: !editable,
          onchange: (e) => {
            const p = pending.get(l.id) || {};
            p.selected = e.target.checked;
            pending.set(l.id, p);
            amount.disabled = !editable || !e.target.checked;
            refreshTotal();
          },
        });
        const amount = h('input', {
          type: 'number', step: '0.01', class: 'num', value: (l.amount_pay / 100).toFixed(2),
          disabled: !editable || !l.selected, style: { width: '110px' },
          onchange: (e) => {
            const p = pending.get(l.id) || {};
            p.amount_pay = Number(e.target.value) || 0;
            pending.set(l.id, p);
            refreshTotal();
          },
        });
        return h('tr',
          h('td', { style: { width: '30px' } }, tick),
          h('td', h('a', {
            href: `#/txn/${l.txn_id}`,
            onclick: (e) => { e.preventDefault(); go(`/txn/${l.txn_id}`); },
          }, l.txn_no)),
          h('td.muted', l.reference || l.bill_memo || '—'),
          h('td', fmt.date(l.due_date)),
          h('td.num', { class: daysTone(l.days_overdue) }, l.days_overdue ? `${l.days_overdue}d late` : 'not yet due'),
          h('td.num.muted', fmt.money(l.amount_due, l.currency)),
          h('td.num', amount));
      });

      return h('div.card', { style: { marginTop: '12px' } },
        h('div.card-head',
          h('h2', g.vendor_name,
            g.payment_hold ? h('span.tag.red', { style: { marginLeft: '8px' } }, 'Payment hold') : null,
            g.payment_no ? h('span.tag.green', { style: { marginLeft: '8px' } }, g.payment_no) : null),
          h('div.row', { style: { gap: '10px', alignItems: 'center' } },
            g.bank_reference ? h('span.muted', { style: { fontSize: '12px' } }, g.bank_reference) : null,
            g.payment_no
              ? h('button.btn.sm', { onclick: () => API.remittancePdf(run.id, g.vendor_id).catch(notifyError) }, 'Remittance')
              : null,
            h('span', { style: { fontSize: '14px', fontWeight: 600 } }, fmt.money(g.total, g.currency)))),
        g.payment_hold
          ? h('div.callout.warn', { style: { margin: '0 12px 8px' } },
            'This supplier is on payment hold. Their bills are listed so the hold is visible, but nothing is ticked. Clear the hold on the supplier record to pay them.')
          : null,
        h('div.grid-wrap', h('table.grid',
          h('thead', h('tr', h('th', ''), h('th', 'Bill'), h('th', 'Their reference'),
            h('th', 'Due'), h('th.num', 'Age'), h('th.num', 'Outstanding'), h('th.num', 'Paying'))),
          h('tbody', ...rows))));
    });

    mount(host,
      h('div.card',
        h('div.card-head', h('h2', 'This run'),
          editable
            ? h('div.row', { style: { gap: '10px', alignItems: 'center' } },
              h('span.muted', { style: { fontSize: '12px' } }, 'Selected'), totalBox, saveBtn)
            : h('span', { style: { fontSize: '14px', fontWeight: 600 } }, fmt.money(run.total, run.currency))),
        h('div.card-body',
          facts([
            ['Paid from', `${run.bank?.name || '—'} (${run.currency})`],
            ['Payment date', fmt.date(run.payment_date)],
            ['Bills due by', fmt.date(run.pay_through)],
            ['Suppliers', String(run.vendor_count)],
            ['Bills', String(run.bill_count)],
            ['Memo', run.memo || '—'],
          ]))),
      ...groupCards);
    refreshTotal();
  }

  async function cancelRun(run) {
    const ok = await confirm({
      title: `Abandon ${run.run_no}?`,
      message: 'The proposal is discarded. No bills are touched and nothing has been paid.',
      confirmLabel: 'Abandon it', danger: true,
    });
    if (!ok) return;
    try {
      await API.cancelPaymentRun(run.id, { reason: 'Abandoned from the payment run screen' });
      notifyOk(`${run.run_no} abandoned.`);
      go('/paybills');
    } catch (e) { notifyError(e); }
  }

  function payDialog(run) {
    const date = h('input', { type: 'date', value: run.payment_date });
    const paying = run.vendors.filter((g) => g.selected_count > 0);
    return modal({
      title: `Pay ${run.run_no}`,
      size: 'wide',
      body: h('div',
        facts([
          ['Paid from', `${run.bank?.name || '—'} (${run.currency})`],
          ['Suppliers', String(paying.length)],
          ['Bills', String(run.bill_count)],
          ['Total', fmt.money(run.total, run.currency)],
        ]),
        h('div.field', { style: { marginTop: '10px' } }, h('label', 'Payment date'), date),
        h('div.grid-wrap', { style: { marginTop: '10px', maxHeight: '240px' } }, h('table.grid',
          h('thead', h('tr', h('th', 'Supplier'), h('th.num', 'Bills'), h('th.num', 'Amount'))),
          h('tbody', ...paying.map((g) => h('tr',
            h('td', g.vendor_name),
            h('td.num', String(g.selected_count)),
            h('td.num', fmt.money(g.total, g.currency))))))),
        h('div.callout', { style: { marginTop: '10px' } },
          'One payment per supplier is posted and applied to their bills. Anything settled since the run was built is dropped from it and reported.')),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Pay it', kind: 'primary',
          onClick: async (close) => {
            try {
              const res = await API.payPaymentRun(run.id, { payment_date: date.value });
              const dropped = res.dropped.length
                ? ` ${res.dropped.length} bill${res.dropped.length === 1 ? '' : 's'} changed since the run was built and were adjusted.`
                : '';
              notifyOk(`${res.payments.length} payment${res.payments.length === 1 ? '' : 's'} posted.${dropped}`, 'Suppliers paid');
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
