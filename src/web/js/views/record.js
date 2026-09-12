// Meridian ERP :: web/views/record
// Generic record page and creation form, generated from metadata plus the
// tenant's custom fields. Related lists, activity timeline and the audit
// trail come from the same endpoint so a record page is one round trip.
import { h, mount, clear } from '../dom.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import * as store from '../store.js';
import { fieldControl, displayValue, empty, loading, toast, notifyError, confirm, modal, statusTag, facts, formatAddress, moneyCell } from '../ui.js';

const SYSTEM_SECTION = 'System';

export async function recordView(route, { go }) {
  const [, type, id] = route.parts;
  const meta = store.metaFor(type);
  if (!meta) return h('div.page', empty('Unknown record type', type));

  const data = await API.record(type, id);
  const record = data.record;
  const fm = store.fieldMap(type);
  await store.ensureRefs(Object.values(fm).map((f) => f.ref).filter(Boolean));

  const canEdit = store.can(type, store.LEVEL.EDIT) && !meta.readOnlyRecord;
  let editing = false;
  const bodyHost = h('div');

  const title = () => {
    if (type === 'employee') return `${record.first_name} ${record.last_name}`;
    if (type === 'contact') return `${record.first_name} ${record.last_name}`.trim() || record.email;
    if (type === 'account') return `${record.number} · ${record.name}`;
    if (type === 'item') return `${record.sku} · ${record.name}`;
    return record[meta.title] || record.name || record.id;
  };

  function renderRead() {
    editing = false;
    const sections = groupFields(meta, fm, record);
    mount(bodyHost,
      h('div.split',
        h('div.stack',
          ...sections.map(([name, fields]) => h('div.card',
            h('div.card-head', h('h2', name)),
            h('div.card-body', h('div.form-grid',
              ...fields.map((f) => h('div.field',
                h('label', f.label),
                h('div', { style: { paddingTop: '2px' } }, readValue(f, record)))))))),
          ...relatedCards(type, data, go)),
        h('div.stack',
          summaryCard(type, record, data),
          data.activities?.length ? activityCard(data.activities) : null,
          data.audit?.length ? auditCard(data.audit) : null)));
  }

  function renderEdit() {
    editing = true;
    const controls = {};
    const sections = groupFields(meta, fm, record, { forEdit: true });
    const form = h('div.stack',
      ...sections.map(([name, fields]) => h('div.card',
        h('div.card-head', h('h2', name)),
        h('div.card-body', h('div.form-grid', ...fields.map((f) => {
          const value = f.custom ? record.custom?.[f.name.slice(7)] : record[f.name];
          const ctl = fieldControl({ ...f, readOnly: f.readOnly }, value, null);
          controls[f.name] = ctl;
          return ctl.el;
        }))))));

    mount(bodyHost, form,
      h('div.row', { style: { marginTop: '14px' } },
        h('button.btn.primary', { onclick: save }, 'Save changes'),
        h('button.btn', { onclick: renderRead }, 'Cancel')));

    async function save(e) {
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = 'Saving…';
      Object.values(controls).forEach((c) => c.setError(null));
      const patch = {}; const custom = {};
      for (const [name, ctl] of Object.entries(controls)) {
        if (ctl.field.readOnly) continue;
        const v = ctl.get();
        if (name.startsWith('custom.')) custom[name.slice(7)] = v;
        else patch[name] = v;
      }
      if (Object.keys(custom).length) patch.custom = custom;
      try {
        const updated = await API.update(type, id, patch);
        Object.assign(record, updated);
        store.invalidateRef(type);
        toast('Saved', { kind: 'success' });
        const fresh = await API.record(type, id);
        Object.assign(data, fresh); Object.assign(record, fresh.record);
        renderRead();
        head.replaceWith(buildHead());
      } catch (err) {
        if (err.fields) {
          for (const [k, msg] of Object.entries(err.fields)) (controls[k] || controls[`custom.${k.replace(/^custom\./, '')}`])?.setError(msg);
          toast(err.message, { kind: 'error', title: 'Check the highlighted fields' });
        } else notifyError(err);
      } finally { btn.disabled = false; btn.textContent = 'Save changes'; }
    }
  }

  function buildHead() {
    const el = h('div.page-head',
      h('div.titles',
        h('div.breadcrumb', h('a', { href: `#/list/${type}`, onclick: (e) => { e.preventDefault(); go(`/list/${type}`); } }, meta.plural), ' / ', record[meta.title] || ''),
        h('h1', title(), record.status ? statusTag(record.status) : null, record.active === 0 ? h('span.tag', 'Inactive') : null),
        h('div.page-sub', subtitleFor(type, record))),
      h('div.page-actions',
        ...recordActions(type, record, data, go, refresh),
        canEdit && !editing && h('button.btn.primary', { onclick: () => { renderEdit(); } }, 'Edit'),
        store.can(type, store.LEVEL.FULL) && h('button.btn.danger', { onclick: remove }, record.active !== undefined ? 'Deactivate' : 'Delete')));
    head = el;
    return el;
  }

  async function remove() {
    const soft = record.active !== undefined;
    const ok = await confirm({
      title: soft ? `Deactivate ${meta.label.toLowerCase()}?` : `Delete ${meta.label.toLowerCase()}?`,
      message: soft
        ? `${title()} will be hidden from pickers and new transactions. Its history stays intact and it can be reactivated later.`
        : `${title()} will be permanently removed.`,
      confirmLabel: soft ? 'Deactivate' : 'Delete', danger: true,
    });
    if (!ok) return;
    try {
      await API.remove(type, id);
      store.invalidateRef(type);
      toast(soft ? 'Deactivated' : 'Deleted', { kind: 'success' });
      go(`/list/${type}`);
    } catch (e) { notifyError(e); }
  }

  async function refresh() {
    const fresh = await API.record(type, id);
    Object.assign(data, fresh); Object.assign(record, fresh.record);
    renderRead();
    head.replaceWith(buildHead());
  }

  // Declared before the first build: buildHead() assigns to `head` itself so
  // that refresh() can swap it, and `let head = buildHead()` would touch the
  // binding while it was still in its temporal dead zone — which took every
  // record detail page down with a ReferenceError.
  let head;
  head = buildHead();
  renderRead();
  return h('div.page', head, bodyHost);
}

