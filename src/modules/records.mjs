// Meridian ERP :: modules/records
// The single create/update path for record types. The REST API and the CSV
// importer both come through here, so an imported customer is numbered,
// validated and audited exactly like one typed into the UI -- the two used to
// diverge, and imported rows arrived without their entity number.
import { badRequest, notFound, ValidationError } from '../core/http.mjs';
import { Money, Qty, ulid, nowIso, safeJson } from '../core/util.mjs';
import * as audit from '../core/audit.mjs';
import * as meta from './meta.mjs';
import * as gl from './gl.mjs';
import * as recurring from './recurring.mjs';
import * as inv from './inventory.mjs';
import * as entities from './entities.mjs';
import * as T from './txn.mjs';
import * as crm from './crm.mjs';
import * as hr from './hr.mjs';
import * as platform from './platform.mjs';
import * as schedules from './schedules.mjs';
import * as customRecords from './customrecords.mjs';

// Coercion lives with the metadata that describes it; re-exported here
// because the API and the importer have always reached for it through this
// module. `export { coerce } from './meta.mjs'` alone does NOT bind a local
// `coerce` -- it only forwards the name to whoever imports it from here --
// so genericCreate/genericUpdate's own calls below need the import too.
import { coerce } from './meta.mjs';
export { coerce };

/** Module-specific create/update handlers; anything absent uses the generic path. */
export const HANDLERS = {
  customer: { create: entities.createCustomer, update: entities.updateCustomer },
  vendor: { create: entities.createVendor, update: entities.updateVendor },
  contact: { create: entities.createContact, update: entities.updateContact, remove: entities.deleteContact },
  item: { create: inv.createItem, update: inv.updateItem },
  account: { create: gl.createAccount, update: gl.updateAccount },
  journal_entry: { remove: gl.deleteJournalEntry },
  recurring_journal: { create: recurring.createRecurring, update: recurring.updateRecurring, remove: recurring.deleteRecurring },
  lead: { create: crm.createLead, update: crm.updateLead },
  opportunity: { create: crm.createOpportunity, update: crm.updateOpportunity },
  activity: { create: crm.createActivity, update: crm.updateActivity },
  support_case: { create: crm.createCase, update: crm.updateCase },
  employee: { create: hr.createEmployee, update: hr.updateEmployee },
  time_entry: { create: hr.logTime },
  time_off: { create: hr.requestTimeOff },
  custom_field: { create: platform.createCustomField, update: platform.updateCustomField, remove: platform.deleteCustomField },
  schedule_template: { create: schedules.createTemplate, update: schedules.updateTemplate },
  workflow: { create: platform.createWorkflow, update: platform.updateWorkflow },
  saved_search: { create: platform.saveSearch, update: platform.updateSavedSearch },
};

/**
 * Has this record already moved money or stock?
 *
 * Every module stamps what it posted with its own source, so one pair of
 * questions answers it for all of them. A few name the event rather than the
 * record — a payroll run posts "payroll" — so those get an alias. Asked before
 * anything is destroyed, whether that is a user pressing delete or an import
 * being reversed.
 */
const POSTED_SOURCE_ALIASES = {
  payroll_run: ['payroll'],
  fixed_asset: ['depreciation', 'asset_disposal'],
  recurring_journal: ['recurring', 'accrual'],
  revaluation_run: ['revaluation'],
};

export function postedHistoryFor(repo, type, id) {
  const sources = [type, ...(POSTED_SOURCE_ALIASES[type] || [])];
  const ph = sources.map(() => '?').join(',');
  const entries = repo.scalar(
    `SELECT COUNT(*) c FROM journal_entry WHERE tenant_id = :t AND source_type IN (${ph}) AND source_id = ?`,
    [...sources, id], 0);
  if (entries > 0) {
    return `${entries} journal entr${entries === 1 ? 'y has' : 'ies have'} been posted from it`;
  }
  const moves = repo.scalar(
    `SELECT COUNT(*) c FROM inventory_txn WHERE tenant_id = :t AND source_type IN (${ph}) AND source_id = ?`,
    [...sources, id], 0);
  if (moves > 0) return `${moves} stock movement${moves === 1 ? '' : 's'} came from it`;

  // A transaction records its own posting on the row rather than by source.
  const m = meta.getMeta(type);
  if (m?.isTransaction) {
    const t = repo.get('txn', id);
    if (t?.posted) return 'it is posted to the ledger; void it instead';
  }
  return null;
}

