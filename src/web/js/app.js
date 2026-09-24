// Meridian ERP :: web/app
// Boot, authentication gate, application shell and the hash router.
//
// The shell's job is to make a system with ninety record types and fifty
// screens feel small. It does that four ways, and they are deliberately
// redundant because different people reach for different ones: a sidebar you
// can filter and pin, a search for records, a palette for actions, and a
// create menu that works from wherever you are.
import { h, mount, clear, $, $$, debounce, safeSnippet } from './dom.js';
import { API, setCsrf, onLoading, ApiError } from './api.js';
import { icon } from './icons.js';
import * as store from './store.js';
import * as fmt from './format.js';
import { toast, notifyError, modal, confirm, formModal, loading, empty, anchoredMenu, closeOpenMenu } from './ui.js';
import { routes } from './views/index.js';
import * as shortcuts from './shortcuts.js';
import { registerCommands } from './commands.js';

const app = document.getElementById('app');
let currentCleanup = null;

// ================================================================ login
function renderLogin(prefill = {}) {
  const errBox = h('div.login-error.hidden');
  const email = h('input', { type: 'email', id: 'lg-email', autocomplete: 'username', required: true, value: prefill.email || '' });
  const password = h('input', { type: 'password', id: 'lg-pass', autocomplete: 'current-password', required: true });
  const tenantSel = h('select', { id: 'lg-tenant', class: 'hidden' });
  const submit = h('button.btn.primary.lg.block', { type: 'submit' }, 'Sign in');

  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      errBox.classList.add('hidden');
      submit.disabled = true; submit.textContent = 'Signing in…';
      try {
        const res = await API.login(email.value.trim(), password.value, tenantSel.value || undefined);
        setCsrf(res.csrf);
        await start();
      } catch (err) {
        clear(errBox);
        errBox.append(icon('x', { size: 14 }), h('span', err.message));
        errBox.classList.remove('hidden');
        password.value = '';
        password.focus();
      } finally { submit.disabled = false; submit.textContent = 'Sign in'; }
    },
  },
    errBox,
    h('div.field', h('label', { for: 'lg-email' }, 'Email'), email),
    h('div.field', h('label', { for: 'lg-pass' }, 'Password'), password),
    h('div.field', { class: 'hidden', id: 'tenant-field' }, h('label', { for: 'lg-tenant' }, 'Company'), tenantSel),
    submit);

  // Only advertise the demo credentials when the demo company is what is
  // actually installed -- on a real company they are noise at best.
  const hint = h('div.login-hint.hidden');
  API.tenants().then((r) => {
    const tenants = r.tenants || [];
    if (tenants.length > 1) {
      for (const t of tenants) tenantSel.appendChild(h('option', { value: t.slug }, t.name));
      tenantSel.classList.remove('hidden');
      $('#tenant-field', form).classList.remove('hidden');
    }
    if (tenants.some((t) => t.slug === 'northwind')) {
      mount(hint,
        h('div', { style: { fontWeight: 600, marginBottom: '4px', color: 'var(--text)', display: 'flex', gap: '6px', alignItems: 'center' } },
          icon('lightbulb', { size: 13 }), 'Demo company'),
        h('div', 'Sign in as ', h('code', 'admin@northwind.test')),
        h('div', 'Password ', h('code', 'Northwind-Demo-2026')));
      hint.classList.remove('hidden');
    }
  }).catch(() => {});

  mount(app, h('div.login-wrap',
    h('div.login-card',
      h('div.login-head',
        h('div.login-brand', h('div.brand-mark', 'M'), h('div.login-title', 'Meridian')),
        h('div.login-sub', 'Cloud ERP & Business Management')),
      h('div.login-body',
        form,
        hint,
        h('div.login-foot', 'Your data stays on this machine.')))));
  setTimeout(() => (prefill.email ? password : email).focus(), 50);
}