// --------------------------------------------------------------- helpers
function groupFields(meta, fm, record, { forEdit = false } = {}) {
  const groups = new Map();
  const push = (section, f) => { if (!groups.has(section)) groups.set(section, []); groups.get(section).push(f); };
  for (const f of meta.fields) {
    if (forEdit && f.readOnly && f.section === SYSTEM_SECTION) continue;
    push(f.section || 'Details', f);
  }
  for (const cf of meta.customFields || []) {
    push('Custom fields', { name: `custom.${cf.name}`, label: cf.label, type: cf.type, options: cf.options, ref: cf.ref_type, help: cf.help_text, required: cf.required, readOnly: cf.type === 'formula', custom: true, full: cf.type === 'longtext' });
  }
  // Details first, System last, everything else in declaration order.
  const order = [...groups.keys()].sort((a, b) => (a === 'Details' ? -1 : b === 'Details' ? 1 : a === SYSTEM_SECTION ? 1 : b === SYSTEM_SECTION ? -1 : 0));
  return order.map((k) => [k, groups.get(k)]);
}

function readValue(f, record) {
  const value = f.custom ? record.custom?.[f.name.slice(7)] : record[f.name];
  if (f.ref || f.refFrom) {
    const label = record[`${f.name}_label`] || store.refLabelSync(f.ref, value);
    if (label) {
      const target = ['customer', 'vendor', 'item', 'employee', 'account', 'contact'].includes(f.ref);
      return target && value
        ? h('a', { href: `#/record/${f.ref}/${value}`, onclick: (e) => { e.preventDefault(); window.__meridianGo(`/record/${f.ref}/${value}`); } }, label)
        : h('span', label);
    }
  }
  return displayValue(f, value, record);
}

const subtitleFor = (type, r) => {
  if (type === 'customer' || type === 'vendor') return [r.entity_no, r.email, r.phone].filter(Boolean).join(' · ');
  if (type === 'employee') return [r.title, r.email].filter(Boolean).join(' · ');
  if (type === 'item') return [fmt.titleCase(r.type), r.category, fmt.money(r.base_price)].filter(Boolean).join(' · ');
  if (type === 'opportunity') return [fmt.money(r.amount, r.currency), `${r.probability}% · closes ${fmt.date(r.expected_close)}`].join(' · ');
  if (type === 'support_case') return [r.case_no, fmt.titleCase(r.priority) + ' priority'].filter(Boolean).join(' · ');
  return '';
};

