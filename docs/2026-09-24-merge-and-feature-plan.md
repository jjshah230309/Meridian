# 2026-09-24: merge, bug hunt, and 4-feature build — plan and outcome

## Outcome
Everything below was carried out. In order:
1. `~/Meridian Hybrid` and `~/Meridian-Overhaul` merged into `~/Meridian` (Phases A–D below), pushed to GitHub (`jjshah230309/Meridian`, `main`), and installed to `/Applications/Meridian ERP.app`.
2. A competitor feature-gap analysis (against NetSuite, Odoo, QuickBooks, Xero, SAP Business One, Zoho) identified 17 real gaps, tiered by size.
3. Four "small" gaps were built in full: the outbox delivery worker, file attachments, email (a hand-written SMTP client), and enforced API token scopes. Each is one commit:
   - `823ad32` — outbox draining (`src/core/outbox.mjs`)
   - `09e5661` — file attachments (`src/modules/attachments.mjs`, migration `035`)
   - `bbb0e6f` — SMTP client (`src/core/smtp.mjs`)
   - `3667cca` — wiring email into statements/dunning notices/remittance advice
   - `eaaa106` — API token scope enforcement

Final state: **577/577 tests passing** (up from 470 at the last recorded baseline), `./scripts/check.sh` clean. The 5 feature commits are local only — not yet pushed to GitHub as of this file being written.

The rest of this document is the plan as written and executed, kept as the detailed record of *why* each decision was made, not just what changed (the commit messages carry the "what" in full).

---

# Status: merge + bug hunt complete, pushed to GitHub, installed to /Applications.
# Below the original merge plan is a new section: a competitor feature-gap
# analysis, started at the user's request ("continue to check for features
# that are missing as compared to other competitors"). It is findings, not
# yet an approved implementation plan — see the end of this file.

# Plan: merge Meridian Hybrid + Meridian-Overhaul into ~/Meridian, then do a thorough bug hunt

## Context
Both folders are on the same git commit (`62b9e9a`) and differ only in uncommitted work.
- **Overhaul** is a copy of Hybrid taken on 18 Sep at 23:57. The copy of Hybrid's `dist/` inside it gives a close fork base. After the copy, Overhaul changed only 5 source files plus `sprint_report.html`:
  - `books.mjs`: `postAdjustment` now runs in its own `repo.tx()`
  - `charts.js`, `ui.js`, `setup-wizard.js`: hardcoded pixel and hex values replaced with tokens
  - `app.css`: a "glass" restyle
  - It also left behind junk: `app/` (a clone of the old baseline) and `.claude/worktrees/`
  - **Tests: 485/487 pass.** Both failures come from real CSS bugs:
    - font-weight 700, which isn't bundled
    - escaped-quote selectors like `[type=\"number\"]`
    - a garbled `\nolL.steps` rule
    - `--chrome-rgb` and `--chart-*` missing from the other palettes
- **Hybrid** kept going after the copy:
  - about 2,300 lines of backend fixes across 25 modules, core and API files
  - migration `033_pick_task_serial.sql`, plus 10 new test files
  - keyboard-shortcut fixes
  - a later CoolDock-style redesign (dark KPI widgets, `.icon-chip`, pills, a dark version of every palette)
  - **Tests: 524/524 pass.** None of this work is committed.

**Your decisions:**
- Keep both looks and add a switch for them in Settings. **Glass** (Overhaul) is the default; **Dock** is Hybrid's CoolDock look.
- Afterwards, rebuild the apps and replace `/Applications/Meridian ERP.app`.
- Leave the two original folders untouched.

## Phase A: create ~/Meridian
1. `rsync -a` from `~/Meridian Hybrid` to `~/Meridian`.
   - Copy `.git`, `data/` (the dev DB, which git ignores) and `.claude/launch.json`.
   - Leave out `dist/` (it gets rebuilt) and `.DS_Store`.