// =====================================================================
// Shell
// =====================================================================
function renderShell() {
  const loadingBar = h('div.loading-bar', { style: { width: '0%' } });
  onLoading((busy) => { loadingBar.style.width = busy ? '70%' : '0%'; loadingBar.style.opacity = busy ? '1' : '0'; });

  // -------------------------------------------------------------- search
  const searchInput = h('input', {
    type: 'search', placeholder: 'Search customers, invoices, items…',
    'aria-label': 'Search records', autocomplete: 'off',
  });
  const searchResults = h('div.search-results.hidden');
  const doSearch = debounce(async (q) => {
    if (!q || q.length < 2) { searchResults.classList.add('hidden'); return; }
    try {
      const { results } = await API.globalSearch(q);
      if (!results.length) {
        mount(searchResults, h('div.search-hit', h('span.muted', `Nothing matches “${q}”`)));
      } else {
        mount(searchResults, ...results.map((r) => h('div.search-hit', {
          onclick: () => { searchResults.classList.add('hidden'); searchInput.value = ''; go(hitRoute(r)); },
        },
          h('span.kind', r.label),
          h('div', { style: { minWidth: 0, flex: 1 } },
            h('div.title', r.title),
            h('div.sub', { html: safeSnippet(r.excerpt || r.subtitle || '') })))));
      }
      searchResults.classList.remove('hidden');
    } catch { searchResults.classList.add('hidden'); }
  }, 200);
  searchInput.addEventListener('input', () => doSearch(searchInput.value.trim()));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { searchResults.classList.add('hidden'); searchInput.blur(); }
    // Enter with one obvious answer should take it, rather than requiring the
    // mouse for something the keyboard just found.
    if (e.key === 'Enter') { searchResults.querySelector('.search-hit')?.click(); }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.searchbox')) searchResults.classList.add('hidden'); });

  // ------------------------------------------------------- notifications
  const bell = h('span');
  const notifBtn = h('button.icon-btn', {
    title: 'Notifications', 'aria-label': 'Notifications', onclick: () => showNotifications(),
  }, icon('bell', { size: 17 }), bell);

  // ---------------------------------------------------------- subsidiary
  const subsidiarySel = h('select.chip-select', {
    title: 'Scope every screen to one subsidiary', dataset: { tour: 'subsidiary' },
    onchange: (e) => { store.state.subsidiary = e.target.value || null; router(); },
  }, h('option', { value: '' }, 'All subsidiaries'),
    ...(store.state.meta.subsidiaries || []).map((s) => h('option', { value: s.id }, s.name)));

  // -------------------------------------------------------------- topbar
  const brandBtn = h('button.brand-switch', { title: 'Company', onclick: (e) => companyMenu(e.currentTarget) },
    h('div.brand-mark', 'M'),
    h('div.brand-text', { style: { minWidth: 0 } },
      h('div.brand-name', store.state.tenant.name),
      h('div.brand-sub', 'Meridian ERP')),
    icon('chevron-down', { size: 13 }));

  const newBtn = h('button.btn.primary', {
    dataset: { tour: 'new' }, title: 'Create a document',
    onclick: (e) => createMenu(e.currentTarget),
  }, icon('plus', { size: 15 }), h('span.brand-text', 'New'), icon('chevron-down', { size: 12 }));

  const topbar = h('header.topbar',
    h('button.icon-btn', { title: 'Toggle navigation  ' + shortcuts.MOD + 'B', 'aria-label': 'Toggle navigation', onclick: toggleSidebar },
      icon('panel-left', { size: 17 })),
    h('div.brand', brandBtn),
    h('div.searchbox', { dataset: { tour: 'search' } },
      h('span.icon', icon('search', { size: 15 })), searchInput,
      // The shortcut is shown where somebody is already looking for the box.
      h('span.kbd-hint', shortcuts.renderKeys('slash')),
      searchResults),
    h('div.topbar-right',
      (store.state.meta.subsidiaries || []).length > 1 && subsidiarySel,
      newBtn,
      h('div.topbar-divider'),
      h('button.icon-btn', {
        dataset: { tour: 'palette' }, title: `Command palette  ${shortcuts.MOD}K`, 'aria-label': 'Command palette',
        onclick: () => shortcuts.openPalette(),
      }, icon('command', { size: 17 })),
      h('button.icon-btn', {
        dataset: { tour: 'help' }, title: 'Help and guided tours', 'aria-label': 'Help',
        onclick: (e) => helpMenu(e.currentTarget),
      }, icon('help', { size: 17 })),
      h('button.icon-btn', {
        title: 'Light or dark', 'aria-label': 'Toggle light or dark',
        onclick: (e) => { store.toggleTheme(); refreshThemeIcon(e.currentTarget); },
      }, icon(store.state.theme === 'dark' ? 'sun' : 'moon', { size: 17 })),
      notifBtn,
      h('div.avatar', { title: store.state.user.name, onclick: (e) => accountMenu(e.currentTarget) }, fmt.initials(store.state.user.name))));

  const sidebar = h('nav.sidebar', { 'aria-label': 'Main navigation', dataset: { tour: 'sidebar' } });
  const main = h('main.main', { id: 'main' });
  const shell = h('div.shell', { id: 'shell' }, sidebar, main);

  mount(app, loadingBar, topbar, shell);
  buildNav(sidebar);
  // Below the breakpoint the sidebar is a drawer over the content, so the
  // remembered "expanded" state would open the application with its own menu
  // covering the page. Narrow starts shut, whatever was remembered.
  const narrow = () => window.innerWidth <= 1000;
  if (narrow() || store.getPref('sidebar.collapsed', false)) shell.classList.add('collapsed');
  let wasNarrow = narrow();
  window.addEventListener('resize', () => {
    if (narrow() === wasNarrow) return;
    wasNarrow = narrow();
    // Crossing the breakpoint re-reads the preference on the way back up, so a
    // sidebar somebody chose to keep open returns when there is room for it.
    shell.classList.toggle('collapsed', wasNarrow ? true : store.getPref('sidebar.collapsed', false));
  });

  window.__notifBell = bell;
  refreshBell();
}

