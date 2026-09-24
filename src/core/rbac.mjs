// Meridian ERP :: core/rbac
// Role-based access control plus row-level security.
//
// Two layers:
//   1. Record-type permissions -- can this role see/create/edit/delete
//      customers, journal entries, employees...
//   2. Row-level restrictions -- of the records of that type, which rows.
//      Expressed per dimension (subsidiary / department / location / class)
//      and as "own records only". These are compiled into a SQL predicate
//      that Repo appends, so restriction cannot be bypassed by a module
//      forgetting to filter.
import { safeJson } from './util.mjs';

export const LEVEL = { NONE: 0, VIEW: 1, CREATE: 2, EDIT: 3, FULL: 4 };
export const LEVEL_NAMES = ['None', 'View', 'Create', 'Edit', 'Full'];

/** Record types the permission system knows about, grouped for the admin UI. */
export const RECORD_TYPES = {
  Financial: ['account', 'journal_entry', 'accounting_period', 'bank_account', 'bank_txn', 'reconciliation', 'currency', 'exchange_rate', 'subsidiary',
    'fixed_asset', 'budget', 'consolidation', 'schedule', 'schedule_template', 'recurring_journal', 'revaluation_run', 'tax_return', 'allocation_schedule',
    'intercompany_txn', 'elimination_run', 'accounting_book'],
  Collections: ['collections', 'dunning_policy', 'dunning_notice'],
  Sales: ['customer', 'quote', 'sales_order', 'invoice', 'customer_payment', 'credit_memo', 'price_level', 'pricing_rule', 'return_auth', 'customer_deposit', 'subscription'],
  CRM: ['lead', 'opportunity', 'contact', 'activity', 'support_case', 'campaign', 'partner', 'commission'],
  Purchasing: ['vendor', 'purchase_order', 'item_receipt', 'vendor_bill', 'vendor_payment', 'requisition', 'vendor_return', 'payment_run', 'vendor_prepayment'],
  Inventory: ['item', 'location', 'inventory_adjustment', 'inventory_transfer', 'fulfillment',
    'bin', 'pick_wave', 'demand_plan', 'inventory_count', 'landed_cost'],
  Projects: ['project', 'expense_report'],
  Manufacturing: ['bom', 'work_order', 'quality_inspection'],
  Commerce: ['sales_channel'],
  Service: ['service_order', 'service_asset', 'service_contract'],
  People: ['employee', 'time_entry', 'time_off', 'payroll_run', 'department',
    'performance_review', 'schedule_entry', 'attendance', 'employee_request'],
  Platform: ['app_user', 'role', 'custom_field', 'workflow', 'saved_search', 'server_script', 'audit_event', 'setup',
    'data_import', 'data_export',
    'custom_record_type', 'custom_record'],
};
export const ALL_RECORD_TYPES = Object.values(RECORD_TYPES).flat();

/** Which physical table backs a permission record type. */
export const TYPE_TABLE = {
  quote: 'txn', sales_order: 'txn', invoice: 'txn', customer_payment: 'txn', credit_memo: 'txn',
  purchase_order: 'txn', item_receipt: 'txn', vendor_bill: 'txn', vendor_payment: 'txn',
  inventory_adjustment: 'txn', inventory_transfer: 'txn', fulfillment: 'txn',
  requisition: 'txn', return_auth: 'txn', vendor_return: 'txn',
};

/** Transaction subtype for permission types backed by `txn`. */
export const TYPE_TXN = {
  quote: 'QUOTE', sales_order: 'SALES_ORDER', invoice: 'INVOICE', customer_payment: 'CUSTOMER_PAYMENT',
  credit_memo: 'CREDIT_MEMO', purchase_order: 'PURCHASE_ORDER', item_receipt: 'ITEM_RECEIPT',
  vendor_bill: 'VENDOR_BILL', vendor_payment: 'VENDOR_PAYMENT', fulfillment: 'FULFILLMENT',
  inventory_adjustment: 'INVENTORY_ADJUSTMENT', inventory_transfer: 'INVENTORY_TRANSFER',
  requisition: 'REQUISITION', return_auth: 'RETURN_AUTH', vendor_return: 'VENDOR_RETURN',
};

