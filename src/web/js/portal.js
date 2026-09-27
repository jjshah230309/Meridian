// Meridian ERP :: web/portal
// The customer/vendor self-service SPA. Deliberately independent of
// store.js/ui.js/app.js -- those hold staff session state and metadata a
// portal user must never load, so this file only reuses the truly generic
// pieces (dom.js, format.js, icons.js, api.js's low-level request helpers).
import { h, mount, clear } from './dom.js';
import { icon } from './icons.js';
import * as fmt from './format.js';
import { get, post, setCsrf } from './api.js';

const root = document.getElementById('portal');
const P = '/api/v1/portal';
let session = null; // { email, entity_type, entity_id }

// --------------------------------------------------------------- helpers
// A small stand-in for ui.js's toast() -- same markup shape (`.toasts` host,
// `.toast` children) so app.css's existing rules style it identically,
// without pulling in ui.js's dependency on store.js.
let toastHost = null;
function toast(message, kind = 'info') {
  if (!toastHost) { toastHost = h('div.toasts'); document.body.appendChild(toastHost); }
  const el = h('div.toast', { class: kind }, h('div', { style: { minWidth: 0 } }, h('div.m', message)),
    h('button.x', { onclick: () => el.remove(), 'aria-label': 'Dismiss' }, '✕'));
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function errorMessage(e) { return e?.message || 'Something went wrong'; }

// ------------------------------------------------------------------ boot
async function boot() {
  try {
    const res = await get(`${P}/session`);
    session = res.user;
    setCsrf(res.csrf);
  } catch { session = null; }
  router();
  window.addEventListener('popstate', router);
}

function go(path) {
  window.history.pushState(null, '', path);
  router();
}

function router() {
  const path = window.location.pathname;
  const qs = new URLSearchParams(window.location.search);
  if (path === '/portal/accept') return renderAccept(qs.get('token') || '');
  if (!session) return renderLogin();
  if (path === '/portal/statement' && session.entity_type === 'customer') return renderStatement();
  const docMatch = /^\/portal\/document\/(.+)$/.exec(path);
  if (docMatch) return renderDocument(docMatch[1]);
  return renderDashboard();
}

// ----------------------------------------------------------------- login
function renderLogin() {
  const errBox = h('div.login-error.hidden');
  const email = h('input', { type: 'email', required: true, autocomplete: 'username' });
  const password = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  const submit = h('button.btn.primary.lg.block', { type: 'submit' }, 'Sign in');

  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      errBox.classList.add('hidden');
      submit.disabled = true; submit.textContent = 'Signing in…';
      try {
        const res = await post(`${P}/login`, { email: email.value.trim(), password: password.value });
        session = res.user; setCsrf(res.csrf);
        go('/portal');
      } catch (err) {
        clear(errBox);
        errBox.append(icon('x', { size: 14 }), h('span', errorMessage(err)));
        errBox.classList.remove('hidden');
        password.value = ''; password.focus();
      } finally { submit.disabled = false; submit.textContent = 'Sign in'; }
    },
  },
    errBox,
    h('div.field', h('label', 'Email'), email),
    h('div.field', h('label', 'Password'), password),
    submit);

  mount(root, h('div.login-wrap',
    h('div.login-card',
      h('div.login-head',
        h('div.login-brand', h('div.brand-mark', 'M'), h('div.login-title', 'Customer Portal')),
        h('div.login-sub', 'View and track your account')),
      h('div.login-body', form,
        h('div.login-foot', 'Invited but haven\'t set a password? Check your invitation email.')))));
}

