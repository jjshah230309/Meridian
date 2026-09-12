// Meridian ERP :: web/shortcuts
// Every action in the application, addressable from the keyboard.
//
// Three things live here, and they are deliberately one system rather than
// three. A registry of commands — each with a title, a group and a way to run
// it. A key handler that maps chords (⌘K) and sequences (g then d) onto them.
// And a palette that searches the same registry, so anything reachable by a
// shortcut is reachable by typing its name, and a shortcut somebody has not
// learnt yet is discoverable rather than secret.
//
// The alternative — shortcuts scattered through the views that own them — is
// how an application ends up with two keys doing the same thing and a help
// screen that lies.
import { h, mount, clear } from './dom.js';
import { icon, hasIcon } from './icons.js';
import * as store from './store.js';

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? '⌘' : 'Ctrl';
const SYMBOL = {
  mod: MOD, shift: '⇧', alt: isMac ? '⌥' : 'Alt',
  enter: '↵', esc: 'Esc', slash: '/', space: 'Space',
  arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
  escape: 'Esc', backspace: '⌫', tab: '⇥',
};

const registry = new Map();
let sequence = [];
let sequenceTimer = null;
let paletteOpen = null;

/**
 * Register a command.
 *
 * `keys` is either a chord ("mod+k"), a sequence ("g d"), or absent — a
 * command with no key is still in the palette, which is where most of them
 * are found.
 */
export function register(command) {
  registry.set(command.id, { group: 'Actions', ...command });
  return command.id;
}

export const registerAll = (commands) => commands.forEach(register);
export const all = () => [...registry.values()];
export const get = (id) => registry.get(id);

/** Commands the current user can actually run, in palette order. */
export function available() {
  return all()
    .filter((c) => !c.when || safely(c.when))
    .sort((a, b) => (a.group === b.group ? (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title)
      : GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group)));
}

const GROUP_ORDER = ['Go to', 'Create', 'Actions', 'View', 'Application', 'Help'];
const safely = (fn) => { try { return fn(); } catch { return false; } };

// ------------------------------------------------------------- key maps
/** "mod+shift+p" -> a comparable signature for a keyboard event. */
function chordOf(e) {
  const parts = [];
  if (e.metaKey || e.ctrlKey) parts.push('mod');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  parts.push(key === ' ' ? 'space' : key);
  return parts.join('+');
}

/** How a binding is written on screen. */
export function renderKeys(keys) {
  if (!keys) return null;
  if (keys.includes(' ')) {
    const steps = keys.split(' ');
    return h('span.kbd-seq', ...steps.flatMap((step, i) => (
      i === 0 ? [h('span.kbd', step.toUpperCase())] : [h('span.then', 'then'), h('span.kbd', step.toUpperCase())]
    )));
  }
  const parts = keys.split('+').map((p) => SYMBOL[p] || (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)));
  return h('span.kbd-seq', ...parts.map((p) => h('span.kbd', p)));
}

const typingIn = (el) => el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);

/**
 * The one keydown listener.
 *
 * A chord wins over a sequence, and neither fires while somebody is typing
 * unless the binding uses a modifier — ⌘K should work in a search box, `g d`
 * should not turn into two letters going missing from an invoice memo.
 */
export function install() {
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    const chord = chordOf(e);
    const typing = typingIn(document.activeElement);

    // Escape closes the topmost thing, which is never a registered command.
    if (chord === 'escape') { sequence = []; return; }

    for (const command of registry.values()) {
      if (!command.keys || command.keys.includes(' ')) continue;
      if (command.keys !== chord) continue;
      if (typing && !/mod|alt/.test(command.keys)) continue;
      if (command.when && !safely(command.when)) continue;
      e.preventDefault();
      run(command.id);
      return;
    }

    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.length !== 1) return;

    sequence.push(e.key.toLowerCase());
    clearTimeout(sequenceTimer);
    sequenceTimer = setTimeout(() => { sequence = []; }, 900);
    const typed = sequence.join(' ');

    const exact = [...registry.values()].find((c) => c.keys && c.keys.includes(' ') && c.keys === typed);
    if (exact && (!exact.when || safely(exact.when))) {
      e.preventDefault();
      sequence = [];
      run(exact.id);
      return;
    }
    // Still part of a longer binding? Keep waiting. Otherwise give up now so
    // the next keystroke starts fresh.
    const partial = [...registry.values()].some((c) => c.keys && c.keys.includes(' ') && c.keys.startsWith(`${typed} `));
    if (!partial) sequence = [];
  });
}

export function run(id) {
  const command = registry.get(id);
  if (!command) return false;
  try { command.run(); } catch (e) { console.error(`shortcut ${id}:`, e); }
  return true;
}

