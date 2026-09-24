// Meridian ERP :: web/ui
// Shared interface pieces: toasts, modals, form fields, empty states,
// and the reference picker that every form and line editor uses.
import { h, mount, clear, $, safeSnippet } from './dom.js';
import { icon } from './icons.js';
import * as fmt from './format.js';
import { refOptions, metaFor, state } from './store.js';

// ---------------------------------------------------------------- toast
let toastHost = null;
export function toast(message, { kind = 'info', title = null, timeout = 5000 } = {}) {
  if (!toastHost) { toastHost = h('div.toasts'); document.body.appendChild(toastHost); }
  const el = h('div.toast', { class: kind },
    h('div', { style: { minWidth: 0 } },
      title && h('div.t', title),
      h('div.m', message)),
    h('button.x', { onclick: () => el.remove(), title: 'Dismiss', 'aria-label': 'Dismiss' }, '✕'));
  toastHost.appendChild(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}
export const notifyError = (e) => toast(e?.message || String(e), { kind: 'error', title: errTitle(e), timeout: 9000 });
const errTitle = (e) => ({
  VALIDATION_FAILED: 'Check the highlighted fields', FORBIDDEN: 'Not permitted',
  UNPROCESSABLE: 'Cannot complete that', CONFLICT: 'Conflict', RATE_LIMITED: 'Slow down',
}[e?.code] || 'Something went wrong');
export const notifyOk = (m, title) => toast(m, { kind: 'success', title });

// ----------------------------------------------------------------- menu
/**
 * A menu anchored to the control that opened it.
 *
 * Most of what used to be a dialog in this application -- the account menu,
 * the create list, a row's actions -- is a list of five things, and a list of
 * five things does not deserve a modal, an overlay and a decision. It deserves
 * to appear under the button, take one click, and go away.
 *
 * Items are descriptors: {label, icon, keys, sub, onClick, danger, checked,
 * disabled}, or {separator: true}, or {heading: 'text'}.
 */
export function anchoredMenu(anchor, items, { align = 'right', minWidth = null } = {}) {
  closeOpenMenu();
  const el = h('div.menu', { role: 'menu' });
  if (minWidth) el.style.minWidth = `${minWidth}px`;

  const close = () => {
    el.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDown, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('scroll', close, true);
    if (openMenu === close) openMenu = null;
    anchor?.classList?.remove('on');
  };
  const rows = [];
  for (const it of items.filter(Boolean)) {
    if (it.separator) { el.appendChild(h('div.menu-sep')); continue; }
    if (it.heading) { el.appendChild(h('div.menu-label', it.heading)); continue; }
    if (it.node) { el.appendChild(it.node); continue; }
    const row = h('button.menu-item', {
      class: it.danger ? 'danger' : '', role: 'menuitem', disabled: !!it.disabled,
      'aria-checked': it.checked === undefined ? null : String(!!it.checked),
      onclick: async (e) => {
        e.preventDefault();
        if (it.keepOpen !== true) close();
        try { await it.onClick?.(e); } catch (err) { notifyError(err); }
      },
    },
      it.icon ? icon(it.icon, { size: 16 }) : h('span', { style: { width: 'var(--s4)' } }),
      h('span', { style: { minWidth: 0 } }, it.label, it.sub && h('div.m-sub', it.sub)),
      it.checked ? icon('check', { size: 14, className: 'keys' }) : null,
      it.keys && h('span.keys', renderMenuKeys(it.keys)));
    rows.push(row);
    el.appendChild(row);
  }

  document.body.appendChild(el);
  // Measured after insertion: a menu's height depends on what is in it, and
  // guessing means the last item lands under the bottom of the window.
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, hgt = el.offsetHeight;
  const gap = 8;
  let left = align === 'left' ? r.left : r.right - w;
  left = Math.min(Math.max(8, left), Math.max(8, window.innerWidth - w - 8));
  let top = r.bottom + gap;
  if (top + hgt > window.innerHeight - 8) top = Math.max(8, r.top - gap - hgt);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  anchor?.classList?.add('on');

  let cursor = -1;
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); anchor?.focus?.(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const usable = rows.filter((x) => !x.disabled);
      if (!usable.length) return;
      cursor = (cursor + (e.key === 'ArrowDown' ? 1 : -1) + usable.length) % usable.length;
      usable[cursor].focus();
    }
  };
  // mousedown rather than click: a click that lands on a button behind the menu
  // would otherwise run that button as well as closing this.
  const onDown = (e) => { if (!el.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close(); };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
  window.addEventListener('resize', close);
  window.addEventListener('scroll', close, true);
  openMenu = close;
  return { close, el };
}