2. Commit Hybrid's uncommitted tree in `~/Meridian` as a local checkpoint: "Hybrid working tree, 2026-09-19". This gives the later diffs a clean base. Nothing gets pushed.

## Phase B: bring in the good parts of Overhaul
1. **`src/modules/books.mjs`**: take Overhaul's `postAdjustment` body, which is atomic for every caller, including the API.
   - Nested `tx()` uses SAVEPOINTs (`src/core/db.mjs:177`), so one asset failing still can't undo another asset's work.
   - Drop Hybrid's now-redundant caller-side wrap in `runBookDepreciation`, along with its comment that says "postAdjustment does not manage its own transaction".
2. **Tokenisation** (applies to both looks):
   - Take Overhaul's edits to `charts.js`, `ui.js` and `setup-wizard.js`.
   - Keep Hybrid's `empty()` `tone` and `.icon-chip` change in `ui.js`. It's the only ui.js hunk Hybrid changed after the copy, so the 3-way merge is clean.
   - Add these to `app.css`: `.address-grid`, `.address-span`, `.row-tight`, `.toast.info`.
   - Add `--chrome-rgb` and `--chart-brown`, `--chart-purple` and `--chart-blue` to **all 12 palette blocks** (light and dark). The dark versions need lighter chart colours so they stay readable. The existing test "every palette defines every colour token" enforces this.
3. **Look switch.** Copy the existing palette/typeface pattern:
   - `src/web/js/store.js`:
     - `LOOKS = [{id:'glass',…},{id:'dock',…}]`
     - `setLook()` falls back to `'glass'` for an unknown value
     - `initAppearance()` reads `getPref('ui.look','glass')`
     - `state.look`
   - `src/web/index.html`: `data-look="glass"` on `<html>`, so there's no flash of the wrong look on first paint.
   - `src/web/js/views/settings.js`: a "Look" picker with two preview cards (reuse the `.swatch` styles), shown above Colour scheme.
   - `src/web/js/commands.js`: a `view.look` command, "Switch look".
   - `src/web/js/app.js`: add the look to the user menu's appearance label (`paletteLabel()`).
4. **CSS for the looks.**
   - Hybrid's stylesheet stays the unscoped base, and that base is **Dock**.
   - A new section at the end of `app.css`, `:root[data-look="glass"] …`, holds Overhaul's differences, rewritten for Hybrid's current markup:
     - Tokens: radii 6/10/16/24. Set `--radius-pill` to 10px, which turns the pill shapes back into Overhaul's rounded rectangles in one place.
     - Obsidian colour tweaks (deeper chrome, `--bg`, and the dark background).
     - A see-through glass topbar using `rgba(var(--chrome-rgb),.85)` with blur and saturate.
     - The sidebar's inset shadow, and the 4px accent bar on the active nav item.
     - A page-enter animation, plus hover lifts on primary buttons and cards.
     - Springy modals, a stronger overlay blur, and the 4px accent-soft focus ring.
     - A 2px table header border and zebra rows. **Hover and selected rows must be restated under the glass selector**, or the higher-specificity zebra rule hides them.
     - Surface-coloured KPI tiles instead of dark chrome ones. Restyle the markup that only Hybrid has: `.k-icon` / `.icon-chip.on-dark`, `.login-head`, `.welcome-hero`, `.track-icon`, `.page-head.hero`.
     - A 64px round empty-state icon.
   - Fixes to Overhaul's bugs as they're ported:
     - Weight 700 becomes 600.
     - Don't carry over the broken selectors.
   - **Keep the dark versions of every palette in both looks.** Overhaul only lacked them because they didn't exist when it was copied.
   - Add a global `@media (prefers-reduced-motion: reduce)` rule. Neither version has one, and Glass adds more motion.
5. **Tests** in `test/webui.test.mjs`:
   - Every `LOOKS` id has a stylesheet block, or is the base look.
   - `index.html` default attributes match the `store.js` defaults for look, palette and typeface.
   - The existing weight and token tests will also cover the new section.
