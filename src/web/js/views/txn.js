// Meridian ERP :: web/views/txn
// Transaction viewer and line-item editor. One screen serves every document
// type; what differs between a quote and a vendor bill is driven by the
// type's metadata, not by a separate page.
import { h, mount, clear } from '../dom.js';
import { icon } from '../icons.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import * as store from '../store.js';
import { fieldControl, empty, toast, notifyError, confirm, modal, statusTag, facts, formatAddress, loading } from '../ui.js';

const TYPE_FOR_ROUTE = {
  quote: 'QUOTE', sales_order: 'SALES_ORDER', invoice: 'INVOICE', credit_memo: 'CREDIT_MEMO',
  purchase_order: 'PURCHASE_ORDER', vendor_bill: 'VENDOR_BILL', item_receipt: 'ITEM_RECEIPT',
  fulfillment: 'FULFILLMENT', inventory_adjustment: 'INVENTORY_ADJUSTMENT',
};
const ROUTE_FOR_TYPE = Object.fromEntries(Object.entries(TYPE_FOR_ROUTE).map(([k, v]) => [v, k]));

// =============================================================== viewer
export async function txnView(route, { go }) {
  const id = route.parts[1];
  const t = await API.txn(id);
  const cfg = store.state.meta.txn_types[t.type] || {};
  const permType = ROUTE_FOR_TYPE[t.type] || 'invoice';
  await store.ensureRefs(['customer', 'vendor', 'item', 'location', 'employee', 'account']);

  const refresh = async () => { go(`/txn/${id}`); const el = await txnView(route, { go }); mount(document.getElementById('main'), el); };

  const entityName = t.entity?.name || '—';
  const isPayment = ['CUSTOMER_PAYMENT', 'VENDOR_PAYMENT'].includes(t.type);

  const actions = [];
  const canFull = store.can(permType, store.LEVEL.FULL);
  if (t.approval_status === 'pending' && canFull) {
    actions.push(h('button.btn.primary', { onclick: () => act('approve') }, '✓ Approve'));
    actions.push(h('button.btn.danger', { onclick: () => act('reject') }, 'Reject'));
  }
  for (const target of t.transforms || []) {
    const targetRoute = ROUTE_FOR_TYPE[target];
    if (targetRoute && !store.can(targetRoute, store.LEVEL.CREATE)) continue;
    actions.push(h('button.btn', { onclick: () => transformDialog(t, target, refresh) },
      `→ ${fmt.titleCase(target.replace(/_/g, ' ').toLowerCase())}`));
  }
  if (['INVOICE', 'VENDOR_BILL'].includes(t.type) && t.amount_remaining > 0 && store.can(t.type === 'INVOICE' ? 'customer_payment' : 'vendor_payment', store.LEVEL.CREATE)) {
    actions.push(h('button.btn.primary', {
      onclick: async () => {
        const { paymentModal } = await import('./record.js');
        paymentModal(t.entity_type, t.entity, refresh);
      },
    }, t.type === 'INVOICE' ? 'Receive payment' : 'Pay bill'));
  }
  if (!t.posted && !['voided', 'closed', 'cancelled'].includes(t.status) && store.can(permType, store.LEVEL.EDIT)) {
    actions.push(h('button.btn', { onclick: () => go(`/txn-edit/${permType}/${t.id}`) }, 'Edit'));
  }
  if (t.status !== 'voided' && canFull) {
    actions.push(h('button.btn.danger', { onclick: () => voidDialog(t, refresh) }, 'Void'));
  }
  actions.push(h('button.btn', { onclick: () => window.print(), class: 'no-print' }, icon('printer', { size: 13 }), 'Print'));

  async function act(kind) {
    try {
      if (kind === 'approve') { await API.approve(t.id, {}); toast('Approved and posted', { kind: 'success' }); }
      else {
        const reason = await promptText('Reject this document', 'Reason (visible in the audit trail)');
        if (reason === null) return;
        await API.reject(t.id, { reason });
        toast('Rejected', { kind: 'success' });
      }
      refresh();
    } catch (e) { notifyError(e); }
  }

  const lineCols = isPayment ? null : lineColumnsFor(t.type);

  return h('div.page',
    h('div.page-head',
      h('div.titles',
        h('div.breadcrumb',
          h('a', { href: `#/list/${permType}`, onclick: (e) => { e.preventDefault(); go(`/list/${permType}`); } }, cfg.label + 's')),
        h('h1', `${cfg.label || t.type} ${t.txn_no}`, statusTag(t.status),
          t.approval_status === 'pending' ? h('span.tag.amber', 'Awaiting approval') : null,
          t.posted ? h('span.tag.green', 'Posted') : h('span.tag', 'Not posted')),
        h('div.page-sub', `${entityName} · ${fmt.date(t.txn_date)}${t.reference ? ' · ref ' + t.reference : ''}`)),
      h('div.page-actions', ...actions)),

    h('div.split',
      h('div.stack',
        // ---- header details
        h('div.card',
          h('div.card-head', h('h2', 'Details')),
          h('div.card-body', h('div.form-grid',
            detail('Document', h('span.mono', t.txn_no)),
            detail(t.entity_type === 'vendor' ? 'Vendor' : 'Customer', t.entity_id
              ? h('a', { href: `#/record/${t.entity_type}/${t.entity_id}`, onclick: (e) => { e.preventDefault(); go(`/record/${t.entity_type}/${t.entity_id}`); } }, entityName)
              : '—'),
            detail('Date', fmt.date(t.txn_date)),
            t.due_date && detail('Due', h('span', { class: t.amount_remaining > 0 && new Date(t.due_date) < new Date() ? 'num-neg' : '' }, fmt.date(t.due_date))),
            detail('Terms', fmt.titleCase(t.terms)),
            detail('Currency', t.currency + (t.fx_rate !== 1 ? ` @ ${t.fx_rate.toFixed(4)}` : '')),
            t.location_id && detail('Location', store.refLabelSync('location', t.location_id)),
            t.sales_rep_id && detail('Sales rep', store.refLabelSync('employee', t.sales_rep_id)),
            t.tracking_no && detail('Tracking', t.tracking_no),
            t.memo && detail('Memo', t.memo))),
          (t.billing_address?.line1 || t.shipping_address?.line1) && h('div.card-body', { style: { borderTop: '1px solid var(--border)' } },
            h('div.form-grid',
              t.billing_address?.line1 && detail('Bill to', formatAddress(t.billing_address)),
              t.shipping_address?.line1 && detail('Ship to', formatAddress(t.shipping_address))))),

        // ---- lines
        !isPayment && t.lines?.length ? h('div.card',
          h('div.card-head', h('h2', 'Lines'), h('span.muted', { style: { fontSize: '12px' } }, `${t.lines.length}`)),
          h('div.grid-wrap', h('table.grid',
            h('thead', h('tr', ...lineCols.map((c) => h('th', { class: c.num ? 'num' : '' }, c.label)))),
            h('tbody', ...t.lines.map((l) => h('tr', ...lineCols.map((c) => h('td', { class: c.num ? 'num' : '' }, c.render(l, t)))))))))
          : null,

        // ---- applications / links
        (t.links_out?.length || t.links_in?.length) ? h('div.card',
          h('div.card-head', h('h2', 'Related documents')),
          h('div.grid-wrap', h('table.grid.compact',
            h('thead', h('tr', h('th', 'Relationship'), h('th', 'Document'), h('th', 'Date'), h('th', 'Status'), h('th.num', 'Amount'), h('th', ''))),
            h('tbody',
              ...(t.links_out || []).map((l) => h('tr.clickable', { onclick: () => go(`/txn/${l.to_txn_id}`) },
                h('td.muted', fmt.titleCase(l.link_type)),
                h('td', h('span.mono', l.to_no), ' ', h('span.muted', fmt.titleCase(l.to_type.replace(/_/g, ' ').toLowerCase()))),
                h('td', fmt.date(l.to_date)),
                h('td', statusTag(l.to_status)),
                h('td.num', fmt.money(l.amount || l.to_total, t.currency)),
                h('td', ''))),
              ...(t.links_in || []).map((l) => h('tr.clickable', { onclick: () => go(`/txn/${l.from_txn_id}`) },
                h('td.muted', `${fmt.titleCase(l.link_type)} by`),
                h('td', h('span.mono', l.from_no), ' ', h('span.muted', fmt.titleCase(l.from_type.replace(/_/g, ' ').toLowerCase()))),
                h('td', fmt.date(l.from_date)),
                h('td', statusTag(l.from_status)),
                h('td.num', fmt.money(l.amount || l.from_total, t.currency)),
                h('td', l.link_type === 'applied' && store.can(permType, store.LEVEL.FULL)
                  ? h('button.btn.sm.ghost', {
                    onclick: async (e) => {
                      e.stopPropagation();
                      if (!await confirm({ title: 'Remove this application?', message: `${fmt.money(l.amount, t.currency)} will be released back to ${l.from_no}.`, confirmLabel: 'Unapply', danger: true })) return;
                      try { await API.unapply(l.from_txn_id, t.id); toast('Application removed', { kind: 'success' }); refresh(); }
                      catch (err) { notifyError(err); }
                    },
                  }, 'Unapply') : ''))))))) : null,

        // ---- GL impact
        t.journal ? h('div.card',
          h('div.card-head', h('h2', 'General ledger impact'),
            h('div.actions', h('button.btn.sm', { onclick: () => go(`/journal/${t.journal.id}`) }, `Entry ${t.journal.entry_no}`))),
          h('div.grid-wrap', h('table.grid.compact',
            h('thead', h('tr', h('th', 'Account'), h('th', 'Memo'), h('th.num', 'Debit'), h('th.num', 'Credit'))),
            h('tbody', ...t.journal.lines.map((l) => h('tr',
              h('td', h('span.mono', l.account_number), ' ', l.account_name),
              h('td.muted', l.memo || ''),
              h('td.num', l.base_debit ? fmt.money(l.base_debit) : ''),
              h('td.num', l.base_credit ? fmt.money(l.base_credit) : '')))),
            h('tfoot', h('tr',
              h('td', { colspan: 2 }, 'Total'),
              h('td.num', fmt.money(t.journal.total_debit)),
              h('td.num', fmt.money(t.journal.total_credit))))))) : null),

      // ---- right rail
      h('div.stack',
        h('div.card',
          h('div.card-head', h('h2', 'Amounts')),
          h('div.card-body', facts([
            !isPayment && ['Subtotal', fmt.money(t.subtotal, t.currency)],
            !isPayment && t.discount_total ? ['Discount', h('span.num-neg', '−' + fmt.money(t.discount_total, t.currency))] : null,
            !isPayment && t.shipping_total ? ['Shipping', fmt.money(t.shipping_total, t.currency)] : null,
            !isPayment && t.tax_total ? ['Tax', fmt.money(t.tax_total, t.currency)] : null,
            ['Total', h('strong', { style: { fontSize: '14px' } }, fmt.money(t.total, t.currency))],
            (t.amount_applied || t.amount_remaining) ? ['Applied', fmt.money(t.amount_applied, t.currency)] : null,
            (t.amount_remaining > 0) ? ['Outstanding', h('strong', { class: 'num-neg' }, fmt.money(t.amount_remaining, t.currency))] : null,
            t.currency !== store.state.tenant.base_currency ? [`In ${store.state.tenant.base_currency}`, fmt.money(t.base_total)] : null,
          ].filter(Boolean)))),
        progressCard(t),
        h('div.card',
          h('div.card-head', h('h2', 'Record')),
          h('div.card-body', facts([
            ['Created', fmt.dateTime(t.created_at)],
            ['Last updated', fmt.dateTime(t.updated_at)],
            t.approved_at ? ['Approved', fmt.dateTime(t.approved_at)] : null,
            ['Posted', t.posted ? h('span.tag.green', 'Yes') : h('span.tag', 'No')],
          ].filter(Boolean)))))));
}

