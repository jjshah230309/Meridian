# Meridian ERP — System Architecture

## 1. The shape of the system

```
┌──────────────────────────────────────────────────────────────────────────┐
│  CLIENT — dependency-free ES modules, strict CSP, same origin            │
│                                                                          │
│   app.js ── router ── views/ ── dashboard · lists · records · txn ·      │
│      │                          journal · reports · crm · hr · bank ·    │
│      │                          inventory · setup                        │
│      │                                                                   │
│   store.js (session, metadata, reference cache)                          │
│   api.js (fetch + CSRF)   ui.js (fields, modals)   charts.js (SVG)       │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │  HTTPS · JSON · cookie session or Bearer token
┌────────────────────────────────▼─────────────────────────────────────────┐
│  REQUEST PIPELINE  (src/server.mjs)                                      │
│                                                                          │
│   route match → rate limit → body → identity → tenant → RBAC → CSRF      │
│                                                     │                    │
│                          one database transaction per mutating request   │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │
┌────────────────────────────────▼─────────────────────────────────────────┐
│  API LAYER  (src/api.mjs)                                                │
│   generic record CRUD · module endpoints · reports · setup · export      │
└────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────────┘
     │          │          │          │          │          │
┌────▼────┐┌────▼────┐┌────▼────┐┌────▼────┐┌────▼────┐┌────▼─────────────┐
│   gl    ││   txn   ││inventory││   crm   ││   hr    ││    platform      │
│ ledger  ││ order-  ││  stock  ││  lead-  ││ people  ││ custom fields    │
│ periods ││ to-cash ││ costing ││ to-cash ││ payroll ││ workflows        │
│ fx      ││ p-to-p  ││ reorder ││ support ││ time    ││ saved searches   │
└────┬────┘└────┬────┘└────┬────┘└────┬────┘└────┬────┘└────┬─────────────┘
     │          │          │          │          │          │
     └──────────┴──────────┴────┬─────┴──────────┴──────────┘
                                │  every module goes through …
┌───────────────────────────────▼──────────────────────────────────────────┐
│  CORE                                                                    │
│   db.mjs      tenant-scoped Repo · transactions · migrations             │
│   auth.mjs    scrypt passwords · sessions · CSRF · API tokens            │
│   rbac.mjs    permissions · row-level security                           │
│   expr.mjs    sandboxed expression language                              │
│   audit.mjs   append-only trail      search.mjs   FTS5 index             │
│   seq.mjs     document numbering     http.mjs     router · errors        │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────────┐
│  SQLite — WAL, synchronous=FULL, foreign keys on, STRICT tables          │
│  one file · ACID · FTS5 full-text · integer money                        │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Why a modular monolith, not microservices

The brief asked for microservices. Meridian is a modular monolith, and that is
a considered decision rather than a shortcut.

An ERP's defining characteristic is that **one user action touches many
domains atomically**. Shipping a sales order moves stock, values it at moving
average cost, posts COGS and an inventory relief to the ledger, advances the
order's fulfilment state, releases a reservation, fires workflows, and writes
audit rows. Either all of that happens or none of it does. Across services
that requires a saga with compensating transactions for every step — and a
compensating transaction against a *posted ledger* is a reversal, which is a
real accounting event that auditors will ask about. You would be inventing
accounting artefacts to paper over a deployment choice.

In one process this is `transaction(db, () => { ... })`.

What Meridian keeps from the microservice discipline:

* **Module boundaries are real.** Modules talk through exported functions with
  explicit arguments. `inventory` knows nothing about invoices; `txn` asks it
  to move stock and gets back a valuation.
* **The ledger has one entrance.** `gl.postJournal` is the only way anything
  reaches `journal_entry`. Every posting rule in the system is visible in one
  function, `txn.postingPlan`.
* **Outbound I/O is queued, never inline.** Payroll submissions and webhooks
  are written to `integration_event` in the same transaction as the business
  record, then delivered separately. A slow provider can never hold a ledger
  transaction open or roll one back.
* **The data layer is swappable.** All SQL is built in `core/db.mjs` and the
  module functions; nothing constructs SQL in the API or client layers.

### When to split, and where

The seams are already cut. In order of when they start to matter:

1. **Reporting reads** — `modules/reports.mjs` only reads. Point it at a
   replica first; this is the change that buys the most headroom.
2. **Search** — `core/search.mjs` has exactly two write functions and one read
   function. Swapping FTS5 for Elasticsearch means reimplementing those three,
   nothing else.
3. **Payroll and integrations** — already asynchronous through the outbox, so
   a worker can move out of process without touching the callers.
4. **The ledger stays.** Splitting the GL from the subledgers is the change
   that buys the least and costs the most.

---

## 3. Multi-tenancy

Tenant isolation is **structural, not conventional**. Every business table
carries `tenant_id` as the leading column of its primary key, so the predicate
is an index seek rather than a filter.

All data access goes through `Repo`, constructed once per request with the
authenticated tenant:

```js
const repo = new Repo(db, tenant.id, { user, access, ip, requestId });
repo.find('customer', { where: { status: 'active' } });     // tenant injected
repo.query('SELECT * FROM txn WHERE tenant_id = :t AND …'); // :t is the only way in
```

Raw SQL must carry the `:t` marker. A query that touches a tenant-scoped table
without it **throws at prepare time**:

```
DbError: Query touches tenant-scoped table "customer" without a :t predicate.
```

`bindTenant` walks the statement character by character — skipping string
literals and comments — and interleaves the tenant parameter with the caller's
own `?` placeholders in the right order.

A test asserts that **every table in the schema carrying a `tenant_id` column
is declared in `TENANT_TABLES`**, so adding a table without wiring it up fails
the build rather than leaking in production. `session` and `api_token` are the
one sanctioned exception: they are looked up by an unguessable credential
digest *before* a tenant is known, because that lookup is what establishes the
tenant.

---

## 4. Money, quantity and the ledger

**Money is never a float.** All amounts are integer minor units (cents).
Quantities are integers scaled by 10⁶ so fractional units survive arithmetic.
Rounding happens exactly once, at the point a rate or percentage is applied,
half-away-from-zero. `Money.allocate` splits an amount by weights such that the
parts sum exactly to the whole.

### The posting engine

`gl.postJournal` is the single write path into the ledger. It guarantees:

1. **Balance.** Debits equal credits in the transaction currency *and* in the
   subsidiary's base currency.
2. **Open period.** The date falls in a period whose status is `open`.
3. **Postable accounts.** No summary accounts, no inactive accounts, no
   accounts belonging to another subsidiary.
4. **Immutability.** A posted entry is never edited. Corrections are
   reversals, so the trail shows what was believed and when it was corrected.
5. **A consistent rollup.** `gl_balance` — a materialised balance per
   subsidiary/period/account — is updated in the *same statement batch* as the
   journal lines, so it cannot drift.

FX rounding of a cent or two across lines is absorbed into the realised FX
account rather than rejecting an otherwise valid entry; anything beyond a
per-line tolerance is refused with the rate and date in the message.

### Reporting reads the rollup, then fills the gaps

`reports.balancesFor` reads `gl_balance` for periods **entirely inside** the
requested window — one indexed row per account per period, so a twelve-month
P&L is a handful of lookups — and sums journal detail only for the periods
**partially** covered, such as the current month. Using the rollup alone would
silently drop the current month from every month-to-date figure; using detail
alone would scan the journal for every report.

`/api/v1/reports/integrity` re-derives the rollup from the detail and compares
it, confirms every posted entry balances, and looks for orphaned lines. A
financial system should be able to prove this on demand.

---

## 5. The unified transaction model

Quotes, orders, fulfilments, invoices, credit memos, payments, purchase
orders, receipts, bills, adjustments and transfers are all rows in `txn` with
children in `txn_line`, discriminated by `type`. This mirrors NetSuite's own
design, and it is what lets custom fields, saved searches, workflows,
approvals, audit and row-level security work uniformly across every document
instead of being reimplemented a dozen times.

```
QUOTE ──► SALES_ORDER ──┬─► FULFILLMENT ──► (stock out, COGS)
                        └─► INVOICE ──► CUSTOMER_PAYMENT
