// Meridian ERP :: web/tour
// The teaching layer: guided tours that drive the real application.
//
// The thing that makes an ERP hard is not any one screen, it is knowing which
// screens belong to each other. A quote becomes an order becomes an invoice
// becomes a payment becomes three lines in the ledger, and nobody discovers
// that by clicking around a sidebar with fifty entries in it.
//
// So this is not a slideshow. Every step navigates to the screen it is talking
// about and puts a ring around the actual control, on the user's own data. The
// two rules that follow from that:
//
//   * A tour never blocks. If a step's target is missing -- a permission the
//     user does not have, a screen that renders differently on empty data --
//     the step degrades to a centred card and the tour carries on. A teaching
//     aid that can strand somebody is worse than none.
//   * A tour never writes. Every step is navigation and explanation. Nothing
//     here posts, saves or deletes, so somebody can be shown the whole of
//     month-end on live books without consequence.
import { h, mount, clear, $ } from './dom.js';
import { icon } from './icons.js';
import * as store from './store.js';
import { modal } from './ui.js';

// ===================================================================== text
/**
 * Step copy, with the two bits of markup a sentence actually needs.
 * `**bold**` for the noun being taught, `` `code` `` for something typed.
 * Built as nodes rather than HTML: there is no innerHTML anywhere in a tour.
 */
