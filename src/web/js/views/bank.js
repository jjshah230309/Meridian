// Meridian ERP :: web/views/bank
// Cash position, statement import, match suggestions and reconciliation.
import { h, mount, clear } from '../dom.js';
import { icon } from '../icons.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import * as store from '../store.js';
import { empty, toast, notifyError, modal, confirm, statusTag, facts, loading } from '../ui.js';

export async function bankView(route, { go }) {
  const accountId = route.parts[1];
  if (accountId === 'rec' && route.parts[2]) return reconciliationView(route.parts[2], go);
  if (accountId) return accountView(accountId, go);
  return overviewView(go);
}

// ------------------------------------------------------------- overview
async function overviewView(go) {
  const { accounts, position } = await API.bankAccounts();

  const kpis = h('div.kpi-grid', { style: { marginBottom: '14px' } },
    h('div.kpi',
      h('div.k-label', 'Cash on hand'),
      h('div.k-value', fmt.moneyCompact(position.total_cash)),
      h('div.k-meta', `${accounts.length} account${accounts.length === 1 ? '' : 's'}`)),
    h('div.kpi',
      h('div.k-label', `Expected in (${position.horizon_days}d)`),
      h('div.k-value', fmt.moneyCompact(position.expected_inflow)),
      h('div.k-meta', `${fmt.moneyCompact(position.overdue_receivable)} already overdue`)),
    h('div.kpi',
      h('div.k-label', `Expected out (${position.horizon_days}d)`),
      h('div.k-value', fmt.moneyCompact(position.expected_outflow)),
      h('div.k-meta', 'Bills falling due')),
    h('div.kpi',
      h('div.k-label', 'Projected position'),
      h('div.k-value', fmt.moneyCompact(position.projected_cash)),
      h('div.k-meta', position.net_position >= 0 ? 'Net inflow' : 'Net outflow')));

  const rows = accounts.map((a) => h('tr.clickable', { onclick: () => go(`/bank/${a.id}`) },
    h('td', h('strong', a.name)),
    h('td.muted', a.bank_name || '—'),
    h('td.muted', a.number_masked ? `••••${a.number_masked}` : '—'),
    h('td.muted', h('span.mono', a.account_number), ' ', a.account_name),
    h('td', a.currency),
    h('td.num', h('strong', fmt.money(a.gl_balance, a.currency))),
    h('td.num', a.unreconciled_count
      ? h('span.tag.amber', `${a.unreconciled_count} to clear`)
      : h('span.tag.green', 'Clear')),
    h('td.muted', a.last_statement ? fmt.date(a.last_statement.statement_date) : 'Never')));

  const table = h('div.card',
    h('div.card-head', h('h2', 'Bank accounts')),
    h('div.grid-wrap', h('table.grid',
      h('thead', h('tr', h('th', 'Account'), h('th', 'Bank'), h('th', 'Number'), h('th', 'GL account'), h('th', 'Ccy'), h('th.num', 'Ledger balance'), h('th.num', 'Status'), h('th', 'Last reconciled'))),
      h('tbody', ...rows))));

  return h('div.page',
    h('div.page-head',
      h('div.titles', h('h1', 'Banking'),
        h('div.page-sub', 'Ledger balances, statement matching and reconciliation.')),
      h('div.page-actions',
        store.can('bank_account', store.LEVEL.CREATE) && h('button.btn', { onclick: () => go('/new/bank_account') }, icon('plus', { size: 14 }), 'New bank account'))),
    kpis, table);
}

