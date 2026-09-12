# Meridian ERP — Database Schema

SQLite, `STRICT` tables, foreign keys on, WAL. Five migrations in
`migrations/`, applied in order and recorded in `schema_migration`.

## Conventions

| | |
|---|---|
| **Tenant key** | Every business table carries `tenant_id` as the leading column of its primary key. |
| **Money** | `INTEGER` minor units (cents). Never a float. |
| **Quantity** | `INTEGER` scaled by 10⁶, so 1.5 units is `1500000`. |
| **Dates** | `TEXT` `YYYY-MM-DD`. Timestamps are ISO-8601 UTC. |
| **Booleans** | `INTEGER` 0/1. |
| **Ids** | ULID — lexicographically sortable, so `ORDER BY id` is chronological. |
| **JSON** | `TEXT` columns decoded on read by the repository. |

---

# Part 1 — The General Ledger

The GL is the system of record. Every subledger document posts to it through
`gl.postJournal`, and nothing else writes to `journal_entry`.

## Organisational structure

### `subsidiary`
A legal entity with its own base currency. Consolidation is by parent chain.

| Column | Type | Notes |
|---|---|---|
| `id`, `tenant_id` | TEXT | PK `(tenant_id, id)` |
| `name`, `legal_name` | TEXT | |
| `parent_id` | TEXT | consolidation hierarchy |
| `currency` | TEXT | **base currency — every posting converts to this** |
| `country`, `tax_number` | TEXT | |
| `is_elimination` | INTEGER | intercompany elimination entity |
| `active` | INTEGER | |

### `currency` and `exchange_rate`

```sql
currency(tenant_id, code, name, symbol, precision, active)
   PRIMARY KEY (tenant_id, code)

exchange_rate(tenant_id, from_currency, to_currency, rate_date, rate, source)
   PRIMARY KEY (tenant_id, from_currency, to_currency, rate_date)
```

A posting takes the most recent rate **on or before** its date. If none
exists, the posting is refused with the pair and date named — a missing rate is
never silently treated as 1.0.

### `department`, `segment_class`
Accounting segments carried on journal lines and transactions for slicing
reports without multiplying accounts.

---

## Chart of accounts

### `account`

| Column | Type | Notes |
|---|---|---|
| `id`, `tenant_id` | TEXT | PK `(tenant_id, id)` |
| `number` | TEXT | unique per tenant |
| `name` | TEXT | |
| `type` | TEXT | `ASSET` · `LIABILITY` · `EQUITY` · `INCOME` · `EXPENSE` |
| `subtype` | TEXT | `BANK`, `AR`, `INVENTORY`, `AP`, `COGS`, `RETAINED_EARNINGS`, … |
| `parent_id` | TEXT | tree; drives report roll-ups |
| `currency` | TEXT | NULL = multi-currency |
| `subsidiary_id` | TEXT | NULL = shared across subsidiaries |
| `is_summary` | INTEGER | **summary accounts cannot be posted to** |
| `cash_flow_category` | TEXT | `operating` · `investing` · `financing` |
| `active` | INTEGER | |
| `custom` | TEXT | JSON, tenant custom fields |

```sql
UNIQUE INDEX ux_account_number ON account(tenant_id, number);
INDEX        ix_account_type   ON account(tenant_id, type, active);
```

`type` determines the normal balance and which statement the account rolls
into. Changing the type of an account that already carries posted lines is
**blocked** — it would silently restate prior periods.

### `accounting_period`

```sql
accounting_period(
  id, tenant_id, name, start_date, end_date,
  fiscal_year, quarter, period_no,
  status,            -- open | closed | locked
  is_adjustment, closed_at, closed_by)
```

Closing checks that no draft entries remain and that the period balances,
with an explicit, audited override. A `locked` period can never be reopened.

---

## The journal

### `journal_entry`

| Column | Type | Notes |
|---|---|---|
| `id`, `tenant_id` | TEXT | PK |
| `entry_no` | TEXT | `JE-00001`, unique per tenant |
| `subsidiary_id` | TEXT | determines the base currency |
| `period_id` | TEXT | resolved from `txn_date` at post time |
| `txn_date` | TEXT | |
| `currency`, `fx_rate` | TEXT, REAL | transaction currency and the rate used |
| `memo` | TEXT | |
| `source_type` | TEXT | `manual` · `invoice` · `bill` · `payroll` · … |
| `source_id` | TEXT | the document that caused this entry |
| `status` | TEXT | `draft` · `posted` · `voided` |
| `is_reversal`, `reverses_id`, `reversed_by_id` | | the correction chain |
| `total_debit`, `total_credit` | INTEGER | base currency; always equal when posted |
| `posted_at`, `posted_by` | | |

### `journal_line`

| Column | Type | Notes |
|---|---|---|
| `entry_id`, `line_no` | | |
| `account_id` | TEXT | must be active and postable |
| `debit`, `credit` | INTEGER | **transaction** currency |
| `base_debit`, `base_credit` | INTEGER | **subsidiary base** currency — what reports sum |
| `currency`, `fx_rate` | | as applied to this line |
| `entity_type`, `entity_id` | | customer / vendor / employee subledger tag |
| `department_id`, `location_id`, `class_id`, `item_id` | | segments |

