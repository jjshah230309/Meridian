// Meridian ERP :: core/seq
// Gap-tolerant document numbering, allocated inside the caller's transaction
// so a rolled-back document does not burn a number that auditors will ask
// about, and two concurrent posts can never collide.
import { HttpError } from './http.mjs';

export const DEFAULTS = {
  journal_entry: { prefix: 'JE-', padding: 5 },
  QUOTE: { prefix: 'QTE-', padding: 5 },
  SALES_ORDER: { prefix: 'SO-', padding: 5 },
  FULFILLMENT: { prefix: 'FUL-', padding: 5 },
  INVOICE: { prefix: 'INV-', padding: 5 },
  CREDIT_MEMO: { prefix: 'CM-', padding: 5 },
  CUSTOMER_PAYMENT: { prefix: 'CPY-', padding: 5 },
  PURCHASE_ORDER: { prefix: 'PO-', padding: 5 },
  ITEM_RECEIPT: { prefix: 'RCV-', padding: 5 },
  VENDOR_BILL: { prefix: 'BILL-', padding: 5 },
  VENDOR_PAYMENT: { prefix: 'VPY-', padding: 5 },
  INVENTORY_ADJUSTMENT: { prefix: 'ADJ-', padding: 5 },
  INVENTORY_TRANSFER: { prefix: 'TRF-', padding: 5 },
  EXPENSE_REPORT: { prefix: 'EXP-', padding: 5 },
  customer: { prefix: 'C', padding: 5 },
  vendor: { prefix: 'V', padding: 5 },
  employee: { prefix: 'E', padding: 4 },
  lead: { prefix: 'LEAD-', padding: 5 },
  opportunity: { prefix: 'OPP-', padding: 5 },
  support_case: { prefix: 'CASE-', padding: 5 },
  payroll_run: { prefix: 'PR-', padding: 4 },
  fixed_asset: { prefix: 'FA-', padding: 5 },
  budget: { prefix: 'BUD-', padding: 4 },
  REQUISITION: { prefix: 'REQ-', padding: 5 },
  RETURN_AUTH: { prefix: 'RMA-', padding: 5 },
  VENDOR_RETURN: { prefix: 'VRA-', padding: 5 },
  WORK_ORDER: { prefix: 'WO-', padding: 5 },
  project: { prefix: 'PRJ-', padding: 5 },
  campaign: { prefix: 'CMP-', padding: 4 },
  partner: { prefix: 'P', padding: 5 },
  service_order: { prefix: 'SVC-', padding: 5 },
  pick_wave: { prefix: 'WAVE-', padding: 5 },
  import_job: { prefix: 'IMP-', padding: 5 },
  REV_SCHEDULE: { prefix: 'REV-', padding: 5 },
  AMORT_SCHEDULE: { prefix: 'AMT-', padding: 5 },
  revaluation_run: { prefix: 'FXR-', padding: 4 },
  dunning_notice: { prefix: 'DUN-', padding: 5 },
  payment_run: { prefix: 'PAY-', padding: 4 },
  tax_return: { prefix: 'VAT-', padding: 4 },
  allocation_run: { prefix: 'ALC-', padding: 4 },
  inventory_count: { prefix: 'CNT-', padding: 5 },
  CUSTOMER_DEPOSIT: { prefix: 'DEP-', padding: 5 },
  VENDOR_PREPAYMENT: { prefix: 'PRE-', padding: 5 },
  subscription: { prefix: 'SUB-', padding: 5 },
  intercompany_txn: { prefix: 'IC-', padding: 5 },
  elimination_run: { prefix: 'ELIM-', padding: 4 },
  asset_revaluation: { prefix: 'REV-', padding: 5 },
  book_adjustment: { prefix: 'BK-', padding: 5 },
};

/** Allocate the next number for `name`. Must run inside a write transaction. */
export function nextNumber(repo, name) {
  const def = DEFAULTS[name] || { prefix: '', padding: 5 };
  const row = repo.queryOne('SELECT * FROM sequence WHERE tenant_id = :t AND name = ?', [name]);
  if (!row) {
    repo.exec('INSERT INTO sequence (tenant_id, name, prefix, next_value, padding) VALUES (:t,?,?,?,?)',
      [name, def.prefix, 2, def.padding]);
    return def.prefix + String(1).padStart(def.padding, '0');
  }
  repo.exec('UPDATE sequence SET next_value = next_value + 1 WHERE tenant_id = :t AND name = ?', [name]);
  return row.prefix + String(row.next_value).padStart(row.padding, '0');
}

/** Reserve a caller-supplied number, or allocate one. Rejects duplicates. */
export function resolveNumber(repo, name, supplied, uniquenessCheck) {
  if (supplied) {
    if (uniquenessCheck && uniquenessCheck(supplied)) {
      throw new HttpError(409, `Document number ${supplied} is already in use`, 'DUPLICATE_NUMBER');
    }
    return supplied;
  }
  for (let attempt = 0; attempt < 25; attempt++) {
    const n = nextNumber(repo, name);
    if (!uniquenessCheck || !uniquenessCheck(n)) return n;
  }
  throw new HttpError(409, `Could not allocate a free ${name} number`, 'SEQUENCE_EXHAUSTED');
}