function summaryCard(type, record, data) {
  const rel = data.related || {};
  if (type === 'customer' && rel.financials) {
    const f = rel.financials;
    return h('div.card',
      h('div.card-head', h('h2', 'Financial position')),
      h('div.card-body', facts([
        ['Open receivables', moneyCell(f.open_ar, record.currency)],
        ['Overdue', h('span', { class: f.overdue ? 'num-neg' : '' }, fmt.money(f.overdue, record.currency))],
        ['Open orders', fmt.money(f.open_orders, record.currency)],
        ['Total exposure', fmt.money(f.exposure, record.currency)],
        ['Credit limit', f.credit_limit ? fmt.money(f.credit_limit, record.currency) : 'None'],
        f.credit_limit && ['Credit available', h('span', { class: f.over_limit ? 'num-neg' : 'num-pos' }, fmt.money(f.credit_available, record.currency))],
        ['Lifetime invoiced', fmt.money(f.lifetime_invoiced, record.currency)],
      ]),
        f.on_hold && h('div.tag.red', { style: { marginTop: '10px' } }, 'On credit hold'),
        f.over_limit && h('div.tag.amber', { style: { marginTop: '10px' } }, 'Over credit limit')));
  }
  if (type === 'vendor' && rel.financials) {
    const f = rel.financials;
    return h('div.card', h('div.card-head', h('h2', 'Payables')),
      h('div.card-body', facts([
        ['Open payables', fmt.money(f.open_ap, record.currency)],
        ['Overdue', h('span', { class: f.overdue ? 'num-neg' : '' }, fmt.money(f.overdue, record.currency))],
        ['Open purchase orders', fmt.money(f.open_pos, record.currency)],
        ['Lifetime billed', fmt.money(f.lifetime_billed, record.currency)],
      ])));
  }
  if (type === 'item' && rel.availability) {
    const a = rel.availability;
    return h('div.card', h('div.card-head', h('h2', 'Stock position')),
      h('div.card-body', facts([
        ['On hand', fmt.qty(a.total_on_hand)],
        ['Committed', fmt.qty(a.total_committed)],
        ['Available', h('strong', fmt.qty(a.total_available))],
        ['On order', fmt.qty(a.total_on_order)],
        ['Inventory value', fmt.money(a.total_value)],
      ]),
        a.locations?.length ? h('table.grid.compact', { style: { marginTop: '10px' } },
          h('thead', h('tr', h('th', 'Location'), h('th.num', 'On hand'), h('th.num', 'Avail'), h('th.num', 'Avg cost'))),
          h('tbody', ...a.locations.map((l) => h('tr',
            h('td', l.location_name),
            h('td.num', fmt.qty(l.qty_on_hand)),
            h('td.num', fmt.qty(l.qty_available)),
            h('td.num', fmt.money(l.avg_cost)))))) : null));
  }
  if (type === 'account' && rel.ledger) {
    return h('div.card', h('div.card-head', h('h2', 'Balance')),
      h('div.card-body', facts([
        ['Opening', fmt.money(rel.ledger.opening)],
        ['Closing', h('strong', fmt.money(rel.ledger.closing))],
        ['Postings shown', String(rel.ledger.lines.length)],
      ]), h('button.btn.sm', { style: { marginTop: '10px' }, onclick: () => window.__meridianGo(`/account/${record.id}`) }, 'Open ledger')));
  }
  return null;
}