export class ForbiddenError extends Error {
  constructor(message, recordType, needed) {
    super(message); this.name = 'ForbiddenError'; this.status = 403;
    this.recordType = recordType; this.needed = needed;
  }
}

/** Load the effective permission set for a user (union of their roles). */
export function loadAccess(db, tenantId, userId) {
  const user = db.prepare('SELECT * FROM app_user WHERE tenant_id = ? AND id = ?').get(tenantId, userId);
  if (!user) return null;
  // Checked on every request, not only at sign-in: disabling somebody has to
  // take their open browser tab with it, not wait out the session's 12 hours.
  if (user.status !== 'active') return null;

  const roles = db.prepare(`SELECT r.* FROM role r JOIN user_role ur
      ON ur.tenant_id = r.tenant_id AND ur.role_id = r.id
      WHERE r.tenant_id = ? AND ur.user_id = ?`).all(tenantId, userId);

  const permissions = {};
  const restrictions = {};                 // dimension -> {allowed:Set|null, ownOnly:bool}

  if (user.is_owner) {
    for (const t of ALL_RECORD_TYPES) permissions[t] = LEVEL.FULL;
  } else {
    const roleIds = roles.map((r) => r.id);
    if (roleIds.length) {
      const ph = roleIds.map(() => '?').join(',');
      for (const p of db.prepare(`SELECT record_type, MAX(level) level FROM permission
            WHERE tenant_id = ? AND role_id IN (${ph}) GROUP BY record_type`).all(tenantId, ...roleIds)) {
        permissions[p.record_type] = Math.max(permissions[p.record_type] || 0, p.level);
      }
      // Restrictions across roles are UNIONed: holding a broader role widens access.
      for (const r of db.prepare(`SELECT * FROM role_restriction WHERE tenant_id = ? AND role_id IN (${ph})`).all(tenantId, ...roleIds)) {
        const allowed = safeJson(r.allowed, []);
        const cur = restrictions[r.dimension];
        if (!cur) {
          restrictions[r.dimension] = { allowed: allowed.length ? new Set(allowed) : null, ownOnly: !!r.own_only };
        } else {
          if (!allowed.length || !cur.allowed) cur.allowed = null;
          else allowed.forEach((a) => cur.allowed.add(a));
          cur.ownOnly = cur.ownOnly && !!r.own_only;
        }
      }
    }
  }
  return { user, roles, permissions, restrictions, isOwner: !!user.is_owner };
}

export const levelFor = (access, recordType) =>
  (access?.isOwner ? LEVEL.FULL : (access?.permissions?.[recordType] ?? LEVEL.NONE));

export const can = (access, recordType, needed) => levelFor(access, recordType) >= needed;

export function require$(access, recordType, needed) {
  if (!can(access, recordType, needed)) {
    throw new ForbiddenError(
      `Your role does not have ${LEVEL_NAMES[needed]} access to ${recordType.replace(/_/g, ' ')}`,
      recordType, needed);
  }
}

/**
 * Build the row-level predicate for a table.
 * Returns { sql, params } where sql begins with ' AND ...' or is ''.
 * `alias` lets callers apply it to a joined table.
 */
// Which column identifies "mine" for a table's own-only restriction. Shared
// between rowFilter (the SQL-level filter) and canSeeRow (the single-row,
// post-fetch check) so the two can never disagree about who owns a row --
// they used to: canSeeRow only ever looked at owner_id/assigned_to/created_by,
// so a table like time_entry or time_off (owned by employee_id, with none of
// those three columns) always passed canSeeRow no matter whose it was, even
// though the list view's SQL filter correctly restricted it.
const OWNER_COL = {
  customer: 'owner_id', lead: 'owner_id', opportunity: 'owner_id', activity: 'owner_id',
  support_case: 'assigned_to', txn: 'created_by', time_entry: 'employee_id', time_off: 'employee_id',
};

