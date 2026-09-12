// Meridian ERP :: web/dom
// A ~100-line view layer. No framework, no build step, no CSP exceptions:
// handlers are attached with addEventListener, never as inline attributes.

/**
 * h('div.card#id', {props}, ...children) -> HTMLElement
 * Selector shorthand: tag, .class (repeatable), #id.
 * Props: class/className, style object, data-*, aria-*, on* handlers, else attr/prop.
 */
export function h(selector, props, ...children) {
  const [, tag = 'div', rest = ''] = /^([a-zA-Z0-9-]*)(.*)$/.exec(selector) || [];
  const el = document.createElement(tag || 'div');
  for (const m of rest.matchAll(/([.#])([^.#]+)/g)) {
    if (m[1] === '.') el.classList.add(m[2]); else el.id = m[2];
  }
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props); props = null;
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class' || k === 'className') { String(v).split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c)); }
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;                     // callers must pre-escape
    else if (k in el && k !== 'list' && typeof v !== 'object') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, kids) {
  for (const c of kids.flat(4)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const frag = (...kids) => { const f = document.createDocumentFragment(); append(f, kids); return f; };
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const mount = (el, ...kids) => { clear(el); append(el, kids); return el; };

/** Escape text for the rare places we build HTML strings (search snippets). */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Sanitise a server-provided snippet, allowing only <mark>. */
export function safeSnippet(s) {
  return esc(s).replace(/&lt;mark&gt;/g, '<mark>').replace(/&lt;\/mark&gt;/g, '</mark>');
}

export function debounce(fn, ms = 220) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Delegate an event from a container to matching descendants. */
export function delegate(root, event, selector, handler) {
  root.addEventListener(event, (e) => {
    const target = e.target.closest(selector);
    if (target && root.contains(target)) handler(e, target);
  });
}