function relatedCards(type, data, go) {
  const rel = data.related || {};
  const out = [];
  const table = (title, rows, cols, onRow, action) => rows?.length ? h('div.card',
    h('div.card-head', h('h2', title), h('span.muted', { style: { fontSize: '12px' } }, `${rows.length}`), action && h('div.actions', action)),
    h('div.grid-wrap', h('table.grid.compact',
      h('thead', h('tr', ...cols.map((c) => h('th', { class: c.num ? 'num' : '' }, c.label)))),
      h('tbody', ...rows.map((r) => h('tr.clickable', { onclick: () => onRow(r) },
        ...cols.map((c) => h('td', { class: c.num ? 'num' : '' }, c.render(r))))))))) : null;

  if (rel.transactions) {
    out.push(table('Transactions', rel.transactions, [
      { label: 'Type', render: (r) => h('span.muted', fmt.titleCase(r.type.replace(/_/g, ' ').toLowerCase())) },
      { label: 'Number', render: (r) => h('span.mono', r.txn_no) },
      { label: 'Date', render: (r) => fmt.date(r.txn_date) },
      { label: 'Status', render: (r) => statusTag(r.status) },
      { label: 'Total', num: true, render: (r) => fmt.money(r.total, r.currency) },
      { label: 'Balance', num: true, render: (r) => (r.amount_remaining ? h('span.num-neg', fmt.money(r.amount_remaining, r.currency)) : h('span.faint', '—')) },
    ], (r) => go(`/txn/${r.id}`)));
  }
  if (rel.contacts) out.push(table('Contacts', rel.contacts, [
    { label: 'Name', render: (r) => `${r.first_name || ''} ${r.last_name || ''}`.trim() },
    { label: 'Title', render: (r) => r.title || '—' },
    { label: 'Email', render: (r) => r.email || '—' },
    { label: 'Phone', render: (r) => r.phone || '—' },
    { label: '', render: (r) => (r.is_primary ? h('span.tag.blue', 'Primary') : '') },
  ], (r) => go(`/record/contact/${r.id}`)));
  if (rel.opportunities) out.push(table('Opportunities', rel.opportunities, [
    { label: 'Name', render: (r) => r.name },
    { label: 'Stage', render: (r) => statusTag(r.stage) },
    { label: 'Amount', num: true, render: (r) => fmt.money(r.amount, r.currency) },
    { label: 'Close', render: (r) => fmt.date(r.expected_close) },
  ], (r) => go(`/record/opportunity/${r.id}`)));
  if (rel.cases) out.push(table('Support cases', rel.cases, [
    { label: 'Case', render: (r) => h('span.mono', r.case_no) },
    { label: 'Subject', render: (r) => h('span.cell-truncate', r.subject) },
    { label: 'Priority', render: (r) => statusTag(r.priority) },
    { label: 'Status', render: (r) => statusTag(r.status) },
  ], (r) => go(`/record/support_case/${r.id}`)));
  if (rel.reports) out.push(table('Direct reports', rel.reports, [
    { label: 'Name', render: (r) => `${r.first_name} ${r.last_name}` },
    { label: 'Title', render: (r) => r.title || '—' },
    { label: 'Email', render: (r) => r.email || '—' },
  ], (r) => go(`/record/employee/${r.id}`)));
  if (rel.time) out.push(table('Recent time', rel.time, [
    { label: 'Date', render: (r) => fmt.date(r.entry_date) },
    { label: 'Hours', num: true, render: (r) => fmt.num(r.hours, 1) },
    { label: 'Project', render: (r) => r.project || '—' },
    { label: 'Billable', render: (r) => (r.billable ? h('span.tag.green', 'Yes') : h('span.faint', 'No')) },
    { label: 'Status', render: (r) => statusTag(r.status) },
  ], () => {}));
  if (rel.expense_lines) out.push(table('Expenses claimed', rel.expense_lines, [
    { label: 'Date', render: (r) => fmt.date(r.expense_date) },
    { label: 'Category', render: (r) => fmt.titleCase(String(r.category || '').replace(/_/g, ' ')) },
    { label: 'Description', render: (r) => h('span.cell-truncate', r.description || '—') },
    { label: 'Billable', render: (r) => (r.billable ? h('span.tag.green', 'Yes') : h('span.faint', 'No')) },
    { label: 'Tax', num: true, render: (r) => (r.tax_amount ? fmt.money(r.tax_amount) : h('span.faint', '—')) },
    { label: 'Amount', num: true, render: (r) => fmt.money(r.amount) },
  ], () => {}));
  if (rel.time_off) out.push(table('Time off', rel.time_off, [
    { label: 'Type', render: (r) => fmt.titleCase(r.type) },
    { label: 'From', render: (r) => fmt.date(r.start_date) },
    { label: 'To', render: (r) => fmt.date(r.end_date) },
    { label: 'Hours', num: true, render: (r) => fmt.num(r.hours, 1) },
    { label: 'Status', render: (r) => statusTag(r.status) },
  ], () => {}));
  if (rel.history) out.push(table('Stock movements', rel.history, [
    { label: 'Date', render: (r) => fmt.date(r.txn_date) },
    { label: 'Type', render: (r) => fmt.titleCase(r.type) },
    { label: 'Location', render: (r) => r.location_name },
    { label: 'Qty', num: true, render: (r) => h('span', { class: r.qty_delta > 0 ? 'num-pos' : 'num-neg' }, (r.qty_delta > 0 ? '+' : '') + fmt.qty(r.qty_delta)) },
    { label: 'Unit cost', num: true, render: (r) => fmt.money(r.unit_cost) },
    { label: 'On hand after', num: true, render: (r) => fmt.qty(r.running_qty) },
  ], () => {}));
  if (rel.schedule_lines) {
    const cur = data.record?.currency;
    out.push(table('Release schedule', rel.schedule_lines, [
      { label: '#', render: (r) => String(r.period_no) },
      { label: 'Due', render: (r) => fmt.date(r.plan_date) },
      { label: 'Amount', num: true, render: (r) => fmt.money(r.amount, cur) },
      { label: 'Status', render: (r) => statusTag(r.status) },
      { label: 'Released', render: (r) => (r.posted_at ? fmt.date(r.posted_at.slice(0, 10)) : h('span.faint', '—')) },
    ], (r) => (r.entry_id ? go(`/journal/${r.entry_id}`) : null)));
  }
  if (rel.schedules) out.push(table('Recognition schedules', rel.schedules, [
    { label: 'Number', render: (r) => h('span.mono', r.schedule_no) },
    { label: 'Kind', render: (r) => fmt.titleCase(r.kind) },
    { label: 'Description', render: (r) => h('span.cell-truncate', r.memo || '—') },
    { label: 'Period', render: (r) => `${fmt.date(r.start_date)} → ${fmt.date(r.end_date)}` },
    { label: 'Total', num: true, render: (r) => fmt.money(r.total_amount, r.currency) },
    { label: 'Released', num: true, render: (r) => fmt.money(r.posted_amount, r.currency) },
    { label: 'Status', render: (r) => statusTag(r.status) },
  ], (r) => go(`/record/schedule/${r.id}`)));
  if (rel.revaluation_lines) {
    const base = data.record?.base_currency;
    out.push(table('What was revalued', rel.revaluation_lines, [
      { label: 'Scope', render: (r) => fmt.titleCase(r.scope) },
      { label: 'Exposure', render: (r) => h('span.cell-truncate', r.label) },
      { label: 'Account', render: (r) => h('span.mono', r.account_number) },
      { label: 'Balance', num: true, render: (r) => fmt.money(r.foreign_amount, r.currency) },
      { label: 'Booked at', num: true, render: (r) => Number(r.rate_booked).toFixed(4) },
      { label: 'Closing', num: true, render: (r) => Number(r.rate_used).toFixed(4) },
      { label: 'Carried', num: true, render: (r) => fmt.money(r.booked_base, base) },
      { label: 'Worth', num: true, render: (r) => fmt.money(r.revalued_base, base) },
      { label: 'Adjustment', num: true, render: (r) => h('span', { class: r.adjustment > 0 ? 'num-pos' : 'num-neg' }, fmt.money(r.adjustment, base, { sign: true })) },
    ], (r) => (r.txn_id ? go(`/txn/${r.txn_id}`) : r.account_id ? go(`/account/${r.account_id}`) : null)));
  }
  if (rel.recurring_lines) {
    const cur = data.record?.currency;
    out.push(table('Lines', rel.recurring_lines, [
      { label: '#', render: (r) => String(r.line_no) },
      { label: 'Account', render: (r) => h('span', h('span.mono', r.account_number), ' ', r.account_name) },
      { label: 'Memo', render: (r) => h('span.cell-truncate', r.memo || '—') },
      { label: 'Debit', num: true, render: (r) => (r.debit ? fmt.money(r.debit, cur) : h('span.faint', '—')) },
      { label: 'Credit', num: true, render: (r) => (r.credit ? fmt.money(r.credit, cur) : h('span.faint', '—')) },
    ], (r) => go(`/account/${r.account_id}`)));
  }
  if (rel.recurring_history) out.push(table('Entries posted', rel.recurring_history, [
    { label: 'Entry', render: (r) => h('span.mono', r.entry_no) },
    { label: 'Date', render: (r) => fmt.date(r.txn_date) },
    { label: 'Memo', render: (r) => h('span.cell-truncate', r.memo || '—') },
    { label: 'Type', render: (r) => (r.is_reversal ? h('span.tag.blue', 'Reversal') : h('span.faint', '—')) },
    { label: 'Amount', num: true, render: (r) => fmt.money(r.total_debit) },
  ], (r) => go(`/journal/${r.id}`)));
  if (rel.items) out.push(table('Items using this template', rel.items, [
    { label: 'SKU', render: (r) => h('span.mono', r.sku) },
    { label: 'Name', render: (r) => r.name },
  ], (r) => go(`/record/item/${r.id}`)));
  if (rel.messages) out.push(caseThread(rel.messages, data.record));
  if (rel.logs) out.push(table('Workflow log', rel.logs, [
    { label: 'When', render: (r) => fmt.dateTime(r.at) },
    { label: 'Result', render: (r) => statusTag(r.result) },
    { label: 'Message', render: (r) => r.message },
    { label: 'ms', num: true, render: (r) => String(r.duration_ms) },
  ], () => {}));
  return out.filter(Boolean);
}