6. **Not carried over:**
   - `sprint_report.html` (marketing copy with inaccurate claims)
   - `app/`
   - `.claude/worktrees/`
   - Overhaul's deletion of the dark palette versions

## Phase C: bug hunt
1. **Baseline:** run `./scripts/check.sh` and `node --test test/`. Everything must be green before hunting.
2. **Pattern sweep.** Search for the bug classes found before (listed in memory):
   - `find(t, {id:{in:…}})` without `where:`
   - spreading a `Map` into an object literal
   - bad regex character classes
   - async callbacks passed to `tx`
   - SQL without the `:t` tenant marker
   - `JSON_COLUMNS`-style dead refactors
   - Also: `gl_balance` write paths, and inline font weights.
3. **Review the uncommitted Hybrid diff** (checkpoint vs `62b9e9a`) plus the Phase B changes, using 4 parallel review agents:
   - (a) core and API: `auth`, `rbac`, `util`, `xlsx`, `expr`, `logger`, `api*.mjs`
   - (b) financial modules: `allocations`, `assets`, `bank`, `books`, `collections`, `consolidation`, `recurring`, `schedules`, `subscriptions`, `txn`
   - (c) ops and platform modules: `customrecords`, `dataio`, `entities`, `hr`, `meta`, `odata`, `planning`, `platform`, `records`, `service`, `warehouse`, and migration 033
   - (d) web JS and CSS
   - Before fixing any finding, reproduce it with a failing test or script. Every fix gets a regression test.
4. **Runtime.**
   - Start `MERIDIAN_DATA=<scratch> node src/server.mjs --no-open --reset --seed`.
   - Drive every route with the browser (Playwright or Chrome) across Glass/Dock × light/dark × all 6 palettes, plus compact density.
   - Collect console errors, failed requests and screenshots, then review the screenshots for visual breakage, especially in Glass.
   - Smoke-test the main flows through the API: sign in, create and post an invoice, record and reverse a payment, run a CSV import, run book depreciation.
5. Re-run the full suite after every group of fixes.

## Phase D: build, install, record
1. `node scripts/package.mjs --target darwin-arm64 --target win-x64`.
2. Launch the built `.app` and check that it opens, signs in and shows the Glass look.
3. Replace `/Applications/Meridian ERP.app`. Packaged data lives in Application Support, so your company data is untouched.
4. Commit locally in logical chunks: Overhaul port, look switch, bug fixes. Nothing gets pushed.
5. Update the `meridian-erp` memory: the project is now `~/Meridian`, what the look switch does, and the new test count.

## Verification
- `./scripts/check.sh` is clean, and `node --test test/` passes fully (524 tests plus the new ones).
- Browser check: zero console errors on every route in every look/theme/palette combination. The look switch persists across reloads, and Glass is the default on a fresh profile.
- The installed app launches from /Applications and signs in with the demo login.

---

# Findings: competitive feature-gap analysis (2026-09-24)

## Method
Two Explore agents inventoried `~/Meridian` exhaustively: one read every backend
module (39 files), every migration, and `docs/`; the other read every frontend
view, the full 19-chapter user manual, `commands.js` and `tour.js`. Both were
told to report only what exists — comprehensively — not to speculate about
gaps. That comparison (below) is mine, done from general knowledge of NetSuite,
Odoo, QuickBooks (Online/Enterprise), Xero, SAP Business One and Zoho
(Books/Inventory/One), cross-checked against the two inventories.

Meridian's actual scope is large and mostly on par with mid-market ERPs already:
full O2C/P2P cycles, multi-book accounting, intercompany + consolidation, fixed
assets, subscriptions/MRR, revenue recognition, warehouse/pick-pack-ship, basic
manufacturing (BOM/routing/work orders), field service, a SOAP API in the style
of NetSuite SuiteTalk, and OData for Power BI. The gaps below are relative to
that mid-market bar, not relative to a toy app.

