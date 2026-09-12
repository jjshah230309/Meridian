# Meridian ERP — API Reference

Base URL `/api/v1`. JSON in, JSON out.

## Authentication

Two mechanisms:

**Session cookie** — for the web client. `POST /api/v1/auth/login` sets an
`HttpOnly; SameSite=Strict` cookie and returns a CSRF token that every
subsequent write must present in `X-CSRF-Token`.

**Bearer token** — for integrations. Send `Authorization: Bearer mrd_…`.
Token clients are exempt from CSRF: a browser cannot be tricked into attaching
a header it must set explicitly.

```bash
curl -c jar -X POST localhost:8422/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@northwind.test","password":"Northwind-Demo-2026"}'
```

## Error shape

Every error is the same shape, with a stable `code` and a message written for
a person:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Enter a valid email address",
    "fields": { "email": "Enter a valid email address" },
    "requestId": "DXMJA9S7AV3N"
  }
}
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `BAD_REQUEST` | Malformed request |
| 401 | `UNAUTHORIZED` | No or expired credential |
| 403 | `FORBIDDEN` · `CSRF_FAILED` · `BAD_ORIGIN` | Permission or CSRF failure |
| 404 | `NOT_FOUND` | No such route or record |
| 409 | `CONFLICT` | Duplicate number, already posted, already reversed |
| 422 | `VALIDATION_FAILED` · `UNPROCESSABLE` | Field errors, or a business rule refused |
| 429 | `RATE_LIMITED` | Slow down; `Retry-After` is set |

When exactly one field fails, its own message becomes the headline, so a
client that only shows `error.message` still tells the user what is wrong.

---

## Authentication

| Method | Path | Notes |
|---|---|---|
| `POST` | `/auth/login` | `{email, password, tenant?}` → user, tenant, csrf, permissions |
| `POST` | `/auth/logout` | Destroys the session |
| `GET` | `/auth/session` | Current identity, permissions and restrictions |
| `POST` | `/auth/password` | `{current_password, new_password}`; signs out every session |
| `GET` | `/auth/tenants` | Companies available at this installation |

## Metadata

| Method | Path | Notes |
|---|---|---|
| `GET` | `/meta` | **The discovery endpoint.** Every record type the caller may see, with its fields, list columns, custom fields and permission level, plus currencies, subsidiaries, locations, departments, tax codes, periods, transaction types, operators and workflow actions. |

The web client is driven entirely by this response — which is also why a
restricted role receives a smaller one.

---

## Records — generic CRUD

Works for all 39 record types: `customer`, `vendor`, `contact`, `lead`,
`opportunity`, `activity`, `support_case`, `item`, `location`, `employee`,
`department`, `account`, `journal_entry`, `subsidiary`, `bank_account`,
`time_entry`, `time_off`, `payroll_run`, `app_user`, `role`, `custom_field`,
`workflow`, `saved_search`, `price_level`, `pricing_rule`, `approval_rule`,
and the transaction types (`quote`, `sales_order`, `invoice`, `credit_memo`,
`customer_payment`, `purchase_order`, `item_receipt`, `vendor_bill`,
`vendor_payment`, `fulfillment`, `inventory_adjustment`,
`inventory_transfer`).

| Method | Path | Notes |
|---|---|---|
| `GET` | `/records/:type` | List. `?q=` free text, `?filters=` JSON, `?columns=`, `?sort=`, `?limit=`, `?offset=` |
| `GET` | `/records/:type/:id` | One record plus related lists, activity timeline and audit history |
| `POST` | `/records/:type` | Create |
| `PATCH` | `/records/:type/:id` | Update |
| `DELETE` | `/records/:type/:id` | **Deactivates** anything a transaction can reference; hard-deletes only when nothing points at the row |

Reference columns come back with a resolved `<column>_label` alongside the id,
so a list does not need a second round trip to render names:

```json
{ "txn_no": "INV-00100", "entity_id": "01J…", "entity_id_label": "Thornton Aerospace",
  "total": 11091800, "status": "open" }
```

**Money is always minor units.** `11091800` is $110,918.00.

### Query endpoint

```http
POST /api/v1/search
{
  "record_type": "invoice",
  "definition": {
    "columns": ["txn_no", "entity_id", "due_date", "amount_remaining"],
    "filters": [
      { "field": "amount_remaining", "op": "gt",  "value": 0 },
      { "field": "due_date",         "op": "lt",  "value": "2026-09-04" }
    ],
    "sort": "due_date ASC",
    "group": "status",
    "aggregate": [{ "fn": "sum", "field": "total" }]
  },
  "limit": 100
}
```