function rich(text) {
  const out = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[1] ? h('strong', m[1]) : h('code', { class: 'mono' }, m[2]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const para = (t) => h('p', ...rich(t));

// ================================================================== catalogue
/**
 * A step is:
 *   route      navigate here first (optional)
 *   target     CSS selector to ring (optional -- omit for a centred card)
 *   navGroup   open this sidebar group before looking for the target
 *   title/body what it says
 *   note       an aside worth keeping out of the main paragraph
 *   place      preferred side: 'bottom' | 'top' | 'left' | 'right'
 *   when       a predicate; a step that does not apply is skipped entirely
 */
const canSee = (type) => () => store.can(type);

export const TOURS = [
  // ------------------------------------------------------------ orientation
  {
    id: 'basics',
    title: 'Finding your way around',
    blurb: 'The five minutes that save you an afternoon: navigation, search, the command palette, and how to create anything from anywhere.',
    icon: 'compass',
    minutes: 4,
    steps: [
      {
        title: 'Welcome to Meridian',
        body: [
          'This is a complete business system — ledger, sales, purchasing, stock, projects, people and payroll — and everything in it is connected. Post an invoice and the receivable, the tax and the revenue all move with it.',
          'This tour shows you the **four ways to get anywhere**, which is most of what makes the system feel small instead of large. Use the arrow keys, or the buttons below.',
        ],
        note: 'Nothing in any tour changes your data. Every step just looks at a screen.',
      },
      {
        target: '[data-tour="sidebar"]',
        place: 'right',
        title: 'One: the sidebar',
        body: [
          'Every screen you can see, grouped by the part of the business it belongs to. What you *cannot* see is not hidden — it is simply not permitted for your role, which is why two people signed in side by side have different menus.',
        ],
      },
      {
        target: '[data-tour="nav-filter"]',
        place: 'right',
        title: 'Filter it instead of reading it',
        body: [
          'There are more than fifty screens. Rather than hunting through the groups, type two or three letters here — `dep`, `rev`, `tax` — and the menu narrows to what matches, groups opened as needed.',
        ],
      },
      {
        target: '[data-tour="pin-target"]',
        place: 'right',
        title: 'Pin the handful you actually use',
        body: [
          'Hover any menu entry and a **pin** appears on the right. Pinned screens collect in a **Pinned** group at the very top of the sidebar, which is where your own working day lives after the first week.',
        ],
        note: 'Pins are per person, stored on this device. Nobody else sees yours.',
      },
      {
        target: '[data-tour="search"]',
        place: 'bottom',
        title: 'Two: search, for things',
        body: [
          'This searches your **records** — a customer by name, an invoice by number, an item by SKU, a memo by the words in it. Press `/` from anywhere to jump into it without reaching for the mouse.',
        ],
      },
      {
        target: '[data-tour="palette"]',
        place: 'bottom',
        title: 'Three: the command palette, for actions',
        body: [
          'Search finds things. The palette runs **actions** — open any screen, create any document, change any setting — by typing a few letters of its name.',
          'It is the fastest thing in the application and the one shortcut worth learning first.',
        ],
        note: 'Press ⌘K (Ctrl+K on Windows) from anywhere, including inside a form.',
      },
      {
        target: '[data-tour="new"]',
        place: 'bottom',
        title: 'Four: create without navigating',
        body: [
          'New invoice, order, bill, journal, customer, item — from wherever you happen to be, without losing the screen you were on. Each one has a two-key sequence too: `N` then `I` for an invoice.',
        ],
      },
      {
        route: '/',
        target: '[data-tour="dashboard-grid"]',
        place: 'top',
        title: 'Your dashboard is yours',
        body: [
          'These tiles are drag-and-droppable, and **Add widget** offers every tile your permissions allow. The arrangement is saved against your user, so the first screen of the morning is the one you built.',
          'A tile with an underline is a link — click it to land on the records behind the number.',
        ],
      },
      {
        target: '[data-tour="subsidiary"]',
        place: 'bottom',
        when: () => (store.state.meta?.subsidiaries || []).length > 1,
        title: 'Which company you are looking at',
        body: [
          'This group has more than one subsidiary. This selector scopes **every screen and every report** to one of them, or shows the consolidated picture across all.',
        ],
      },
      {
        target: '[data-tour="help"]',
        place: 'bottom',
        title: 'The manual is inside the application',
        body: [
          'Nineteen chapters, searchable, no network required. `?` on its own shows every keyboard shortcut; ⌘/ opens the manual.',
          'And the **Learning centre** — where you started this tour — has a walkthrough for each part of the business.',
        ],
      },
      {
        title: 'That is the whole navigation model',
        body: [
          'Sidebar to browse, search for records, palette for actions, New for documents. Everything else in Meridian is a screen you reach with one of those four.',
          'The other tours walk an actual process end to end — a sale from quote to cash, a purchase from order to payment, a month-end close. Those are where the system stops being a menu and starts being a business.',
        ],
        finish: true,
      },
    ],
  },

  // ----------------------------------------------------------- quote to cash
  {
    id: 'quote-to-cash',
    title: 'A sale, from quote to cash',
    blurb: 'Follow one order through quote, fulfilment, invoice and payment — and see exactly what each step does to the ledger.',
    icon: 'trending-up',
    minutes: 6,
    when: canSee('invoice'),
    steps: [
      {
        title: 'One sale, five documents',
        body: [
          'A sale in Meridian is a chain, and each link is a document that carries the last one forward: **quote → sales order → fulfilment → invoice → payment**.',
          'You never retype anything. Each step is created *from* the one before it, which is also why the numbers always agree.',
        ],
      },
      {
        route: '/list/customer',
        target: 'page-title',
        place: 'bottom',
        title: 'It starts with the customer',
        body: [
          'Everything hangs off this record: their currency, payment terms, credit limit, price level, tax registration and delivery addresses. Set them here once and every document for this customer is filled in correctly by default.',
        ],
      },
      {
        route: '/list/customer',
        target: 'toolbar',
        place: 'bottom',
        title: 'Every list works the same way',
        body: [
          'Search, filter, sort, choose your columns, save the result as a view, export it. This is the same toolbar on all ninety-odd record types — learn it here and you have learnt every list in the product.',
        ],
        note: 'A saved search with filters is how most people build their own working lists.',
      },
      {
        route: '/list/quote',
        target: 'page-title',
        place: 'bottom',
        when: canSee('quote'),
        title: 'A quote commits nothing',
        body: [
          'A quote prices the work and posts **nothing** to the ledger. It is a document you can send, revise and lose without consequence.',
          'When it is accepted, one button turns it into a sales order, lines and pricing intact.',
        ],
      },
      {
        route: '/list/sales_order',
        target: 'page-title',
        place: 'bottom',
        when: canSee('sales_order'),
        title: 'The order is the promise',
        body: [
          'A sales order records what you have agreed to deliver. It still posts nothing — revenue is not earned by promising — but it *does* commit stock, which is why the item availability screens subtract it.',
        ],
        note: 'Approval rules, if your company uses them, sit here: an order over a threshold waits for somebody.',
      },
      {
        route: '/list/invoice',
        target: 'page-title',
        place: 'bottom',
        title: 'The invoice is where the ledger moves',
        body: [
          'This is the first document that posts. Debit **receivables**, credit **revenue**, credit **tax payable** — and for a stocked item, debit cost of sales and credit inventory at the moving average cost.',
          'Open any invoice and its **GL Impact** tab shows you those lines. Not a summary of them: the actual journal, as posted.',
        ],
      },
      {
        route: '/list/invoice',
        target: 'grid',
        place: 'top',
        title: 'Read the status column',
        body: [
          '**Open** means posted and unpaid. **Partially paid**, **Paid in full** and **Overdue** follow from the payments against it and the terms on the customer. Nothing here is typed by hand — status is derived, so it cannot be wrong.',
        ],
      },
      {
        route: '/collections',
        target: 'page-title',
        place: 'bottom',
        when: canSee('collections'),
        title: 'Getting paid is a screen, not a spreadsheet',
        body: [
          '**Collections** ranks who owes you what, by how late and how much, with the promise-to-pay notes and the dunning letters already drafted. It is the aged debt report you can actually work from.',
        ],
      },
      {
        route: '/bank',
        target: 'page-title',
        place: 'bottom',
        when: canSee('bank_account'),
        title: 'Cash lands in the bank',
        body: [
          'A customer payment debits the bank and clears the receivable. Import a statement here and Meridian matches the lines it recognises, leaving you only the ones it is not sure about.',
        ],
      },
      {
        route: '/reports/ar-aging',
        target: 'page-title',
        place: 'bottom',
        title: 'And the whole chain reconciles',
        body: [
          'Receivables aging totals to the receivables control account in the ledger, to the penny, always. If it ever did not, **Setup → Integrity check** would say so.',
          'That is the point of a single connected system: the subledger and the ledger cannot drift, because they are the same postings read two ways.',
        ],
        finish: true,
      },
    ],
  },

  // ---------------------------------------------------------- purchase to pay
  {
    id: 'purchase-to-pay',
    title: 'A purchase, from order to payment',
    blurb: 'Requisition, purchase order, receipt, bill and pay run — including the three-way match that stops you paying for what never arrived.',
    icon: 'truck',
    minutes: 5,
    when: canSee('vendor_bill'),
    steps: [
      {
        title: 'The mirror image, with one extra guard',
        body: [
          'Buying runs the same shape as selling — **requisition → purchase order → receipt → bill → payment** — with one thing added: the **three-way match**. Meridian will not let a bill be paid quietly when the goods, the order and the invoice disagree.',
        ],
      },
      {
        route: '/list/purchase_order',
        target: 'page-title',
        place: 'bottom',
        when: canSee('purchase_order'),
        title: 'The order commits you',
        body: [
          'A purchase order posts nothing, but it is the number your supplier quotes back at you and the figure your commitment reporting uses. Receiving against it is what starts the accounting.',
        ],
      },
      {
        route: '/list/item_receipt',
        target: 'page-title',
        place: 'bottom',
        when: canSee('item_receipt'),
        title: 'The receipt is where value arrives',
        body: [
          'Debit **inventory**, credit **goods received not invoiced**. Stock is now yours and on your balance sheet, even though no bill has come. That accrual is what stops a month looking artificially profitable because the paperwork is slow.',
        ],
      },
      {
        route: '/list/vendor_bill',
        target: 'page-title',
        place: 'bottom',
        title: 'The bill clears the accrual',
        body: [
          'The supplier invoice clears goods-received-not-invoiced and credits **payables**. Any difference between what you ordered, what arrived and what you were billed shows as a **variance** rather than being absorbed silently into cost.',
        ],
        note: 'Landed cost — freight, duty, insurance — is apportioned onto the items here, not expensed away from them.',
      },
      {
        route: '/paybills',
        target: 'page-title',
        place: 'bottom',
        when: canSee('payment_run'),
        title: 'Pay in batches, not one at a time',
        body: [
          'A **pay run** selects everything due by a date, nets credit notes off, applies early-payment discounts where they are worth taking, and produces one payment file and one set of postings.',
        ],
      },
      {
        route: '/reports/ap-aging',
        target: 'page-title',
        place: 'bottom',
        title: 'Which ties out the same way',
        body: [
          'Payables aging equals the payables control account. Same guarantee as receivables, same reason.',
          'Between the two you have working capital: what you are owed, what you owe, and when each lands — which is the **Cash flow forecast** in Reports.',
        ],
        finish: true,
      },
    ],
  },

  // ---------------------------------------------------------------- the close
  {
    id: 'month-end',
    title: 'Closing a month',
    blurb: 'The whole close in order: accruals, recurring entries, allocations, revaluation, revenue, reconciliation, integrity, lock.',
    icon: 'calendar',
    minutes: 7,
    when: canSee('accounting_period'),
    steps: [
      {
        title: 'A close is a checklist, in an order',
        body: [
          'Every step here exists because some number is not yet right, and they have to happen in sequence: things that create entries, then things that reconcile, then the lock.',
          'Meridian has a screen for each one. This tour is the order.',
        ],
      },
      {
        route: '/recurring',
        target: 'page-title',
        place: 'bottom',
        when: canSee('recurring_journal'),
        title: 'First: the entries you make every month',
        body: [
          'Rent, insurance, depreciation of the intangibles, the standing accruals. Define them once as **recurring journals** and generating the month is one button instead of forty minutes of typing.',
        ],
      },
      {
        route: '/revenue',
        target: 'page-title',
        place: 'bottom',
        when: canSee('schedule'),
        title: 'Then: revenue that was invoiced but not yet earned',
        body: [
          'A twelve-month support contract invoiced in January is not January revenue. **Revenue recognition** holds it as deferred and releases a twelfth each month on its own schedule.',
          '**Amortisation** does the same job in the other direction for prepaid costs.',
        ],
      },
      {
        route: '/allocations',
        target: 'page-title',
        place: 'bottom',
        when: canSee('allocation_schedule'),
        title: 'Then: shared costs onto the things that caused them',
        body: [
          'One electricity bill, five departments. **Cost allocations** spread it by a rule — headcount, floor area, revenue share, fixed percentages — so departmental results mean something.',
        ],
      },
      {
        route: '/revaluation',
        target: 'page-title',
        place: 'bottom',
        when: canSee('revaluation_run'),
        title: 'Then: what the exchange rate did',
        body: [
          'Foreign-currency balances are worth a different amount than when they were posted. **Currency revaluation** measures that at the closing rate and posts the unrealised gain or loss.',
        ],
      },
      {
        route: '/bank',
        target: 'page-title',
        place: 'bottom',
        when: canSee('bank_account'),
        title: 'Now reconcile: does the bank agree?',
        body: [
          'Import the statement, match what matches, explain what does not. A reconciled bank account is the one hard external check on your cash figure — the only number in the ledger somebody else also keeps.',
        ],
      },
      {
        route: '/reports/trial-balance',
        target: 'page-title',
        place: 'bottom',
        title: 'Then read the trial balance',
        body: [
          'Debits equal credits — structurally, because nothing unbalanced can be posted. What you are looking for here is not arithmetic, it is a balance that looks wrong: a suspense account with something in it, an expense at ten times last month.',
        ],
      },
      {
        route: '/setup',
        target: 'page-title',
        place: 'bottom',
        title: 'Then let the system check itself',
        body: [
          '**Integrity check** re-proves the things that are supposed to be impossible: every journal balanced, subledgers tied to their control accounts, no orphaned lines, inventory value equal to the sum of its layers.',
          'Run it before you close. It takes seconds and it is the difference between believing the books and knowing.',
        ],
      },
      {
        route: '/periods',
        target: 'page-title',
        place: 'bottom',
        when: canSee('accounting_period'),
        title: 'Then lock it',
        body: [
          'Closing a period refuses further postings into it. That is what makes a reported number a fact rather than a snapshot — and it is why a late invoice belongs in the open month with a note, not quietly backdated into a closed one.',
        ],
        note: 'A period can be reopened, and reopening is recorded in the audit trail with who and when.',
      },
      {
        route: '/reports',
        target: 'page-title',
        place: 'bottom',
        title: 'And report it',
        body: [
          'Income statement, balance sheet, cash flow — each with period comparison and drill-down to the entries underneath. Every figure on every statement traces back to a posting you can open.',
        ],
        finish: true,
      },
    ],
  },

  // --------------------------------------------------------------- reporting
  {
    id: 'reporting',
    title: 'Getting answers out',
    blurb: 'Statements, drill-down, saved searches, multi-book comparison, and the three ways to get Meridian data into something else.',
    icon: 'bar-chart',
    minutes: 5,
    when: canSee('account'),
    steps: [
      {
        route: '/reports',
        target: 'page-title',
        place: 'bottom',
        title: 'Every report is here',
        body: [
          'Financial statements, aged debt and credit, inventory valuation, sales and margin analysis, budget variance, cash flow forecasting, tax. Grouped by what you are trying to find out rather than by which module owns the data.',
        ],
      },
      {
        route: '/reports/income-statement',
        target: 'page-title',
        place: 'bottom',
        title: 'Statements compare and drill',
        body: [
          'Choose a period and a comparison — last month, same month last year, budget — and every line shows the variance. Then click the line: you get the accounts, then the transactions, then the document.',
          'A number you cannot trace is a number you cannot defend, so nothing here is a dead end.',
        ],
      },
      {
        route: '/reports/income-statement',
        target: 'toolbar',
        place: 'bottom',
        title: 'Segment it, book it, print it',
        body: [
          'The controls here filter by subsidiary, department, location and class — and, where a second set of books exists, by **accounting book**, so you can read the same month on two accounting bases side by side.',
        ],
      },
      {
        route: '/list/invoice',
        target: 'toolbar',
        place: 'bottom',
        title: 'For anything else, build the list',
        body: [
          'Any list can be filtered on any field, sorted, grouped, given the columns you want, totalled, and **saved as a view** you can come back to or share with your team. Most "can we get a report on…" questions are actually this.',
        ],
      },
      {
        route: '/data',
        target: 'page-title',
        place: 'bottom',
        when: canSee('data_import'),
        title: 'And three ways out of the building',
        body: [
          'CSV export from any list. A **REST API** for anything you want to build. And an **OData feed** that Excel and Power BI connect to directly, so a spreadsheet refreshes against live data instead of being pasted once and going stale.',
        ],
        note: 'Import works the same way, with a dry run that reports what would happen before anything is written.',
      },
      {
        title: 'The rule underneath all of it',
        body: [
          'There is one copy of every number. Reports read the ledger; they do not keep their own totals. That is why two reports can never disagree, and why a correction shows up everywhere at once.',
        ],
        finish: true,
      },
    ],
  },

  // ------------------------------------------------------------- making it fit
  {
    id: 'customise',
    title: 'Making it fit your business',
    blurb: 'Custom fields, your own record types, workflow rules, roles and permissions — the parts that turn a generic ERP into yours.',
    icon: 'puzzle',
    minutes: 5,
    steps: [
      {
        title: 'No business is the shape of the software',
        body: [
          'Every company has something the standard record does not hold and some rule nobody else has. Meridian is built to be bent rather than worked around, and the bending is configuration — it survives upgrades.',
        ],
      },
      {
        route: '/setup',
        target: 'page-title',
        place: 'bottom',
        title: 'Setup is the whole control panel',
        body: [
          'Company and subsidiaries, chart of accounts, tax codes, currencies, numbering, users, roles, custom fields, workflows, integrations, backups. One screen with sections rather than settings scattered through the application.',
        ],
      },
      {
        route: '/setup',
        target: 'page-title',
        place: 'bottom',
        title: 'Custom fields go on any record',
        body: [
          'Add a field to customers, items, invoices, anything — text, number, date, money, a dropdown, a reference to another record, or a **formula** computed from the record it sits on.',
          'They appear on the form, in the list columns, in the filters and in search, because they are real fields rather than a notes box.',
        ],
      },
      {
        route: '/custom-records',
        target: 'page-title',
        place: 'bottom',
        when: canSee('custom_record_type'),
        title: 'Whole record types, if you need them',
        body: [
          'When there is no standard record for the thing you track — properties, vessels, licences, inspections — define your own. It gets a list, a form, search, permissions and an API, the same as everything built in.',
        ],
      },
      {
        route: '/setup',
        target: 'page-title',
        place: 'bottom',
        title: 'Workflow rules do the remembering',
        body: [
          '**When** something happens, **if** a condition holds, **then** act: require approval over a threshold, email the owner, set a field, create a task, raise an alert.',
          'This is where "we always forget to…" stops being a person\'s problem.',
        ],
      },
      {
        route: '/setup',
        target: 'page-title',
        place: 'bottom',
        title: 'Roles decide who sees what',
        body: [
          'Permissions are per record type and per level — view, create, edit, full — and can be narrowed further by subsidiary, department or location, so a regional manager sees their region and not the group.',
        ],
      },
      {
        route: '/books',
        target: 'page-title',
        place: 'bottom',
        when: canSee('accounting_book'),
        title: 'And more than one set of books',
        body: [
          'If you report on two bases — IFRS and local GAAP, statutory and management — a second **accounting book** records only where it differs from the ledger, and the statements can be read either way.',
        ],
      },
      {
        title: 'That is the toolkit',
        body: [
          'Fields, records, workflows, roles, books. Between them, most of what a consultant would have quoted you for is a screen in Setup.',
          'The manual has a chapter on each, with the trade-offs spelled out.',
        ],
        finish: true,
      },
    ],
  },
];

export const tourById = (id) => TOURS.find((t) => t.id === id) || null;
/** Tours this user's permissions make sense of. */
export const availableTours = () => TOURS.filter((t) => !t.when || safely(t.when));
const safely = (fn) => { try { return fn(); } catch { return false; } };

// =================================================================== progress
const DONE_KEY = 'tour.completed';
export const completedTours = () => {
  const v = store.getPref(DONE_KEY, []);
  return Array.isArray(v) ? v : [];
};
export const isTourDone = (id) => completedTours().includes(id);
function markDone(id) {
  const done = completedTours();
  if (!done.includes(id)) store.syncPref(DONE_KEY, [...done, id]);
  window.dispatchEvent(new CustomEvent('meridian:tour-progress', { detail: { id } }));
}
export const resetTourProgress = () => {
  store.syncPref(DONE_KEY, []);
  store.syncPref('tour.welcomed', false);
  window.dispatchEvent(new CustomEvent('meridian:tour-progress', { detail: { id: null } }));
};
/** The next tour worth offering: first available one not yet finished. */
export function suggestedTour() {
  const done = completedTours();
  return availableTours().find((t) => !done.includes(t.id)) || null;
}

// ===================================================================== engine
let active = null;                       // the one running tour, or null

export const tourRunning = () => !!active;

/** Wait for an element to exist, up to `timeout`. Resolves null on giving up. */
function waitForEl(selector, timeout = 2600) {
  const found = () => resolveTarget(selector);
  const first = found();
  if (first) return Promise.resolve(first);
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (!active) return resolve(null);
      const el = found();
      if (el) return resolve(el);
      if (Date.now() - started > timeout) return resolve(null);
      setTimeout(tick, 60);
    };
    setTimeout(tick, 60);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Logical targets.
 *
 * A step says what it wants to point at, not where that thing happens to be in
 * the DOM. Two reasons. Views differ -- a report's controls are a toolbar, a
 * list's are an action row -- and a step should ring whichever one this screen
 * has. And several views build their head after their data arrives, so any
 * scheme that stamps an attribute on at mount time misses them; resolving at
 * the moment the step runs cannot.
 *
 * A spec that is not a name here is used as a plain CSS selector.
 */
const TARGETS = {
  'page-title': ['.main .page-head h1', '.main h1', '.main .card-head h2'],
  'page-actions': ['.main .page-head .page-actions', '.main .toolbar', '.main .page-head'],
  toolbar: ['.main .toolbar', '.main .tabs', '.main .card-head'],
  grid: ['.main table.grid', '.main .card'],
  card: ['.main .card'],
  tabs: ['.main .tabs'],
};

/** First element matching a step's target, or null. */
function resolveTarget(spec) {
  if (!spec) return null;
  for (const sel of TARGETS[spec] || [spec]) {
    const el = document.querySelector(sel);
    if (el && el.getBoundingClientRect().width > 0) return el;
  }
  return null;
}

/**
 * Start a tour. Safe to call twice: a second call replaces the first rather
 * than stacking two spotlights on one screen.
 */
export async function startTour(id) {
  const tour = tourById(id);
  if (!tour) return;
  if (active) endTour({ silent: true });

  const masks = [h('div.tour-mask'), h('div.tour-mask'), h('div.tour-mask'), h('div.tour-mask')];
  const ring = h('div.tour-ring.pulse');
  const pop = h('div.tour-pop');
  const host = h('div', ...masks, ring, pop);
  document.body.appendChild(host);

  // The steps that apply to this user, resolved once so the numbering shown in
  // "3 of 9" matches what they will actually be shown.
  const steps = tour.steps.filter((s) => !s.when || safely(s.when));
  active = { tour, steps, index: 0, host, masks, ring, pop, target: null };

  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, true);
  document.body.classList.add('tour-active');

  await show(0);
}

export function endTour({ silent = false, completed = false } = {}) {
  if (!active) return;
  const { host, tour } = active;
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', reposition);
  window.removeEventListener('scroll', reposition, true);
  document.body.classList.remove('tour-active');
  host.remove();
  active = null;
  if (completed) markDone(tour.id);
  if (!silent && !completed) {
    // Leaving early is a normal thing to do, not a failure, and the way back
    // in should be visible at the moment somebody has just left.
    import('./ui.js').then(({ toast }) => toast(
      'Tour closed. The Learning centre has it whenever you want it.',
      { kind: 'info', timeout: 4200 },
    ));
  }
}

function onKey(e) {
  if (!active) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endTour(); return; }
  // Arrow keys are how somebody reads a tour; they must not also scroll the
  // page underneath it, and they must not fight a control being demonstrated.
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if (typing) return;
  if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
}

