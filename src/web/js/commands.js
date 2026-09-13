// Meridian ERP :: web/commands
// What the application can be asked to do, in one list.
//
// Every screen, every global action and every setting is declared here rather
// than wired into the view that happens to own it. That is what lets the
// command palette, the keyboard shortcuts and the Help → Keyboard Shortcuts
// screen all be generated from the same source: three views of one list,
// which cannot drift apart.
import * as shortcuts from './shortcuts.js';
import * as store from './store.js';
import { h } from './dom.js';
import { modal, toast } from './ui.js';

const go = (route) => () => window.__meridianGo(route);
const can = (type, level = store.LEVEL.VIEW) => () => store.can(type, level);

/** Screens, in the order the sidebar shows them. */
const DESTINATIONS = [
  ['go.dashboard', 'Dashboard', 'home', 'g d', '/', null],
  ['go.reports', 'Reports', 'bar-chart', 'g r', '/reports', 'account'],
  ['go.chart', 'Chart of Accounts', 'ledger', 'g a', '/chart', 'account'],
  ['go.journal', 'Journal Entries', 'ledger', 'g j', '/list/journal_entry', 'journal_entry'],
  ['go.banking', 'Banking', 'bank', 'g b', '/bank', 'bank_account'],
  ['go.periods', 'Period Close', 'calendar', null, '/periods', 'accounting_period'],
  ['go.revenue', 'Revenue Recognition', 'trending-up', null, '/revenue', 'schedule'],
  ['go.amortisation', 'Expense Amortisation', 'trending-down', null, '/revenue/amortisation', 'schedule'],
  ['go.recurring', 'Recurring Journals', 'repeat', null, '/recurring', 'recurring_journal'],
  ['go.allocations', 'Cost Allocations', 'split', null, '/allocations', 'allocation_schedule'],
  ['go.revaluation', 'Currency Revaluation', 'exchange', null, '/revaluation', 'revaluation_run'],
  ['go.tax', 'Tax & 1099', 'percent', null, '/tax', 'tax_return'],
  ['go.customers', 'Customers', 'user-check', 'g c', '/list/customer', 'customer'],
  ['go.invoices', 'Invoices', 'invoice', 'g i', '/list/invoice', 'invoice'],
  ['go.orders', 'Sales Orders', 'shopping-cart', 'g o', '/list/sales_order', 'sales_order'],
  ['go.subscriptions', 'Subscriptions', 'repeat', 'g u', '/subscriptions', 'subscription'],
  ['go.intercompany', 'Intercompany', 'exchange', 'g x', '/intercompany', 'intercompany_txn'],
  ['go.customrecords', 'Custom Records', 'puzzle', 'g y', '/custom-records', 'custom_record_type'],
  ['go.assets', 'Fixed Assets', 'factory', 'g f', '/assets', 'fixed_asset'],
  ['go.books', 'Accounting Books', 'layers', 'g m', '/books', 'accounting_book'],
  ['go.collections', 'Collections', 'clock', null, '/collections', 'collections'],
  ['go.deposits', 'Customer Deposits', 'wallet', null, '/list/customer_deposit', 'customer_deposit'],
  ['go.vendors', 'Suppliers', 'truck', 'g v', '/list/vendor', 'vendor'],
  ['go.bills', 'Vendor Bills', 'receipt', 'g l', '/list/vendor_bill', 'vendor_bill'],
  ['go.paybills', 'Pay Bills', 'wallet', 'g p', '/paybills', 'payment_run'],
  ['go.items', 'Items', 'tag', 'g t', '/list/item', 'item'],
  ['go.inventory', 'Stock & Reorder', 'box', 'g s', '/inventory', 'item'],
  ['go.counts', 'Stock Counts', 'clipboard', null, '/list/inventory_count', 'inventory_count'],
  ['go.production', 'Production', 'factory', null, '/production', 'work_order'],
  ['go.warehouse', 'Warehouse', 'package', null, '/warehouse', 'pick_wave'],
  ['go.projects', 'Project Board', 'briefcase', null, '/projects', 'project'],
  ['go.pipeline', 'Pipeline', 'target', 'g k', '/pipeline', 'opportunity'],
  ['go.forecast', 'Forecast', 'trending-up', null, '/forecast', 'opportunity'],
  ['go.dispatch', 'Dispatch', 'map', null, '/dispatch', 'service_order'],
  ['go.people', 'Directory', 'users', 'g e', '/hr/directory', 'employee'],
  ['go.data', 'Import & Export', 'arrows-up-down', null, '/data', 'data_import'],
  ['go.setup', 'Setup', 'settings', null, '/setup', null],
  ['go.learn', 'Learning Centre', 'graduation-cap', null, '/learn', null],
];