PURCHASE_ORDER ──► ITEM_RECEIPT ──► VENDOR_BILL ──► VENDOR_PAYMENT
                   (stock in,        (clears the
                    accrual)          accrual)
```

`TYPES` declares, per document type, whether it posts to the GL, what it does
to stock, whether it commits or orders inventory, and which sequence it draws
its number from. `transform()` walks the chain, respects remaining quantities,
cascades progress back to the source document, and recomputes lifecycle
status. Everything else is derived from that table.

---

## 6. The customisation engine

Tenant-authored logic is **data evaluated by an interpreter**, never code
handed to the JavaScript engine.

`core/expr.mjs` is a ~350-line expression language: tokenizer, precedence-
climbing parser, tree-walking evaluator. It has no host object access, no
prototype traversal, no loops, no I/O, and a hard step budget. Own-property
checks only; `__proto__`, `constructor` and `prototype` throw. Functions come
from a fixed allowlist.

One engine powers five features:

| Feature | Expression is used as |
|---|---|
| Workflow conditions | `total > 50000 && status == "open"` |
| Formula custom fields | `IF(probability >= 70, "Strong", "At risk")` |
| Pricing rules | `quantity >= 25` |
| Approval routing | `max_line_discount > 20` |
| Saved-search filters | structured filters compiled to SQL |

Workflows run **inside the same transaction** as the record that fired them,
so a `before_*` workflow that blocks a save really does prevent it. A workflow
that throws is logged to `workflow_log` and skipped — tenant automation must
never be able to take down a posting run.

A `node:vm`-based script runner exists for SuiteScript-style server scripts.
It is **disabled unless `MERIDIAN_ENABLE_SCRIPTS=1`**, because `node:vm` is an
isolation mechanism and not a security boundary. See
[SECURITY.md](SECURITY.md).

---

## 7. Search

The brief specified Elasticsearch. Meridian uses **SQLite FTS5**, deliberately.

FTS5 gives BM25 ranking, prefix and phrase queries, and snippet highlighting,
at sub-millisecond latency on this data volume — inside the same ACID
transaction as the write, with no second service to run, secure, back up or
keep in sync. An index that updates in the same transaction as the record can
never be stale, which removes an entire class of "the search says it exists
but the record is gone" bugs.

`core/search.mjs` is the seam: `indexRecord`, `unindexRecord`, `search`.
Swapping in an external engine means reimplementing three functions.

---

## 8. Request pipeline and security posture

Ordered so that cheap rejections happen first:

1. **Route match** — patterns compiled segment by segment; unknown path → 404,
   known path with the wrong method → 405.
2. **Rate limit** — fixed-window, with a much tighter bucket on `/auth/login`.
3. **Body** — 8 MB cap, content-type aware.
4. **Identity** — session cookie (`HttpOnly`, `SameSite=Strict`) or
   `Bearer` API token. Only the digest of either is ever stored.
5. **Tenant and access** — the tenant comes from the credential, never from
   client input. Effective permissions are the union of the user's roles.
6. **CSRF** — cookie-authenticated writes must present a stateless HMAC token
   derived from the session id, plus an origin check. Bearer clients are
   exempt: a browser cannot be tricked into attaching a token it must set
   explicitly.
7. **Handler**, inside one transaction.

Every response carries a strict CSP (`default-src 'self'`, no inline script),
`X-Frame-Options: DENY`, `nosniff` and a restrictive `Permissions-Policy`.
The client has no inline handlers and no CDN dependencies, so the CSP needs no
exceptions — which is also why a tenant's custom field label can never become
an XSS vector.

---

## 9. Durability

```
journal_mode = WAL          reporting reads run concurrently with posting writes
synchronous  = FULL         a committed ledger entry has reached the disk
foreign_keys = ON           referential integrity STRICT tables cannot express
STRICT tables               a type error is a write failure, not a silent coercion
```

`synchronous=FULL` is slower than the usual `NORMAL`. For money, that is the
right trade.

Nested `transaction()` calls become SAVEPOINTs, so a module can compose —
posting a journal inside creating an invoice inside a workflow — and the whole
tree still commits or rolls back as one unit.

---

## 10. Scaling path

| Users | What changes |
|---|---|
| **1–50** | As shipped. One file, one process. |
| **50–500** | Move reporting reads to a replica. Raise the SQLite page cache. |
| **500+** | Migrate to PostgreSQL. The dialect surface is small: `Repo` and the module SQL. `STRICT`/`INTEGER` maps to `BIGINT`, FTS5 to `tsvector` or Elasticsearch behind the existing seam. Row-level security moves into Postgres RLS policies, which strengthens what `rowFilter` does today. |
| **Multi-region** | Shard by tenant — every table is already keyed that way, and no query crosses tenants. |