// Fallback allowlist for callers that cannot pass a `db` (unit tests
// exercising rowFilter directly). Every real call site passes `db`, which
// asks the live schema instead -- this hand-maintained list drifted from the
// schema before (see the `db` branch below) and is kept only for that case.
const DIMENSION_COLS_FALLBACK = {
  txn: ['subsidiary_id', 'location_id', 'department_id', 'class_id'],
  journal_entry: ['subsidiary_id'],
  journal_line: ['department_id', 'location_id', 'class_id'],
  customer: ['subsidiary_id'], vendor: ['subsidiary_id'], employee: ['subsidiary_id', 'department_id', 'location_id'],
  location: ['subsidiary_id'], item: [], opportunity: ['subsidiary_id'], account: ['subsidiary_id'],
  time_entry: ['department_id'], payroll_run: ['subsidiary_id'],
};

export function rowFilter(access, table, { alias = '', ownerColumn = 'owner_id', db = null } = {}) {
  if (!access || access.isOwner) return { sql: '', params: [] };
  const p = alias ? `${alias}.` : '';
  const parts = []; const params = [];
  const COLUMN_FOR = { subsidiary: 'subsidiary_id', department: 'department_id', location: 'location_id', class: 'class_id' };
  // Whether `table` actually carries this dimension's column -- read from the
  // live schema when possible. A hand-maintained allowlist here used to fall
  // behind the schema, so a subsidiary/department/location/class restriction
  // silently did nothing on any table someone forgot to add to the list,
  // even though the single-row canSeeRow check (which reads the row itself)
  // enforced it correctly -- the two only need to agree once this reads the
  // same source of truth canSeeRow already does.
  const hasCol = (col) => (db ? db.$hasColumn(table, col) : (DIMENSION_COLS_FALLBACK[table] || []).includes(col));

  for (const [dim, r] of Object.entries(access.restrictions || {})) {
    if (dim === 'owner') continue;
    const col = COLUMN_FOR[dim];
    if (!col || !hasCol(col) || !r.allowed) continue;
    const ids = [...r.allowed];
    if (!ids.length) { parts.push('0=1'); continue; }
    // NULL means "unassigned/shared" and stays visible; restrictions scope
    // assigned rows rather than hiding shared configuration data.
    parts.push(`(${p}${col} IN (${ids.map(() => '?').join(',')}) OR ${p}${col} IS NULL)`);
    params.push(...ids);
  }

  const own = access.restrictions?.owner;
  if (own?.ownOnly && access.user) {
    const col = OWNER_COL[table] || ownerColumn;
    if (col === 'employee_id') {
      // An app user who isn't linked to an employee record owns nothing here.
      if (access.user.employee_id) { parts.push(`${p}${col} = ?`); params.push(access.user.employee_id); }
      else { parts.push('0=1'); }
    } else if (access.user.id) {
      parts.push(`${p}${col} = ?`); params.push(access.user.id);
    }
  }
  return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', params };
}

/** Post-fetch check for a single row (defence in depth for by-id reads). */
export function canSeeRow(access, table, row) {
  if (!access || access.isOwner || !row) return true;
  const COLUMN_FOR = { subsidiary: 'subsidiary_id', department: 'department_id', location: 'location_id', class: 'class_id' };
  for (const [dim, r] of Object.entries(access.restrictions || {})) {
    if (dim === 'owner' || !r.allowed) continue;
    const col = COLUMN_FOR[dim];
    if (!col || !(col in row)) continue;
    const v = row[col];
    if (v !== null && v !== undefined && !r.allowed.has(v)) return false;
  }
  const own = access.restrictions?.owner;
  if (own?.ownOnly) {
    // Same column rowFilter would have used for this table -- a row that
    // passes the SQL-level filter must pass this check too, and vice versa.
    const col = OWNER_COL[table] || 'owner_id';
    if (col === 'employee_id') {
      if (!(row.employee_id && row.employee_id === access.user?.employee_id)) return false;
    } else {
      const v = row[col];
      if (v !== null && v !== undefined && v !== access.user?.id) return false;
    }
  }
  return true;
}