const detail = (label, value) => value === null || value === undefined || value === false
  ? null
  : h('div.field', h('label', label), h('div', { style: { paddingTop: '2px' } }, value instanceof Node ? value : String(value)));

function progressCard(t) {
  if (!['SALES_ORDER', 'PURCHASE_ORDER'].includes(t.type) || !t.lines?.length) return null;
  const totalQty = t.lines.reduce((a, l) => a + l.quantity, 0) || 1;
  const shipped = t.lines.reduce((a, l) => a + (t.type === 'SALES_ORDER' ? l.qty_fulfilled : l.qty_received), 0);
  const billed = t.lines.reduce((a, l) => a + l.qty_billed, 0);
  const bar = (label, value) => h('div', { style: { marginBottom: '9px' } },
    h('div.row', { style: { justifyContent: 'space-between', fontSize: '12px', marginBottom: '3px' } },
      h('span.muted', label), h('span', `${Math.round((value / totalQty) * 100)}%`)),
    h('div.progress', h('i', { style: { width: `${Math.min(100, (value / totalQty) * 100)}%` } })));
  return h('div.card',
    h('div.card-head', h('h2', 'Progress')),
    h('div.card-body',
      bar(t.type === 'SALES_ORDER' ? 'Fulfilled' : 'Received', shipped),
      bar('Billed', billed)));
}