Storing both the transaction and base amounts means a foreign-currency invoice
can be shown to the customer in their currency and to the accountant in the
reporting currency without recomputing a historical rate.

### `gl_balance` — the materialised rollup

```sql
gl_balance(tenant_id, subsidiary_id, period_id, account_id,
           base_debit, base_credit)
  PRIMARY KEY (tenant_id, subsidiary_id, period_id, account_id)
```

Maintained inside the same transaction as `journal_line`, so it cannot drift.
Reports read this instead of scanning the journal.
`/api/v1/reports/integrity` re-derives it from the detail and compares;
`gl.rebuildBalances()` restores it from scratch if it ever needs to be.

---

## Cash management

```sql
bank_account(id, tenant_id, name, account_id → account, subsidiary_id,
             bank_name, number_masked, currency, active)

bank_txn(id, tenant_id, bank_account_id, txn_date, description, reference,
         amount,            -- signed minor units: + deposit, − withdrawal
         status,            -- unmatched | matched | reconciled | ignored
         matched_journal_id, reconciliation_id, external_id)

reconciliation(id, tenant_id, bank_account_id, statement_date,
               statement_balance, cleared_balance, difference, status)
```

`external_id` is uniquely indexed per bank account, so re-importing the same
statement file cannot duplicate cash. Only the last four digits of an account
number are ever stored.

---

# Part 2 — Inventory

## `item`

| Column | Type | Notes |
|---|---|---|
| `sku` | TEXT | unique per tenant |
| `type` | TEXT | `inventory` · `noninventory` · `service` · `assembly` · `kit` · `discount` |
| `uom` | TEXT | |
| `base_price`, `purchase_price`, `standard_cost` | INTEGER | minor units |
| `costing_method` | TEXT | `average` (default) or `standard` |
| `income_account_id`, `cogs_account_id`, `asset_account_id`, `expense_account_id` | TEXT | **per-item GL mapping; overrides the tenant defaults** |
| `preferred_vendor_id` | TEXT | drives reorder → PO generation |
| `taxable`, `tax_code` | | |
| `lead_time_days` | INTEGER | replenishment planning |
| `is_serialised`, `barcode`, `weight_g` | | |

Only `inventory` and `assembly` items are stocked. Changing a stocked item to
a non-stocked type while it has quantity on hand is blocked.

## `item_location` — the stock position

```sql
item_location(
  tenant_id, item_id, location_id,
  qty_on_hand,             -- physical
  qty_committed,           -- allocated to open sales orders
  qty_on_order,            -- open purchase orders
  qty_back_order,
  reorder_point, preferred_stock_level, safety_stock, lead_time_days,
  avg_cost,                -- moving average, minor units per unit
  total_value,             -- on-hand valuation
  bin, last_count_at)
  PRIMARY KEY (tenant_id, item_id, location_id)
```

**Available = `qty_on_hand − qty_committed`.** Committing stock to an order
never moves quantity or value; only a fulfilment does.

## `inventory_txn` — the append-only stock ledger

```sql
inventory_txn(
  id, tenant_id, item_id, location_id, txn_date,
  type,                    -- receipt|shipment|adjustment|transfer_in|transfer_out|build|count
  qty_delta, unit_cost, value_delta,
  running_qty, running_value,
  source_type, source_id, memo)
```

Every physical movement writes a row, so on-hand is always reproducible from
history and a valuation can be rebuilt as at any past date.

### Moving-average costing

Maintained **per item and per location** — the same item can legitimately have
different average costs in two warehouses.

On a **receipt** (`qty_delta > 0`):

```
newValue   = oldValue + receivedQty × unitCost
newAverage = newValue / (oldQty + receivedQty)
```

On an **issue** (`qty_delta < 0`) the movement is valued at the *current*
average, which is exactly the amount posted to COGS:

```
valueDelta = −issuedQty × currentAverage
```

Two deliberate rules:

* When quantity lands exactly on zero, the **entire** remaining value is
  flushed, so no rounding residue is stranded in the asset account.
* Shipping more than is on hand drives both quantity **and** value negative
  rather than costing the issue at zero. Negative inventory is visible and
  self-corrects on the next receipt; a silent zero-cost shipment overstates
  gross margin, which is far worse.

### Reorder analysis

Demand is measured from actual `shipment` rows over a lookback window:

```
averageDailyDemand = shippedQty / lookbackDays
computedReorderPoint = averageDailyDemand × leadTimeDays + safetyStock
effectiveReorderPoint = MAX(configuredReorderPoint, computedReorderPoint)
```

Taking the greater of the two means a stale manual setting cannot hide a real
stock-out risk. An item is flagged when
`available + onOrder ≤ effectiveReorderPoint`, and the suggested quantity
brings it up to the target level.

---

# Part 3 — The unified transaction model

Every business document is a `txn` row with `txn_line` children.

## `txn`