function caseThread(messages, record) {
  const input = h('textarea', { placeholder: 'Write a reply…', style: { minHeight: '64px' } });
  const internal = h('input', { type: 'checkbox', id: 'msg-internal' });
  return h('div.card',
    h('div.card-head', h('h2', 'Conversation')),
    h('div.card-body',
      h('div.timeline', ...messages.map((m) => h('div.tl-item',
        h('div.tl-dot', { style: { background: m.internal ? 'var(--warn)' : m.author_type === 'customer' ? 'var(--text-faint)' : 'var(--accent)' } }),
        h('div.tl-body',
          h('div.row', h('strong', m.author_name || fmt.titleCase(m.author_type)), m.internal ? h('span.tag.amber', 'Internal') : null, h('span.tl-when', { style: { marginLeft: 'auto' } }, fmt.dateTime(m.created_at))),
          h('div', { style: { whiteSpace: 'pre-wrap' } }, m.body))))),
      h('div', { style: { marginTop: '10px' } }, input),
      h('div.row', { style: { marginTop: '6px' } },
        h('label', { for: 'msg-internal', style: { display: 'flex', gap: '5px', alignItems: 'center', fontSize: '12px' } }, internal, 'Internal note'),
        h('button.btn.primary.sm', {
          style: { marginLeft: 'auto' },
          onclick: async (e) => {
            if (!input.value.trim()) return;
            e.currentTarget.disabled = true;
            try {
              await API.caseMessage(record.id, { body: input.value, internal: internal.checked });
              window.__meridianGo(`/record/support_case/${record.id}`);
              location.reload();
            } catch (err) { notifyError(err); e.currentTarget.disabled = false; }
          },
        }, 'Send'))));
}

const activityCard = (activities) => h('div.card',
  h('div.card-head', h('h2', 'Activity')),
  h('div.card-body', h('div.timeline', ...activities.slice(0, 12).map((a) => h('div.tl-item',
    h('div.tl-dot', { style: { background: a.status === 'completed' ? 'var(--pos)' : 'var(--accent)' } }),
    h('div.tl-body',
      h('div', h('strong', a.subject)),
      h('div.muted', { style: { fontSize: '12px' } }, `${fmt.titleCase(a.type)}${a.owner_name ? ' · ' + a.owner_name : ''}`),
      h('div.tl-when', a.due_date ? `Due ${fmt.date(a.due_date)}` : fmt.relative(a.created_at))))))));

const auditCard = (rows) => h('div.card',
  h('div.card-head', h('h2', 'Audit trail'), h('span.muted', { style: { fontSize: '12px' } }, `${rows.length}`)),
  h('div.card-body', h('div.timeline', ...rows.slice(0, 15).map((a) => h('div.tl-item',
    h('div.tl-dot', { style: { background: a.financial ? 'var(--warn)' : 'var(--border-strong)' } }),
    h('div.tl-body',
      h('div', h('strong', fmt.titleCase(a.action)), ' by ', a.user_label || 'system'),
      changeSummary(a.changes),
      h('div.tl-when', fmt.dateTime(a.at))))))));