## Deliberate, already-documented non-goals (not gaps to "fix")
The codebase is unusually disciplined about writing these down — worth
respecting rather than second-guessing:
- **No statutory tax/payroll engine.** Payroll and sales-tax rates are
  configuration; the README calls getting real tax logic wrong "a legal
  problem rather than a bug" and expects a payroll provider via the
  integration outbox instead.
- **No arbitrary server-side code as a real feature.** The `node:vm` script
  runner exists but is off by default and documented as single-tenant-only,
  not a security boundary.
- **No GraphQL** — stated as deliberate; REST + saved-search query covers the
  same ground.
- **Single-writer SQLite**, with a documented (not hidden) Postgres migration
  path for later.

## Real gaps, grouped by how big a lift each is

**Small — days, clearly worth doing on their own merits:**
1. **No email sent, anywhere.** Statements, dunning letters, remittance
   advice and 1099s are all generated as PDFs "for you to send" — there is no
   SMTP integration in the codebase at all. Every competitor (NetSuite,
   QuickBooks, Xero, Zoho, Odoo) emails invoices/statements directly.
2. **No file attachments on any record.** Not a receipt, not a signed PO, not
   a contract — nothing can be attached anywhere in the UI. Every competitor
   listed has this as a basic feature.
3. **Outbox is write-only.** `integration_event` rows are inserted (payroll
   export, webhook actions) but nothing drains the queue — `hr.mjs` even has
   a comment claiming "a worker drains the outbox" that doesn't exist. This
   makes the payroll/webhook integration feature non-functional as shipped.
4. **API token scopes are stored but never enforced** — a token narrower than
   full access can't actually be issued in practice, which undercuts the
   "revocable, scoped tokens" story in the manual.

**Medium — a real feature, but scoped and self-contained:**
5. **No customer/vendor self-service portal.** No way for a customer to view
   or pay an invoice online, or a vendor to see PO/payment status — NetSuite
   (Customer Center), QuickBooks, Xero and Zoho all have this.
6. **No online payment collection.** No Stripe/card/ACH integration for
   customers to actually pay from an emailed invoice.
7. **No live bank feeds.** Bank import is file-based only (OFX/QFX/BAI2/
   CAMT.053/CSV) — no Plaid/Yodlee/Open Banking live connection, which is
   now the default expectation in QuickBooks/Xero/NetSuite.
8. **Lots/serials are modelled but not wired up.** `inventory_lot` (with an
   expiry date) exists only as a bare CRUD record type; receipts and
   fulfilment never create or consume a lot, and warehouse code writes
   `lot_number: ''` outright. Any regulated-goods use case (food, pharma,
   electronics with warranty tracking) needs this working, not just modelled.
9. **No custom/drag-and-drop report builder.** Reporting is a fixed catalogue
   plus saved searches plus OData-for-Power-BI — there's no in-app pivot
   builder (NetSuite SuiteAnalytics Workbook, Zoho Analytics, QuickBooks
   Advanced Reporting all have one).
10. **No visual workflow/approval designer.** Workflows and approval rules
    are expression-based, not a flow builder (NetSuite SuiteFlow, Odoo
    Studio).
11. **No multi-language UI.** Currency/number formatting is `Intl`-based and
    country-aware for setup, but there is no UI translation system at all —
    relevant for any team that isn't English-first.

**Large — multi-week, genuinely different tier of investment:**
12. **No mobile app.** The web UI is responsive down to phone width but there
    is no native/PWA mobile app; every competitor listed has one, at minimum
    for expense capture and approvals on the go.
13. **No SSO / 2FA.** No SAML, OAuth/OIDC or TOTP — already on the project's
    own roadmap (Phase 6/10) but not built. Blocks any enterprise buyer with
    an SSO requirement.
