# Meridian ERP — Security & Compliance

## Threat model

Meridian holds a company's ledger, its customer list and its payroll. The
threats worth designing against, in order:

1. **Cross-tenant leakage** — the worst outcome, and the easiest to cause by
   accident.
2. **Privilege escalation** — a warehouse user reading payroll, a sales rep
   editing the ledger.
3. **Tenant-authored logic escaping its sandbox** — the customisation engine
   runs code paths that tenants control.
4. **Injection** — through the query builder, the filter API, custom field
   names.
5. **Session theft and CSRF** — a browser-based app with cookie sessions.
6. **Ledger tampering** — silent modification of posted financial records.

---

## Cross-tenant isolation

Structural, not conventional. Three layers:

**1. Schema.** Every business table carries `tenant_id` as the leading column
of its primary key.

**2. The repository.** All access goes through `Repo`, constructed with the
tenant from the authenticated credential — never from a request parameter.
Raw SQL must carry a `:t` marker, and a query touching a tenant-scoped table
without one throws at prepare time rather than returning another tenant's
rows.

**3. A test that fails the build.** `test/tenancy.test.mjs` enumerates every
table in the live schema, finds those with a `tenant_id` column, and asserts
each is declared in `TENANT_TABLES`. Adding a table without wiring it up is a
test failure, not a production incident.

The only pre-tenant lookups are `session` and `api_token`, keyed by an
unguessable credential digest — that lookup is what *establishes* the tenant.

---

## Authentication

| | |
|---|---|
| Password hashing | scrypt, N=16384 r=8 p=1, 64-byte key, per-user random salt |
| Password policy | ≥10 characters, mixed case, a digit, common prefixes rejected |
| Failed attempts | Lockout after 8 failures for 15 minutes |
| Account enumeration | A missing account performs a decoy scrypt so timing and message are identical to a wrong password |
| Sessions | 12-hour expiry; **only the SHA-256 digest of the token is stored** |
| Cookies | `HttpOnly`, `SameSite=Strict`, `Secure` behind TLS |
| API tokens | Prefixed `mrd_`, shown once, stored as a digest, revocable, optionally expiring |
| Password change | Invalidates every session for that user |

## CSRF

Stateless double-submit: the token is `HMAC(serverSecret, "csrf:" + sessionId)`,
unforgeable without the server secret and requiring no extra storage. Every
cookie-authenticated write must present it in `X-CSRF-Token`, and cross-origin
writes are rejected outright. Bearer-token clients are exempt — a browser
cannot be induced to attach a header it must set explicitly.

The server secret lives in `data/secret.key`, mode `0600`, generated on first
run.

## Authorisation

**Record-type permissions** — five levels (none, view, create, edit, full) per
record type per role. A user's effective permission is the union of their
roles: the widest wins.

**Row-level security** — per-dimension restrictions (subsidiary, department,
location, class) and "own records only", compiled into a SQL predicate that
the repository appends. Enforcement is in the data layer, so a module that
forgets to filter still cannot leak. `canSeeRow` re-checks single-record reads
as defence in depth.

Nine role templates ship pre-configured — Administrator, Controller, AP Clerk,
AR Clerk, Sales Rep (own records only), Sales Manager, Warehouse (no financial
visibility), HR Manager, Employee (self-service).

Metadata is permission-filtered: a restricted user's `/meta` response omits the
record types they cannot see, so the UI cannot offer what the API would refuse.

---

## Tenant-authored logic

This is the sharpest edge in the system, and it is handled by **not running
tenant code**.

`core/expr.mjs` is a purpose-built interpreter. It has:

* no access to host objects, globals or `require`
* own-property lookups only; `__proto__`, `constructor` and `prototype` throw
* no callables returned from scope — a function value resolves to `null`
* a fixed allowlist of ~40 functions
* no loops, no recursion, no I/O
* a hard step budget and an expression length cap

A workflow whose condition throws is logged and skipped. Tenant automation
cannot take down a posting run.

### Server scripts

A `node:vm` runner exists for SuiteScript-style scripts. It is **disabled
unless `MERIDIAN_ENABLE_SCRIPTS=1`**, and this is deliberate:

> `node:vm` is an isolation mechanism, not a security boundary. A determined
> script can escape it. It is therefore appropriate only for single-tenant
> deployments where the script author already has server access.

Multi-tenant deployments should use workflows, which are safe by construction.

## Injection

Column names, sort fields, filter fields and operators are validated against
the metadata registry — never interpolated from input. Illegal identifiers
throw. Table names are checked against an allowlist. All values are bound
parameters. `test/tenancy.test.mjs` attempts injection through filters, sorts
and column selection and asserts each is refused.

## Ledger integrity

* Posted entries are **immutable**. Corrections are reversals, so the trail
  shows what was believed and when it was corrected.
* Every mutation writes an `audit_event` **inside the same transaction**, so a
  rolled-back change leaves no ghost and a committed one can never lack its
  trail. Financial record types are flagged for longer retention.
* `synchronous=FULL` means a committed entry has reached the disk before the
  request is acknowledged.
* `/api/v1/reports/integrity` re-derives the balance rollup from journal
  detail, confirms every posted entry balances, and reports orphaned lines.

## Browser-side

Strict CSP with no exceptions needed, because the client has no inline
handlers and no CDN dependencies:

```
default-src 'self'; script-src 'self'; style-src 'self';
connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'
```

Plus `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: same-origin`,
`Cross-Origin-Opener-Policy: same-origin` and a restrictive
`Permissions-Policy`. All DOM construction goes through a helper that sets
text nodes, never `innerHTML`, except for one server-generated search snippet
that is escaped and re-allows only `<mark>`.

Static file serving resolves paths and rejects anything escaping the web root.

## Sensitive data handling

Employee national identifiers and bank details are **never stored in full**.
The schema keeps only a last-four fragment for display; full identifiers live
with the payroll provider and are referenced by `provider_ref`. Bank account
numbers are stored masked. Password hashes and token digests are stripped from
API responses and excluded from audit diffs.

---

## GDPR readiness

| Requirement | Status |
|---|---|
| Lawful basis, purpose limitation | Data model is business-necessary; no behavioural tracking, no third-party analytics |
| Right of access | `/api/v1/export/:type` per record type; a per-subject bundle is Phase 9 |
| Right to erasure | Deactivation preserves financial records under the legal-obligation exemption; hard erasure of non-financial personal data is Phase 9 |
| Right to rectification | Full edit history in the audit trail |
| Data minimisation | Sensitive identifiers deliberately not stored |
| Security of processing | Above |
| Breach notification | Audit trail supports scope determination |
| Data residency | `tenant.data_region`; the whole dataset is one file per deployment |

## SOC 2 readiness

| Criterion | What exists |
|---|---|
| **Security** | Authentication, RBAC, row-level security, rate limiting, CSP, injection defences |
| **Availability** | WAL, atomic transactions, clean shutdown with checkpoint. *Backup automation is Phase 6.* |
| **Processing integrity** | Double-entry enforcement, immutable postings, the integrity endpoint, 75 automated tests |
| **Confidentiality** | Tenant isolation with a build-failing test; sensitive fields not stored |
| **Privacy** | Minimisation, audit trail, export |

The technical controls are in place. Certification additionally requires
formal policies, a 6–12 month observation window and an independent auditor —
that is process, not code.

## Reporting a vulnerability

Open a private security advisory rather than a public issue.