const refreshThemeIcon = (btn) => mount(btn, icon(store.state.theme === 'dark' ? 'sun' : 'moon', { size: 17 }));

const toggleSidebar = () => {
  const shell = $('#shell');
  shell.classList.toggle('collapsed');
  store.setPref('sidebar.collapsed', shell.classList.contains('collapsed'));
};

// =====================================================================
// Navigation
// ---------------------------------------------------------------------
// Fifty screens is a wall unless three things are true: the groups are shut
// by default, the list can be filtered by typing, and the handful somebody
// actually uses is pinned above all of it.
// =====================================================================

/** Icon per purpose-built screen, keyed on route. */
const ROUTE_ICON = {
  '/': 'home', '/reports': 'bar-chart', '/chart': 'ledger', '/bank': 'bank',
  '/periods': 'calendar', '/revenue': 'trending-up', '/revenue/amortisation': 'trending-down',
  '/recurring': 'repeat', '/allocations': 'split', '/revaluation': 'exchange',
  '/assets': 'factory', '/intercompany': 'exchange', '/books': 'layers', '/tax': 'percent',
  '/paybills': 'wallet', '/subscriptions': 'repeat', '/collections': 'clock',
  '/pipeline': 'target', '/forecast': 'trending-up', '/hr/directory': 'users',
  '/hr/orgchart': 'split', '/inventory': 'box', '/production': 'factory',
  '/warehouse': 'package', '/projects': 'briefcase', '/dispatch': 'map',
  '/setup': 'settings', '/data': 'arrows-up-down', '/custom-records': 'puzzle',
  '/learn': 'graduation-cap', '/help': 'book-open', '/settings': 'sliders',
};

/** Icon per record type, for the generic lists the metadata registry declares. */
const TYPE_ICON = {
  customer: 'user-check', vendor: 'truck', contact: 'user', item: 'tag',
  invoice: 'invoice', quote: 'file-text', sales_order: 'shopping-cart',
  credit_memo: 'receipt', customer_payment: 'coins', customer_deposit: 'wallet',
  purchase_order: 'clipboard', vendor_bill: 'receipt', vendor_payment: 'coins',
  purchase_requisition: 'clipboard', item_receipt: 'package', vendor_credit: 'receipt',
  journal_entry: 'ledger', account: 'ledger', accounting_period: 'calendar',
  bank_account: 'bank', budget: 'target', fixed_asset: 'factory',
  inventory_count: 'clipboard', inventory_transfer: 'exchange', inventory_adjustment: 'sliders',
  work_order: 'wrench', bom: 'layers', pick_wave: 'package', shipment: 'truck',
  opportunity: 'target', lead: 'user', campaign: 'flag', support_case: 'life-buoy',
  service_order: 'wrench', project: 'briefcase', task: 'check', timesheet: 'clock',
  expense_report: 'receipt', employee: 'users', pay_run: 'coins', subscription: 'repeat',
  app_user: 'user', role: 'shield', workflow: 'route', custom_field: 'puzzle',
  saved_search: 'bookmark', data_import: 'arrows-up-down', location: 'map',
  department: 'building', subsidiary: 'building', tax_code: 'percent', tax_return: 'percent',
  price_level: 'tag', currency: 'coins', schedule: 'calendar', allocation_schedule: 'split',
  recurring_journal: 'repeat', revaluation_run: 'exchange', intercompany_txn: 'exchange',
  accounting_book: 'layers', custom_record_type: 'puzzle', notification: 'bell',
  audit_event: 'shield', attachment: 'file-text', note: 'file-text',
};

const GROUP_ICON = {
  Financial: 'ledger', Sales: 'trending-up', Purchasing: 'truck', Inventory: 'box',
  Manufacturing: 'factory', Projects: 'briefcase', CRM: 'target', Commerce: 'shopping-cart',
  Service: 'life-buoy', People: 'users', Platform: 'settings',
};

