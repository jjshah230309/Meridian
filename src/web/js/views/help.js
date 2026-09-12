// Meridian ERP :: web/views/help
// The manual, in the application.
//
// Documentation that lives somewhere else is documentation nobody reads. This
// is the same manual the Help menu opens, rendered from Markdown that ships
// inside the app, so it works with no network and cannot drift out of step
// with the build it came with.
import { h, mount, clear } from '../dom.js';
import { icon } from '../icons.js';
import { render } from '../markdown.js';
import { empty, loading } from '../ui.js';
import * as shortcuts from '../shortcuts.js';
import { showShortcutSheet } from '../commands.js';

/** The manual, in reading order. */
export const CHAPTERS = [
  { id: '01-getting-started', title: 'Getting started', group: 'Start here' },
  { id: '19-guided-tours', title: 'Guided tours', group: 'Start here' },
  { id: '02-everyday', title: 'Working day to day', group: 'Start here' },
  { id: '03-money-in', title: 'Money coming in', group: 'The business' },
  { id: '14-subscriptions', title: 'Subscriptions', group: 'The business' },
  { id: '04-money-out', title: 'Money going out', group: 'The business' },
  { id: '05-stock', title: 'Stock', group: 'The business' },
  { id: '06-ledger', title: 'The ledger', group: 'The business' },
  { id: '15-intercompany', title: 'Intercompany', group: 'The business' },
  { id: '17-fixed-assets', title: 'Fixed assets', group: 'The business' },
  { id: '18-accounting-books', title: 'Accounting books', group: 'The business' },
  { id: '07-reporting', title: 'Reporting', group: 'The business' },
  { id: '08-operations', title: 'Operations', group: 'The business' },
  { id: '09-tax', title: 'Tax', group: 'The business' },
  { id: '10-setup-admin', title: 'Setup and administration', group: 'Running it' },
  { id: '16-custom-records', title: 'Custom records', group: 'Running it' },
  { id: '11-data', title: 'Data and backups', group: 'Running it' },
  { id: '12-server', title: 'Running on a server', group: 'Running it' },
  { id: '13-troubleshooting', title: 'When something goes wrong', group: 'Running it' },
];

const cache = new Map();

async function chapter(id) {
  if (cache.has(id)) return cache.get(id);
  const res = await fetch(`/manual/${id}.md`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`That chapter is missing from this build (${res.status}).`);
  const parsed = render(await res.text());
  cache.set(id, parsed);
  return parsed;
}

export async function helpView(route, { go }) {
  const requested = route.parts[1];
  const active = CHAPTERS.some((c) => c.id === requested) ? requested : CHAPTERS[0].id;
  const anchor = route.parts[2] || null;

  const host = h('div');
  const nav = h('div.doc-nav');
  const body = h('div.doc-body.manual');

  function drawNav(headings) {
    clear(nav);
    let lastGroup = null;
    for (const c of CHAPTERS) {
      if (c.group !== lastGroup) {
        lastGroup = c.group;
        nav.appendChild(h('div.doc-nav-group', c.group));
      }
      nav.appendChild(h('button', {
        class: c.id === active ? 'active' : '',
        onclick: () => go(`/help/${c.id}`),
      }, c.title));
      // The contents of the chapter you are in, so a long one is navigable.
      if (c.id === active && headings?.length) {
        for (const heading of headings.filter((x) => x.level === 2)) {
          nav.appendChild(h('button', {
            style: { paddingLeft: 'var(--s5)', fontSize: 'var(--t-xs)' },
            onclick: () => document.getElementById(heading.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
          }, heading.text));
        }
      }
    }
    nav.appendChild(h('div.doc-nav-group', 'Reference'));
    nav.appendChild(h('button', { onclick: () => go('/learn') }, 'Learning centre'));
    nav.appendChild(h('button', { onclick: () => showShortcutSheet() }, 'Keyboard shortcuts'));
    nav.appendChild(h('button', { onclick: () => go('/settings') }, 'Settings'));
  }

  async function load() {
    mount(body, loading('Opening the manual'));
    drawNav(null);
    try {
      const { html, headings } = await chapter(active);
      body.innerHTML = html;
      // In-app links (#/help/..., #/settings) go through the router rather
      // than reloading the page under the application.
      for (const link of body.querySelectorAll('a[href^="#/"], a[href^="/"]')) {
        link.addEventListener('click', (e) => {
          const href = link.getAttribute('href');
          if (href.startsWith('#/')) { e.preventDefault(); go(href.slice(1)); }
        });
      }
      drawNav(headings);
      if (anchor) {
        setTimeout(() => document.getElementById(anchor)?.scrollIntoView({ block: 'start' }), 40);
      } else {
        document.querySelector('.main')?.scrollTo({ top: 0 });
      }
    } catch (e) {
      mount(body, empty('That chapter could not be opened', e.message));
      drawNav(null);
    }
  }

  load();
  return h('div.page',
    h('div.page-head',
      h('div.titles',
        h('h1', 'Help'),
        h('div.page-sub',
          'The complete manual. Press ', shortcuts.renderKeys('mod+k'),
          ' to search the application itself, or ', shortcuts.renderKeys('?'),
          ' for the keyboard shortcuts.')),
      h('div.page-actions',
        h('button.btn.primary', { onclick: () => go('/learn') }, icon('graduation-cap', { size: 14 }), 'Guided tours'),
        h('button.btn', { onclick: () => showShortcutSheet() }, icon('command', { size: 14 }), 'Keyboard shortcuts'),
        h('button.btn', { onclick: () => go('/settings') }, icon('sliders', { size: 14 }), 'Settings'))),
    h('div.doc-layout', nav, body));
}