Operators: `eq` `ne` `gt` `gte` `lt` `lte` `contains` `starts` `empty`
`notempty` `in` `between`. Custom fields are addressed as `custom.<name>`.
Every column and operator is validated against the metadata registry, so the
builder cannot be turned into SQL injection.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/search/global` | `?q=` full-text across every indexed record, permission-filtered |
| `GET` | `/saved-searches` | Saved searches visible to the caller |
| `GET` | `/export/:type` | CSV download; accepts the same `definition` |

---

## General ledger

| Method | Path | Notes |
|---|---|---|
| `GET` | `/gl/accounts` | Chart of accounts as a tree with balances |
| `POST` | `/gl/journal` | Post a manual entry |
| `GET` | `/gl/journal/:id` | Entry with lines, period and subsidiary |
| `POST` | `/gl/journal/:id/reverse` | The only way to undo a posted entry |
| `GET` | `/gl/ledger/:accountId` | Account ledger with a running balance |
| `GET` | `/gl/periods` | |
| `POST` | `/gl/periods/generate` | `{fiscal_year}` → twelve monthly periods |
| `POST` | `/gl/periods/:id/close` | `{force?}`; refuses over drafts or an imbalance |
| `POST` | `/gl/periods/:id/reopen` | |
| `POST` | `/gl/rebuild-balances` | Owner only; rebuilds the rollup from detail |
| `GET`/`POST` | `/gl/rates` | Exchange rates |

```http
POST /api/v1/gl/journal
{
  "subsidiary_id": "01J…",
  "txn_date": "2026-06-15",
  "currency": "USD",
  "memo": "Monthly depreciation",
  "lines": [
    { "account_id": "…6800", "debit":  4200.00, "memo": "Depreciation" },
    { "account_id": "…1590", "credit": 4200.00, "memo": "Accumulated" }
  ]
}
```

Amounts here accept decimals and are parsed to minor units. The entry must
balance, the period must be open, and no line may hit a summary account.

---

## Transactions

| Method | Path | Notes |
|---|---|---|
| `GET` | `/txn` | `?type=`, `?status=`, `?entity_id=`, `?from=`, `?to=`, `?overdue=`, `?open=`, `?q=` |
| `GET` | `/txn/:id` | Document, lines, links, journal and available transforms |
| `POST` | `/txn/:id/approve` | Approves, then posts if the type posts |
| `POST` | `/txn/:id/reject` | `{reason}` |
| `POST` | `/txn/:id/void` | `{reason}`; reverses the journal and undoes stock |
| `POST` | `/txn/:id/post` | Post a document held back from posting |
| `GET` | `/txn/:id/transform/:target` | **Preview**: what quantities remain |
| `POST` | `/txn/:id/transform/:target` | Execute, optionally with partial quantities |

Valid transformations:

```
QUOTE          → SALES_ORDER
SALES_ORDER    → FULFILLMENT, INVOICE
PURCHASE_ORDER → ITEM_RECEIPT, VENDOR_BILL
ITEM_RECEIPT   → VENDOR_BILL
INVOICE        → CREDIT_MEMO
```

```http
POST /api/v1/txn/01J…/transform/FULFILLMENT
{ "txn_date": "2026-06-11", "tracking_no": "1Z9999",
  "lines": [{ "source_line_id": "01J…", "quantity": 4 }] }
```

Omit `lines` to take everything remaining. Asking for more than remains is
refused, naming the line and the amount available.

### Settlement

| Method | Path | Notes |
|---|---|---|
| `POST` | `/payments` | Record and apply a customer or vendor payment |
| `POST` | `/payments/:id/unapply` | `{txn_id}`; restores the target's balance |
| `GET` | `/entities/:entityType/:id/open-documents` | What a payment could settle |
| `GET` | `/entities/customer/:id/credit` | Exposure, limit and headroom |
| `POST` | `/pricing/quote` | What would this line be priced at, and why |

```http
POST /api/v1/payments
{ "type": "CUSTOMER_PAYMENT", "entity_id": "01J…", "txn_date": "2026-06-20",
  "amount": 4820.00,
  "applications": [{ "txn_id": "01J…", "amount": 4820.00 }] }
