// Meridian ERP :: web/views/books
// Keeping more than one set of books over the same transactions.
//
// The screen leads with the difference between the bases, because that is the
// only thing anybody actually wants to know: we earned this under one set of
// rules and that under another, and here is exactly why.
import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import * as store from '../store.js';
import { empty, notifyError, notifyOk, statusTag, loading, modal, facts, confirm, fieldControl } from '../ui.js';

const SOURCE_LABEL = {
  manual: 'Posted by hand',
  depreciation: 'Depreciation',
  revenue: 'Revenue',
};

export async function booksView(route, { go }) {
  if (!store.can('accounting_book')) {
    return h('div.page', empty('Not permitted', 'Your role cannot see the accounting books.'));
  }
  const canEdit = store.can('accounting_book', store.LEVEL.EDIT);
  const canCreate = store.can('accounting_book', store.LEVEL.CREATE);
  const canDelete = store.can('accounting_book', store.LEVEL.FULL);
  const openId = route.parts[1] || null;

  const host = h('div');
  const head = h('div');

  async function load() {
    mount(host, loading('Reading the books'));
    try {
      if (openId) { renderOne(await API.book(openId)); return; }
      renderIndex(await API.books({}));
    } catch (e) { mount(host, empty('Could not open the books', e.message)); }
  }

  // ------------------------------------------------------------- index
  function renderIndex(data) {
    const secondary = data.rows.filter((b) => !b.is_primary);

    mount(head,
      h('div.titles',
        h('h1', 'Accounting Books'),
        h('div.page-sub', 'The same transactions, measured by more than one set of rules')),
      h('div.page-actions',
        canCreate ? h('button.btn.primary', { onclick: () => bookDialog(null) }, 'New book') : null));

    mount(host,
      h('div.callout', { style: { marginBottom: 'var(--s5)' } },
        'The ', h('strong', 'primary'), ' book is the ledger: everything posts there. Another book records only where it ',
        h('em', 'differs'), ' — a revenue recognised later, a machine depreciated over longer. Its statements are the ledger plus those differences, ',
        'so the ledger itself is never touched by having a second book and the difference between the two bases is something you can look at.'),

      h('div.card',
        h('div.card-head', h('h2', 'The books'),
          h('span.muted', { style: { fontSize: 'var(--t-sm)' } },
            data.comparison?.to ? `Compared to ${fmt.date(data.comparison.to)}` : '')),
        h('div.grid-wrap', h('table.grid',
          h('thead', h('tr', h('th', 'Book'), h('th', 'Code'), h('th', 'Purpose'), h('th', 'Basis'),
            h('th.num', 'Adjustments'), h('th.num', 'Profit differs by'), h('th', 'Status'))),
          h('tbody', ...data.rows.map((b) => {
            const c = (data.comparison?.books || []).find((x) => x.book_id === b.id) || {};
            return h('tr.clickable', { onclick: () => go(`/books/${b.id}`) },
              h('td', h('strong', b.name),
                b.is_primary ? h('span.tag.green', { style: { marginLeft: 'var(--s2)' } }, 'The ledger') : null,
                b.description ? h('div.muted', { style: { fontSize: 'var(--t-xs)' } }, b.description) : null),
              h('td', h('span.mono', b.code)),
              h('td.muted', b.purpose || '—'),
              h('td.muted', fmt.titleCase(b.basis)),
              h('td.num.muted', b.is_primary ? h('span.faint', '—') : String(c.adjustment_count ?? 0)),
              h('td.num', { class: c.profit_difference < 0 ? 'num-neg' : '' },
                b.is_primary
                  ? h('span.faint', '—')
                  : (c.profit_difference ? fmt.money(c.profit_difference) : h('span.faint', 'Agrees'))),
              h('td', b.status === 'active' ? h('span.tag.green', 'Active') : h('span.tag', 'Inactive')));
          }))))),

      secondary.length
        ? h('div.callout', { style: { marginTop: 'var(--s5)' } },
          'Every financial statement takes a book. Open ',
          h('a', { href: '#/reports', onclick: (e) => { e.preventDefault(); go('/reports'); } }, 'Reports'),
          ' and choose one to see the same period on a different basis.')
        : null);
  }

  // ------------------------------------------------------------ detail
  function renderOne(data) {
    const b = data.book;
    const adjustments = data.adjustments?.rows || [];

    mount(head,
      h('div.titles',
        h('div.breadcrumb', h('a', {
          href: '#/books',
          onclick: (e) => { e.preventDefault(); go('/books'); },
        }, 'Accounting Books')),
        h('h1', b.name, ' ', b.is_primary ? h('span.tag.green', 'The ledger') : statusTag(b.status)),
        h('div.page-sub', b.description || `Addressed as ${b.code}`)),
      h('div.page-actions',
        b.is_primary ? null : (canEdit ? h('button.btn', { onclick: () => adjustmentDialog(b) }, 'Post adjustment') : null),
        b.is_primary ? null : (canEdit ? h('button.btn', { onclick: () => assetRuleDialog(b, data.asset_rules) }, 'Asset rule') : null),
        b.is_primary ? null : (canEdit && data.asset_rules.length
          ? h('button.btn.primary', { onclick: () => depreciationDialog(b) }, 'Run depreciation') : null),
        canEdit ? h('button.btn', { onclick: () => bookDialog(b) }, 'Edit') : null,
        canDelete && !b.is_primary && !adjustments.length
          ? h('button.btn.danger', { onclick: () => removeBook(b) }, 'Delete') : null));

    mount(host,
      b.is_primary
        ? h('div.callout', { style: { marginBottom: 'var(--s5)' } },
          'This is the ledger itself. Every transaction in Meridian posts here, and it holds no adjustments — ',
          'the other books are the ones that record how they differ from it.')
        : null,

      h('div.card',
        h('div.card-head', h('h2', 'The book')),
        h('div.card-body', facts([
          ['Name', b.name],
          ['Code', h('span.mono', b.code)],
          ['Purpose', b.purpose || '—'],
          ['Basis', fmt.titleCase(b.basis)],
          ['Role', b.is_primary ? 'The ledger — everything posts here' : 'Records only where it differs from the ledger'],
          ['Adjustments', b.is_primary ? '—' : String(adjustments.length)],
          ['Status', b.status === 'active' ? h('span.tag.green', 'Active') : h('span.tag', 'Inactive')],
        ]))),

      b.is_primary
        ? null
        : h('div.card', { style: { marginTop: 'var(--s5)' } },
          h('div.card-head', h('h2', 'Assets this book depreciates differently'),
            h('span.muted', { style: { fontSize: 'var(--t-sm)' } },
              'The commonest reason for a second set of books at all')),
          data.asset_rules.length
            ? h('div.grid-wrap', h('table.grid',
              h('thead', h('tr', h('th', 'Asset'), h('th.num', 'Cost'), h('th', 'In the ledger'),
                h('th', 'In this book'), h('th', 'Why'), h('th', ''))),
              h('tbody', ...data.asset_rules.map((r) => h('tr',
                h('td', h('strong', r.asset_no), h('div.muted', { style: { fontSize: 'var(--t-xs)' } }, r.asset_name)),
                h('td.num', fmt.money(r.cost)),
                h('td.muted', `${r.primary_life} months, ${fmt.titleCase(r.primary_method.replace(/_/g, ' ').toLowerCase())}`),
                h('td', h('strong', `${r.life_months} months`), ' ',
                  h('span.muted', fmt.titleCase(r.method.replace(/_/g, ' ').toLowerCase()))),
                h('td.muted', { style: { fontSize: 'var(--t-xs)' } }, r.note || ''),
                h('td', canEdit
                  ? h('button.btn.sm', { onclick: () => removeRule(b, r) }, 'Remove')
                  : h('span.faint', '—')))))))
            : h('div.card-body', h('div.muted',
              'None. Add a rule and this book will depreciate that asset on its own terms, posting only the difference from the ledger.'))),

      b.is_primary
        ? null
        : h('div.card', { style: { marginTop: 'var(--s5)' } },
          h('div.card-head', h('h2', 'Adjustments'),
            h('span.muted', { style: { fontSize: 'var(--t-sm)' } }, 'Where this book parts company with the ledger')),
          adjustments.length
            ? h('div.grid-wrap', { style: { maxHeight: '420px' } }, h('table.grid',
              h('thead', h('tr', h('th', 'Entry'), h('th', 'Date'), h('th', 'Period'), h('th', 'Why'),
                h('th', 'Memo'), h('th.num', 'Amount'), h('th', ''))),
              h('tbody', ...adjustments.map((a) => h('tr',
                h('td', h('strong', a.entry_no)),
                h('td.muted', fmt.date(a.txn_date)),
                h('td.muted', a.period_name || '—'),
                h('td', h('span.tag', SOURCE_LABEL[a.source_type] || a.source_type)),
                h('td.muted', a.memo || ''),
                h('td.num', fmt.money(a.total_debit)),
                h('td', a.status === 'posted' && canEdit
                  ? h('button.btn.sm', { onclick: () => reverseAdjustment(b, a) }, 'Reverse')
                  : statusTag(a.status)))))))
            : h('div.card-body', h('div.muted',
              'Nothing yet, so this book agrees with the ledger exactly.'))));
  }

  // ------------------------------------------------------------ dialogs
  function bookDialog(existing) {
    const isNew = !existing;
    const fields = [
      { name: 'name', label: 'Name', type: 'text', required: true, help: 'What people will call it — “IFRS”, “Tax”.' },
      {
        name: 'code', label: 'Code', type: 'text', required: true,
        help: 'Capital letters, digits and underscores. It is the address the book is filed under and cannot change afterwards.',
      },
      { name: 'purpose', label: 'Purpose', type: 'text', help: 'The basis of accounting it represents.' },
      { name: 'basis', label: 'Basis', type: 'select', options: ['accrual', 'cash'] },
      { name: 'description', label: 'What it is for', type: 'longtext', full: true },
    ];
    if (!isNew && !existing.is_primary) {
      fields.push({ name: 'status', label: 'Status', type: 'select', options: ['active', 'inactive'] });
    }

    const controls = {};
    const formHost = h('div.form-grid');
    for (const f of fields) {
      const ctl = fieldControl(f, existing ? existing[f.name] ?? '' : (f.name === 'basis' ? 'accrual' : ''), null);
      if (f.name === 'code' && !isNew) ctl.el.querySelectorAll('input').forEach((i) => { i.disabled = true; });
      controls[f.name] = ctl;
      formHost.appendChild(ctl.el);
    }

    return modal({
      title: isNew ? 'New accounting book' : `Edit ${existing.name}`,
      body: h('div', formHost,
        isNew
          ? h('div.callout', { style: { marginTop: 'var(--s4)' } },
            'A new book starts agreeing with the ledger exactly. It only begins to differ when you post an adjustment to it, '
            + 'or give it its own rule for depreciating an asset.')
          : null),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: isNew ? 'Create it' : 'Save', kind: 'primary',
          onClick: async (close) => {
            const payload = Object.fromEntries(fields.map((f) => [f.name, controls[f.name].get()]));
            if (!isNew) delete payload.code;
            try {
              if (isNew) {
                const made = await API.createBook(payload);
                notifyOk(`${made.name} created.`);
                close(true);
                await store.loadMeta();
                go(`/books/${made.id}`);
              } else {
                await API.updateBook(existing.id, payload);
                notifyOk(`${payload.name} saved.`);
                close(true);
                await store.loadMeta();
                load();
              }
            } catch (e) { notifyError(e); return false; }
            return true;
          },
        },
      ],
    });
  }

  async function adjustmentDialog(book) {
    await store.ensureRefs(['account', 'subsidiary']);
    const accountOptions = (await store.refOptions('account')).filter((o) => !o.row?.is_summary);
    const subsidiaries = await store.refOptions('subsidiary');

    const sub = h('select', ...subsidiaries.filter((o) => !o.row?.is_elimination)
      .map((o, i) => h('option', { value: o.value, selected: i === 0 }, o.label)));
    const date = fieldControl({ name: 'txn_date', label: 'Date', type: 'date' }, fmt.today(), null);
    const memo = fieldControl({ name: 'memo', label: 'Why the books differ', type: 'text', full: true }, '', null);

    let lines = [{ account_id: '', debit: '', credit: '' }, { account_id: '', debit: '', credit: '' }];
    const body = h('tbody');
    const totals = h('div.muted', { style: { marginTop: 'var(--s2)', textAlign: 'right' } });

    function retotal() {
      const d = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
      const c = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
      totals.textContent = d === c
        ? `Balanced at ${fmt.money(Math.round(d * 100))}`
        : `Out by ${fmt.money(Math.round(Math.abs(d - c) * 100))} — debits ${fmt.money(Math.round(d * 100))}, credits ${fmt.money(Math.round(c * 100))}`;
      totals.className = d === c ? 'muted' : 'num-neg';
    }

    function draw() {
      while (body.firstChild) body.removeChild(body.firstChild);
      lines.forEach((l, i) => {
        const acct = h('select', { onchange: (e) => { l.account_id = e.target.value; } },
          h('option', { value: '' }, '— account —'),
          ...accountOptions.map((o) => h('option', { value: o.value, selected: o.value === l.account_id }, o.label)));
        const debit = h('input', {
          type: 'number', step: '0.01', class: 'num', value: l.debit,
          oninput: (e) => { l.debit = e.target.value; if (e.target.value) l.credit = ''; retotal(); },
        });
        const credit = h('input', {
          type: 'number', step: '0.01', class: 'num', value: l.credit,
          oninput: (e) => { l.credit = e.target.value; if (e.target.value) l.debit = ''; retotal(); },
        });
        body.appendChild(h('tr',
          h('td', { style: { minWidth: '240px' } }, acct),
          h('td', { style: { width: '120px' } }, debit),
          h('td', { style: { width: '120px' } }, credit),
          h('td', { style: { width: '28px' } }, h('button.rm', {
            onclick: () => { lines.splice(i, 1); if (lines.length < 2) lines.push({ account_id: '', debit: '', credit: '' }); draw(); retotal(); },
          }, icon('x', { size: 13 })))));
      });
    }
    draw();
    retotal();

    return modal({
      title: `Adjustment in ${book.name}`,
      size: 'wide',
      body: h('div',
        h('div.callout',
          'This records how ', h('strong', book.name), ' differs from the ledger — not the whole transaction. ',
          'The ledger has already recorded that.'),
        h('div.form-grid', { style: { marginTop: 'var(--s4)' } },
          h('div.field', h('label', 'Company'), sub), date.el, memo.el),
        h('div.row', { style: { justifyContent: 'space-between', alignItems: 'center', margin: 'var(--s5) 0 var(--s2)' } },
          h('h3', { style: { margin: 0, fontSize: 'var(--t-md)' } }, 'The difference'),
          h('button.btn.sm', { onclick: () => { lines.push({ account_id: '', debit: '', credit: '' }); draw(); } }, icon('plus', { size: 13 }), 'Add line')),
        h('div.grid-wrap', h('table.lines-table',
          h('thead', h('tr', h('th', 'Account'), h('th', 'Debit'), h('th', 'Credit'), h('th', ''))),
          body)),
        totals),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Post it', kind: 'primary',
          onClick: async (close) => {
            try {
              const made = await API.postBookAdjustment(book.id, {
                subsidiary_id: sub.value, txn_date: date.get(), memo: memo.get(),
                lines: lines.filter((l) => l.account_id && (Number(l.debit) || Number(l.credit))).map((l) => ({
                  account_id: l.account_id,
                  base_debit: Math.round((Number(l.debit) || 0) * 100),
                  base_credit: Math.round((Number(l.credit) || 0) * 100),
                })),
              });
              notifyOk(`${made.entry_no} posted in ${book.name}.`);
              close(true);
              load();
            } catch (e) { notifyError(e); return false; }
            return true;
          },
        },
      ],
    });
  }

  async function assetRuleDialog(book, existingRules) {
    const reg = await API.assetRegister({});
    const already = new Set((existingRules || []).map((r) => r.asset_id));
    const available = reg.assets.filter((a) => !already.has(a.id) && a.status !== 'draft');
    if (!available.length) {
      notifyError(new Error('Every asset in service already has a rule in this book.'));
      return;
    }

    const asset = h('select', ...available.map((a, i) => h('option', { value: a.id, selected: i === 0 },
      `${a.asset_no} — ${a.name} (${a.life_months} months in the ledger)`)));
    const method = fieldControl({
      name: 'method', label: 'Method', type: 'select',
      options: ['STRAIGHT_LINE', 'DECLINING_BALANCE', 'SUM_OF_YEARS', 'UNITS_OF_PRODUCTION'],
    }, 'STRAIGHT_LINE', null);
    const life = fieldControl({ name: 'life_months', label: 'Life in this book (months)', type: 'number', required: true }, 120, null);
    const salvage = fieldControl({ name: 'salvage_value', label: 'Residual value', type: 'money' }, 0, null);
    const note = fieldControl({ name: 'note', label: 'Why', type: 'text', full: true }, '', null);

    return modal({
      title: `How ${book.name} depreciates an asset`,
      body: h('div',
        h('div.form-grid',
          h('div.field', h('label', 'Asset'), asset),
          method.el, life.el, salvage.el, note.el),
        h('div.callout', { style: { marginTop: 'var(--s4)' } },
          'The ledger keeps charging its own figure. This book posts only the ',
          h('strong', 'difference'), ', so its depreciation comes out at the life you set here and the asset itself is unchanged.')),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Set the rule', kind: 'primary',
          onClick: async (close) => {
            try {
              await API.setAssetBookRule(book.id, {
                asset_id: asset.value, method: method.get(),
                life_months: Number(life.get()) || 0, salvage_value: salvage.get(), note: note.get(),
              });
              notifyOk('Rule set.');
              close(true);
              load();
            } catch (e) { notifyError(e); return false; }
            return true;
          },
        },
      ],
    });
  }

  async function depreciationDialog(book) {
    const through = fieldControl({ name: 'through', label: 'Up to', type: 'date' }, fmt.today(), null);
    const previewHost = h('div', { style: { marginTop: 'var(--s4)' } });

    async function refresh() {
      mount(previewHost, loading('Working out the difference'));
      try {
        const plan = await API.runBookDepreciation(book.id, { through: through.get(), dry_run: true });
        mount(previewHost, plan.planned.length
          ? h('div',
            facts([
              ['Periods to adjust', String(plan.planned.length)],
              ['Total difference', h('strong', { class: plan.total_difference < 0 ? 'num-neg' : '' }, fmt.money(plan.total_difference))],
            ]),
            h('div.grid-wrap', { style: { marginTop: 'var(--s3)', maxHeight: '260px' } }, h('table.grid',
              h('thead', h('tr', h('th', 'Asset'), h('th', 'Period'), h('th.num', 'The ledger'),
                h('th.num', 'This book'), h('th.num', 'Difference'))),
              h('tbody', ...plan.planned.map((p) => h('tr',
                h('td.muted', p.asset_no),
                h('td.muted', fmt.date(p.depr_date)),
                h('td.num.muted', fmt.money(p.primary_amount)),
                h('td.num', fmt.money(p.book_amount)),
                h('td.num', { class: p.difference < 0 ? 'num-neg' : '' }, fmt.money(p.difference))))))))
          : h('div.muted', 'Nothing to adjust — every period the ledger has charged is already accounted for in this book.'));
      } catch (e) { mount(previewHost, h('div.callout.warn', e.message)); }
    }
    through.el.addEventListener('change', refresh);
    refresh();

    return modal({
      title: `Depreciation in ${book.name}`,
      size: 'wide',
      body: h('div',
        h('div.form-grid', through.el),
        h('div.callout', { style: { marginTop: 'var(--s4)' } },
          'Only the difference from the ledger is posted. A period already adjusted is never adjusted again, so running this twice costs nothing.'),
        previewHost),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Post the differences', kind: 'primary',
          onClick: async (close) => {
            try {
              const out = await API.runBookDepreciation(book.id, { through: through.get() });
              notifyOk(out.posted ? `${out.posted} adjustment${out.posted === 1 ? '' : 's'} posted.` : 'Nothing needed adjusting.');
              close(true);
              load();
            } catch (e) { notifyError(e); return false; }
            return true;
          },
        },
      ],
    });
  }

  async function reverseAdjustment(book, a) {
    const ok = await confirm({
      title: `Reverse ${a.entry_no}?`,
      message: `${book.name} goes back to agreeing with the ledger on this.`,
      confirmLabel: 'Reverse it',
      danger: true,
    });
    if (!ok) return;
    try {
      await API.reverseBookAdjustment(book.id, a.id, {});
      notifyOk(`${a.entry_no} reversed.`);
      load();
    } catch (e) { notifyError(e); }
  }

  async function removeRule(book, rule) {
    const ok = await confirm({
      title: `Remove the rule for ${rule.asset_no}?`,
      message: 'This book will depreciate it the way the ledger does from now on.',
      detail: 'Adjustments already posted stay where they are; reverse those separately if you want them gone.',
      confirmLabel: 'Remove it',
      danger: true,
    });
    if (!ok) return;
    try {
      await API.removeAssetBookRule(book.id, rule.id);
      notifyOk('Rule removed.');
      load();
    } catch (e) { notifyError(e); }
  }

  async function removeBook(b) {
    const ok = await confirm({
      title: `Delete ${b.name}?`,
      message: 'It holds no adjustments, so nothing is lost.',
      confirmLabel: 'Delete it',
      danger: true,
    });
    if (!ok) return;
    try {
      await API.deleteBook(b.id);
      notifyOk(`${b.name} deleted.`);
      await store.loadMeta();
      go('/books');
    } catch (e) { notifyError(e); }
  }

  load();
  return h('div.page', h('div.page-head', head), host);
}