// -------------------------------------------------------------- account
async function accountView(id, go) {
  const { accounts } = await API.bankAccounts();
  const account = accounts.find((a) => a.id === id);
  if (!account) return h('div.page', empty('Bank account not found', ''));

  const host = h('div');

  async function load() {
    mount(host, loading());
    const txns = await API.bankTxns(id, { limit: 300 });
    const unmatched = txns.filter((t) => t.status === 'unmatched');

    const rows = txns.map((t) => h('tr',
      h('td.nowrap', fmt.date(t.txn_date)),
      h('td', h('span.cell-truncate', t.description)),
      h('td.muted', t.reference || ''),
      h('td.num', { class: t.amount < 0 ? 'num-neg' : 'num-pos' }, fmt.money(t.amount, account.currency)),
      h('td', statusTag(t.status)),
      h('td.muted', t.entry_no ? h('span.mono', t.entry_no) : '—'),
      h('td', { style: { textAlign: 'right' } }, t.status === 'unmatched'
        ? h('button.btn.sm', { onclick: () => matchDialog(t, load) }, 'Match')
        : t.status === 'matched'
          ? h('button.btn.sm.ghost', {
            onclick: async () => { try { await API.unmatch(t.id); load(); } catch (e) { notifyError(e); } },
          }, 'Unmatch')
          : '')));

    mount(host,
      h('div.card',
        h('div.card-head',
          h('h2', 'Statement lines'),
          h('span.muted', { style: { fontSize: '12px' } }, `${txns.length} imported · ${unmatched.length} unmatched`),
          h('div.actions',
            h('button.btn.sm', { onclick: () => importDialog(id, load) }, '⤒ Import CSV'),
            unmatched.length ? h('button.btn.sm', {
              onclick: async () => {
                try {
                  const r = await API.autoMatch(id);
                  toast(`${r.auto_applied} line${r.auto_applied === 1 ? '' : 's'} matched automatically`, { kind: r.auto_applied ? 'success' : 'info' });
                  load();
                } catch (e) { notifyError(e); }
              },
            }, '⚡ Auto-match') : null,
            store.can('reconciliation', store.LEVEL.CREATE)
              ? h('button.btn.sm.primary', { onclick: () => startRecDialog(account, go) }, 'Reconcile')
              : null)),
        txns.length
          ? h('div.grid-wrap', h('table.grid',
            h('thead', h('tr', h('th', 'Date'), h('th', 'Description'), h('th', 'Reference'), h('th.num', 'Amount'), h('th', 'Status'), h('th', 'Journal'), h('th', ''))),
            h('tbody', ...rows)))
          : empty('No statement lines', 'Import a CSV statement to begin matching.',
            h('button.btn.primary', { onclick: () => importDialog(id, load) }, 'Import statement'))));
  }

  async function matchDialog(bankTxn, onDone) {
    const { suggestions } = await API.suggestMatches(id);
    const entry = suggestions.find((s) => s.bank_txn.id === bankTxn.id);
    const candidates = entry?.candidates || [];
    modal({
      title: `Match ${fmt.money(bankTxn.amount, account.currency)} on ${fmt.date(bankTxn.txn_date)}`,
      size: 'wide',
      body: candidates.length
        ? h('div',
          h('div.muted', { style: { marginBottom: '10px' } }, bankTxn.description),
          h('table.grid.compact',
            h('thead', h('tr', h('th', 'Entry'), h('th', 'Date'), h('th', 'Memo'), h('th', 'Confidence'), h('th', ''))),
            h('tbody', ...candidates.map((c) => h('tr',
              h('td', h('span.mono', c.entry_no)),
              h('td', fmt.date(c.txn_date)),
              h('td', h('span.cell-truncate', c.memo || '')),
              h('td', h('span.tag', { class: c.confidence === 'high' ? 'green' : c.confidence === 'medium' ? 'amber' : '' }, `${c.confidence} · ${c.day_gap}d apart`)),
              h('td', h('button.btn.sm.primary', {
                onclick: async (e) => {
                  e.currentTarget.disabled = true;
                  try { await API.match(bankTxn.id, c.entry_id); toast('Matched', { kind: 'success' }); onDone(); document.querySelector('.overlay')?.remove(); }
                  catch (err) { notifyError(err); }
                },
              }, 'Match')))))))
        : h('div',
          h('div.muted', bankTxn.description),
          empty('No ledger entry matches', 'Nothing posted to this bank account for that amount within a week. Record the transaction first — a bank fee, for example, needs a journal entry before it can be reconciled.')),
      actions: [{ label: 'Close', value: null }],
    });
  }

  await load();

  return h('div.page',
    h('div.page-head',
      h('div.titles',
        h('div.breadcrumb', h('a', { href: '#/bank', onclick: (e) => { e.preventDefault(); go('/bank'); } }, 'Banking')),
        h('h1', account.name),
        h('div.page-sub', `${account.bank_name || 'Bank'} · ${account.currency} · ledger balance ${fmt.money(account.gl_balance, account.currency)}`)),
      h('div.page-actions',
        h('button.btn', { onclick: () => go(`/account/${account.account_id}`) }, 'GL ledger'))),
    host);
}

