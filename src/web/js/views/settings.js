// Meridian ERP :: web/views/settings
// Everything that can be adjusted, in one place, explained.
//
// A settings screen fails in two ways. It hides things — the option exists
// but lives in a modal three clicks inside a feature nobody opens. Or it
// dumps them — sixty switches in a column with names only their author
// understands.
//
// So this is a document: sections down the left, one row per setting, and
// each row says what it does in a sentence before it offers the control. A
// setting nobody can explain in a sentence is usually a setting that should
// not exist.
import { h, mount, clear } from '../dom.js';
import { icon } from '../icons.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import * as store from '../store.js';
import * as shortcuts from '../shortcuts.js';
import { showShortcutSheet } from '../commands.js';
import { empty, notifyError, notifyOk, loading, modal, confirm } from '../ui.js';

const SECTIONS = [
  { id: 'appearance', title: 'Appearance', group: 'This computer' },
  { id: 'keyboard', title: 'Keyboard', group: 'This computer' },
  { id: 'behaviour', title: 'Behaviour', group: 'This computer' },
  { id: 'connection', title: 'Connection', group: 'This computer' },
  { id: 'company', title: 'Company', group: 'Company' },
  { id: 'accounting', title: 'Accounting', group: 'Company' },
  { id: 'people', title: 'Users & roles', group: 'Company' },
  { id: 'data', title: 'Data & backups', group: 'Company' },
  { id: 'about', title: 'About', group: 'Company' },
];

/** One row: what it is, what it does, and the control that changes it. */
const setting = (label, help, control, opts = {}) => h('div.setting', { class: opts.stacked ? 'stacked' : '' },
  h('div', h('div.s-label', label), help ? h('div.s-help', help) : null),
  h('div.s-control', control));

const choices = (options, current, onPick) => h('div.choice-row',
  ...options.map(([value, label, iconName]) => h('button.choice', {
    class: value === current ? 'active' : '',
    onclick: () => onPick(value),
  }, iconName ? icon(iconName, { size: 14 }) : null, label)));

/**
 * Colour and type are picked by looking, not by reading a list of names.
 *
 * The swatches are painted from a table here rather than read out of the
 * stylesheet: getComputedStyle can only tell you the palette that is on, and
 * the whole job of this control is to show you the three that are not.
 */
const PALETTE_CHIPS = {
  ink: ['#17140F', '#9C620E', '#F7F4EF'],
  graphite: ['#1C1B19', '#156F4A', '#F6F5F2'],
  slate: ['#16202B', '#0E6F72', '#F3F5F7'],
  midnight: ['#14152B', '#5546C8', '#F5F5FB'],
};

const palettePicker = (current, onPick) => h('div.swatch-row',
  ...store.PALETTES.map((pal) => h('button.swatch', {
    class: pal.id === current ? 'active' : '',
    title: pal.note,
    onclick: () => onPick(pal.id),
  },
    h('div.swatch-chips',
      ...(PALETTE_CHIPS[pal.id] || []).map((c, i) => h('i', { class: i === 2 ? 'wide' : '', style: { background: c } }))),
    h('div.swatch-body',
      h('div.swatch-name', pal.name, pal.id === current && icon('check', { size: 13 })),
      h('div.swatch-note', pal.note)))));

const typefacePicker = (current, onPick) => h('div.type-row',
  ...store.TYPEFACES.map((face) => h('button.type-card', {
    class: `tf-${face.id}${face.id === current ? ' active' : ''}`,
    onclick: () => onPick(face.id),
  },
    h('div.specimen', 'Aa'),
    h('div.figures', '1,284  ·  $664,039'),
    h('div.type-name', face.name, face.id === current ? ' ✓' : ''),
    h('div.type-note', face.note))));

