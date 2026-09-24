// Meridian ERP :: modules/entities
// Customers, vendors and contacts -- the parties every transaction points at.
import { ulid, nowIso, Money, termsToDueDate, sum } from '../core/util.mjs';
import { notFound, unprocessable, ValidationError } from '../core/http.mjs';
import { nextNumber } from '../core/seq.mjs';
import * as audit from '../core/audit.mjs';
import { indexRecord, unindexRecord } from '../core/search.mjs';
import * as meta from './meta.mjs';
import * as platform from './platform.mjs';

export const TERMS = ['DUE_ON_RECEIPT', 'NET7', 'NET10', 'NET15', 'NET30', 'NET45', 'NET60', 'NET90'];

const emailOk = (e) => !e || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

// ---------------------------------------------------------- customers
export function getCustomer(repo, id) {
  const c = repo.get('customer', id);
  if (!c) throw notFound(`Customer ${id} not found`);
  return c;
}

/**
 * Columns each create function decides for itself -- a generated number, a
 * default that depends on the subsidiary, an owner taken from the session.
 * Everything else the registry declares is taken from the caller as-is.
 */
const KNOWN_CUSTOMER_FIELDS = ['entity_no', 'name', 'legal_name', 'parent_id', 'category', 'email',
  'phone', 'website', 'billing_address', 'shipping_address', 'currency', 'subsidiary_id', 'terms',
  'credit_limit', 'credit_hold', 'price_level_id', 'discount_pct', 'tax_number', 'tax_code',
  'sales_rep_id', 'owner_id', 'status', 'source', 'notes', 'custom'];
const KNOWN_VENDOR_FIELDS = ['entity_no', 'name', 'legal_name', 'category', 'email', 'phone',
  'website', 'address', 'currency', 'subsidiary_id', 'terms', 'tax_number', 'is_1099',
  'payables_account_id', 'expense_account_id', 'lead_time_days', 'status', 'notes', 'custom'];

export function createCustomer(repo, input) {
  const fields = {};
  if (!input.name) fields.name = 'Customer name is required';
  if (!emailOk(input.email)) fields.email = 'Enter a valid email address';
  if (input.terms && !TERMS.includes(input.terms)) fields.terms = 'Unknown payment terms';
  if (Object.keys(fields).length) throw new ValidationError(fields);

  const subsidiaryId = input.subsidiary_id || repo.queryOne('SELECT id, currency FROM subsidiary WHERE tenant_id = :t AND active = 1 ORDER BY created_at LIMIT 1')?.id;
  if (!subsidiaryId) throw unprocessable('No active subsidiary exists. Create one under Setup first.');
  const currency = input.currency || repo.get('subsidiary', subsidiaryId)?.currency || 'USD';
  const now = nowIso();

  const id = repo.insert('customer', {
    id: ulid(), entity_no: input.entity_no || nextNumber(repo, 'customer'),
    name: input.name, legal_name: input.legal_name || '', parent_id: input.parent_id || null,
    category: input.category || '', email: input.email || '', phone: input.phone || '',
    website: input.website || '',
    billing_address: input.billing_address || {}, shipping_address: input.shipping_address || input.billing_address || {},
    currency, subsidiary_id: subsidiaryId, terms: input.terms || 'NET30',
    credit_limit: Money.parse(input.credit_limit ?? 0), credit_hold: input.credit_hold ? 1 : 0,
    price_level_id: input.price_level_id || null, discount_pct: Number(input.discount_pct || 0),
    tax_number: input.tax_number || '', tax_code: input.tax_code || 'STANDARD',
    sales_rep_id: input.sales_rep_id || null, owner_id: input.owner_id || repo.ctx?.user?.id || null,
    status: input.status || 'active', source: input.source || '', notes: input.notes || '',
    custom: platform.validateCustom(repo, 'customer', input.custom || {}), created_at: now, updated_at: now,
    ...meta.cleanPatch('customer', input, { skip: KNOWN_CUSTOMER_FIELDS }),
  });
  audit.record(repo, { recordType: 'customer', recordId: id, action: 'create', after: input });
  reindexCustomer(repo, id);
  return getCustomer(repo, id);
}