function renderAccept(token) {
  if (!token) { mount(root, h('div.login-wrap', h('div.login-card', h('div.login-body', h('div.err', 'Missing invitation token.'))))); return; }
  const errBox = h('div.login-error.hidden');
  const password = h('input', { type: 'password', required: true, autocomplete: 'new-password' });
  const confirmPw = h('input', { type: 'password', required: true, autocomplete: 'new-password' });
  const submit = h('button.btn.primary.lg.block', { type: 'submit' }, 'Set password and sign in');

  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      errBox.classList.add('hidden');
      if (password.value !== confirmPw.value) {
        clear(errBox); errBox.append(h('span', 'Passwords do not match')); errBox.classList.remove('hidden'); return;
      }
      submit.disabled = true;
      try {
        const res = await post(`${P}/accept-invite`, { token, password: password.value });
        session = res.user; setCsrf(res.csrf);
        go('/portal');
      } catch (err) {
        clear(errBox); errBox.append(icon('x', { size: 14 }), h('span', errorMessage(err))); errBox.classList.remove('hidden');
      } finally { submit.disabled = false; }
    },
  },
    errBox,
    h('div.field', h('label', 'Choose a password'), password),
    h('div.field', h('label', 'Confirm password'), confirmPw),
    submit);

  mount(root, h('div.login-wrap',
    h('div.login-card',
      h('div.login-head', h('div.login-brand', h('div.brand-mark', 'M'), h('div.login-title', 'Welcome')),
        h('div.login-sub', 'Set a password to activate your account')),
      h('div.login-body', form))));
}

// -------------------------------------------------------------- shell
function shell(title, ...content) {
  const isCustomer = session.entity_type === 'customer';
  mount(root,
    h('div.topbar',
      h('div.login-brand', h('div.brand-mark', 'M'), h('span', { style: { fontWeight: 600 } }, isCustomer ? 'Customer Portal' : 'Vendor Portal')),
      h('div.spacer', { style: { flex: 1 } }),
      h('nav.row', { style: { gap: '12px' } },
        h('a', { href: '/portal', onclick: (e) => { e.preventDefault(); go('/portal'); } }, 'Documents'),
        isCustomer && h('a', { href: '/portal/statement', onclick: (e) => { e.preventDefault(); go('/portal/statement'); } }, 'Statement'),
        h('a', { href: '#', onclick: async (e) => { e.preventDefault(); await post(`${P}/logout`); session = null; go('/portal'); } }, 'Sign out'))),
    h('div.page', h('div.page-head', h('div.titles', h('h1', title))), ...content));
}

async function renderDashboard() {
  mount(root, h('div.login-wrap', h('div.spinner')));
  const isCustomer = session.entity_type === 'customer';
  let open = [], payments = [];
  try {
    [open, payments] = await Promise.all([
      get(`${P}/documents`, { kind: 'open' }).then((r) => r.documents),
      get(`${P}/documents`, { kind: 'payments' }).then((r) => r.documents),
    ]);
  } catch (e) { toast(errorMessage(e), 'error'); }

  const table = (rows, cols) => rows.length
    ? h('div.grid-wrap', h('table.grid',
      h('thead', h('tr', ...cols.map((c) => h('th', { class: c.num ? 'num' : '' }, c.label)))),
      h('tbody', ...rows.map((r) => h('tr.clickable', { onclick: () => go(`/portal/document/${r.id}`) },
        ...cols.map((c) => h('td', { class: c.num ? 'num' : '' }, c.render(r))))))))
    : h('div.muted', { style: { padding: '16px' } }, 'Nothing here yet.');

  shell(isCustomer ? 'Your invoices' : 'Your purchase orders and bills',
    h('div.card', { style: { marginBottom: '14px' } },
      h('div.card-head', h('h2', isCustomer ? 'Open invoices' : 'Open documents')),
      table(open, [
        { label: 'Document', render: (r) => h('span.mono', r.txn_no) },
        { label: 'Date', render: (r) => fmt.date(r.txn_date) },
        { label: 'Due', render: (r) => (r.due_date ? fmt.date(r.due_date) : '—') },
        { label: 'Status', render: (r) => fmt.titleCase(r.status) },
        { label: 'Total', num: true, render: (r) => fmt.money(r.total, r.currency) },
        { label: 'Balance', num: true, render: (r) => (r.amount_remaining ? h('strong', fmt.money(r.amount_remaining, r.currency)) : h('span.faint', '—')) },
      ])),
    h('div.card',
      h('div.card-head', h('h2', 'Payment history')),
      table(payments, [
        { label: 'Reference', render: (r) => h('span.mono', r.txn_no) },
        { label: 'Date', render: (r) => fmt.date(r.txn_date) },
        { label: 'Amount', num: true, render: (r) => fmt.money(r.total, r.currency) },
      ])));
}

