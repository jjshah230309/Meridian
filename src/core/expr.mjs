// Meridian ERP :: core/expr
// A small, safe expression language. This is the substrate of the whole
// customisation engine: workflow conditions, formula custom fields, pricing
// rules, approval routing and saved-search filters all compile to it.
//
// Why not just eval() user JavaScript? Because tenant-authored logic runs
// inside our process, and `node:vm` is explicitly not a security boundary.
// This evaluator has no host object access, no property traversal onto
// prototypes, no loops, no I/O, and a hard step budget -- a tenant admin
// cannot reach the filesystem, another tenant's data, or the event loop.
//
//   Grammar (precedence low -> high)
//     or        := and ( ('||' | 'or') and )*
//     and       := not ( ('&&' | 'and') not )*
//     not       := ('!' | 'not') not | comparison
//     comparison:= additive ( ('=='|'!='|'<'|'<='|'>'|'>='|'in'|'contains') additive )*
//     additive  := multiplicative ( ('+'|'-') multiplicative )*
//     multiplicative := unary ( ('*'|'/'|'%') unary )*
//     unary     := '-' unary | primary
//     primary   := NUMBER | STRING | TRUE | FALSE | NULL | ARRAY | CALL | PATH | '(' or ')'

const MAX_STEPS = 20000;
const MAX_LENGTH = 4000;
// Nesting deeper than this is nobody's formula, and the parser is recursive:
// 1,800 nested parentheses fit inside MAX_LENGTH and overflow the stack.
const MAX_DEPTH = 64;
// A cap on any string an expression builds. The step budget counts nodes, not
// characters, so forty nested REPLACE calls that each double their input are
// only forty steps -- and a gigabyte of string, which killed the process
// outright rather than raising anything catchable.
const MAX_STRING = 100_000;

export class ExprError extends Error {
  constructor(msg, pos) { super(pos === undefined ? msg : `${msg} (at ${pos})`); this.name = 'ExprError'; this.pos = pos; }
}

// ------------------------------------------------------------ tokenizer
const PUNCT = ['<=', '>=', '==', '!=', '&&', '||', '(', ')', '[', ']', ',', '+', '-', '*', '/', '%', '<', '>', '!', '.'];
// Null-prototype, because a field really can be called `constructor` or
// `toString`: on a plain object literal those words resolve up the prototype
// chain and the tokenizer emits a token whose type is a native function.
const KEYWORDS = Object.assign(Object.create(null), {
  true: 'TRUE', false: 'FALSE', null: 'NULL', and: 'AND', or: 'OR', not: 'NOT', in: 'IN', contains: 'CONTAINS',
});

function tokenize(src) {
  if (src.length > MAX_LENGTH) throw new ExprError('Expression too long');
  const out = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '"' || c === "'") {
      const q = c; let s = ''; i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\' && i + 1 < src.length) {
          const n = src[++i];
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
        } else s += src[i];
        i++;
      }
      if (i >= src.length) throw new ExprError('Unterminated string', i);
      i++; out.push({ t: 'STR', v: s }); continue;
    }
    if (c >= '0' && c <= '9') {
      let j = i; while (j < src.length && /[0-9_]/.test(src[j])) j++;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] || '')) { j++; while (j < src.length && /[0-9_]/.test(src[j])) j++; }
      out.push({ t: 'NUM', v: Number(src.slice(i, j).replace(/_/g, '')) }); i = j; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i; while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      const kw = KEYWORDS[word.toLowerCase()];
      out.push(kw ? { t: kw } : { t: 'IDENT', v: word });
      i = j; continue;
    }
    const p = PUNCT.find((x) => src.startsWith(x, i));
    if (!p) throw new ExprError(`Unexpected character "${c}"`, i);
    out.push({ t: p }); i += p.length;
  }
  out.push({ t: 'EOF' });
  return out;
}