const PIN_KEY = 'nav.pinned';
const pinned = () => { const v = store.getPref(PIN_KEY, []); return Array.isArray(v) ? v : []; };
const isPinned = (route) => pinned().some((p) => p.r === route);
function togglePin(label, route, iconName) {
  const list = pinned();
  const next = list.some((p) => p.r === route)
    ? list.filter((p) => p.r !== route)
    : [...list, { l: label, r: route, i: iconName }];
  store.setPref(PIN_KEY, next);
  buildNav($('.sidebar'));
  toast(next.length > list.length ? `${label} pinned` : `${label} unpinned`, { kind: 'info', timeout: 1600 });
}

/** Sidebar: pinned first, then standard sections, then the record types. */
function buildNav(sidebar) {
  if (!sidebar) return;
  clear(sidebar);
  const groups = store.state.meta.groups || {};

  const link = (label, route, iconName, { pin = true, tour = null } = {}) => {
    const el = h('a.nav-item', {
      href: `#${route}`, dataset: { route, label: label.toLowerCase(), ...(tour ? { tour } : {}) },
      class: isPinned(route) ? 'pinned' : '',
      onclick: (e) => { e.preventDefault(); go(route); },
    }, icon(iconName || 'file-text', { size: 15 }), h('span.label', label));
    if (pin) {
      el.appendChild(h('button.nav-pin', {
        title: isPinned(route) ? `Unpin ${label}` : `Pin ${label} to the top`,
        'aria-label': isPinned(route) ? `Unpin ${label}` : `Pin ${label}`,
        onclick: (e) => { e.preventDefault(); e.stopPropagation(); togglePin(label, route, iconName); },
      }, icon('star', { size: 13 })));
    }
    return el;
  };

  const group = (name, items, opts = {}) => {
    const key = `nav.${name}`;
    const body = h('div.nav-items', ...items);
    const g = h('div.nav-group', { dataset: { group: name }, class: store.getPref(key, opts.closed ? 'closed' : '') },
      h('div.nav-group-label', {
        onclick: () => { g.classList.toggle('closed'); store.setPref(key, g.classList.contains('closed') ? 'closed' : ''); },
      }, h('span.caret', icon('chevron-down', { size: 11 })), name,
        h('span.g-count', String(items.length))),
      body);
    return g;
  };

  // ---- filter
  const filter = h('input.nav-filter', {
    type: 'search', placeholder: 'Filter menu…', 'aria-label': 'Filter navigation',
    dataset: { tour: 'nav-filter' }, autocomplete: 'off',
  });
  const clearBtn = h('button.clear.hidden', { title: 'Clear', 'aria-label': 'Clear filter' }, icon('x', { size: 13 }));
  const noMatch = h('div.nav-empty.hidden', 'Nothing in the menu matches that.');
  // Which groups were open before filtering started. Restoring from the
  // preference instead would quietly open every group that is closed by
  // default rather than by choice, so clearing the box would leave the menu
  // in a state the user never asked for.
  let openBeforeFilter = null;
  const applyFilter = () => {
    const q = filter.value.trim().toLowerCase();
    clearBtn.classList.toggle('hidden', !q);
    if (q && !openBeforeFilter) {
      openBeforeFilter = new Map($$('.nav-group', sidebar).map((g) => [g, g.classList.contains('closed')]));
    }
    let hits = 0;
    for (const item of $$('.nav-item', sidebar)) {
      const on = !q || (item.dataset.label || '').includes(q);
      item.classList.toggle('hidden', !on);
      if (on) hits++;
    }
    for (const g of $$('.nav-group', sidebar)) {
      const groupHits = $$('.nav-item:not(.hidden)', g).length;
      g.classList.toggle('hidden', !!q && groupHits === 0);
      // While filtering, every group holding a hit is open -- a match inside a
      // collapsed group is a match nobody can see.
      if (q) g.classList.remove('closed');
      else if (openBeforeFilter) g.classList.toggle('closed', openBeforeFilter.get(g) === true);
    }
    // The footer is a group of links too, and it should disappear along with
    // everything else that does not match rather than sitting under a filter
    // it ignores.
    const foot = $('.sidebar-foot', sidebar);
    if (foot) foot.classList.toggle('hidden', !!q && !$('.nav-item:not(.hidden)', foot));
    if (!q) openBeforeFilter = null;
    noMatch.classList.toggle('hidden', !q || hits > 0);
  };
  filter.addEventListener('input', applyFilter);
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { filter.value = ''; applyFilter(); filter.blur(); }
    if (e.key === 'Enter') { $('.nav-item:not(.hidden)', sidebar)?.click(); }
  });
  clearBtn.addEventListener('click', () => { filter.value = ''; applyFilter(); filter.focus(); });
  sidebar.appendChild(h('div.nav-filter-wrap',
    h('span.icon', icon('search', { size: 13 })), filter, clearBtn));

  // ---- always at the top
  sidebar.appendChild(h('div.nav-group', { dataset: { group: '_top' } }, h('div.nav-items',
    link('Dashboard', '/', 'home'),
    store.can('account') && link('Reports', '/reports', 'bar-chart'))));

  // ---- pinned
  const pins = pinned();
  if (pins.length) {
    sidebar.appendChild(group('Pinned', pins.map((p) => link(p.l, p.r, p.i)), { closed: false }));
  }

  // Every group the metadata registry declares has to appear here, or its
  // record types exist but are unreachable from the sidebar.
  const ORDER = ['Financial', 'Sales', 'Purchasing', 'Inventory', 'Manufacturing',
    'Projects', 'CRM', 'Commerce', 'Service', 'People', 'Platform'];
  for (const gname of ORDER) {
    const types = (groups[gname] || []).filter((t) => store.can(t));
    const extra = [];
    const add = (label, route, perm) => { if (!perm || store.can(perm)) extra.push(link(label, route, ROUTE_ICON[route])); };
    if (gname === 'Financial') {
      add('Chart of Accounts', '/chart', 'account');
      add('Banking', '/bank', 'bank_account');
      add('Period Close', '/periods', 'accounting_period');
      add('Revenue Recognition', '/revenue', 'schedule');
      add('Amortisation', '/revenue/amortisation', 'schedule');
      add('Recurring Journals', '/recurring', 'recurring_journal');
      add('Cost Allocations', '/allocations', 'allocation_schedule');
      add('Currency Revaluation', '/revaluation', 'revaluation_run');
      add('Fixed Assets', '/assets', 'fixed_asset');
      add('Intercompany', '/intercompany', 'intercompany_txn');
      add('Accounting Books', '/books', 'accounting_book');
      add('Tax', '/tax', 'tax_return');
    }
    if (gname === 'Purchasing') add('Pay Bills', '/paybills', 'payment_run');
    if (gname === 'Sales') {
      add('Subscriptions', '/subscriptions', 'subscription');
      add('Collections', '/collections', 'collections');
    }
    if (gname === 'CRM') {
      add('Pipeline', '/pipeline', 'opportunity');
      add('Forecast', '/forecast', 'opportunity');
    }
    if (gname === 'People') {
      add('Directory', '/hr/directory', 'employee');
      add('Org Chart', '/hr/orgchart', 'employee');
    }
    if (gname === 'Inventory') add('Stock & Reorder', '/inventory', 'item');
    if (gname === 'Manufacturing') {
      add('Production', '/production', 'work_order');
      add('Warehouse', '/warehouse', 'pick_wave');
    }
    if (gname === 'Projects') add('Project Board', '/projects', 'project');
    if (gname === 'Service') add('Dispatch', '/dispatch', 'service_order');
    if (gname === 'Platform') {
      add('Setup', '/setup', null);
      add('Custom Records', '/custom-records', 'custom_record_type');
      add('Import & Export', '/data', 'data_import');
    }
    // A purpose-built view above (Chart of Accounts, say) and the generic
    // record list for the same type share a label, which reads as a duplicated
    // menu entry. The richer view wins.
    const taken = new Set(extra.map((e) => e.querySelector('.label').textContent.trim()));
    const items = [...extra, ...types.map((t) => {
      const m = store.metaFor(t);
      return taken.has(m.plural) ? null : link(m.plural, `/list/${t}`, TYPE_ICON[t] || 'file-text');
    }).filter(Boolean)];
    if (!items.length) continue;
    sidebar.appendChild(group(gname, items, {
      closed: !['Financial', 'Sales'].includes(gname),
    }));
  }

  sidebar.appendChild(noMatch);

  // ---- footer: learning and help, where somebody looks when stuck
  sidebar.appendChild(h('div.sidebar-foot',
    h('div.nav-items',
      link('Learning centre', '/learn', 'graduation-cap', { pin: false, tour: 'learn-link' }),
      link('Help & manual', '/help', 'book-open', { pin: false }),
      link('Settings', '/settings', 'sliders', { pin: false })),
    h('div.sidebar-version', `Meridian ${store.state.meta?.version || ''}`.trim())));

  // Something to point a tour at that is certain to be there.
  const first = $('.nav-group[data-group="Financial"] .nav-item', sidebar) || $('.nav-item', sidebar);
  if (first) first.dataset.tour = 'pin-target';

  markActive();
}

