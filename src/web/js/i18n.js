// Meridian ERP :: web/i18n
// A translation is a flat map from the English string (the key) to the
// translated one -- so English itself needs no file at all, and a missing
// key just falls back to the English text rather than breaking the page.
// Safe to import under plain Node (no `window`/`document`), so
// test/webui.test.mjs's static checks and scripts/i18n-extract.mjs can both
// load it directly.
export const BUILT_IN_LANGUAGES = [
  { code: 'en', name: 'English', native: 'English', dir: 'ltr' },
  { code: 'ar', name: 'Arabic', native: 'العربية', dir: 'rtl' },
];
// Downloadable, not bundled -- see language-packs/manifest.json at the repo
// root and core/langpacks.mjs, which fetches from there.
export const DOWNLOADABLE_LANGUAGES = [
  { code: 'fr', name: 'French', native: 'Français', dir: 'ltr' },
  { code: 'es', name: 'Spanish', native: 'Español', dir: 'ltr' },
  { code: 'de', name: 'German', native: 'Deutsch', dir: 'ltr' },
];
export const ALL_LANGUAGES = [...BUILT_IN_LANGUAGES, ...DOWNLOADABLE_LANGUAGES];
export const languageInfo = (code) => ALL_LANGUAGES.find((l) => l.code === code) || BUILT_IN_LANGUAGES[0];
export const dirFor = (code) => languageInfo(code).dir;

let lang = 'en';
let dict = {};

/** Install a language's dictionary. `{}` (or omitted) for English -- there is nothing to translate against itself. */
export function setLanguage(code, packDict = {}) {
  lang = code;
  dict = packDict || {};
}
export const currentLanguage = () => lang;

/**
 * Translate an English string, optionally filling `{name}`-style
 * placeholders. The English text IS the lookup key, so a string nobody has
 * translated yet still renders correctly -- just untranslated -- rather
 * than as a raw key like `invoice.title.new`.
 */
export function t(english, vars) {
  let s = (lang === 'en' ? english : (dict[english] ?? english));
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/**
 * Pluralised translation. `forms` is an English map keyed by CLDR plural
 * category, e.g. `tn({ one: '{n} item', other: '{n} items' }, count)`.
 * English only distinguishes `one`/`other`, so a language with more
 * categories than that (Arabic has six) still gets a grammatically
 * complete result by falling back to `other`'s English text for a
 * category English has no form for -- each distinct English form is its
 * own lookup key in a pack, same as any other string.
 */
const pluralRulesCache = new Map();
export function tn(forms, count, vars = {}) {
  let rules = pluralRulesCache.get(lang);
  if (!rules) { try { rules = new Intl.PluralRules(lang); } catch { rules = new Intl.PluralRules('en'); } pluralRulesCache.set(lang, rules); }
  const category = rules.select(count);
  const english = forms[category] || forms.other || Object.values(forms)[0];
  return t(english, { n: count, ...vars });
}
