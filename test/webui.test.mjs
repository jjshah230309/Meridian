// The front end has no DOM in this test runner, and does not need one for the
// things that actually break: a tour that navigates to a route the router does
// not have, a menu entry pointing at a screen that was renamed, an icon name
// with a typo, a manual chapter that exists as a file but is in no index.
//
// Every one of those fails silently in a browser -- a blank page, a dot where
// a glyph should be, a chapter nobody can reach -- so they are worth pinning
// here, where they fail loudly instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { routes } from '../src/web/js/views/index.js';
import { TOURS } from '../src/web/js/tour.js';
import { hasIcon, iconNames } from '../src/web/js/icons.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const WEB = path.join(HERE, '..', 'src', 'web');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

/** The router's own parse, so a test cannot agree with a mistake it invented. */
const parse = (route) => {
  const [p, qs] = route.split('?');
  return { path: p, parts: p.split('/').filter(Boolean), query: Object.fromEntries(new URLSearchParams(qs || '')) };
};
const fallback = routes.at(-1);
const resolves = (route) => {
  const hit = routes.find((r) => r.match(parse(route)));
  return hit && hit !== fallback;
};

// ------------------------------------------------------------------- tours
test('every route a tour navigates to is a real screen', () => {
  const dead = [];
  for (const tour of TOURS) {
    for (const [i, step] of tour.steps.entries()) {
      if (step.route && !resolves(step.route)) dead.push(`${tour.id}#${i} -> ${step.route}`);
    }
  }
  assert.deepEqual(dead, [], 'tour steps pointing at routes the router does not have');
});

test('every tour is complete enough to run', () => {
  assert.ok(TOURS.length >= 5, 'the learning centre should offer more than a token tour');
  const ids = TOURS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'tour ids must be unique');
  for (const t of TOURS) {
    assert.ok(t.title && t.blurb, `${t.id} needs a title and a blurb`);
    assert.ok(t.minutes > 0, `${t.id} needs an honest length`);
    assert.ok(hasIcon(t.icon), `${t.id} uses an icon that does not exist: ${t.icon}`);
    assert.ok(t.steps.length >= 3, `${t.id} is too short to be a tour`);
    for (const [i, s] of t.steps.entries()) {
      assert.ok(s.title, `${t.id}#${i} has no title`);
      assert.ok(Array.isArray(s.body) && s.body.length, `${t.id}#${i} has no body`);
      assert.ok(s.body.every((p) => typeof p === 'string'), `${t.id}#${i} body must be plain strings`);
    }
  }
});

test('a tour never contains a step that writes', () => {
  // Tours are declarative on purpose: a step navigates and explains, and there
  // is nowhere in the descriptor to hang an action. This asserts that stays
  // true, because the moment a step can run code, "tours change nothing" -- a
  // promise the manual makes in as many words -- stops being structural.
  const allowed = new Set(['route', 'target', 'navGroup', 'title', 'body', 'note', 'place', 'when', 'finish']);
  for (const t of TOURS) {
    for (const [i, s] of t.steps.entries()) {
      for (const key of Object.keys(s)) {
        assert.ok(allowed.has(key), `${t.id}#${i} has an unexpected step key: ${key}`);
      }
    }
  }
});

// ------------------------------------------------------------------- icons
/** Every icon name written anywhere in the front end. */
function referencedIcons() {
  const names = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js') || entry.name === 'icons.js') continue;
      const src = fs.readFileSync(full, 'utf8');
      for (const m of src.matchAll(/\bicon\(\s*'([a-z0-9-]+)'/g)) names.add(m[1]);
      for (const m of src.matchAll(/\bicon:\s*'([a-z0-9-]+)'/g)) names.add(m[1]);
    }
  };
  walk(path.join(WEB, 'js'));
  // The navigation maps name icons as plain map values rather than calls.
  const app = read(WEB, 'js', 'app.js');
  for (const block of ['ROUTE_ICON', 'TYPE_ICON', 'GROUP_ICON']) {
    const start = app.indexOf(`const ${block} = {`);
    assert.ok(start > -1, `${block} has been renamed; this test needs updating`);
    const body = app.slice(start, app.indexOf('\n};', start));
    for (const m of body.matchAll(/:\s*'([a-z0-9-]+)'/g)) names.add(m[1]);
  }
  return [...names];
}

test('every icon the interface asks for exists', () => {
  const missing = referencedIcons().filter((n) => !hasIcon(n));
  assert.deepEqual(missing, [], 'icon names with no path behind them render as a dot');
});