// --------------------------------------------------------------- parser
function parse(src) {
  const toks = tokenize(src); let p = 0;
  let depth = 0;
  const deeper = (fn) => {
    if (++depth > MAX_DEPTH) throw new ExprError(`Expression nested too deeply (limit ${MAX_DEPTH})`);
    try { return fn(); } finally { depth--; }
  };
  const peek = () => toks[p];
  const eat = (t) => { if (toks[p].t === t) return toks[p++]; return null; };
  const expect = (t) => { const x = eat(t); if (!x) throw new ExprError(`Expected ${t} but found ${toks[p].t}`, p); return x; };

  // Every nested construct -- parentheses, array items, call arguments --
  // re-enters the grammar here, so this is where depth is counted.
  function parseOr() {
    return deeper(() => {
      let l = parseAnd();
      while (peek().t === '||' || peek().t === 'OR') { p++; l = { k: 'or', l, r: parseAnd() }; }
      return l;
    });
  }
  function parseAnd() {
    let l = parseNot();
    while (peek().t === '&&' || peek().t === 'AND') { p++; l = { k: 'and', l, r: parseNot() }; }
    return l;
  }
  function parseNot() {
    if (peek().t === '!' || peek().t === 'NOT') { p++; return deeper(() => ({ k: 'not', e: parseNot() })); }
    return parseCmp();
  }
  function parseCmp() {
    let l = parseAdd();
    for (;;) {
      const t = peek().t;
      if (['==', '!=', '<', '<=', '>', '>=' ].includes(t)) { p++; l = { k: 'cmp', op: t, l, r: parseAdd() }; }
      else if (t === 'IN') { p++; l = { k: 'in', l, r: parseAdd() }; }
      else if (t === 'CONTAINS') { p++; l = { k: 'contains', l, r: parseAdd() }; }
      else return l;
    }
  }
  function parseAdd() {
    let l = parseMul();
    while (peek().t === '+' || peek().t === '-') { const op = toks[p++].t; l = { k: 'bin', op, l, r: parseMul() }; }
    return l;
  }
  function parseMul() {
    let l = parseUnary();
    while (['*', '/', '%'].includes(peek().t)) { const op = toks[p++].t; l = { k: 'bin', op, l, r: parseUnary() }; }
    return l;
  }
  function parseUnary() {
    if (peek().t === '-') { p++; return deeper(() => ({ k: 'neg', e: parseUnary() })); }
    if (peek().t === '+') { p++; return deeper(() => parseUnary()); }
    return parsePrimary();
  }
  function parsePrimary() {
    const t = peek();
    if (t.t === 'NUM') { p++; return { k: 'lit', v: t.v }; }
    if (t.t === 'STR') { p++; return { k: 'lit', v: t.v }; }
    if (t.t === 'TRUE') { p++; return { k: 'lit', v: true }; }
    if (t.t === 'FALSE') { p++; return { k: 'lit', v: false }; }
    if (t.t === 'NULL') { p++; return { k: 'lit', v: null }; }
    if (t.t === '(') { p++; const e = parseOr(); expect(')'); return e; }
    if (t.t === '[') {
      p++; const items = [];
      if (peek().t !== ']') { do { items.push(parseOr()); } while (eat(',')); }
      expect(']'); return { k: 'arr', items };
    }
    if (t.t === 'IDENT') {
      p++;
      if (peek().t === '(') {
        p++; const args = [];
        if (peek().t !== ')') { do { args.push(parseOr()); } while (eat(',')); }
        expect(')');
        return { k: 'call', name: t.v.toUpperCase(), args };
      }
      const path = [t.v];
      while (peek().t === '.') { p++; const seg = expect('IDENT'); path.push(seg.v); }
      return { k: 'path', path };
    }
    throw new ExprError(`Unexpected token ${t.t}`, p);
  }

  const ast = parseOr();
  if (peek().t !== 'EOF') throw new ExprError(`Unexpected trailing token ${peek().t}`, p);
  return ast;
}

// ------------------------------------------------------------ functions
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

