# Meridian ERP — Development Roadmap

## Where this repository stands

Phases 0–5 are **built and working**, with 75 automated tests. What follows
separates that from what a real deployment would still need.

---

## Phase 0 — Foundations ✅ *shipped*

The parts everything else assumes, built first because retrofitting any of
them is a rewrite.

* Tenant-scoped data access that **refuses** unscoped SQL at prepare time
* Integer money and scaled quantities — no floats anywhere near an amount
* Migration runner, transaction manager with SAVEPOINT nesting
* scrypt passwords, sessions, stateless CSRF, API tokens
* RBAC with row-level security, append-only audit trail
* Router, error contract, rate limiting, security headers

> **Why first:** multi-tenancy and money representation are the two decisions
> that cannot be changed later without touching every table and every query.

## Phase 1 — General ledger ✅ *shipped*

* Chart of accounts with types, subtypes and a summary/postable distinction
* Accounting periods with close, reopen and lock
* Multi-currency with dated rates; multi-subsidiary with base-currency conversion
* `postJournal` — the single write path, enforcing balance, open period,
  postable accounts and immutability
* Reversal as the only correction mechanism
* Materialised balance rollup, kept consistent inside the writing transaction,
  with an integrity endpoint that proves it

## Phase 2 — Entities and transactions ✅ *shipped*

* Customers, vendors, contacts, with credit limits, terms and credit control
* The unified transaction model — one table, twelve document types
* Order-to-cash and procure-to-pay, with partial fulfilment and partial billing
* Price levels, volume breaks, expression-driven pricing rules
* Approval routing; payment application and unapplication
* Per-type posting rules in one reviewable function

## Phase 3 — Inventory ✅ *shipped*

* Multi-location stock with commitments and on-order tracking
* Moving-average costing per item and per location
* Append-only stock ledger; point-in-time valuation
* Demand-based reorder analysis; one-click purchase-order generation

## Phase 4 — CRM, HR and banking ✅ *shipped*

* Leads, conversion, opportunities, pipeline, weighted forecasting
* Support cases with SLA tracking and threaded conversation
* Employee directory, cycle-validated org chart, time tracking, time off
* Payroll calculation, posting, and provider hand-off through the outbox
* Statement import, confidence-rated matching, reconciliation

## Phase 5 — Platform and interface ✅ *shipped*

* Custom fields, including read-time formulas
* Workflow engine — declarative, transactional, sandboxed
* Saved searches over a validated query builder; CSV export
* Financial statements, aging, sales analysis, audit reporting
* Dashboard with drag-reorderable widgets; 20+ screens; light and dark
* Native macOS and Windows packaging with a bundled runtime

---

# What a production deployment needs next

## Phase 6 — Operational hardening *(4–6 weeks)*

The gap between "works" and "you can run a business on it".

| Item | Why |
|---|---|
| **Backup and restore** | Scheduled `VACUUM INTO` snapshots, retention, and a *tested* restore path. An untested backup is not a backup. |
| **Outbox worker** | `integration_event` is written but not yet drained. Needs a delivery loop with exponential backoff, a dead-letter state and replay. |
| **Password reset** | Email-based reset with single-use, expiring tokens. Currently an administrator sets passwords. |
| **Two-factor authentication** | TOTP, enforced per role. Table stakes for anything touching a ledger. |
| **Session management UI** | Let users see and revoke their active sessions. |
| **Structured logging and metrics** | Request id, tenant, user, duration as JSON; slow-query log; health beyond a liveness ping. |
| **Import** | CSV import with dry-run preview, field mapping and per-row error reporting — the first thing anyone migrating from another system asks for. |

## Phase 7 — Accounting depth *(6–10 weeks)*

The things a controller will notice are missing within a month.

| Item | Notes |
|---|---|
| **Year-end close** | Roll income and expense into retained earnings; opening balances for the new year. |
| **Recurring journals and accruals** | Templates with a schedule; automatic reversal in the following period. |
| **Fixed assets** | Register, depreciation schedules (straight line, reducing balance), disposal with gain/loss. |
| **Revenue recognition** | Deferral schedules for subscription and multi-element arrangements. ASC 606 shape. |
| **Unrealised FX revaluation** | Period-end revaluation of foreign-currency AR/AP balances. |
| **Intercompany elimination** | Automatic elimination entries on consolidation; the schema already carries the flag. |
| **Budgets and variance** | Budget by account, period and department; budget-vs-actual reporting. |
| **1099 / VAT returns** | Vendor 1099 tracking; VAT return preparation from tax codes already captured. |

## Phase 8 — Scale *(8–12 weeks)*

Triggered by concurrency, not by record count. SQLite's single-writer model is
the ceiling, and it arrives well before storage does.

1. **PostgreSQL migration.** The dialect surface is small and confined to
   `core/db.mjs` plus module SQL. `INTEGER` → `BIGINT`, FTS5 → `tsvector`,
   `rowFilter` → native row-level security policies (a strengthening, since the
   database enforces it rather than the application).
2. **Read replicas** for reporting — `modules/reports.mjs` is read-only.
3. **Extract the search indexer** behind the existing three-function seam.
4. **Extract payroll and integrations** — already asynchronous.
5. **Horizontal API nodes** with sessions in Redis rather than the database.

The ledger stays monolithic. Splitting the GL from the subledgers converts
atomic postings into distributed sagas whose compensating transactions are
*reversals* — real accounting events that would exist only to serve a
deployment topology.

## Phase 9 — Compliance certification *(ongoing)*

The controls are built; certification is process and evidence.

* **SOC 2 Type II** — the audit trail, RBAC and change management already
  produce the evidence. Needs formal policies, a 6–12 month observation
  window, and an auditor.
* **GDPR** — export and erasure endpoints per data subject, with the
  legal-retention carve-out for financial records already distinguished by the
  `financial` flag on audit events. Add a data-processing register and
  configurable retention.
* **Penetration test** against the expression sandbox, the query builder and
  the tenant boundary specifically.
* **Encryption at rest** — SQLCipher, or filesystem-level, or Postgres TDE
  depending on where Phase 8 lands.

## Phase 10 — Ecosystem

* **GraphQL** over the existing resolver layer, for clients that want one round trip
* **Webhook subscriptions** — the outbox exists; tenants need self-service registration
* **OAuth 2.0 / OIDC** for third-party apps, and SAML SSO for enterprise
* **Mobile** — approvals, expenses and time entry are the three that matter
* **Sandbox tenants** — copy production to a scratch tenant for testing customisations

---

## Sequencing rationale

The order is driven by **what is expensive to change later**, not by what
demonstrates well.

Tenancy and money representation came first because they touch every table.
The ledger came before the subledgers because everything posts to it. The
unified transaction model came before any individual document type, because
inverting that order means writing custom fields, saved searches, workflows
and audit twelve separate times.

Phase 6 precedes Phase 7 for the same reason: an ERP that loses a week of data
is worse than one that cannot calculate depreciation. Backups before features.