/**
 * Why this record cannot simply be destroyed, or null if it can be. One place
 * answers the question, so a delete button, an import rollback and anything
 * else that removes rows all agree about what is safe to remove.
 */
export function blockersFor(repo, type, id) {
  // Nothing that has already moved money or stock can be destroyed, whatever
  // kind of record it is.
  const postedHistory = postedHistoryFor(repo, type, id);
  if (postedHistory) return postedHistory;

  // A few records carry an obligation the moment they leave their opening
  // state, without anything else pointing at them to say so.
  const SETTLED_BEYOND = {
    commission: 'accrued',
    cart: 'open',
    demand_plan: 'draft',
    budget: 'draft',
    review_cycle: 'draft',
  };
  if (SETTLED_BEYOND[type]) {
    const m = meta.getMeta(type);
    const row = m && repo.get(m.table, id);
    if (row && row.status && row.status !== SETTLED_BEYOND[type]) {
      return `it is ${String(row.status).replace(/_/g, ' ')} rather than ${SETTLED_BEYOND[type]}`;
    }
  }

  const checks = {
    customer: [['txn', 'entity_id', 'transaction'], ['opportunity', 'customer_id', 'opportunity'], ['support_case', 'customer_id', 'case']],
    vendor: [['txn', 'entity_id', 'transaction']],
    item: [['txn_line', 'item_id', 'transaction line'], ['inventory_txn', 'item_id', 'stock movement']],
    employee: [['txn', 'sales_rep_id', 'transaction'], ['time_entry', 'employee_id', 'time entry', 'time entries'], ['payroll_line', 'employee_id', 'payroll line']],
    account: [['journal_line', 'account_id', 'journal line']],
    accounting_period: [['journal_entry', 'period_id', 'journal entry', 'journal entries'], ['txn', 'period_id', 'transaction']],
    fixed_asset: [['depreciation_line', 'asset_id', 'depreciation charge']],
    project: [['txn', 'project_id', 'transaction'], ['time_entry', 'project_id', 'time entry', 'time entries'], ['expense_line', 'project_id', 'expense line']],
    bom: [['work_order', 'bom_id', 'work order']],
    work_center: [['routing_step', 'work_center_id', 'routing step'], ['work_order_operation', 'work_center_id', 'operation']],
    campaign: [['opportunity', 'campaign_id', 'opportunity'], ['lead', 'campaign_id', 'lead']],
    partner: [['txn', 'partner_id', 'transaction'], ['commission', 'partner_id', 'commission']],
    sales_channel: [['channel_listing', 'channel_id', 'listing'], ['cart', 'channel_id', 'cart'], ['txn', 'channel_id', 'transaction']],
    service_contract: [['service_order', 'contract_id', 'service order'], ['service_asset', 'contract_id', 'covered asset']],
    review_cycle: [['performance_review', 'cycle_id', 'review']],
    asset_class: [['fixed_asset', 'class_id', 'asset']],
    budget: [['budget_line', 'budget_id', 'budget line']],
    location: [['txn', 'location_id', 'transaction'], ['inventory_txn', 'location_id', 'stock movement']],
    subsidiary: [['txn', 'subsidiary_id', 'transaction'], ['journal_entry', 'subsidiary_id', 'journal entry', 'journal entries']],
    department: [['employee', 'department_id', 'employee']],
  };
  for (const [table, column, noun, plural] of checks[type] || []) {
    const n = repo.scalar(`SELECT COUNT(*) c FROM ${table} WHERE tenant_id = :t AND ${column} = ?`, [id], 0);
    if (n > 0) return `${n} ${n === 1 ? noun : (plural || `${noun}s`)} reference it`;
  }
  return null;
}

/** Bulk resolution helpers to eliminate N+1 query patterns. */