function changeSummary(changes) {
  const entries = Object.entries(changes || {}).filter(([k]) => k !== '__note').slice(0, 4);
  if (!entries.length) return null;
  return h('div.muted', { style: { fontSize: '11.5px' } },
    entries.map(([k, v]) => `${fmt.titleCase(k)}: ${abbr(v.from)} → ${abbr(v.to)}`).join(' · '));
}
const abbr = (v) => (v === null || v === undefined || v === '' ? '—' : String(v).slice(0, 26));

/** Type-specific header buttons. */
function recordActions(type, record, data, go, refresh) {
  const out = [];
  if (type === 'lead' && record.status !== 'converted' && store.can('customer', store.LEVEL.CREATE)) {
    out.push(h('button.btn', {
      onclick: async () => {
        const ok = await confirm({
          title: 'Convert this lead?',
          message: `${record.name} will become a customer, with a primary contact and an opportunity.`,
          confirmLabel: 'Convert',
        });
        if (!ok) return;
        try {
          const r = await API.convertLead(record.id, {});
          store.invalidateRef('customer');
          toast(`Converted to ${r.customer.name}`, { kind: 'success' });
          go(`/record/customer/${r.customer.id}`);
        } catch (e) { notifyError(e); }
      },
    }, 'Convert lead'));
  }
  if (type === 'customer') {
    if (store.can('sales_order', store.LEVEL.CREATE)) out.push(h('button.btn', { onclick: () => go(`/txn-new/sales_order?entity=${record.id}`) }, 'New order'));
    if (store.can('invoice', store.LEVEL.CREATE)) out.push(h('button.btn', { onclick: () => go(`/txn-new/invoice?entity=${record.id}`) }, 'New invoice'));
    if (store.can('customer_payment', store.LEVEL.CREATE)) out.push(h('button.btn', { onclick: () => paymentModal('customer', record, refresh) }, 'Receive payment'));
  }
  if (type === 'vendor') {
    if (store.can('purchase_order', store.LEVEL.CREATE)) out.push(h('button.btn', { onclick: () => go(`/txn-new/purchase_order?entity=${record.id}`) }, 'New PO'));
    if (store.can('vendor_payment', store.LEVEL.CREATE)) out.push(h('button.btn', { onclick: () => paymentModal('vendor', record, refresh) }, 'Pay vendor'));
  }
  if (type === 'expense_report') out.push(...expenseActions(record, refresh));
  if (type === 'item') out.push(h('button.btn', { onclick: () => stockLevelsModal(record, refresh) }, 'Reorder settings'));
  if (type === 'workflow') out.push(h('button.btn', { onclick: () => testWorkflowModal(record) }, 'Test'));
  return out;
}

/**
 * A claim's next step, and only that step. Showing "approve" beside "submit"
 * beside "reimburse" invites the wrong click; one button says what happens.
 */
function expenseActions(record, refresh) {
  const run = (action, verb, confirmText) => async () => {
    if (confirmText && !await confirm({ title: verb, message: confirmText, confirmLabel: verb })) return;
    try {
      await API.expenseAction(record.id, action);
      toast(`${record.report_no} ${verb.toLowerCase()}d`, { kind: 'success' });
      refresh();
    } catch (e) { notifyError(e); }
  };
  const can = store.can('expense_report', store.LEVEL.FULL);
  const out = [];
  if (['draft', 'rejected'].includes(record.status) && store.can('expense_report', store.LEVEL.EDIT)) {
    out.push(h('button.btn.primary', { onclick: run('submit', 'Submit') }, 'Submit for approval'));
  }
  if (record.status === 'submitted' && can) {
    out.push(h('button.btn.primary', {
      onclick: run('approve', 'Approve',
        `${fmt.money(record.total, record.currency)} will be posted as an expense and recorded as owed to the claimant.`),
    }, 'Approve'));
    out.push(h('button.btn.danger', { onclick: run('reject', 'Reject', 'The claimant can amend it and submit again.') }, 'Reject'));
  }
  if (record.status === 'approved' && can) {
    out.push(h('button.btn.primary', {
      onclick: run('reimburse', 'Reimburse',
        `${fmt.money(record.total, record.currency)} will be paid out of the bank account and the liability cleared.`),
    }, 'Mark reimbursed'));
  }
  return out;
}