function importDialog(bankAccountId, onDone) {
  const textarea = h('textarea', {
    style: { width: '100%', minHeight: '190px', fontFamily: 'var(--mono)', fontSize: '12px' },
    placeholder: 'Date,Description,Amount\n2026-09-01,Customer payment ACME,4820.00\n2026-09-02,Bank fee,-45.00',
  });
  const fileInput = h('input', {
    type: 'file', accept: '.csv,text/csv',
    onchange: async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      textarea.value = await file.text();
    },
  });
  modal({
    title: 'Import bank statement',
    body: h('div',
      h('div.muted', { style: { marginBottom: '10px' } },
        'Paste CSV or choose a file. Columns are matched by name — date, description, amount, or separate debit and credit columns. Re-importing the same file will not duplicate lines.'),
      fileInput,
      h('div', { style: { marginTop: '10px' } }, textarea)),
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'Import', kind: 'primary',
        onClick: async () => {
          if (!textarea.value.trim()) { toast('Nothing to import', { kind: 'warn' }); return false; }
          const r = await API.importStatement(bankAccountId, { csv: textarea.value });
          toast(`${r.imported} line${r.imported === 1 ? '' : 's'} imported${r.skipped ? `, ${r.skipped} skipped as duplicates` : ''}`, { kind: 'success' });
          onDone();
        },
      },
    ],
  });
}

function startRecDialog(account, go) {
  const dateInput = h('input', { type: 'date', value: fmt.today() });
  const balanceInput = h('input', { type: 'number', step: '0.01', class: 'num', placeholder: '0.00' });
  modal({
    title: `Reconcile ${account.name}`, size: 'narrow',
    body: h('div',
      h('div.muted', { style: { marginBottom: '12px' } }, 'Enter the closing balance from your bank statement. Meridian will show which ledger entries clear to it.'),
      h('div.field', h('label', 'Statement date'), dateInput),
      h('div.field', { style: { marginTop: '10px' } }, h('label', `Statement closing balance (${account.currency})`), balanceInput)),
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'Start', kind: 'primary',
        onClick: async () => {
          const state = await API.startRec({
            bank_account_id: account.id,
            statement_date: dateInput.value,
            statement_balance: Number(balanceInput.value || 0),
          });
          go(`/bank/rec/${state.reconciliation.id}`);
        },
      },
    ],
  });
}