function lineColumnsFor(type) {
  const isPurchase = ['PURCHASE_ORDER', 'ITEM_RECEIPT', 'VENDOR_BILL'].includes(type);
  const cols = [
    { label: '#', render: (l) => h('span.faint', String(l.line_no)) },
    { label: 'Item', render: (l) => (l.item_id
      ? h('a', { href: `#/record/item/${l.item_id}`, onclick: (e) => { e.preventDefault(); window.__meridianGo(`/record/item/${l.item_id}`); } }, l.sku || 'Item')
      : h('span.muted', l.account_number ? `${l.account_number} ${l.account_name}` : '—')) },
    { label: 'Description', render: (l) => h('span.cell-truncate', l.description || '') },
    { label: 'Qty', num: true, render: (l) => fmt.qty(l.quantity) },
  ];
  if (type !== 'FULFILLMENT' && type !== 'ITEM_RECEIPT') {
    cols.push({ label: isPurchase ? 'Cost' : 'Price', num: true, render: (l, t) => fmt.money(l.unit_price, t.currency) });
    cols.push({ label: 'Disc', num: true, render: (l) => (l.discount_pct ? fmt.pct(l.discount_pct, 0) : h('span.faint', '—')) });
    cols.push({ label: 'Tax', num: true, render: (l, t) => (l.tax_amount ? fmt.money(l.tax_amount, t.currency) : h('span.faint', '—')) });
    cols.push({ label: 'Amount', num: true, render: (l, t) => h('strong', fmt.money(l.amount, t.currency)) });
  }
  if (type === 'SALES_ORDER') {
    cols.push({ label: 'Shipped', num: true, render: (l) => fmt.qty(l.qty_fulfilled) });
    cols.push({ label: 'Billed', num: true, render: (l) => fmt.qty(l.qty_billed) });
  }
  if (type === 'PURCHASE_ORDER') {
    cols.push({ label: 'Received', num: true, render: (l) => fmt.qty(l.qty_received) });
    cols.push({ label: 'Billed', num: true, render: (l) => fmt.qty(l.qty_billed) });
  }
  return cols;
}

