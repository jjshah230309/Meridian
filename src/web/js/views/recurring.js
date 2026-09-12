// Meridian ERP :: web/views/recurring
// Standing entries and month-end accruals: what posts, when it next posts,
// and the run that puts it on the ledger.
//
// The screen is built around the calendar rather than the amounts, because
// the question a controller brings here is "what has not gone in yet". The
// run is dry-run first — it shows every date it would touch before anything
// reaches the ledger — and an accrual says on its face that it unwinds
// itself, since that is the detail people forget and then double-count.
import { h, mount, clear } from '../dom.js';
import { icon } from '../icons.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import * as store from '../store.js';
import { empty, notifyError, notifyOk, statusTag, loading, modal, facts, fieldControl } from '../ui.js';

const ORDINAL = (n) => {
  const v = Number(n) || 1;
  const suffix = v % 100 >= 11 && v % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][v % 10] || 'th';
  return `${v}${suffix}`;
};

/** The calendar in words, because "monthly / month_end" is not a sentence. */
function cadence(r) {
  if (r.frequency === 'weekly') return `Weekly from ${fmt.dateShort(r.start_date)}`;
  const every = { monthly: 'Monthly', quarterly: 'Quarterly', annually: 'Annually' }[r.frequency] || 'Monthly';
  return r.day_rule === 'month_end' ? `${every}, at month end` : `${every}, on the ${ORDINAL(r.day_of_month)}`;
}

/** Every template reduced to what it costs in a month, so the totals add up. */
const perMonth = (r) => {
  const factor = { weekly: 52 / 12, monthly: 1, quarterly: 1 / 3, annually: 1 / 12 }[r.frequency] || 1;
  return (r.amount || 0) * factor;
};

const overdue = (d) => d && d < fmt.today();