/** New documents worth a key of their own. */
const CREATIONS = [
  ['new.invoice', 'New invoice', 'n i', '/txn-new/invoice', 'invoice', 'invoice'],
  ['new.sales_order', 'New sales order', 'n o', '/txn-new/sales_order', 'sales_order', 'shopping-cart'],
  ['new.quote', 'New quote', 'n q', '/txn-new/quote', 'quote', 'file-text'],
  ['new.bill', 'New vendor bill', 'n b', '/txn-new/vendor_bill', 'vendor_bill', 'receipt'],
  ['new.purchase_order', 'New purchase order', 'n p', '/txn-new/purchase_order', 'purchase_order', 'clipboard'],
  ['new.journal', 'New journal entry', 'n j', '/journal-new', 'journal_entry', 'ledger'],
  ['new.customer', 'New customer', 'n c', '/new/customer', 'customer', 'user-check'],
  ['new.vendor', 'New supplier', 'n v', '/new/vendor', 'vendor', 'truck'],
  ['new.item', 'New item', 'n t', '/new/item', 'item', 'tag'],
];

export function registerCommands() {
  for (const [id, title, icon, keys, route, perm] of DESTINATIONS) {
    shortcuts.register({
      id, title, icon, keys, group: 'Go to', run: go(route),
      keywords: route, when: perm ? can(perm) : undefined,
    });
  }
  for (const [id, title, keys, route, perm, iconName] of CREATIONS) {
    shortcuts.register({
      id, title, icon: iconName || 'plus', keys, group: 'Create', run: go(route),
      when: can(perm, store.LEVEL.CREATE),
    });
  }

  shortcuts.registerAll([
    {
      id: 'app.palette', title: 'Command palette', icon: 'command', keys: 'mod+k', group: 'Application',
      subtitle: 'search every screen and action', run: () => shortcuts.openPalette(),
    },
    {
      id: 'app.search', title: 'Search records', icon: 'search', keys: 'slash', group: 'Application',
      subtitle: 'customers, invoices, items', run: () => document.querySelector('.searchbox input')?.focus(),
    },
    {
      id: 'app.settings', title: 'Settings', icon: 'sliders', keys: 'mod+,', group: 'Application',
      run: go('/settings'),
    },
    {
      id: 'app.help', title: 'Help & documentation', icon: 'book-open', keys: 'mod+/', group: 'Help',
      run: go('/help'),
    },
    {
      id: 'app.shortcuts', title: 'Keyboard shortcuts', icon: 'command', keys: '?', group: 'Help',
      run: () => showShortcutSheet(),
    },
    {
      id: 'app.learn', title: 'Learning centre', icon: 'graduation-cap', group: 'Help',
      subtitle: 'guided walkthroughs of each process', run: go('/learn'),
    },
    {
      id: 'app.tour', title: 'Take a guided tour', icon: 'play', group: 'Help',
      subtitle: 'the next one you have not done', order: -1,
      run: async () => {
        const tour = await import('./tour.js');
        const next = tour.suggestedTour() || tour.availableTours()[0];
        if (next) tour.startTour(next.id); else window.__meridianGo('/learn');
      },
    },
    {
      id: 'app.welcome', title: 'Show the welcome screen', icon: 'sparkles', group: 'Help',
      run: async () => (await import('./tour.js')).showWelcome(),
    },
    {
      id: 'view.theme', title: 'Toggle dark mode', icon: 'moon', keys: 'mod+shift+l', group: 'View',
      run: () => store.toggleTheme(),
    },
    {
      id: 'view.palette', title: 'Next colour scheme', icon: 'eye', group: 'View',
      subtitle: 'ink, graphite, slate, midnight',
      run: () => {
        const ids = store.PALETTES.map((p) => p.id);
        const next = ids[(ids.indexOf(store.state.palette) + 1) % ids.length];
        const chosen = store.PALETTES.find((p) => p.id === next);
        store.setPalette(next);
        toast(chosen.name, { kind: 'info', title: 'Colour scheme', timeout: 2200 });
      },
    },
    {
      id: 'view.typeface', title: 'Next typeface', icon: 'file-text', group: 'View',
      subtitle: 'Plex, Source Sans, Inter, Plex Serif',
      run: () => {
        const ids = store.TYPEFACES.map((t) => t.id);
        const next = ids[(ids.indexOf(store.state.typeface) + 1) % ids.length];
        const chosen = store.TYPEFACES.find((t) => t.id === next);
        store.setTypeface(next);
        toast(chosen.name, { kind: 'info', title: 'Typeface', timeout: 2200 });
      },
    },
    {
      id: 'view.appearance', title: 'Appearance settings', icon: 'sliders', group: 'View',
      subtitle: 'colour scheme, typeface, density', run: go('/settings/appearance'),
    },
    {
      id: 'view.density', title: 'Toggle compact rows', icon: 'list', group: 'View',
      run: () => {
        const next = document.documentElement.dataset.density === 'compact' ? 'comfortable' : 'compact';
        store.setDensity(next);
        toast(next === 'compact' ? 'Compact rows on' : 'Comfortable rows on', { kind: 'info', timeout: 1800 });
      },
    },
    {
      id: 'view.sidebar', title: 'Toggle sidebar', icon: 'panel-left', keys: 'mod+b', group: 'View',
      run: () => document.querySelector('#shell')?.classList.toggle('collapsed'),
    },
    {
      id: 'view.zoom-in', title: 'Zoom in', icon: 'plus', keys: 'mod+=', group: 'View',
      run: () => shortcuts.stepZoom(1),
    },
    {
      id: 'view.zoom-out', title: 'Zoom out', icon: 'minus', keys: 'mod+-', group: 'View',
      run: () => shortcuts.stepZoom(-1),
    },
    {
      id: 'view.zoom-reset', title: 'Actual size', icon: 'target', keys: 'mod+0', group: 'View',
      run: () => shortcuts.applyZoom(1),
    },
    {
      id: 'app.reload', title: 'Reload', icon: 'refresh', keys: 'mod+r', group: 'Application',
      run: () => window.location.reload(),
    },
    {
      id: 'app.signout', title: 'Sign out', icon: 'log-out', group: 'Application',
      run: async () => {
        const { API } = await import('./api.js');
        await API.logout().catch(() => {});
        window.dispatchEvent(new CustomEvent('meridian:signed-out'));
      },
    },
  ]);
}

