// Meridian ERP :: core/util
// Identifiers, money/quantity arithmetic, dates. No dependencies.
import crypto from 'node:crypto';

// ---------------------------------------------------------------- ids
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';       // Crockford, no I/L/O/U
let lastMs = 0, lastRand = null;

/** ULID: lexicographically sortable, collision-safe, URL-safe. */
export function ulid(now = Date.now()) {
  let ts = '';
  let t = now;
  for (let i = 9; i >= 0; i--) { ts = B32[t % 32] + ts; t = Math.floor(t / 32); }
  let rand;
  if (now === lastMs && lastRand) {           // monotonic within the same ms
    rand = lastRand.slice();
    for (let i = 15; i >= 0; i--) { if (rand[i] < 31) { rand[i]++; break; } rand[i] = 0; }
  } else {
    rand = Array.from(crypto.randomBytes(16), (b) => b % 32);
  }
  lastMs = now; lastRand = rand;
  return ts + rand.map((r) => B32[r]).join('');
}

export const uuid = () => crypto.randomUUID();
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Constant-time string compare that tolerates length mismatch. */
export function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ab.length !== bb.length) { crypto.timingSafeEqual(ab, ab); return false; }
  return crypto.timingSafeEqual(ab, bb);
}

// ------------------------------------------------------------- money
// All monetary values are INTEGER minor units (cents). Two rules:
//   1. Never let a float reach the database.
//   2. Round exactly once, at the point a rate or percentage is applied,
//      using half-away-from-zero (the convention finance teams expect).
export const MONEY_SCALE = 100;

export function round(n) {                     // half away from zero
  return n < 0 ? -Math.round(-n) : Math.round(n);
}

export const Money = {
  /** Accepts 1234.56 | "1,234.56" | "$1234.56" -> 123456 */
  parse(v) {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'number') return round(v * MONEY_SCALE);
    const cleaned = String(v).replace(/[^0-9.,\-]/g, '').replace(/,/g, '');
    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) ? round(n * MONEY_SCALE) : 0;
  },
  /** minor units -> Number for display/JSON. Safe: |cents| < 2^53. */
  toNumber: (c) => (c || 0) / MONEY_SCALE,
  format(c, currency = 'USD', locale = 'en-US') {
    try {
      return new Intl.NumberFormat(locale, { style: 'currency', currency }).format((c || 0) / MONEY_SCALE);
    } catch { return ((c || 0) / MONEY_SCALE).toFixed(2); }
  },
  /** Apply a percentage to minor units, rounding once. */
  pct: (cents, pct) => round((cents || 0) * (pct || 0) / 100),
  /** Convert between currencies at `rate`, rounding once. */
  convert: (cents, rate) => round((cents || 0) * (rate || 1)),
  /**
   * Split `cents` into `n` parts that sum exactly to `cents`
   * (largest-remainder). Used for allocations and tax distribution.
   */
  allocate(cents, weights) {
    const total = weights.reduce((a, b) => a + b, 0);
    if (total === 0) return weights.map(() => 0);
    const raw = weights.map((w) => (cents * w) / total);
    const out = raw.map((r) => Math.trunc(r));
    let remainder = cents - out.reduce((a, b) => a + b, 0);
    const order = raw.map((r, i) => [r - Math.trunc(r), i]).sort((a, b) => b[0] - a[0]);
    for (let k = 0; remainder !== 0 && k < order.length; k++) {
      const step = remainder > 0 ? 1 : -1;
      out[order[k][1]] += step; remainder -= step;
    }
    return out;
  },
};

// ---------------------------------------------------------- quantity
// Quantities are INTEGER scaled by 1e6 so fractional units (0.001 kg,
// 1/3 hour) survive arithmetic without float drift.
export const QTY_SCALE = 1_000_000;
export const Qty = {
  parse(v) {
    if (v === null || v === undefined || v === '') return 0;
    const n = typeof v === 'number' ? v : Number.parseFloat(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? round(n * QTY_SCALE) : 0;
  },
  toNumber: (q) => (q || 0) / QTY_SCALE,
  format: (q, dp = 2) => ((q || 0) / QTY_SCALE).toFixed(dp).replace(/\.?0+$/, (m) => (m.includes('.') ? '' : m)),
  /** qty (1e6) x unitPrice (cents) -> cents, rounded once. */
  extend: (qty, unitPrice) => round(((qty || 0) / QTY_SCALE) * (unitPrice || 0)),
};

// ------------------------------------------------------------- dates
export const today = () => new Date().toISOString().slice(0, 10);
export const nowIso = () => new Date().toISOString();

/**
 * Parse a YYYY-MM-DD into a UTC date, or refuse it by name.
 *
 * Left to itself, `new Date('banana')` gives an Invalid Date that only fails
 * several lines later inside toISOString, as a bare RangeError -- which the
 * server can only report as a 500. A date that arrived from a query string is
 * the caller's mistake, so say which value was wrong and answer 400. The
 * `status` property is all the server needs; core/util deliberately does not
 * import core/http, which imports it.
 */
export function parseDate(dateStr, label = 'date') {
  const d = new Date(String(dateStr) + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) {
    const err = new Error(`Invalid ${label} "${dateStr}" — expected YYYY-MM-DD`);
    err.status = 400; err.code = 'BAD_REQUEST';
    throw err;
  }
  return d;
}

export function addDays(dateStr, days) {
  const d = parseDate(dateStr);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}
export function addMonths(dateStr, months) {
  const d = parseDate(dateStr);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + Number(months || 0));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}
export const endOfMonth = (dateStr) => {
  const d = parseDate(dateStr);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
};
export const startOfMonth = (dateStr) => parseDate(dateStr).toISOString().slice(0, 8) + '01';
export function daysBetween(a, b) {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86400000);
}
export function isValidDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')); }

/** NET30 -> due date. */
export function termsToDueDate(txnDate, terms) {
  const map = { DUE_ON_RECEIPT: 0, NET7: 7, NET10: 10, NET15: 15, NET30: 30, NET45: 45, NET60: 60, NET90: 90 };
  return addDays(txnDate, map[terms] ?? 30);
}

// ------------------------------------------------------------- misc
export const slugify = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in (obj || {})).map((k) => [k, obj[k]]));
export const omit = (obj, keys) => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => !keys.includes(k)));
export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const groupBy = (arr, fn) => arr.reduce((m, x) => { const k = fn(x); (m[k] ||= []).push(x); return m; }, {});
export const sum = (arr, fn = (x) => x) => arr.reduce((a, x) => a + (fn(x) || 0), 0);

export function safeJson(v, fallback = {}) {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

/** Escape for embedding untrusted text in generated HTML. */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
