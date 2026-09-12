// Meridian ERP :: web/views/intercompany
// Trading between companies you own.
//
// The screen leads with the reconciliation, because the only question anybody
// brings to it is "do the two sides agree". Below that sits the register of
// what crossed a company boundary, and the elimination runs that cancel it
// for the group's own accounts.
//
// The distinction the whole screen turns on: a pair that disagrees is
// somebody's mistake, while a translated total that disagrees is a sterling
// company holding a dollar balance and nobody's fault at all. They are shown
// differently on purpose.
import { h, mount, clear } from '../dom.js';
import { icon } from '../icons.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import * as store from '../store.js';
import { empty, notifyError, notifyOk, statusTag, loading, modal, facts, confirm, fieldControl } from '../ui.js';

const KIND_LABEL = { journal: 'Recharge', sale: 'Sale' };

export async function intercompanyView(route, { go }) {
  if (!store.can('intercompany_txn')) {
    return h('div.page', empty('Not permitted', 'Your role cannot see intercompany transactions.'));
  }
  const canCreate = store.can('intercompany_txn', store.LEVEL.CREATE);
  const canEliminate = store.can('elimination_run', store.LEVEL.CREATE);
  const openId = route.parts[1] || null;

  const host = h('div');
  const head = h('div');

  async function load() {
    mount(host, loading('Reading the register'));
    try {
      if (openId) { renderOne(await API.intercompanyTxn(openId)); return; }
      renderIndex(await API.intercompany({}));
    } catch (e) { mount(host, empty('Could not open intercompany', e.message)); }
  }

  // ------------------------------------------------------------- index
  function renderIndex(data) {
    const rec = data.reconciliation;
    const runs = data.runs || [];

    mount(head,
      h('div.titles',
        h('h1', 'Intercompany'),
        h('div.page-sub', 'What the companies in the group sold each other, whether both sides agree, and what has been cancelled for the consolidated accounts')),
      h('div.page-actions',
        canCreate ? h('button.btn', { onclick: () => saleDialog() }, 'Sale between companies') : null,
        canCreate ? h('button.btn.primary', { onclick: () => rechargeDialog() }, 'New recharge') : null,
        canEliminate ? h('button.btn', { onclick: () => eliminationDialog() }, 'Eliminate a period') : null));

    const kpis = h('div.kpi-grid', { style: { marginBottom: 'var(--s5)' } },
      h('div.kpi',
        h('div.k-label', 'Owed between companies'),
        h('div.k-value', fmt.moneyCompact(rec.total_due_from, rec.currency)),
        h('div.k-meta', `${rec.transactions} transaction${rec.transactions === 1 ? '' : 's'}, in ${rec.currency}`)),
      h('div.kpi',
        h('div.k-label', 'Both sides agree'),
        h('div.k-value', { class: rec.clean ? '' : 'num-neg' }, rec.clean ? 'Yes' : 'No'),
        h('div.k-meta', rec.clean
          ? 'Every pair matches and every ledger matches its register'
          : `${rec.unmatched.length} pair${rec.unmatched.length === 1 ? '' : 's'} and ${rec.drifting.length} ledger${rec.drifting.length === 1 ? '' : 's'} to look at`)),
      h('div.kpi',
        h('div.k-label', 'Translation'),
        h('div.k-value', fmt.moneyCompact(rec.translation_difference, rec.currency)),
        h('div.k-meta', rec.translation_difference
          ? 'A balance held in a currency that is not yours — revalue it, do not chase it'
          : 'Nothing, because the group keeps one currency')),
      h('div.kpi',
        h('div.k-label', 'Eliminated'),
        h('div.k-value', String(runs.filter((r) => r.status === 'posted').length)),
        h('div.k-meta', runs.length ? `${runs.length} run${runs.length === 1 ? '' : 's'} in all` : 'No period cancelled yet')));

    mount(host, kpis,
      rec.missing_rates?.length
        ? h('div.callout.warn', { style: { marginBottom: 'var(--s5)' } },
          'These totals leave out balances in ', h('strong', rec.missing_rates.join(', ')),
          `: there is no exchange rate into ${rec.currency}. Add one under Setup → Exchange Rates.`)
        : null,

      // --- what is actually wrong, if anything
      rec.unmatched.length
        ? h('div.card', { style: { marginBottom: 'var(--s5)' } },
          h('div.card-head', h('h2', 'These pairs do not agree'),
            h('span.muted', { style: { fontSize: 'var(--t-sm)' } }, 'One half has been changed since it was written')),
          h('div.grid-wrap', h('table.grid',
            h('thead', h('tr', h('th', 'Reference'), h('th', 'Date'), h('th', 'Between'),
              h('th.num', 'One side'), h('th.num', 'The other'), h('th.num', 'Out by'), h('th', ''))),
            h('tbody', ...rec.unmatched.map((u) => h('tr.clickable', { onclick: () => go(`/intercompany/${u.id}`) },
              h('td', h('strong', u.reference)),
              h('td.muted', fmt.date(u.txn_date)),
              h('td.muted', `${u.from} → ${u.to}`),
              h('td.num', u.from_amount === undefined ? h('span.faint', '—') : fmt.money(u.from_amount, u.currency)),
              h('td.num', u.to_amount === undefined ? h('span.faint', '—') : fmt.money(u.to_amount, u.currency)),
              h('td.num.num-neg', fmt.money(u.difference, u.currency)),
              h('td.muted', { style: { fontSize: 'var(--t-xs)' } }, u.note)))))))
        : null,

      rec.drifting.length
        ? h('div.card', { style: { marginBottom: 'var(--s5)' } },
          h('div.card-head', h('h2', 'These ledgers hold more than the register accounts for'),
            h('span.muted', { style: { fontSize: 'var(--t-sm)' } }, 'Somebody has posted at a control account by hand')),
          h('div.grid-wrap', h('table.grid',
            h('thead', h('tr', h('th', 'Company'), h('th.num', 'Unaccounted for'))),
            h('tbody', ...rec.drifting.map((d) => h('tr',
              h('td', h('strong', d.name)),
              h('td.num.num-neg', fmt.money(d.drift, d.currency))))))))
        : null,

      // --- the position, company by company
      h('div.card',
        h('div.card-head', h('h2', 'Who owes whom'),
          h('span.muted', { style: { fontSize: 'var(--t-sm)' } }, `As at ${fmt.date(rec.as_of)}`)),
        rec.by_subsidiary.length
          ? h('div.grid-wrap', h('table.grid',
            h('thead', h('tr', h('th', 'Company'), h('th', 'Books in'),
              h('th.num', 'Owed to it'), h('th.num', 'It owes'),
              h('th.num', `Owed to it (${rec.currency})`), h('th.num', `It owes (${rec.currency})`))),
            h('tbody', ...rec.by_subsidiary.map((b) => h('tr',
              h('td', h('strong', b.name)),
              h('td.muted', b.currency),
              h('td.num', fmt.money(b.total_due_from, b.currency)),
              h('td.num', fmt.money(b.total_due_to, b.currency)),
              h('td.num.muted', fmt.money(b.due_from_group, rec.currency)),
              h('td.num.muted', fmt.money(b.due_to_group, rec.currency)))))))
          : h('div.card-body', h('div.muted', 'No company owes another anything.'))),

      // --- the register
      h('div.card', { style: { marginTop: 'var(--s5)' } },
        h('div.card-head', h('h2', 'What crossed a company boundary'),
          h('span.muted', { style: { fontSize: 'var(--t-sm)' } }, `${data.total} recorded`)),
        data.rows.length
          ? h('div.grid-wrap', { style: { maxHeight: '420px' } }, h('table.grid',
            h('thead', h('tr', h('th', 'Reference'), h('th', 'Date'), h('th', 'From'), h('th', 'To'),
              h('th', 'Kind'), h('th.num', 'Amount'), h('th', 'Status'))),
            h('tbody', ...data.rows.map((r) => h('tr.clickable', { onclick: () => go(`/intercompany/${r.id}`) },
              h('td', h('strong', r.reference),
                r.memo ? h('div.muted', { style: { fontSize: 'var(--t-xs)' } }, r.memo) : null),
              h('td.muted', fmt.date(r.txn_date)),
              h('td', r.from_name),
              h('td', r.to_name),
              h('td', h('span.tag', KIND_LABEL[r.kind] || r.kind)),
              h('td.num', fmt.money(r.amount, r.currency)),
              h('td', statusTag(r.status)))))))
          : h('div.card-body', h('div.muted', 'Nothing yet. A recharge or a sale between two of your companies will appear here.'))),

      // --- elimination history
      runs.length
        ? h('div.card', { style: { marginTop: 'var(--s5)' } },
          h('div.card-head', h('h2', 'Eliminations'),
            h('span.muted', { style: { fontSize: 'var(--t-sm)' } }, 'Cancelled for the group accounts, not for the companies’ own')),
          h('div.grid-wrap', h('table.grid',
            h('thead', h('tr', h('th', 'Run'), h('th', 'Period'), h('th.num', 'Eliminated'), h('th', 'Status'), h('th', ''))),
            h('tbody', ...runs.map((r) => h('tr',
              h('td', h('strong', r.run_no)),
              h('td.muted', r.period_name),
              h('td.num', fmt.money(r.total_eliminated)),
              h('td', statusTag(r.status)),
              h('td', r.status === 'posted' && canEliminate
                ? h('button.btn.sm', { onclick: () => reverseRun(r) }, 'Reverse')
                : h('span.faint', '—'))))))))
        : null);
  }

  // -------------------------------------------------------------- detail
  function renderOne(t) {
    mount(head,
      h('div.titles',
        h('div.breadcrumb', h('a', {
          href: '#/intercompany',
          onclick: (e) => { e.preventDefault(); go('/intercompany'); },
        }, 'Intercompany')),
        h('h1', t.reference, ' ', statusTag(t.status)),
        h('div.page-sub', `${t.from_subsidiary?.name || ''} → ${t.to_subsidiary?.name || ''} · ${KIND_LABEL[t.kind] || t.kind}`)),
      h('div.page-actions'));

    const half = (title, sub, entry, txn) => h('div.card',
      h('div.card-head', h('h2', title), h('span.muted', { style: { fontSize: 'var(--t-sm)' } }, sub)),
      entry
        ? h('div',
          h('div.card-body', facts([
            ['Entry', entry.entry_no],
            ['Date', fmt.date(entry.txn_date)],
            ['Total', fmt.money(entry.total_debit, entry.currency)],
          ])),
          h('div.grid-wrap', h('table.grid',
            h('thead', h('tr', h('th', 'Account'), h('th', 'Memo'), h('th.num', 'Debit'), h('th.num', 'Credit'))),
            h('tbody', ...entry.lines.map((l) => h('tr',
              h('td', h('span.mono', l.account_number), ' ', l.account_name),
              h('td.muted', l.memo || ''),
              h('td.num', l.debit ? fmt.money(l.debit, entry.currency) : h('span.faint', '—')),
              h('td.num', l.credit ? fmt.money(l.credit, entry.currency) : h('span.faint', '—'))))))))
        : txn
          ? h('div.card-body', facts([
            ['Document', txn.txn_no],
            ['Date', fmt.date(txn.txn_date)],
            ['Total', fmt.money(txn.total, txn.currency)],
            ['Outstanding', fmt.money(txn.total - (txn.amount_applied || 0), txn.currency)],
            ['Status', statusTag(txn.status)],
          ]))
          : h('div.card-body', h('div.muted', 'This half is missing, which should not be possible.')));

    mount(host,
      h('div.card',
        h('div.card-head', h('h2', 'The transaction')),
        h('div.card-body', facts([
          ['Reference', t.reference],
          ['Kind', KIND_LABEL[t.kind] || t.kind],
          ['Date', fmt.date(t.txn_date)],
          ['From', t.from_subsidiary?.name || '—'],
          ['To', t.to_subsidiary?.name || '—'],
          ['Amount', fmt.money(t.amount, t.currency)],
          ['Status', statusTag(t.status)],
          ['Memo', t.memo || '—'],
        ]))),
      h('div.two-col', { style: { marginTop: 'var(--s5)' } },
        half(`${t.from_subsidiary?.name || 'Seller'} — what it gave`,
          'The company recovering the cost, or selling', t.from_entry, t.from_txn),
        half(`${t.to_subsidiary?.name || 'Buyer'} — what it took`,
          'The company bearing the cost, or buying', t.to_entry, t.to_txn)),
      h('div.callout', { style: { marginTop: 'var(--s5)' } },
        'Both halves were written together and cannot exist alone. ',
        t.status === 'eliminated'
          ? 'This transaction has been cancelled for the group accounts; each company’s own books still carry its side, which is what it files.'
          : 'On consolidation it will be cancelled by an elimination entry, posted in the elimination subsidiary rather than in either company.'));
  }

  // ------------------------------------------------------------ dialogs
  async function pickSubsidiaries() {
    await store.ensureRefs(['subsidiary']);
    const all = await store.refOptions('subsidiary');
    // The elimination subsidiary is not a trading company: it exists to hold
    // the cancelling entries, and offering it here would invite nonsense.
    return all.filter((o) => !o.row?.is_elimination);
  }

  async function rechargeDialog() {
    const subsidiaries = await pickSubsidiaries();
    await store.ensureRefs(['account']);
    const accountOptions = (await store.refOptions('account')).filter((o) => !o.row?.is_summary && !o.row?.is_intercompany);
    if (subsidiaries.length < 2) {
      notifyError(new Error('A recharge needs two trading companies. Add another subsidiary first.'));
      return;
    }

    const from = h('select', ...subsidiaries.map((o, i) => h('option', { value: o.value, selected: i === 0 }, o.label)));
    const to = h('select', ...subsidiaries.map((o, i) => h('option', { value: o.value, selected: i === 1 }, o.label)));
    const date = fieldControl({ name: 'txn_date', label: 'Date', type: 'date' }, fmt.today(), null);
    const memo = fieldControl({ name: 'memo', label: 'What it is for', type: 'text' }, '', null);

    let lines = [blankLine(), blankLine()];
    function blankLine() { return { side: 'to', account_id: '', amount: '', memo: '' }; }
    const body = h('tbody');

    function draw() {
      clear(body);
      lines.forEach((l, i) => {
        const side = h('select', { onchange: (e) => { l.side = e.target.value; } },
          h('option', { value: 'to', selected: l.side === 'to' }, 'Bears the cost'),
          h('option', { value: 'from', selected: l.side === 'from' }, 'Recovers it'));
        const acct = h('select', { onchange: (e) => { l.account_id = e.target.value; } },
          h('option', { value: '' }, '— account —'),
          ...accountOptions.map((o) => h('option', { value: o.value, selected: o.value === l.account_id }, o.label)));
        const amount = h('input', {
          type: 'number', step: '0.01', class: 'num', value: l.amount,
          oninput: (e) => { l.amount = e.target.value; },
        });
        body.appendChild(h('tr',
          h('td', { style: { width: '150px' } }, side),
          h('td', { style: { minWidth: '220px' } }, acct),
          h('td', { style: { width: '120px' } }, amount),
          h('td', { style: { width: '28px' } }, h('button.rm', {
            onclick: () => { lines.splice(i, 1); if (!lines.length) lines.push(blankLine()); draw(); },
          }, icon('x', { size: 13 })))));
      });
    }
    draw();

    return modal({
      title: 'Recharge between companies',
      size: 'wide',
      body: h('div',
        h('div.form-grid',
          h('div.field', h('label', 'Recovers the cost'), from),
          h('div.field', h('label', 'Bears the cost'), to),
          date.el, memo.el),
        h('div.row', { style: { justifyContent: 'space-between', alignItems: 'center', margin: 'var(--s5) 0 var(--s2)' } },
          h('h3', { style: { margin: 0, fontSize: 'var(--t-md)' } }, 'What the transaction is'),
          h('button.btn.sm', { onclick: () => { lines.push(blankLine()); draw(); } }, icon('plus', { size: 13 }), 'Add line')),
        h('div.grid-wrap', h('table.lines-table',
          h('thead', h('tr', h('th', 'Side'), h('th', 'Account'), h('th', 'Amount'), h('th', ''))),
          body)),
        h('div.callout', { style: { marginTop: 'var(--s4)' } },
          'Enter only what the transaction is for. The ',
          h('strong', 'Due from'), ' and ', h('strong', 'Due to'),
          ' sides are worked out and posted in both companies — that is the half people get wrong.')),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Post in both companies', kind: 'primary',
          onClick: async (close) => {
            const payload = {
              from_subsidiary_id: from.value, to_subsidiary_id: to.value,
              txn_date: date.get(), memo: memo.get(),
              lines: lines.filter((l) => l.account_id && Number(l.amount)).map((l) => ({
                subsidiary_id: l.side === 'from' ? from.value : to.value,
                account_id: l.account_id,
                // A cost borne is a debit; a cost recovered is a credit.
                debit: l.side === 'to' ? Math.round(Number(l.amount) * 100) : 0,
                credit: l.side === 'from' ? Math.round(Number(l.amount) * 100) : 0,
              })),
            };
            try {
              const made = await API.intercompanyJournal(payload);
              notifyOk(`${made.reference} posted in both companies.`);
              close(true);
              go(`/intercompany/${made.id}`);
            } catch (e) { notifyError(e); return false; }
            return true;
          },
        },
      ],
    });
  }

  async function saleDialog() {
    const subsidiaries = await pickSubsidiaries();
    await store.ensureRefs(['item']);
    const itemOptions = await store.refOptions('item');
    if (subsidiaries.length < 2) {
      notifyError(new Error('A sale needs two trading companies. Add another subsidiary first.'));
      return;
    }

    const from = h('select', ...subsidiaries.map((o, i) => h('option', { value: o.value, selected: i === 0 }, o.label)));
    const to = h('select', ...subsidiaries.map((o, i) => h('option', { value: o.value, selected: i === 1 }, o.label)));
    const date = fieldControl({ name: 'txn_date', label: 'Date', type: 'date' }, fmt.today(), null);
    const memo = fieldControl({ name: 'memo', label: 'Memo', type: 'text' }, '', null);

    let lines = [{ item_id: '', quantity: 1, unit_price: '' }];
    const body = h('tbody');
    function draw() {
      clear(body);
      lines.forEach((l, i) => {
        const item = h('select', {
          onchange: (e) => {
            l.item_id = e.target.value;
            const opt = itemOptions.find((o) => o.value === e.target.value);
            if (opt && !l.unit_price) { l.unit_price = (opt.row.base_price || 0) / 100; draw(); }
          },
        }, h('option', { value: '' }, '— item —'),
        ...itemOptions.map((o) => h('option', { value: o.value, selected: o.value === l.item_id }, o.label)));
        body.appendChild(h('tr',
          h('td', { style: { minWidth: '240px' } }, item),
          h('td', { style: { width: '90px' } }, h('input', {
            type: 'number', step: 'any', class: 'num', value: l.quantity,
            oninput: (e) => { l.quantity = e.target.value; },
          })),
          h('td', { style: { width: '120px' } }, h('input', {
            type: 'number', step: '0.01', class: 'num', value: l.unit_price,
            oninput: (e) => { l.unit_price = e.target.value; },
          })),
          h('td', { style: { width: '28px' } }, h('button.rm', {
            onclick: () => { lines.splice(i, 1); if (!lines.length) lines.push({ item_id: '', quantity: 1, unit_price: '' }); draw(); },
          }, icon('x', { size: 13 })))));
      });
    }
    draw();

    return modal({
      title: 'Sale between companies',
      size: 'wide',
      body: h('div',
        h('div.form-grid',
          h('div.field', h('label', 'Selling company'), from),
          h('div.field', h('label', 'Buying company'), to),
          date.el, memo.el),
        h('div.row', { style: { justifyContent: 'space-between', alignItems: 'center', margin: 'var(--s5) 0 var(--s2)' } },
          h('h3', { style: { margin: 0, fontSize: 'var(--t-md)' } }, 'What is being sold'),
          h('button.btn.sm', { onclick: () => { lines.push({ item_id: '', quantity: 1, unit_price: '' }); draw(); } }, icon('plus', { size: 13 }), 'Add line')),
        h('div.grid-wrap', h('table.lines-table',
          h('thead', h('tr', h('th', 'Item'), h('th', 'Quantity'), h('th', 'Price'), h('th', ''))),
          body)),
        h('div.callout', { style: { marginTop: 'var(--s4)' } },
          'This raises an invoice in the selling company and a bill in the buying one, for the same lines, in the seller’s currency. ',
          'No tax is applied: a sale inside a group is not a supply to a third party.')),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Raise both documents', kind: 'primary',
          onClick: async (close) => {
            try {
              const made = await API.intercompanySale({
                from_subsidiary_id: from.value, to_subsidiary_id: to.value,
                txn_date: date.get(), memo: memo.get(),
                lines: lines.filter((l) => l.item_id).map((l) => ({
                  item_id: l.item_id,
                  quantity: Number(l.quantity) || 0,
                  unit_price: Number(l.unit_price) || 0,
                })),
              });
              notifyOk(`${made.reference} raised in both companies.`);
              close(true);
              go(`/intercompany/${made.id}`);
            } catch (e) { notifyError(e); return false; }
            return true;
          },
        },
      ],
    });
  }

  async function eliminationDialog() {
    await store.ensureRefs(['accounting_period']);
    const periods = (await store.refOptions('accounting_period')).filter((o) => o.row?.status === 'open');
    if (!periods.length) {
      notifyError(new Error('There is no open period to eliminate into.'));
      return;
    }
    // Open on the period somebody is most likely to mean — the one today
    // falls in — rather than on whichever happens to sort first. A dialog
    // that opens on an empty period two years out just looks broken.
    const todayStr = fmt.today();
    const current = periods.find((o) => o.row?.start_date <= todayStr && o.row?.end_date >= todayStr)
      || periods.find((o) => o.row?.end_date <= todayStr)
      || periods[0];
    const period = h('select', ...periods.map((o) => h('option', { value: o.value, selected: o.value === current.value }, o.label)));
    const memo = fieldControl({ name: 'memo', label: 'Memo', type: 'text' }, '', null);
    const previewHost = h('div', { style: { marginTop: 'var(--s4)' } });

    async function refresh() {
      mount(previewHost, loading('Working out what cancels'));
      try {
        const plan = await API.previewElimination({ period_id: period.value });
        mount(previewHost, plan.lines.length
          ? h('div',
            facts([
              ['Lines', String(plan.lines.length)],
              ['Debit', fmt.money(plan.totals.debit, plan.currency)],
              ['Credit', fmt.money(plan.totals.credit, plan.currency)],
            ]),
            plan.totals.translation
              ? h('div.callout', { style: { marginTop: 'var(--s3)' } },
                plan.totals.single_currency
                  ? h('span', 'Rounding of ', h('strong', fmt.money(Math.abs(plan.totals.translation), plan.currency)),
                    ' goes to the cumulative translation adjustment so the entry balances.')
                  : h('span',
                    'The balances cancel exactly in the currencies they are held in. Stated in ',
                    h('strong', plan.currency), ' they differ by ',
                    h('strong', fmt.money(Math.abs(plan.totals.translation), plan.currency)),
                    ' — that is translation, not a reconciling item, and it goes to the cumulative translation adjustment where a consolidated balance sheet expects it.'))
              : null,
            plan.missing_rates?.length
              ? h('div.callout.warn', { style: { marginTop: 'var(--s3)' } },
                'Balances in ', h('strong', plan.missing_rates.join(', ')),
                ` are left out: there is no rate into ${plan.currency} for this period.`)
              : null,
            h('div.grid-wrap', { style: { marginTop: 'var(--s3)', maxHeight: '260px' } }, h('table.grid',
              h('thead', h('tr', h('th', 'Company'), h('th', 'Account'), h('th.num', 'In its own books'),
                h('th.num', 'Debit'), h('th.num', 'Credit'))),
              h('tbody', ...plan.lines.map((l) => h('tr',
                h('td.muted', l.subsidiary_name),
                h('td', h('span.mono', l.number), ' ', l.name),
                h('td.num.muted', l.local_currency === plan.currency
                  ? h('span.faint', '—')
                  : fmt.money(Math.abs(l.local_balance), l.local_currency)),
                h('td.num', l.base_debit ? fmt.money(l.base_debit, plan.currency) : h('span.faint', '—')),
                h('td.num', l.base_credit ? fmt.money(l.base_credit, plan.currency) : h('span.faint', '—'))))))))
          : h('div.muted', 'Nothing was posted between companies in that period, so there is nothing to cancel.'));
      } catch (e) { mount(previewHost, h('div.callout.warn', e.message)); }
    }
    period.onchange = refresh;
    refresh();

    return modal({
      title: 'Eliminate a period',
      size: 'wide',
      body: h('div',
        h('div.form-grid', h('div.field', h('label', 'Period'), period), memo.el),
        h('div.callout', { style: { marginTop: 'var(--s4)' } },
          'The entry is posted in the ', h('strong', 'elimination subsidiary'),
          ', never in a trading company — each of those files its own accounts and must not carry the group’s consolidation adjustments. ',
          'Running a period again supersedes the last run rather than cancelling it twice.'),
        previewHost),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Post the elimination', kind: 'primary',
          onClick: async (close) => {
            try {
              const run = await API.runElimination({ period_id: period.value, memo: memo.get() });
              notifyOk(`${run.run_no} posted — ${run.lines.length} balances cancelled.`);
              close(true);
              load();
            } catch (e) { notifyError(e); return false; }
            return true;
          },
        },
      ],
    });
  }

  async function reverseRun(run) {
    const ok = await confirm({
      title: `Reverse ${run.run_no}?`,
      message: 'The cancelling entry is reversed and the transactions go back to being uneliminated.',
      detail: 'Each company’s own books are untouched either way — only the group view changes.',
      confirmLabel: 'Reverse it',
      danger: true,
    });
    if (!ok) return;
    try {
      await API.reverseElimination(run.id, { reason: 'Reversed from the intercompany screen' });
      notifyOk(`${run.run_no} reversed.`);
      load();
    } catch (e) { notifyError(e); }
  }

  load();
  return h('div.page', h('div.page-head', head), host);
}
