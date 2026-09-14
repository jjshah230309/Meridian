// Meridian ERP :: web/store
// Session, metadata and reference-data cache. Reference lists (customers,
// items, accounts…) are fetched once and reused by every picker, so opening
// a form does not fan out into a dozen requests.
import { API } from './api.js';
import * as fmt from './format.js';

export const state = {
  user: null, tenant: null, permissions: {}, roles: [], restrictions: {},
  meta: null, savedSearches: [], notifications: [], unread: 0,
  subsidiary: null, theme: 'light', palette: 'ink', typeface: 'plex',
};

const refCache = new Map();
const refPromises = new Map();

export const LEVEL = { NONE: 0, VIEW: 1, CREATE: 2, EDIT: 3, FULL: 4 };

export function can(recordType, level = LEVEL.VIEW) {
  if (state.user?.is_owner) return true;
  const m = state.meta?.records?.[recordType];
  const perm = m?.permission || recordType;
  return (state.permissions?.[perm] ?? 0) >= level;
}

export const metaFor = (type) => state.meta?.records?.[type] || null;
export const fieldsOf = (type) => metaFor(type)?.fields || [];
export function fieldMap(type) {
  const m = metaFor(type);
  if (!m) return {};
  const out = Object.fromEntries((m.fields || []).map((f) => [f.name, f]));
  for (const cf of m.customFields || []) out[`custom.${cf.name}`] = { name: `custom.${cf.name}`, label: cf.label, type: cf.type, options: cf.options, custom: true, readOnly: cf.type === 'formula' };
  return out;
}

export async function loadSession() {
  const s = await API.session();
  Object.assign(state, {
    user: s.user, tenant: s.tenant, permissions: s.permissions,
    roles: s.roles, restrictions: s.restrictions || {},
  });
  fmt.configure({ currency: s.tenant.base_currency });
  // The desktop app binds a fresh, random port every launch, so localStorage
  // -- scoped to that origin -- never carries anything to the next one. A
  // few things saved through syncPref below are mirrored onto the account
  // instead precisely so they survive that; pull them back into localStorage
  // here, before anything on this screen has had a chance to ask getPref for
  // one of them.
  for (const [k, v] of Object.entries(s.user?.prefs || {})) setPref(k, v);
  return s;
}

export async function loadMeta() {
  state.meta = await API.meta();
  if (!state.subsidiary && state.meta.subsidiaries?.length === 1) state.subsidiary = null;
  refCache.set('subsidiary', state.meta.subsidiaries);
  refCache.set('location', state.meta.locations);
  refCache.set('department', state.meta.departments);
  refCache.set('price_level', state.meta.price_levels);
  refCache.set('accounting_period', state.meta.periods);
  return state.meta;
}

export async function loadSavedSearches() {
  try { state.savedSearches = await API.savedSearches(); } catch { state.savedSearches = []; }
  return state.savedSearches;
}

export async function loadNotifications() {
  try {
    const n = await API.notifications({ limit: 30 });
    state.notifications = n.rows; state.unread = n.unread;
  } catch { /* notifications are non-critical */ }
  return state.notifications;
}

/**
 * Options for a reference field: [{value, label, sub}].
 * Cached per record type; call invalidateRef after creating a record.
 */
export async function refOptions(type) {
  if (refCache.has(type)) return toOptions(type, refCache.get(type));
  if (refPromises.has(type)) return toOptions(type, await refPromises.get(type));

  const p = (async () => {
    const m = metaFor(type);
    if (!m) return [];
    const cols = uniq(['id', m.title, ...labelParts(type), ...pickerCols(type)]).filter(Boolean);
    const res = await API.list(type, { limit: 1000, columns: cols.join(','), sort: m.defaultSort });
    return res.rows || [];
  })().catch(() => []);

  refPromises.set(type, p);
  const rows = await p;
  refCache.set(type, rows);
  refPromises.delete(type);
  return toOptions(type, rows);
}

export function invalidateRef(type) { refCache.delete(type); refPromises.delete(type); }

const labelParts = (type) => ({
  customer: ['name', 'entity_no'], vendor: ['name', 'entity_no'],
  item: ['sku', 'name'], account: ['number', 'name', 'type'],
  employee: ['first_name', 'last_name', 'employee_no'],
  app_user: ['name', 'email'], contact: ['first_name', 'last_name'],
  location: ['code', 'name'], role: ['name'], subsidiary: ['name', 'currency'],
  department: ['name'], price_level: ['name'], opportunity: ['name'],
  accounting_period: ['name', 'status'],
}[type] || ['name']);

/**
 * Columns a picker needs beyond the label. A dropdown that filters out
 * summary accounts, or fills a line in from the item behind it, reads them
 * off `option.row` -- and a column that was never fetched reads as undefined,
 * which quietly turns "hide the ones you cannot post to" into "show
 * everything" and a cost autofill into zero.
 */
const pickerCols = (type) => ({
  account: ['is_summary', 'active'],
  item: ['type', 'base_price', 'purchase_price', 'standard_cost', 'tax_code', 'taxable', 'active'],
  customer: ['currency'],
  vendor: ['currency'],
  location: ['active'],
}[type] || []);

function toOptions(type, rows) {
  return (rows || []).map((r) => ({ value: r.id, label: refLabel(type, r), sub: refSub(type, r), row: r }));
}