| Column | Notes |
|---|---|
| `type` | `QUOTE`, `SALES_ORDER`, `FULFILLMENT`, `INVOICE`, `CREDIT_MEMO`, `CUSTOMER_PAYMENT`, `PURCHASE_ORDER`, `ITEM_RECEIPT`, `VENDOR_BILL`, `VENDOR_PAYMENT`, `INVENTORY_ADJUSTMENT`, `INVENTORY_TRANSFER` |
| `txn_no` | unique per `(tenant, type)` |
| `entity_type`, `entity_id` | polymorphic: customer, vendor or employee |
| `subsidiary_id`, `location_id`, `to_location_id`, `department_id`, `class_id` | |
| `currency`, `fx_rate` | |
| `status` | `draft` · `pending_approval` · `open` · `partially_fulfilled` · `fulfilled` · `partially_received` · `received` · `billed` · `partially_paid` · `paid` · `closed` · `cancelled` · `rejected` · `voided` |
| `approval_status` | `not_required` · `pending` · `approved` · `rejected` |
| `subtotal`, `discount_total`, `tax_total`, `shipping_total`, `total`, `base_total` | minor units |
| `amount_applied`, `amount_remaining` | settlement state |
| `terms`, `due_date` | |
| `source_txn_id` | what this was transformed from |
| `journal_entry_id`, `period_id`, `posted` | GL linkage |

```sql
UNIQUE INDEX ux_txn_no      ON txn(tenant_id, type, txn_no);
INDEX ix_txn_type_date      ON txn(tenant_id, type, txn_date DESC);
INDEX ix_txn_entity         ON txn(tenant_id, entity_type, entity_id, txn_date DESC);
INDEX ix_txn_due            ON txn(tenant_id, type, due_date) WHERE amount_remaining > 0;
```

The partial index on `due_date` is what makes aging reports fast: they only
ever look at documents with an outstanding balance.

## `txn_line`

Carries `item_id` **or** `account_id` (for non-item expense lines), quantity,
unit price, unit cost, discount, tax, segments, and the progress counters
`qty_committed`, `qty_fulfilled`, `qty_billed`, `qty_received`. `source_line_id`
links back to the line this was pulled from.

## `txn_link`

Applications and derivations: `applied` (payment → invoice), `fulfils`,
`bills`, `receives`, `derives`. Payment application lives here rather than as
a column, so one payment can settle many invoices and be unapplied cleanly.

---

## Posting rules

Every rule in the system, in one place (`txn.postingPlan`):

| Document | Debit | Credit |
|---|---|---|
| **Invoice** | Accounts Receivable (total) · Sales Discounts | Revenue (per line, per item mapping) · Sales Tax Payable · Shipping Income |
| **Credit memo** | mirror of the invoice | |
| **Customer payment** | Bank or Undeposited Funds | Accounts Receivable |
| **Item receipt** | Inventory Asset (at PO cost) | Accrued Inventory Receipts |
| **Vendor bill** | Accrued Inventory Receipts *(when billing a receipt)* or Inventory/Expense · recoverable tax | Accounts Payable |
| **Vendor payment** | Accounts Payable | Bank |
| **Fulfilment** | COGS (at moving-average cost) | Inventory Asset |
| **Inventory adjustment** | Inventory Asset ↕ | Shrinkage ↕ |
| **Payroll run** | Salaries & Wages (gross) · Employer Payroll Tax | Employee Tax Withheld · Employer Tax Payable · Payroll Liabilities (net) |

The three-way match falls out of this: the receipt accrues, the bill clears
the accrual, and any difference between PO price and bill price lands in the
variance rather than silently restating inventory.

---

# Part 4 — Platform tables

| Table | Purpose |
|---|---|
| `app_user`, `role`, `permission`, `role_restriction`, `user_role` | RBAC. `permission.level` 0–4 (none/view/create/edit/full); `role_restriction` holds row-level scoping per dimension. |
| `session`, `api_token` | Only digests stored. Sessions expire; tokens can be revoked. |
| `audit_event` | Append-only. `financial` flags entries subject to the longer retention policy. |
| `custom_field` | Per-tenant field definitions, including read-time formulas. |
| `saved_search` | Column, filter and sort definitions for the query engine. |
| `workflow`, `workflow_log` | Declarative automation and its execution history. |
| `server_script` | SuiteScript-style scripts. Disabled by default. |
| `pricing_rule`, `approval_rule` | Expression-driven pricing and approval routing. |
| `integration_event` | Outbound delivery queue for payroll and webhooks. |
| `search_doc` + `search_fts` | FTS5 index kept in step by triggers. |
| `sequence` | Document numbering, allocated inside the writing transaction. |

---

# Part 5 — CRM and HR

**CRM** — `customer`, `vendor`, `contact`, `lead`, `opportunity`, `activity`,
`support_case`, `case_message`. Leads convert to a customer, contact and
opportunity in one transaction and are retained, never deleted, so campaign
attribution survives.

**HR** — `employee` (with a validated, cycle-free `manager_id` chain),
`time_entry`, `time_off`, `payroll_run`, `payroll_line`.

Sensitive identifiers are **never stored in clear text**. `employee` keeps
`national_id_last4` and `bank_last4` for display only; full identifiers live
with the payroll provider and are referenced by `provider_ref`.
