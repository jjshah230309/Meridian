// Meridian ERP :: web/views/journal
// Journal entry viewer and the manual entry editor, with a live balance
// check — the editor refuses to submit until debits equal credits, which is
// the same rule the server enforces.
import { h, mount, clear } from '../dom.js';
import { icon } from '../icons.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import * as store from '../store.js';
import { fieldControl, empty, toast, notifyError, confirm, modal, statusTag, facts } from '../ui.js';

export async function journalView(route, { go }) {
  const id = route.parts[1];
  const e = await API.journal(id);
  await store.ensureRefs(['account', 'subsidiary', 'department', 'location', 'customer', 'vendor']);

  const canReverse = store.can('journal_entry', store.LEVEL.FULL) && e.status === 'posted' && !e.reversed_by_id;

  return h('div.page',
    h('div.page-head',
      h('div.titles',
        h('div.breadcrumb', h('a', { href: '#/list/journal_entry', onclick: (ev) => { ev.preventDefault(); go('/list/journal_entry'); } }, 'Journal Entries')),
        h('h1', `Journal ${e.entry_no}`, statusTag(e.status),
          e.is_reversal ? h('span.tag.amber', 'Reversal') : null,
          e.reversed_by_id ? h('span.tag.red', 'Reversed') : null),
        h('div.page-sub', `${fmt.date(e.txn_date)} · ${e.period?.name || ''} · ${fmt.titleCase(e.source_type)}`)),
      h('div.page-actions',
        e.source_type !== 'manual' && e.source_id
          ? h('button.btn', { onclick: () => go(`/txn/${e.source_id}`) }, 'Open source document') : null,
        canReverse && h('button.btn.danger', { onclick: () => reverseDialog(e, go) }, 'Reverse entry'),
        h('button.btn.no-print', { onclick: () => window.print() }, icon('printer', { size: 13 }), 'Print'))),

    h('div.split',
      h('div.card',
        h('div.card-head', h('h2', 'Lines'), h('span.muted', { style: { fontSize: '12px' } }, `${e.lines.length} lines`)),
        h('div.grid-wrap', h('table.grid',
          h('thead', h('tr',
            h('th', '#'), h('th', 'Account'), h('th', 'Memo'), h('th', 'Entity'),
            h('th.num', 'Debit'), h('th.num', 'Credit'))),
          h('tbody', ...e.lines.map((l) => h('tr',
            h('td.faint', String(l.line_no)),
            h('td', h('a', {
              href: `#/account/${l.account_id}`,
              onclick: (ev) => { ev.preventDefault(); go(`/account/${l.account_id}`); },
            }, h('span.mono', l.account_number), ' ', l.account_name)),
            h('td.muted', l.memo || ''),
            h('td.muted', l.entity_id ? store.refLabelSync(l.entity_type, l.entity_id) || '—' : '—'),
            h('td.num', l.base_debit ? fmt.money(l.base_debit) : h('span.faint', '')),
            h('td.num', l.base_credit ? fmt.money(l.base_credit) : h('span.faint', ''))))),
          h('tfoot', h('tr',
            h('td', { colspan: 4 }, 'Totals'),
            h('td.num', fmt.money(e.total_debit)),
            h('td.num', fmt.money(e.total_credit))))))),

      h('div.stack',
        h('div.card',
          h('div.card-head', h('h2', 'Entry')),
          h('div.card-body', facts([
            ['Number', h('span.mono', e.entry_no)],
            ['Date', fmt.date(e.txn_date)],
            ['Period', e.period?.name || '—'],
            ['Subsidiary', e.subsidiary?.name || '—'],
            ['Currency', e.currency + (e.fx_rate !== 1 ? ` @ ${e.fx_rate.toFixed(4)}` : '')],
            ['Source', fmt.titleCase(e.source_type)],
            ['Posted', e.posted_at ? fmt.dateTime(e.posted_at) : '—'],
            ['Balanced', e.total_debit === e.total_credit ? h('span.tag.green', 'Yes') : h('span.tag.red', 'No')],
          ]),
            e.memo && h('div', { style: { marginTop: '12px' } },
              h('div.muted', { style: { fontSize: '11.5px', fontWeight: 600 } }, 'MEMO'),
              h('div', e.memo)))))));
}