export function refLabel(type, r) {
  if (!r) return '';
  switch (type) {
    case 'item': return `${r.sku} · ${r.name}`;
    case 'account': return `${r.number} · ${r.name}`;
    case 'employee': return `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.employee_no;
    case 'contact': return `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.email;
    case 'location': return r.name || r.code;
    default: return r.name || r.txn_no || r.subject || r.id;
  }
}
const refSub = (type, r) => ({
  customer: r.entity_no, vendor: r.entity_no, employee: r.title,
  account: r.type, app_user: r.email, subsidiary: r.currency,
}[type] || '');

/** Resolve one reference id to a display label, using the cache if warm. */
export function refLabelSync(type, id) {
  if (!id) return '';
  const rows = refCache.get(type);
  const row = rows?.find((r) => r.id === id);
  return row ? refLabel(type, row) : '';
}

export async function ensureRefs(types) {
  await Promise.all([...new Set(types)].filter(Boolean).map((t) => refOptions(t).catch(() => [])));
}

const uniq = (a) => [...new Set(a)];

// ----------------------------------------------------------- appearance
/**
 * Appearance is three independent choices, each an attribute on <html> that
 * the stylesheet reads:
 *
 *   palette    which colours          ink | graphite | slate | midnight
 *   theme      light or dark cut of that palette
 *   typeface   which family and type scale
 *
 * They are independent on purpose. Somebody who wants the green palette in
 * dark mode with the serif headings should not have to pick from twelve
 * pre-baked combinations, and a palette added next year should not multiply
 * the list again.
 */
export const PALETTES = [
  { id: 'ink', name: 'Ink & Brass', note: 'Warm paper, near-black chrome, brass' },
  { id: 'graphite', name: 'Graphite & Green', note: 'Warm stone with forest green' },
  { id: 'slate', name: 'Slate & Teal', note: 'Cool slate with deep teal' },
  { id: 'midnight', name: 'Midnight & Indigo', note: 'Drawn for dark, with a light cut' },
];

export const TYPEFACES = [
  { id: 'plex', name: 'IBM Plex', note: 'Engineered; Plex Mono for codes' },
  { id: 'source', name: 'Source Sans', note: 'Humanist and warm; JetBrains Mono' },
  { id: 'inter', name: 'Inter', note: 'Neutral, tuned for screens' },
  { id: 'plex-serif', name: 'Plex Serif titles', note: 'Serif headings over a sans body' },
  // Not a bundled font — Apple's licence for SF Pro forbids embedding the
  // font files in any distributed software, on any platform. This asks the
  // OS for the system font it already has installed instead, the same way
  // every other typeface here already falls back to -apple-system if its
  // own files are somehow missing. Elsewhere it quietly becomes the local
  // system font (Segoe UI on Windows, and so on), which is why it defaults
  // on for macOS and stays opt-in everywhere else.
  { id: 'sf-pro', name: 'SF Pro', note: "macOS's own system font; no files bundled" },
];

const isMacPlatform = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const has = (list, id) => list.some((x) => x.id === id);

export function initTheme() {
  const saved = localStorage.getItem('meridian.theme');
  const prefers = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  setTheme(saved || prefers);
}
export function setTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('meridian.theme', theme); } catch { /* private mode */ }
}
export const toggleTheme = () => setTheme(state.theme === 'dark' ? 'light' : 'dark');

export function setPalette(id) {
  // An unknown value would leave the page with no colour tokens at all, which
  // is a white screen rather than a wrong one -- so fall back rather than trust.
  const value = has(PALETTES, id) ? id : 'ink';
  state.palette = value;
  document.documentElement.setAttribute('data-palette', value);
  setPref('ui.palette', value);
  return value;
}

export function setTypeface(id) {
  const value = has(TYPEFACES, id) ? id : 'plex';
  state.typeface = value;
  document.documentElement.setAttribute('data-typeface', value);
  setPref('ui.typeface', value);
  return value;
}

/**
 * Palette, theme, typeface, density and zoom are all read before the first
 * paint, so the application never flashes one appearance and settles on
 * another.
 */
export function initAppearance() {
  setPalette(getPref('ui.palette', 'ink'));
  setTypeface(getPref('ui.typeface', isMacPlatform() ? 'sf-pro' : 'plex'));
  initTheme();
  setDensity(getPref('ui.density', 'comfortable'));
  const zoom = Number(getPref('ui.zoom', 1)) || 1;
  if (zoom !== 1) document.documentElement.style.fontSize = `${Math.round(zoom * 16)}px`;
}

export function setDensity(density) {
  const value = density === 'compact' ? 'compact' : 'comfortable';
  state.density = value;
  document.documentElement.setAttribute('data-density', value);
  setPref('ui.density', value);
  return value;
}

// ------------------------------------------------------- view prefs
const prefKey = (k) => `meridian.pref.${k}`;
export function getPref(key, fallback) {
  try { const v = localStorage.getItem(prefKey(key)); return v === null ? fallback : JSON.parse(v); }
  catch { return fallback; }
}
export function setPref(key, value) {
  try { localStorage.setItem(prefKey(key), JSON.stringify(value)); } catch { /* ignore */ }
}

/**
 * Like setPref, but for the handful of settings that must survive the next
 * launch -- the desktop app's random per-launch port means localStorage
 * alone will not. Mirrors the value onto the account as well; loadSession
 * pulls it back into localStorage on the next boot, whatever port that one
 * happens to land on. Fire-and-forget: a save that loses the race with the
 * window closing just means the offer runs once more, not data loss.
 */
export function syncPref(key, value) {
  setPref(key, value);
  API.savePrefs({ [key]: value }).catch(() => { /* best effort */ });
}