// The window shapes below are the operating system's, not a Meridian
// command — nothing here calls into the page to run them, which is exactly
// why they cannot live in the registry above with the rest. Windows has one
// row of these (Snap, built into every window); macOS has two, because its
// system shortcuts use the Globe/fn key, which not every keyboard has —
// Meridian's own Window menu offers the same six on ⌘⌃ as a fallback.
const WINDOW_SHAPES_MAC = [
  ['Fill the screen', 'fn ⌃F', '⌘⌃↩'],
  ['Left half', 'fn ⌃←', '⌘⌃←'],
  ['Right half', 'fn ⌃→', '⌘⌃→'],
  ['Top half', 'fn ⌃↑', '⌘⌃↑'],
  ['Bottom half', 'fn ⌃↓', '⌘⌃↓'],
  ['Centre', 'fn ⌃C', '⌘⌃C'],
  ['Undo the last tile', 'fn ⌃R', '⌘⌃R'],
];
const WINDOW_SHAPES_WIN = [
  ['Maximise', '⊞ Win + ↑'],
  ['Restore / minimise', '⊞ Win + ↓'],
  ['Left half', '⊞ Win + ←'],
  ['Right half', '⊞ Win + →'],
  ['Move to the other monitor', '⊞ Win + ⇧ + ← / →'],
];

/** The printed card: every binding, grouped, generated from the registry. */
export function showShortcutSheet() {
  const groups = new Map();
  for (const command of shortcuts.available()) {
    if (!command.keys) continue;
    if (!groups.has(command.group)) groups.set(command.group, []);
    groups.get(command.group).push(command);
  }
  const commandGroups = [...groups.entries()].map(([group, commands]) => h('div',
    h('h3', { style: { marginBottom: 'var(--s2)' } }, group),
    h('table.shortcut-table', h('tbody', ...commands.map((c) => h('tr',
      h('td', c.title),
      h('td', shortcuts.renderKeys(c.keys))))))));

  const windowTable = shortcuts.isMac
    ? h('table.shortcut-table',
      h('thead', h('tr', h('th', ''), h('th', 'System (Globe key)'), h('th', "Meridian's Window menu"))),
      h('tbody', ...WINDOW_SHAPES_MAC.map(([title, os, app]) => h('tr', h('td', title), h('td', os), h('td', app)))))
    : h('table.shortcut-table', h('tbody', ...WINDOW_SHAPES_WIN.map(([title, keys]) => h('tr', h('td', title), h('td', keys)))));

  return modal({
    title: 'Keyboard shortcuts',
    size: 'wide',
    body: h('div',
      h('p.muted', { style: { marginTop: 0 } },
        `Two kinds. A chord is held together — ${shortcuts.MOD}K. A sequence is typed in order — G then D — and works anywhere you are not typing into a field.`),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 'var(--s6)' } }, ...commandGroups),
      h('h3', { style: { marginTop: 'var(--s6)', marginBottom: 'var(--s2)' } }, 'Window'),
      h('p.muted', { style: { marginTop: 0 } },
        "The operating system's own, not Meridian's — they work because the window is a normal, resizable one."),
      windowTable),
    actions: [{ label: 'Close', value: null }],
  });
}