14. **No e-commerce/POS connector.** Sales Channels/Listings/Carts are
    internal-only record types — nothing actually syncs with Shopify,
    WooCommerce, Amazon, or a physical POS terminal (Odoo ships a full POS
    module natively; NetSuite has SuiteCommerce).
15. **No e-invoicing / tax-authority submission.** No Peppol, UK Making Tax
    Digital, or e-invoice mandates (India/LatAm/EU) — the sales-tax-return
    feature stops at a printable PDF, by design, but this is where that
    design choice costs the most in markets that now require e-filing.
16. **A payroll tax engine, if ever wanted, is a from-scratch build** — the
    current flat 22%/7.65% is explicitly a labelled placeholder, not a
    partial implementation to extend incrementally.
17. **No AI/ML anywhere** — no anomaly detection, demand-forecast ML (planning
    is moving-average/linear/seasonal/manual, not learned), or copilot-style
    assistance, all of which NetSuite, QuickBooks, Xero and Zoho now market
    prominently. (Flagging for completeness — the user's other local-first
    apps in memory suggest this may be an intentional non-goal here too,
    worth confirming rather than assuming.)

## Decision
User picked the 4 "small" items to actually build: #1 email sending, #2 file
attachments, #3 drain the outbox, #4 enforce API token scopes. Two rounds of
Explore agents then read the exact code each touches (auth.mjs, rbac.mjs,
db.mjs, http.mjs, server.mjs, platform.mjs, collections.mjs, payruns.mjs,
record.js, txn.js, setup.js, the relevant migrations and tests) — findings
below are precise (file:line), not estimates. Honesty check: these turned out
to be four real, moderately-sized features (new migration + module + routes +
UI + tests each), not one-line fixes — the plan below builds all four
properly rather than cutting corners to keep the "small" label true.

---

# Implementation plan: attachments, outbox drain, email, token scopes

## Context
The competitive gap analysis above found four things every competitor ERP
has that Meridian doesn't, all independently useful and none requiring a new
architectural direction: attachments on records, a working delivery worker
for the outbox table that already exists, actual email capability, and real
enforcement of the token scopes the UI already implies exist. Building these
closes the most visible, least controversial gaps first (none touch the
"no statutory tax engine" / "no GraphQL" / single-node non-goals).