function markActive() {
  const route = location.hash.slice(1).split('?')[0] || '/';
  for (const el of $$('.nav-item')) {
    const r = el.dataset.route;
    const on = r === route || (r !== '/' && route.startsWith(r));
    el.classList.toggle('active', on);
    // A collapsed group hides its items, so the highlight would land out of
    // sight. Open whichever group the current page lives in, and remember it.
    if (on) {
      const g = el.closest('.nav-group.closed');
      if (g) {
        g.classList.remove('closed');
        if (g.dataset.group) store.setPref(`nav.${g.dataset.group}`, '');
      }
    }
  }
}

// =====================================================================
// Topbar menus
// =====================================================================
const CREATE_ITEMS = [
  ['Invoice', '/txn-new/invoice', 'invoice', 'invoice', 'n i'],
  ['Sales order', '/txn-new/sales_order', 'shopping-cart', 'sales_order', 'n o'],
  ['Quote', '/txn-new/quote', 'file-text', 'quote', 'n q'],
  ['Customer payment', '/txn-new/customer_payment', 'coins', 'customer_payment', null],
  ['—'],
  ['Purchase order', '/txn-new/purchase_order', 'clipboard', 'purchase_order', 'n p'],
  ['Vendor bill', '/txn-new/vendor_bill', 'receipt', 'vendor_bill', 'n b'],
  ['—'],
  ['Journal entry', '/journal-new', 'ledger', 'journal_entry', 'n j'],
  ['—'],
  ['Customer', '/new/customer', 'user-check', 'customer', 'n c'],
  ['Supplier', '/new/vendor', 'truck', 'vendor', 'n v'],
  ['Item', '/new/item', 'tag', 'item', 'n t'],
  ['Employee', '/new/employee', 'users', 'employee', null],
];

