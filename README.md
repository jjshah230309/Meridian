# Meridian ERP

A multi-tenant cloud ERP and business management platform: general ledger,
CRM, inventory, order management and HR, with a customisation engine, RBAC,
audit trails and a dashboard-driven web interface.

It runs as **one self-contained application** on macOS and Windows. No
database server, no message broker, no search cluster, no npm install — the
entire system is Node's standard library plus a single SQLite file.

It has its own window. On macOS the packaged app is a native Cocoa
application hosting a `WKWebView`: no browser, nothing to install, and
quitting it stops the service. On Windows it opens a chromeless
Edge/WebView2 window with its own taskbar entry.

```
                    ┌──────────────────────────────┐
   double-click ──► │  Meridian ERP                │
                    │  native window (WKWebView /  │
                    │    WebView2) — no browser    │
                    │  bundled Node runtime        │
                    │  embedded web client         │
                    │  SQLite (WAL, ACID)          │
                    └──────────────────────────────┘
```

---

## Quick start

```bash
npm start
```

Meridian is a desktop application first. `npm start` hands over to an
installed copy if there is one; otherwise it serves this working tree and
opens a window on it.

| Command | What it does |
|---|---|
| `npm start` | Open Meridian the way a user does |
| `npm run dev` | Serve this working tree, verbose |
| `npm run server` | Run as a server on the network — no window |
| `npm run reset` | Rebuild the demo company from scratch |
| `npm test` | The full test suite |
| `npm run package` | Build the macOS and Windows distributions |
| `npm run service` | Install/remove it as a background service |
| `npm run backup` | Take, list or restore a consistent backup |

### Running it for a team

One machine holds the data; everybody else connects to it.

```bash
npm run server                     # on the machine that holds the data
node scripts/service.mjs install   # so it starts at boot
```

Then on each person's machine: **Settings → Connection → On a server**, and
enter the address the server printed. There is no cloud account — the server
is yours.

The full manual is inside the application under **Help**, and the sources are
in `src/web/manual/`.

The first run creates the database, applies migrations, seeds a demo company
and opens the app. Sign in with:

| | |
|---|---|
| Email | `admin@northwind.test` |
| Password | `Northwind-Demo-2026` |

The demo company has six months of trading history: ~1,500 transactions,
~1,100 journal entries, 24 customers, 12 vendors, 20 employees, a sales
pipeline, support cases, two warehouses and a UK subsidiary on GBP.

### Other commands

```bash
node src/server.mjs --reset        # start from an empty database
node src/server.mjs --seed         # (re)create the demo company
node src/server.mjs --port 9000    # different port
node src/server.mjs --no-open      # don't open a window
node --test test/                  # run the test suite (75 tests)
node scripts/package.mjs           # build a native distribution
```

---

## Building native distributions

```bash
node scripts/package.mjs                      # for this machine
node scripts/package.mjs --target win-x64     # Windows
node scripts/package.mjs --target darwin-arm64 --target win-x64
```

This produces, in `dist/`:

* **`Meridian ERP.app`** — a real macOS bundle, ad-hoc signed, double-clickable.
  Its executable is a native Cocoa application (`native/macos/main.swift`,
  compiled at package time) that hosts a `WKWebView`, runs the server as its
  own child process and stops it on quit. No browser is launched or required.
  Data in `~/Library/Application Support/Meridian`.
* **`Meridian ERP/`** — a Windows folder. `Meridian ERP.vbs` starts it with no
  console window; `Create Shortcut.ps1` adds Start-menu and desktop shortcuts
  with the bundled icon. The window is Edge/WebView2 in app mode — no tabs, no
  address bar, its own taskbar entry — because Windows ships no embeddable web
  host we can link against without a compiler on the target machine. Edge is
  part of Windows 10 and 11, so nothing needs installing.
  Data in `%LOCALAPPDATA%\Meridian`.

Each bundles the official, statically linked Node runtime, so the target
machine needs nothing installed. About 100–145 MB per platform, almost all of
which is the runtime; the application itself is under 1 MB.

Building the macOS native host needs the Xcode Command Line Tools on the
*build* machine only. Without them the packaging script says so and falls back
to a browser window rather than failing silently.

---

## What is in the box

| Module | What it does |
|---|---|
| **Financial management** | Chart of accounts, double-entry GL, multi-currency, multi-subsidiary, accounting periods with close/reopen, AR, AP, bank reconciliation, trial balance, P&L, balance sheet, cash flow, aging |
| **CRM** | Leads with conversion, contacts, opportunities with a drag-and-drop pipeline, weighted forecasting, activities, support cases with SLA tracking |
| **Supply chain & inventory** | Multi-location stock, moving-average costing, commitments, demand-based reorder analysis, one-click purchase-order generation, valuation |
| **Order management** | Quote → order → fulfilment → invoice → payment, purchase order → receipt → bill → payment, price levels, volume breaks, declarative pricing rules, approval routing |
| **HR (SuitePeople-style)** | Employee directory, org chart, time tracking with approval, time off, payroll calculation and posting, provider integration hooks |
| **Platform** | Custom fields (including formulas), a workflow engine, saved searches, role-based access control with row-level security, immutable audit trail, full-text search, CSV export, REST API with token auth |

---

## Architecture in one paragraph

A **modular monolith**: one process, clear module boundaries, one transaction
per request. The general ledger is the system of record and every other module
posts to it through a single function. Tenant isolation is structural — all
data access goes through a tenant-scoped repository that refuses to build SQL
without a tenant predicate. The web client is dependency-free ES modules
served from the same origin under a strict CSP.

Full detail, including where the seams are for splitting this into services:
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Documentation

| | |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | System design, data flow, scaling path |
| [Database schema](docs/SCHEMA.md) | The GL and inventory models in detail |
| [API reference](docs/API.md) | Every endpoint, with examples |
| [Roadmap](docs/ROADMAP.md) | Phased delivery plan |
| [Security & compliance](docs/SECURITY.md) | Threat model, RBAC, GDPR/SOC 2 posture |

---

## Honest scope

This is a complete, working ERP across the five modules above — not a
NetSuite clone, and it does not pretend to be. What is deliberately **not**
here, and why:

* **No statutory tax engine.** Payroll and sales tax rates are configuration.
  Real tax is jurisdiction-specific, changes yearly, and getting it wrong is a
  legal problem rather than a bug. Payroll calculates gross-to-net and posts
  the journal; funding and filing go to a payroll provider through the
  integration outbox.
* **No arbitrary user code on the server.** The customisation engine runs a
  sandboxed expression language, not tenant JavaScript. `node:vm` is not a
  security boundary, so a SuiteScript-style code runner exists but is disabled
  by default and documented as single-tenant only.
* **No GraphQL.** The REST API plus the saved-search query endpoint covers the
  same ground; the resolver layer is factored so GraphQL can be added over it.
* **Single node.** SQLite in WAL mode is genuinely ACID and handles this
  workload comfortably, but one writer at a time. The Postgres migration path
  is documented rather than pretended away.

## Licence

MIT. See [LICENSE](LICENSE).
