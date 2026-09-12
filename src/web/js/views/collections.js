// Meridian ERP :: web/views/collections
// The collections desk. Who owes what, how late, who has been chased, what
// they promised — and the three things you can do about it: send a statement,
// send the next letter, or give up and write it off.
//
// The aging report answers "how much is late". This screen answers "what do I
// do next", which is a different question and needs different columns: the
// oldest item rather than the total, the last letter rather than the invoice
// date, and a promise that pushes an account down the list instead of off it.
import { h, mount } from '../dom.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import * as store from '../store.js';
import { empty, notifyError, notifyOk, statusTag, loading, modal, facts, confirm, fieldControl } from '../ui.js';

const TABS = [['worklist', 'Worklist'], ['notices', 'Letters sent'], ['allowance', 'Provision']];

const daysTone = (d) => (d >= 90 ? 'num-neg' : d >= 60 ? 'num-neg' : d >= 30 ? '' : 'muted');

export async function collectionsView(route, { go }) {
  if (!store.can('collections')) {
    return h('div.page', empty('Not permitted', 'Your role cannot see the collections desk.'));
  }
  const canWork = store.can('collections', store.LEVEL.EDIT);
  const canDun = store.can('dunning_notice', store.LEVEL.CREATE);

  let tab = TABS.some(([k]) => k === route.parts[1]) ? route.parts[1] : 'worklist';
  const host = h('div');
  const head = h('div');
  let data = null;

  const tabs = () => h('div.tabs', { style: { marginBottom: '14px' } },
    ...TABS.map(([k, label]) => h('button.tab', {
      class: k === tab ? 'active' : '',
      onclick: () => { if (k === tab) return; tab = k; go(k === 'worklist' ? '/collections' : `/collections/${k}`); },
    }, label)));

  async function load() {
    mount(host, loading('Reading the ledger'));
    try {
      if (tab === 'notices') {
        data = await API.dunningNotices({ limit: 100 });
        renderNotices();
      } else if (tab === 'allowance') {
        data = await API.runAllowance({ dry_run: true });
        renderAllowance();
      } else {
        const [work, candidates] = await Promise.all([
          API.collectionsWorklist(),
          canDun ? API.dunningCandidates() : Promise.resolve({ candidates: [], skipped: [] }),
        ]);
        data = { work, candidates };
        renderWorklist();
      }
    } catch (e) {
      mount(host, empty('Could not open the collections desk', e.message));
    }
  }

  function pageHead(actions) {
    mount(head,
      h('div.titles',
        h('h1', 'Collections'),
        h('div.page-sub', 'Who owes what, how late it is, and what has been done about it')),
      h('div.page-actions', ...actions.filter(Boolean)));
  }

  // ------------------------------------------------------------ worklist
  function renderWorklist() {
    const { work, candidates } = data;
    const due = candidates.candidates || [];
    pageHead([
      canDun
        ? h('button.btn.primary', {
          disabled: !due.length,
          title: due.length ? '' : 'Nobody is due a letter today',
          onclick: () => dunningDialog(due, candidates.skipped || [], work.currency),
        }, due.length ? `Send ${due.length} letter${due.length === 1 ? '' : 's'}` : 'Send letters')
        : null,
    ]);

    if (!work.rows.length) {
      mount(host, tabs(), empty('Nothing is overdue',
        'Every open invoice is still inside its terms. The worklist fills up on its own as due dates pass.'));
      return;
    }

    const t = work.totals;
    const kpis = h('div.kpi-grid', { style: { marginBottom: '14px' } },
      h('div.kpi',
        h('div.k-label', 'Overdue'),
        h('div.k-value.num-neg', fmt.moneyCompact(t.overdue, t.currency)),
        h('div.k-meta', `${t.customers} customer${t.customers === 1 ? '' : 's'} · ${fmt.moneyCompact(t.total, t.currency)} owed in total`)),
      h('div.kpi',
        h('div.k-label', 'Over 90 days'),
        h('div.k-value', { class: t.buckets[4] ? 'num-neg' : '' }, fmt.moneyCompact(t.buckets[4], t.currency)),
        h('div.k-meta', t.total ? `${Math.round((t.buckets[4] / t.total) * 100)}% of the ledger` : '—')),
      h('div.kpi',
        h('div.k-label', 'Promised'),
        h('div.k-value', fmt.moneyCompact(t.promised, t.currency)),
        h('div.k-meta', t.promised ? 'Expected on the dates given' : 'Nobody has committed to a date')),
      h('div.kpi',
        h('div.k-label', 'On credit hold'),
        h('div.k-value', String(t.on_hold)),
        h('div.k-meta', due.length ? `${due.length} due a letter today` : 'No letters due')));

    const rows = work.rows.map((r) => {
      const promised = r.promise_date && r.promise_date >= work.as_of;
      return h('tr.clickable', { onclick: () => customerDialog(r) },
        h('td',
          h('strong', r.name),
          h('div.muted', { style: { fontSize: '12px' } },
            r.entity_no,
            r.credit_hold ? h('span.tag.red', { style: { marginLeft: '6px' } }, 'On hold') : null,
            r.no_dunning ? h('span.tag', { style: { marginLeft: '6px' } }, 'Do not chase') : null,
            r.over_limit ? h('span.tag.amber', { style: { marginLeft: '6px' } }, 'Over limit') : null)),
        h('td.num', { class: daysTone(r.oldest_days) }, `${r.oldest_days}d`),
        ...r.buckets.map((b, i) => h('td.num', { class: i >= 3 && b ? 'num-neg' : '' },
          b ? fmt.money(b, work.currency, { blankZero: true }) : h('span.faint', '·'))),
        h('td.num', h('strong', fmt.money(r.total, work.currency))),
        h('td', r.dunning_level
          ? h('span.tag.amber', { title: r.last_notice_date ? `Last chased ${fmt.date(r.last_notice_date)}` : '' }, `Level ${r.dunning_level}`)
          : h('span.faint', 'Not chased')),
        h('td', promised
          ? h('span.tag.blue', { title: fmt.money(r.promise_amount) }, fmt.dateShort(r.promise_date))
          : r.promise_date ? h('span.tag.red', { title: 'The date came and went' }, fmt.dateShort(r.promise_date))
            : h('span.faint', '—')),
        h('td.muted', r.collector_name || '—'));
    });

    mount(host, tabs(), kpis,
      h('div.card',
        h('div.card-head', h('h2', `Worklist at ${fmt.date(work.as_of)}`),
          h('span.muted', { style: { fontSize: '12px' } },
            `Worst first; a promise still in date waits its turn · ${work.currency}`)),
        h('div.grid-wrap', h('table.grid',
          h('thead', h('tr',
            h('th', 'Customer'), h('th.num', 'Oldest'),
            ...t.bucket_labels.map((l) => h('th.num', l)),
            h('th.num', 'Total'), h('th', 'Chased'), h('th', 'Promised'), h('th', 'Collector'))),
          h('tbody', ...rows,
            h('tr.subtotal',
              h('td', 'Total'), h('td', ''),
              ...t.buckets.map((b) => h('td.num', fmt.money(b, t.currency))),
              h('td.num', fmt.money(t.total, t.currency)), h('td', ''), h('td', ''), h('td', '')))))));
  }

  // --------------------------------------------------------- one customer
  async function customerDialog(row) {
    let statement;
    try { statement = await API.customerStatement(row.customer_id, { kind: 'open_item' }); }
    catch (e) { notifyError(e); return; }

    const controls = {};
    const form = h('div.form-grid');
    for (const f of [
      { name: 'promise_date', label: 'Promised by', type: 'date', help: 'A date still in the future takes the account out of the next dunning run.' },
      { name: 'promise_amount', label: 'Promised amount', type: 'money' },
      { name: 'collector_id', label: 'Collector', type: 'reference', ref: 'employee' },
      { name: 'no_dunning', label: 'Do not chase', type: 'checkbox' },
      { name: 'credit_hold', label: 'Credit hold', type: 'checkbox' },
      { name: 'collection_note', label: 'Note', type: 'longtext', full: true },
    ]) {
      const value = f.name === 'promise_amount' ? (row.promise_amount ? row.promise_amount / 100 : '')
        : f.name === 'no_dunning' ? row.no_dunning
          : f.name === 'credit_hold' ? row.credit_hold
            : row[f.name] || '';
      const ctl = fieldControl(f, value, null);
      controls[f.name] = ctl;
      form.appendChild(ctl.el);
    }

    const items = h('div', h('div.grid-wrap', { style: { maxHeight: '240px' } }, h('table.grid',
      h('thead', h('tr', h('th', 'Document'), h('th', 'Dated'), h('th', 'Due'),
        h('th.num', 'Days late'), h('th.num', 'Outstanding'), h('th', ''))),
      h('tbody', ...statement.lines.map((l) => h('tr',
        h('td', h('strong', l.reference), h('div.muted', { style: { fontSize: '11.5px' } }, l.type)),
        h('td', fmt.date(l.date)),
        h('td', l.due_date ? fmt.date(l.due_date) : '—'),
        h('td.num', { class: daysTone(l.days_overdue || 0) }, l.days_overdue ? `${l.days_overdue}d` : '—'),
        h('td.num', fmt.money(l.document_outstanding ?? l.outstanding, l.currency),
          statement.mixed && l.currency !== statement.currency
            ? h('div.muted', { style: { fontSize: '11px' } }, fmt.money(l.outstanding, statement.currency))
            : null),
        h('td', canWork && l.type === 'Invoice'
          ? h('button.btn.sm', { onclick: () => { m.close(); writeOffDialog(l, row); } }, 'Write off')
          : null)))))),
      statement.mixed
        ? h('div.muted', { style: { fontSize: '11.5px', marginTop: '6px' } },
          `Documents are shown in their own currency; the totals above are in ${statement.currency}.`)
        : null);

    const m = modal({
      title: row.name,
      size: 'wide',
      body: h('div',
        facts([
          ['Owed', fmt.money(statement.total, statement.currency)],
          ['Overdue', fmt.money(statement.overdue, statement.currency)],
          ['Oldest item', `${statement.oldest_days} days`],
          ['Terms', fmt.titleCase(String(row.terms || '').replace(/_/g, ' '))],
          ['Credit limit', row.credit_limit ? fmt.money(row.credit_limit, statement.currency) : 'None set'],
          ['Chased to', row.dunning_level ? `Level ${row.dunning_level}${row.last_notice_date ? ` on ${fmt.date(row.last_notice_date)}` : ''}` : 'Not yet chased'],
        ]),
        h('h3', { style: { margin: '14px 0 6px', fontSize: '13px' } }, 'Open items'),
        items,
        h('h3', { style: { margin: '14px 0 6px', fontSize: '13px' } }, 'Collections'),
        form),
      footLeft: h('div.row', { style: { gap: '6px' } },
        h('button.btn.sm', { onclick: () => API.statementPdf(row.customer_id, { kind: 'open_item' }).catch(notifyError) }, 'Statement (open items)'),
        h('button.btn.sm', { onclick: () => API.statementPdf(row.customer_id, { kind: 'activity' }).catch(notifyError) }, 'Statement (activity)')),
      actions: [
        { label: 'Close', value: null },
        { label: 'Open customer', onClick: (close) => { close(true); go(`/record/customer/${row.customer_id}`); } },
        canWork
          ? {
            label: 'Save', kind: 'primary',
            onClick: async (close) => {
              try {
                await API.updateCollectionState(row.customer_id, {
                  promise_date: controls.promise_date.get() || null,
                  promise_amount: controls.promise_amount.get() || 0,
                  collector_id: controls.collector_id.get() || null,
                  no_dunning: !!controls.no_dunning.get(),
                  credit_hold: !!controls.credit_hold.get(),
                  collection_note: controls.collection_note.get() || '',
                });
                notifyOk(`${row.name} updated.`);
                close(true); load();
              } catch (e) { notifyError(e); return false; }
            },
          }
          : null,
      ].filter(Boolean),
    });
    return m;
  }

  // ---------------------------------------------------------- write-off
  function writeOffDialog(line, row) {
    const owed = line.document_outstanding ?? line.outstanding;
    const amount = h('input', { type: 'number', step: '0.01', class: 'num', value: (owed / 100).toFixed(2) });
    const reason = h('input', { type: 'text', placeholder: 'Company dissolved, disputed, uneconomic to pursue…' });
    const allowance = h('input', { type: 'checkbox' });
    return modal({
      title: `Write off ${line.reference}`,
      body: h('div',
        h('p.muted', { style: { marginTop: 0 } },
          'The invoice is settled without any cash: the receivable comes off the ledger and the loss is taken. Nothing is deleted — a settlement document records it, and the invoice keeps its history.'),
        h('div.field', h('label', `Amount to write off (${line.currency})`), amount),
        h('div.field', h('label', 'Reason'), reason),
        h('div.field.checkbox', allowance, h('label', 'Charge it against the allowance for doubtful accounts'),
          h('div.help', 'Use this where the loss was already provided for. Otherwise it goes straight to Bad Debt Expense.')),
      ),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Write it off', kind: 'danger',
          onClick: async (close) => {
            try {
              const res = await API.writeOff(line.txn_id, {
                amount: Number(amount.value) || 0, reason: reason.value || '',
                use_allowance: allowance.checked,
              });
              notifyOk(`${line.reference} written off — ${res.write_off.txn_no}.`, 'Written off');
              close(true); load();
            } catch (e) { notifyError(e); return false; }
          },
        },
      ],
    });
  }

  // ------------------------------------------------------------ dunning
  function dunningDialog(due, skipped, currency) {
    const rows = due.map((c) => h('tr',
      h('td', c.name),
      h('td', h('span.tag', `Level ${c.level.level_no}`), ' ', c.level.name),
      h('td.num', { class: daysTone(c.oldest_days) }, `${c.oldest_days}d`),
      h('td.num', fmt.money(c.overdue, currency)),
      h('td', c.level.credit_hold ? h('span.tag.red', 'Goes on hold') : h('span.faint', '—'))));

    return modal({
      title: `Send ${due.length} letter${due.length === 1 ? '' : 's'}`,
      size: 'wide',
      body: h('div',
        h('p.muted', { style: { marginTop: 0 } },
          `Each account moves up one rung — however far behind it is, nobody jumps straight to a final notice. Each letter is written in the customer's own currency; the figures here are in ${currency} so they can be compared. The letters are produced and recorded, ready to print or export; nothing is emailed.`),
        h('div.grid-wrap', { style: { maxHeight: '260px' } }, h('table.grid',
          h('thead', h('tr', h('th', 'Customer'), h('th', 'Letter'), h('th.num', 'Oldest'), h('th.num', `Overdue (${currency})`), h('th', 'Effect'))),
          h('tbody', ...rows))),
        skipped.length
          ? h('details', { style: { marginTop: '10px' } },
            h('summary.muted', { style: { fontSize: '12px', cursor: 'pointer' } },
              `${skipped.length} account${skipped.length === 1 ? '' : 's'} passed over`),
            h('div.grid-wrap', { style: { maxHeight: '180px', marginTop: '6px' } }, h('table.grid',
              h('thead', h('tr', h('th', 'Customer'), h('th.num', `Overdue (${currency})`), h('th', 'Why not'))),
              h('tbody', ...skipped.map((s) => h('tr',
                h('td', s.name), h('td.num', fmt.money(s.overdue, currency)), h('td.muted', s.reason)))))))
          : null),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Issue the letters', kind: 'primary',
          onClick: async (close) => {
            try {
              const res = await API.runDunning({});
              notifyOk(`${res.issued} letter${res.issued === 1 ? '' : 's'} issued.`, 'Dunning run complete');
              close(true); tab = 'notices'; go('/collections/notices');
            } catch (e) { notifyError(e); return false; }
          },
        },
      ],
    });
  }

  // ------------------------------------------------------------- notices
  function renderNotices() {
    pageHead([]);
    const rows = data.rows || [];
    if (!rows.length) {
      mount(host, tabs(), empty('No letters have gone out',
        'A dunning run produces a letter per account, at the rung its age has earned. They are listed here once issued.'));
      return;
    }
    mount(host, tabs(),
      h('div.card',
        h('div.card-head', h('h2', 'Letters sent'),
          h('span.muted', { style: { fontSize: '12px' } }, `${rows.length} on record`)),
        h('div.grid-wrap', h('table.grid',
          h('thead', h('tr', h('th', 'Notice'), h('th', 'Customer'), h('th', 'Issued'),
            h('th', 'Rung'), h('th.num', 'Overdue'), h('th.num', 'Oldest'),
            h('th', 'Status'), h('th', ''))),
          h('tbody', ...rows.map((n) => h('tr.clickable', { onclick: () => noticeDialog(n) },
            h('td', h('strong', n.notice_no)),
            h('td', n.customer_name, h('div.muted', { style: { fontSize: '11.5px' } }, n.entity_no)),
            h('td', fmt.date(n.as_of)),
            h('td', h('span.tag', `L${n.level_no}`), ' ', n.level_name),
            h('td.num', fmt.money(n.total_overdue, n.currency)),
            h('td.num', { class: daysTone(n.oldest_days) }, `${n.oldest_days}d`),
            h('td', statusTag(n.status)),
            h('td', { onclick: (e) => e.stopPropagation() },
              h('button.btn.sm', { onclick: () => API.noticePdf(n.id).catch(notifyError) }, 'PDF')))))))));
  }

  async function noticeDialog(n) {
    let notice;
    try { notice = await API.dunningNotice(n.id); } catch (e) { notifyError(e); return; }
    const docs = Array.isArray(notice.documents) ? notice.documents : [];
    const m = modal({
      title: notice.subject || notice.notice_no,
      size: 'wide',
      body: h('div',
        facts([
          ['Customer', notice.customer?.name || '—'],
          ['Issued', fmt.date(notice.as_of)],
          ['Rung', `${notice.level_no} — ${notice.level_name}`],
          ['Overdue', fmt.money(notice.total_overdue, notice.currency)],
          ['Oldest item', `${notice.oldest_days} days`],
          ['Status', notice.status === 'cancelled' ? 'Withdrawn' : 'Issued'],
        ]),
        h('div.callout', { style: { marginTop: '12px', whiteSpace: 'pre-wrap' } }, notice.body),
        docs.length
          ? h('div', { style: { marginTop: '12px' } },
            h('h3', { style: { margin: '0 0 6px', fontSize: '13px' } }, 'Items listed'),
            h('div.grid-wrap', { style: { maxHeight: '200px' } }, h('table.grid',
              h('thead', h('tr', h('th', 'Document'), h('th', 'Due'), h('th.num', 'Days late'), h('th.num', 'Outstanding'))),
              h('tbody', ...docs.map((d) => h('tr',
                h('td', d.txn_no), h('td', d.due_date ? fmt.date(d.due_date) : '—'),
                h('td.num', `${d.days_overdue}d`),
                h('td.num', fmt.money(d.outstanding, d.currency))))))))
          : null),
      footLeft: h('button.btn.sm', { onclick: () => API.noticePdf(notice.id).catch(notifyError) }, 'Download PDF'),
      actions: [
        { label: 'Close', value: null },
        store.can('dunning_notice', store.LEVEL.EDIT) && notice.status === 'issued'
          ? {
            label: 'Withdraw', kind: 'danger',
            onClick: async (close) => {
              const ok = await confirm({
                title: `Withdraw ${notice.notice_no}?`,
                message: 'The customer drops back to the highest rung still standing, so the next run offers this letter again rather than skipping ahead.',
                confirmLabel: 'Withdraw it', danger: true,
              });
              if (!ok) return false;
              try {
                await API.cancelNotice(notice.id, { reason: 'Withdrawn from the collections desk' });
                notifyOk(`${notice.notice_no} withdrawn.`);
                close(true); load();
              } catch (e) { notifyError(e); return false; }
            },
          }
          : null,
      ].filter(Boolean),
    });
    return m;
  }

  // ----------------------------------------------------------- allowance
  function renderAllowance() {
    const a = data;
    pageHead([
      canWork
        ? h('button.btn.primary', {
          disabled: !a.movement,
          title: a.movement ? '' : 'The provision already matches the aged balance',
          onclick: () => allowanceDialog(a),
        }, a.movement > 0 ? 'Top up the provision' : a.movement < 0 ? 'Release the provision' : 'Provision is up to date')
        : null,
    ]);

    mount(host, tabs(),
      h('div.kpi-grid', { style: { marginBottom: '14px' } },
        h('div.kpi',
          h('div.k-label', 'Receivables'),
          h('div.k-value', fmt.moneyCompact(a.receivables)),
          h('div.k-meta', `Aged at ${fmt.date(a.as_of)}`)),
        h('div.kpi',
          h('div.k-label', 'Provision required'),
          h('div.k-value', fmt.moneyCompact(a.target)),
          h('div.k-meta', `${a.coverage_pct}% of the ledger`)),
        h('div.kpi',
          h('div.k-label', 'Already provided'),
          h('div.k-value', fmt.moneyCompact(a.held)),
          h('div.k-meta', 'Standing on account 1150')),
        h('div.kpi',
          h('div.k-label', 'Movement'),
          h('div.k-value', { class: a.movement > 0 ? 'num-neg' : a.movement < 0 ? 'num-pos' : '' },
            fmt.money(a.movement, undefined, { sign: true })),
          h('div.k-meta', a.movement > 0 ? 'A charge to bad debt' : a.movement < 0 ? 'A release back to profit' : 'Nothing to post'))),
      h('div.card',
        h('div.card-head', h('h2', 'Expected credit loss'),
          h('span.muted', { style: { fontSize: '12px' } }, 'Rates applied to each aged bucket')),
        h('div.grid-wrap', h('table.grid',
          h('thead', h('tr', h('th', 'Bucket'), h('th.num', 'Balance'), h('th.num', 'Rate'), h('th.num', 'Provision'))),
          h('tbody',
            ...a.bands.map((b) => h('tr',
              h('td', b.label),
              h('td.num', fmt.money(b.balance)),
              h('td.num.muted', `${b.rate}%`),
              h('td.num', fmt.money(b.provision)))),
            h('tr.subtotal',
              h('td', 'Required'), h('td.num', fmt.money(a.receivables)), h('td', ''),
              h('td.num', fmt.money(a.target))))))),
      h('div.callout', { style: { marginTop: '14px' } },
        'The allowance is a standing provision, not a period entry: each run adjusts it to the new target and books only the difference. Writing an invoice off against the allowance draws it down; the next run tops it back up.'));
  }

  function allowanceDialog(a) {
    const memo = h('input', { type: 'text', placeholder: `Allowance for doubtful accounts at ${a.as_of}` });
    return modal({
      title: a.movement > 0 ? 'Increase the provision' : 'Release the provision',
      body: h('div',
        facts([
          ['Aged receivables', fmt.money(a.receivables)],
          ['Provision required', fmt.money(a.target)],
          ['Already provided', fmt.money(a.held)],
          ['To post', fmt.money(a.movement, undefined, { sign: true })],
        ]),
        h('div.callout', { style: { marginTop: '10px' } },
          a.movement > 0
            ? 'Debit Bad Debt Expense, credit Allowance for Doubtful Accounts. The receivables themselves are untouched — this is a judgement about how much of them will arrive.'
            : 'Debit Allowance for Doubtful Accounts, credit Bad Debt Expense. The ledger collected better than it was provided for.'),
        h('div.field', { style: { marginTop: '10px' } }, h('label', 'Memo'), memo)),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Post it', kind: 'primary',
          onClick: async (close) => {
            try {
              const res = await API.runAllowance({ memo: memo.value || '' });
              notifyOk(`${res.entry.entry_no} posted — provision now ${fmt.money(res.target)}.`, 'Provision updated');
              close(true); load();
            } catch (e) { notifyError(e); return false; }
          },
        },
      ],
    });
  }

  load();
  return h('div.page', h('div.page-head', head), host);
}