/** Receive-or-pay dialog that applies against open documents. */
export async function paymentModal(entityType, entity, onDone) {
  const docs = await API.openDocuments(entityType, entity.id);
  const isCustomer = entityType === 'customer';
  const amountInput = h('input', { type: 'number', step: '0.01', class: 'num', placeholder: '0.00' });
  const dateInput = h('input', { type: 'date', value: fmt.today() });
  const rows = docs.map((d) => {
    const cb = h('input', { type: 'checkbox' });
    const amt = h('input', { type: 'number', step: '0.01', class: 'num', style: { width: '110px' }, value: (d.amount_remaining / 100).toFixed(2), disabled: true });
    cb.addEventListener('change', () => { amt.disabled = !cb.checked; recalc(); });
    amt.addEventListener('input', recalc);
    return { doc: d, cb, amt };
  });
  function recalc() {
    const total = rows.filter((r) => r.cb.checked).reduce((a, r) => a + Number(r.amt.value || 0), 0);
    if (total > 0) amountInput.value = total.toFixed(2);
  }

  modal({
    title: isCustomer ? `Receive payment from ${entity.name}` : `Pay ${entity.name}`,
    size: 'wide',
    body: h('div',
      h('div.form-grid', { style: { marginBottom: '14px' } },
        h('div.field', h('label', 'Payment date'), dateInput),
        h('div.field', h('label', `Amount (${entity.currency})`), amountInput)),
      docs.length
        ? h('div', h('h3', { style: { marginBottom: '6px' } }, 'Apply to open documents'),
          h('table.grid.compact',
            h('thead', h('tr', h('th', ''), h('th', 'Document'), h('th', 'Date'), h('th', 'Due'), h('th.num', 'Total'), h('th.num', 'Outstanding'), h('th.num', 'Apply'))),
            h('tbody', ...rows.map((r) => h('tr',
              h('td', r.cb),
              h('td', h('span.mono', r.doc.txn_no)),
              h('td', fmt.date(r.doc.txn_date)),
              h('td', { class: new Date(r.doc.due_date) < new Date() ? 'num-neg' : '' }, fmt.date(r.doc.due_date)),
              h('td.num', fmt.money(r.doc.total, r.doc.currency)),
              h('td.num', fmt.money(r.doc.amount_remaining, r.doc.currency)),
              h('td.num', r.amt))))))
        : h('div.muted', 'No open documents. The payment will be recorded on account and can be applied later.')),
    actions: [
      { label: 'Cancel', value: null },
      {
        label: isCustomer ? 'Record receipt' : 'Record payment', kind: 'primary',
        onClick: async () => {
          const applications = rows.filter((r) => r.cb.checked).map((r) => ({ txn_id: r.doc.id, amount: Number(r.amt.value || 0) }));
          const amount = Number(amountInput.value || 0) || applications.reduce((a, x) => a + x.amount, 0);
          if (!amount) { toast('Enter an amount', { kind: 'warn' }); return false; }
          await API.payment({
            type: isCustomer ? 'CUSTOMER_PAYMENT' : 'VENDOR_PAYMENT',
            entity_id: entity.id, txn_date: dateInput.value, amount,
            applications, auto_apply: applications.length === 0,
          });
          toast('Payment recorded and posted', { kind: 'success' });
          onDone?.();
        },
      },
    ],
  });
}

async function stockLevelsModal(item, onDone) {
  const avail = await API.availability(item.id);
  const rows = avail.locations.map((l) => ({
    loc: l,
    rop: h('input', { type: 'number', class: 'num', value: (l.reorder_point / 1e6) || 0 }),
    psl: h('input', { type: 'number', class: 'num', value: (l.preferred_stock_level / 1e6) || 0 }),
    safety: h('input', { type: 'number', class: 'num', value: (l.safety_stock / 1e6) || 0 }),
    lead: h('input', { type: 'number', class: 'num', value: l.lead_time_days || 0 }),
  }));
  modal({
    title: `Reorder settings — ${item.sku}`, size: 'wide',
    body: rows.length ? h('table.grid.compact',
      h('thead', h('tr', h('th', 'Location'), h('th.num', 'On hand'), h('th.num', 'Reorder point'), h('th.num', 'Target level'), h('th.num', 'Safety stock'), h('th.num', 'Lead time (d)'))),
      h('tbody', ...rows.map((r) => h('tr',
        h('td', r.loc.location_name),
        h('td.num', fmt.qty(r.loc.qty_on_hand)),
        h('td', r.rop), h('td', r.psl), h('td', r.safety), h('td', r.lead)))))
      : h('div.muted', 'This item has no stock positions yet.'),
    actions: [{
      label: 'Save', kind: 'primary',
      onClick: async () => {
        for (const r of rows) {
          await API.setLevels({
            item_id: item.id, location_id: r.loc.location_id,
            reorder_point: Number(r.rop.value || 0), preferred_stock_level: Number(r.psl.value || 0),
            safety_stock: Number(r.safety.value || 0), lead_time_days: Number(r.lead.value || 0),
          });
        }
        toast('Reorder settings saved', { kind: 'success' });
        onDone?.();
      },
    }],
  });
}

function testWorkflowModal(workflow) {
  const idInput = h('input', { placeholder: 'Record id to test against' });
  const out = h('div', { style: { marginTop: '12px' } });
  modal({
    title: `Test “${workflow.name}”`,
    body: h('div',
      h('div.muted', { style: { marginBottom: '8px' } }, `Evaluates the condition against a real ${workflow.record_type.replace(/_/g, ' ')} without running any action.`),
      idInput, out),
    actions: [{
      label: 'Run test', kind: 'primary', close: false,
      onClick: async () => {
        try {
          const r = await API.testWorkflow(workflow.id, idInput.value.trim());
          mount(out,
            h('div.tag', { class: r.matched ? 'green' : '' }, r.matched ? 'Condition matched' : 'Condition did not match'),
            r.error && h('div.err', r.error),
            r.would_run.length ? h('ul', ...r.would_run.map((a) => h('li', a.label))) : null);
        } catch (e) { mount(out, h('div.err', e.message)); }
        return false;
      },
    }],
  });
}