export function updateCustomer(repo, id, patch) {
  const before = getCustomer(repo, id);
  if (patch.email !== undefined && !emailOk(patch.email)) throw new ValidationError({ email: 'Enter a valid email address' });
  const clean = meta.cleanPatch('customer', patch);
  // Merge onto the existing blob (a patch naming one custom field must not
  // blank the rest) and coerce it the same way every other write path does,
  // or a money/qty custom field is stored in the wrong units and a saved
  // search filtering on it never matches.
  if (patch.custom !== undefined) clean.custom = { ...(before.custom || {}), ...platform.validateCustom(repo, 'customer', patch.custom, { partial: true }) };
  // Changing the currency of a customer with open documents would restate them.
  if (clean.currency && clean.currency !== before.currency) {
    const open = repo.scalar(`SELECT COUNT(*) c FROM txn WHERE tenant_id = :t AND entity_type='customer' AND entity_id = ?
                              AND status NOT IN ('closed','cancelled','voided')`, [id], 0);
    if (open > 0) throw unprocessable(`${before.name} has ${open} open transaction${open === 1 ? '' : 's'} in ${before.currency}. Close them before changing currency.`);
  }
  clean.updated_at = nowIso();
  repo.update('customer', id, clean);
  const after = getCustomer(repo, id);
  audit.record(repo, { recordType: 'customer', recordId: id, action: 'update', before, after });
  reindexCustomer(repo, id);
  return after;
}

export function reindexCustomer(repo, id) {
  const c = repo.get('customer', id);
  if (!c) return;
  indexRecord(repo, 'customer', id, {
    title: c.name, subtitle: `${c.entity_no} · ${c.email || 'no email'}`,
    body: [c.legal_name, c.phone, c.website, c.category, c.notes, JSON.stringify(c.billing_address || {})].filter(Boolean).join(' '),
  });
}

/** Balance, exposure and credit headroom for a customer. */
export function customerFinancials(repo, id) {
  const c = getCustomer(repo, id);
  const r = repo.queryOne(`SELECT
      COALESCE(SUM(CASE WHEN type IN ('INVOICE') AND status NOT IN ('voided','cancelled') THEN amount_remaining ELSE 0 END),0) open_ar,
      COALESCE(SUM(CASE WHEN type='INVOICE' AND status NOT IN ('voided','cancelled') THEN total ELSE 0 END),0) invoiced,
      COALESCE(SUM(CASE WHEN type='INVOICE' AND status NOT IN ('voided','cancelled') AND due_date < date('now') THEN amount_remaining ELSE 0 END),0) overdue
      FROM txn WHERE tenant_id = :t AND entity_type='customer' AND entity_id = ?`, [id]);
  const openOrders = repo.scalar(`SELECT COALESCE(SUM(total),0) FROM txn WHERE tenant_id = :t AND type='SALES_ORDER'
      AND entity_type='customer' AND entity_id = ? AND status IN ('open','partially_fulfilled','pending_approval')`, [id], 0);
  const exposure = (r?.open_ar || 0) + openOrders;
  return {
    open_ar: r?.open_ar || 0, lifetime_invoiced: r?.invoiced || 0, overdue: r?.overdue || 0,
    open_orders: openOrders, exposure,
    credit_limit: c.credit_limit,
    credit_available: c.credit_limit ? c.credit_limit - exposure : null,
    over_limit: !!c.credit_limit && exposure > c.credit_limit,
    on_hold: !!c.credit_hold,
  };
}

/**
 * Credit gate applied before a sales order or invoice is committed.
 * Returns { ok, reason } rather than throwing, so callers can choose to
 * route to approval instead of rejecting outright.
 */