async function payForDocument(id) {
  try {
    const checkout = await post(`${P}/documents/${id}/checkout`, {});
    if (checkout.provider === 'stripe') { window.location.href = checkout.redirect_url; return; }
    const ok = window.confirm(`Confirm a demo payment of ${fmt.money(checkout.amount, checkout.currency)}? No real money moves.`);
    if (!ok) return;
    await post(`/api/v1/payments/demo/${checkout.intent_id}/confirm`, {});
    toast('Payment recorded', 'success');
    renderDocument(id);
  } catch (e) { toast(errorMessage(e), 'error'); }
}

async function renderDocument(id) {
  mount(root, h('div.login-wrap', h('div.spinner')));
  let doc;
  try { doc = await get(`${P}/documents/${id}`); }
  catch (e) { shell('Document', h('div.err', errorMessage(e))); return; }
  const paidJustNow = new URLSearchParams(window.location.search).get('paid') === '1';

  shell(`${fmt.titleCase(doc.type.replace(/_/g, ' ').toLowerCase())} ${doc.txn_no}`,
    paidJustNow ? h('div.tag.green', { style: { marginBottom: '14px' } }, '✓ Payment received') : null,
    h('div.card', { style: { marginBottom: '14px' } },
      h('div.card-body', h('div.form-grid',
        h('div.field', h('label', 'Date'), fmt.date(doc.txn_date)),
        doc.due_date && h('div.field', h('label', 'Due'), fmt.date(doc.due_date)),
        h('div.field', h('label', 'Status'), fmt.titleCase(doc.status)),
        h('div.field', h('label', 'Total'), fmt.money(doc.total, doc.currency)),
        doc.amount_remaining ? h('div.field', h('label', 'Balance'), h('strong', fmt.money(doc.amount_remaining, doc.currency))) : null,
        doc.memo && h('div.field.full', h('label', 'Memo'), doc.memo))),
      doc.type === 'INVOICE' && doc.amount_remaining > 0 ? h('div.card-body', { style: { borderTop: '1px solid var(--border)' } },
        h('button.btn.primary', { onclick: () => payForDocument(id) }, icon('credit-card', { size: 13 }), `Pay ${fmt.money(doc.amount_remaining, doc.currency)}`)) : null),
    doc.lines?.length ? h('div.card',
      h('div.card-head', h('h2', 'Lines')),
      h('div.grid-wrap', h('table.grid',
        h('thead', h('tr', h('th', 'Description'), h('th.num', 'Qty'), h('th.num', 'Unit price'), h('th.num', 'Amount'))),
        h('tbody', ...doc.lines.map((l) => h('tr',
          h('td', l.description || ''),
          h('td.num', fmt.qty(l.quantity)),
          h('td.num', fmt.money(l.unit_price, doc.currency)),
          h('td.num', fmt.money(l.amount, doc.currency)))))))) : null,
    h('button.btn', { style: { marginTop: '14px' }, onclick: () => go('/portal') }, '← Back'));
}

async function renderStatement() {
  mount(root, h('div.login-wrap', h('div.spinner')));
  let s;
  try { s = await get(`${P}/statement`); }
  catch (e) { shell('Statement', h('div.err', errorMessage(e))); return; }

  shell('Statement',
    h('div.card', { style: { marginBottom: '14px' } },
      h('div.card-body', h('div.form-grid',
        h('div.field', h('label', 'Total outstanding'), h('strong', fmt.money(s.total, s.currency))),
        h('div.field', h('label', 'Overdue'), fmt.money(s.overdue, s.currency)),
        h('div.field', h('label', 'Oldest (days)'), String(s.oldest_days))))),
    h('div.card',
      h('div.card-head', h('h2', 'Open items')),
      h('div.grid-wrap', h('table.grid',
        h('thead', h('tr', h('th', 'Document'), h('th', 'Date'), h('th', 'Due'), h('th.num', 'Outstanding'))),
        h('tbody', ...(s.lines || []).map((i) => h('tr',
          h('td', h('span.mono', i.reference)),
          h('td', fmt.date(i.date)),
          h('td', i.due_date ? fmt.date(i.due_date) : '—'),
          h('td.num', fmt.money(i.outstanding, s.currency)))))))),
    h('a.btn', { href: `${P}/statement.pdf`, target: '_blank', style: { marginTop: '14px', display: 'inline-block' } }, icon('download', { size: 13 }), 'Download PDF'));
}

boot();