async function reverseDialog(entry, go) {
  const dateInput = h('input', { type: 'date', value: fmt.today() });
  const memoInput = h('input', { type: 'text', placeholder: `Reversal of ${entry.entry_no}` });
  modal({
    title: `Reverse ${entry.entry_no}?`, size: 'narrow',
    body: h('div',
      h('div.muted', { style: { marginBottom: '12px' } },
        'A posted entry is never edited. Meridian writes an equal and opposite entry so both the original and the correction stay in the audit trail.'),
      h('div.field', h('label', 'Reversal date'), dateInput),
      h('div.field', { style: { marginTop: '10px' } }, h('label', 'Memo'), memoInput)),
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'Post reversal', kind: 'danger',
        onClick: async () => {
          const rev = await API.reverseJournal(entry.id, { date: dateInput.value, memo: memoInput.value || undefined });
          toast(`Reversal ${rev.entry_no} posted`, { kind: 'success' });
          go(`/journal/${rev.id}`);
        },
      },
    ],
  });
}

// =============================================================== editor
export async function journalEditor(route, { go }) {
  if (!store.can('journal_entry', store.LEVEL.CREATE)) {
    return h('div.page', empty('Not permitted', 'Your role cannot post journal entries.'));
  }
  const accounts = await store.refOptions('account');
  const postable = accounts.filter((a) => !a.row.is_summary && a.row.active !== 0);
  const subsidiaries = store.state.meta.subsidiaries || [];

  const model = {
    subsidiary_id: subsidiaries[0]?.id || '',
    txn_date: fmt.today(),
    currency: store.state.tenant.base_currency,
    memo: '',
  };
  let lines = [blank(), blank()];
  function blank() { return { account_id: '', memo: '', debit: '', credit: '' }; }

  const controls = {};
  const headerHost = h('div.form-grid');
  for (const f of [
    subsidiaries.length > 1 && { name: 'subsidiary_id', label: 'Subsidiary', type: 'reference', ref: 'subsidiary', required: true },
    { name: 'txn_date', label: 'Date', type: 'date', required: true },
    { name: 'currency', label: 'Currency', type: 'select', options: (store.state.meta.currencies || []).map((c) => ({ value: c.code, label: `${c.code} — ${c.name}` })) },
    { name: 'memo', label: 'Memo', type: 'text', full: true },
  ].filter(Boolean)) {
    const ctl = fieldControl(f, model[f.name], (v) => { model[f.name] = v; });
    controls[f.name] = ctl;
    headerHost.appendChild(ctl.el);
  }

  const body = h('tbody');
  const balanceBox = h('div');

  function totals() {
    const d = lines.reduce((a, l) => a + (Number(l.debit) || 0), 0);
    const c = lines.reduce((a, l) => a + (Number(l.credit) || 0), 0);
    return { debit: d, credit: c, diff: Math.round((d - c) * 100) / 100 };
  }

  function recalc() {
    const t = totals();
    mount(balanceBox,
      h('div.row', { style: { justifyContent: 'flex-end', gap: '22px', padding: '10px 12px' } },
        h('div', h('div.muted', { style: { fontSize: '11px' } }, 'DEBITS'), h('div', { style: { fontSize: '15px', fontWeight: 600, textAlign: 'right' } }, fmt.money(Math.round(t.debit * 100), model.currency))),
        h('div', h('div.muted', { style: { fontSize: '11px' } }, 'CREDITS'), h('div', { style: { fontSize: '15px', fontWeight: 600, textAlign: 'right' } }, fmt.money(Math.round(t.credit * 100), model.currency))),
        h('div', h('div.muted', { style: { fontSize: '11px' } }, 'DIFFERENCE'),
          h('div', { style: { fontSize: '15px', fontWeight: 600, textAlign: 'right' }, class: t.diff === 0 ? 'num-pos' : 'num-neg' },
            fmt.money(Math.round(t.diff * 100), model.currency)))));
    postBtn.disabled = t.diff !== 0 || t.debit === 0;
    postBtn.title = t.diff !== 0 ? 'Debits and credits must be equal before this entry can post' : '';
  }

  function draw() {
    clear(body);
    lines.forEach((l, i) => {
      const acct = h('select', { onchange: (e) => { l.account_id = e.target.value; } },
        h('option', { value: '' }, '— account —'),
        ...postable.map((a) => h('option', { value: a.value, selected: a.value === l.account_id }, a.label)));
      const memo = h('input', { type: 'text', value: l.memo, oninput: (e) => { l.memo = e.target.value; } });
      const debit = h('input', { type: 'number', step: '0.01', class: 'num', value: l.debit, oninput: (e) => { l.debit = e.target.value; if (e.target.value) { l.credit = ''; credit.value = ''; } recalc(); } });
      const credit = h('input', { type: 'number', step: '0.01', class: 'num', value: l.credit, oninput: (e) => { l.credit = e.target.value; if (e.target.value) { l.debit = ''; debit.value = ''; } recalc(); } });
      body.appendChild(h('tr',
        h('td', { style: { width: '30px' } }, h('span.faint', String(i + 1))),
        h('td', { style: { minWidth: '260px' } }, acct),
        h('td', memo),
        h('td', { style: { width: '130px' } }, debit),
        h('td', { style: { width: '130px' } }, credit),
        h('td', { style: { width: '30px' } }, h('button.rm', {
          onclick: () => { lines.splice(i, 1); if (lines.length < 2) lines.push(blank()); draw(); recalc(); },
        }, icon('x', { size: 13 })))));
    });
  }

  const postBtn = h('button.btn.primary', {
    onclick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = 'Posting…';
      try {
        const entry = await API.postJournal({
          subsidiary_id: controls.subsidiary_id ? controls.subsidiary_id.get() : subsidiaries[0]?.id,
          txn_date: controls.txn_date.get(),
          currency: controls.currency.get(),
          memo: controls.memo.get() || '',
          lines: lines.filter((l) => l.account_id && (Number(l.debit) || Number(l.credit)))
            .map((l) => ({ account_id: l.account_id, memo: l.memo, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0 })),
        });
        toast(`Journal ${entry.entry_no} posted`, { kind: 'success' });
        go(`/journal/${entry.id}`);
      } catch (err) {
        notifyError(err);
        btn.disabled = false; btn.textContent = 'Post entry';
      }
    },
  }, 'Post entry');

  draw();
  recalc();

  return h('div.page',
    h('div.page-head',
      h('div.titles',
        h('div.breadcrumb', h('a', { href: '#/list/journal_entry', onclick: (e) => { e.preventDefault(); go('/list/journal_entry'); } }, 'Journal Entries')),
        h('h1', 'New journal entry'),
        h('div.page-sub', 'Manual entries post straight to the ledger and cannot be edited afterwards.')),
      h('div.page-actions',
        h('button.btn', { onclick: () => go('/list/journal_entry') }, 'Cancel'),
        postBtn)),
    h('div.card', h('div.card-head', h('h2', 'Header')), h('div.card-body', headerHost)),
    h('div.card', { style: { marginTop: '12px' } },
      h('div.card-head', h('h2', 'Lines'),
        h('div.actions', h('button.btn.sm', { onclick: () => { lines.push(blank()); draw(); } }, icon('plus', { size: 13 }), 'Add line'))),
      h('div.grid-wrap', h('table.lines-table',
        h('thead', h('tr', h('th', ''), h('th', 'Account'), h('th', 'Memo'), h('th', 'Debit'), h('th', 'Credit'), h('th', ''))),
        body)),
      h('div', { style: { borderTop: '1px solid var(--border)' } }, balanceBox)));
}