export async function recurringView(route, { go }) {
  if (!store.can('recurring_journal')) {
    return h('div.page', empty('Not permitted', 'Your role cannot see recurring journals.'));
  }
  const canEdit = store.can('recurring_journal', store.LEVEL.EDIT);
  const canCreate = store.can('recurring_journal', store.LEVEL.CREATE);

  const host = h('div');
  const head = h('div');
  let filter = 'active';

  async function load() {
    mount(host, loading('Reading the recurring journals'));
    try {
      const [list, dueRows] = await Promise.all([
        API.recurringList({ status: filter }),
        API.recurringDue(),
      ]);
      render(list, dueRows);
    } catch (e) {
      mount(host, empty('Could not load the recurring journals', e.message));
    }
  }

  function render(list, dueRows) {
    const due = dueRows.rows || [];
    mount(head,
      h('div.titles',
        h('h1', 'Recurring Journals'),
        h('div.page-sub', 'Standing entries and month-end accruals, and the dates they are waiting on')),
      h('div.page-actions',
        canCreate ? h('button.btn', { onclick: () => editor(null) }, 'New template') : null,
        canEdit
          ? h('button.btn.primary', {
            disabled: !due.length,
            title: due.length ? '' : 'Nothing is due to post',
            onclick: () => runDialog(),
          }, 'Post due entries')
          : null));

    if (!list.rows.length && filter === 'active') {
      mount(host, empty('No recurring journals yet',
        'A template is a set of balanced lines and a calendar. Mark it as an accrual and it posts at period end and reverses itself on the first of the next month.',
        canCreate ? h('button.btn.primary', { onclick: () => editor(null) }, 'New template') : null));
      return;
    }

    const dueAmount = due.reduce((a, r) => a + (r.amount || 0), 0);
    const accruals = list.rows.filter((r) => r.auto_reverse && r.status === 'active');
    const kpis = h('div.kpi-grid', { style: { marginBottom: '14px' } },
      h('div.kpi',
        h('div.k-label', 'Due to post'),
        h('div.k-value', { class: due.length ? 'num-neg' : '' }, String(due.length)),
        h('div.k-meta', due.length
          ? `Earliest ${fmt.dateShort(due[0].next_date)}`
          : 'Everything is up to date')),
      h('div.kpi',
        h('div.k-label', 'Waiting to be posted'),
        h('div.k-value', fmt.moneyCompact(dueAmount)),
        h('div.k-meta', 'Across every template now due')),
      h('div.kpi',
        h('div.k-label', 'Monthly run rate'),
        h('div.k-value', fmt.moneyCompact(Math.round(list.rows.filter((r) => r.status === 'active').reduce((a, r) => a + perMonth(r), 0)))),
        h('div.k-meta', 'Active templates, put on a monthly footing')),
      h('div.kpi',
        h('div.k-label', 'Self-reversing'),
        h('div.k-value', String(accruals.length)),
        h('div.k-meta', accruals.length ? 'Accruals that unwind themselves' : 'No accruals set up')));

    const tabs = h('div.tabs', { style: { marginBottom: '14px' } },
      ...[['active', 'Active'], ['paused', 'Paused'], ['ended', 'Ended'], ['all', 'All']].map(([k, label]) =>
        h('button.tab', {
          class: k === filter ? 'active' : '',
          onclick: () => { if (k === filter) return; filter = k; load(); },
        }, label)));

    const rows = list.rows.map((r) => h('tr.clickable', { onclick: () => details(r.id) },
      h('td', h('strong', r.name), r.memo ? h('div.muted', { style: { fontSize: '12px' } }, r.memo) : null),
      h('td.muted', cadence(r)),
      h('td', r.auto_reverse
        ? h('span.tag.blue', { title: 'Posts at period end and reverses on the following day' }, 'Accrual')
        : h('span.muted', '—')),
      h('td', { class: overdue(r.next_date) && r.status === 'active' ? 'num-neg' : '' },
        r.status === 'ended' ? h('span.muted', '—') : fmt.date(r.next_date)),
      h('td.num', fmt.money(r.amount, r.currency)),
      h('td.num.muted', String(r.occurrences)),
      h('td.muted', r.last_run_date ? fmt.dateShort(r.last_run_date) : '—'),
      h('td', statusTag(r.status))));

    mount(host, kpis, tabs,
      h('div.card',
        h('div.card-head', h('h2', 'Templates'),
          h('span.muted', { style: { fontSize: '12px' } }, `${list.total} ${filter === 'all' ? 'in total' : filter}`)),
        rows.length
          ? h('div.grid-wrap', h('table.grid',
            h('thead', h('tr', h('th', 'Name'), h('th', 'Cadence'), h('th', 'Type'),
              h('th', 'Next run'), h('th.num', 'Amount'), h('th.num', 'Runs'),
              h('th', 'Last run'), h('th', 'Status'))),
            h('tbody', ...rows)))
          : h('div.card-body', h('div.muted', `Nothing ${filter === 'all' ? 'here' : `is ${filter}`}.`))));
  }

  // ------------------------------------------------------------- details
  async function details(id) {
    let data;
    try { data = await API.recurring(id); } catch (e) { notifyError(e); return; }
    const r = data.recurring;
    const total = r.lines.reduce((a, l) => a + l.debit, 0);

    const linesTable = h('div.grid-wrap', h('table.grid',
      h('thead', h('tr', h('th', 'Account'), h('th', 'Memo'), h('th.num', 'Debit'), h('th.num', 'Credit'))),
      h('tbody', ...r.lines.map((l) => h('tr',
        h('td', h('span.mono', l.account_number), ' ', l.account_name),
        h('td.muted', l.memo || '—'),
        h('td.num', l.debit ? fmt.money(l.debit, r.currency) : ''),
        h('td.num', l.credit ? fmt.money(l.credit, r.currency) : ''))))));

    const history = data.history.length
      ? h('div.grid-wrap', { style: { maxHeight: '220px' } }, h('table.grid',
        h('thead', h('tr', h('th', 'Entry'), h('th', 'Date'), h('th', 'Memo'), h('th.num', 'Amount'))),
        h('tbody', ...data.history.map((e) => h('tr.clickable', {
          onclick: () => { m.close(); go(`/journal/${e.id}`); },
        },
        h('td', h('strong', e.entry_no), e.is_reversal ? h('span.tag.blue', { style: { marginLeft: '6px' } }, 'Reversal') : null),
        h('td', fmt.date(e.txn_date)),
        h('td.muted', e.memo || '—'),
        h('td.num', fmt.money(e.total_debit)))))))
      : h('div.muted', { style: { padding: '10px 0' } }, 'It has not posted anything yet.');

    const actions = [{ label: 'Close', value: null }];
    if (canEdit) {
      if (r.status !== 'ended') {
        actions.push({
          label: r.status === 'active' ? 'Pause' : 'Resume',
          onClick: async (close) => {
            try {
              await API.recurringStatus(r.id, r.status === 'active' ? 'paused' : 'active');
              notifyOk(`${r.name} is now ${r.status === 'active' ? 'paused' : 'active'}.`);
              close(true); load();
            } catch (e) { notifyError(e); return false; }
          },
        });
      }
      actions.push({ label: 'Edit', onClick: (close) => { close(true); editor(r); } });
      if (r.status === 'active') {
        actions.push({
          label: 'Post this one', kind: 'primary',
          onClick: (close) => { close(true); runDialog(r); },
        });
      }
    }

    const m = modal({
      title: r.name,
      size: 'wide',
      body: h('div',
        facts([
          ['Cadence', cadence(r)],
          ['Next run', r.status === 'ended' ? 'Ended' : fmt.date(r.next_date)],
          ['Amount', fmt.money(total, r.currency)],
          ['Type', r.auto_reverse ? 'Accrual — reverses the next day' : 'Standing entry'],
          ['Runs so far', String(r.occurrences) + (r.max_occurrences ? ` of ${r.max_occurrences}` : '')],
          ['Period', `${fmt.date(r.start_date)} → ${r.end_date ? fmt.date(r.end_date) : 'no end date'}`],
        ]),
        h('h3', { style: { margin: '14px 0 6px', fontSize: '13px' } }, 'Lines'),
        linesTable,
        h('h3', { style: { margin: '14px 0 6px', fontSize: '13px' } }, 'History'),
        history),
      actions,
    });
    return m;
  }

  // -------------------------------------------------------------- editor
  async function editor(existing) {
    const accounts = await store.refOptions('account');
    const postable = accounts.filter((a) => !a.row.is_summary && a.row.active !== 0);
    const subsidiaries = store.state.meta.subsidiaries || [];

    const model = {
      name: existing?.name || '',
      subsidiary_id: existing?.subsidiary_id || subsidiaries[0]?.id || '',
      currency: existing?.currency || store.state.tenant.base_currency,
      memo: existing?.memo || '',
      frequency: existing?.frequency || 'monthly',
      day_rule: existing?.day_rule || 'month_end',
      day_of_month: existing?.day_of_month || 1,
      start_date: existing?.start_date || fmt.today(),
      end_date: existing?.end_date || '',
      auto_reverse: existing ? !!existing.auto_reverse : false,
      max_occurrences: existing?.max_occurrences || 0,
    };
    let lines = existing?.lines?.length
      ? existing.lines.map((l) => ({
        account_id: l.account_id, memo: l.memo || '',
        debit: l.debit ? l.debit / 100 : '',
        credit: l.credit ? l.credit / 100 : '',
      }))
      : [blank(), blank()];
    function blank() { return { account_id: '', memo: '', debit: '', credit: '' }; }

    const controls = {};
    const headerHost = h('div.form-grid');
    const dayField = { name: 'day_of_month', label: 'Day of the month', type: 'number', help: 'Days after the 28th are not offered: not every month has one.' };

    const fields = [
      { name: 'name', label: 'Name', type: 'text', required: true },
      subsidiaries.length > 1 && { name: 'subsidiary_id', label: 'Subsidiary', type: 'reference', ref: 'subsidiary', required: true },
      { name: 'frequency', label: 'Frequency', type: 'select', options: ['weekly', 'monthly', 'quarterly', 'annually'] },
      { name: 'day_rule', label: 'Posts on', type: 'select', options: [
        { value: 'month_end', label: 'The last day of the period' },
        { value: 'day_of_month', label: 'A fixed day of the month' },
      ] },
      dayField,
      { name: 'start_date', label: 'First run', type: 'date', required: true },
      { name: 'end_date', label: 'Stop after', type: 'date', help: 'Leave empty to run until it is paused.' },
      { name: 'auto_reverse', label: 'Reverse it the next day (accrual)', type: 'checkbox' },
      { name: 'memo', label: 'Memo', type: 'text', full: true },
    ].filter(Boolean);

    for (const f of fields) {
      const ctl = fieldControl(f, model[f.name], (v) => { model[f.name] = v; syncCalendar(); });
      controls[f.name] = ctl;
      headerHost.appendChild(ctl.el);
    }
    Object.assign(controls.day_of_month.input, { min: '1', max: '28', step: '1' });

    // Weekly repeats from its start date, so neither the day rule nor the day
    // number means anything; hiding them is kinder than leaving dead controls.
    function syncCalendar() {
      const weekly = controls.frequency.get() === 'weekly';
      const byDay = !weekly && controls.day_rule.get() === 'day_of_month';
      controls.day_rule.el.hidden = weekly;
      controls.day_of_month.el.hidden = !byDay;
      if (cadenceNote) cadenceNote.textContent = cadence({
        frequency: controls.frequency.get(), day_rule: controls.day_rule.get(),
        day_of_month: controls.day_of_month.get(), start_date: controls.start_date.get(),
      });
    }
    const cadenceNote = h('span.muted', { style: { fontSize: '12px' } }, '');

    const body = h('tbody');
    const balanceBox = h('div');
    const totals = () => {
      const d = lines.reduce((a, l) => a + (Number(l.debit) || 0), 0);
      const c = lines.reduce((a, l) => a + (Number(l.credit) || 0), 0);
      return { debit: d, credit: c, diff: Math.round((d - c) * 100) / 100 };
    };

    function recalc() {
      const t = totals();
      mount(balanceBox, h('div.row', { style: { justifyContent: 'flex-end', gap: '22px', padding: '8px 12px' } },
        h('div', h('div.muted', { style: { fontSize: '11px' } }, 'DEBITS'),
          h('div', { style: { fontSize: '14px', fontWeight: 600, textAlign: 'right' } }, fmt.money(Math.round(t.debit * 100), model.currency))),
        h('div', h('div.muted', { style: { fontSize: '11px' } }, 'CREDITS'),
          h('div', { style: { fontSize: '14px', fontWeight: 600, textAlign: 'right' } }, fmt.money(Math.round(t.credit * 100), model.currency))),
        h('div', h('div.muted', { style: { fontSize: '11px' } }, 'DIFFERENCE'),
          h('div', { style: { fontSize: '14px', fontWeight: 600, textAlign: 'right' }, class: t.diff === 0 ? 'num-pos' : 'num-neg' },
            fmt.money(Math.round(t.diff * 100), model.currency)))));
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
          h('td', { style: { width: '26px' } }, h('span.faint', String(i + 1))),
          h('td', { style: { minWidth: '240px' } }, acct),
          h('td', memo),
          h('td', { style: { width: '120px' } }, debit),
          h('td', { style: { width: '120px' } }, credit),
          h('td', { style: { width: '28px' } }, h('button.rm', {
            onclick: () => { lines.splice(i, 1); if (lines.length < 2) lines.push(blank()); draw(); recalc(); },
          }, icon('x', { size: 13 })))));
      });
    }
    draw();
    recalc();
    syncCalendar();

    return modal({
      title: existing ? `Edit ${existing.name}` : 'New recurring journal',
      size: 'wide',
      body: h('div',
        headerHost,
        h('div.row', { style: { justifyContent: 'space-between', alignItems: 'center', margin: '14px 0 6px' } },
          h('h3', { style: { margin: 0, fontSize: '13px' } }, 'Lines'),
          h('div.row', { style: { gap: '10px', alignItems: 'center' } },
            cadenceNote,
            h('button.btn.sm', { onclick: () => { lines.push(blank()); draw(); } }, icon('plus', { size: 13 }), 'Add line'))),
        h('div.grid-wrap', h('table.lines-table',
          h('thead', h('tr', h('th', ''), h('th', 'Account'), h('th', 'Memo'), h('th', 'Debit'), h('th', 'Credit'), h('th', ''))),
          body)),
        h('div', { style: { borderTop: '1px solid var(--border)' } }, balanceBox)),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: existing ? 'Save changes' : 'Create template', kind: 'primary',
          onClick: async (close) => {
            const t = totals();
            if (t.diff !== 0 || !t.debit) {
              notifyError(new Error(t.debit ? 'Debits and credits must be equal.' : 'Enter at least one debit and one credit.'));
              return false;
            }
            const payload = {
              ...Object.fromEntries(fields.map((f) => [f.name, controls[f.name].get()])),
              currency: model.currency,
              max_occurrences: model.max_occurrences,
              lines: lines.filter((l) => l.account_id && (Number(l.debit) || Number(l.credit)))
                .map((l) => ({ account_id: l.account_id, memo: l.memo, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0 })),
            };
            if (!payload.subsidiary_id) payload.subsidiary_id = subsidiaries[0]?.id;
            try {
              const saved = existing
                ? await API.updateRecurring(existing.id, payload)
                : await API.createRecurring(payload);
              notifyOk(existing ? `${saved.name} saved.` : `${saved.name} will next post on ${fmt.date(saved.next_date)}.`,
                existing ? 'Template updated' : 'Template created');
              close(true); load();
            } catch (e) { notifyError(e); return false; }
          },
        },
      ],
    });
  }

  // ----------------------------------------------------------------- run
  /** Preview first, then post. Nobody should write to the ledger blind. */
  function runDialog(single = null) {
    const through = h('input', { type: 'date', value: fmt.today() });
    const preview = h('div', { style: { marginTop: '12px' } });
    let plan = null;

    const runPreview = async () => {
      mount(preview, loading('Working out what would post'));
      try {
        plan = await API.runRecurring({ through: through.value, id: single?.id || null, dry_run: true });
        mount(preview, planSummary(plan));
      } catch (e) { plan = null; mount(preview, empty('Could not preview the run', e.message)); }
    };
    through.addEventListener('change', runPreview);

    const m = modal({
      title: single ? `Post ${single.name}` : 'Post due entries',
      size: 'wide',
      body: h('div',
        h('p.muted', { style: { marginTop: 0 } },
          'Every occurrence dated on or before this day is posted, one entry per date — a template three months behind catches up month by month rather than in one lump. Anything whose period is closed is listed and left where it is.'),
        h('div.field', h('label', 'Post everything up to'), through),
        preview),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Post entries', kind: 'primary',
          onClick: async (close) => {
            if (!plan || !plan.generated) { notifyError(new Error('There is nothing to post for that date.')); return false; }
            try {
              const res = await API.runRecurring({ through: through.value, id: single?.id || null });
              notifyOk(`${res.generated} journal ${res.generated === 1 ? 'entry' : 'entries'} posted, ${fmt.money(Math.round(res.amount * 100))} in total.`,
                'Run complete');
              close(true); load();
            } catch (e) { notifyError(e); return false; }
          },
        },
      ],
    });
    runPreview();
    return m;
  }

  function planSummary(plan) {
    if (!plan.generated && !plan.skipped.length) {
      return h('div.muted', { style: { padding: '10px 0' } }, 'Nothing falls due on or before that date.');
    }
    const rows = plan.posted.map((p) => h('tr',
      h('td', fmt.date(p.date)),
      h('td', p.name, p.auto_reverse ? h('span.tag.blue', { style: { marginLeft: '6px' } }, 'reverses') : null),
      h('td.num', fmt.money(Math.round(p.amount * 100)))));
    const total = plan.posted.reduce((a, p) => a + p.amount, 0);
    return h('div',
      plan.generated
        ? h('div',
          facts([['Journal entries', String(plan.generated)], ['Total to be posted', fmt.money(Math.round(total * 100))]]),
          h('div.grid-wrap', { style: { marginTop: '8px', maxHeight: '220px' } },
            h('table.grid',
              h('thead', h('tr', h('th', 'Posting date'), h('th', 'Template'), h('th.num', 'Amount'))),
              h('tbody', ...rows))))
        : null,
      plan.skipped.length
        ? h('div.callout.warn', { style: { marginTop: '10px' } },
          h('strong', `${plan.skipped.length} held back. `),
          plan.skipped.map((s) => `${s.name} on ${fmt.dateShort(s.date)} — ${s.reason}`).join('; '),
          '. Reopen the period, or run again once it is open.')
        : null);
  }

  load().then(() => { if (route.parts[1] === 'new' && canCreate) editor(null); });
  return h('div.page', h('div.page-head', head), host);
}