```

Omit `applications` to auto-apply oldest first. A document can never be
over-applied.

---

## Inventory

| Method | Path | Notes |
|---|---|---|
| `GET` | `/inventory/availability/:itemId` | On hand, committed, available, on order, value, by location |
| `GET` | `/inventory/reorder` | `?location_id=`, `?lookback=` — demand-based reorder analysis |
| `GET` | `/inventory/valuation` | `?as_of=` rebuilds the valuation from the stock ledger |
| `POST` | `/inventory/levels` | Reorder point, target level, safety stock, lead time |
| `POST` | `/inventory/reorder/create-pos` | Turn suggestions into purchase orders, grouped by vendor and location |

## CRM

| Method | Path | Notes |
|---|---|---|
| `GET` | `/crm/pipeline` | Opportunities grouped by stage with values |
| `GET` | `/crm/forecast` | `?from=&to=` — categories, by owner, win rate, cycle length |
| `POST` | `/crm/leads/:id/convert` | Lead → customer + contact + opportunity, atomically |
| `GET` | `/crm/support/metrics` | Open cases, SLA breaches, resolution times |
| `POST` | `/crm/cases/:id/messages` | Add a reply or internal note |

## People

| Method | Path | Notes |
|---|---|---|
| `GET` | `/hr/directory` | `?q=&department_id=&status=` plus headcount metrics |
| `GET` | `/hr/orgchart` | Reporting tree with recursive report counts |
| `GET` | `/hr/timesheet/:employeeId` | `?week_start=` weekly grid |
| `POST` | `/hr/time/approve` | `{ids, approve}` bulk approval |
| `POST` | `/hr/timeoff/:id/decide` | `{approve}` |
| `POST` | `/hr/payroll/calculate` | Gross-to-net for a period |
| `GET` | `/hr/payroll/:id` | Run with per-employee lines |
| `POST` | `/hr/payroll/:id/approve` | Posts the payroll journal |
| `POST` | `/hr/payroll/:id/export` | Queues the run for a payroll provider |

## Reports

| Method | Path |
|---|---|
| `GET` | `/reports/dashboard` |
| `GET` | `/reports/income-statement` `?from=&to=&compare_from=&compare_to=` |
| `GET` | `/reports/balance-sheet` `?as_of=` |
| `GET` | `/reports/cash-flow` `?from=&to=` |
| `GET` | `/reports/trial-balance` `?to=` |
| `GET` | `/reports/ar-aging`, `/reports/ap-aging` `?as_of=` |
| `GET` | `/reports/revenue-trend`, `/reports/top-customers`, `/reports/top-items` |
| `GET` | `/reports/integrity` |
| `GET` | `/reports/drilldown/:metric` |

All accept `?subsidiary_id=` to scope to one legal entity.

## Banking

| Method | Path | Notes |
|---|---|---|
| `GET` | `/bank/accounts` | Balances plus a rolling cash position |
| `GET` | `/bank/:id/transactions` | |
| `POST` | `/bank/:id/import` | `{csv}` or `{lines}`; idempotent by `external_id` |
| `GET` | `/bank/:id/suggest` | Match candidates with a confidence rating |
| `POST` | `/bank/:id/auto-match` | Applies only unambiguous, confident matches |
| `POST` | `/bank/match`, `/bank/unmatch` | Manual matching |
| `POST` | `/bank/reconciliations` | Start against a statement balance |
| `GET` | `/bank/reconciliations/:id` | Cleared total and remaining difference |
| `POST` | `/bank/reconciliations/:id/select` | Tick the cleared lines |
| `POST` | `/bank/reconciliations/:id/complete` | `{force?}` |

## Platform & setup

| Method | Path | Notes |
|---|---|---|
| `POST` | `/workflows/:id/test` | Dry-run a condition against a real record |
| `POST` | `/expressions/validate` | Validate, and optionally evaluate against a sample scope |
| `GET` | `/audit` | `?record_type=&record_id=&user_id=&action=&financial=&from=&to=` |
| `GET`/`POST` | `/notifications`, `/notifications/read` | |
| `GET`/`PUT` | `/dashboards` | Per-user widget layout |
| `GET` | `/setup/roles` | Roles with permissions, restrictions and user counts |
| `PUT` | `/setup/roles/:id/permissions` | |
| `GET`/`POST` | `/setup/users` | |
| `PUT` | `/setup/users/:id/roles` | |
| `GET` | `/setup/company` | Tenant, subsidiaries, currencies, periods, record counts |
| `GET` | `/setup/integration-events` | Outbound delivery log |

---

## Rate limits

| Scope | Window | Limit |
|---|---|---|
| `/auth/login` | 5 minutes | 30 |
| Everything else | 1 minute | 1200 |

Exceeding either returns 429 with `Retry-After`.