function createMenu(anchor) {
  const items = [{ heading: 'Create' }];
  let pendingSep = false;
  for (const [label, route, iconName, perm, keys] of CREATE_ITEMS) {
    if (label === '—') { pendingSep = true; continue; }
    if (perm && !store.can(perm, store.LEVEL.CREATE)) continue;
    if (pendingSep && items.length > 1) { items.push({ separator: true }); }
    pendingSep = false;
    items.push({ label, icon: iconName, keys, onClick: () => go(route) });
  }
  if (items.length === 1) items.push({ label: 'Nothing you can create', disabled: true });
  anchoredMenu(anchor, items, { minWidth: 236 });
}

function companyMenu(anchor) {
  anchoredMenu(anchor, [
    {
      node: h('div.menu-head',
        h('div.brand-mark', 'M'),
        h('div', { style: { minWidth: 0 } },
          h('div.n', store.state.tenant.name),
          h('div.e', `Base currency ${store.state.tenant.base_currency}`))),
    },
    { separator: true },
    { label: 'Setup', sub: 'Company, users, roles, customisation', icon: 'settings', onClick: () => go('/setup') },
    store.can('accounting_period') && { label: 'Accounting periods', icon: 'calendar', onClick: () => go('/periods') },
    store.can('accounting_book') && { label: 'Accounting books', icon: 'layers', onClick: () => go('/books') },
    store.can('subsidiary') && { label: 'Subsidiaries', icon: 'building', onClick: () => go('/list/subsidiary') },
    { separator: true },
    store.can('data_import') && { label: 'Import & export', icon: 'arrows-up-down', onClick: () => go('/data') },
    { label: 'Switch company', sub: 'Signs you out first', icon: 'exchange', onClick: async () => {
      if (await confirm({ title: 'Switch company?', message: 'You will be signed out so you can sign in to another company.', confirmLabel: 'Sign out' })) {
        await API.logout().catch(() => {});
        renderLogin({ email: store.state.user.email });
      }
    } },
  ], { align: 'left', minWidth: 250 });
}

function helpMenu(anchor) {
  import('./tour.js').then(({ availableTours, completedTours, startTour, suggestedTour }) => {
    const done = completedTours();
    const suggestion = suggestedTour();
    anchoredMenu(anchor, [
      { heading: 'Learn' },
      suggestion && {
        label: done.length ? `Continue: ${suggestion.title}` : 'Take the guided tour',
        sub: `${suggestion.minutes} minutes, on your own data`,
        icon: 'play', onClick: () => startTour(suggestion.id),
      },
      { label: 'Learning centre', sub: `${availableTours().length} walkthroughs`, icon: 'graduation-cap', onClick: () => go('/learn') },
      { separator: true },
      { heading: 'Reference' },
      { label: 'Manual', icon: 'book-open', keys: 'mod+/', onClick: () => go('/help') },
      { label: 'Keyboard shortcuts', icon: 'command', keys: '?', onClick: () => shortcuts.run('app.shortcuts') },
      { label: 'Command palette', icon: 'search', keys: 'mod+k', onClick: () => shortcuts.openPalette() },
    ], { minWidth: 262 });
  });
}