const next = () => { if (active) (active.index >= active.steps.length - 1 ? endTour({ completed: true }) : show(active.index + 1)); };
const back = () => { if (active && active.index > 0) show(active.index - 1); };

async function show(index) {
  if (!active) return;
  active.index = index;
  const step = active.steps[index];
  if (!step) return endTour({ completed: true });

  // Navigate first. The router replaces the whole main pane, so anything we
  // measured before this point is gone.
  if (step.route && location.hash.slice(1) !== step.route) {
    window.__meridianGo?.(step.route);
    await sleep(90);
  }
  if (step.navGroup) openNavGroup(step.navGroup);

  renderPop(step, index);
  // Placed centrally while the target is being looked for, so the card is
  // never invisible and never jumps in from off-screen.
  active.target = null;
  layout(null, step);

  if (step.target) {
    const el = await waitForEl(step.target);
    if (!active || active.index !== index) return;                // superseded
    if (el) {
      active.target = el;
      const r = el.getBoundingClientRect();
      const main = document.querySelector('.main');
      // Scroll it into view only if it is actually out of view: scrolling a
      // control that is already visible makes the page lurch for no reason.
      if (main && (r.top < 70 || r.bottom > window.innerHeight - 40)) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        await sleep(320);
      }
      if (!active || active.index !== index) return;
    }
    layout(active.target, step);
  }
}

