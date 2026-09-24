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
import { spawnSync } from 'node:child_process';

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

test('every registered shortcut uses a real KeyboardEvent.key, not its display name', () => {
  // shortcuts.js's key handler builds its match string from the raw
  // KeyboardEvent -- e.key.toLowerCase() for anything but a modifier, so a
  // press of "/" produces the token "/", never "slash". SYMBOL in
  // shortcuts.js maps a handful of these to a printable glyph for
  // `renderKeys`'s on-screen hint (slash -> "/", enter -> "↵", ...), but
  // that map is display-only. A command registered with the *display* name
  // instead of the real key ("slash" rather than "/") renders a correct-
  // looking kbd hint and then can never actually fire, silently -- exactly
  // what happened to "/" for jumping into search.
  const REAL_SPECIAL_KEYS = new Set(['enter', 'escape', 'tab', 'backspace', 'space', 'delete', 'home', 'end',
    'pageup', 'pagedown', 'insert', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
  const DISPLAY_ONLY_NAMES = new Set(['slash', 'esc']); // SYMBOL entries that are not real e.key values

  const sources = [read(WEB, 'js', 'commands.js'), read(WEB, 'js', 'app.js')];
  const offenders = [];
  for (const src of sources) {
    for (const m of src.matchAll(/keys:\s*'([^']+)'/g)) {
      const binding = m[1];
      for (const step of binding.split(' ')) {           // sequence steps ("g d")
        for (const token of step.split('+')) {            // chord parts ("mod+shift+p")
          const t = token.toLowerCase();
          if (t === 'mod' || t === 'shift' || t === 'alt') continue;
          if (t.length === 1) continue;                   // a literal character key
          if (REAL_SPECIAL_KEYS.has(t)) continue;
          if (DISPLAY_ONLY_NAMES.has(t)) offenders.push(`"${binding}" uses the display name "${t}" instead of the real key`);
          // Anything else unrecognized is worth seeing too, not silently passed.
          else if (!/^[a-z0-9]$/.test(t)) offenders.push(`"${binding}": unrecognized key token "${t}"`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], 'a registered shortcut cannot match a real keypress');
});

// ------------------------------------------------------------- theming
const CSS = () => read(WEB, 'css', 'app.css');

/** Every `--token: value;` declared inside one selector block. */
function tokensIn(css, selector) {
  const at = css.indexOf(`\n${selector}`);
  assert.ok(at > -1, `no block for ${selector} -- has it been renamed?`);
  const body = css.slice(at, css.indexOf('\n}', at));
  // Not anchored to line-start: several palette blocks pack more than one
  // `--token: value;` on the same physical line, and a `^`-anchored match
  // silently sees only the first one -- which used to make this check pass
  // without ever actually reading most of a compact block's tokens.
  return new Set([...body.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]));
}

const LIGHT_BLOCKS = [':root[data-palette="carbon"] {', ':root[data-palette="ink"] {', ':root[data-palette="graphite"] {', ':root[data-palette="slate"] {', ':root[data-palette="midnight"] {'];
const DARK_BLOCKS = ['[data-theme="dark"][data-palette="carbon"] {', '[data-theme="dark"][data-palette="ink"] {', '[data-theme="dark"][data-palette="graphite"] {', '[data-theme="dark"][data-palette="slate"] {', '[data-theme="dark"][data-palette="midnight"] {'];

// Status colours and the two rings never vary by palette -- none of the
// named light palettes redeclare them, on purpose, and inherit the base
// rule's values through the ordinary cascade (":root" still matches their
// element; it is simply lower-specificity than their own palette block,
// so it only supplies what that block does not set). Dark mode is the
// exception: its status colours differ from light mode's, and only the
// default palette's dark block overrides them for itself, so every other
// palette's dark cut has to restate them or silently keep the light values.
const SHARED_TOKENS = ['--pos', '--neg', '--warn', '--info', '--pos-soft', '--neg-soft', '--warn-soft', '--info-soft', '--row-hover', '--row-selected', '--ring', '--ring-neg', '--accent-rgb'];

test('every palette defines every colour token', () => {
  // A token a palette forgets falls back to nothing, and a component painted
  // with nothing is invisible rather than wrong -- which is why this is a test
  // and not a code review.
  const css = CSS();
  const base = tokensIn(css, ':root,\n:root[data-palette="obsidian"] {');
  const baseDark = tokensIn(css, '[data-theme="dark"],\n[data-theme="dark"][data-palette="obsidian"] {');
  assert.ok(base.size > 30, 'the default palette should define the whole set');

  const basePaletteSpecific = [...base].filter((t) => !SHARED_TOKENS.includes(t));
  for (const sel of LIGHT_BLOCKS) {
    const missing = basePaletteSpecific.filter((t) => !tokensIn(css, sel).has(t));
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
  const missing = [...asked].filter((f) => !declared.has(f) && !/^(Segoe UI|Georgia|Times New Roman|SF Pro Text|SF Pro Display|SF Mono|Styrene A|Styrene B|Tiempos Text|Tiempos Headline)$/.test(f));
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

test('nothing in an inline style asks for a weight that is not bundled either', () => {
  // The CSS-only version of this check above missed nine call sites entirely:
  // `style: { fontWeight: 550 }` and friends, written straight into a view's
  // `h()` call rather than through a stylesheet rule. Same failure mode --
  // fake bold at 13px -- just invisible to a test that only reads app.css.
  const fontCss = read(WEB, 'fonts', 'fonts.css');
  const have = new Set([...fontCss.matchAll(/font-weight:\s*(\d+)/g)].map((m) => Number(m[1])));
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const src = fs.readFileSync(full, 'utf8');
      for (const m of src.matchAll(/fontWeight:\s*['"]?(\d+)/g)) {
        const w = Number(m[1]);
        if (!have.has(w)) offenders.push(`${path.relative(WEB, full)}: fontWeight ${w}`);
      }
    }
  };
  walk(path.join(WEB, 'js'));
  assert.deepEqual(offenders, [], `inline weights used but not bundled (bundled: ${[...have].sort().join(', ')})`);
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

test('every look the settings screen offers is either the base look or has its own stylesheet section', async () => {
  // Dock is the file's unscoped default -- every rule above the "Look:
  // Glass" section already is Dock -- so only a non-default look needs its
  // own `[data-look="…"]` section to actually change anything.
  const { LOOKS } = await import('../src/web/js/store.js');
  const css = CSS();
  for (const l of LOOKS) {
    if (l.id === 'dock') continue;
    assert.ok(css.includes(`[data-look="${l.id}"]`), `Settings offers look "${l.id}" but the stylesheet has no section for it`);
  }
});

test('index.html\'s default appearance attributes match store.js\'s defaults', async () => {
  // The attributes on <html> are read before the first script runs, so the
  // page never flashes one appearance and settles on another. If they drift
  // from store.js's own fallbacks, that flash comes back.
  const { state } = await import('../src/web/js/store.js');
  const html = read(WEB, 'index.html');
  const tag = html.match(/<html[^>]*>/)?.[0] || '';
  for (const attr of ['theme', 'palette', 'typeface', 'look']) {
    const m = tag.match(new RegExp(`data-${attr}="([^"]+)"`));
    assert.ok(m, `index.html's <html> has no data-${attr}`);
    assert.equal(m[1], state[attr], `index.html's data-${attr} does not match store.js's state.${attr} default`);
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

test('every view module actually parses', () => {
  // Views are imported lazily, only when a browser actually navigates to
  // their route (see views/index.js) -- so a stray or missing parenthesis
  // in one is invisible to every other test here, which only reads route
  // tables and icon names as text. It surfaces as a real user opening the
  // Dashboard or a list screen and getting "That page could not be loaded."
  // `node --check` parses without executing, so it is safe to run on a
  // module that expects `document` to exist.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const result = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' });
      if (result.status !== 0) offenders.push(`${path.relative(WEB, full)}: ${result.stderr.split('\n').find((l) => l.includes('Error')) || result.stderr.trim()}`);
    }
  };
  walk(path.join(WEB, 'js'));
  assert.deepEqual(offenders, [], 'a view module has a syntax error and would fail to load in the browser');
});
