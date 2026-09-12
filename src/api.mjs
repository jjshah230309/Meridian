// Meridian ERP :: api
// The REST surface. Every route runs inside a tenant-scoped Repo with the
// caller's effective permissions already resolved, and every mutating route
// runs inside a single database transaction.
import { Router, badRequest, notFound, forbidden, unprocessable, conflict, ValidationError, HttpError, rowList } from './core/http.mjs';
import { Repo, transaction } from './core/db.mjs';
import { Money, Qty, ulid, nowIso, today, addDays, startOfMonth, endOfMonth, addMonths, safeJson, sum } from './core/util.mjs';
import * as rbac from './core/rbac.mjs';
import * as audit from './core/audit.mjs';
import * as searchIdx from './core/search.mjs';
import * as auth from './core/auth.mjs';
import * as appconfig from './core/appconfig.mjs';
import * as desktop from './core/desktop.mjs';
import { validate as validateExpr, evalSafe } from './core/expr.mjs';
import * as meta from './modules/meta.mjs';
import * as gl from './modules/gl.mjs';
import * as inv from './modules/inventory.mjs';
import * as entities from './modules/entities.mjs';
import * as T from './modules/txn.mjs';
import * as crm from './modules/crm.mjs';
import * as hr from './modules/hr.mjs';
import * as reports from './modules/reports.mjs';
import * as platform from './modules/platform.mjs';
import * as bank from './modules/bank.mjs';
import * as setup from './modules/setup.mjs';
import * as projects from './modules/projects.mjs';
import * as schedules from './modules/schedules.mjs';
import * as recurring from './modules/recurring.mjs';
import * as revaluation from './modules/revaluation.mjs';
import * as customRecords from './modules/customrecords.mjs';
import { HANDLERS, coerce, genericCreate, genericUpdate, blockersFor } from './modules/records.mjs';
import { registerOpsRoutes } from './api_ops.mjs';
import { registerDataRoutes, registerODataRoutes, registerSoapRoutes } from './api_data.mjs';

const LEVEL = rbac.LEVEL;

// ---------------------------------------------------------------- helpers
const int = (v, d = 0) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const bool = (v) => v === true || v === 'true' || v === '1' || v === 1;

/** Run before_/after_ workflows around a mutation. */
function withWorkflows(repo, type, trigger, record, before, mutable) {
  const r = platform.dispatch(repo, type, trigger, record, { before, mutable });
  if (r.blocked) throw unprocessable(r.blocked);
  return r;
}

const requirePerm = (ctx, type, level) => {
  const m = meta.getMeta(type, ctx.repo);
  rbac.require$(ctx.access, m?.permission || type, level);
};