// ============================================================ new record
export async function newRecordView(route, { go }) {
  const type = route.parts[1];
  const meta = store.metaFor(type);
  if (!meta) return h('div.page', empty('Unknown record type', type));
  if (!store.can(type, store.LEVEL.CREATE)) return h('div.page', empty('Not permitted', `Your role cannot create ${meta.plural.toLowerCase()}.`));
  // Some records are assembled by a module and carry lines this generic form
  // has nowhere to collect. Point at the screen that can, rather than letting
  // somebody save a headless one.
  if (meta.readOnlyRecord) {
    const BUILDER = { journal_entry: '/journal-new', recurring_journal: '/recurring/new' };
    if (BUILDER[type]) { go(BUILDER[type]); return h('div.page', loading('Opening the editor')); }
    return h('div.page', empty(`${meta.plural} are not created by hand`,
      `A ${meta.label.toLowerCase()} is raised by the process behind it, not entered directly.`));
  }

  const fm = store.fieldMap(type);
  await store.ensureRefs(Object.values(fm).map((f) => f.ref).filter(Boolean));

  const controls = {};
  const sections = groupFields(meta, fm, {}, { forEdit: true });
  const defaults = defaultsFor(type, route.query);

  const form = h('div.stack', ...sections
    .filter(([name]) => name !== SYSTEM_SECTION)
    .map(([name, fields]) => h('div.card',
      h('div.card-head', h('h2', name)),
      h('div.card-body', h('div.form-grid', ...fields.filter((f) => !f.readOnly).map((f) => {
        const ctl = fieldControl(f, defaults[f.name], null);
        controls[f.name] = ctl;
        return ctl.el;
      }))))));

  async function save(e) {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = 'Creating…';
    Object.values(controls).forEach((c) => c.setError(null));
    const payload = {}; const custom = {};
    for (const [name, ctl] of Object.entries(controls)) {
      const v = ctl.get();
      if (v === null || v === '' || v === undefined) continue;
      if (name.startsWith('custom.')) custom[name.slice(7)] = v;
      else payload[name] = v;
    }
    if (Object.keys(custom).length) payload.custom = custom;
    try {
      const created = await API.create(type, payload);
      store.invalidateRef(type);
      toast(`${meta.label} created`, { kind: 'success' });
      go(`/record/${type}/${created.id}`);
    } catch (err) {
      if (err.fields) {
        for (const [k, msg] of Object.entries(err.fields)) controls[k]?.setError(msg);
        toast(err.message, { kind: 'error', title: 'Check the highlighted fields' });
      } else notifyError(err);
      btn.disabled = false; btn.textContent = `Create ${meta.label.toLowerCase()}`;
    }
  }

  return h('div.page',
    h('div.page-head',
      h('div.titles',
        h('div.breadcrumb', h('a', { href: `#/list/${type}`, onclick: (e) => { e.preventDefault(); go(`/list/${type}`); } }, meta.plural)),
        h('h1', `New ${meta.label.toLowerCase()}`))),
    form,
    h('div.row', { style: { marginTop: '14px' } },
      h('button.btn.primary', { onclick: save }, `Create ${meta.label.toLowerCase()}`),
      h('button.btn', { onclick: () => go(`/list/${type}`) }, 'Cancel')));
}

function defaultsFor(type, query) {
  const d = {};
  // Nobody creates a record meaning it to be inactive. Applied from the
  // record's own description rather than by name, so a type invented this
  // morning gets it too.
  if ((store.state.meta.records?.[type]?.fields || []).some((f) => f.name === 'active')) d.active = 1;
  if (type === 'customer' || type === 'vendor') { d.status = 'active'; d.terms = 'NET30'; d.active = 1; }
  if (type === 'item') { d.type = 'inventory'; d.uom = 'EA'; d.taxable = 1; d.active = 1; d.costing_method = 'average'; }
  if (type === 'employee') { d.status = 'active'; d.employment_type = 'full_time'; d.pay_type = 'salary'; d.hire_date = fmt.today(); d.standard_hours = 40; }
  if (type === 'lead') { d.status = 'new'; d.rating = 'warm'; }
  if (type === 'opportunity') { d.stage = 'prospecting'; d.probability = 10; d.expected_close = fmt.addDays(fmt.today(), 30); }
  if (type === 'support_case') { d.priority = 'medium'; d.origin = 'email'; d.status = 'new'; }
  if (type === 'account') { d.type = 'ASSET'; d.active = 1; }
  if (type === 'time_entry') { d.entry_date = fmt.today(); d.status = 'draft'; }
  if (type === 'location' || type === 'department' || type === 'price_level') d.active = 1;
  for (const [k, v] of Object.entries(query || {})) d[k] = v;
  if (query.entity) d.entity_id = query.entity;
  return d;
}