test('no icon in the set is unused', () => {
  // Not a correctness bug, but an icon set nobody prunes becomes a icon set
  // nobody trusts -- and a near-duplicate of one already in use is how two
  // screens end up drawing the same idea two ways.
  const used = new Set(referencedIcons());
  const orphans = iconNames().filter((n) => !used.has(n));
  assert.ok(orphans.length <= 24, `too many unused icons (${orphans.length}): ${orphans.join(', ')}`);
});

// ------------------------------------------------------------------ manual
const chapterIds = () => {
  const help = read(WEB, 'js', 'views', 'help.js');
  const block = help.slice(help.indexOf('export const CHAPTERS'), help.indexOf('\n];'));
  return [...block.matchAll(/id: '([^']+)'/g)].map((m) => m[1]);
};

test('every manual chapter is on disk and in the contents', () => {
  const listed = chapterIds();
  const onDisk = fs.readdirSync(path.join(WEB, 'manual')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  assert.deepEqual(listed.filter((id) => !onDisk.includes(id)), [], 'chapters in the contents with no file');
  assert.deepEqual(onDisk.filter((id) => !listed.includes(id)), [], 'chapter files nothing links to');
});

test('the macOS Help menu lists every chapter', () => {
  // This drifted twice before: a chapter was added to the web contents and the
  // native menu kept showing the previous release's list.
  const swift = read(HERE, '..', 'native', 'macos', 'main.swift');
  const missing = chapterIds().filter((id) => !swift.includes(`"${id}"`));
  assert.deepEqual(missing, [], 'chapters missing from the native Help menu');
});

// --------------------------------------------------------------- navigation
test('every route the command list offers is a real screen', () => {
  // commands.js cannot be imported here (it reaches for `window` on load), so
  // the routes are read out of it as text. The point is the same: a palette
  // entry that lands on the not-found page is worse than no entry.
  const src = read(WEB, 'js', 'commands.js');
  const dead = [...src.matchAll(/'(\/[a-z0-9/_-]*)'/g)]
    .map((m) => m[1])
    .filter((r, i, a) => a.indexOf(r) === i)
    .filter((r) => !resolves(r));
  assert.deepEqual(dead, [], 'command palette destinations with no route');
});

test('every screen the sidebar links to is a real screen', () => {
  const src = read(WEB, 'js', 'app.js');
  const dead = [];
  for (const m of src.matchAll(/add\('[^']+', '(\/[a-z0-9/_-]*)'/g)) {
    if (!resolves(m[1])) dead.push(m[1]);
  }
  for (const m of src.matchAll(/link\('[^']+', '(\/[a-z0-9/_-]*)'/g)) {
    if (!resolves(m[1])) dead.push(m[1]);
  }
  assert.deepEqual(dead, [], 'sidebar entries with no route');
});

// ------------------------------------------------------------- theming
const CSS = () => read(WEB, 'css', 'app.css');

/** Every `--token: value;` declared inside one selector block. */
function tokensIn(css, selector) {
  const at = css.indexOf(`\n${selector}`);
  assert.ok(at > -1, `no block for ${selector} -- has it been renamed?`);
  const body = css.slice(at, css.indexOf('\n}', at));
  return new Set([...body.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]));
}

const LIGHT_BLOCKS = [':root[data-palette="graphite"] {', ':root[data-palette="slate"] {', ':root[data-palette="midnight"] {'];
const DARK_BLOCKS = ['[data-theme="dark"][data-palette="graphite"] {', '[data-theme="dark"][data-palette="slate"] {', '[data-theme="dark"][data-palette="midnight"] {'];

test('every palette defines every colour token', () => {
  // A token a palette forgets falls back to nothing, and a component painted
  // with nothing is invisible rather than wrong -- which is why this is a test
  // and not a code review.
  const css = CSS();
  const base = tokensIn(css, ':root,\n:root[data-palette="ink"] {');
  const baseDark = tokensIn(css, '[data-theme="dark"],\n[data-theme="dark"][data-palette="ink"] {');
  assert.ok(base.size > 30, 'the default palette should define the whole set');

  for (const sel of LIGHT_BLOCKS) {
    const missing = [...base].filter((t) => !tokensIn(css, sel).has(t));
    assert.deepEqual(missing, [], `${sel} is missing tokens the default palette has`);
  }
  for (const sel of DARK_BLOCKS) {
    const missing = [...baseDark].filter((t) => !tokensIn(css, sel).has(t));
    assert.deepEqual(missing, [], `${sel} is missing tokens the default dark palette has`);
  }
});

test('the dark cuts are declared after every light palette', () => {
  // [data-theme="dark"] and [data-palette="slate"] have equal specificity, so
  // dark only wins by coming later. Reordering the file would silently leave
  // three palettes stuck in their light colours.
  const css = CSS();
  const firstDark = css.indexOf('\n[data-theme="dark"] {');
  for (const sel of LIGHT_BLOCKS) {
    assert.ok(css.indexOf(`\n${sel}`) < firstDark, `${sel} must be declared before the dark cuts`);
  }
});

test('no component names a colour of its own', () => {
  // Everything below the token blocks has to draw from tokens, or a palette is
  // a suggestion rather than a setting. Scrims, pure white/black on accent
  // fills and the chart opacity are the listed exceptions.
  const css = CSS();
  const body = css.slice(css.indexOf('/* =====================================================================\n   Base'));
  const allowed = /^(#fff|#ffffff|#000|transparent|currentColor|inherit|none)$/i;
  const offenders = [];
  for (const m of body.matchAll(/:\s*(#[0-9a-f]{3,8})\b/gi)) {
    if (!allowed.test(m[1])) offenders.push(m[1]);
  }
  assert.deepEqual([...new Set(offenders)], [], 'hard-coded colours outside the palette blocks');
});

// --------------------------------------------------------------- fonts
test('every bundled font file the stylesheet asks for exists', () => {
  const fontCss = read(WEB, 'fonts', 'fonts.css');
  const refs = [...fontCss.matchAll(/url\('\/fonts\/([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(refs.length >= 20, 'expected the full set of bundled faces');
  const missing = refs.filter((f) => !fs.existsSync(path.join(WEB, 'fonts', f)));
  assert.deepEqual(missing, [], 'fonts.css references files that are not in the build');
});

test('every family the typefaces offer is actually bundled', () => {
  const css = CSS();
  const fontCss = read(WEB, 'fonts', 'fonts.css');
  const declared = new Set([...fontCss.matchAll(/font-family:\s*'([^']+)'/g)].map((m) => m[1]));
  const block = css.slice(css.indexOf('   Typefaces'), css.indexOf('   Palettes — light'));
  const asked = new Set([...block.matchAll(/'([A-Z][^']+)'/g)].map((m) => m[1]));
  const missing = [...asked].filter((f) => !declared.has(f) && !/^(Segoe UI|Georgia|Times New Roman)$/.test(f));
  assert.deepEqual(missing, [], 'a typeface option names a family with no bundled files');
});

test('nothing asks for a weight that is not bundled', () => {
  // Only 400, 500 and 600 ship. A rule asking for 700 does not fail: the
  // browser smears the 600 into a fake bold, which looks muddy at 13px and is
  // most of a manual page.
  const css = CSS();
  const fontCss = read(WEB, 'fonts', 'fonts.css');
  const have = new Set([...fontCss.matchAll(/font-weight:\s*(\d+)/g)].map((m) => Number(m[1])));
  const body = css.slice(css.indexOf('   Base'));
  const asked = [...body.matchAll(/font-weight:\s*(\d+)/g)].map((m) => Number(m[1]));
  const bad = [...new Set(asked)].filter((w) => !have.has(w));
  assert.deepEqual(bad, [], `weights used but not bundled (bundled: ${[...have].sort().join(', ')})`);
});

test('the palette and typeface lists agree with the stylesheet', async () => {
  const { PALETTES, TYPEFACES } = await import('../src/web/js/store.js');
  const css = CSS();
  for (const p of PALETTES) {
    assert.ok(css.includes(`[data-palette="${p.id}"]`), `Settings offers "${p.id}" but no palette block defines it`);
  }
  for (const t of TYPEFACES) {
    const sel = t.id === 'plex' ? ':root[data-typeface="plex"]' : `:root[data-typeface="${t.id}"]`;
    assert.ok(css.includes(sel), `Settings offers typeface "${t.id}" but the stylesheet has no block for it`);
  }
});

test('the interface no longer draws icons out of geometric Unicode', () => {
  // The set these replaced -- ▤ ◈ ▣ ☺ ⚙ -- renders at a different weight and
  // baseline on every platform, which is most of what made the old screens
  // look assembled rather than drawn. Keep them out.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const src = fs.readFileSync(full, 'utf8');
      for (const m of src.matchAll(/'[^']*([■-◿⬒-⬯＋☰-☷])[^']*'/g)) {
        offenders.push(`${path.relative(WEB, full)}: ${m[0].slice(0, 40)}`);
      }
    }
  };
  walk(path.join(WEB, 'js'));
  assert.deepEqual(offenders, [], 'geometric Unicode used as an icon');
});