**Sequencing matters**: outbox draining is built before email, because email
delivery is wired through the outbox (the codebase's own rule, stated in
`platform.mjs:543` and the Integrations tab copy: *"Queued, never called
inline: the ledger must not wait on the network"*) rather than sending
inline from a request handler.

## 1. Outbox draining (build first)
**Schema**: migration `034_outbox_backoff.sql` adds `next_attempt_at TEXT`
to `integration_event` (migration `005_hr.sql:143-161`), so retries can be
scheduled without a cron dependency.

**New `src/core/outbox.mjs`** (core, not a tenant module, since it drains
across every tenant — same reasoning as `server.mjs`'s existing housekeeping
job): `drainOnce(db, { fetchImpl, now, logger })` selects due `pending` rows
(`status='pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now)`),
batched, and per `channel`:
- `webhook` → `fetch(target_url, { method:'POST', body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) })`, signed with an HMAC over the server secret (same construction as `auth.csrfFor`, `auth.mjs:93-97`) so a receiver can verify it. 2xx → `delivered`; otherwise increment `attempts`, set `last_error`, and either schedule `next_attempt_at` with exponential backoff or mark `failed` past a max (8) attempts.
- `email` → calls the new `core/smtp.mjs` (section 3) using that tenant's stored settings; same attempts/backoff/failed handling.
- `payroll` → left alone. Per `hr.mjs:425-429` and the README's own scope note, there's no real payroll provider to push to — this channel is a pull surface (`GET /setup/integration-events`) for a provider integration that doesn't exist yet. Draining it would be fabricating a delivery that doesn't correspond to anything real.

**Wiring**: add a `startBackgroundJobs(config, db)` call inside `createServer()` (`server.mjs`), not only `main()` (`:400-407`) as today, so it's exercised under test; guard it with `config.disableBackgroundJobs` for tests that don't want it running on a timer, and expose `outbox.drainOnce(db)` directly so tests can call it synchronously instead of waiting.

**Close two gaps Explore found while here**: `GET /setup/integration-events` (`api.mjs:1155-1157`) has no permission check today — gate it owner-only, matching `/settings/connection`. Add `POST /setup/integration-events/:id/retry` (reset to pending) and show `last_error`/`delivered_at`/a retry button in `views/setup.js:487-515`'s delivery log, which currently hides both.

**Tests**: `test/outbox.test.mjs` — a local `http.createServer` on port 0 as a fake webhook receiver (pattern from `test/dataio.test.mjs:31-52`); assert delivery, retry-with-backoff on 500s, `failed` after max attempts, and that `payroll` rows are left untouched.

## 2. File attachments
**Schema**: migration `035_attachments.sql`:
```sql
CREATE TABLE attachment (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL,
  record_type TEXT NOT NULL, record_id TEXT NOT NULL,
  filename TEXT NOT NULL, content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL, bytes BLOB NOT NULL,
  uploaded_by TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX ix_attachment_record ON attachment(tenant_id, record_type, record_id, created_at);
```
Add `attachment` to `TENANT_TABLES` (`db.mjs:26-72`) — `test/tenancy.test.mjs:113-124` enforces this isn't forgotten. Avoid a column name in `JSON_COLUMNS` (`db.mjs:82-90`) — `bytes` is safe.

**Real bug fix uncovered, worth fixing generally**: `encodeValue` (`db.mjs:206-213`) turns any `object` into `JSON.stringify(v)`, which would silently corrupt a `Buffer`/`Uint8Array` bound through `repo.insert`/`update`. Add a `Buffer.isBuffer(v) || v instanceof Uint8Array` pass-through before that branch, so attachments (and any future binary column) can go through `Repo` normally instead of needing raw `repo.exec` everywhere. `decodeRow` already needs no change — a BLOB returns untouched since it isn't in `JSON_COLUMNS`; wrap it in `Buffer.from(...)` only at the HTTP boundary, since `http.mjs:202` checks `Buffer.isBuffer`.

**New `src/modules/attachments.mjs`**: `list`, `get`, `create`, `remove` — `create` validates a size cap (20MB), that `record_type` resolves to a real permission (via `meta.getMeta` for generic/custom records, or `T.PERM_FOR` for transaction types), and that the target record actually exists and is visible (`repo.get` + `rbac.canSeeRow`) before allowing the attach — closes a possible spoofed-`record_type` gap, not just a happy-path feature.

**Routes** (new, in `api.mjs`): `GET/POST /attachments?record_type=&record_id=`, `GET /attachments/:id` (download), `DELETE /attachments/:id`. Upload takes base64 JSON (`{filename, content_type, data}`), matching the existing `resolveInput`/`Buffer.from(data,'base64')` convention (`api_data.mjs:37-49`) rather than inventing multipart parsing; a `bodyLimit` sized for the 20MB cap. Download sanitises the filename into the `Content-Disposition` header (RFC 5987 encoding) — Explore flagged the existing header-building code (`server.mjs:276-288`) doesn't do this anywhere yet, a real (if minor) bug worth fixing on the way past.

**Frontend**: `record.js` gets an Attachments card in the right rail between the activity and audit cards (`record.js:51-52`, matching the `activityCard`/`auditCard` pattern at `:415-431`); `txn.js` gets the same after the "Record" card (`:184`). Both fetch attachments with a second, lightweight call after the main record loads rather than changing `GET /records/:type/:id` or `GET /txn/:id`'s response shape. Reuse `readFileAsBase64`/`filePicker` from `data.js:56-89`.

**Tests**: `test/attachments.test.mjs` — upload/list/download round-trip (bytes match exactly), permission enforcement (VIEW to list/download, EDIT to upload/delete), record_type/record_id mismatch rejected, size cap rejected, tenant isolation, audit trail written.

## 3. Email (SMTP)
**New `src/core/smtp.mjs`**, hand-written against `node:net`/`node:tls` (no dependency exists for this, matching the project's own style for `zip.mjs`/`xlsx.mjs`/`pdf.mjs` — header comment, named `SmtpError`, stdlib only). `sendMail(config, { from, to, subject, text, attachments })`: connects (implicit TLS on 465, or STARTTLS on 587), EHLO, AUTH LOGIN/PLAIN if configured, MAIL FROM/RCPT TO/DATA with dot-stuffing, a `multipart/mixed` MIME body when a PDF is attached, socket timeouts, clean QUIT.

**Secrets**: an SMTP password must be recoverable (unlike every other secret in this codebase, which is hashed — `auth.mjs:29-41,56-65,129-145`), so it needs real encryption at rest, which doesn't exist anywhere yet. Derive a key from the existing server secret (`crypto.hkdfSync`, `auth.mjs:15-26`'s `secret.key`) and use AES-256-GCM; store `iv:authTag:ciphertext` inside the settings JSON, never returned by any GET.

**Storage**: `tenant.settings` (`migrations/001_platform.sql:25`) already exists as a JSON column but `tenant` isn't in `TENANT_TABLES`, so it needs a small raw-SQL helper (`UPDATE tenant SET settings = json_set(settings, '$.smtp', ?) WHERE id = :t`) rather than going through `Repo.update`. New owner-only routes `GET/PUT /setup/email-settings` (mirroring `/settings/connection`'s owner-gate + `audit.record`, `api.mjs:1042-1104`) and `POST /setup/email-settings/test` (sends immediately — the one deliberate exception to "never inline", since it's a user-triggered test action, not a document posting).

**Wiring — scoped to exactly what the manual already calls out as "produced for you to send"**, not every PDF in the app:
- `collections.mjs`: statements (`statementPdf`, `:283`) and dunning notices (`noticePdf`/`runDunning`, `:508-572` — whose own docstring says *"Nothing is sent anywhere"*, which stops being true) get an `emailStatement`/an email option on notice issue, enqueuing `channel:'email'` on `integration_event` rather than sending inline.
- `payruns.mjs`: supplier remittance advice (`remittancePdf`, `:296`) gets an "Email remittance" button using `vendor.remittance_email` (already loaded, `payruns.mjs:32,49`).
- Sales tax returns and 1099s are **out of scope** — those are for the company's own filing, not documents naturally emailed to a third party the way a statement or remittance advice is.

**Frontend**: a real settings section in Setup → Integrations (`views/setup.js:487-515`, which today just displays the outbox read-only) — host/port/secure/username/password (write-only, never redisplayed, matching the API token "shown once" precedent)/from name+address, Save, Send test email. "Email" buttons next to the existing "PDF" buttons in `collections.js:211-212,344,374` and `payruns.js:227`, toasting "Queued to be sent" (honest about async delivery, not claiming it's instant). Update the "makes no outbound connections" claim in `settings.js:465` and the equivalent lines in `README.md` / manual chapters 01 and 12 once this ships — the app's own docs would otherwise contradict its behaviour.

**Tests**: `test/smtp.test.mjs` — a `net.createServer` fake SMTP server on port 0 with scripted EHLO/AUTH/MAIL/RCPT/DATA/QUIT responses, covering the happy path, an auth failure, and a rejected recipient. `test/collections.test.mjs`/`payruns.test.mjs` additions checking the "Email" action enqueues a correctly-shaped `integration_event` (actual delivery is outbox.test.mjs's job). A round-trip test for the AES-GCM encrypt/decrypt helper.

## 4. Enforce API token scopes
**Scope model, kept small and real rather than a large taxonomy the UI can't yet expose**: `'*'` (today's only behaviour, unchanged, stays the default so nothing existing breaks) or `'read'` (every permission capped at `LEVEL.VIEW`, `isOwner` forced false) — this matches almost word-for-word what the token UI already tells users today (`views/data.js:773-798`: *"The token can see exactly what you can see, and nothing more"* / read access for BI tools). Any other/unrecognised scope value falls back to `'read'` rather than silently granting full access, which is the actual security gap today — `POST /setup/api-tokens` (`api.mjs:1121-1141`) currently accepts and stores any JSON array without checking its contents at all.

**Implementation, at the one hook Explore identified that needs no per-route changes**: in `server.mjs`, right after `access = rbac.loadAccess(...)` (`:223-234`), if the identity came from a token (not a session) and its scopes aren't `['*']`: force `access.isOwner = false` and cap every value in `access.permissions` to `LEVEL.VIEW`. Every one of the ~300 `require$`/`can`/`levelFor`/`rowFilter`/`canSeeRow` call sites across `api.mjs`/`api_ops.mjs`/`api_data.mjs`/`odata.mjs`/`soap.mjs` then respects the cap automatically. Also fix `readApiToken` (`auth.mjs:138-145`) to actually `JSON.parse` `scopes` — it returns the raw column value today since it reads via `db.prepare` rather than `Repo`.

**Close the routes a capped token would otherwise still reach**: Explore found several authenticated routes with no permission check at all regardless of scope — `GET /gl/periods` and `/gl/rates` (`api.mjs:539,574`), the dashboard/aging/trend/drilldown report routes (`:838,843-849`), `GET /bank/reconciliations/:id` (`:880`), and `/setup/integration-events` (already being fixed in section 1). Add `require$`/`reportGuard` to each — real hardening this feature surfaced, not scope creep.

**Frontend**: a "Read-only" checkbox in the create-token dialog (`views/data.js:773-798`), and show each token's scope in the list (`:754-771`), which the API already returns but the UI doesn't display.

**Tests**: extend `test/dataio.test.mjs`'s existing token-auth coverage (`:765-790`) with a scoped-token case — a read-only token can `GET` but gets `403` on a mutating `POST`, and doesn't inherit owner bypass. Add coverage for the newly-guarded previously-open routes.

## Critical files (grouped, not exhaustive)
- New: `migrations/034_outbox_backoff.sql`, `035_attachments.sql`, `src/core/outbox.mjs`, `src/core/smtp.mjs`, `src/modules/attachments.mjs`, `test/outbox.test.mjs`, `test/attachments.test.mjs`, `test/smtp.test.mjs`
- Core: `src/core/db.mjs` (Buffer pass-through, `TENANT_TABLES`), `src/core/auth.mjs` (scopes JSON parse, AES-GCM helper), `src/server.mjs` (background jobs, token scope capping), `src/core/http.mjs` (filename encoding)
- Modules: `src/modules/collections.mjs`, `src/modules/payruns.mjs`, `src/modules/platform.mjs`
- Routes: `src/api.mjs`, `src/api_ops.mjs`
- Frontend: `src/web/js/api.js`, `views/record.js`, `views/txn.js`, `views/setup.js`, `views/collections.js`, `views/payruns.js`, `views/data.js`, `views/settings.js`
- Docs: `README.md`, `src/web/manual/01-*.md`, `12-*.md`

## Verification
- `./scripts/check.sh` clean; `node --test test/` fully green, including the 4 new test files.
- Manual smoke test against a running server: create a read-only API token and confirm a mutating call is rejected; attach and download a file on an invoice and a customer record with byte-for-byte integrity; configure SMTP settings and send a test email against a local fake-SMTP listener; enqueue a webhook and watch it deliver on the next drain cycle without waiting on the hour-long interval (call `outbox.drainOnce` directly).
- Re-run the existing 527 tests to confirm nothing already passing regresses, especially `test/tenancy.test.mjs` (new table registered) and `test/routes.test.mjs` (new GET routes return something other than 500).