const toNum = (v) => { const n = typeof v === 'number' ? v : Number.parseFloat(v); return Number.isFinite(n) ? n : 0; };
const toStr = (v) => (v === null || v === undefined ? '' : String(v));
const truthy = (v) => !(v === false || v === null || v === undefined || v === 0 || v === '' || (Array.isArray(v) && v.length === 0));
const isoDate = (v) => (typeof v === 'string' ? v.slice(0, 10) : new Date(v).toISOString().slice(0, 10));

/**
 * Refuse a string before it is built, not after. The functions that can grow
 * their input work out the size first: by the time a doubling REPLACE has
 * actually allocated a gigabyte, there is nothing left to catch -- V8 aborts
 * the process rather than raising.
 */
function cap(length) {
  if (length > MAX_STRING) {
    throw new ExprError(`Expression would build a string of ${Math.round(length / 1000)}k characters (limit ${MAX_STRING / 1000}k)`);
  }
}
const capped = (v) => { if (typeof v === 'string') cap(v.length); return v; };

export const FUNCTIONS = {
  // logic / null handling
  IF: (c, a, b) => (truthy(c) ? a : b),
  COALESCE: (...a) => a.find((x) => x !== null && x !== undefined && x !== '') ?? null,
  ISBLANK: (v) => v === null || v === undefined || v === '',
  NOT: (v) => !truthy(v),
  // numbers
  ABS: (v) => Math.abs(toNum(v)),
  ROUND: (v, d = 0) => { const f = 10 ** toNum(d); return Math.round(toNum(v) * f) / f; },
  FLOOR: (v) => Math.floor(toNum(v)),
  CEIL: (v) => Math.ceil(toNum(v)),
  MIN: (...a) => Math.min(...a.flat().map(toNum)),
  MAX: (...a) => Math.max(...a.flat().map(toNum)),
  SUM: (...a) => a.flat().reduce((x, y) => x + toNum(y), 0),
  AVG: (...a) => { const f = a.flat().map(toNum); return f.length ? f.reduce((x, y) => x + y, 0) / f.length : 0; },
  COUNT: (...a) => a.flat().length,
  NUMBER: toNum,
  PERCENT: (v, p) => (toNum(v) * toNum(p)) / 100,
  // text
  LEN: (v) => toStr(v).length,
  UPPER: (v) => toStr(v).toUpperCase(),
  LOWER: (v) => toStr(v).toLowerCase(),
  TRIM: (v) => toStr(v).trim(),
  CONCAT: (...a) => { const parts = a.flat().map(toStr); cap(parts.reduce((n, x) => n + x.length, 0)); return parts.join(''); },
  SUBSTR: (v, s, n) => toStr(v).slice(toNum(s), n === undefined ? undefined : toNum(s) + toNum(n)),
  STARTSWITH: (v, s) => toStr(v).startsWith(toStr(s)),
  ENDSWITH: (v, s) => toStr(v).endsWith(toStr(s)),
  CONTAINS: (v, s) => toStr(v).toLowerCase().includes(toStr(s).toLowerCase()),
  REPLACE: (v, a, b) => {
    const s = toStr(v), from = toStr(a), to = toStr(b);
    if (!from) return s;
    const hits = s.split(from).length - 1;
    cap(s.length + hits * (to.length - from.length));
    return s.split(from).join(to);
  },
  SPLIT: (v, s) => toStr(v).split(toStr(s)),
  TEXT: toStr,
  // logic / control
  SWITCH: (expr, ...args) => {
    for (let i = 0; i < args.length; i += 2) {
      if (looseEq(expr, args[i])) return args[i+1];
    }
    return null;
  },
  // financials
  NPV: (rate, ...vals) => {
    const r = toNum(rate);
    return vals.reduce((acc, v, i) => acc + toNum(v) / Math.pow(1 + r, i + 1), 0);
  },
  IRR: (vals) => {
    let guess = 0.1;
    for (let i = 0; i < 100; i++) {
      let npv = 0, dnpv = 0;
      for (let j = 0; j < vals.length; j++) {
        const v = toNum(vals[j]);
        npv += v / Math.pow(1 + guess, j);
        dnpv -= j * v / Math.pow(1 + guess, j + 1);
      }
      const next = guess - npv / dnpv;
      if (Math.abs(next - guess) < 1e-7) return next;
      guess = next;
    }
    return null;
  },
  // dates
  TODAY: () => new Date().toISOString().slice(0, 10),
  NOW: () => new Date().toISOString(),
  YEAR: (d) => Number(isoDate(d).slice(0, 4)),
  MONTH: (d) => Number(isoDate(d).slice(5, 7)),
  DAY: (d) => Number(isoDate(d).slice(8, 10)),
  DATE_ADD: (d, n) => { const x = new Date(isoDate(d) + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + toNum(n)); return x.toISOString().slice(0, 10); },
  DAYS_BETWEEN: (a, b) => Math.round((Date.parse(isoDate(b) + 'T00:00:00Z') - Date.parse(isoDate(a) + 'T00:00:00Z')) / 86400000),
  EOMONTH: (d) => {
    const x = new Date(isoDate(d) + 'T00:00:00Z');
    x.setUTCMonth(x.getUTCMonth() + 1, 0);
    return x.toISOString().slice(0, 10);
  },
  ADD_MONTHS: (d, n) => {
    const x = new Date(isoDate(d) + 'T00:00:00Z');
    const day = x.getUTCDate();
    x.setUTCMonth(x.getUTCMonth() + toNum(n));
    const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
    x.setUTCDate(Math.min(day, last));
    return x.toISOString().slice(0, 10);
  },
  WORKING_DAYS_BETWEEN: (a, b) => {
    const start = new Date(isoDate(a) + 'T00:00:00Z');
    const end = new Date(isoDate(b) + 'T00:00:00Z');
    let count = 0;
    const cur = new Date(start);
    while (cur < end) {
      const day = cur.getUTCDay();
      if (day !== 0 && day !== 6) count++;
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return count;
  },
  // money helpers (values in the model are minor units)
  MONEY: (v) => toNum(v) / 100,
  CENTS: (v) => Math.round(toNum(v) * 100),
  QTY: (v) => toNum(v) / 1e6,
  // financials
  PMT: (rate, nper, pv) => {
    const r = toNum(rate) / 12; const n = toNum(nper); const v = toNum(pv);
    return r === 0 ? -v / n : (-v * r) / (1 - Math.pow(1 + r, -n));
  },
  FV: (rate, nper, pmt, pv = 0) => {
    const r = toNum(rate) / 12; const n = toNum(nper); const p = toNum(pmt); const v = toNum(pv);
    return v * Math.pow(1 + r, n) + p * (Math.pow(1 + r, n) - 1) / r;
  },
  PV: (rate, nper, pmt, fv = 0) => {
    const r = toNum(rate) / 12; const n = toNum(nper); const p = toNum(pmt); const v = toNum(fv);
    return (v + p * (Math.pow(1 + r, n) - 1) / r) / Math.pow(1 + r, n);
  },

};

// ------------------------------------------------------------ evaluator
function evaluate(node, scope, state) {
  if (++state.steps > MAX_STEPS) throw new ExprError('Expression step budget exceeded');
  switch (node.k) {
    case 'lit': return node.v;
    case 'arr': return node.items.map((n) => evaluate(n, scope, state));
    case 'path': {
      let cur = scope;
      for (const seg of node.path) {
        if (FORBIDDEN.has(seg)) throw new ExprError(`Illegal property "${seg}"`);
        if (cur === null || cur === undefined) return null;
        if (typeof cur !== 'object') return null;
        if (!Object.prototype.hasOwnProperty.call(cur, seg)) return null;  // own props only
        cur = cur[seg];
        if (typeof cur === 'function') return null;                        // never expose callables
      }
      return cur === undefined ? null : cur;
    }
    case 'call': {
      const fn = Object.prototype.hasOwnProperty.call(FUNCTIONS, node.name) ? FUNCTIONS[node.name] : null;
      if (!fn) throw new ExprError(`Unknown function ${node.name}()`);
      // IF is lazy so IF(x != null, x.y, 0) is safe
      if (node.name === 'IF') {
        return truthy(evaluate(node.args[0], scope, state))
          ? (node.args[1] ? evaluate(node.args[1], scope, state) : null)
          : (node.args[2] ? evaluate(node.args[2], scope, state) : null);
      }
      return capped(fn(...node.args.map((a) => evaluate(a, scope, state))));
    }
    case 'and': return truthy(evaluate(node.l, scope, state)) ? truthy(evaluate(node.r, scope, state)) : false;
    case 'or': return truthy(evaluate(node.l, scope, state)) ? true : truthy(evaluate(node.r, scope, state));
    case 'not': return !truthy(evaluate(node.e, scope, state));
    case 'neg': return -toNum(evaluate(node.e, scope, state));
    case 'in': {
      const l = evaluate(node.l, scope, state); const r = evaluate(node.r, scope, state);
      if (Array.isArray(r)) return r.some((x) => looseEq(x, l));
      return toStr(r).includes(toStr(l));
    }
    case 'contains': {
      const l = evaluate(node.l, scope, state); const r = evaluate(node.r, scope, state);
      if (Array.isArray(l)) return l.some((x) => looseEq(x, r));
      return toStr(l).toLowerCase().includes(toStr(r).toLowerCase());
    }
    case 'cmp': {
      const l = evaluate(node.l, scope, state); const r = evaluate(node.r, scope, state);
      switch (node.op) {
        case '==': return looseEq(l, r);
        case '!=': return !looseEq(l, r);
        case '<': return cmp(l, r) < 0;
        case '<=': return cmp(l, r) <= 0;
        case '>': return cmp(l, r) > 0;
        case '>=': return cmp(l, r) >= 0;
        default: throw new ExprError(`Bad comparison ${node.op}`);
      }
    }
    case 'bin': {
      const l = evaluate(node.l, scope, state); const r = evaluate(node.r, scope, state);
      if (node.op === '+' && (typeof l === 'string' || typeof r === 'string')) {
        const a2 = toStr(l), b2 = toStr(r);
        cap(a2.length + b2.length);
        return a2 + b2;
      }
      const a = toNum(l), b = toNum(r);
      switch (node.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return b === 0 ? 0 : a / b;
        case '%': return b === 0 ? 0 : a % b;
        default: throw new ExprError(`Bad operator ${node.op}`);
      }
    }
    default: throw new ExprError(`Bad node ${node.k}`);
  }
}

function looseEq(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined || b === '';
  if (b === null || b === undefined) return a === '';
  if (typeof a === 'number' || typeof b === 'number') return toNum(a) === toNum(b);
  if (typeof a === 'boolean' || typeof b === 'boolean') return truthy(a) === truthy(b);
  return String(a) === String(b);
}
function cmp(a, b) {
  if (typeof a === 'string' && typeof b === 'string' && !(/^-?[\d.]+$/.test(a) && /^-?[\d.]+$/.test(b))) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const x = toNum(a), y = toNum(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// ----------------------------------------------------------- public API
const cache = new Map();
const CACHE_MAX = 500;

/** Compile once, reuse. Returns (scope) => value. */
export function compile(source) {
  const src = String(source ?? '').trim();
  if (!src) return () => true;                 // blank condition = always
  let ast = cache.get(src);
  if (!ast) {
    ast = parse(src);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(src, ast);
  }
  return (scope = {}) => evaluate(ast, scope, { steps: 0 });
}

/** Evaluate, returning `fallback` on any error (used for display formulas). */
export function evalSafe(source, scope = {}, fallback = null) {
  try { return compile(source)(scope); } catch { return fallback; }
}

/** Evaluate as a boolean condition. Errors are false, and reported by caller. */
export function test(source, scope = {}) {
  return truthy(compile(source)(scope));
}

/** Validate without running. Returns {ok, error}. */
export function validate(source) {
  try { compile(source); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message, pos: e.pos }; }
}

export { truthy };