let openMenu = null;
export const closeOpenMenu = () => { openMenu?.(); };
/** Keys in a menu row, without pulling the shortcut module into every caller. */
const renderMenuKeys = (keys) => (window.__meridianRenderKeys ? window.__meridianRenderKeys(keys) : h('span.kbd', keys));

// ---------------------------------------------------------------- modal
export function modal({ title, body, actions = [], size = '', onClose = null, footLeft = null }) {
  const overlay = h('div.overlay');
  const close = (result) => { overlay.remove(); document.removeEventListener('keydown', onKey); onClose?.(result); };
  const onKey = (e) => { if (e.key === 'Escape') close(null); };
  document.addEventListener('keydown', onKey);

  const box = h('div.modal', { class: size },
    h('div.modal-head',
      h('h2', title),
      h('button.icon-btn', { onclick: () => close(null), title: 'Close', 'aria-label': 'Close' }, '✕')),
    h('div.modal-body', body),
    (actions.length || footLeft) && h('div.modal-foot',
      footLeft && h('div.left', footLeft),
      // An action is normally a descriptor, but a caller that hands over a
      // ready-made button gets it used as-is: passing an element used to
      // produce a blank, unlabelled button with no warning.
      ...actions.map((a) => (a instanceof Node ? a : h('button.btn', {
        class: a.kind || '', disabled: a.disabled,
        onclick: async (ev) => {
          const btn = ev.currentTarget;
          if (a.close !== false && !a.onClick) return close(a.value);
          btn.disabled = true;
          const prev = btn.textContent;
          btn.textContent = 'Working…';
          try { const r = await a.onClick(close); if (a.close !== false && r !== false) close(r); }
          catch (e) { notifyError(e); }
          finally { btn.disabled = false; btn.textContent = prev; }
        },
      }, a.label)))));

  overlay.appendChild(box);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
  document.body.appendChild(overlay);
  setTimeout(() => box.querySelector('input,select,textarea,button.primary')?.focus(), 30);
  return { close, box, overlay };
}

export function confirm({ title = 'Are you sure?', message, confirmLabel = 'Confirm', danger = false, detail = null }) {
  return new Promise((resolve) => {
    let settled = false;
    modal({
      title, size: 'narrow',
      body: h('div', h('div', message), detail && h('div.muted', { style: { marginTop: 'var(--s2)', fontSize: 'var(--t-sm)' } }, detail)),
      actions: [
        { label: 'Cancel', value: false },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: () => { settled = true; resolve(true); } },
      ],
      onClose: () => { if (!settled) resolve(false); },
    });
  });
}

/** Modal that collects values from a field list and resolves with them. */
export function formModal({ title, fields, values = {}, submitLabel = 'Save', size = '', onSubmit }) {
  const model = { ...values };
  const host = h('div.form-grid');
  const controls = {};
  for (const f of fields) {
    const ctl = fieldControl(f, model[f.name], (v) => { model[f.name] = v; f.onChange?.(v, model, controls); });
    controls[f.name] = ctl;
    host.appendChild(ctl.el);
  }
  const m = modal({
    title, body: host, size,
    actions: [
      { label: 'Cancel', value: null },
      {
        label: submitLabel, kind: 'primary',
        onClick: async (close) => {
          Object.values(controls).forEach((c) => c.setError(null));
          try { const r = await onSubmit(model, controls); close(r); }
          catch (e) {
            if (e.fields) {
              for (const [k, msg] of Object.entries(e.fields)) controls[k]?.setError(msg);
              toast(e.message, { kind: 'error', title: 'Check the highlighted fields' });
            } else notifyError(e);
            return false;
          }
        },
      },
    ],
  });
  return { modal: m, model, controls };
}

// --------------------------------------------------------------- fields
/**
 * Build a labelled control for one metadata field descriptor.
 * Returns { el, get, set, setError }.
 */
