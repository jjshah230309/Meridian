// Meridian ERP :: web/format
// Presentation of the wire format. The server sends money as integer minor
// units and quantities scaled by 1e6; everything user-facing is rendered here
// so there is exactly one place that decides how a number looks.

export const MONEY_SCALE = 100;
export const QTY_SCALE = 1_000_000;

let locale = 'en-US';
let baseCurrency = 'USD';
export function configure({ locale: l, currency }) {
  if (l) locale = l;
  if (currency) baseCurrency = currency;
}
export const getBaseCurrency = () => baseCurrency;

const nfCache = new Map();
function nf(currency, opts) {
  const key = `${currency}|${JSON.stringify(opts)}`;
  let f = nfCache.get(key);
  if (!f) {
    try { f = new Intl.NumberFormat(locale, { style: 'currency', currency, ...opts }); }
    catch { f = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    nfCache.set(key, f);
  }
  return f;
}

/** Minor units -> "$1,234.56" */
export function money(cents, currency = baseCurrency, { blankZero = false, sign = false } = {}) {
  if (cents === null || cents === undefined) return '—';
  if (blankZero && !cents) return '';
  const n = cents / MONEY_SCALE;
  const s = nf(currency, sign ? { signDisplay: 'exceptZero' } : {}).format(n);
  return s;
}

/** Compact form for dashboard tiles: $1.2M, $84.5k */
export function moneyCompact(cents, currency = baseCurrency) {
  if (cents === null || cents === undefined) return '—';
  const n = cents / MONEY_SCALE;
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return nf(currency, { notation: 'compact', maximumFractionDigits: 2 }).format(n);
  if (abs >= 10_000) return nf(currency, { maximumFractionDigits: 0 }).format(n);
  return nf(currency, {}).format(n);
}

export function num(v, dp = 0) {
  if (v === null || v === undefined || v === '') return '—';
  return new Intl.NumberFormat(locale, { minimumFractionDigits: dp, maximumFractionDigits: dp }).format(Number(v));
}

/** Scaled quantity -> trimmed decimal string. */
export function qty(q, dp = 2) {
  if (q === null || q === undefined) return '—';
  const n = q / QTY_SCALE;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: dp }).format(n);
}

export const pct = (v, dp = 1) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(dp)}%`);

export function date(d) {
  if (!d) return '—';
  const s = String(d).slice(0, 10);
  const dt = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(dt.getTime())) return s;
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(dt);
}
export function dateShort(d) {
  if (!d) return '—';
  const dt = new Date(String(d).slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(dt.getTime())) return String(d);
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', timeZone: 'UTC' }).format(dt);
}
export function dateTime(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(dt);
}

/** "3 days ago" / "in 2 weeks" */
export function relative(d) {
  if (!d) return '—';
  const ms = new Date(d).getTime() - Date.now();
  if (Number.isNaN(ms)) return String(d);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const units = [['year', 31536e6], ['month', 2592e6], ['week', 6048e5], ['day', 864e5], ['hour', 36e5], ['minute', 6e4]];
  for (const [unit, size] of units) {
    if (Math.abs(ms) >= size || unit === 'minute') return rtf.format(Math.round(ms / size), unit);
  }
  return 'just now';
}

export const today = () => new Date().toISOString().slice(0, 10);
export function addDays(d, n) {
  const x = new Date(String(d).slice(0, 10) + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
export const startOfMonth = (d = today()) => String(d).slice(0, 8) + '01';
export function endOfMonth(d = today()) {
  const x = new Date(String(d).slice(0, 10) + 'T00:00:00Z');
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}
export function addMonths(d, n) {
  const x = new Date(String(d).slice(0, 10) + 'T00:00:00Z');
  x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + n);
  return x.toISOString().slice(0, 10);
}
export const monthLabel = (ym) => {
  const dt = new Date(ym + '-01T00:00:00Z');
  return Number.isNaN(dt.getTime()) ? ym : new Intl.DateTimeFormat(locale, { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(dt);
};

/** Turn snake_case into a readable label. */
export const titleCase = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
export const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

/** Colour class for a status token. */
export function statusTone(status) {
  const s = String(status || '').toLowerCase();
  if (['paid', 'closed', 'approved', 'active', 'posted', 'resolved', 'fulfilled', 'received', 'completed', 'closed_won', 'reconciled', 'matched'].includes(s)) return 'green';
  if (['voided', 'cancelled', 'rejected', 'failed', 'closed_lost', 'unqualified', 'terminated', 'escalated'].includes(s)) return 'red';
  if (['pending_approval', 'pending', 'partially_paid', 'partially_fulfilled', 'partially_received', 'partially_applied', 'draft', 'on_leave', 'submitted', 'in_progress'].includes(s)) return 'amber';
  if (['open', 'new', 'working', 'qualification', 'proposal', 'negotiation', 'unmatched'].includes(s)) return 'blue';
  return '';
}