// ------------------------------------------------------- transformation
async function transformDialog(source, target, onDone) {
  const preview = await API.transformPreview(source.id, target);
  const cfg = store.state.meta.txn_types[target];
  const dateInput = h('input', { type: 'date', value: fmt.today() });
  const trackingInput = h('input', { type: 'text', placeholder: 'Tracking number' });
  const rows = preview.lines.map((l) => {
    const qty = h('input', { type: 'number', step: 'any', class: 'num', value: (l.quantity / 1e6), style: { width: '92px' } });
    return { line: l, qty };
  });

  if (!rows.length) {
    toast(`Nothing remains on ${source.txn_no} to turn into a ${cfg.label.toLowerCase()}.`, { kind: 'warn' });
    return;
  }

  modal({
    title: `${source.txn_no} → ${cfg.label}`, size: 'wide',
    body: h('div',
      h('div.form-grid', { style: { marginBottom: '14px' } },
        h('div.field', h('label', 'Date'), dateInput),
        target === 'FULFILLMENT' && h('div.field', h('label', 'Tracking number'), trackingInput)),
      h('table.grid.compact',
        h('thead', h('tr', h('th', 'Item'), h('th', 'Description'), h('th.num', 'Ordered'), h('th.num', 'Already'), h('th.num', 'This document'))),
        h('tbody', ...rows.map((r) => h('tr',
          h('td', h('span.mono', r.line.sku || '—')),
          h('td', h('span.cell-truncate', r.line.description)),
          h('td.num', fmt.qty(r.line.ordered)),
          h('td.num.muted', fmt.qty(r.line.already)),
          h('td', r.qty)))))),
    actions: [
      { label: 'Cancel', value: null },
      {
        label: `Create ${cfg.label.toLowerCase()}`, kind: 'primary',
        onClick: async () => {
          const lines = rows
            .map((r) => ({ source_line_id: r.line.source_line_id, quantity: Number(r.qty.value || 0) }))
            .filter((l) => l.quantity > 0);
          if (!lines.length) { toast('Enter a quantity on at least one line', { kind: 'warn' }); return false; }
          const created = await API.transform(source.id, target, {
            txn_date: dateInput.value, lines,
            tracking_no: trackingInput.value || undefined,
          });
          toast(`${cfg.label} ${created.txn_no} created`, { kind: 'success' });
          window.__meridianGo(`/txn/${created.id}`);
        },
      },
    ],
  });
}

async function voidDialog(t, onDone) {
  const reason = await promptText(`Void ${t.txn_no}?`,
    'Reason (recorded in the audit trail)',
    t.posted ? 'Its journal entry will be reversed and any stock movement undone. The document itself is kept for the audit trail.' : null);
  if (reason === null) return;
  try {
    await API.voidTxn(t.id, { reason });
    toast(`${t.txn_no} voided`, { kind: 'success' });
    onDone();
  } catch (e) { notifyError(e); }
}