export function fieldControl(f, value, onChange) {
  const id = `f_${f.name}_${Math.random().toString(36).slice(2, 7)}`;
  const err = h('div.err.hidden');
  let input;
  const fire = () => onChange?.(get());

  const type = f.type || 'text';
  if (type === 'checkbox') {
    input = h('input', { type: 'checkbox', id, checked: !!value, disabled: f.readOnly, onchange: fire });
    const wrap = h('div.field.checkbox', input, h('label', { for: id }, f.label), err);
    return controlApi(wrap, input, err, f);
  }
  if (type === 'longtext') {
    input = h('textarea', { id, disabled: f.readOnly, oninput: fire }, '');
    input.value = value ?? '';
  } else if (type === 'select') {
    const opts = f.options || [];
    input = h('select', { id, disabled: f.readOnly, onchange: fire },
      h('option', { value: '' }, f.placeholder || '—'),
      ...opts.map((o) => {
        const val = typeof o === 'object' ? o.value : o;
        const lab = typeof o === 'object' ? o.label : fmt.titleCase(o);
        return h('option', { value: val, selected: String(value ?? '') === String(val) }, lab);
      }));
  } else if (type === 'reference') {
    input = h('select', { id, disabled: f.readOnly, onchange: fire }, h('option', { value: '' }, '—'));
    const refType = f.ref;
    if (refType) {
      refOptions(refType).then((opts) => {
        for (const o of opts) input.appendChild(h('option', { value: o.value, selected: o.value === value }, o.label));
        input.value = value ?? '';
      });
    }
  } else if (type === 'money' || type === 'number' || type === 'percent' || type === 'qty') {
    input = h('input', {
      id, type: 'number', class: 'num', disabled: f.readOnly,
      step: type === 'money' ? '0.01' : type === 'percent' ? '0.1' : 'any',
      oninput: fire,
    });
    input.value = value === null || value === undefined || value === '' ? '' : String(value);
  } else if (type === 'date') {
    input = h('input', { id, type: 'date', disabled: f.readOnly, onchange: fire });
    input.value = value ? String(value).slice(0, 10) : '';
  } else if (type === 'datetime') {
    input = h('input', { id, type: 'text', disabled: true });
    input.value = value ? fmt.dateTime(value) : '';
  } else if (type === 'json') {
    return addressControl(f, value, onChange);
  } else if (type === 'formula') {
    input = h('input', { id, type: 'text', class: 'mono', disabled: f.readOnly, placeholder: 'e.g. total > 10000', oninput: fire });
    input.value = value ?? '';
  } else {
    const inputType = type === 'email' ? 'email' : type === 'phone' ? 'tel' : type === 'url' ? 'url' : 'text';
    input = h('input', { id, type: inputType, disabled: f.readOnly, placeholder: f.placeholder || '', oninput: fire });
    input.value = value ?? '';
  }

  function get() {
    if (type === 'checkbox') return input.checked ? 1 : 0;
    if (['money', 'number', 'percent', 'qty'].includes(type)) return input.value === '' ? null : Number(input.value);
    return input.value === '' ? null : input.value;
  }

  const wrap = h('div.field', { class: f.full ? 'full' : '' },
    h('label', { for: id }, f.label, f.required && h('span.req', '*')),
    input,
    f.help && h('div.help', f.help),
    err);
  return controlApi(wrap, input, err, f, get);
}

function controlApi(wrap, input, err, f, getter) {
  return {
    el: wrap, input, field: f,
    get: getter || (() => (input.type === 'checkbox' ? (input.checked ? 1 : 0) : input.value)),
    set: (v) => { if (input.type === 'checkbox') input.checked = !!v; else input.value = v ?? ''; },
    setError: (msg) => {
      wrap.classList.toggle('invalid', !!msg);
      err.classList.toggle('hidden', !msg);
      err.textContent = msg || '';
    },
  };
}

/** Structured address editor for JSON address columns. */
function addressControl(f, value, onChange) {
  const v = (typeof value === 'object' && value) || {};
  const parts = f.subfields || ['line1', 'line2', 'city', 'state', 'postcode', 'country'];
  const inputs = {};
  const grid = h('div.address-grid');
  for (const p of parts) {
    const inp = h('input', {
      type: 'text', placeholder: fmt.titleCase(p), disabled: f.readOnly,
      oninput: () => onChange?.(get()),
    });
    inp.value = v[p] ?? '';
    inputs[p] = inp;
    grid.appendChild(h('div', { class: p === 'line1' || p === 'line2' ? 'address-span' : '' }, inp));
  }
  const get = () => Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value]).filter(([, x]) => x));
  const err = h('div.err.hidden');
  const wrap = h('div.field.full', h('label', f.label), grid, err);
  return {
    el: wrap, field: f, get,
    set: (val) => { for (const [k, i] of Object.entries(inputs)) i.value = (val || {})[k] ?? ''; },
    setError: (msg) => { wrap.classList.toggle('invalid', !!msg); err.classList.toggle('hidden', !msg); err.textContent = msg || ''; },
  };
}