function openNavGroup(name) {
  const g = document.querySelector(`.nav-group[data-group="${CSS.escape(name)}"]`);
  if (g?.classList.contains('closed')) g.querySelector('.nav-group-label')?.click();
}

function renderPop(step, index) {
  const { pop, steps, tour } = active;
  const last = index === steps.length - 1;
  mount(pop,
    h('button.tour-skip', { onclick: () => endTour(), title: 'Close tour (Esc)', 'aria-label': 'Close tour' }, icon('x', { size: 15 })),
    h('div.tour-pop-head',
      h('div', { style: { minWidth: 0 } },
        h('div.tour-eyebrow', icon(tour.icon || 'compass', { size: 12 }), tour.title),
        h('h3', step.title))),
    h('div.tour-pop-body',
      ...(step.body || []).map(para),
      step.note && h('div.tour-note', icon('lightbulb', { size: 13, className: 'ic' }), ' ', ...rich(step.note))),
    h('div.tour-pop-foot',
      steps.length <= 12
        ? h('div.tour-dots', ...steps.map((_s, i) => h('button.tour-dot', {
          class: i === index ? 'now' : i < index ? 'done' : '',
          title: `Step ${i + 1}: ${steps[i].title}`,
          'aria-label': `Step ${i + 1} of ${steps.length}`,
          onclick: () => show(i),
        })))
        : h('div.tour-count', `${index + 1} of ${steps.length}`),
      index > 0 && h('button.btn.sm', { onclick: back }, icon('chevron-left', { size: 13 }), 'Back'),
      h('button.btn.sm.primary', { onclick: next },
        last ? 'Finish' : 'Next',
        icon(last ? 'check' : 'chevron-right', { size: 13 }))));
}