function accountMenu(anchor) {
  const density = document.documentElement.dataset.density === 'compact';
  anchoredMenu(anchor, [
    {
      node: h('div.menu-head',
        h('div.avatar.lg', fmt.initials(store.state.user.name)),
        h('div', { style: { minWidth: 0 } },
          h('div.n', store.state.user.name),
          h('div.e', store.state.user.email),
          h('div.e', store.state.roles.join(', ') || '—'))),
    },
    { separator: true },
    { label: 'Settings', icon: 'sliders', keys: 'mod+,', onClick: () => go('/settings') },
    { label: 'Change password', icon: 'lock', onClick: () => changePassword() },
    { separator: true },
    { heading: 'Appearance' },
    {
      label: store.state.theme === 'dark' ? 'Light appearance' : 'Dark appearance',
      icon: store.state.theme === 'dark' ? 'sun' : 'moon', keys: 'mod+shift+l',
      onClick: () => { store.toggleTheme(); renderShellThemeIcons(); },
    },
    {
      label: 'Colour scheme & typeface', icon: 'eye', sub: paletteLabel(),
      onClick: () => go('/settings/appearance'),
    },
    {
      label: 'Compact rows', icon: 'list', checked: density,
      onClick: () => {
        store.setDensity(density ? 'comfortable' : 'compact');
        toast(density ? 'Comfortable rows' : 'Compact rows', { kind: 'info', timeout: 1600 });
      },
    },
    { separator: true },
    { label: 'Sign out', icon: 'log-out', danger: true, onClick: async () => {
      await API.logout().catch(() => {});
      location.hash = '';
      renderLogin({ email: store.state.user.email });
    } },
  ], { minWidth: 250 });
}

const paletteLabel = () => {
  const pal = store.PALETTES.find((p) => p.id === store.state.palette);
  const face = store.TYPEFACES.find((t) => t.id === store.state.typeface);
  return `${pal?.name || 'Carbon & Cobalt'} · ${face?.name || 'Styrene & Tiempos'}`;
};

/** After a theme change from a menu, the topbar's own icon has to agree. */
function renderShellThemeIcons() {
  const btn = $$('.topbar-right .icon-btn').find((b) => /Light or dark/.test(b.title || ''));
  if (btn) refreshThemeIcon(btn);
}

function changePassword() {
  formModal({
    title: 'Change password', size: 'narrow',
    fields: [
      { name: 'current_password', label: 'Current password', type: 'text', full: true },
      { name: 'new_password', label: 'New password', type: 'text', full: true, help: 'At least 10 characters, with upper case, lower case and a digit.' },
    ],
    submitLabel: 'Update password',
    onSubmit: async (m) => {
      await API.changePassword(m.current_password, m.new_password);
      toast('Password updated. Please sign in again.', { kind: 'success' });
      setTimeout(() => renderLogin({ email: store.state.user.email }), 900);
    },
  });
}

// ------------------------------------------------------- notifications
async function refreshBell() {
  await store.loadNotifications();
  const bell = window.__notifBell;
  if (!bell) return;
  clear(bell);
  if (store.state.unread > 0) bell.appendChild(h('span.badge-dot', String(Math.min(99, store.state.unread))));
}

function showNotifications() {
  const rows = store.state.notifications;
  modal({
    title: 'Notifications', size: 'narrow',
    body: rows.length
      ? h('div.timeline', ...rows.map((n) => h('div.tl-item',
        h('div.tl-dot', { style: { background: n.severity === 'error' ? 'var(--neg)' : n.severity === 'warning' ? 'var(--warn)' : 'var(--accent)', opacity: n.read_at ? 0.35 : 1 } }),
        h('div.tl-body',
          h('div', { style: { fontWeight: n.read_at ? 400 : 620 } }, n.title),
          n.body && h('div.muted', n.body),
          h('div.tl-when', fmt.relative(n.created_at))))))
      : empty('Nothing new', 'Notifications from workflows and approvals appear here.', null, 'bell'),
    actions: rows.length ? [{
      label: 'Mark all read', kind: 'primary',
      onClick: async () => { await API.markRead(null); await refreshBell(); },
    }] : [],
  });
}