// ------------------------------------------------------- reconciliation
async function reconciliationView(recId, go) {
  const host = h('div');
  const selected = new Set();

  async function load() {
    mount(host, loading());
    const s = await API.recState(recId);
    s.selected_ids.forEach((id) => selected.add(id));

    const rows = s.lines.map((l) => {
      const cb = h('input', {
        type: 'checkbox', checked: selected.has(l.id), disabled: s.reconciliation.status !== 'in_progress',
        onchange: (e) => { if (e.target.checked) selected.add(l.id); else selected.delete(l.id); recalc(); },
      });
      return h('tr',
        h('td', cb),
        h('td.nowrap', fmt.date(l.txn_date)),
        h('td', h('span.cell-truncate', l.description)),
        h('td.muted', l.entry_no ? h('span.mono', l.entry_no) : h('span.tag.amber', 'unmatched')),
        h('td.num', { class: l.amount < 0 ? 'num-neg' : 'num-pos' }, fmt.money(l.amount, s.bank_account.currency)));
    });

    const summary = h('div.card-body', { style: { borderBottom: '1px solid var(--border)' } });
    function recalc() {
      const cleared = s.lines.filter((l) => selected.has(l.id)).reduce((a, l) => a + l.amount, 0);
      const priorCleared = s.cleared_balance - s.lines.filter((l) => s.selected_ids.includes(l.id)).reduce((a, l) => a + l.amount, 0);
      const total = priorCleared + cleared;
      const diff = s.statement_balance - total;
      mount(summary, h('div.row', { style: { gap: '26px', flexWrap: 'wrap' } },
        stat('Statement balance', fmt.money(s.statement_balance, s.bank_account.currency)),
        stat('Cleared', fmt.money(total, s.bank_account.currency)),
        stat('Difference', fmt.money(diff, s.bank_account.currency), diff === 0 ? 'num-pos' : 'num-neg'),
        stat('Ledger balance', fmt.money(s.gl_balance, s.bank_account.currency)),
        stat('Unmatched lines', String(s.unmatched_count), s.unmatched_count ? 'num-neg' : '')));
      completeBtn.disabled = diff !== 0 || s.reconciliation.status !== 'in_progress';
      completeBtn.title = diff !== 0 ? 'The statement must clear to zero difference' : '';
      forceBtn.classList.toggle('hidden', diff === 0 || s.reconciliation.status !== 'in_progress');
    }

    const completeBtn = h('button.btn.primary', {
      onclick: async () => {
        try {
          await API.recSelect(recId, [...selected]);
          await API.recComplete(recId, false);
          toast('Reconciliation complete', { kind: 'success' });
          go(`/bank/${s.bank_account.id}`);
        } catch (e) { notifyError(e); }
      },
    }, 'Complete reconciliation');

    const forceBtn = h('button.btn.danger.hidden', {
      onclick: async () => {
        const ok = await confirm({
          title: 'Complete with a difference?',
          message: 'The statement does not clear to zero. Completing now records the difference against this reconciliation.',
          detail: 'Prefer to find the missing entry — an unmatched bank fee or interest line usually needs a journal entry first.',
          confirmLabel: 'Complete anyway', danger: true,
        });
        if (!ok) return;
        try {
          await API.recSelect(recId, [...selected]);
          await API.recComplete(recId, true);
          toast('Completed with a difference', { kind: 'warn' });
          go(`/bank/${s.bank_account.id}`);
        } catch (e) { notifyError(e); }
      },
    }, 'Complete anyway');

    recalc();

    mount(host,
      h('div.card',
        h('div.card-head',
          h('h2', `${s.bank_account.name} — statement to ${fmt.date(s.reconciliation.statement_date)}`),
          h('div.actions', statusTag(s.reconciliation.status))),
        summary,
        h('div.grid-wrap', h('table.grid',
          h('thead', h('tr', h('th', ''), h('th', 'Date'), h('th', 'Description'), h('th', 'Journal'), h('th.num', 'Amount'))),
          h('tbody', ...rows))),
        h('div.card-foot', h('div.row',
          h('span.muted', `${selected.size} of ${s.lines.length} lines cleared`),
          h('div', { style: { flex: 1 } }),
          forceBtn, completeBtn))));
  }

  const stat = (label, value, cls = '') => h('div',
    h('div.muted', { style: { fontSize: '11px' } }, label.toUpperCase()),
    h('div', { style: { fontSize: '17px', fontWeight: 650 }, class: cls }, value));

  await load();

  return h('div.page',
    h('div.page-head',
      h('div.titles',
        h('div.breadcrumb', h('a', { href: '#/bank', onclick: (e) => { e.preventDefault(); go('/bank'); } }, 'Banking')),
        h('h1', 'Reconciliation'),
        h('div.page-sub', 'Tick the statement lines that appear on your bank statement until the difference is zero.'))),
    host);
}