/**
 * Put the four mask panels around `el` and the card next to it.
 * With no target, the masks cover everything and the card sits centred.
 */
function layout(el, step = {}) {
  if (!active) return;
  const { masks, ring, pop } = active;
  const W = window.innerWidth, H = window.innerHeight;
  const pad = 6;

  if (!el) {
    ring.style.opacity = '0';
    setMask(masks[0], 0, 0, W, H);
    [1, 2, 3].forEach((i) => setMask(masks[i], 0, 0, 0, 0));
    pop.classList.add('centred');
    pop.style.top = ''; pop.style.left = '';
    return;
  }

  const r = el.getBoundingClientRect();
  const box = {
    top: Math.max(0, r.top - pad), left: Math.max(0, r.left - pad),
    right: Math.min(W, r.right + pad), bottom: Math.min(H, r.bottom + pad),
  };
  ring.style.opacity = '1';
  Object.assign(ring.style, {
    top: `${box.top}px`, left: `${box.left}px`,
    width: `${Math.max(0, box.right - box.left)}px`, height: `${Math.max(0, box.bottom - box.top)}px`,
  });
  // top, bottom, left, right of the hole
  setMask(masks[0], 0, 0, W, box.top);
  setMask(masks[1], 0, box.bottom, W, H - box.bottom);
  setMask(masks[2], 0, box.top, box.left, box.bottom - box.top);
  setMask(masks[3], box.right, box.top, W - box.right, box.bottom - box.top);

  pop.classList.remove('centred');
  const pw = pop.offsetWidth || 378;
  const ph = pop.offsetHeight || 240;
  const gap = 14;
  const fits = {
    bottom: H - box.bottom - gap >= ph, top: box.top - gap >= ph,
    right: W - box.right - gap >= pw, left: box.left - gap >= pw,
  };
  const order = [step.place, 'bottom', 'right', 'top', 'left'].filter(Boolean);
  // A target can be bigger than the space around it -- a full-height table, the
  // sidebar on a short window -- and then no side fits. Sitting the card in the
  // middle of it would hide the very thing being pointed at, so it goes to the
  // far corner instead: still clearly attached by the ring, covering only the
  // part of a long list nobody is reading yet.
  const place = order.find((p) => fits[p]) || 'corner';

  let top, left;
  if (place === 'bottom') { top = box.bottom + gap; left = centreOn(r.left + r.width / 2, pw, W); }
  else if (place === 'top') { top = box.top - gap - ph; left = centreOn(r.left + r.width / 2, pw, W); }
  else if (place === 'right') { left = box.right + gap; top = centreOn(r.top + r.height / 2, ph, H); }
  else if (place === 'left') { left = box.left - gap - pw; top = centreOn(r.top + r.height / 2, ph, H); }
  else { left = W - pw - 20; top = H - ph - 20; }

  pop.style.top = `${clamp(top, 10, Math.max(10, H - ph - 10))}px`;
  pop.style.left = `${clamp(left, 10, Math.max(10, W - pw - 10))}px`;
}