export function resolveRecords(repo, table, ids) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!uniqueIds.length) return new Map();
  const rows = repo.query(`SELECT * FROM ${table} WHERE tenant_id = :t AND id IN (${uniqueIds.map(() => '?').join(',')})`, uniqueIds);
  return new Map(rows.map(r => [r.id, r]));
}

export function resolveTaxRates(repo, codes) {
  const uniqueCodes = [...new Set(codes.filter(Boolean))];
  if (!uniqueCodes.length) return new Map();
  const rows = repo.query(`SELECT code, rate FROM tax_code WHERE tenant_id = :t AND code IN (${uniqueCodes.map(() => '?').join(',')})`, uniqueCodes);
  return new Map(rows.map(r => [r.code, r]));
}

export function resolvePricingRules(repo) {
  return repo.query(`SELECT * FROM pricing_rule WHERE tenant_id = :t AND active = 1 ORDER BY priority ASC`);
}

export function checkBankTxnDuplicates(repo, accountId, externalIds) {
  const uniqueIds = [...new Set(externalIds.filter(Boolean))];
  if (!uniqueIds.length) return new Set();
  const rows = repo.query(`SELECT external_id FROM bank_txn WHERE tenant_id = :t AND bank_account_id = ? AND external_id IN (${uniqueIds.map(() => '?').join(',')})`, [accountId, ...uniqueIds]);
  return new Set(rows.map(r => r.external_id));
}

export function genericCreate(repo, type, body) {
  const m = meta.getMeta(type);
  if (!m) throw badRequest(`Unknown record type "${type}"`);
  if (m.isTransaction) return T.createTxn(repo, m.txnType, body);

  const values = {}; const errors = {};
  for (const f of m.fields) {
    if (f.readOnly) continue;
    const v = coerce(f, body[f.name]);
    if (f.required && (v === null || v === undefined || v === '')) { errors[f.name] = `${f.label} is required`; continue; }
    if (v !== undefined) values[f.name] = v;
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  if (body.custom !== undefined) values.custom = platform.validateCustom(repo, type, body.custom);
  const now = nowIso();
  if (m.fields.some((f) => f.name === 'created_at')) values.created_at = now;
  if (m.fields.some((f) => f.name === 'updated_at')) values.updated_at = now;
  values.id = ulid();
  const id = repo.insert(m.table, values);
  audit.record(repo, { recordType: type, recordId: id, action: 'create', after: values });
  return repo.get(m.table, id);
}

export function genericUpdate(repo, type, id, body) {
  const m = meta.getMeta(type);
  if (!m) throw badRequest(`Unknown record type "${type}"`);
  if (m.isTransaction) return T.updateTxn(repo, id, body);
  const before = repo.get(m.table, id);
  if (!before) throw notFound(`${m.label} not found`);

  const values = {};
  for (const f of m.fields) {
    if (f.readOnly || !(f.name in body)) continue;
    const v = coerce(f, body[f.name]);
    if (v !== undefined) values[f.name] = v;
  }
  if (body.custom !== undefined) values.custom = { ...(before.custom || {}), ...platform.validateCustom(repo, type, body.custom, { partial: true }) };
  if (m.fields.some((f) => f.name === 'updated_at')) values.updated_at = nowIso();
  repo.update(m.table, id, values);
  const after = repo.get(m.table, id);
  audit.record(repo, { recordType: type, recordId: id, action: 'update', before, after });
  return after;
}

/** Create through the bespoke handler when there is one, else generically. */
export function createRecord(repo, type, body) {
  if (customRecords.isCustomType(type)) return customRecords.createRecord(repo, type, body);
  return HANDLERS[type]?.create ? HANDLERS[type].create(repo, body) : genericCreate(repo, type, body);
}

/** Update through the bespoke handler when there is one, else generically. */
export function updateRecord(repo, type, id, body) {
  if (customRecords.isCustomType(type)) return customRecords.updateRecord(repo, type, id, body);
  return HANDLERS[type]?.update ? HANDLERS[type].update(repo, id, body) : genericUpdate(repo, type, id, body);
}