// -------------------------------------------------------------- palette
/**
 * Everything, by name.
 *
 * Ranked so that a match at the start of a word beats one in the middle:
 * typing "inv" should offer Invoices before Physical Inventory Count.
 */
function score(command, query) {
  if (!query) return 1;
  const title = command.title.toLowerCase();
  const hay = `${title} ${(command.keywords || '').toLowerCase()} ${command.group.toLowerCase()}`;
  if (!query.split(/\s+/).every((word) => hay.includes(word))) return 0;
  if (title.startsWith(query)) return 100;
  if (new RegExp(`\\b${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(title)) return 60;
  if (title.includes(query)) return 30;
  return 10;
}

export function openPalette() {
  if (paletteOpen) return paletteOpen;
  const input = h('input.palette-input', {
    type: 'text', placeholder: 'Search for anything — a screen, an action, a setting…',
    autocomplete: 'off', spellcheck: 'false',
  });
  const list = h('div.palette-list');
  const overlay = h('div.palette-overlay', h('div.palette',
    input, list,
    h('div.palette-foot',
      h('span', renderKeys('arrowup'), ' ', renderKeys('arrowdown'), ' to move'),
      h('span', renderKeys('enter'), ' to run'),
      h('span', renderKeys('esc'), ' to close'))));

  let matches = [];
  let cursor = 0;

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    paletteOpen = null;
  };

  const draw = () => {
    const query = input.value.trim().toLowerCase();
    matches = available()
      .map((c) => ({ c, s: score(c, query) }))
      .filter((m) => m.s > 0)
      .sort((a, b) => b.s - a.s || GROUP_ORDER.indexOf(a.c.group) - GROUP_ORDER.indexOf(b.c.group))
      .slice(0, 40)
      .map((m) => m.c);
    cursor = Math.min(cursor, Math.max(0, matches.length - 1));
    clear(list);
    if (!matches.length) {
      list.appendChild(h('div.palette-empty', `Nothing matches “${input.value.trim()}”.`));
      return;
    }
    let lastGroup = null;
    matches.forEach((command, i) => {
      if (!query && command.group !== lastGroup) {
        lastGroup = command.group;
        list.appendChild(h('div.palette-group', command.group));
      }
      list.appendChild(h('div.palette-item', {
        class: i === cursor ? 'active' : '',
        onmousemove: () => { if (cursor !== i) { cursor = i; draw(); } },
        onclick: () => { close(); run(command.id); },
      },
      h('span.p-icon', hasIcon(command.icon) ? icon(command.icon, { size: 15 }) : (command.icon || '·')),
      h('span', command.title,
        command.subtitle ? h('span.p-sub', ` — ${command.subtitle}`) : null),
      command.keys ? h('span.p-keys', renderKeys(command.keys)) : null));
    });
    list.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
  };

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); cursor = (cursor + 1) % Math.max(1, matches.length); draw(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); cursor = (cursor - 1 + matches.length) % Math.max(1, matches.length); draw(); return; }
    if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      const chosen = matches[cursor];
      close();
      if (chosen) run(chosen.id);
    }
  };

  input.addEventListener('input', () => { cursor = 0; draw(); });
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  draw();
  setTimeout(() => input.focus(), 10);
  paletteOpen = { close };
  return paletteOpen;
}

// ----------------------------------------------------------------- zoom
/**
 * Zoom, for the copy running in a browser.
 *
 * The native desktop host does this properly through WKWebView, which scales
 * everything including the scrollbars. This is the fallback: scale the root
 * font size, which every measurement in the stylesheet is ultimately relative
 * to, and remember the choice.
 */
export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6];

export function applyZoom(level) {
  const z = Math.min(Math.max(Number(level) || 1, ZOOM_STEPS[0]), ZOOM_STEPS[ZOOM_STEPS.length - 1]);
  document.documentElement.style.fontSize = `${Math.round(z * 16)}px`;
  store.setPref('ui.zoom', z);
  return z;
}

export const currentZoom = () => Number(store.getPref('ui.zoom', 1)) || 1;

export function stepZoom(direction) {
  const now = currentZoom();
  const index = ZOOM_STEPS.reduce((best, v, i) => (Math.abs(v - now) < Math.abs(ZOOM_STEPS[best] - now) ? i : best), 0);
  const next = ZOOM_STEPS[Math.min(Math.max(index + direction, 0), ZOOM_STEPS.length - 1)];
  return applyZoom(next);
}

/** The native host asks the page to follow its own zoom, so the two agree. */
window.addEventListener('meridian:zoom', (e) => applyZoom(e.detail?.level ?? 1));