export function creditCheck(repo, customerId, additionalAmount = 0) {
  const c = getCustomer(repo, customerId);
  if (c.credit_hold) return { ok: false, reason: `${c.name} is on credit hold.`, code: 'CREDIT_HOLD' };
  if (!c.credit_limit) return { ok: true };
  const f = customerFinancials(repo, customerId);
  const projected = f.exposure + additionalAmount;
  if (projected > c.credit_limit) {
    return {
      ok: false, code: 'CREDIT_LIMIT',
      reason: `This would put ${c.name} at ${Money.format(projected, c.currency)} against a ${Money.format(c.credit_limit, c.currency)} credit limit.`,
      exposure: projected, limit: c.credit_limit,
    };
  }
  return { ok: true, exposure: projected, limit: c.credit_limit };
}

// ------------------------------------------------------------- vendors
export function getVendor(repo, id) {
  const v = repo.get('vendor', id);
  if (!v) throw notFound(`Vendor ${id} not found`);
  return v;
}

export function createVendor(repo, input) {
  const fields = {};
  if (!input.name) fields.name = 'Vendor name is required';
  if (!emailOk(input.email)) fields.email = 'Enter a valid email address';
  if (Object.keys(fields).length) throw new ValidationError(fields);
  const subsidiaryId = input.subsidiary_id || repo.queryOne('SELECT id FROM subsidiary WHERE tenant_id = :t AND active = 1 ORDER BY created_at LIMIT 1')?.id;
  if (!subsidiaryId) throw unprocessable('No active subsidiary exists.');
  const now = nowIso();
  const id = repo.insert('vendor', {
    id: ulid(), entity_no: input.entity_no || nextNumber(repo, 'vendor'),
    name: input.name, legal_name: input.legal_name || '', category: input.category || '',
    email: input.email || '', phone: input.phone || '', website: input.website || '',
    address: input.address || {},
    currency: input.currency || repo.get('subsidiary', subsidiaryId)?.currency || 'USD',
    subsidiary_id: subsidiaryId, terms: input.terms || 'NET30',
    tax_number: input.tax_number || '', is_1099: input.is_1099 ? 1 : 0,
    payables_account_id: input.payables_account_id || null, expense_account_id: input.expense_account_id || null,
    lead_time_days: Number(input.lead_time_days || 7), status: input.status || 'active',
    notes: input.notes || '', custom: platform.validateCustom(repo, 'vendor', input.custom || {}), created_at: now, updated_at: now,
    // Anything else the registry says is writable -- payment method, bank
    // reference, the collections settings -- rather than a second list here
    // that has to be remembered every time a field is added.
    ...meta.cleanPatch('vendor', input, { skip: KNOWN_VENDOR_FIELDS }),
  });
  audit.record(repo, { recordType: 'vendor', recordId: id, action: 'create', after: input });
  reindexVendor(repo, id);
  return getVendor(repo, id);
}

export function updateVendor(repo, id, patch) {
  const before = getVendor(repo, id);
  const clean = meta.cleanPatch('vendor', patch);
  if (patch.custom !== undefined) clean.custom = { ...(before.custom || {}), ...platform.validateCustom(repo, 'vendor', patch.custom, { partial: true }) };
  clean.updated_at = nowIso();
  repo.update('vendor', id, clean);
  const after = getVendor(repo, id);
  audit.record(repo, { recordType: 'vendor', recordId: id, action: 'update', before, after });
  reindexVendor(repo, id);
  return after;
}

export function reindexVendor(repo, id) {
  const v = repo.get('vendor', id);
  if (!v) return;
  indexRecord(repo, 'vendor', id, {
    title: v.name, subtitle: `${v.entity_no} · ${v.email || 'no email'}`,
    body: [v.legal_name, v.phone, v.category, v.notes].filter(Boolean).join(' '),
  });
}

