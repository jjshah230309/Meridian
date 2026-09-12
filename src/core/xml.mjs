// Meridian ERP :: core/xml
// A small XML reader and writer, enough for SOAP envelopes and the ISO-20022
// bank formats.
//
// Deliberately NOT a general XML processor: a DOCTYPE is rejected outright
// rather than parsed. Entity expansion is where XXE and billion-laughs live,
// and an ERP has no reason to accept either, so the only entities understood
// are the five predefined ones plus numeric character references.

export class XmlError extends Error {
  constructor(message) { super(message); this.name = 'XmlError'; }
}

const NAMED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Resolve the five predefined entities and numeric references; nothing else. */
export function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      // Surrogates and out-of-range code points are not characters.
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    }
    const named = NAMED[body];
    // An unknown entity stays literal rather than resolving to anything.
    return named === undefined ? whole : named;
  });
}

export function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // Control characters other than tab/LF/CR are not legal in XML 1.0 at all.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

/**
 * Parse a document into a tree of
 * `{ name, local, prefix, attrs, children, text }`.
 *
 * `maxDepth` and `maxNodes` bound the work a hostile document can cause.
 */
export function parseXml(source, { maxDepth = 100, maxNodes = 200_000 } = {}) {
  const src = String(source ?? '').replace(/^﻿/, '');
  if (/<!DOCTYPE/i.test(src)) throw new XmlError('DOCTYPE is not accepted');
  if (/<!ENTITY/i.test(src)) throw new XmlError('Entity declarations are not accepted');

  const root = { name: '#document', local: '#document', prefix: '', attrs: {}, children: [], text: '' };
  const stack = [root];
  let nodes = 0;
  let i = 0;

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { appendText(stack[stack.length - 1], src.slice(i)); break; }
    if (lt > i) appendText(stack[stack.length - 1], src.slice(i, lt));

    // Comments, CDATA, processing instructions.
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end < 0) throw new XmlError('Unterminated comment');
      i = end + 3; continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      if (end < 0) throw new XmlError('Unterminated CDATA section');
      // CDATA is literal: it must not go through entity decoding.
      stack[stack.length - 1].text += src.slice(lt + 9, end);
      i = end + 3; continue;
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      if (end < 0) throw new XmlError('Unterminated processing instruction');
      i = end + 2; continue;
    }

    const gt = findTagEnd(src, lt);
    if (gt < 0) throw new XmlError('Unterminated tag');
    const raw = src.slice(lt + 1, gt).trim();

    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      const open = stack.pop();
      if (stack.length === 0) throw new XmlError(`Unexpected closing tag </${name}>`);
      if (open.name !== name) throw new XmlError(`Closing </${name}> does not match <${open.name}>`);
      i = gt + 1; continue;
    }

    const selfClosing = raw.endsWith('/');
    const inner = selfClosing ? raw.slice(0, -1).trim() : raw;
    const nameMatch = /^([^\s/>]+)/.exec(inner);
    if (!nameMatch) throw new XmlError('Malformed tag');
    const name = nameMatch[1];
    const colon = name.indexOf(':');
    const node = {
      name,
      prefix: colon > 0 ? name.slice(0, colon) : '',
      local: colon > 0 ? name.slice(colon + 1) : name,
      attrs: parseAttrs(inner.slice(name.length)),
      children: [],
      text: '',
    };
    if (++nodes > maxNodes) throw new XmlError('Document has too many elements');
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) {
      stack.push(node);
      if (stack.length > maxDepth) throw new XmlError('Document is nested too deeply');
    }
    i = gt + 1;
  }

  if (stack.length !== 1) throw new XmlError(`Unclosed element <${stack[stack.length - 1].name}>`);
  return root;
}

// A '>' inside an attribute value does not end the tag.
function findTagEnd(src, from) {
  let quote = null;
  for (let i = from + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') return i;
  }
  return -1;
}

function parseAttrs(s) {
  const attrs = {};
  const rx = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = rx.exec(s))) attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? '');
  return attrs;
}

function appendText(node, chunk) {
  if (!chunk) return;
  node.text += decodeEntities(chunk);
}

// ------------------------------------------------------------- navigation

/** Direct children whose local name matches, ignoring namespace prefixes. */
export const kids = (node, local) =>
  (node?.children || []).filter((c) => c.local === local);

/** The first matching child, or null. */
export const kid = (node, local) => kids(node, local)[0] || null;

/** The first descendant with this local name, breadth-first. */
export function find(node, local) {
  const queue = [...(node?.children || [])];
  while (queue.length) {
    const n = queue.shift();
    if (n.local === local) return n;
    queue.push(...n.children);
  }
  return null;
}

/** Every descendant with this local name. */
export function findAll(node, local) {
  const out = [];
  const queue = [...(node?.children || [])];
  while (queue.length) {
    const n = queue.shift();
    if (n.local === local) out.push(n);
    queue.push(...n.children);
  }
  return out;
}

/** Trimmed text of a node, its own only -- not its descendants'. */
export const textOf = (node) => (node ? node.text.trim() : '');

/** Trimmed text of a node and everything under it. */
export function deepText(node) {
  if (!node) return '';
  let out = node.text;
  for (const c of node.children) out += deepText(c);
  return out.trim();
}

/** The document element. */
export const rootOf = (doc) => doc.children.find((c) => c.name !== '#document') || null;

// ---------------------------------------------------------------- writing

/**
 * Build an element. `children` may be a string (text content), an array of
 * built strings, or null.
 */
export function el(name, attrs = null, children = null) {
  const a = attrs
    ? Object.entries(attrs)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join('')
    : '';
  if (children === null || children === undefined || children === '') return `<${name}${a}/>`;
  const body = Array.isArray(children) ? children.filter(Boolean).join('') : escapeXml(children);
  return `<${name}${a}>${body}</${name}>`;
}

/** Element whose body is already-built markup, not text to escape. */
export const raw = (name, attrs, markup) => el(name, attrs, [markup]);

export const declaration = '<?xml version="1.0" encoding="UTF-8"?>';