function promptText(title, label, detail) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', placeholder: label });
    let done = false;
    modal({
      title, size: 'narrow',
      body: h('div', detail && h('div.muted', { style: { marginBottom: '10px' } }, detail), h('div.field', h('label', label), input)),
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Confirm', kind: 'primary', onClick: () => { done = true; resolve(input.value); } },
      ],
      onClose: () => { if (!done) resolve(null); },
    });
  });
}

// =============================================================== editor
export async function txnEditor(route, { go }) {
  const editing = route.parts[0] === 'txn-edit';
  const permType = route.parts[1];
  const existingId = editing ? route.parts[2] : null;
  const txnType = TYPE_FOR_ROUTE[permType];
  const meta = store.metaFor(permType);
  if (!txnType || !meta) return h('div.page', empty('Unknown document type', permType));
  if (!store.can(permType, editing ? store.LEVEL.EDIT : store.LEVEL.CREATE)) {
    return h('div.page', empty('Not permitted', `Your role cannot ${editing ? 'edit' : 'create'} ${meta.plural.toLowerCase()}.`));
  }

  const cfg = store.state.meta.txn_types[txnType];
  const entityType = cfg.entity;
  const isPurchase = cfg.direction < 0;

  const existing = existingId ? await API.txn(existingId) : null;
  await store.ensureRefs([entityType, 'item', 'location', 'department', 'employee', 'account'].filter(Boolean));
  const itemOptions = entityType ? await store.refOptions('item') : [];

  // Recognition schedules only apply to the two documents that create them,
  // and only if somebody has set a template up. Everywhere else the control
  // is simply absent rather than present and inert.
  const scheduleKind = txnType === 'INVOICE' ? 'revenue' : txnType === 'VENDOR_BILL' ? 'expense' : null;
  const scheduleTemplates = scheduleKind && store.can('schedule_template')
    ? ((await API.list('schedule_template', { limit: 200, sort: 'name ASC' }).catch(() => ({ rows: [] }))).rows || [])
      .filter((t) => t.kind === scheduleKind && t.active)
    : [];
  // The shared reference cache carries only enough of an item to label it, so
  // the default each item brings is fetched here rather than guessed at.
  const itemDefaultTemplate = new Map();
  if (scheduleTemplates.length) {
    const col = scheduleKind === 'revenue' ? 'revenue_template_id' : 'expense_template_id';
    const res = await API.list('item', { limit: 1000, columns: `id,${col}` }).catch(() => ({ rows: [] }));
    for (const r of res.rows || []) if (r[col]) itemDefaultTemplate.set(r.id, r[col]);
  }

  // ---- header controls
  const model = {
    entity_id: existing?.entity_id || route.query.entity || '',
    txn_date: existing?.txn_date || fmt.today(),
    location_id: existing?.location_id || store.state.meta.locations?.[0]?.id || '',
    terms: existing?.terms || 'NET30',
    memo: existing?.memo || '',
    reference: existing?.reference || '',
    currency: existing?.currency || store.state.tenant.base_currency,
    shipping_total: existing ? existing.shipping_total / 100 : 0,
    discount_total: existing ? existing.discount_total / 100 : 0,
  };

  const controls = {};
  const headerFields = [
    entityType && { name: 'entity_id', label: entityType === 'vendor' ? 'Vendor' : 'Customer', type: 'reference', ref: entityType, required: true },
    { name: 'txn_date', label: 'Date', type: 'date', required: true },
    store.state.meta.locations?.length > 1 && { name: 'location_id', label: 'Location', type: 'reference', ref: 'location' },
    ['INVOICE', 'VENDOR_BILL', 'SALES_ORDER', 'PURCHASE_ORDER', 'QUOTE'].includes(txnType)
      && { name: 'terms', label: 'Terms', type: 'select', options: ['DUE_ON_RECEIPT', 'NET7', 'NET15', 'NET30', 'NET45', 'NET60', 'NET90'] },
    { name: 'reference', label: 'Reference', type: 'text' },
    { name: 'memo', label: 'Memo', type: 'text', full: true },
  ].filter(Boolean);

  const headerHost = h('div.form-grid');
  for (const f of headerFields) {
    const ctl = fieldControl(f, model[f.name], (v) => { model[f.name] = v; if (f.name === 'entity_id') onEntityChange(v); });
    controls[f.name] = ctl;
    headerHost.appendChild(ctl.el);
  }

  async function onEntityChange(id) {
    if (!id || !entityType) return;
    try {
      const { record } = await API.record(entityType, id);
      if (record.terms && controls.terms) { controls.terms.set(record.terms); model.terms = record.terms; }
      model.currency = record.currency;
      currencyLabel.textContent = record.currency;
      if (entityType === 'customer') creditNote(record);
      recalcAll();
    } catch { /* entity lookup is advisory */ }
  }

  const creditBox = h('div');
  async function creditNote(customer) {
    clear(creditBox);
    if (!customer.credit_limit && !customer.credit_hold) return;
    try {
      const f = await fetch(`/api/v1/entities/customer/${customer.id}/credit`, { credentials: 'same-origin' }).then((r) => r.json());
      if (customer.credit_hold) creditBox.appendChild(h('div.tag.red', { style: { marginTop: '8px' } }, `${customer.name} is on credit hold`));
      else if (f.over_limit) creditBox.appendChild(h('div.tag.amber', { style: { marginTop: '8px' } }, `Over credit limit — exposure ${fmt.money(f.exposure, customer.currency)} of ${fmt.money(f.credit_limit, customer.currency)}`));
      else if (f.credit_limit) creditBox.appendChild(h('div.muted', { style: { marginTop: '8px', fontSize: '12px' } }, `Credit available: ${fmt.money(f.credit_available, customer.currency)} of ${fmt.money(f.credit_limit, customer.currency)}`));
    } catch { /* advisory only */ }
  }

  // ---- line editor
  const linesBody = h('tbody');
  const currencyLabel = h('span.muted', model.currency);
  let lines = (existing?.lines || []).map((l) => ({
    item_id: l.item_id, account_id: l.account_id, description: l.description,
    quantity: l.quantity / 1e6, unit_price: l.unit_price / 100, discount_pct: l.discount_pct, tax_code: l.tax_code,
    schedule_template_id: l.schedule_template_id || '', service_start: l.service_start || '', service_end: l.service_end || '',
  }));
  if (!lines.length) lines = [blankLine()];

  function blankLine() { return { item_id: '', description: '', quantity: 1, unit_price: 0, discount_pct: 0, tax_code: '', schedule_template_id: '', service_start: '', service_end: '' }; }

  const totalsHost = h('div.totals-box');

  function recalcAll() {
    let subtotal = 0, tax = 0;
    for (const l of lines) {
      const gross = (Number(l.quantity) || 0) * (Number(l.unit_price) || 0);
      const disc = gross * ((Number(l.discount_pct) || 0) / 100);
      const amount = gross - disc;
      l._amount = amount;
      subtotal += amount;
      const rate = (store.state.meta.tax_codes.find((tc) => tc.code === l.tax_code)?.rate) || 0;
      l._tax = amount * (rate / 100);
      tax += l._tax;
    }
    const shipping = Number(model.shipping_total) || 0;
    const headerDiscount = Number(model.discount_total) || 0;
    const total = subtotal - headerDiscount + tax + shipping;

    for (const [i, l] of lines.entries()) {
      const cell = linesBody.querySelector(`tr[data-i="${i}"] .amount-cell`);
      if (cell) cell.textContent = fmt.money(Math.round(l._amount * 100), model.currency);
    }
    mount(totalsHost, facts([
      ['Subtotal', fmt.money(Math.round(subtotal * 100), model.currency)],
      ['Discount', discountInput],
      ['Shipping', shippingInput],
      tax ? ['Tax', fmt.money(Math.round(tax * 100), model.currency)] : null,
      ['Total', h('strong', { style: { fontSize: '15px' } }, fmt.money(Math.round(total * 100), model.currency))],
    ].filter(Boolean)));
  }

  const discountInput = h('input', { type: 'number', step: '0.01', class: 'num', style: { width: '110px' }, value: model.discount_total, oninput: (e) => { model.discount_total = e.target.value; recalcAll(); } });
  const shippingInput = h('input', { type: 'number', step: '0.01', class: 'num', style: { width: '110px' }, value: model.shipping_total, oninput: (e) => { model.shipping_total = e.target.value; recalcAll(); } });

  function drawLines() {
    clear(linesBody);
    lines.forEach((l, i) => {
      const itemSel = h('select', { onchange: async (e) => { l.item_id = e.target.value; await autofillLine(l, i); } },
        h('option', { value: '' }, '— choose item —'),
        ...itemOptions.map((o) => h('option', { value: o.value, selected: o.value === l.item_id }, o.label)));
      const desc = h('input', { type: 'text', value: l.description || '', oninput: (e) => { l.description = e.target.value; } });
      const qty = h('input', { type: 'number', step: 'any', class: 'num', value: l.quantity, oninput: (e) => { l.quantity = e.target.value; recalcAll(); } });
      const price = h('input', { type: 'number', step: '0.01', class: 'num', value: l.unit_price, oninput: (e) => { l.unit_price = e.target.value; recalcAll(); } });
      const disc = h('input', { type: 'number', step: '0.1', class: 'num', value: l.discount_pct || 0, oninput: (e) => { l.discount_pct = e.target.value; recalcAll(); } });
      const taxSel = h('select', { onchange: (e) => { l.tax_code = e.target.value; recalcAll(); } },
        h('option', { value: '' }, '—'),
        ...store.state.meta.tax_codes.map((tc) => h('option', { value: tc.code, selected: tc.code === l.tax_code }, `${tc.code} (${tc.rate}%)`)));

      linesBody.appendChild(h('tr', { dataset: { i } },
        h('td', { style: { width: '34px' } }, h('span.faint', String(i + 1))),
        h('td', { style: { minWidth: '210px' } }, itemSel),
        h('td', { style: { minWidth: '190px' } }, desc),
        h('td', { style: { width: '92px' } }, qty),
        h('td', { style: { width: '110px' } }, price),
        h('td', { style: { width: '78px' } }, disc),
        h('td', { style: { width: '112px' } }, taxSel),
        h('td.calc.amount-cell', { style: { width: '118px' } }, fmt.money(Math.round((l._amount || 0) * 100), model.currency)),
        scheduleTemplates.length ? h('td', { style: { width: '32px' } }, scheduleButton(l, i)) : null,
        h('td', { style: { width: '30px' } }, h('button.rm', {
          title: 'Remove line',
          onclick: () => { lines.splice(i, 1); if (!lines.length) lines.push(blankLine()); drawLines(); recalcAll(); },
        }, icon('x', { size: 13 })))));
    });
  }

  /**
   * Per-line schedule, behind a button rather than three more columns: most
   * lines never need it, and the ones that do are set once. The button says
   * what is in force, including the default the item brings with it.
   */
  function scheduleButton(l, i) {
    const inherited = itemDefaultTemplate.get(l.item_id) || '';
    const effective = l.schedule_template_id || inherited;
    const tmpl = scheduleTemplates.find((t) => t.id === effective);
    const explicit = !!l.schedule_template_id;
    const label = tmpl
      ? `${tmpl.name}${explicit ? '' : ' (from the item)'}${l.service_start ? ` · ${l.service_start} → ${l.service_end || '—'}` : ''}`
      : 'No schedule — recognised in full when this posts';
    return h('button.btn.sm', {
      class: tmpl ? 'accent' : '',
      title: label,
      style: { padding: '2px 6px', lineHeight: '1.1' },
      onclick: () => scheduleDialog(l, i),
    }, tmpl ? '⧗' : '·');
  }

  function scheduleDialog(l, i) {
    const inherited = itemDefaultTemplate.get(l.item_id) || '';
    const inheritedName = scheduleTemplates.find((t) => t.id === inherited)?.name;
    const sel = h('select',
      h('option', { value: '' }, inheritedName ? `Use the item's default — ${inheritedName}` : 'None — recognise in full'),
      ...scheduleTemplates.map((t) => h('option', { value: t.id, selected: t.id === l.schedule_template_id },
        `${t.name} · ${t.term_months} month${t.term_months === 1 ? '' : 's'}`)));
    const from = h('input', { type: 'date', value: l.service_start || '' });
    const to = h('input', { type: 'date', value: l.service_end || '' });
    modal({
      title: scheduleKind === 'revenue' ? `Revenue recognition — line ${i + 1}` : `Cost amortisation — line ${i + 1}`,
      body: h('div',
        h('p.muted', { style: { marginTop: 0 } }, scheduleKind === 'revenue'
          ? 'The revenue on this line is held in Deferred Revenue and released over the schedule.'
          : 'The cost on this line is held as a prepayment and expensed over the schedule.'),
        h('div.field', h('label', 'Schedule'), sel),
        h('div.form-grid', { style: { marginTop: '10px' } },
          h('div.field', h('label', 'Service starts'), from),
          h('div.field', h('label', 'Service ends'), to)),
        h('p.muted', { style: { fontSize: '11.5px' } },
          'Service dates are used when the schedule starts on the service period. Leave them empty to run from the document date.')),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Apply',
          kind: 'primary',
          onClick: (close) => {
            if (from.value && to.value && to.value < from.value) {
              toast('The service period ends before it starts.', { kind: 'warn' });
              return false;
            }
            l.schedule_template_id = sel.value || '';
            l.service_start = from.value || '';
            l.service_end = to.value || '';
            close(true);
            drawLines();
            recalcAll();
          },
        },
      ],
    });
  }

  async function autofillLine(l, i) {
    const opt = itemOptions.find((o) => o.value === l.item_id);
    if (!opt) return;
    l.description = opt.row.name || opt.row.description || '';
    try {
      if (isPurchase) {
        l.unit_price = (opt.row.purchase_price ?? opt.row.standard_cost ?? 0) / 100;
      } else {
        const q = await API.priceQuote({ item_id: l.item_id, customer_id: model.entity_id || undefined, quantity: Number(l.quantity) || 1, currency: model.currency });
        l.unit_price = q.unit_price / 100;
        l.discount_pct = q.discount_pct || 0;
        if (q.applied_rules?.length) toast(`Pricing rule applied: ${q.applied_rules.join(', ')}`, { kind: 'info', timeout: 3500 });
      }
      l.tax_code = opt.row.tax_code || '';
    } catch { /* fall back to the item's list price */ }
    drawLines();
    recalcAll();
  }

  drawLines();
  recalcAll();
  if (model.entity_id) onEntityChange(model.entity_id);

  async function save(e, andApprove = false) {
    const btn = e.currentTarget;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Saving…';
    Object.values(controls).forEach((c) => c.setError(null));
    const payload = {
      entity_id: model.entity_id || undefined,
      txn_date: controls.txn_date.get(),
      location_id: controls.location_id?.get() || undefined,
      terms: controls.terms?.get() || undefined,
      memo: controls.memo.get() || '',
      reference: controls.reference.get() || '',
      discount_total: Number(model.discount_total) || 0,
      shipping_total: Number(model.shipping_total) || 0,
      lines: lines.filter((l) => l.item_id || l.account_id).map((l) => ({
        item_id: l.item_id || undefined, account_id: l.account_id || undefined,
        description: l.description, quantity: Number(l.quantity) || 0,
        unit_price: Number(l.unit_price) || 0, discount_pct: Number(l.discount_pct) || 0,
        tax_code: l.tax_code || '',
        schedule_template_id: l.schedule_template_id || undefined,
        service_start: l.service_start || undefined,
        service_end: l.service_end || undefined,
      })),
    };
    if (!payload.lines.length) {
      toast('Add at least one line', { kind: 'warn' });
      btn.disabled = false; btn.textContent = original;
      return;
    }
    try {
      const saved = editing ? await API.update(permType, existingId, payload) : await API.create(permType, payload);
      toast(`${cfg.label} ${saved.txn_no} ${editing ? 'updated' : 'created'}`, { kind: 'success' });
      go(`/txn/${saved.id}`);
    } catch (err) {
      if (err.fields) {
        for (const [k, msg] of Object.entries(err.fields)) controls[k]?.setError(msg);
        toast(err.message, { kind: 'error', title: 'Check the highlighted fields' });
      } else notifyError(err);
      btn.disabled = false; btn.textContent = original;
    }
  }

  return h('div.page',
    h('div.page-head',
      h('div.titles',
        h('div.breadcrumb', h('a', { href: `#/list/${permType}`, onclick: (ev) => { ev.preventDefault(); go(`/list/${permType}`); } }, cfg.label + 's')),
        h('h1', editing ? `Edit ${cfg.label.toLowerCase()} ${existing.txn_no}` : `New ${cfg.label.toLowerCase()}`)),
      h('div.page-actions',
        h('button.btn', { onclick: () => go(editing ? `/txn/${existingId}` : `/list/${permType}`) }, 'Cancel'),
        h('button.btn.primary', { onclick: (ev) => save(ev) }, editing ? 'Save changes' : `Create ${cfg.label.toLowerCase()}`))),

    h('div.card', h('div.card-head', h('h2', 'Header')), h('div.card-body', headerHost, creditBox)),

    h('div.card', { style: { marginTop: '12px' } },
      h('div.card-head', h('h2', 'Lines'), h('span.muted', { style: { fontSize: '12px' } }, currencyLabel),
        h('div.actions', h('button.btn.sm', { onclick: () => { lines.push(blankLine()); drawLines(); recalcAll(); } }, icon('plus', { size: 13 }), 'Add line'))),
      h('div.grid-wrap',
        h('table.lines-table',
          h('thead', h('tr',
            h('th', ''), h('th', 'Item'), h('th', 'Description'), h('th', 'Qty'),
            h('th', isPurchase ? 'Unit cost' : 'Unit price'), h('th', 'Disc %'), h('th', 'Tax'),
            h('th', { style: { textAlign: 'right' } }, 'Amount'),
            scheduleTemplates.length ? h('th', { title: scheduleKind === 'revenue' ? 'Revenue recognition' : 'Cost amortisation' }, '⧗') : null,
            h('th', ''))),
          linesBody)),
      h('div.card-body', { style: { display: 'flex' } }, totalsHost)));
}