/** Role templates seeded into every new tenant. */
export const ROLE_TEMPLATES = [
  {
    name: 'Administrator', description: 'Full access to every record and every setup area.',
    permissions: Object.fromEntries(ALL_RECORD_TYPES.map((t) => [t, LEVEL.FULL])),
  },
  {
    name: 'Controller', description: 'Owns the ledger: posting, period close, banking, reporting.',
    permissions: {
      ...Object.fromEntries(RECORD_TYPES.Financial.map((t) => [t, LEVEL.FULL])),
      ...Object.fromEntries(RECORD_TYPES.Sales.map((t) => [t, LEVEL.EDIT])),
      ...Object.fromEntries(RECORD_TYPES.Purchasing.map((t) => [t, LEVEL.FULL])),
      item: LEVEL.VIEW, location: LEVEL.VIEW, employee: LEVEL.VIEW, payroll_run: LEVEL.FULL,
      ...Object.fromEntries(RECORD_TYPES.Collections.map((t) => [t, LEVEL.FULL])),
      audit_event: LEVEL.VIEW, saved_search: LEVEL.EDIT, setup: LEVEL.VIEW, department: LEVEL.EDIT,
    },
  },
  {
    name: 'AP Clerk', description: 'Enters vendor bills and prepares payment runs. Cannot post journals directly.',
    permissions: { vendor: LEVEL.EDIT, purchase_order: LEVEL.VIEW, item_receipt: LEVEL.VIEW, vendor_bill: LEVEL.CREATE, vendor_payment: LEVEL.CREATE, payment_run: LEVEL.CREATE, account: LEVEL.VIEW, saved_search: LEVEL.VIEW },
  },
  {
    name: 'AR Clerk', description: 'Issues invoices and applies customer payments.',
    permissions: { customer: LEVEL.EDIT, invoice: LEVEL.CREATE, customer_payment: LEVEL.CREATE, credit_memo: LEVEL.CREATE, sales_order: LEVEL.VIEW, account: LEVEL.VIEW, saved_search: LEVEL.VIEW, collections: LEVEL.EDIT, dunning_notice: LEVEL.CREATE, dunning_policy: LEVEL.VIEW },
  },
  {
    name: 'Sales Rep', description: 'Owns their own pipeline. Row-level restricted to their own records.',
    permissions: { lead: LEVEL.EDIT, opportunity: LEVEL.EDIT, contact: LEVEL.EDIT, customer: LEVEL.EDIT, activity: LEVEL.FULL, quote: LEVEL.CREATE, sales_order: LEVEL.CREATE, item: LEVEL.VIEW, support_case: LEVEL.VIEW, saved_search: LEVEL.VIEW },
    restrictions: [{ dimension: 'owner', allowed: [], own_only: 1 }],
  },
  {
    name: 'Sales Manager', description: 'Full pipeline visibility, approves discounts and orders.',
    permissions: { lead: LEVEL.FULL, opportunity: LEVEL.FULL, contact: LEVEL.FULL, customer: LEVEL.FULL, activity: LEVEL.FULL, quote: LEVEL.FULL, sales_order: LEVEL.FULL, invoice: LEVEL.VIEW, item: LEVEL.VIEW, support_case: LEVEL.EDIT, employee: LEVEL.VIEW, saved_search: LEVEL.EDIT, pricing_rule: LEVEL.EDIT },
  },
  {
    name: 'Warehouse', description: 'Picks, packs, ships and receives stock. No financial visibility.',
    permissions: { item: LEVEL.VIEW, location: LEVEL.VIEW, sales_order: LEVEL.VIEW, fulfillment: LEVEL.CREATE, purchase_order: LEVEL.VIEW, item_receipt: LEVEL.CREATE, inventory_adjustment: LEVEL.CREATE, inventory_transfer: LEVEL.CREATE, saved_search: LEVEL.VIEW },
  },
  {
    name: 'HR Manager', description: 'Employee records, time and payroll.',
    permissions: { employee: LEVEL.FULL, department: LEVEL.FULL, time_entry: LEVEL.FULL, time_off: LEVEL.FULL, payroll_run: LEVEL.FULL, app_user: LEVEL.VIEW, saved_search: LEVEL.VIEW },
  },
  {
    name: 'Employee', description: 'Self-service: own time, own time off, company directory.',
    permissions: { employee: LEVEL.VIEW, time_entry: LEVEL.CREATE, time_off: LEVEL.CREATE, activity: LEVEL.EDIT },
    restrictions: [{ dimension: 'owner', allowed: [], own_only: 1 }],
  },
];