export async function settingsView(route, { go }) {
  const host = h('div');
  let active = SECTIONS.some((s) => s.id === route.parts[1]) ? route.parts[1] : 'appearance';
  let data = null;

  const nav = h('div.doc-nav');
  const body = h('div.doc-body');

  function drawNav() {
    clear(nav);
    let lastGroup = null;
    for (const s of SECTIONS) {
      if (s.group !== lastGroup) {
        lastGroup = s.group;
        nav.appendChild(h('div.doc-nav-group', s.group));
      }
      nav.appendChild(h('button', {
        class: s.id === active ? 'active' : '',
        onclick: () => { active = s.id; go(`/settings/${s.id}`); },
      }, s.title));
    }
  }

  async function load() {
    mount(host, loading('Reading your settings'));
    try {
      const [company, connection] = await Promise.all([
        API.companySettings().catch(() => null),
        API.connectionSettings().catch((e) => ({ $error: e.message })),
      ]);
      data = { company, connection };
      render();
    } catch (e) {
      mount(host, empty('Could not open settings', e.message));
    }
  }

  function render() {
    drawNav();
    clear(body);
    body.appendChild(SECTION_RENDERERS[active](data, { go, reload: load }));
    mount(host,
      h('div.page-head',
        h('div.titles',
          h('h1', 'Settings'),
          h('div.page-sub', 'How this copy of Meridian looks, behaves and connects, and how your company is set up.'))),
      h('div.doc-layout', nav, body));
  }

  load();
  return h('div.page', host);
}