// -------------------------------------------------------------- display
/** Render a stored value for reading, given its field descriptor. */
export function displayValue(f, value, row) {
  if (value === null || value === undefined || value === '') return h('span.faint', '—');
  switch (f.type) {
    case 'money': return h('span.nowrap', fmt.money(value, row?.currency || fmt.getBaseCurrency()));
    case 'qty': return h('span', fmt.qty(value));
    case 'percent': return h('span', fmt.pct(value));
    case 'number': return h('span', fmt.num(value, Number.isInteger(value) ? 0 : 2));
    case 'date': return h('span.nowrap', fmt.date(value));
    case 'datetime': return h('span.nowrap', { title: value }, fmt.dateTime(value));
    case 'checkbox': return value ? h('span.tag.green', 'Yes') : h('span.faint', 'No');
    case 'reference': return h('span', refDisplay(f, value, row));
    case 'email': return h('a', { href: `mailto:${value}` }, value);
    case 'url': return h('a', { href: value, target: '_blank', rel: 'noreferrer noopener' }, String(value).replace(/^https?:\/\//, ''));
    case 'phone': return h('a', { href: `tel:${value}` }, value);
    case 'json': return h('span.muted', formatAddress(value));
    // A list column -- a set of names rather than one value.
    case 'tags': {
      const items = Array.isArray(value) ? value : String(value).split(',').filter(Boolean);
      if (!items.length) return h('span.faint', '—');
      return h('span.row-tight.wrap',
        ...items.map((v) => h('span.tag', fmt.titleCase(String(v).trim()))));
    }
    case 'select': {
      if (f.name === 'status' || f.name === 'approval_status' || f.name === 'stage') {
        return h('span.tag', { class: fmt.statusTone(value) }, fmt.titleCase(value));
      }
      return h('span', fmt.titleCase(value));
    }
    default: return h('span', String(value));
  }
}

function refDisplay(f, value, row) {
  // The server resolves reference labels alongside the id; fall back to the
  // client-side cache, then to a short id so a cell is never blank.
  const resolved = row?.[`${f.name}_label`];
  if (resolved) return resolved;
  const named = row?.[`${f.name.replace(/_id$/, '')}_name`] || row?.entity_name;
  if (named) return named;
  const label = window.__meridianRefLabel?.(f.ref, value);
  return label || String(value).slice(-6);
}

export const formatAddress = (a) => {
  if (!a || typeof a !== 'object') return '—';
  return [a.line1, a.line2, a.city, a.state, a.postcode, a.country].filter(Boolean).join(', ') || '—';
};

export const empty = (title, message, action, iconName = 'inbox', tone = '--text-faint') =>
  h('div.empty',
    h('div.icon-chip.lg.big', { style: { color: `var(${tone})` } }, icon(iconName, { size: 22 })),
    h('div.t', title),
    message && h('div', message),
    action && h('div', { style: { marginTop: 'var(--s4)' } }, action));

export const loading = (label = 'Loading') =>
  h('div.empty', h('div', h('span.spinner')), h('div.muted', { style: { marginTop: 'var(--s2)' } }, label + '…'));

export const tag = (text, tone = '') => h('span.tag', { class: tone }, text);
export const statusTag = (s) => h('span.tag', { class: fmt.statusTone(s) }, fmt.titleCase(s || '—'));

/** Signed money cell that colours negatives. */
export function moneyCell(cents, currency, { colour = false } = {}) {
  const el = h('span.nowrap', fmt.money(cents, currency));
  if (colour && cents < 0) el.classList.add('num-neg');
  if (colour && cents > 0) el.classList.add('num-pos');
  return el;
}

/** A labelled definition list. */
export const facts = (pairs) => h('dl.facts',
  ...pairs.filter(Boolean).flatMap(([k, v]) => [h('dt', k), h('dd', v instanceof Node ? v : String(v ?? '—'))]));

/** Section wrapper used across report pages. */
export const section = (title, actions, ...body) => h('div.card',
  h('div.card-head', h('h2', title), actions && h('div.actions', actions)),
  h('div.card-body', ...body));

export { safeSnippet };