// ====================================================================
export function buildApi({ config }) {
  const r = new Router();
  const P = '/api/v1';

  // ------------------------------------------------------------- health
  r.get('/health', () => ({ ok: true, service: 'meridian-erp', version: config.version, time: nowIso() }), { public: true });

  // --------------------------------------------------------------- auth
  r.post(`${P}/auth/login`, async (ctx) => {
    const { email, password, tenant } = ctx.body || {};
    if (!email || !password) throw badRequest('Email and password are required');
    const t = tenant
      ? ctx.db.prepare('SELECT * FROM tenant WHERE slug = ? OR id = ?').get(tenant, tenant)
      : ctx.db.prepare('SELECT * FROM tenant ORDER BY created_at LIMIT 1').get();
    if (!t) throw new HttpError(401, 'Unknown company');
    if (t.status !== 'active') throw new HttpError(403, `This company account is ${t.status}.`);

    const result = auth.authenticate(ctx.db, { tenantId: t.id, email, password, ip: ctx.ip, userAgent: ctx.req.headers['user-agent'] });
    if (!result.ok) {
      const messages = {
        invalid_credentials: 'That email and password do not match.',
        account_disabled: 'That account has been disabled. Ask an administrator to re-enable it.',
        account_locked: `Too many failed attempts. Try again after ${result.until ? new Date(result.until).toLocaleTimeString() : 'a short wait'}.`,
      };
      throw new HttpError(401, messages[result.reason] || 'Sign-in failed', result.reason.toUpperCase());
    }
    const repo = new Repo(ctx.db, t.id, { user: result.user, ip: ctx.ip });
    audit.record(repo, { recordType: 'app_user', recordId: result.user.id, action: 'login', changes: { ip: { from: null, to: ctx.ip } } });

    ctx.setSessionCookie(result.session.token);
    const access = rbac.loadAccess(ctx.db, t.id, result.user.id);
    return {
      user: { id: result.user.id, name: result.user.name, email: result.user.email, is_owner: !!result.user.is_owner },
      tenant: { id: t.id, name: t.name, slug: t.slug, base_currency: t.base_currency },
      csrf: auth.csrfFor(config.secret, result.session.id),
      permissions: access.permissions, roles: access.roles.map((x) => x.name),
      expires_at: result.session.expiresAt,
    };
  }, { public: true, rateLimit: 'auth' });

  r.post(`${P}/auth/logout`, async (ctx) => {
    if (ctx.sessionToken) auth.destroySession(ctx.db, ctx.sessionToken);
    ctx.clearSessionCookie();
    return { ok: true };
  }, { public: true });

  r.get(`${P}/auth/session`, async (ctx) => {
    if (!ctx.user) throw new HttpError(401, 'Not signed in');
    return {
      user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email, is_owner: !!ctx.user.is_owner, employee_id: ctx.user.employee_id },
      tenant: { id: ctx.tenant.id, name: ctx.tenant.name, slug: ctx.tenant.slug, base_currency: ctx.tenant.base_currency },
      csrf: ctx.csrf, permissions: ctx.access.permissions, roles: ctx.access.roles.map((x) => x.name),
      restrictions: Object.fromEntries(Object.entries(ctx.access.restrictions || {}).map(([k, v]) => [k, { own_only: v.ownOnly, count: v.allowed ? v.allowed.size : null }])),
    };
  });

  r.post(`${P}/auth/password`, async (ctx) => {
    const { current_password, new_password } = ctx.body || {};
    const user = ctx.db.prepare('SELECT * FROM app_user WHERE tenant_id = ? AND id = ?').get(ctx.tenant.id, ctx.user.id);
    if (!auth.verifyPassword(current_password, user.password_hash, user.password_salt)) {
      throw new ValidationError({ current_password: 'That is not your current password' });
    }
    const problems = auth.passwordProblems(new_password);
    if (problems.length) throw new ValidationError({ new_password: `Password ${problems.join(', ')}` });
    const { hash, salt } = auth.hashPassword(new_password);
    ctx.repo.update('app_user', ctx.user.id, { password_hash: hash, password_salt: salt, updated_at: nowIso() });
    auth.destroyUserSessions(ctx.db, ctx.tenant.id, ctx.user.id);   // force re-login everywhere
    audit.record(ctx.repo, { recordType: 'app_user', recordId: ctx.user.id, action: 'password_change' });
    ctx.clearSessionCookie();
    return { ok: true, message: 'Password updated. Please sign in again.' };
  });

  r.get(`${P}/auth/tenants`, async (ctx) => ({
    tenants: ctx.db.prepare("SELECT id, slug, name FROM tenant WHERE status='active' ORDER BY name").all(),
  }), { public: true });

  // ----------------------------------------------------- first-run setup
  // Before any company exists there is nobody to authenticate as, so these
  // two are public. `provision` refuses the moment a tenant exists, which is
  // what stops it from being a way to add companies without signing in.
  r.get(`${P}/setup/state`, async (ctx) => {
    const count = ctx.db.prepare('SELECT COUNT(*) c FROM tenant').get().c;
    return {
      configured: count > 0,
      currencies: setup.DEFAULT_CURRENCIES.map(([code, name, symbol]) => ({ code, name, symbol })),
      countries: setup.SETUP_COUNTRIES,
      version: config.version,
    };
  }, { public: true });

  r.post(`${P}/setup/provision`, async (ctx) => {
    if (ctx.db.prepare('SELECT COUNT(*) c FROM tenant').get().c > 0) {
      throw conflict('This copy of Meridian has already been set up. Sign in instead.');
    }
    const b = ctx.body || {};
    const result = transaction(ctx.db, () => setup.provisionTenant(ctx.db, {
      name: b.company_name,
      ownerEmail: b.email,
      ownerName: b.full_name || 'Administrator',
      ownerPassword: b.password,
      baseCurrency: b.currency || 'USD',
      country: b.country || 'US',
      fiscalYear: Number(b.fiscal_year) || new Date().getUTCFullYear(),
    }));

    // Sample data is opt-in: a company that wants to start on its own books
    // should not have to delete somebody else's invoices first.
    if (b.sample_data) {
      const { seedSampleData } = await import('./seed.mjs');
      await seedSampleData(ctx.db, result.tenant.id);
    }
    return { ok: true, company: b.company_name, email: b.email };
  }, { public: true });

  // --------------------------------------------------------- metadata
  r.get(`${P}/meta`, async (ctx) => {
    const visible = {};
    for (const [type, m] of Object.entries(meta.RECORDS)) {
      const level = rbac.levelFor(ctx.access, m.permission);
      if (level < LEVEL.VIEW) continue;
      visible[type] = {
        type, label: m.label, plural: m.plural, group: m.group, icon: m.icon || null,
        permission: m.permission, level, isTransaction: !!m.isTransaction, txnType: m.txnType || null,
        title: m.title, defaultSort: m.defaultSort, listColumns: m.listColumns,
        fields: m.fields, readOnlyRecord: !!m.readOnlyRecord,
        customFields: platform.listCustomFields(ctx.repo, type),
      };
    }
    // Custom types come down the same pipe as the built-ins, which is what
    // makes them appear in navigation, lists, forms and search without any of
    // those knowing that custom records exist.
    const customLevel = rbac.levelFor(ctx.access, 'custom_record');
    if (customLevel >= LEVEL.VIEW) {
      for (const [type, m] of Object.entries(customRecords.describeAll(ctx.repo))) {
        visible[type] = {
          type, label: m.label, plural: m.plural, group: m.group, icon: m.icon || null,
          permission: m.permission, level: customLevel, isTransaction: false, txnType: null,
          title: m.title, defaultSort: m.defaultSort, listColumns: m.listColumns,
          fields: m.fields, readOnlyRecord: false,
          isCustom: true, customType: m.customType, description: m.description,
          // A custom type's own fields are already in `fields`; listing them
          // again here would make the record screen render each one twice.
          customFields: [],
        };
      }
    }

    return {
      records: visible,
      groups: Object.entries(visible).reduce((g, [type, m]) => { (g[m.group] ||= []).push(type); return g; }, {}),
      books: rbac.can(ctx.access, 'accounting_book', LEVEL.VIEW)
        ? ctx.repo.query("SELECT id, name, code, is_primary, purpose, basis FROM accounting_book WHERE tenant_id = :t AND status = 'active' ORDER BY is_primary DESC, name")
        : [],
      currencies: ctx.repo.query('SELECT * FROM currency WHERE tenant_id = :t AND active = 1 ORDER BY code'),
      subsidiaries: ctx.repo.find('subsidiary', { where: { active: 1 }, order: 'name' }),
      locations: ctx.repo.find('location', { where: { active: 1 }, order: 'name' }),
      departments: ctx.repo.find('department', { where: { active: 1 }, order: 'name' }),
      price_levels: ctx.repo.find('price_level', { where: { active: 1 }, order: 'name' }),
      bank_accounts: ctx.repo.find('bank_account', { where: { active: 1 }, order: 'name' }),
      tax_codes: ctx.repo.query('SELECT * FROM tax_code WHERE tenant_id = :t AND active = 1 ORDER BY code'),
      periods: ctx.repo.find('accounting_period', { order: 'start_date DESC', limit: 48 }),
      txn_types: T.TYPES,
      operators: platform.OPERATORS,
      action_types: platform.ACTION_TYPES,
      workflow_triggers: platform.TRIGGERS,
      account_subtypes: gl.SUBTYPES,
      scripts_enabled: platform.scriptsEnabled(),
    };
  });

  // --------------------------------------------------- generic records
  r.get(`${P}/records/:type`, async (ctx) => {
    const type = ctx.params.type;
    const m = meta.getMeta(type, ctx.repo);
    if (!m) throw notFound(`Unknown record type "${type}"`);
    requirePerm(ctx, type, LEVEL.VIEW);

    const definition = {
      columns: ctx.query.columns ? String(ctx.query.columns).split(',') : undefined,
      filters: ctx.query.filters ? safeJson(ctx.query.filters, []) : [],
      sort: ctx.query.sort || undefined,
    };
    // Free-text `q` maps onto the record's declared search fields.
    if (ctx.query.q) {
      const q = String(ctx.query.q);
      definition.filters = [...(definition.filters || [])];
      // An empty array is truthy, so `|| [m.title]` alone would let a record
      // type that declares no search fields build `WHERE ()`.
      const declared = m.searchFields?.length ? m.searchFields : null;
      const fields = declared || [m.title].filter(Boolean);
      definition._orSearch = { q, fields };
    }
    let out;
    if (definition._orSearch?.fields?.length) {
      const { q, fields } = definition._orSearch;
      const rf = rbac.rowFilter(ctx.access, m.table, { alias: 'r' });
      // A custom type's own fields live in the JSON column, so a free-text
      // search has to reach into it rather than name a column that is not there.
      const fmap = meta.fieldMap(type, ctx.repo);
      const colFor = (f) => (fmap[f]?.inCustom ? `json_extract(r.custom, '$.${f}')` : `r.${f}`);
      const like = fields.map((f) => `${colFor(f)} LIKE ?`).join(' OR ');
      const params = fields.map(() => `%${q}%`);
      const typeClause = m.txnType ? ' AND r.type = ?' : (m.customType ? ' AND r.type_name = ?' : '');
      if (m.txnType) params.unshift(m.txnType);
      else if (m.customType) params.unshift(m.customType);
      const limit = Math.min(int(ctx.query.limit, 100), 1000);
      const offset = int(ctx.query.offset, 0);
      const rows = ctx.repo.query(
        `SELECT * FROM ${m.table} r WHERE r.tenant_id = :t${typeClause} AND (${like})${rf.sql}
         ORDER BY r.${m.defaultSort || 'id DESC'} LIMIT ? OFFSET ?`,
        [...params, ...rf.params, limit, offset]);
      const total = ctx.repo.scalar(
        `SELECT COUNT(*) c FROM ${m.table} r WHERE r.tenant_id = :t${typeClause} AND (${like})${rf.sql}`,
        [...params, ...rf.params], 0);
      platform.resolveReferences(ctx.repo, type, m.listColumns, rows);
      out = { record_type: type, rows, total, limit, offset, columns: m.listColumns };
    } else {
      out = platform.runSearch(ctx.repo, type, definition, {
        access: ctx.access, limit: int(ctx.query.limit, 100), offset: int(ctx.query.offset, 0),
      });
    }
    return { ...out, label: m.label, plural: m.plural };
  });

  r.get(`${P}/records/:type/:id`, async (ctx) => {
    const { type, id } = ctx.params;
    const m = meta.getMeta(type, ctx.repo);
    if (!m) throw notFound(`Unknown record type "${type}"`);
    requirePerm(ctx, type, LEVEL.VIEW);

    let record = m.isTransaction ? T.getTxn(ctx.repo, id) : ctx.repo.get(m.table, id);
    if (!record) throw notFound(`${m.label} not found`);
    if (m.isTransaction && record.type !== m.txnType) throw notFound(`${m.label} not found`);
    // Every custom type shares one table, so the id alone does not say the
    // caller asked for the right one.
    if (m.customType && record.type_name !== m.customType) throw notFound(`${m.label} not found`);
    if (m.customType) record = customRecords.flatten(record);
    if (!rbac.canSeeRow(ctx.access, m.table, record)) throw forbidden(`You do not have access to that ${m.label.toLowerCase()}.`);
    record = platform.decorateCustom(ctx.repo, type, record);
    platform.resolveReferences(ctx.repo, type, m.fields.map((f) => f.name), [record]);
    for (const f of m.redact || []) delete record[f];

    return {
      record, record_type: type,
      audit: rbac.can(ctx.access, 'audit_event', LEVEL.VIEW) ? audit.historyFor(ctx.repo, type, id, 30) : [],
      activities: ['customer', 'lead', 'opportunity', 'vendor', 'support_case'].includes(type) ? crm.timelineFor(ctx.repo, type, id) : [],
      related: relatedFor(ctx, type, id, record),
    };
  });

  r.post(`${P}/records/:type`, async (ctx) => {
    const type = ctx.params.type;
    const m = meta.getMeta(type, ctx.repo);
    if (!m) throw notFound(`Unknown record type "${type}"`);
    requirePerm(ctx, type, LEVEL.CREATE);
    return ctx.tx(() => {
      const mutable = { ...ctx.body };
      withWorkflows(ctx.repo, type, 'before_create', mutable, null, mutable);
      const created = m.customType
        ? customRecords.createRecord(ctx.repo, type, mutable)
        : (HANDLERS[type]?.create
          ? HANDLERS[type].create(ctx.repo, mutable)
          : genericCreate(ctx.repo, type, mutable));
      if (ctx.body.custom !== undefined && HANDLERS[type]?.create && !m.isTransaction) {
        ctx.repo.update(m.table, created.id, { custom: platform.validateCustom(ctx.repo, type, ctx.body.custom) });
      }
      withWorkflows(ctx.repo, type, 'after_create', created, null, null);
      if (m.customType) return customRecords.getRecord(ctx.repo, type, created.id);
      return m.isTransaction ? T.getTxn(ctx.repo, created.id) : ctx.repo.get(m.table, created.id);
    });
  });

  r.patch(`${P}/records/:type/:id`, async (ctx) => {
    const { type, id } = ctx.params;
    const m = meta.getMeta(type, ctx.repo);
    if (!m) throw notFound(`Unknown record type "${type}"`);
    requirePerm(ctx, type, LEVEL.EDIT);
    return ctx.tx(() => {
      const before = m.isTransaction ? T.getTxn(ctx.repo, id) : ctx.repo.get(m.table, id);
      if (!before) throw notFound(`${m.label} not found`);
      if (!rbac.canSeeRow(ctx.access, m.table, before)) throw forbidden('You do not have access to that record.');
      const mutable = { ...ctx.body };
      withWorkflows(ctx.repo, type, 'before_update', { ...before, ...mutable }, before, mutable);
      const updated = m.customType
        ? customRecords.updateRecord(ctx.repo, type, id, mutable)
        : (HANDLERS[type]?.update
          ? HANDLERS[type].update(ctx.repo, id, mutable)
          : genericUpdate(ctx.repo, type, id, mutable));
      if (mutable.custom !== undefined && HANDLERS[type]?.update && !m.isTransaction && !m.customType) {
        ctx.repo.update(m.table, id, { custom: platform.validateCustom(ctx.repo, type, { ...(before.custom || {}), ...mutable.custom }) });
      }
      withWorkflows(ctx.repo, type, 'after_update', updated, before, null);
      if (m.customType) return customRecords.getRecord(ctx.repo, type, id);
      return m.isTransaction ? T.getTxn(ctx.repo, id) : ctx.repo.get(m.table, id);
    });
  });

  r.delete(`${P}/records/:type/:id`, async (ctx) => {
    const { type, id } = ctx.params;
    const m = meta.getMeta(type, ctx.repo);
    if (!m) throw notFound(`Unknown record type "${type}"`);
    requirePerm(ctx, type, LEVEL.FULL);
    return ctx.tx(() => {
      if (m.isTransaction) return T.voidTxn(ctx.repo, id, { reason: ctx.body?.reason || 'Deleted by user' });
      const before = ctx.repo.get(m.table, id);
      if (!before) throw notFound(`${m.label} not found`);
      if (HANDLERS[type]?.remove) { HANDLERS[type].remove(ctx.repo, id); return { ok: true, deleted: id }; }

      // Anything a posted transaction can point at is DEACTIVATED, never
      // destroyed: hard-deleting a customer would orphan its invoices and
      // silently break the audit trail. Preference order:
      //   1. an `active` flag,
      //   2. a `status` field that offers a retired value,
      //   3. a genuine delete -- and only when nothing references the row.
      const hasActive = m.fields.some((f) => f.name === 'active');
      const retired = retireStatusFor(type, m);
      if (hasActive || retired) {
        ctx.repo.update(m.table, id, hasActive ? { active: 0 } : { status: retired });
        // A user losing their account must lose their sessions with it,
        // otherwise the browser they left open keeps working for 12 hours.
        if (m.table === 'app_user') auth.destroyUserSessions(ctx.db, ctx.tenant.id, id);
        audit.record(ctx.repo, { recordType: type, recordId: id, action: 'deactivate', before });
        return { ok: true, deactivated: id, message: `${m.label} deactivated. Its history is retained.` };
      }

      const blocking = blockersFor(ctx.repo, type, id);
      if (blocking) {
        throw conflict(`${m.label} cannot be deleted: ${blocking}. It stays on the record so the history it produced still says where it came from.`);
      }
      ctx.repo.remove(m.table, id);
      searchIdx.unindexRecord(ctx.repo, type, id);
      audit.record(ctx.repo, { recordType: type, recordId: id, action: 'delete', before });
      return { ok: true, deleted: id };
    });
  });

  /**
   * Types whose `status` has a value that honestly means "no longer in use",
   * true whatever the record has already done. Named one by one rather than
   * guessed from the options: an employee who leaves is terminated and that
   * remains accurate, but marking a finished work order "cancelled" would say
   * the job never happened. Everything not listed here is either switched off
   * with an `active` flag, refused because it has consequences, or genuinely
   * deleted because it has none.
   */
  const RETIRE_STATUS = {
    employee: 'terminated',
    app_user: 'disabled',
    bom: 'obsolete',
    service_asset: 'retired',
    service_contract: 'cancelled',
  };

  /**
   * The status to switch a record off with, or null if it has none. A literal
   * "inactive" option always qualifies — that word says switched off and
   * nothing more — and the map above covers the types where a different word
   * carries the same plain meaning.
   */
  function retireStatusFor(type, m) {
    const options = m.fields.find((f) => f.name === 'status')?.options || [];
    if (options.includes('inactive')) return 'inactive';
    const named = RETIRE_STATUS[type];
    return named && options.includes(named) ? named : null;
  }


  /** Sub-lists shown on a record page. */
  function relatedFor(ctx, type, id, record) {
    const out = {};
    try {
      if (type === 'customer') {
        out.financials = entities.customerFinancials(ctx.repo, id);
        out.transactions = T.listTxns(ctx.repo, { entityId: id, limit: 25 }).rows;
        out.contacts = ctx.repo.find('contact', { where: { company_type: 'customer', company_id: id }, order: 'last_name' });
        out.opportunities = ctx.repo.find('opportunity', { where: { customer_id: id }, order: 'expected_close DESC', limit: 20 });
        out.cases = ctx.repo.find('support_case', { where: { customer_id: id }, order: 'created_at DESC', limit: 20 });
      } else if (type === 'vendor') {
        out.financials = entities.vendorFinancials(ctx.repo, id);
        out.transactions = T.listTxns(ctx.repo, { entityId: id, limit: 25 }).rows;
        out.contacts = ctx.repo.find('contact', { where: { company_type: 'vendor', company_id: id }, order: 'last_name' });
      } else if (type === 'item') {
        out.availability = inv.availability(ctx.repo, id);
        out.history = inv.itemHistory(ctx.repo, id, { limit: 40 });
        out.prices = ctx.repo.query(`SELECT ip.*, pl.name price_level_name FROM item_price ip
            JOIN price_level pl ON pl.tenant_id = ip.tenant_id AND pl.id = ip.price_level_id
            WHERE ip.tenant_id = :t AND ip.item_id = ? ORDER BY pl.name, ip.min_qty`, [id]);
      } else if (type === 'employee') {
        out.reports = ctx.repo.find('employee', { where: { manager_id: id, status: 'active' }, order: 'last_name' });
        out.time = ctx.repo.find('time_entry', { where: { employee_id: id }, order: 'entry_date DESC', limit: 30 });
        out.time_off = ctx.repo.find('time_off', { where: { employee_id: id }, order: 'start_date DESC', limit: 20 });
      } else if (type === 'account') {
        out.ledger = gl.accountLedger(ctx.repo, id, { limit: 100 });
      } else if (type === 'support_case') {
        out.messages = ctx.repo.query('SELECT * FROM case_message WHERE tenant_id = :t AND case_id = ? ORDER BY created_at', [id]);
      } else if (type === 'opportunity') {
        out.quotes = T.listTxns(ctx.repo, { types: ['QUOTE', 'SALES_ORDER'], limit: 20 }).rows.filter((x) => x.opportunity_id === id);
      } else if (type === 'schedule') {
        out.schedule_lines = schedules.linesFor(ctx.repo, id);
      } else if (type === 'revaluation_run') {
        out.revaluation_lines = revaluation.linesFor(ctx.repo, id);
        out.journal = record?.entry_id ? gl.getJournalEntry(ctx.repo, record.entry_id) : null;
      } else if (type === 'recurring_journal') {
        out.recurring_lines = recurring.linesFor(ctx.repo, id);
        out.recurring_history = recurring.historyFor(ctx.repo, id);
      } else if (type === 'schedule_template') {
        out.schedules = ctx.repo.find('schedule', { where: { template_id: id }, order: 'created_at DESC', limit: 30 });
        out.items = ctx.repo.query(
          `SELECT id, sku, name FROM item WHERE tenant_id = :t AND (revenue_template_id = ? OR expense_template_id = ?) ORDER BY sku`, [id, id]);
      } else if (meta.getMeta(type)?.isTransaction) {
        out.journal = record?.journal_entry_id ? gl.getJournalEntry(ctx.repo, record.journal_entry_id) : null;
        out.transforms = T.TRANSFORMS[record?.type] || [];
        out.schedules = schedules.schedulesForTxn(ctx.repo, id);
      } else if (type === 'expense_report') {
        out.expense_lines = projects.expenseLines(ctx.repo, id);
        out.journal = record?.journal_entry_id ? gl.getJournalEntry(ctx.repo, record.journal_entry_id) : null;
      } else if (type === 'workflow') {
        out.logs = ctx.repo.query('SELECT * FROM workflow_log WHERE tenant_id = :t AND workflow_id = ? ORDER BY at DESC LIMIT 50', [id]);
      }
    } catch { /* a related-list failure must not break the record page */ }
    return out;
  }

  // ---------------------------------------------------------------- GL
  r.get(`${P}/gl/accounts`, async (ctx) => {
    rbac.require$(ctx.access, 'account', LEVEL.VIEW);
    return {
      tree: gl.chartOfAccounts(ctx.repo, {
        includeInactive: bool(ctx.query.include_inactive),
        periodId: ctx.query.period_id || null, subsidiaryId: ctx.query.subsidiary_id || null,
      }),
      balances: gl.balanceMap(ctx.repo, { subsidiaryId: ctx.query.subsidiary_id || null }),
    };
  });

  r.post(`${P}/gl/journal`, async (ctx) => {
    rbac.require$(ctx.access, 'journal_entry', LEVEL.CREATE);
    return ctx.tx(() => {
      const lines = rowList(ctx.body.lines).map((l) => ({
        ...l, debit: Money.parse(l.debit || 0), credit: Money.parse(l.credit || 0),
      }));
      const entry = gl.postJournal(ctx.repo, { ...ctx.body, lines });
      withWorkflows(ctx.repo, 'journal_entry', 'on_post', entry, null, null);
      return entry;
    });
  });

  r.post(`${P}/gl/journal/:id/reverse`, async (ctx) => {
    rbac.require$(ctx.access, 'journal_entry', LEVEL.FULL);
    return ctx.tx(() => gl.reverseJournal(ctx.repo, ctx.params.id, ctx.body || {}));
  });

  r.get(`${P}/gl/journal/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'journal_entry', LEVEL.VIEW);
    const e = gl.getJournalEntry(ctx.repo, ctx.params.id);
    if (!e) throw notFound('Journal entry not found');
    return e;
  });

  r.get(`${P}/gl/ledger/:accountId`, async (ctx) => {
    rbac.require$(ctx.access, 'account', LEVEL.VIEW);
    return gl.accountLedger(ctx.repo, ctx.params.accountId, {
      from: ctx.query.from, to: ctx.query.to,
      subsidiaryId: ctx.query.subsidiary_id || null, limit: int(ctx.query.limit, 500),
    });
  });

  r.get(`${P}/gl/periods`, async (ctx) => ctx.repo.find('accounting_period', { order: 'start_date DESC' }));

  r.post(`${P}/gl/periods/generate`, async (ctx) => {
    rbac.require$(ctx.access, 'accounting_period', LEVEL.FULL);
    return ctx.tx(() => ({ created: gl.generatePeriods(ctx.repo, int(ctx.body.fiscal_year, new Date().getUTCFullYear()), int(ctx.body.start_month, 1)).length }));
  });

  r.post(`${P}/gl/periods/:id/close`, async (ctx) => {
    rbac.require$(ctx.access, 'accounting_period', LEVEL.FULL);
    return ctx.tx(() => gl.closePeriod(ctx.repo, ctx.params.id, { force: bool(ctx.body?.force) }));
  });

  r.post(`${P}/gl/periods/:id/reopen`, async (ctx) => {
    rbac.require$(ctx.access, 'accounting_period', LEVEL.FULL);
    return ctx.tx(() => gl.reopenPeriod(ctx.repo, ctx.params.id));
  });

  r.post(`${P}/gl/rebuild-balances`, async (ctx) => {
    if (!ctx.access.isOwner) throw forbidden('Only the account owner can rebuild ledger balances.');
    return ctx.tx(() => ({ rebuilt: gl.rebuildBalances(ctx.repo), integrity: gl.integrityCheck(ctx.repo) }));
  });

  r.post(`${P}/gl/rates`, async (ctx) => {
    rbac.require$(ctx.access, 'exchange_rate', LEVEL.CREATE);
    const { from_currency, to_currency, rate_date, rate } = ctx.body || {};
    if (!from_currency || !to_currency || !rate_date || !rate) throw badRequest('from_currency, to_currency, rate_date and rate are all required');
    return ctx.tx(() => {
      ctx.repo.exec(`INSERT INTO exchange_rate (tenant_id, from_currency, to_currency, rate_date, rate, source)
          VALUES (:t,?,?,?,?,'manual')
          ON CONFLICT (tenant_id, from_currency, to_currency, rate_date) DO UPDATE SET rate = excluded.rate`,
        [from_currency, to_currency, rate_date, Number(rate)]);
      return { ok: true };
    });
  });

  r.get(`${P}/gl/rates`, async (ctx) => ctx.repo.query('SELECT * FROM exchange_rate WHERE tenant_id = :t ORDER BY rate_date DESC LIMIT 200'));

  // -------------------------------------------------------- transactions
  r.get(`${P}/txn`, async (ctx) => {
    const type = ctx.query.type || null;
    if (type && meta.getMeta(String(type).toLowerCase())) requirePerm(ctx, String(type).toLowerCase(), LEVEL.VIEW);
    const rf = rbac.rowFilter(ctx.access, 'txn', { alias: 't' });
    return T.listTxns(ctx.repo, {
      type: type ? String(type).toUpperCase() : null,
      status: ctx.query.status || null, entityId: ctx.query.entity_id || null,
      from: ctx.query.from || null, to: ctx.query.to || null, search: ctx.query.q || null,
      subsidiaryId: ctx.query.subsidiary_id || null, locationId: ctx.query.location_id || null,
      overdueOnly: bool(ctx.query.overdue), openOnly: bool(ctx.query.open),
      limit: int(ctx.query.limit, 100), offset: int(ctx.query.offset, 0),
      order: ctx.query.order || undefined,
      rowFilterSql: rf.sql, rowFilterParams: rf.params,
    });
  });

  r.get(`${P}/txn/:id`, async (ctx) => {
    const t = T.getTxn(ctx.repo, ctx.params.id);
    if (!t) throw notFound('Transaction not found');
    requirePerm(ctx, T.PERM_FOR[t.type], LEVEL.VIEW);
    if (!rbac.canSeeRow(ctx.access, 'txn', t)) throw forbidden('You do not have access to that transaction.');
    return { ...t, journal: t.journal_entry_id ? gl.getJournalEntry(ctx.repo, t.journal_entry_id) : null, transforms: T.TRANSFORMS[t.type] || [] };
  });

  r.post(`${P}/txn/:id/approve`, async (ctx) => {
    const t = T.requireTxn(ctx.repo, ctx.params.id);
    requirePerm(ctx, T.PERM_FOR[t.type], LEVEL.FULL);
    return ctx.tx(() => {
      const approved = T.approveTxn(ctx.repo, ctx.params.id, ctx.body || {});
      withWorkflows(ctx.repo, T.PERM_FOR[t.type], 'on_approve', approved, t, null);
      return approved;
    });
  });

  r.post(`${P}/txn/:id/reject`, async (ctx) => {
    const t = T.requireTxn(ctx.repo, ctx.params.id);
    requirePerm(ctx, T.PERM_FOR[t.type], LEVEL.FULL);
    return ctx.tx(() => T.rejectTxn(ctx.repo, ctx.params.id, ctx.body || {}));
  });

  r.post(`${P}/txn/:id/void`, async (ctx) => {
    const t = T.requireTxn(ctx.repo, ctx.params.id);
    requirePerm(ctx, T.PERM_FOR[t.type], LEVEL.FULL);
    return ctx.tx(() => T.voidTxn(ctx.repo, ctx.params.id, ctx.body || {}));
  });

  r.post(`${P}/txn/:id/post`, async (ctx) => {
    const t = T.requireTxn(ctx.repo, ctx.params.id);
    requirePerm(ctx, T.PERM_FOR[t.type], LEVEL.FULL);
    return ctx.tx(() => T.postTxn(ctx.repo, ctx.params.id));
  });

  r.get(`${P}/txn/:id/transform/:target`, async (ctx) => {
    const target = String(ctx.params.target).toUpperCase();
    return T.transformPreview(ctx.repo, ctx.params.id, target);
  });

  r.post(`${P}/txn/:id/transform/:target`, async (ctx) => {
    const target = String(ctx.params.target).toUpperCase();
    requirePerm(ctx, T.PERM_FOR[target], LEVEL.CREATE);
    return ctx.tx(() => {
      const created = T.transform(ctx.repo, ctx.params.id, target, ctx.body || {});
      withWorkflows(ctx.repo, T.PERM_FOR[target], 'after_create', created, null, null);
      return created;
    });
  });

  r.post(`${P}/payments`, async (ctx) => {
    const type = String(ctx.body?.type || 'CUSTOMER_PAYMENT').toUpperCase();
    requirePerm(ctx, T.PERM_FOR[type], LEVEL.CREATE);
    return ctx.tx(() => T.createPayment(ctx.repo, type, ctx.body || {}));
  });

  r.post(`${P}/payments/:id/unapply`, async (ctx) => {
    const t = T.requireTxn(ctx.repo, ctx.params.id);
    requirePerm(ctx, T.PERM_FOR[t.type], LEVEL.FULL);
    if (!ctx.body.txn_id) throw badRequest('Say which document to unapply the payment from (txn_id).');
    return ctx.tx(() => T.unapplyPayment(ctx.repo, ctx.params.id, ctx.body.txn_id));
  });

  r.get(`${P}/entities/:entityType/:id/open-documents`, async (ctx) =>
    T.openDocumentsFor(ctx.repo, ctx.params.entityType, ctx.params.id));

  r.get(`${P}/entities/customer/:id/credit`, async (ctx) => entities.customerFinancials(ctx.repo, ctx.params.id));

  r.post(`${P}/pricing/quote`, async (ctx) => {
    rbac.require$(ctx.access, 'item', LEVEL.VIEW);
    const { item_id, customer_id, quantity, currency, price_level_id } = ctx.body || {};
    const item = inv.getItem(ctx.repo, item_id);
    const customer = customer_id ? entities.getCustomer(ctx.repo, customer_id) : null;
    const qty = Qty.parse(quantity ?? 1);
    const base = T.priceFor(ctx.repo, { item, customer, quantity: qty, currency, price_level_id });
    const ruled = T.applyPricingRules(ctx.repo, { item, customer, line: {}, txn: { txn_date: today() }, unit_price: base, quantity: qty });
    return { item_id, base_price: item.base_price, list_price: base, unit_price: ruled.unit_price, discount_pct: ruled.discount_pct, applied_rules: ruled.applied };
  });

  // ------------------------------------------------------------ inventory
  r.get(`${P}/inventory/availability/:itemId`, async (ctx) => {
    rbac.require$(ctx.access, 'item', LEVEL.VIEW);
    return inv.availability(ctx.repo, ctx.params.itemId);
  });

  r.get(`${P}/inventory/reorder`, async (ctx) => {
    rbac.require$(ctx.access, 'item', LEVEL.VIEW);
    return { suggestions: inv.reorderAnalysis(ctx.repo, { locationId: ctx.query.location_id || null, lookbackDays: int(ctx.query.lookback, 90) }) };
  });

  r.get(`${P}/inventory/valuation`, async (ctx) => {
    rbac.require$(ctx.access, 'item', LEVEL.VIEW);
    return inv.valuation(ctx.repo, { locationId: ctx.query.location_id || null, asOf: ctx.query.as_of || null });
  });

  r.post(`${P}/inventory/levels`, async (ctx) => {
    rbac.require$(ctx.access, 'item', LEVEL.EDIT);
    const { item_id, location_id, reorder_point, preferred_stock_level, safety_stock, lead_time_days, bin } = ctx.body || {};
    if (!item_id || !location_id) throw new ValidationError({
      ...(item_id ? {} : { item_id: 'Item is required' }),
      ...(location_id ? {} : { location_id: 'Location is required' }),
    });
    return ctx.tx(() => {
      inv.position(ctx.repo, item_id, location_id);
      ctx.repo.exec(`UPDATE item_location SET reorder_point = ?, preferred_stock_level = ?, safety_stock = ?, lead_time_days = ?, bin = ?
          WHERE tenant_id = :t AND item_id = ? AND location_id = ?`,
        [Qty.parse(reorder_point ?? 0), Qty.parse(preferred_stock_level ?? 0), Qty.parse(safety_stock ?? 0),
          int(lead_time_days, 0), bin || '', item_id, location_id]);
      audit.record(ctx.repo, { recordType: 'item', recordId: item_id, action: 'set_levels', changes: { location: { from: null, to: location_id } } });
      return inv.availability(ctx.repo, item_id);
    });
  });

  r.post(`${P}/inventory/reorder/create-pos`, async (ctx) => {
    rbac.require$(ctx.access, 'purchase_order', LEVEL.CREATE);
    const picks = ctx.body?.suggestions || [];
    return ctx.tx(() => {
      const byVendor = {};
      for (const s of picks) {
        const vendorId = s.preferred_vendor_id || ctx.body.vendor_id;
        if (!vendorId) throw unprocessable(`No vendor for ${s.sku}. Set a preferred vendor on the item, or choose one for the whole run.`);
        (byVendor[`${vendorId}|${s.location_id}`] ||= { vendorId, locationId: s.location_id, lines: [] })
          .lines.push({ item_id: s.item_id, quantity: Qty.toNumber(s.suggested_qty) });
      }
      const created = [];
      for (const g of Object.values(byVendor)) {
        created.push(T.createTxn(ctx.repo, 'PURCHASE_ORDER', {
          entity_id: g.vendorId, location_id: g.locationId, txn_date: today(),
          memo: 'Generated from reorder analysis', lines: g.lines,
        }));
      }
      return { created: created.map((c) => ({ id: c.id, txn_no: c.txn_no, total: c.total, entity_id: c.entity_id })) };
    });
  });

  // ------------------------------------------------------------------ CRM
  r.get(`${P}/crm/pipeline`, async (ctx) => {
    rbac.require$(ctx.access, 'opportunity', LEVEL.VIEW);
    const ownerId = ctx.access.restrictions?.owner?.ownOnly ? ctx.user.id : (ctx.query.owner_id || null);
    return { stages: crm.pipeline(ctx.repo, { ownerId, subsidiaryId: ctx.query.subsidiary_id || null }) };
  });

  r.get(`${P}/crm/forecast`, async (ctx) => {
    rbac.require$(ctx.access, 'opportunity', LEVEL.VIEW);
    const ownerId = ctx.access.restrictions?.owner?.ownOnly ? ctx.user.id : (ctx.query.owner_id || null);
    return { ...crm.forecast(ctx.repo, { from: ctx.query.from, to: ctx.query.to, ownerId }), metrics: crm.salesMetrics(ctx.repo, { days: int(ctx.query.days, 180) }) };
  });

  r.post(`${P}/crm/leads/:id/convert`, async (ctx) => {
    rbac.require$(ctx.access, 'lead', LEVEL.EDIT);
    rbac.require$(ctx.access, 'customer', LEVEL.CREATE);
    return ctx.tx(() => crm.convertLead(ctx.repo, ctx.params.id, ctx.body || {}));
  });

  r.get(`${P}/crm/support/metrics`, async (ctx) => {
    rbac.require$(ctx.access, 'support_case', LEVEL.VIEW);
    return crm.supportMetrics(ctx.repo);
  });

  r.post(`${P}/crm/cases/:id/messages`, async (ctx) => {
    rbac.require$(ctx.access, 'support_case', LEVEL.EDIT);
    return ctx.tx(() => crm.addCaseMessage(ctx.repo, ctx.params.id, {
      body: ctx.body?.body, internal: bool(ctx.body?.internal),
      authorType: ctx.body?.author_type || 'agent',
    }));
  });

  // ------------------------------------------------------------------- HR
  r.get(`${P}/hr/directory`, async (ctx) => {
    rbac.require$(ctx.access, 'employee', LEVEL.VIEW);
    return {
      employees: hr.directory(ctx.repo, {
        search: ctx.query.q || null, departmentId: ctx.query.department_id || null,
        managerId: ctx.query.manager_id || null, status: ctx.query.status || 'active',
      }),
      metrics: hr.headcountMetrics(ctx.repo),
    };
  });

  r.get(`${P}/hr/orgchart`, async (ctx) => {
    rbac.require$(ctx.access, 'employee', LEVEL.VIEW);
    return { roots: hr.orgChart(ctx.repo) };
  });

  r.get(`${P}/hr/timesheet/:employeeId`, async (ctx) => {
    rbac.require$(ctx.access, 'time_entry', LEVEL.VIEW);
    return hr.timesheet(ctx.repo, ctx.params.employeeId, ctx.query.week_start || today());
  });

  r.post(`${P}/hr/time/approve`, async (ctx) => {
    rbac.require$(ctx.access, 'time_entry', LEVEL.FULL);
    return ctx.tx(() => ({ updated: hr.approveTime(ctx.repo, ctx.body?.ids || [], { approve: ctx.body?.approve !== false }) }));
  });

  r.post(`${P}/hr/timeoff/:id/decide`, async (ctx) => {
    rbac.require$(ctx.access, 'time_off', LEVEL.FULL);
    return ctx.tx(() => hr.decideTimeOff(ctx.repo, ctx.params.id, ctx.body?.approve !== false));
  });

  r.post(`${P}/hr/payroll/calculate`, async (ctx) => {
    rbac.require$(ctx.access, 'payroll_run', LEVEL.CREATE);
    return ctx.tx(() => hr.calculatePayroll(ctx.repo, ctx.body || {}));
  });

  r.get(`${P}/hr/payroll/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'payroll_run', LEVEL.VIEW);
    const run = hr.getPayrollRun(ctx.repo, ctx.params.id);
    if (!run) throw notFound('Payroll run not found');
    return run;
  });

  r.post(`${P}/hr/payroll/:id/approve`, async (ctx) => {
    rbac.require$(ctx.access, 'payroll_run', LEVEL.FULL);
    return ctx.tx(() => hr.approvePayroll(ctx.repo, ctx.params.id));
  });

  r.post(`${P}/hr/payroll/:id/export`, async (ctx) => {
    rbac.require$(ctx.access, 'payroll_run', LEVEL.FULL);
    return ctx.tx(() => hr.exportPayroll(ctx.repo, ctx.params.id, ctx.body || {}));
  });

  // -------------------------------------------------------------- reports
  const reportGuard = (ctx) => rbac.require$(ctx.access, 'account', LEVEL.VIEW);

  r.get(`${P}/reports/dashboard`, async (ctx) => reports.dashboard(ctx.repo, { subsidiaryId: ctx.query.subsidiary_id || null }));
  r.get(`${P}/reports/trial-balance`, async (ctx) => { reportGuard(ctx); return reports.trialBalance(ctx.repo, { from: ctx.query.from, to: ctx.query.to, subsidiaryId: ctx.query.subsidiary_id || null, bookId: ctx.query.book_id || null }); });
  r.get(`${P}/reports/income-statement`, async (ctx) => { reportGuard(ctx); return reports.incomeStatement(ctx.repo, { from: ctx.query.from, to: ctx.query.to, subsidiaryId: ctx.query.subsidiary_id || null, compareFrom: ctx.query.compare_from, compareTo: ctx.query.compare_to, bookId: ctx.query.book_id || null }); });
  r.get(`${P}/reports/balance-sheet`, async (ctx) => { reportGuard(ctx); return reports.balanceSheet(ctx.repo, { asOf: ctx.query.as_of, subsidiaryId: ctx.query.subsidiary_id || null, bookId: ctx.query.book_id || null }); });
  r.get(`${P}/reports/cash-flow`, async (ctx) => { reportGuard(ctx); return reports.cashFlow(ctx.repo, { from: ctx.query.from, to: ctx.query.to, subsidiaryId: ctx.query.subsidiary_id || null }); });
  r.get(`${P}/reports/ar-aging`, async (ctx) => reports.arAging(ctx.repo, { asOf: ctx.query.as_of, subsidiaryId: ctx.query.subsidiary_id || null }));
  r.get(`${P}/reports/ap-aging`, async (ctx) => reports.apAging(ctx.repo, { asOf: ctx.query.as_of, subsidiaryId: ctx.query.subsidiary_id || null }));
  r.get(`${P}/reports/revenue-trend`, async (ctx) => ({ months: reports.revenueByMonth(ctx.repo, { months: int(ctx.query.months, 12) }) }));
  r.get(`${P}/reports/top-customers`, async (ctx) => ({ rows: reports.topCustomers(ctx.repo, { limit: int(ctx.query.limit, 10), days: int(ctx.query.days, 365) }) }));
  r.get(`${P}/reports/top-items`, async (ctx) => ({ rows: reports.topItems(ctx.repo, { limit: int(ctx.query.limit, 10), days: int(ctx.query.days, 365) }) }));
  r.get(`${P}/reports/integrity`, async (ctx) => { reportGuard(ctx); return gl.integrityCheck(ctx.repo); });
  r.get(`${P}/reports/drilldown/:metric`, async (ctx) => ({ rows: reports.drillDown(ctx.repo, ctx.params.metric, {}) }));

  // ----------------------------------------------------------------- bank
  r.get(`${P}/bank/accounts`, async (ctx) => { rbac.require$(ctx.access, 'bank_account', LEVEL.VIEW); return { accounts: bank.listBankAccounts(ctx.repo), position: bank.cashPosition(ctx.repo) }; });
  r.get(`${P}/bank/:id/transactions`, async (ctx) => {
    rbac.require$(ctx.access, 'bank_txn', LEVEL.VIEW);
    return ctx.repo.query(`SELECT bt.*, je.entry_no FROM bank_txn bt
        LEFT JOIN journal_entry je ON je.tenant_id = bt.tenant_id AND je.id = bt.matched_journal_id
        WHERE bt.tenant_id = :t AND bt.bank_account_id = ? ORDER BY bt.txn_date DESC LIMIT ?`,
      [ctx.params.id, int(ctx.query.limit, 200)]);
  });
  r.post(`${P}/bank/:id/import`, async (ctx) => {
    rbac.require$(ctx.access, 'bank_txn', LEVEL.CREATE);
    const lines = typeof ctx.body === 'string' ? bank.parseStatementCsv(ctx.body) : (ctx.body?.lines || bank.parseStatementCsv(ctx.body?.csv || ''));
    return ctx.tx(() => bank.importStatement(ctx.repo, ctx.params.id, lines, { source: ctx.body?.source || 'upload' }));
  });
  r.get(`${P}/bank/:id/suggest`, async (ctx) => { rbac.require$(ctx.access, 'bank_txn', LEVEL.VIEW); return bank.suggestMatches(ctx.repo, ctx.params.id, { autoApply: false }); });
  r.post(`${P}/bank/:id/auto-match`, async (ctx) => { rbac.require$(ctx.access, 'bank_txn', LEVEL.EDIT); return ctx.tx(() => bank.suggestMatches(ctx.repo, ctx.params.id, { autoApply: true })); });
  r.post(`${P}/bank/match`, async (ctx) => {
    rbac.require$(ctx.access, 'bank_txn', LEVEL.EDIT);
    if (!ctx.body.bank_txn_id || !ctx.body.journal_entry_id) throw badRequest('A bank line and a journal entry are both required to match.');
    return ctx.tx(() => bank.applyMatch(ctx.repo, ctx.body.bank_txn_id, ctx.body.journal_entry_id));
  });
  r.post(`${P}/bank/unmatch`, async (ctx) => {
    rbac.require$(ctx.access, 'bank_txn', LEVEL.EDIT);
    if (!ctx.body.bank_txn_id) throw badRequest('Say which bank line to unmatch (bank_txn_id).');
    return ctx.tx(() => bank.unmatch(ctx.repo, ctx.body.bank_txn_id));
  });
  r.post(`${P}/bank/reconciliations`, async (ctx) => { rbac.require$(ctx.access, 'reconciliation', LEVEL.CREATE); return ctx.tx(() => bank.startReconciliation(ctx.repo, ctx.body || {})); });
  r.get(`${P}/bank/reconciliations/:id`, async (ctx) => bank.reconciliationState(ctx.repo, ctx.params.id));
  r.post(`${P}/bank/reconciliations/:id/select`, async (ctx) => {
    rbac.require$(ctx.access, 'reconciliation', LEVEL.EDIT);
    return ctx.tx(() => bank.setReconciled(ctx.repo, ctx.params.id, rowList(ctx.body?.ids, 'ids')));
  });
  r.post(`${P}/bank/reconciliations/:id/complete`, async (ctx) => { rbac.require$(ctx.access, 'reconciliation', LEVEL.FULL); return ctx.tx(() => bank.completeReconciliation(ctx.repo, ctx.params.id, { force: bool(ctx.body?.force) })); });

  // ------------------------------------------------------------- platform
  r.post(`${P}/search`, async (ctx) => {
    const { record_type, definition, limit, offset } = ctx.body || {};
    requirePerm(ctx, record_type, LEVEL.VIEW);
    return platform.runSearch(ctx.repo, record_type, definition || {}, { access: ctx.access, limit: int(limit, 100), offset: int(offset, 0) });
  });

  r.get(`${P}/search/global`, async (ctx) => ({
    results: searchIdx.search(ctx.repo, ctx.query.q, { limit: int(ctx.query.limit, 25) })
      .filter((hit) => {
        const permType = hit.type === 'txn' ? 'invoice' : hit.type;
        return rbac.can(ctx.access, meta.getMeta(permType)?.permission || permType, LEVEL.VIEW);
      }),
  }));

  r.get(`${P}/saved-searches`, async (ctx) => ctx.repo.query(
    `SELECT * FROM saved_search WHERE tenant_id = :t AND (is_public = 1 OR owner_id = ?) ORDER BY record_type, name`, [ctx.user.id]));

  r.post(`${P}/workflows/:id/test`, async (ctx) => {
    rbac.require$(ctx.access, 'workflow', LEVEL.EDIT);
    return platform.testWorkflow(ctx.repo, ctx.params.id, ctx.body?.record_id);
  });

  r.post(`${P}/expressions/validate`, async (ctx) => {
    const v = validateExpr(ctx.body?.expression || '');
    let sample = null;
    if (v.ok && ctx.body?.scope) sample = evalSafe(ctx.body.expression, ctx.body.scope, null);
    return { ...v, sample };
  });

  r.get(`${P}/audit`, async (ctx) => {
    rbac.require$(ctx.access, 'audit_event', LEVEL.VIEW);
    const where = []; const params = [];
    if (ctx.query.record_type) { where.push('record_type = ?'); params.push(ctx.query.record_type); }
    if (ctx.query.record_id) { where.push('record_id = ?'); params.push(ctx.query.record_id); }
    if (ctx.query.user_id) { where.push('user_id = ?'); params.push(ctx.query.user_id); }
    if (ctx.query.action) { where.push('action = ?'); params.push(ctx.query.action); }
    if (bool(ctx.query.financial)) where.push('financial = 1');
    if (ctx.query.from) { where.push('at >= ?'); params.push(ctx.query.from); }
    if (ctx.query.to) { where.push('at <= ?'); params.push(ctx.query.to + 'T23:59:59Z'); }
    const w = where.length ? ' AND ' + where.join(' AND ') : '';
    return {
      rows: ctx.repo.query(`SELECT * FROM audit_event WHERE tenant_id = :t${w} ORDER BY at DESC LIMIT ? OFFSET ?`,
        [...params, int(ctx.query.limit, 100), int(ctx.query.offset, 0)]),
      total: ctx.repo.scalar(`SELECT COUNT(*) c FROM audit_event WHERE tenant_id = :t${w}`, params, 0),
    };
  });

  r.get(`${P}/notifications`, async (ctx) => ({
    rows: platform.listNotifications(ctx.repo, ctx.user.id, { unreadOnly: bool(ctx.query.unread), limit: int(ctx.query.limit, 50) }),
    unread: ctx.repo.scalar('SELECT COUNT(*) c FROM notification WHERE tenant_id = :t AND (user_id = ? OR user_id IS NULL) AND read_at IS NULL', [ctx.user.id], 0),
  }));
  r.post(`${P}/notifications/read`, async (ctx) => ctx.tx(() => ({
    updated: ctx.body?.id ? platform.markNotificationRead(ctx.repo, ctx.body.id, ctx.user.id) : platform.markAllRead(ctx.repo, ctx.user.id),
  })));

  // ---------------------------------------------------------- dashboards
  r.get(`${P}/dashboards`, async (ctx) => {
    const mine = ctx.repo.queryOne('SELECT * FROM dashboard WHERE tenant_id = :t AND user_id = ? LIMIT 1', [ctx.user.id]);
    return mine || ctx.repo.queryOne('SELECT * FROM dashboard WHERE tenant_id = :t AND user_id IS NULL LIMIT 1') || { layout: null };
  });
  r.put(`${P}/dashboards`, async (ctx) => ctx.tx(() => {
    const existing = ctx.repo.queryOne('SELECT * FROM dashboard WHERE tenant_id = :t AND user_id = ? LIMIT 1', [ctx.user.id]);
    if (existing) ctx.repo.update('dashboard', existing.id, { layout: ctx.body?.layout || [], updated_at: nowIso() });
    else ctx.repo.insert('dashboard', { id: ulid(), user_id: ctx.user.id, name: 'Home', layout: ctx.body?.layout || [], updated_at: nowIso() });
    return { ok: true };
  }));

  // ------------------------------------------------------------- setup
  r.get(`${P}/setup/roles`, async (ctx) => {
    rbac.require$(ctx.access, 'role', LEVEL.VIEW);
    const roles = ctx.repo.find('role', { order: 'name' });
    for (const role of roles) {
      role.permissions = Object.fromEntries(ctx.repo.query('SELECT record_type, level FROM permission WHERE tenant_id = :t AND role_id = ?', [role.id]).map((p) => [p.record_type, p.level]));
      role.restrictions = ctx.repo.query('SELECT * FROM role_restriction WHERE tenant_id = :t AND role_id = ?', [role.id]);
      role.user_count = ctx.repo.scalar('SELECT COUNT(*) c FROM user_role WHERE tenant_id = :t AND role_id = ?', [role.id], 0);
    }
    return { roles, record_types: rbac.RECORD_TYPES, levels: rbac.LEVEL_NAMES };
  });

  r.put(`${P}/setup/roles/:id/permissions`, async (ctx) => {
    rbac.require$(ctx.access, 'role', LEVEL.FULL);
    return ctx.tx(() => {
      const role = ctx.repo.get('role', ctx.params.id);
      if (!role) throw notFound('Role not found');
      const before = ctx.repo.query('SELECT record_type, level FROM permission WHERE tenant_id = :t AND role_id = ?', [ctx.params.id]);
      ctx.repo.exec('DELETE FROM permission WHERE tenant_id = :t AND role_id = ?', [ctx.params.id]);
      for (const [recordType, level] of Object.entries(ctx.body?.permissions || {})) {
        if (!rbac.ALL_RECORD_TYPES.includes(recordType)) continue;
        const lvl = int(level, 0);
        if (lvl > 0) ctx.repo.exec('INSERT INTO permission (tenant_id, role_id, record_type, level) VALUES (:t,?,?,?)', [ctx.params.id, recordType, Math.min(lvl, 4)]);
      }
      audit.record(ctx.repo, { recordType: 'role', recordId: ctx.params.id, action: 'permissions_change', changes: { before: { from: before.length, to: Object.keys(ctx.body?.permissions || {}).length } } });
      return { ok: true };
    });
  });

  r.get(`${P}/setup/users`, async (ctx) => {
    rbac.require$(ctx.access, 'app_user', LEVEL.VIEW);
    const users = ctx.repo.query('SELECT id, name, email, status, is_owner, last_login_at, created_at FROM app_user WHERE tenant_id = :t ORDER BY name');
    for (const u of users) u.roles = ctx.repo.query('SELECT r.id, r.name FROM user_role ur JOIN role r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id WHERE ur.tenant_id = :t AND ur.user_id = ?', [u.id]);
    return { users };
  });

  r.post(`${P}/setup/users`, async (ctx) => {
    rbac.require$(ctx.access, 'app_user', LEVEL.CREATE);
    const { email, name, password, role_ids = [] } = ctx.body || {};
    const problems = auth.passwordProblems(password);
    if (problems.length) throw new ValidationError({ password: `Password ${problems.join(', ')}` });
    if (!email || !name) throw new ValidationError({ email: !email ? 'Email is required' : undefined, name: !name ? 'Name is required' : undefined });
    return ctx.tx(() => {
      if (ctx.repo.queryOne('SELECT id FROM app_user WHERE tenant_id = :t AND lower(email) = lower(?)', [email])) {
        throw new ValidationError({ email: 'A user with that email already exists' });
      }
      const { hash, salt } = auth.hashPassword(password);
      const now = nowIso();
      const id = ctx.repo.insert('app_user', {
        id: ulid(), email, name, password_hash: hash, password_salt: salt, status: 'active',
        is_owner: 0, locale: 'en-US', timezone: 'UTC', created_at: now, updated_at: now,
      });
      for (const rid of role_ids) ctx.repo.exec('INSERT INTO user_role (tenant_id, user_id, role_id) VALUES (:t,?,?)', [id, rid]);
      audit.record(ctx.repo, { recordType: 'app_user', recordId: id, action: 'create', changes: { email: { from: null, to: email }, roles: { from: null, to: role_ids.length } } });
      return { id, email, name };
    });
  });

  r.put(`${P}/setup/users/:id/roles`, async (ctx) => {
    rbac.require$(ctx.access, 'app_user', LEVEL.FULL);
    return ctx.tx(() => {
      ctx.repo.exec('DELETE FROM user_role WHERE tenant_id = :t AND user_id = ?', [ctx.params.id]);
      for (const rid of ctx.body?.role_ids || []) ctx.repo.exec('INSERT INTO user_role (tenant_id, user_id, role_id) VALUES (:t,?,?)', [ctx.params.id, rid]);
      audit.record(ctx.repo, { recordType: 'app_user', recordId: ctx.params.id, action: 'roles_change' });
      return { ok: true };
    });
  });

  r.get(`${P}/setup/company`, async (ctx) => ({
    tenant: ctx.tenant,
    subsidiaries: ctx.repo.find('subsidiary', { order: 'name' }),
    currencies: ctx.repo.query('SELECT * FROM currency WHERE tenant_id = :t ORDER BY code'),
    periods: ctx.repo.find('accounting_period', { order: 'start_date DESC', limit: 36 }),
    counts: {
      customers: ctx.repo.count('customer'), vendors: ctx.repo.count('vendor'),
      items: ctx.repo.count('item'), employees: ctx.repo.count('employee'),
      transactions: ctx.repo.count('txn'), journal_entries: ctx.repo.count('journal_entry'),
      users: ctx.repo.count('app_user'),
    },
  }));

  // ------------------------------------------------- how this copy runs
  // The connection settings live in a file rather than the database, because
  // they have to be readable before there is a database to read: which mode
  // this copy runs in, and — if it is a client of a server elsewhere — where
  // that server is. Only an owner may change them, and the change takes
  // effect when the application next starts.
  r.get(`${P}/settings/connection`, async (ctx) => {
    rbac.require$(ctx.access, 'setup', LEVEL.VIEW);
    const current = appconfig.readConfig(config.configDir);
    return {
      mode: current.mode,
      remote: current.remote,
      server: { ...current.server, tls: { cert: current.server.tls.cert, key: current.server.tls.key } },
      window: current.window,
      file: current.$file,
      exists: current.$exists,
      problem: current.$problem,
      // What this process is actually doing right now, which is not always
      // what the file says: a flag on the command line wins over it.
      running: {
        mode: config.serverMode ? 'server' : 'local',
        host: config.host,
        port: config.port,
        tls: !!config.tls,
        data_dir: config.dataDir,
        version: config.version,
        addresses: config.serverMode ? desktop.lanAddresses(config.port, !!config.tls) : [],
      },
    };
  });

  r.put(`${P}/settings/connection`, async (ctx) => {
    if (!ctx.user?.is_owner) throw forbidden('Only the account owner can change how this copy connects.');
    const body = ctx.body || {};
    const patch = {};
    if (body.mode !== undefined) {
      if (!['local', 'remote', 'server'].includes(body.mode)) {
        throw new ValidationError({ mode: 'Choose local, remote or server' });
      }
      patch.mode = body.mode;
    }
    if (body.remote !== undefined) {
      const url = String(body.remote.url || '').trim().replace(/\/+$/, '');
      if (patch.mode === 'remote' || (body.mode === undefined && body.remote.url)) {
        const problem = appconfig.validateRemote(url);
        if (problem) throw new ValidationError({ 'remote.url': problem });
      }
      patch.remote = { url, verify_tls: body.remote.verify_tls !== false };
    }
    if (body.server !== undefined) {
      const port = Number(body.server.port);
      if (body.server.port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
        throw new ValidationError({ 'server.port': 'Enter a port between 1 and 65535' });
      }
      patch.server = {
        host: body.server.host || '0.0.0.0',
        port: Number.isInteger(port) ? port : undefined,
        trust_proxy: !!body.server.trust_proxy,
        tls: { cert: body.server.tls?.cert || '', key: body.server.tls?.key || '' },
      };
      if (patch.server.port === undefined) delete patch.server.port;
    }
    const saved = appconfig.writeConfig(patch, config.configDir);
    audit.record(ctx.repo, {
      recordType: 'setup', recordId: null, action: 'connection',
      changes: { mode: { from: null, to: saved.mode }, file: { from: null, to: saved.$file } },
    });
    return { ok: true, mode: saved.mode, file: saved.$file, restart_required: true };
  });

  // ------------------------------------------------------- API tokens
  // Power BI, Excel and the ODBC/JDBC bridges all authenticate with Basic
  // auth, so a long-lived token is the only way a BI tool can refresh a
  // dataset unattended. The secret is shown exactly once, at creation.
  r.get(`${P}/setup/api-tokens`, async (ctx) => {
    rbac.require$(ctx.access, 'app_user', LEVEL.VIEW);
    return {
      tokens: ctx.repo.query(
        `SELECT t.id, t.name, t.prefix, t.scopes, t.created_at, t.expires_at, t.last_used_at, t.revoked_at,
                u.name AS user_name
         FROM api_token t JOIN app_user u ON u.tenant_id = t.tenant_id AND u.id = t.user_id
         WHERE t.tenant_id = :t ORDER BY t.revoked_at IS NOT NULL, t.created_at DESC`),
    };
  });

  r.post(`${P}/setup/api-tokens`, async (ctx) => {
    rbac.require$(ctx.access, 'app_user', LEVEL.CREATE);
    const { name, expires_at = null, scopes = ['*'] } = ctx.body || {};
    if (!name || !String(name).trim()) throw new ValidationError({ name: 'Give the token a name so you can recognise it later' });
    if (expires_at && !/^\d{4}-\d{2}-\d{2}$/.test(expires_at)) throw new ValidationError({ expires_at: 'Use YYYY-MM-DD' });
    return ctx.tx(() => {
      // A token inherits the permissions of the user who created it, so it can
      // never read more than that person can.
      const issued = auth.issueApiToken(ctx.repo.db, {
        tenantId: ctx.tenant.id, userId: ctx.user.id, name: String(name).trim(),
        scopes: Array.isArray(scopes) && scopes.length ? scopes : ['*'],
        expiresAt: expires_at ? `${expires_at}T23:59:59.999Z` : null,
      });
      audit.record(ctx.repo, {
        recordType: 'api_token', recordId: issued.id, action: 'create',
        after: { name, prefix: issued.prefix, scopes },
      });
      return { id: issued.id, name, prefix: issued.prefix, token: issued.token, expires_at,
        note: 'Copy this token now -- it is not stored and cannot be shown again.' };
    });
  });

  r.delete(`${P}/setup/api-tokens/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'app_user', LEVEL.FULL);
    return ctx.tx(() => {
      const row = ctx.repo.get('api_token', ctx.params.id);
      if (!row) throw notFound('Token not found');
      if (row.revoked_at) return { revoked: true, already: true };
      ctx.repo.update('api_token', ctx.params.id, { revoked_at: nowIso() });
      audit.record(ctx.repo, { recordType: 'api_token', recordId: ctx.params.id, action: 'delete', before: { name: row.name } });
      return { revoked: true };
    });
  });

  r.get(`${P}/setup/integration-events`, async (ctx) => ({
    rows: ctx.repo.query('SELECT * FROM integration_event WHERE tenant_id = :t ORDER BY created_at DESC LIMIT 100'),
  }));

  // Assets, budgeting, consolidation, projects, manufacturing, warehousing,
  // planning, service, commerce and workforce live in their own file.
  registerOpsRoutes(r, P);
  // Import, export, bank statement files and the Power BI connection helper.
  registerDataRoutes(r, P);
  // The OData feed sits at its own root, because BI tools expect a service
  // document at the address you hand them.
  registerODataRoutes(r);
  // SuiteTalk-style SOAP, likewise at its own root so the WSDL's endpoint and
  // the address integrators are given are the same string.
  registerSoapRoutes(r);

  return r;
}