const centreOn = (mid, size, limit) => clamp(mid - size / 2, 10, Math.max(10, limit - size - 10));
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
function setMask(m, left, top, width, height) {
  Object.assign(m.style, { left: `${left}px`, top: `${top}px`, width: `${Math.max(0, width)}px`, height: `${Math.max(0, height)}px` });
}

let repoTimer = null;
function reposition() {
  if (!active) return;
  // Scroll fires far more often than a layout needs recomputing.
  if (repoTimer) return;
  repoTimer = requestAnimationFrame(() => {
    repoTimer = null;
    if (active) layout(active.target, active.steps[active.index] || {});
  });
}

// ===================================================================== welcome
/**
 * The first-run offer.
 *
 * Shown once, and only ever once, because an application that asks a second
 * time has not understood the first answer. "Explore on my own" is a real
 * answer, and the Learning centre stays in the sidebar either way.
 */
export function maybeOfferWelcome() {
  if (store.getPref('tour.welcomed', false)) return false;
  store.syncPref('tour.welcomed', true);
  setTimeout(() => showWelcome(), 620);
  return true;
}

export function showWelcome() {
  const tours = availableTours();
  const first = tours[0];
  const m = modal({
    title: 'Welcome',
    size: 'narrow',
    body: h('div',
      h('div.welcome-hero',
        h('div.brand-mark', 'M'),
        h('h2', 'Welcome to Meridian'),
        h('p', `${store.state.tenant?.name || 'Your company'} is set up and ready. Would you like to be shown around first?`)),
      h('div.stack',
        first && h('button.track', {
          onclick: () => { m.close(null); startTour(first.id); },
        },
          h('div.track-icon', icon('play', { size: 15 })),
          h('div.track-body',
            h('div.track-title', 'Show me around'),
            h('div.track-sub', `${first.title} — about ${first.minutes} minutes, on your own data.`)),
          h('div.track-meta', icon('chevron-right', { size: 15 }))),
        h('button.track', {
          onclick: () => { m.close(null); window.__meridianGo?.('/learn'); },
        },
          h('div.track-icon', icon('graduation-cap', { size: 15 })),
          h('div.track-body',
            h('div.track-title', 'Show me the full set of walkthroughs'),
            h('div.track-sub', `${tours.length} guided tours: a sale end to end, a purchase, a month-end close, reporting, and how to customise it.`)),
          h('div.track-meta', icon('chevron-right', { size: 15 }))),
        h('div.tip', { style: { marginTop: 'var(--s2)' } },
          icon('lightbulb', { size: 14 }),
          h('div', 'Not now is fine. Everything here stays under ',
            h('strong', 'Learning centre'), ' at the bottom of the sidebar.')))),
    actions: [{ label: 'I\'ll explore on my own', value: null }],
  });
  return m;
}