// =============================================================== router
export function go(route, { replace = false } = {}) {
  closeOpenMenu();
  const target = route.startsWith('#') ? route : `#${route}`;
  const before = location.hash;
  if (replace) location.replace(target); else location.hash = target;
  // A fragment that actually changed fires `hashchange`, which routes for us.
  // Re-navigating to the route we are already on fires nothing, so route by hand.
  if (location.hash === before) router();
  // On a narrow window the sidebar is a drawer over the content, so following
  // a link has to shut it or the page arrives behind the menu.
  if (window.innerWidth <= 1000) {
    const shell = $('#shell');
    if (shell && !shell.classList.contains('collapsed')) shell.classList.add('collapsed');
  }
}
window.__meridianGo = go;
window.__meridianRenderKeys = shortcuts.renderKeys;

const hitRoute = (r) => (r.type === 'txn' ? `/txn/${r.id}` : r.type === 'journal_entry' ? `/journal/${r.id}` : `/record/${r.type}/${r.id}`);

/** Parse "#/list/customer?q=acme" into { path, parts, query }. */
function parseRoute() {
  const raw = decodeURIComponent(location.hash.slice(1)) || '/';
  const [path, qs] = raw.split('?');
  return {
    path,
    parts: path.split('/').filter(Boolean),
    query: Object.fromEntries(new URLSearchParams(qs || '')),
  };
}

let navSeq = 0;

async function router() {
  const main = $('#main');
  if (!main) return;
  const r = parseRoute();
  const seq = ++navSeq;
  markActive();
  try { currentCleanup?.(); } catch { /* view teardown is best-effort */ }
  currentCleanup = null;

  const handler = routes.find((rt) => rt.match(r));
  mount(main, loading());
  main.scrollTop = 0;
  try {
    const view = await handler.render(r, { go });
    if (seq !== navSeq) return;                               // superseded mid-load
    mount(main, view.el || view);
    currentCleanup = view.cleanup || null;
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) {
      mount(main, h('div.page', empty('Not permitted', e.message, null, 'lock')));
    } else if (e instanceof ApiError && e.status === 404) {
      mount(main, h('div.page', empty('Not found', e.message,
        h('button.btn', { onclick: () => go('/') }, 'Back to dashboard'), 'search')));
    } else {
      console.error(e);
      mount(main, h('div.page', empty('That page could not be loaded', e.message,
        h('button.btn', { onclick: () => router() }, 'Try again'), 'help')));
    }
  }
}

// ================================================================ boot
async function start() {
  await store.loadSession();
  await store.loadMeta();
  window.__meridianRefLabel = store.refLabelSync;
  store.loadSavedSearches();
  renderShell();
  if (!location.hash || location.hash === '#') location.hash = '#/';
  await router();
  setInterval(refreshBell, 120_000);
  // The offer to be taught, once, after the first screen has actually painted.
  import('./tour.js').then((tour) => tour.maybeOfferWelcome()).catch(() => {});
}

window.addEventListener('hashchange', router);
window.addEventListener('meridian:signed-out', () => {
  if (!document.querySelector('.login-card')) renderLogin();
});
window.addEventListener('meridian:refresh-nav', () => buildNav($('.sidebar')));

store.initAppearance();
registerCommands();
shortcuts.install();

// The native desktop host drives these from its own menus, so File → New
// Invoice and Help → Keyboard Shortcuts do the same thing as the keys.
window.__meridianPalette = () => shortcuts.openPalette();
window.__meridianShortcutSheet = () => shortcuts.run('app.shortcuts');
// Help → Take a Guided Tour starts the next one not yet done; with an id it
// starts that one. Either way the host does not need to know what tours exist.
window.__meridianTour = (id) => import('./tour.js').then((t) => {
  const chosen = id || t.suggestedTour()?.id || t.availableTours()[0]?.id;
  if (chosen) t.startTour(chosen); else go('/learn');
});
// The host owns the real zoom; the page only records it so Settings agrees.
window.addEventListener('meridian:zoom-native', (e) => {
  store.setPref('ui.zoom', e.detail?.level ?? 1);
});
(async () => {
  try {
    const s = await API.session();
    setCsrf(s.csrf);
    await start();
    return;
  } catch { /* no session yet: either a fresh copy, or signed out */ }

  // A copy with no company at all goes to the setup wizard, not to a login
  // form nobody has credentials for.
  try {
    const state = await API.setupState();
    if (!state.configured) {
      const { renderSetup } = await import('./setup-wizard.js');
      await renderSetup(app, start);
      return;
    }
  } catch { /* fall through to the sign-in form */ }
  renderLogin();
})();

export { router, refreshBell };