// =============================================================== sections
const SECTION_RENDERERS = {
  appearance: () => h('section.doc-section',
    h('h2', 'Appearance'),
    h('p.lede', 'These are stored on this computer, for you. Somebody else signing in here — or you signing in elsewhere — gets their own.'),
    setting('Colour scheme',
      'Each one is a complete palette with its own light and dark cut, so this and the theme below are separate choices.',
      palettePicker(store.state.palette, (value) => {
        store.setPalette(value);
        window.__meridianGo('/settings/appearance');
      }), { stacked: true }),
    setting('Typeface',
      'All four ship inside the application, so they work with no network. Each brings its own type scale, because the same pixel size reads differently in different families.',
      typefacePicker(store.state.typeface, (value) => {
        store.setTypeface(value);
        window.__meridianGo('/settings/appearance');
      }), { stacked: true }),
    setting('Theme', 'Dark is easier on the eyes in a dim room; light is easier to read in a bright one.',
      choices([['light', 'Light', 'sun'], ['dark', 'Dark', 'moon'], ['system', 'Match the system', 'eye']],
        localStorage.getItem('meridian.theme.mode') || (localStorage.getItem('meridian.theme') || 'light'),
        (value) => {
          try { localStorage.setItem('meridian.theme.mode', value); } catch { /* private mode */ }
          if (value === 'system') {
            const prefers = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
            store.setTheme(prefers);
          } else store.setTheme(value);
          window.__meridianGo('/settings/appearance');
        })),
    setting('Density', 'Compact fits about a third more rows on a screen by tightening the padding. Nothing is hidden either way.',
      choices([['comfortable', 'Comfortable'], ['compact', 'Compact']],
        document.documentElement.dataset.density || 'comfortable',
        (value) => { store.setDensity(value); window.__meridianGo('/settings/appearance'); })),
    setting('Text size',
      `Scales the whole interface. ${shortcuts.MOD}+ and ${shortcuts.MOD}− do the same thing from anywhere, and ${shortcuts.MOD}0 puts it back.`,
      h('div.row', { style: { gap: 'var(--s2)', alignItems: 'center' } },
        h('button.btn', { onclick: () => { shortcuts.stepZoom(-1); window.__meridianGo('/settings/appearance'); } }, '−'),
        h('span', { style: { minWidth: '52px', textAlign: 'center', fontVariantNumeric: 'tabular-nums' } },
          `${Math.round(shortcuts.currentZoom() * 100)}%`),
        h('button.btn', { onclick: () => { shortcuts.stepZoom(1); window.__meridianGo('/settings/appearance'); } }, '+'),
        h('button.btn.ghost', { onclick: () => { shortcuts.applyZoom(1); window.__meridianGo('/settings/appearance'); } }, 'Reset'))),
    setting('Sidebar', 'Collapse it to icons when you know where everything is.',
      h('button.btn', {
        onclick: () => {
          const shell = document.querySelector('#shell');
          shell?.classList.toggle('collapsed');
          store.setPref('sidebar.collapsed', !!shell?.classList.contains('collapsed'));
        },
      }, 'Toggle sidebar'))),

  keyboard: () => {
    const bound = shortcuts.available().filter((c) => c.keys);
    return h('section.doc-section',
      h('h2', 'Keyboard'),
      h('p.lede', `Everything the application can do has a name, and most of it has a key. ${shortcuts.MOD}K opens the command palette, which searches the same list — so a shortcut you have not learnt is one you can still find.`),
      setting('Command palette', 'Search every screen, action and setting by name, then run it.',
        h('button.btn.primary', { onclick: () => shortcuts.openPalette() },
          'Open palette  ', shortcuts.renderKeys('mod+k'))),
      setting('All shortcuts', `${bound.length} bindings, grouped. Also on Help → Keyboard Shortcuts.`,
        h('button.btn', { onclick: () => showShortcutSheet() }, 'Show the list  ', shortcuts.renderKeys('?'))),
      h('h3', { style: { marginTop: 'var(--s6)' } }, 'The ones worth learning first'),
      h('table.shortcut-table', h('tbody',
        ...['app.palette', 'app.search', 'go.dashboard', 'new.invoice', 'view.theme', 'app.settings', 'app.help']
          .map((id) => shortcuts.get(id))
          .filter(Boolean)
          .map((c) => h('tr', h('td', c.title), h('td', shortcuts.renderKeys(c.keys)))))));
  },

  behaviour: () => h('section.doc-section',
    h('h2', 'Behaviour'),
    h('p.lede', 'Small choices about how the application acts, stored on this computer.'),
    setting('Opening screen', 'Where Meridian lands when it starts.',
      h('select', {
        onchange: (e) => { store.setPref('ui.home', e.target.value); notifyOk('Saved.'); },
      }, ...[['/', 'Dashboard'], ['/reports', 'Reports'], ['/list/invoice', 'Invoices'], ['/collections', 'Collections']]
        .map(([value, label]) => h('option', { value, selected: store.getPref('ui.home', '/') === value }, label)))),
    setting('Rows per page', 'How many records a list loads before you page.',
      h('select', {
        onchange: (e) => { store.setPref('ui.pageSize', Number(e.target.value)); notifyOk('Saved.'); },
      }, ...[25, 50, 100, 200].map((n) => h('option', { value: n, selected: store.getPref('ui.pageSize', 50) === n }, String(n))))),
    setting('Confirm before leaving an edited form',
      'Warns if you navigate away from a document with unsaved changes.',
      h('label.field.checkbox',
        h('input', {
          type: 'checkbox', checked: store.getPref('ui.confirmLeave', true) !== false,
          onchange: (e) => { store.setPref('ui.confirmLeave', e.target.checked); notifyOk('Saved.'); },
        }),
        h('span', 'Warn me'))),
    setting('Guided tours',
      'Which walkthroughs you have finished. Clearing this offers them all again and restores the Getting started panel on the dashboard.',
      h('div.row.wrap',
        h('button.btn', { onclick: () => window.__meridianGo('/learn') }, 'Learning centre'),
        h('button.btn', {
          onclick: async () => {
            const { resetTourProgress } = await import('../tour.js');
            resetTourProgress();
            store.setPref('onboarding.hidden', false);
            notifyOk('Tours reset. They will be offered again.');
          },
        }, 'Start over'))),
    setting('Reset everything on this computer',
      'Clears theme, density, zoom, saved column layouts and dashboard arrangement. Your data is untouched.',
      h('button.btn.danger', {
        onclick: async () => {
          const ok = await confirm({
            title: 'Reset local settings?',
            message: 'Theme, density, zoom, column layouts and your dashboard arrangement go back to their defaults.',
            detail: 'Nothing in your company file changes. Other people are unaffected.',
            confirmLabel: 'Reset them', danger: true,
          });
          if (!ok) return;
          for (const key of Object.keys(localStorage)) {
            if (key.startsWith('meridian.')) localStorage.removeItem(key);
          }
          window.location.reload();
        },
      }, 'Reset local settings'))),

  connection: (data, { reload }) => {
    const c = data.connection;
    if (c?.$error) {
      return h('section.doc-section',
        h('h2', 'Connection'),
        h('div.callout.warn', 'These settings are only visible to the account owner.'));
    }
    const running = c.running;
    const modeInput = { value: c.mode };
    const remoteUrl = h('input', { type: 'url', value: c.remote.url || '', placeholder: 'https://meridian.yourcompany.local:8422' });
    const serverHost = h('input', { type: 'text', value: c.server.host || '0.0.0.0' });
    const serverPort = h('input', { type: 'number', value: String(c.server.port || 8422), min: '1', max: '65535' });
    const tlsCert = h('input', { type: 'text', value: c.server.tls.cert || '', placeholder: '/etc/ssl/meridian.crt' });
    const tlsKey = h('input', { type: 'text', value: c.server.tls.key || '', placeholder: '/etc/ssl/meridian.key' });
    const modeBox = h('div');

    const drawMode = () => {
      clear(modeBox);
      modeBox.appendChild(choices([
        ['local', 'On this computer', 'home'],
        ['remote', 'On a server', 'exchange'],
        ['server', 'This IS the server', 'database'],
      ], modeInput.value, (value) => { modeInput.value = value; drawMode(); drawDetail(); }));
    };
    const detail = h('div', { style: { marginTop: 'var(--s4)' } });
    const drawDetail = () => {
      clear(detail);
      if (modeInput.value === 'local') {
        detail.appendChild(h('div.callout',
          'Meridian runs on this computer and keeps your company file here. Nothing leaves the machine. This is the right choice for one person, or for trying it out.'));
      } else if (modeInput.value === 'remote') {
        detail.appendChild(h('div.callout',
          'This computer becomes a client. The company file lives on the server you name below, everybody works on the same data, and this machine keeps none of it.'));
        detail.appendChild(h('div.field', h('label', 'Server address'), remoteUrl,
          h('div.help', 'The address the server prints when it starts, for example https://meridian.yourcompany.local:8422. It has to be reachable from this computer.')));
        detail.appendChild(h('div.row', { style: { gap: 'var(--s2)' } },
          h('button.btn', {
            onclick: async (e) => {
              const btn = e.currentTarget;
              btn.disabled = true; btn.textContent = 'Checking…';
              try {
                const res = await fetch(`${remoteUrl.value.replace(/\/+$/, '')}/health`, { mode: 'cors' });
                const json = await res.json();
                notifyOk(`Reached Meridian ${json.version} at that address.`, 'Server found');
              } catch (err) {
                notifyError(new Error(`Could not reach that address. ${err.message}`));
              } finally { btn.disabled = false; btn.textContent = 'Test the connection'; }
            },
          }, 'Test the connection')));
      } else {
        detail.appendChild(h('div.callout',
          'This computer serves everybody else. It listens on the network, holds the company file, and should be a machine that stays on. Install it as a service so it starts without anybody logging in.'));
        detail.appendChild(h('div.form-grid',
          h('div.field', h('label', 'Listen on'), serverHost,
            h('div.help', '0.0.0.0 means every network this machine is on. Name one address to restrict it.')),
          h('div.field', h('label', 'Port'), serverPort),
          h('div.field', h('label', 'TLS certificate'), tlsCert,
            h('div.help', 'Leave both empty to serve plain HTTP — only safe behind a reverse proxy you control.')),
          h('div.field', h('label', 'TLS private key'), tlsKey)));
        detail.appendChild(h('div.callout',
          h('strong', 'To install it as a service: '),
          h('code', 'node scripts/service.mjs install'),
          ' on this machine. It starts at boot and restarts if it stops.'));
      }
    };
    drawMode();
    drawDetail();

    return h('section.doc-section',
      h('h2', 'Connection'),
      h('p.lede', 'Where your company file lives and who can reach it. Changing this takes effect the next time Meridian starts.'),
      h('div.card', { style: { marginBottom: 'var(--s5)' } },
        h('div.card-head', h('h2', 'Right now')),
        h('div.card-body',
          h('dl.facts',
            h('dt', 'Running as'), h('dd', running.mode === 'server' ? 'A server on the network' : 'A desktop copy'),
            h('dt', 'Address'), h('dd', h('span.mono', `${running.tls ? 'https' : 'http'}://${running.host}:${running.port}/`)),
            h('dt', 'Company file'), h('dd', h('span.mono', running.data_dir)),
            h('dt', 'Settings file'), h('dd', h('span.mono', c.file)),
            h('dt', 'Version'), h('dd', running.version)),
          running.addresses?.length
            ? h('div', { style: { marginTop: 'var(--s3)' } },
              h('div.s-help', 'Other computers can reach this server at:'),
              ...running.addresses.map((a) => h('div', h('code', a))))
            : null)),
      setting('Where the data lives', 'Pick how this copy of Meridian is used.', modeBox, { stacked: true }),
      detail,
      h('div.row', { style: { marginTop: 'var(--s5)', gap: 'var(--s2)' } },
        h('button.btn.primary', {
          onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
              await API.saveConnectionSettings({
                mode: modeInput.value,
                remote: { url: remoteUrl.value.trim(), verify_tls: true },
                server: {
                  host: serverHost.value.trim() || '0.0.0.0',
                  port: Number(serverPort.value) || 8422,
                  tls: { cert: tlsCert.value.trim(), key: tlsKey.value.trim() },
                },
              });
              notifyOk('Saved. Quit and reopen Meridian for it to take effect.', 'Connection updated');
              reload();
            } catch (err) { notifyError(err); } finally { btn.disabled = false; }
          },
        }, 'Save connection settings')));
  },

  company: (data, { go }) => {
    const t = data.company?.tenant;
    if (!t) return h('section.doc-section', h('h2', 'Company'), h('div.callout.warn', 'Your role cannot see company settings.'));
    const counts = data.company.counts || {};
    return h('section.doc-section',
      h('h2', 'Company'),
      h('p.lede', 'Who you are, in the eyes of the ledger. These apply to everybody.'),
      setting('Name', 'Appears on statements, remittances, invoices and every document you send.',
        h('div', h('strong', t.name))),
      setting('Base currency', 'What the accounts are kept in. It cannot change once anything is posted.',
        h('div', h('strong', t.base_currency))),
      setting('Subsidiaries', `${(data.company.subsidiaries || []).length} on file. Each keeps its own base currency and its own books.`,
        h('button.btn', { onclick: () => go('/list/subsidiary') }, 'Manage subsidiaries')),
      setting('Custom records', 'Registers this company keeps that Meridian does not ship with — they behave like any other record once defined.',
        h('button.btn', { onclick: () => go('/custom-records') }, 'Define record types')),
      setting('What is on file', 'A rough measure of how much is in here.',
        h('div.s-help',
          `${fmt.num(counts.customers || 0)} customers · ${fmt.num(counts.vendors || 0)} suppliers · `
          + `${fmt.num(counts.items || 0)} items · ${fmt.num(counts.transactions || 0)} transactions`)),
      setting('Everything else', 'Numbering, posting accounts, tax codes, currencies, workflows and custom fields.',
        h('button.btn.primary', { onclick: () => go('/setup') }, 'Open Setup')));
  },

  accounting: (data, { go }) => h('section.doc-section',
    h('h2', 'Accounting'),
    h('p.lede', 'The rules the ledger follows. Changing any of these changes what posts where, so they are deliberately not one-click.'),
    setting('Chart of accounts', 'Every account, its type, and what it is used for by default.',
      h('button.btn', { onclick: () => go('/chart') }, 'Open the chart')),
    setting('Accounting periods', 'Which months are open, closed or locked. A closed period refuses new postings.',
      h('button.btn', { onclick: () => go('/periods') }, 'Period close')),
    setting('Posting accounts', 'Which account receivables, payables, inventory, tax and the rest land on.',
      h('button.btn', { onclick: () => go('/setup') }, 'Setup → Posting accounts')),
    setting('Recurring journals', 'Standing entries and month-end accruals that post themselves.',
      h('button.btn', { onclick: () => go('/recurring') }, 'Recurring journals')),
    setting('Cost allocations', 'Spreading shared cost across departments by weight or by headcount.',
      h('button.btn', { onclick: () => go('/allocations') }, 'Allocation schedules')),
    setting('Currency revaluation', 'Restating open foreign-currency balances at the closing rate.',
      h('button.btn', { onclick: () => go('/revaluation') }, 'Revaluation'))),

  people: (data, { go }) => h('section.doc-section',
    h('h2', 'Users & roles'),
    h('p.lede', 'Who can sign in, and what each of them is allowed to see and change.'),
    setting('People', `${data.company?.counts?.users ?? '—'} accounts. Adding one sends nothing — you give them the password yourself.`,
      h('button.btn', { onclick: () => go('/setup') }, 'Manage users')),
    setting('Roles and permissions', 'Five levels per record type, from none to full, plus row-level restrictions.',
      h('button.btn', { onclick: () => go('/setup') }, 'Manage roles')),
    setting('Your password', 'At least ten characters, with upper case, lower case and a digit.',
      h('button.btn', { onclick: () => document.querySelector('.topbar .avatar')?.click() }, 'Change password')),
    setting('API tokens', 'For Power BI, Excel and anything else that reads Meridian unattended.',
      h('button.btn', { onclick: () => go('/setup') }, 'Manage tokens'))),

  data: (data, { go }) => h('section.doc-section',
    h('h2', 'Data & backups'),
    h('p.lede', 'Your company file is a single SQLite database. It can be copied, backed up and moved like any other file — as long as nothing is writing to it at the time.'),
    setting('Import', 'CSV, bank statements in OFX, QFX, BAI2 and CAMT.053, and JSON. Everything is previewed and validated before a single row is written.',
      h('button.btn', { onclick: () => go('/data') }, 'Import data')),
    setting('Export', 'Any list as CSV or a styled workbook, the financial statements as a PDF pack, and a live feed for Power BI.',
      h('button.btn', { onclick: () => go('/data') }, 'Export data')),
    setting('Backups', 'Takes a consistent snapshot while the server is running. Keep the last fourteen by default.',
      h('div',
        h('code', 'node scripts/backup.mjs create'),
        h('div.s-help', { style: { marginTop: 'var(--s2)' } },
          'Run it on the machine holding the data. ', h('code', 'restore --from <file>'), ' puts one back.'))),
    setting('Where it is', 'The folder holding the database, its write-ahead log and any backups.',
      h('code', data.connection?.running?.data_dir || 'unknown'))),

  about: (data) => h('section.doc-section',
    h('h2', 'About'),
    h('p.lede', 'Meridian ERP — cloud ERP and business management, running entirely on hardware you control.'),
    h('dl.facts',
      h('dt', 'Version'), h('dd', data.connection?.running?.version || '1.0.0'),
      h('dt', 'Company'), h('dd', store.state.tenant.name),
      h('dt', 'Signed in as'), h('dd', `${store.state.user.name} · ${store.state.user.email}`),
      h('dt', 'Roles'), h('dd', store.state.roles.join(', ') || '—')),
    h('div.callout', { style: { marginTop: 'var(--s5)' } },
      'Meridian has no third-party dependencies and makes no outbound connections. '
      + 'Nothing you enter leaves the machine it is entered on unless you export it deliberately.'),
    h('div.row', { style: { marginTop: 'var(--s4)', gap: 'var(--s2)' } },
      h('button.btn', { onclick: () => window.__meridianGo('/help') }, 'Open the manual'),
      h('button.btn', { onclick: () => showShortcutSheet() }, 'Keyboard shortcuts'))),
};

void modal;
