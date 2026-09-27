// Meridian ERP :: web/pay
// A single, guest-facing page: view and pay one invoice from a signed link,
// no sign-in at all. The token in the URL is the entire credential -- see
// api_payments.mjs's guestInvoice() -- so this page never asks for one.
import { h, mount, clear } from './dom.js';
import { icon } from './icons.js';
import * as fmt from './format.js';
import { get, post } from './api.js';

const root = document.getElementById('pay');
const token = window.location.pathname.replace(/^\/pay\//, '');
const paidFlag = new URLSearchParams(window.location.search).get('paid') === '1';

function card(...content) {
  mount(root, h('div.login-wrap', h('div.login-card', { style: { maxWidth: '440px' } },
    h('div.login-head', h('div.login-brand', h('div.brand-mark', 'M'), h('div.login-title', 'Pay your invoice'))),
    h('div.login-body', ...content))));
}

async function boot() {
  if (!token) { card(h('div.err', 'Missing link.')); return; }
  let invoice;
  try { invoice = await get(`/api/v1/pay/${token}`); }
  catch (e) { card(h('div.err', e.message || 'This link is invalid or has expired.')); return; }

  if (paidFlag || invoice.amount_remaining <= 0) {
    card(
      h('div.tag.green', { style: { marginBottom: '10px' } }, '✓ Paid'),
      h('div', `Invoice ${invoice.txn_no} from ${invoice.company} is settled.`));
    return;
  }

  const payBtn = h('button.btn.primary.lg.block', { onclick: pay }, `Pay ${fmt.money(invoice.amount_remaining, invoice.currency)}`);
  const errBox = h('div.login-error.hidden');

  async function pay() {
    payBtn.disabled = true; payBtn.textContent = 'Starting checkout…';
    try {
      const checkout = await post(`/api/v1/pay/${token}/checkout`, {});
      if (checkout.provider === 'stripe') { window.location.href = checkout.redirect_url; return; }
      renderDemo(checkout);
    } catch (e) {
      clear(errBox); errBox.append(icon('x', { size: 14 }), h('span', e.message)); errBox.classList.remove('hidden');
      payBtn.disabled = false; payBtn.textContent = `Pay ${fmt.money(invoice.amount_remaining, invoice.currency)}`;
    }
  }

  function renderDemo(checkout) {
    card(
      h('div.tag.amber', { style: { marginBottom: '10px' } }, 'Demo mode — no money moves'),
      h('div', { style: { marginBottom: '14px' } }, `Confirm a demo payment of ${fmt.money(checkout.amount, checkout.currency)} for invoice ${checkout.invoice_no}?`),
      h('button.btn.primary.lg.block', {
        onclick: async (e) => {
          e.target.disabled = true; e.target.textContent = 'Confirming…';
          try {
            await post(`/api/v1/payments/demo/${checkout.intent_id}/confirm`, {});
            window.location.search = '?paid=1';
          } catch (err) { card(h('div.err', err.message)); }
        },
      }, 'Confirm demo payment'),
      h('button.btn.block', { style: { marginTop: '8px' }, onclick: () => window.location.reload() }, 'Cancel'));
  }

  card(
    h('div.form-grid', { style: { marginBottom: '14px' } },
      h('div.field', h('label', 'From'), invoice.company),
      h('div.field', h('label', 'Invoice'), h('span.mono', invoice.txn_no)),
      h('div.field', h('label', 'Due'), invoice.due_date ? fmt.date(invoice.due_date) : '—'),
      h('div.field', h('label', 'Amount due'), h('strong', fmt.money(invoice.amount_remaining, invoice.currency)))),
    errBox, payBtn);
}

boot();
