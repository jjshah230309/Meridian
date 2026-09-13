// Meridian ERP :: web/views/chart
// Chart of accounts (as a balance tree), account ledger drill-down, and the
// period close screen.
import { h, mount, clear } from '../dom.js';
import { icon } from '../icons.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import * as store from '../store.js';
import { empty, toast, notifyError, confirm, modal, statusTag, facts } from '../ui.js';

const TYPE_ORDER = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];
const DEBIT_NORMAL = new Set(['ASSET', 'EXPENSE']);

export async function chartView(_route, { go }) {
  const { tree } = await API.chart(store.state.subsidiary ? { subsidiary_id: store.state.subsidiary } : {});
  const collapsed = new Set(store.getPref('coa.collapsed', []));
  const host = h('tbody');
  let showInactive = false;
  let query = '';

  function draw() {
    clear(host);
    const matches = (a) => !query || `${a.number} ${a.name}`.toLowerCase().includes(query);
    const walk = (node, depth) => {
      const anyChildMatch = node.children.some(function check(c) { return matches(c) || c.children.some(check); });
      if (!matches(node) && !anyChildMatch) return;
      if (!showInactive && !node.active && !anyChildMatch) return;
      const isOpen = !collapsed.has(node.id);
      const balance = node.is_summary ? node.rollup : node.balance;
      // Presentation flips the sign so a credit-normal account reads positive.
      const shown = DEBIT_NORMAL.has(node.type) ? balance : -balance;
      host.appendChild(h('tr', { class: node.is_summary ? 'subtotal' : 'clickable', onclick: () => { if (!node.is_summary) go(`/account/${node.id}`); } },
        h('td', h('div.tree-row', { style: { paddingLeft: `${depth * 15}px` } },
          node.children.length
            ? h('span.tree-toggle', {
              onclick: (e) => { e.stopPropagation(); if (isOpen) collapsed.add(node.id); else collapsed.delete(node.id); store.setPref('coa.collapsed', [...collapsed]); draw(); },
            }, icon(isOpen ? 'chevron-down' : 'chevron-right', { size: 12 }))
            : h('span.tree-toggle', ''),
          h('span.mono', node.number))),
        h('td', h('span', { style: { fontWeight: node.is_summary ? 600 : 400 } }, node.name),
          !node.active ? h('span.tag', { style: { marginLeft: '6px' } }, 'Inactive') : null),
        h('td.muted', fmt.titleCase(node.subtype || node.type)),
        h('td.num', { class: shown < 0 ? 'num-neg' : '' }, balance || node.rollup ? fmt.money(shown) : h('span.faint', '—'))));
      if (isOpen) for (const c of node.children) walk(c, depth + 1);
    };
    const byType = TYPE_ORDER.map((t) => tree.filter((n) => n.type === t)).flat();
    const rest = tree.filter((n) => !TYPE_ORDER.includes(n.type));
    for (const n of [...byType, ...rest]) walk(n, 0);
  }
  draw();

  const search = h('input', {
    type: 'search', placeholder: 'Filter accounts…', style: { width: '220px' },
    oninput: (e) => { query = e.target.value.trim().toLowerCase(); draw(); },
  });

  return h('div.page',
    h('div.page-head',
      h('div.titles', h('h1', 'Chart of Accounts'),
        h('div.page-sub', 'Balances are cumulative to date, shown in the base currency with each account’s natural sign.')),
      h('div.page-actions',
        h('button.btn', { onclick: () => go('/journal-new') }, 'New journal entry'),
        store.can('account', store.LEVEL.CREATE) && h('button.btn.primary', { onclick: () => go('/new/account') }, icon('plus', { size: 14 }), 'New account'))),
    h('div.card',
      h('div.toolbar', search,
        h('label', { style: { display: 'flex', gap: '5px', alignItems: 'center', fontSize: '12.5px' } },
          h('input', { type: 'checkbox', onchange: (e) => { showInactive = e.target.checked; draw(); } }), 'Show inactive'),
        h('div.spacer'),
        h('button.btn.sm', { onclick: () => { collapsed.clear(); store.setPref('coa.collapsed', []); draw(); } }, 'Expand all'),
        h('div.row', { style: { gap: '4px' } },
          h('button.btn.sm', { onclick: () => API.exportCsv('account').catch(notifyError) }, icon('download', { size: 13 }), 'CSV'),
          h('button.btn.sm', { onclick: () => API.exportFile('account', 'pdf').catch(notifyError) }, 'PDF')),
      h('div.grid-wrap',
        h('table.grid',
          h('thead', h('tr', h('th', { style: { width: '150px' } }, 'Number'), h('th', 'Name'), h('th', { style: { width: '190px' } }, 'Type'), h('th.num', { style: { width: '160px' } }, 'Balance'))),
          host))));
}

// =============================================================== ledger
export async function ledgerView(route, { go }) {
  const accountId = route.parts[1];
  const from = h('input', { type: 'date', value: route.query.from || fmt.addDays(fmt.today(), -180) });
  const to = h('input', { type: 'date', value: route.query.to || fmt.today() });
  const host = h('div');

  async function load() {
    mount(host, h('div.empty', h('span.spinner')));
    const data = await API.ledger(accountId, { from: from.value, to: to.value, subsidiary_id: store.state.subsidiary || undefined });
    const a = data.account;
    const sign = DEBIT_NORMAL.has(a.type) ? 1 : -1;
    mount(host,
      h('div.card',
        h('div.card-head', h('h2', 'Ledger'),
          h('span.muted', { style: { fontSize: '12px' } }, `${data.lines.length} postings`),
          h('div.actions',
            h('span.muted', { style: { fontSize: '12px' } }, 'Opening ', h('strong', fmt.money(sign * data.opening))),
            h('span.muted', { style: { fontSize: '12px' } }, 'Closing ', h('strong', fmt.money(sign * data.closing))))),
        data.lines.length ? h('div.grid-wrap', h('table.grid',
          h('thead', h('tr', h('th', 'Date'), h('th', 'Entry'), h('th', 'Source'), h('th', 'Memo'), h('th.num', 'Debit'), h('th.num', 'Credit'), h('th.num', 'Balance'))),
          h('tbody', ...data.lines.map((l) => h('tr.clickable', { onclick: () => go(`/journal/${l.entry_id}`) },
            h('td.nowrap', fmt.date(l.txn_date)),
            h('td', h('span.mono', l.entry_no)),
            h('td.muted', fmt.titleCase(l.source_type)),
            h('td', h('span.cell-truncate', l.memo || l.entry_memo || '')),
            h('td.num', l.base_debit ? fmt.money(l.base_debit) : ''),
            h('td.num', l.base_credit ? fmt.money(l.base_credit) : ''),
            h('td.num', { class: sign * l.running_balance < 0 ? 'num-neg' : '' }, fmt.money(sign * l.running_balance)))))))
          : empty('No postings in this range', 'Widen the dates to see earlier activity.')));
  }

  const data = await API.ledger(accountId, { from: from.value, to: to.value });
  await load();

  from.addEventListener('change', load);
  to.addEventListener('change', load);

  return h('div.page',
    h('div.page-head',
      h('div.titles',
        h('div.breadcrumb', h('a', { href: '#/chart', onclick: (e) => { e.preventDefault(); go('/chart'); } }, 'Chart of Accounts')),
        h('h1', `${data.account.number} · ${data.account.name}`),
        h('div.page-sub', `${fmt.titleCase(data.account.type)} · ${fmt.titleCase(data.account.subtype || '')}`)),
      h('div.page-actions',
        h('span.muted', { style: { fontSize: '12px' } }, 'From'), from,
        h('span.muted', { style: { fontSize: '12px' } }, 'to'), to,
        h('button.btn', { onclick: () => go(`/record/account/${accountId}`) }, 'Account settings'))),
    host);
}

// =============================================================== periods
export async function periodsView(_route, { go }) {
  const periods = await API.periods();
  const host = h('div');

  async function refresh() {
    const fresh = await API.periods();
    render(fresh);
  }

  function render(rows) {
    const byYear = {};
    for (const p of rows) (byYear[p.fiscal_year] ||= []).push(p);
    mount(host, ...Object.entries(byYear).sort((a, b) => b[0] - a[0]).map(([year, list]) => h('div.card', { style: { marginBottom: '12px' } },
      h('div.card-head', h('h2', `Fiscal year ${year}`),
        h('span.muted', { style: { fontSize: '12px' } }, `${list.filter((p) => p.status === 'open').length} open`)),
      h('div.grid-wrap', h('table.grid',
        h('thead', h('tr', h('th', 'Period'), h('th', 'Start'), h('th', 'End'), h('th', 'Quarter'), h('th', 'Status'), h('th', 'Closed'), h('th', ''))),
        h('tbody', ...list.sort((a, b) => a.start_date.localeCompare(b.start_date)).map((p) => h('tr',
          h('td', h('strong', p.name)),
          h('td', fmt.date(p.start_date)),
          h('td', fmt.date(p.end_date)),
          h('td.muted', `Q${p.quarter}`),
          h('td', statusTag(p.status)),
          h('td.muted', p.closed_at ? fmt.dateTime(p.closed_at) : '—'),
          h('td', { style: { textAlign: 'right' } },
            store.can('accounting_period', store.LEVEL.FULL)
              ? (p.status === 'open'
                ? h('button.btn.sm', { onclick: () => closePeriod(p) }, 'Close')
                : p.status === 'closed'
                  ? h('button.btn.sm', { onclick: () => reopen(p) }, 'Reopen')
                  : h('span.faint', 'Locked'))
              : null))))))))); 
  }

  async function closePeriod(p) {
    try {
      await API.closePeriod(p.id, false);
      toast(`${p.name} closed`, { kind: 'success' });
      refresh();
    } catch (e) {
      // The server blocks a close over unposted or unbalanced work; offer the
      // override explicitly rather than silently forcing it.
      const force = await confirm({
        title: `Cannot close ${p.name}`, message: e.message,
        detail: 'You can close anyway, but the reason above will remain in the books and in the audit trail.',
        confirmLabel: 'Close anyway', danger: true,
      });
      if (!force) return;
      try { await API.closePeriod(p.id, true); toast(`${p.name} closed with an override`, { kind: 'warn' }); refresh(); }
      catch (err) { notifyError(err); }
    }
  }

  async function reopen(p) {
    if (!await confirm({ title: `Reopen ${p.name}?`, message: 'Reopening a closed period allows new postings into it. Anything you post will change previously reported figures.', confirmLabel: 'Reopen', danger: true })) return;
    try { await API.reopenPeriod(p.id); toast(`${p.name} reopened`, { kind: 'success' }); refresh(); }
    catch (e) { notifyError(e); }
  }

  render(periods);

  const integrityBox = h('div.card', { style: { marginBottom: '12px' } });
  API.report('integrity').then((r) => {
    mount(integrityBox,
      h('div.card-head', h('h2', 'Ledger integrity'),
        h('div.actions', r.ok ? h('span.tag.green', 'All checks passed') : h('span.tag.red', 'Attention needed'))),
      h('div.card-body', facts([
        ['Total debits', fmt.money(r.ledger_total_debits)],
        ['Total credits', fmt.money(r.ledger_total_credits)],
        ['Ledger balanced', r.ledger_balanced ? h('span.tag.green', 'Yes') : h('span.tag.red', 'No')],
        ['Unbalanced entries', String(r.unbalanced_entries.length)],
        ['Rollup drift', String(r.rollup_drift.length)],
        ['Orphaned lines', String(r.orphan_lines)],
        ...(r.subledgers || []).map((sl) => [
          `${sl.name} ties to ${sl.explain}`,
          sl.difference === 0 ? h('span.tag.green', 'Yes')
            : h('span.num-neg', `Out by ${fmt.money(sl.difference)}`),
        ]),
      ]),
        h('div.muted', { style: { marginTop: '10px', fontSize: '12px' } },
          'Compares the materialised balance rollup against the journal detail, confirms every posted entry balances, and checks each control account still agrees with the records behind it. Run this before closing a period.')));
  }).catch(() => mount(integrityBox, h('div.card-body', h('span.muted', 'Integrity check unavailable.'))));

  return h('div.page',
    h('div.page-head',
      h('div.titles', h('h1', 'Period Close'),
        h('div.page-sub', 'Closing a period stops new postings into it. Meridian checks the ledger balances before it lets you close.')),
      h('div.page-actions',
        store.can('accounting_period', store.LEVEL.FULL) && h('button.btn', {
          onclick: async () => {
            const year = new Date().getUTCFullYear() + 1;
            if (!await confirm({ title: `Generate periods for ${year}?`, message: `Twelve monthly periods will be created for fiscal year ${year}. Existing periods are left alone.`, confirmLabel: 'Generate' })) return;
            try { const r = await API.generatePeriods(year); toast(`${r.created} periods created`, { kind: 'success' }); refresh(); }
            catch (e) { notifyError(e); }
          },
        }, 'Generate next year'))),
    integrityBox,
    host);
}