export function vendorFinancials(repo, id) {
  const r = repo.queryOne(`SELECT
      COALESCE(SUM(CASE WHEN type='VENDOR_BILL' AND status NOT IN ('voided','cancelled') THEN amount_remaining ELSE 0 END),0) open_ap,
      COALESCE(SUM(CASE WHEN type='VENDOR_BILL' AND status NOT IN ('voided','cancelled') THEN total ELSE 0 END),0) billed,
      COALESCE(SUM(CASE WHEN type='VENDOR_BILL' AND status NOT IN ('voided','cancelled') AND due_date < date('now') THEN amount_remaining ELSE 0 END),0) overdue
      FROM txn WHERE tenant_id = :t AND entity_type='vendor' AND entity_id = ?`, [id]);
  const openPos = repo.scalar(`SELECT COALESCE(SUM(total),0) FROM txn WHERE tenant_id = :t AND type='PURCHASE_ORDER'
      AND entity_type='vendor' AND entity_id = ? AND status IN ('open','partially_fulfilled','pending_approval')`, [id], 0);
  return { open_ap: r?.open_ap || 0, lifetime_billed: r?.billed || 0, overdue: r?.overdue || 0, open_pos: openPos };
}

// ------------------------------------------------------------ contacts
export function createContact(repo, input) {
  if (!input.first_name && !input.last_name) throw new ValidationError({ last_name: 'A first or last name is required' });
  if (!emailOk(input.email)) throw new ValidationError({ email: 'Enter a valid email address' });
  const now = nowIso();
  const id = repo.insert('contact', {
    id: ulid(), first_name: input.first_name || '', last_name: input.last_name || '',
    email: input.email || '', phone: input.phone || '', mobile: input.mobile || '',
    title: input.title || '', company_type: input.company_type || 'customer',
    company_id: input.company_id || null, is_primary: input.is_primary ? 1 : 0,
    owner_id: input.owner_id || repo.ctx?.user?.id || null, status: input.status || 'active',
    notes: input.notes || '', custom: platform.validateCustom(repo, 'contact', input.custom || {}), created_at: now, updated_at: now,
  });
  // Only one primary contact per company.
  if (input.is_primary && input.company_id) {
    repo.exec(`UPDATE contact SET is_primary = 0 WHERE tenant_id = :t AND company_type = ? AND company_id = ? AND id != ?`,
      [input.company_type || 'customer', input.company_id, id]);
  }
  audit.record(repo, { recordType: 'contact', recordId: id, action: 'create', after: input });
  reindexContact(repo, id);
  return repo.get('contact', id);
}

export function updateContact(repo, id, patch) {
  const before = repo.get('contact', id);
  if (!before) throw notFound('Contact not found');
  const allowed = ['first_name', 'last_name', 'email', 'phone', 'mobile', 'title', 'company_type',
    'company_id', 'is_primary', 'owner_id', 'status', 'notes', 'custom'];
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  if (clean.custom !== undefined) clean.custom = { ...(before.custom || {}), ...platform.validateCustom(repo, 'contact', clean.custom, { partial: true }) };
  clean.updated_at = nowIso();
  repo.update('contact', id, clean);
  if (clean.is_primary) {
    const c = repo.get('contact', id);
    repo.exec(`UPDATE contact SET is_primary = 0 WHERE tenant_id = :t AND company_type = ? AND company_id = ? AND id != ?`,
      [c.company_type, c.company_id, id]);
  }
  const after = repo.get('contact', id);
  audit.record(repo, { recordType: 'contact', recordId: id, action: 'update', before, after });
  reindexContact(repo, id);
  return after;
}

export function reindexContact(repo, id) {
  const c = repo.get('contact', id);
  if (!c) return;
  const name = `${c.first_name} ${c.last_name}`.trim();
  let company = '';
  if (c.company_id) company = (c.company_type === 'vendor' ? repo.get('vendor', c.company_id) : repo.get('customer', c.company_id))?.name || '';
  indexRecord(repo, 'contact', id, {
    title: name || c.email, subtitle: [c.title, company].filter(Boolean).join(' · '),
    body: [c.email, c.phone, c.mobile, c.notes].filter(Boolean).join(' '),
  });
}

export const deleteContact = (repo, id) => {
  const before = repo.get('contact', id);
  if (!before) throw notFound('Contact not found');
  repo.remove('contact', id);
  unindexRecord(repo, 'contact', id);
  audit.record(repo, { recordType: 'contact', recordId: id, action: 'delete', before });
  return true;
};
