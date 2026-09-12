// Meridian ERP :: web/views/learn
// The Learning centre: where the guided tours live.
//
// An ERP is the kind of software people are usually taught by another person,
// badly, once. This screen is the alternative: a short walkthrough per business
// process, run against the user's own data, plus the manual behind it.
import { h, mount, clear } from '../dom.js';
import { icon } from '../icons.js';
import * as store from '../store.js';
import * as shortcuts from '../shortcuts.js';
import { confirm, toast } from '../ui.js';
import { showShortcutSheet } from '../commands.js';
import { availableTours, completedTours, startTour, resetTourProgress, showWelcome } from '../tour.js';
import { CHAPTERS } from './help.js';

/** The chapters worth surfacing before somebody has found the manual. */
const READING = [
  ['01-getting-started', 'Getting started', 'What everything is called, and where it is.'],
  ['02-everyday', 'Working day to day', 'The rhythm of the week: lists, saved views, approvals, shortcuts.'],
  ['06-ledger', 'The ledger', 'How posting works, and why the subledgers always tie out.'],
  ['07-reporting', 'Reporting', 'Statements, drill-down, and getting data into Excel or Power BI.'],
  ['10-setup-admin', 'Setup and administration', 'Users, roles, custom fields, workflows, numbering.'],
  ['13-troubleshooting', 'When something goes wrong', 'The checks to run, in the order to run them.'],
];

export async function learnView(_route, { go }) {
  const host = h('div');

  function draw() {
    const tours = availableTours();
    const done = completedTours();
    const finished = tours.filter((t) => done.includes(t.id)).length;
    const pct = tours.length ? Math.round((finished / tours.length) * 100) : 0;

    mount(host,
      h('div.page-head',
        h('div.titles',
          h('h1', { dataset: { tour: 'page-title' } }, icon('graduation-cap', { size: 20 }), 'Learning centre'),
          h('div.page-sub',
            'Guided walkthroughs that drive the real application on your own data. ',
            'Nothing in a tour changes anything — every step navigates and explains.')),
        h('div.page-actions',
          h('button.btn', { onclick: () => showShortcutSheet() }, icon('command', { size: 14 }), 'Keyboard shortcuts'),
          h('button.btn', { onclick: () => go('/help') }, icon('book-open', { size: 14 }), 'Open the manual'))),

      // ---- progress
      h('div.card',
        h('div.card-head',
          h('h2', icon('route', { size: 15 }), 'Your progress'),
          h('div.actions',
            h('span.muted', { style: { fontSize: 'var(--t-sm)' } }, `${finished} of ${tours.length} complete`),
            finished > 0 && h('button.btn.sm', {
              onclick: async () => {
                if (await confirm({
                  title: 'Start again?',
                  message: 'This clears which tours you have finished so they are all offered again.',
                  confirmLabel: 'Clear progress',
                })) { resetTourProgress(); draw(); toast('Tour progress cleared', { kind: 'success', timeout: 2400 }); }
              },
            }, 'Clear'))),
        h('div.card-body',
          h('div.progress', { style: { marginBottom: 'var(--s3)' } }, h('i', { style: { width: `${pct}%` } })),
          h('div.track-list', ...tours.map((t) => tourRow(t, done.includes(t.id)))))),

      // ---- reading
      h('div.card',
        h('div.card-head', h('h2', icon('book-open', { size: 15 }), 'Worth reading once')),
        h('div.card-body',
          h('div.two-col',
            h('div.track-list', ...READING.slice(0, 3).map(chapterRow(go))),
            h('div.track-list', ...READING.slice(3).map(chapterRow(go)))),
          h('div.tip', { style: { marginTop: 'var(--s4)' } },
            icon('lightbulb', { size: 14 }),
            h('div', 'The manual has ', h('strong', `${CHAPTERS.length} chapters`),
              ' and ships inside the application, so it works with no network. Press ',
              shortcuts.renderKeys('mod+/'), ' from anywhere.')))),

      // ---- the four ways
      h('div.card',
        h('div.card-head', h('h2', icon('compass', { size: 15 }), 'The four ways to get anywhere')),
        h('div.card-body',
          h('div.two-col',
            h('div.stack',
              wayRow('list', 'The sidebar', 'Browse by part of the business. Filter it by typing, and pin the screens you use every day to the top.'),
              wayRow('search', 'Search', 'Finds records — a customer, an invoice number, an SKU, words in a memo.', 'slash')),
            h('div.stack',
              wayRow('command', 'The command palette', 'Runs actions — open any screen, create any document, change any setting.', 'mod+k'),
              wayRow('plus', 'New', 'Create a document from wherever you are, without losing the screen you are on.'))))),

      h('div.card',
        h('div.card-head', h('h2', icon('life-buoy', { size: 15 }), 'Still stuck')),
        h('div.card-body',
          h('div.row.wrap',
            h('button.btn', { onclick: () => showWelcome() }, icon('play', { size: 14 }), 'Show the welcome screen again'),
            h('button.btn', { onclick: () => go('/help/13-troubleshooting') }, icon('wrench', { size: 14 }), 'Troubleshooting'),
            h('button.btn', { onclick: () => go('/setup') }, icon('settings', { size: 14 }), 'Setup'),
            h('button.btn', { onclick: () => go('/help/12-server') }, icon('database', { size: 14 }), 'Running it on a server')))));
  }

  function tourRow(t, isDone) {
    return h('button.track', {
      class: isDone ? 'done' : '',
      onclick: () => startTour(t.id),
    },
      h('div.track-icon', icon(isDone ? 'check' : (t.icon || 'play'), { size: 16 })),
      h('div.track-body',
        h('div.track-title', t.title, isDone && h('span.tag.green', 'Done')),
        h('div.track-sub', t.blurb)),
      h('div.track-meta',
        h('span', `${t.minutes} min`),
        h('span.muted', `${t.steps.length} steps`),
        icon('chevron-right', { size: 15 })));
  }

  const chapterRow = (go) => ([id, title, sub]) => h('button.track', {
    onclick: () => go(`/help/${id}`),
  },
    h('div.track-icon', icon('file-text', { size: 15 })),
    h('div.track-body',
      h('div.track-title', title),
      h('div.track-sub', sub)),
    h('div.track-meta', icon('chevron-right', { size: 15 })));

  const wayRow = (ic, title, sub, keys) => h('div.row', { style: { alignItems: 'flex-start', gap: 'var(--s3)' } },
    h('div.track-icon', icon(ic, { size: 15 })),
    h('div', { style: { minWidth: 0 } },
      h('div.track-title', title, keys && shortcuts.renderKeys(keys)),
      h('div.track-sub', sub)));

  draw();
  const onProgress = () => draw();
  window.addEventListener('meridian:tour-progress', onProgress);

  return {
    el: h('div.page.narrow', host),
    cleanup: () => window.removeEventListener('meridian:tour-progress', onProgress),
  };
}
