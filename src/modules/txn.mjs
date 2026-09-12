// Meridian ERP :: modules/txn
// The unified transaction engine: quotes, orders, fulfilments, invoices,
// payments, purchase orders, receipts, bills, adjustments and transfers all
// flow through this one module.
//
// Three concerns live here, in this order:
//   1. PRICING   -- price level, volume break, then declarative pricing rules.
//   2. LIFECYCLE -- approval routing, transformation, fulfilment/billing state.
//   3. POSTING   -- the type-specific rules that turn a document into a
//                   balanced journal entry and a stock movement.
//
// Nothing here writes to the GL directly; everything goes through
// gl.postJournal so the ledger keeps its invariants.
import { ulid, nowIso, today, Money, Qty, termsToDueDate, isValidDate, round, sum, addDays } from '../core/util.mjs';
import { notFound, unprocessable, conflict, ValidationError, badRequest, forbidden } from '../core/http.mjs';
import { nextNumber } from '../core/seq.mjs';
import { compile, test as exprTest } from '../core/expr.mjs';
import * as audit from '../core/audit.mjs';
import { indexRecord } from '../core/search.mjs';
import * as gl from './gl.mjs';
import * as inv from './inventory.mjs';
import * as entities from './entities.mjs';
import { postingAccounts } from './setup.mjs';
import * as schedules from './schedules.mjs';

// ------------------------------------------------------------- metadata
/**
 * direction: +1 receivable/outbound (we are owed), -1 payable/inbound.
 * posts:     does this document hit the GL?
 * stock:     'issue' | 'receive' | 'adjust' | 'transfer' | null
 */
export const TYPES = {
  QUOTE:                { label: 'Quote',              entity: 'customer', posts: false, stock: null,       direction: 1, sequence: 'QUOTE' },
  SALES_ORDER:          { label: 'Sales Order',        entity: 'customer', posts: false, stock: null,       direction: 1, sequence: 'SALES_ORDER', commits: true },
  FULFILLMENT:          { label: 'Item Fulfilment',    entity: 'customer', posts: true,  stock: 'issue',    direction: 1, sequence: 'FULFILLMENT', terminal: true },
  INVOICE:              { label: 'Invoice',            entity: 'customer', posts: true,  stock: null,       direction: 1, sequence: 'INVOICE', receivable: true },
  CREDIT_MEMO:          { label: 'Credit Memo',        entity: 'customer', posts: true,  stock: null,       direction: -1, sequence: 'CREDIT_MEMO', receivable: true },
  CUSTOMER_PAYMENT:     { label: 'Customer Payment',   entity: 'customer', posts: true,  stock: null,       direction: 1, sequence: 'CUSTOMER_PAYMENT', settlement: true },
  PURCHASE_ORDER:       { label: 'Purchase Order',     entity: 'vendor',   posts: false, stock: null,       direction: -1, sequence: 'PURCHASE_ORDER', onOrder: true },
  ITEM_RECEIPT:         { label: 'Item Receipt',       entity: 'vendor',   posts: true,  stock: 'receive',  direction: -1, sequence: 'ITEM_RECEIPT', terminal: true },
  VENDOR_BILL:          { label: 'Vendor Bill',        entity: 'vendor',   posts: true,  stock: null,       direction: -1, sequence: 'VENDOR_BILL', payable: true },
  VENDOR_PAYMENT:       { label: 'Vendor Payment',     entity: 'vendor',   posts: true,  stock: null,       direction: -1, sequence: 'VENDOR_PAYMENT', settlement: true },
  INVENTORY_ADJUSTMENT: { label: 'Inventory Adjustment', entity: null,     posts: true,  stock: 'adjust',   direction: 0, sequence: 'INVENTORY_ADJUSTMENT' },
  INVENTORY_TRANSFER:   { label: 'Inventory Transfer', entity: null,       posts: false, stock: 'transfer', direction: 0, sequence: 'INVENTORY_TRANSFER' },
  // A requisition is an internal ask, not a commitment to a vendor: it does
  // not post, does not reserve stock, and carries no vendor until approval
  // turns it into a purchase order.
  REQUISITION:          { label: 'Purchase Requisition', entity: null,     posts: false, stock: null,       direction: -1, sequence: 'REQUISITION' },
  // Returns are the reverse leg of each cycle. The authorisation itself is a
  // promise; the stock movement and the credit happen on the documents it
  // becomes, which is why neither posts here.
  RETURN_AUTH:          { label: 'Return Authorisation', entity: 'customer', posts: false, stock: null,     direction: -1, sequence: 'RETURN_AUTH' },
  VENDOR_RETURN:        { label: 'Vendor Return',      entity: 'vendor',   posts: true,  stock: 'issue',    direction: 1, sequence: 'VENDOR_RETURN', terminal: true, payable: true },
  // Money that has moved before there is a document to apply it to. A deposit
  // taken from a customer is a liability until the goods go out; a payment
  // made to a supplier before delivery is an asset until they arrive. Neither
  // is revenue, cost, a receivable or a payable, and treating either as one
  // overstates the period it lands in and understates the one it belongs to.
  CUSTOMER_DEPOSIT:     { label: 'Customer Deposit',   entity: 'customer', posts: true,  stock: null,       direction: 1, sequence: 'CUSTOMER_DEPOSIT', settlement: true, deposit: 'customer' },
  VENDOR_PREPAYMENT:    { label: 'Supplier Prepayment', entity: 'vendor',  posts: true,  stock: null,       direction: -1, sequence: 'VENDOR_PREPAYMENT', settlement: true, deposit: 'vendor' },
};

/** permission record type for a txn type */
export const PERM_FOR = {
  QUOTE: 'quote', SALES_ORDER: 'sales_order', FULFILLMENT: 'fulfillment', INVOICE: 'invoice',
  CREDIT_MEMO: 'credit_memo', CUSTOMER_PAYMENT: 'customer_payment', PURCHASE_ORDER: 'purchase_order',
  ITEM_RECEIPT: 'item_receipt', VENDOR_BILL: 'vendor_bill', VENDOR_PAYMENT: 'vendor_payment',
  INVENTORY_ADJUSTMENT: 'inventory_adjustment', INVENTORY_TRANSFER: 'inventory_transfer',
  REQUISITION: 'requisition', RETURN_AUTH: 'return_auth', VENDOR_RETURN: 'vendor_return',
  CUSTOMER_DEPOSIT: 'customer_deposit', VENDOR_PREPAYMENT: 'vendor_prepayment',
};

export const OPEN_STATUSES = ['draft', 'pending_approval', 'open', 'partially_fulfilled', 'partially_paid', 'partially_received'];

// -------------------------------------------------------------- pricing
/** Resolve the tax rate for a code, cached per call site. */
const taxRate = (repo, code) => (code ? (repo.queryOne('SELECT rate FROM tax_code WHERE tenant_id = :t AND code = ? AND active = 1', [code])?.rate ?? 0) : 0);

/**
 * Unit price for a line, before line-level discount.
 * Order of precedence: explicit override → volume break on the customer's
 * price level → price level discount off base → item base price.
 */
export function priceFor(repo, { item, customer = null, quantity = 1_000_000, currency = null, price_level_id = null, override = null }) {
  if (override !== null && override !== undefined && override !== '') return Money.parse(override);
  const cur = currency || customer?.currency || 'USD';
  const levelId = price_level_id || customer?.price_level_id || null;

  if (levelId) {
    const break$ = repo.queryOne(`SELECT price FROM item_price WHERE tenant_id = :t AND item_id = ? AND price_level_id = ?
        AND currency = ? AND min_qty <= ? ORDER BY min_qty DESC LIMIT 1`, [item.id, levelId, cur, quantity]);
    if (break$) return break$.price;
    const level = repo.get('price_level', levelId);
    if (level?.discount_pct) return item.base_price - Money.pct(item.base_price, level.discount_pct);
  }
  const anyBreak = repo.queryOne(`SELECT ip.price FROM item_price ip JOIN price_level pl ON pl.tenant_id = ip.tenant_id AND pl.id = ip.price_level_id
      WHERE ip.tenant_id = :t AND ip.item_id = ? AND pl.is_base = 1 AND ip.currency = ? AND ip.min_qty <= ?
      ORDER BY ip.min_qty DESC LIMIT 1`, [item.id, cur, quantity]);
  if (anyBreak) return anyBreak.price;
  return item.base_price || 0;
}

/**
 * Apply active pricing rules to a priced line. Rules run in priority order;
 * a non-stackable match wins outright and stops evaluation.
 * Returns { unit_price, discount_pct, applied: [names] }.
 */
export function applyPricingRules(repo, { item, customer, line, txn, unit_price, quantity }) {
  const rules = repo.query(`SELECT * FROM pricing_rule WHERE tenant_id = :t AND active = 1
      AND (starts_on IS NULL OR starts_on <= ?) AND (ends_on IS NULL OR ends_on >= ?)
      ORDER BY priority, name`, [txn.txn_date || today(), txn.txn_date || today()]);
  if (!rules.length) return { unit_price, discount_pct: line.discount_pct || 0, applied: [] };

  const scope = {
    item: { ...item, base_price: Money.toNumber(item.base_price) },
    customer: customer ? { ...customer, credit_limit: Money.toNumber(customer.credit_limit) } : null,
    line: { quantity: Qty.toNumber(quantity), unit_price: Money.toNumber(unit_price) },
    txn: { ...txn, subtotal: Money.toNumber(txn.subtotal || 0) },
    quantity: Qty.toNumber(quantity),
    unit_price: Money.toNumber(unit_price),
  };

  let price = unit_price;
  let discount = line.discount_pct || 0;
  const applied = [];
  for (const r of rules) {
    let matched = false;
    try { matched = exprTest(r.condition, scope); }
    catch { matched = false; }              // a broken rule must not break pricing
    if (!matched) continue;
    applied.push(r.name);
    if (r.action === 'fixed_price') price = Money.parse(r.value);
    else if (r.action === 'markup_pct') price = price + Money.pct(price, r.value);
    else discount = r.stackable ? Math.min(100, discount + r.value) : Math.max(discount, r.value);
    if (!r.stackable) break;
  }
  return { unit_price: price, discount_pct: discount, applied };
}

// --------------------------------------------------------------- totals
/**
 * Normalise and price every line, then roll the document totals.
 * Line amount = qty x unitPrice, less the line discount, rounded once.
 */
export function computeLines(repo, { type, header, lines, entity = null }) {
  const out = [];
  const errors = {};
  // Pricing is a customer-side idea; the tax rate is not. Both sides of a
  // transaction have a tax position, so `entity` drives the rate while only a
  // customer drives the price.
  const customer = TYPES[type]?.entity === 'customer' ? entity : null;
  lines.forEach((given, i) => {
    // `rate` is the word the rest of the system uses for an agreed per-unit
    // price -- a project's bill rate, a service line's price, a cart price
    // already quoted to the shopper. Treat it as a synonym for unit_price:
    // ignoring it silently re-prices the line off the price list, or, on a
    // line with no item, bills the customer nothing at all.
    const raw = given.rate !== undefined && given.unit_price === undefined
      ? { ...given, unit_price: given.rate }
      : given;
    const qty = Qty.parse(raw.quantity ?? 1);
    if (qty === 0 && type !== 'INVENTORY_ADJUSTMENT') { errors[`lines.${i}.quantity`] = 'Quantity cannot be zero'; return; }

    let item = null;
    if (raw.item_id) {
      item = repo.get('item', raw.item_id);
      if (!item) { errors[`lines.${i}.item_id`] = `Item ${raw.item_id} not found`; return; }
      if (!item.active) { errors[`lines.${i}.item_id`] = `${item.sku} is inactive`; return; }
    } else if (!raw.account_id && type !== 'INVENTORY_TRANSFER') {
      errors[`lines.${i}.item_id`] = 'Select an item, or choose an account for a non-item line';
      return;
    }

    let unitPrice;
    if (item) {
      const isPurchase = TYPES[type].direction < 0;
      unitPrice = raw.unit_price !== undefined && raw.unit_price !== null && raw.unit_price !== ''
        ? Money.parse(raw.unit_price)
        : (isPurchase ? (item.purchase_price || item.standard_cost || 0)
                      : priceFor(repo, { item, customer, quantity: qty, currency: header.currency, price_level_id: header.price_level_id }));
    } else {
      unitPrice = Money.parse(raw.unit_price ?? raw.amount ?? 0);
    }

    let discountPct = Number(raw.discount_pct || 0);
    let appliedRules = [];
    if (item && TYPES[type].direction > 0 && raw.unit_price === undefined) {
      const r = applyPricingRules(repo, { item, customer, line: raw, txn: header, unit_price: unitPrice, quantity: qty });
      unitPrice = r.unit_price; discountPct = r.discount_pct; appliedRules = r.applied;
    }

    const gross = item || raw.unit_price !== undefined ? Qty.extend(qty, unitPrice) : Money.parse(raw.amount ?? 0);
    const lineDiscount = Money.pct(gross, discountPct) + Money.parse(raw.discount_amount ?? 0);
    const amount = gross - lineDiscount;

    const taxCode = raw.tax_code ?? (item?.taxable ? (entity?.tax_code || item?.tax_code || '') : '');
    const rate = item && !item.taxable ? 0 : taxRate(repo, taxCode);
    const taxAmount = TYPES[type].direction === 0 ? 0 : Money.pct(amount, rate);

    out.push({
      id: raw.id || ulid(), line_no: i + 1,
      item_id: item?.id || null, account_id: raw.account_id || null,
      description: raw.description || item?.name || '',
      quantity: qty, unit_price: unitPrice,
      unit_cost: raw.unit_cost !== undefined ? Money.parse(raw.unit_cost) : (item?.standard_cost || 0),
      discount_pct: discountPct, discount_amount: lineDiscount,
      amount, tax_code: taxCode || '', tax_rate: rate, tax_amount: taxAmount,
      location_id: raw.location_id || header.location_id || null,
      department_id: raw.department_id || header.department_id || null,
      class_id: raw.class_id || header.class_id || null,
      qty_committed: raw.qty_committed || 0, qty_fulfilled: raw.qty_fulfilled || 0,
      qty_billed: raw.qty_billed || 0, qty_received: raw.qty_received || 0,
      source_line_id: raw.source_line_id || null, is_closed: raw.is_closed ? 1 : 0,
      // A line may name its own recognition schedule and the window it covers,
      // overriding whatever the item defaults to.
      schedule_template_id: raw.schedule_template_id || null,
      service_start: raw.service_start || null, service_end: raw.service_end || null,
      custom: raw.custom || {}, _applied_rules: appliedRules, _item: item,
    });
  });
  if (Object.keys(errors).length) throw new ValidationError(errors, 'Some transaction lines are invalid');

  const subtotal = sum(out, (l) => l.amount);
  const taxTotal = sum(out, (l) => l.tax_amount);
  const headerDiscount = Money.parse(header.discount_total ?? 0);
  const shipping = Money.parse(header.shipping_total ?? 0);
  const total = subtotal - headerDiscount + taxTotal + shipping;
  return {
    lines: out,
    totals: {
      subtotal, discount_total: headerDiscount, tax_total: taxTotal,
      shipping_total: shipping, total,
    },
  };
}

// ------------------------------------------------------------ approvals
/** Does this document need approval, and by whom? */
export function approvalRoute(repo, type, header, lines) {
  const rules = repo.query('SELECT * FROM approval_rule WHERE tenant_id = :t AND txn_type = ? AND active = 1 ORDER BY sequence, name', [type]);
  if (!rules.length) return null;
  const scope = {
    txn: {
      ...header,
      total: Money.toNumber(header.total || 0),
      subtotal: Money.toNumber(header.subtotal || 0),
      discount_total: Money.toNumber(header.discount_total || 0),
    },
    total: Money.toNumber(header.total || 0),
    discount_pct: header.subtotal ? (header.discount_total / header.subtotal) * 100 : 0,
    max_line_discount: Math.max(0, ...lines.map((l) => l.discount_pct || 0)),
    line_count: lines.length,
  };
  for (const r of rules) {
    let matched = false;
    try { matched = exprTest(r.condition, scope); } catch { matched = false; }
    if (matched) return r;
  }
  return null;
}

// ---------------------------------------------------------------- read
export function getTxn(repo, id, { withLines = true, withLinks = true } = {}) {
  const t = repo.get('txn', id);
  if (!t) return null;
  if (withLines) {
    t.lines = repo.query(`SELECT tl.*, i.sku, i.name item_name, i.uom, a.number account_number, a.name account_name
        FROM txn_line tl
        LEFT JOIN item i ON i.tenant_id = tl.tenant_id AND i.id = tl.item_id
        LEFT JOIN account a ON a.tenant_id = tl.tenant_id AND a.id = tl.account_id
        WHERE tl.tenant_id = :t AND tl.txn_id = ? ORDER BY tl.line_no`, [id]);
  }
  if (withLinks) {
    t.links_out = repo.query(`SELECT tl.*, t2.type to_type, t2.txn_no to_no, t2.status to_status, t2.txn_date to_date, t2.total to_total
        FROM txn_link tl JOIN txn t2 ON t2.tenant_id = tl.tenant_id AND t2.id = tl.to_txn_id
        WHERE tl.tenant_id = :t AND tl.from_txn_id = ?`, [id]);
    t.links_in = repo.query(`SELECT tl.*, t2.type from_type, t2.txn_no from_no, t2.status from_status, t2.txn_date from_date, t2.total from_total
        FROM txn_link tl JOIN txn t2 ON t2.tenant_id = tl.tenant_id AND t2.id = tl.from_txn_id
        WHERE tl.tenant_id = :t AND tl.to_txn_id = ?`, [id]);
  }
  if (t.entity_id) {
    t.entity = t.entity_type === 'vendor' ? repo.get('vendor', t.entity_id)
      : t.entity_type === 'employee' ? repo.get('employee', t.entity_id)
      : repo.get('customer', t.entity_id);
  }
  return t;
}

export function requireTxn(repo, id, type = null) {
  const t = getTxn(repo, id);
  if (!t) throw notFound('Transaction not found');
  if (type && t.type !== type) throw badRequest(`Expected a ${TYPES[type].label}, found a ${TYPES[t.type]?.label || t.type}`);
  return t;
}

// -------------------------------------------------------------- create
export function createTxn(repo, type, input, { autoPost = true, skipApproval = false } = {}) {
  const cfg = TYPES[type];
  if (!cfg) throw badRequest(`Unknown transaction type "${type}"`);
  // Payments carry applications rather than lines and have their own path.
  if (cfg.settlement) return createPayment(repo, type, input);

  const txnDate = input.txn_date || today();
  if (!isValidDate(txnDate)) throw new ValidationError({ txn_date: 'Enter a valid date (YYYY-MM-DD)' });

  // ---- entity
  let entity = null;
  if (cfg.entity) {
    if (!input.entity_id) throw new ValidationError({ entity_id: `A ${cfg.entity} is required` });
    entity = cfg.entity === 'vendor' ? entities.getVendor(repo, input.entity_id) : entities.getCustomer(repo, input.entity_id);
  }

  const subsidiaryId = input.subsidiary_id || entity?.subsidiary_id
    || repo.queryOne('SELECT id FROM subsidiary WHERE tenant_id = :t AND active = 1 ORDER BY created_at LIMIT 1')?.id;
  if (!subsidiaryId) throw unprocessable('No subsidiary available for this transaction.');
  const currency = input.currency || entity?.currency || repo.get('subsidiary', subsidiaryId)?.currency || 'USD';

  const header = {
    type, txn_date: txnDate, currency,
    location_id: input.location_id || null, department_id: input.department_id || null,
    class_id: input.class_id || null, price_level_id: input.price_level_id || entity?.price_level_id || null,
    discount_total: input.discount_total, shipping_total: input.shipping_total,
    subtotal: 0, total: 0,
  };

  const { lines, totals } = computeLines(repo, { type, header, lines: input.lines || [], entity });
  if (!lines.length && cfg.posts) throw new ValidationError({ lines: 'Add at least one line' });
  Object.assign(header, totals);

  // ---- credit control on customer commitments
  let creditWarning = null;
  if ((type === 'SALES_ORDER' || type === 'INVOICE') && entity) {
    const check = entities.creditCheck(repo, entity.id, totals.total);
    if (!check.ok) {
      if (input.override_credit) creditWarning = check.reason;
      else throw new ValidationError({ entity_id: check.reason }, check.reason);
    }
  }

  // ---- approval routing
  let approvalStatus = 'not_required';
  let status = input.status || 'open';
  if (!skipApproval) {
    const rule = approvalRoute(repo, type, { ...header, ...totals }, lines);
    if (rule) { approvalStatus = 'pending'; status = 'pending_approval'; }
  }
  if (type === 'QUOTE' && !input.status) status = 'open';
  // Stock documents have no lifecycle of their own: once posted they are done.
  if (cfg.terminal && !input.status && status !== 'pending_approval') status = 'closed';
  if (cfg.stock === 'adjust' || cfg.stock === 'transfer') status = input.status || 'closed';

  const baseCurrency = gl.subsidiaryCurrency(repo, subsidiaryId);
  const fxRate = currency === baseCurrency ? 1 : gl.exchangeRate(repo, currency, baseCurrency, txnDate);

  const now = nowIso();
  const id = ulid();
  const txnNo = input.txn_no || nextNumber(repo, cfg.sequence);
  const terms = input.terms || entity?.terms || 'NET30';

  repo.insert('txn', {
    id, type, txn_no: txnNo, txn_date: txnDate,
    entity_type: cfg.entity, entity_id: entity?.id || null,
    subsidiary_id: subsidiaryId, location_id: input.location_id || null,
    to_location_id: input.to_location_id || null,
    department_id: input.department_id || null, class_id: input.class_id || null,
    currency, fx_rate: fxRate, memo: input.memo || '', reference: input.reference || '',
    status, approval_status: approvalStatus,
    subtotal: totals.subtotal, discount_total: totals.discount_total, tax_total: totals.tax_total,
    shipping_total: totals.shipping_total, total: totals.total,
    base_total: Money.convert(totals.total, fxRate),
    amount_applied: 0,
    amount_remaining: (cfg.receivable || cfg.payable) ? totals.total : 0,
    terms,
    due_date: input.due_date || ((cfg.receivable || cfg.payable) ? termsToDueDate(txnDate, terms) : null),
    ship_date: input.ship_date || null, ship_method: input.ship_method || '',
    tracking_no: input.tracking_no || '',
    billing_address: input.billing_address || entity?.billing_address || entity?.address || {},
    // On a purchase the goods come to us: the ship-to is the receiving site,
    // not the supplier's own address. Leaving it blank prints a purchase order
    // that never says where to deliver.
    shipping_address: input.shipping_address || entity?.shipping_address
      || (cfg.entity === 'vendor' && header.location_id ? repo.get('location', header.location_id)?.address : null)
      || {},
    source_txn_id: input.source_txn_id || null, journal_entry_id: null, period_id: null, posted: 0,
    sales_rep_id: input.sales_rep_id || entity?.sales_rep_id || null,
    price_level_id: header.price_level_id,
    opportunity_id: input.opportunity_id || null,
    probability: input.probability ?? 100, expected_close: input.expected_close || null,
    custom: input.custom || {}, created_at: now, created_by: repo.ctx?.user?.id || null, updated_at: now,
  });

  for (const l of lines) {
    repo.insert('txn_line', {
      id: l.id, txn_id: id, line_no: l.line_no, item_id: l.item_id, account_id: l.account_id,
      schedule_template_id: l.schedule_template_id || null,
      service_start: l.service_start || null, service_end: l.service_end || null,
      description: l.description, quantity: l.quantity, unit_price: l.unit_price, unit_cost: l.unit_cost,
      discount_pct: l.discount_pct, discount_amount: l.discount_amount, amount: l.amount,
      tax_code: l.tax_code, tax_rate: l.tax_rate, tax_amount: l.tax_amount,
      location_id: l.location_id, department_id: l.department_id, class_id: l.class_id,
      qty_committed: l.qty_committed, qty_fulfilled: l.qty_fulfilled, qty_billed: l.qty_billed,
      qty_received: l.qty_received, source_line_id: l.source_line_id, is_closed: l.is_closed, custom: l.custom,
    });
  }

  // ---- side effects that do not need the GL
  if (cfg.commits && status === 'open') commitLines(repo, id, +1);
  if (cfg.onOrder && status === 'open') onOrderLines(repo, id, +1);

  audit.record(repo, {
    recordType: PERM_FOR[type], recordId: id, action: 'create',
    changes: { txn_no: { from: null, to: txnNo }, total: { from: null, to: Money.toNumber(totals.total) }, status: { from: null, to: status } },
  });
  reindexTxn(repo, id);

  // ---- posting
  if (autoPost && cfg.posts && status !== 'pending_approval') postTxn(repo, id);

  const result = getTxn(repo, id);
  if (creditWarning) result.warnings = [creditWarning];
  return result;
}

export function updateTxn(repo, id, patch) {
  const before = requireTxn(repo, id);
  if (before.posted) throw unprocessable(`${TYPES[before.type].label} ${before.txn_no} is posted. Void it and re-enter, or issue a correcting document — posted transactions are not editable.`);
  if (['closed', 'cancelled', 'voided'].includes(before.status)) throw unprocessable(`${before.txn_no} is ${before.status} and cannot be edited.`);

  const cfg = TYPES[before.type];
  const entity = before.entity_id ? (cfg.entity === 'vendor' ? repo.get('vendor', before.entity_id) : repo.get('customer', before.entity_id)) : null;

  // Release existing reservations before re-computing them.
  if (cfg.commits && before.status === 'open') commitLines(repo, id, -1);
  if (cfg.onOrder && before.status === 'open') onOrderLines(repo, id, -1);

  const header = {
    type: before.type, txn_date: patch.txn_date || before.txn_date, currency: patch.currency || before.currency,
    location_id: patch.location_id ?? before.location_id, department_id: patch.department_id ?? before.department_id,
    class_id: patch.class_id ?? before.class_id,
    discount_total: patch.discount_total ?? before.discount_total,
    shipping_total: patch.shipping_total ?? before.shipping_total,
    subtotal: 0, total: 0,
  };
  const rawLines = patch.lines || before.lines;
  const { lines, totals } = computeLines(repo, { type: before.type, header, lines: rawLines, entity });

  repo.exec('DELETE FROM txn_line WHERE tenant_id = :t AND txn_id = ?', [id]);
  for (const l of lines) {
    repo.insert('txn_line', {
      id: l.id, txn_id: id, line_no: l.line_no, item_id: l.item_id, account_id: l.account_id,
      schedule_template_id: l.schedule_template_id || null,
      service_start: l.service_start || null, service_end: l.service_end || null,
      description: l.description, quantity: l.quantity, unit_price: l.unit_price, unit_cost: l.unit_cost,
      discount_pct: l.discount_pct, discount_amount: l.discount_amount, amount: l.amount,
      tax_code: l.tax_code, tax_rate: l.tax_rate, tax_amount: l.tax_amount,
      location_id: l.location_id, department_id: l.department_id, class_id: l.class_id,
      qty_committed: l.qty_committed, qty_fulfilled: l.qty_fulfilled, qty_billed: l.qty_billed,
      qty_received: l.qty_received, source_line_id: l.source_line_id, is_closed: l.is_closed, custom: l.custom,
    });
  }

  const terms = patch.terms || before.terms;
  const fxRate = header.currency === gl.subsidiaryCurrency(repo, before.subsidiary_id) ? 1 : gl.exchangeRate(repo, header.currency, gl.subsidiaryCurrency(repo, before.subsidiary_id), header.txn_date);
  repo.update('txn', id, {
    txn_date: header.txn_date, currency: header.currency, fx_rate: fxRate,
    memo: patch.memo ?? before.memo, reference: patch.reference ?? before.reference,
    location_id: header.location_id, department_id: header.department_id, class_id: header.class_id,
    subtotal: totals.subtotal, discount_total: totals.discount_total, tax_total: totals.tax_total,
    shipping_total: totals.shipping_total, total: totals.total,
    base_total: Money.convert(totals.total, fxRate),
    amount_remaining: (cfg.receivable || cfg.payable) ? totals.total - (before.amount_applied || 0) : 0,
    terms, due_date: patch.due_date ?? ((cfg.receivable || cfg.payable) ? termsToDueDate(header.txn_date, terms) : before.due_date),
    ship_date: patch.ship_date ?? before.ship_date, ship_method: patch.ship_method ?? before.ship_method,
    tracking_no: patch.tracking_no ?? before.tracking_no,
    shipping_address: patch.shipping_address ?? before.shipping_address,
    billing_address: patch.billing_address ?? before.billing_address,
    sales_rep_id: patch.sales_rep_id ?? before.sales_rep_id,
    custom: patch.custom ?? before.custom,
    updated_at: nowIso(),
  });

  if (cfg.commits && before.status === 'open') commitLines(repo, id, +1);
  if (cfg.onOrder && before.status === 'open') onOrderLines(repo, id, +1);

  const after = getTxn(repo, id);
  audit.record(repo, { recordType: PERM_FOR[before.type], recordId: id, action: 'update', before, after });
  reindexTxn(repo, id);
  return after;
}

function commitLines(repo, txnId, sign) {
  const t = repo.get('txn', txnId);
  const lines = repo.query('SELECT * FROM txn_line WHERE tenant_id = :t AND txn_id = ?', [txnId]);
  for (const l of lines) {
    if (!l.item_id) continue;
    const remaining = l.quantity - (l.qty_fulfilled || 0);
    if (remaining <= 0) continue;
    inv.commit(repo, l.item_id, l.location_id || t.location_id, sign * remaining);
  }
}
function onOrderLines(repo, txnId, sign) {
  const t = repo.get('txn', txnId);
  const lines = repo.query('SELECT * FROM txn_line WHERE tenant_id = :t AND txn_id = ?', [txnId]);
  for (const l of lines) {
    if (!l.item_id) continue;
    const remaining = l.quantity - (l.qty_received || 0);
    if (remaining <= 0) continue;
    inv.changeOnOrder(repo, l.item_id, l.location_id || t.location_id, sign * remaining);
  }
}

export function reindexTxn(repo, id) {
  const t = repo.get('txn', id);
  if (!t) return;
  const entityName = t.entity_id ? (t.entity_type === 'vendor' ? repo.get('vendor', t.entity_id)?.name : repo.get('customer', t.entity_id)?.name) : '';
  const lines = repo.query('SELECT description FROM txn_line WHERE tenant_id = :t AND txn_id = ?', [id]);
  indexRecord(repo, 'txn', id, {
    title: `${t.txn_no} · ${TYPES[t.type]?.label || t.type}`,
    subtitle: `${entityName || ''} ${Money.format(t.total, t.currency)} · ${t.txn_date}`.trim(),
    body: [t.memo, t.reference, entityName, ...lines.map((l) => l.description)].filter(Boolean).join(' '),
  });
}

// ------------------------------------------------------------ approvals
export function approveTxn(repo, id, { note = '' } = {}) {
  const t = requireTxn(repo, id);
  if (t.approval_status !== 'pending') throw unprocessable(`${t.txn_no} is not awaiting approval.`);
  repo.update('txn', id, {
    approval_status: 'approved', approved_by: repo.ctx?.user?.id || null, approved_at: nowIso(),
    status: 'open', updated_at: nowIso(),
  });
  const cfg = TYPES[t.type];
  if (cfg.commits) commitLines(repo, id, +1);
  if (cfg.onOrder) onOrderLines(repo, id, +1);
  audit.record(repo, { recordType: PERM_FOR[t.type], recordId: id, action: 'approve', changes: { approval_status: { from: 'pending', to: 'approved' }, ...(note ? { note: { from: null, to: note } } : {}) } });
  if (cfg.posts) postTxn(repo, id);
  return getTxn(repo, id);
}

export function rejectTxn(repo, id, { reason = '' } = {}) {
  const t = requireTxn(repo, id);
  if (t.approval_status !== 'pending') throw unprocessable(`${t.txn_no} is not awaiting approval.`);
  repo.update('txn', id, { approval_status: 'rejected', status: 'rejected', updated_at: nowIso() });
  audit.record(repo, { recordType: PERM_FOR[t.type], recordId: id, action: 'reject', changes: { reason: { from: null, to: reason } } });
  return getTxn(repo, id);
}

// -------------------------------------------------------------- posting
/**
 * Build the journal for a document. This function is the single place where
 * "what does this document do to the books" is expressed, which is what makes
 * the accounting reviewable rather than scattered through the codebase.
 */
/**
 * What the settled documents are actually carrying in the base ledger.
 *
 * A payment is in one currency at one rate; the invoices it clears may each
 * have gone on the books at a different rate. Relieving them at the payment's
 * rate would leave the control account holding a balance for documents that
 * are fully paid, so each application is valued at the rate its own document
 * used, and the difference is realised exchange gain or loss.
 */
function settlementBase(repo, t) {
  const links = repo.query(
    `SELECT tl.amount, x.fx_rate, x.amount_remaining FROM txn_link tl
     JOIN txn x ON x.tenant_id = tl.tenant_id AND x.id = tl.to_txn_id
     WHERE tl.tenant_id = :t AND tl.from_txn_id = ? AND tl.link_type = 'applied'`, [t.id]);
  const applied = sum(links, (l) => l.amount);
  const unapplied = Math.max(0, t.total - applied);
  // Relief is measured as the change in what the document is carrying, not as
  // the applied amount converted on its own. The two differ by a penny
  // whenever a part-payment lands mid-rounding, and that penny never goes
  // away: it leaves the control account holding a balance for a document the
  // subledger says is settled. Measured this way the reliefs telescope --
  // each one is exactly the drop in the document's carrying value, so the sum
  // of them is always the original debit and the control always agrees.
  const base = sum(links, (l) => {
    const rate = l.fx_rate || 1;
    const after = l.amount_remaining || 0;
    return Money.convert(after + l.amount, rate) - Money.convert(after, rate);
  }) + Money.convert(unapplied, t.fx_rate || 1);
  // Positive means the cash was worth more than the documents it cleared.
  return { base, applied, fxDifference: Money.convert(t.total, t.fx_rate || 1) - base };
}

export function postingPlan(repo, t, lines, acc) {
  const L = [];
  const push = (accountId, debit, credit, extra = {}) => {
    if (!accountId) throw unprocessable(`No GL account is configured for part of ${t.txn_no}. Check the item's account mapping and the default posting accounts under Setup.`);
    if (!debit && !credit) return;
    L.push({ account_id: accountId, debit: debit || 0, credit: credit || 0, ...extra });
  };
  /**
   * A line whose amount is a cost the stock ledger already settled, in the
   * subsidiary's own currency. Converting it again would leave the inventory
   * account and the stock behind it carrying different numbers, so the base
   * amount is stated outright and the document-currency figure derived from
   * it rather than the other way round.
   */
  const rate = t.fx_rate || 1;
  const inDocCurrency = (base) => (rate === 1 ? base : Math.round(base / rate));
  const pushCost = (accountId, baseDebit, baseCredit, extra = {}) => {
    if (!accountId) throw unprocessable(`No GL account is configured for part of ${t.txn_no}. Check the item's account mapping and the default posting accounts under Setup.`);
    if (!baseDebit && !baseCredit) return;
    L.push({
      account_id: accountId,
      debit: inDocCurrency(baseDebit || 0), credit: inDocCurrency(baseCredit || 0),
      base_debit: baseDebit || 0, base_credit: baseCredit || 0, ...extra,
    });
  };

  /** A base-currency-only line: no transaction-currency amount to record. */
  const pushFx = (accountId, difference, txnNo) => {
    if (!accountId || !difference) return;
    L.push({
      account_id: accountId, debit: 0, credit: 0,
      base_debit: difference < 0 ? -difference : 0,
      base_credit: difference > 0 ? difference : 0,
      memo: `Exchange ${difference > 0 ? 'gain' : 'loss'} on ${txnNo}`,
    });
  };
  const ent = { entity_type: t.entity_type, entity_id: t.entity_id };
  const seg = (l) => ({ department_id: l.department_id || t.department_id, location_id: l.location_id || t.location_id, class_id: l.class_id || t.class_id, item_id: l.item_id });

  switch (t.type) {
    case 'INVOICE': {
      push(acc.ar, t.total, 0, { ...ent, memo: 'Accounts receivable' });
      for (const l of lines) {
        const item = l.item_id ? repo.get('item', l.item_id) : null;
        const revenue = l.account_id || item?.income_account_id || (item?.type === 'service' ? acc.service_revenue : acc.product_revenue) || acc.product_revenue;
        // A line under a recognition schedule is not revenue yet. It goes to
        // the deferral account, and `applySchedules` lays down the slices that
        // will move it across, one period at a time.
        const tmpl = schedules.templateFor(repo, l, item, 'revenue');
        if (tmpl) {
          const deferral = tmpl.deferral_account_id || acc.deferred_revenue;
          if (!deferral) throw unprocessable(`${t.txn_no} defers revenue but no Deferred Revenue account is configured. Set one under Setup → Posting Accounts.`);
          l._defer = { kind: 'revenue', template: tmpl, item, target: revenue, deferral };
          push(deferral, 0, l.amount, { ...seg(l), memo: `Deferred — ${l.description}` });
          continue;
        }
        push(revenue, 0, l.amount, { ...seg(l), memo: l.description });
      }
      push(acc.discounts, t.discount_total, 0, { memo: 'Sales discount' });
      push(acc.sales_tax, 0, t.tax_total, { memo: 'Sales tax payable' });
      push(acc.shipping_income, 0, t.shipping_total, { memo: 'Shipping' });
      break;
    }
    case 'CREDIT_MEMO': {
      push(acc.ar, 0, t.total, { ...ent, memo: 'Credit to customer' });
      for (const l of lines) {
        const item = l.item_id ? repo.get('item', l.item_id) : null;
        const revenue = l.account_id || item?.income_account_id || acc.product_revenue;
        push(revenue, l.amount, 0, { ...seg(l), memo: l.description });
      }
      push(acc.discounts, 0, t.discount_total, {});
      push(acc.sales_tax, t.tax_total, 0, {});
      push(acc.shipping_income, t.shipping_total, 0, {});
      break;
    }
    case 'CUSTOMER_DEPOSIT': {
      const bank = t.custom?.bank_account_id
        ? repo.get('bank_account', t.custom.bank_account_id)?.account_id
        : (t.custom?.undeposited ? acc.undeposited : acc.bank);
      const held = acc.customer_deposits;
      if (!held) throw unprocessable(`${t.txn_no} needs a Customer Deposits account. Add account 2350 to the chart.`);
      push(bank || acc.bank, t.total, 0, { memo: `Deposit ${t.txn_no}` });
      push(held, 0, t.total, { ...ent, memo: 'Held against future delivery' });
      break;
    }
    case 'VENDOR_PREPAYMENT': {
      const bank = t.custom?.bank_account_id
        ? repo.get('bank_account', t.custom.bank_account_id)?.account_id
        : acc.bank;
      const held = acc.supplier_prepayments;
      if (!held) throw unprocessable(`${t.txn_no} needs a Supplier Prepayments account. Add account 1260 to the chart.`);
      push(held, t.total, 0, { ...ent, memo: 'Paid before delivery' });
      push(bank || acc.bank, 0, t.total, { memo: `Prepayment ${t.txn_no}` });
      break;
    }
    case 'CUSTOMER_PAYMENT': {
      // A write-off settles the invoice without any cash: the debit is the
      // loss rather than the bank. Everything downstream -- relieving the
      // receivable at the rate it was booked at, closing the document,
      // keeping the control account tied to the invoices behind it -- is
      // identical to a payment, which is why it is one.
      const bank = t.custom?.write_off_account_id
        || (t.custom?.bank_account_id ? repo.get('bank_account', t.custom.bank_account_id)?.account_id : null)
        || (t.custom?.undeposited ? acc.undeposited : acc.bank);
      push(bank || acc.bank, t.total, 0, { memo: t.custom?.write_off_account_id ? `Written off — ${t.txn_no}` : `Payment ${t.txn_no}` });
      const ar = settlementBase(repo, t);
      push(acc.ar, 0, t.total, { ...ent, memo: 'Applied to receivables', base_credit: ar.base, base_debit: 0 });
      // The cash came in at today's rate; the receivable went on the books at
      // the rate on the invoice. The gap between them is a real gain or loss,
      // not a rounding artefact, and it belongs in the ledger by name.
      if (ar.fxDifference) pushFx(acc.fx || acc.rounding, ar.fxDifference, t.txn_no);
      break;
    }
    case 'VENDOR_BILL': {
      for (const l of lines) {
        const item = l.item_id ? repo.get('item', l.item_id) : null;
        const target = l.account_id
          || (item && inv.isStocked(item) ? (item.asset_account_id || acc.inventory) : (item?.expense_account_id || acc.cogs));
        // Where the bill received the stock itself, book what the stock ledger
        // actually took in -- rounding a net unit cost back out over the
        // quantity can land a penny away from the billed amount, and that
        // penny is a purchase price variance, not a silent drift between the
        // inventory account and the stock it is supposed to represent.
        // A prepayment -- a year of insurance, a support renewal -- is an
        // asset until the months it covers arrive.
        const tmpl = schedules.templateFor(repo, l, item, 'expense');
        if (tmpl && l._value === undefined) {
          const deferral = tmpl.deferral_account_id || acc.prepaid_expenses;
          if (!deferral) throw unprocessable(`${t.txn_no} spreads a cost but no Prepaid Expenses account is configured. Set one under Setup → Posting Accounts.`);
          l._defer = { kind: 'expense', template: tmpl, item, target, deferral };
          push(deferral, l.amount, 0, { ...seg(l), memo: `Prepaid — ${l.description}` });
          continue;
        }
        if (l._value !== undefined) {
          pushCost(target, l._value, 0, { ...seg(l), memo: l.description });
          const residue = l.amount - inDocCurrency(l._value);
          if (residue) push(acc.purchase_variance || acc.cogs, residue, 0, { ...seg(l), memo: `Purchase price variance ${l.description}` });
          continue;
        }
        push(target, l.amount, 0, { ...seg(l), memo: l.description });
      }
      push(acc.sales_tax, t.tax_total, 0, { memo: 'Recoverable tax' });
      push(acc.shipping_income && acc.cogs, t.shipping_total, 0, { memo: 'Freight' });
      push(acc.ap, 0, t.total, { ...ent, memo: 'Accounts payable' });
      break;
    }
    case 'VENDOR_PAYMENT': {
      const bank = t.custom?.bank_account_id ? repo.get('bank_account', t.custom.bank_account_id)?.account_id : acc.bank;
      const ap = settlementBase(repo, t);
      push(acc.ap, t.total, 0, { ...ent, memo: 'Payable settled', base_debit: ap.base, base_credit: 0 });
      push(bank || acc.bank, 0, t.total, { memo: `Payment ${t.txn_no}` });
      if (ap.fxDifference) pushFx(acc.fx || acc.rounding, -ap.fxDifference, t.txn_no);
      break;
    }
    case 'FULFILLMENT': {
      // Valued at moving-average cost captured during the stock movement.
      for (const l of lines) {
        const cost = l._cogs || 0;
        if (!cost) continue;
        const item = l.item_id ? repo.get('item', l.item_id) : null;
        pushCost(item?.cogs_account_id || acc.cogs, cost, 0, { ...seg(l), memo: `COGS ${l.description}` });
        pushCost(item?.asset_account_id || acc.inventory, 0, cost, { ...seg(l), memo: `Inventory relief ${l.description}` });
      }
      break;
    }
    case 'ITEM_RECEIPT': {
      for (const l of lines) {
        const value = l._value || 0;
        if (!value) continue;
        const item = l.item_id ? repo.get('item', l.item_id) : null;
        pushCost(item?.asset_account_id || acc.inventory, value, 0, { ...seg(l), memo: `Received ${l.description}` });
        pushCost(acc.accrued_receipts, 0, value, { ...ent, ...seg(l), memo: 'Accrued inventory receipts' });
      }
      break;
    }
    case 'VENDOR_RETURN': {
      // Goods go back to the supplier: stock leaves at what it is carried at,
      // the vendor owes the price that was billed, and the gap between the two
      // is a purchase price variance rather than a silent tweak to inventory.
      let relieved = 0;
      for (const l of lines) {
        const cost = l._cogs || 0;
        if (!cost) continue;
        const item = l.item_id ? repo.get('item', l.item_id) : null;
        pushCost(item?.asset_account_id || acc.inventory, 0, cost, { ...seg(l), memo: `Returned ${l.description}` });
        relieved += inDocCurrency(cost);
      }
      push(acc.ap, t.total, 0, { ...ent, memo: 'Credit due from vendor' });
      const variance = t.total - relieved;
      if (variance > 0) push(acc.purchase_variance || acc.cogs, 0, variance, { memo: 'Purchase price variance' });
      if (variance < 0) push(acc.purchase_variance || acc.cogs, -variance, 0, { memo: 'Purchase price variance' });
      break;
    }
    case 'INVENTORY_ADJUSTMENT': {
      for (const l of lines) {
        const value = l._value || 0;
        if (!value) continue;
        const item = l.item_id ? repo.get('item', l.item_id) : null;
        const assetAccount = item?.asset_account_id || acc.inventory;
        const offset = l.account_id || acc.shrinkage;
        if (value > 0) { pushCost(assetAccount, value, 0, { ...seg(l), memo: l.description }); pushCost(offset, 0, value, { ...seg(l), memo: 'Inventory adjustment' }); }
        else { pushCost(assetAccount, 0, -value, { ...seg(l), memo: l.description }); pushCost(offset, -value, 0, { ...seg(l), memo: 'Inventory adjustment' }); }
      }
      break;
    }
    default:
      return [];
  }
  return L.filter((l) => l.debit || l.credit || l.base_debit || l.base_credit);
}

/** Post a document: move stock if it should, then write the journal. */
export function postTxn(repo, id) {
  const t = requireTxn(repo, id);
  const cfg = TYPES[t.type];
  if (!cfg.posts) return t;
  if (t.posted) throw conflict(`${t.txn_no} is already posted.`);
  if (t.approval_status === 'pending') throw unprocessable(`${t.txn_no} is awaiting approval and cannot be posted.`);

  const acc = postingAccounts(repo);
  const lines = repo.query('SELECT * FROM txn_line WHERE tenant_id = :t AND txn_id = ? ORDER BY line_no', [id]);

  // ---- stock movements first: they determine the amounts we post.
  if (cfg.stock === 'issue') {
    for (const l of lines) {
      if (!l.item_id) continue;
      const r = inv.moveStock(repo, {
        item_id: l.item_id, location_id: l.location_id || t.location_id, qty_delta: -l.quantity,
        type: 'shipment', source_type: t.type, source_id: id, txn_date: t.txn_date, memo: t.txn_no,
      });
      l._cogs = Math.abs(r.value_delta);
    }
  } else if (cfg.stock === 'receive') {
    for (const l of lines) {
      if (!l.item_id) continue;
      const r = inv.moveStock(repo, {
        item_id: l.item_id, location_id: l.location_id || t.location_id, qty_delta: l.quantity,
        // The stock ledger is kept in the subsidiary's own currency, because
        // that is the only way it can tie to the inventory account. Goods
        // bought in euros are carried at what the euros cost.
        unit_cost: Money.convert(l.unit_price, t.fx_rate || 1),
        type: 'receipt', source_type: t.type, source_id: id,
        txn_date: t.txn_date, memo: t.txn_no,
      });
      l._value = r.value_delta;
    }
  } else if (t.type === 'VENDOR_BILL') {
    // A bill raised straight against a vendor -- no purchase order, no item
    // receipt -- IS the receiving event: it is how most small purchases of
    // stock actually arrive. Without this the bill debits Inventory Asset and
    // no stock ever appears, so the control account and the stock ledger part
    // company on the first bill. Lines that carry an account are either
    // clearing an accrued receipt (the goods came in already) or being
    // expensed on purpose, and neither should move stock again.
    for (const l of lines) {
      if (!l.item_id || l.account_id) continue;
      const item = repo.get('item', l.item_id);
      if (!inv.isStocked(item)) continue;
      const baseAmount = Money.convert(l.amount, t.fx_rate || 1);
      const netUnitCost = l.quantity ? Math.round(baseAmount * 1_000_000 / l.quantity) : 0;
      const r = inv.moveStock(repo, {
        item_id: l.item_id, location_id: l.location_id || t.location_id, qty_delta: l.quantity,
        unit_cost: netUnitCost, type: 'receipt', source_type: t.type, source_id: id,
        txn_date: t.txn_date, memo: t.txn_no,
      });
      l._value = r.value_delta;
    }
  } else if (cfg.stock === 'adjust') {
    for (const l of lines) {
      if (!l.item_id) continue;
      const r = inv.moveStock(repo, {
        item_id: l.item_id, location_id: l.location_id || t.location_id, qty_delta: l.quantity,
        unit_cost: l.unit_cost || undefined, type: 'adjustment', source_type: t.type, source_id: id,
        txn_date: t.txn_date, memo: t.memo || t.txn_no,
      });
      l._value = r.value_delta;
    }
  }

  const journalLines = postingPlan(repo, t, lines, acc);
  if (!journalLines.length) {
    repo.update('txn', id, { posted: 1, updated_at: nowIso() });
    return getTxn(repo, id);
  }

  const entry = gl.postJournal(repo, {
    subsidiary_id: t.subsidiary_id, txn_date: t.txn_date, currency: t.currency, fx_rate: t.fx_rate,
    memo: `${cfg.label} ${t.txn_no}${t.memo ? ' — ' + t.memo : ''}`,
    source_type: t.type.toLowerCase(), source_id: id, lines: journalLines,
  });

  repo.update('txn', id, { posted: 1, journal_entry_id: entry.id, period_id: entry.period_id, updated_at: nowIso() });

  // The deferral is on the books; now record what will release it. This runs
  // after the journal on purpose -- a schedule for a document that failed to
  // post would be a promise about money nobody owes.
  for (const l of lines) {
    if (!l._defer) continue;
    schedules.createFromLine(repo, {
      txn: t, line: l, item: l._defer.item, kind: l._defer.kind,
      template: l._defer.template, targetAccount: l._defer.target, deferralAccount: l._defer.deferral,
    });
  }

  audit.record(repo, { recordType: PERM_FOR[t.type], recordId: id, action: 'post', changes: { journal_entry: { from: null, to: entry.entry_no } } });
  return getTxn(repo, id);
}

/** Void a posted document: reverse its journal and undo its stock movement. */
export function voidTxn(repo, id, { reason = '' } = {}) {
  const t = requireTxn(repo, id);
  if (t.status === 'voided') throw conflict(`${t.txn_no} is already voided.`);
  if (t.amount_applied > 0) throw unprocessable(`${t.txn_no} has ${Money.format(t.amount_applied, t.currency)} applied against it. Remove the applications first.`);

  const cfg = TYPES[t.type];

  // Voiding reverses the deferral. Anything already released has been in a
  // published profit and loss, and unwinding that silently would restate a
  // closed month -- so the document has to be credited, not erased.
  const released = schedules.recognisedForTxn(repo, id);
  if (released > 0) {
    throw unprocessable(`${t.txn_no} has ${Money.format(released, t.currency)} already recognised from its schedule. Raise a credit memo instead of voiding it.`);
  }
  schedules.cancelForTxn(repo, id, { reason: reason || `Void of ${t.txn_no}` });

  if (t.posted && t.journal_entry_id) gl.reverseJournal(repo, t.journal_entry_id, { memo: `Void of ${t.txn_no}${reason ? ' — ' + reason : ''}` });

  // Reverse stock movements recorded against this document.
  if (cfg.stock) {
    const moves = repo.query('SELECT * FROM inventory_txn WHERE tenant_id = :t AND source_type = ? AND source_id = ?', [t.type, id]);
    for (const m of moves) {
      inv.moveStock(repo, {
        item_id: m.item_id, location_id: m.location_id, qty_delta: -m.qty_delta,
        unit_cost: m.unit_cost, type: 'adjustment', source_type: 'void', source_id: id,
        txn_date: today(), memo: `Void of ${t.txn_no}`,
      });
    }
  }
  if (cfg.commits && ['open', 'partially_fulfilled'].includes(t.status)) commitLines(repo, id, -1);
  if (cfg.onOrder && ['open', 'partially_received'].includes(t.status)) onOrderLines(repo, id, -1);

  repo.update('txn', id, { status: 'voided', amount_remaining: 0, updated_at: nowIso() });
  audit.record(repo, { recordType: PERM_FOR[t.type], recordId: id, action: 'void', changes: { reason: { from: null, to: reason }, status: { from: t.status, to: 'voided' } } });
  return getTxn(repo, id);
}

// ================================================================
// TRANSFORMATIONS -- how one document becomes the next in the chain
// ================================================================

export const TRANSFORMS = {
  REQUISITION: ['PURCHASE_ORDER'],
  QUOTE: ['SALES_ORDER'],
  SALES_ORDER: ['FULFILLMENT', 'INVOICE'],
  PURCHASE_ORDER: ['ITEM_RECEIPT', 'VENDOR_BILL'],
  ITEM_RECEIPT: ['VENDOR_BILL'],
  INVOICE: ['CREDIT_MEMO', 'RETURN_AUTH'],
  RETURN_AUTH: ['CREDIT_MEMO'],
  VENDOR_BILL: ['VENDOR_RETURN'],
};

/** How much of a source line is still available to pull into `targetType`. */
export function remainingFor(repo, line, targetType, sourceType) {
  const qty = line.quantity || 0;
  if (line.is_closed) return 0;
  switch (targetType) {
    case 'SALES_ORDER': return qty;
    case 'FULFILLMENT': {
      const item = line.item_id ? repo.get('item', line.item_id) : null;
      if (!item || !inv.isStocked(item)) return 0;              // services are not shipped
      return Math.max(0, qty - (line.qty_fulfilled || 0));
    }
    case 'INVOICE': {
      const item = line.item_id ? repo.get('item', line.item_id) : null;
      const unbilled = Math.max(0, qty - (line.qty_billed || 0));
      // A stocked line is invoiced only for what has actually shipped.
      if (item && inv.isStocked(item) && sourceType === 'SALES_ORDER') {
        return Math.max(0, Math.min(unbilled, (line.qty_fulfilled || 0) - (line.qty_billed || 0)));
      }
      return unbilled;
    }
    case 'ITEM_RECEIPT': return Math.max(0, qty - (line.qty_received || 0));
    case 'VENDOR_BILL': {
      if (sourceType === 'ITEM_RECEIPT') return Math.max(0, qty - (line.qty_billed || 0));
      const unbilled = Math.max(0, qty - (line.qty_billed || 0));
      const item = line.item_id ? repo.get('item', line.item_id) : null;
      if (item && inv.isStocked(item)) {
        return Math.max(0, Math.min(unbilled, (line.qty_received || 0) - (line.qty_billed || 0)));
      }
      return unbilled;
    }
    case 'CREDIT_MEMO': return Math.max(0, qty - (line.qty_returned || 0));
    // A requisition becomes a PO once, in full; splitting one requisition
    // across several vendors is done by editing the PO, not by re-pulling.
    case 'PURCHASE_ORDER': return sourceType === 'REQUISITION' ? Math.max(0, qty - (line.qty_ordered || 0)) : qty;
    case 'RETURN_AUTH': return Math.max(0, qty - (line.qty_returned || 0));
    case 'VENDOR_RETURN': {
      // Sending goods back is measured against the document in hand: a bill
      // line is returnable for what it billed, a receipt line for what it
      // received. Services cannot be put back on a lorry.
      const item = line.item_id ? repo.get('item', line.item_id) : null;
      if (item && !inv.isStocked(item)) return 0;
      const had = sourceType === 'ITEM_RECEIPT' ? (line.qty_received || 0) : qty;
      return Math.max(0, had - (line.qty_returned || 0));
    }
    default: return qty;
  }
}

/** Preview what a transformation would pull, so the UI can pre-fill it. */
export function transformPreview(repo, sourceId, targetType) {
  const src = requireTxn(repo, sourceId);
  if (!(TRANSFORMS[src.type] || []).includes(targetType)) {
    throw badRequest(`A ${TYPES[src.type].label} cannot become a ${TYPES[targetType]?.label || targetType}`);
  }
  const lines = src.lines.map((l) => ({
    source_line_id: l.id, item_id: l.item_id, account_id: l.account_id, sku: l.sku,
    description: l.description, uom: l.uom,
    ordered: l.quantity, already: targetType === 'FULFILLMENT' ? l.qty_fulfilled : targetType === 'ITEM_RECEIPT' ? l.qty_received : l.qty_billed,
    quantity: remainingFor(repo, l, targetType, src.type),
    unit_price: l.unit_price, discount_pct: l.discount_pct, tax_code: l.tax_code,
    location_id: l.location_id, department_id: l.department_id, class_id: l.class_id,
  }));
  return { source: src, target_type: targetType, lines: lines.filter((l) => l.quantity > 0), all_lines: lines };
}

/**
 * Execute a transformation. `input.lines` may narrow quantities (partial
 * shipment, partial billing); omitted lines default to everything remaining.
 */
export function transform(repo, sourceId, targetType, input = {}) {
  const src = requireTxn(repo, sourceId);
  const cfg = TYPES[targetType];
  if (!(TRANSFORMS[src.type] || []).includes(targetType)) {
    throw badRequest(`A ${TYPES[src.type].label} cannot become a ${cfg?.label || targetType}`);
  }
  if (['voided', 'cancelled', 'rejected'].includes(src.status)) throw unprocessable(`${src.txn_no} is ${src.status}.`);
  if (src.approval_status === 'pending') throw unprocessable(`${src.txn_no} is still awaiting approval.`);

  if (input.lines !== undefined && input.lines !== null && !Array.isArray(input.lines)) {
    throw new ValidationError({ lines: 'Lines must be a list' });
  }
  const requested = new Map((input.lines || []).map((l) => [l.source_line_id || l.id, l]));
  const newLines = [];
  for (const l of src.lines) {
    const avail = remainingFor(repo, l, targetType, src.type);
    if (avail <= 0 && requested.size === 0) continue;
    const req = requested.size ? requested.get(l.id) : { quantity: Qty.toNumber(avail) };
    if (!req) continue;
    const qty = req.quantity === undefined ? avail : Qty.parse(req.quantity);
    if (qty <= 0) continue;
    if (qty > avail) {
      throw new ValidationError({ [`lines.${l.line_no}.quantity`]: `Only ${Qty.format(avail)} remaining on line ${l.line_no}` },
        `Line ${l.line_no} requests ${Qty.format(qty)} but only ${Qty.format(avail)} remains on ${src.txn_no}.`);
    }
    // Billing stock that has already arrived clears the accrual the receipt
    // raised, rather than debiting inventory a second time. That is true
    // whether the bill is pulled from the receipt or straight from the order:
    // a stocked order line can only be billed for what has been received
    // (see remainingFor), so by the time it is billable the accrual exists.
    const billedItem = targetType === 'VENDOR_BILL' && l.item_id ? repo.get('item', l.item_id) : null;
    const clearsAccrual = targetType === 'VENDOR_BILL'
      && (src.type === 'ITEM_RECEIPT' || (src.type === 'PURCHASE_ORDER' && billedItem && inv.isStocked(billedItem)));

    newLines.push({
      item_id: l.item_id,
      account_id: clearsAccrual
        ? postingAccounts(repo).accrued_receipts
        : (req.account_id ?? l.account_id),
      description: l.description,
      quantity: Qty.toNumber(qty),
      unit_price: Money.toNumber(req.unit_price !== undefined ? Money.parse(req.unit_price) : l.unit_price),
      unit_cost: Money.toNumber(l.unit_cost),
      discount_pct: l.discount_pct,
      tax_code: targetType === 'FULFILLMENT' ? '' : l.tax_code,
      location_id: req.location_id || l.location_id || src.location_id,
      department_id: l.department_id, class_id: l.class_id,
      source_line_id: l.id,
    });
  }
  if (!newLines.length) throw unprocessable(`Nothing remains on ${src.txn_no} to turn into a ${cfg.label}.`);

  const created = createTxn(repo, targetType, {
    entity_id: src.entity_id, subsidiary_id: src.subsidiary_id, currency: src.currency,
    txn_date: input.txn_date || today(),
    location_id: input.location_id || src.location_id,
    department_id: src.department_id, class_id: src.class_id,
    memo: input.memo || src.memo, reference: input.reference || src.txn_no,
    terms: input.terms || src.terms,
    shipping_total: input.shipping_total ?? (targetType === 'INVOICE' ? src.shipping_total : 0),
    discount_total: input.discount_total ?? 0,
    billing_address: src.billing_address, shipping_address: src.shipping_address,
    ship_method: input.ship_method || src.ship_method, tracking_no: input.tracking_no || '',
    sales_rep_id: src.sales_rep_id, opportunity_id: src.opportunity_id,
    source_txn_id: src.id, price_level_id: src.price_level_id,
    lines: newLines, custom: input.custom || {},
  }, { autoPost: input.autoPost !== false, skipApproval: input.skipApproval ?? (targetType === 'FULFILLMENT' || targetType === 'ITEM_RECEIPT') });

  // ---- link and advance the source
  repo.insert('txn_link', {
    id: ulid(), from_txn_id: src.id, to_txn_id: created.id,
    link_type: targetType === 'FULFILLMENT' ? 'fulfils' : targetType === 'ITEM_RECEIPT' ? 'receives'
      : ['INVOICE', 'VENDOR_BILL'].includes(targetType) ? 'bills' : 'derives',
    amount: created.total, created_at: nowIso(),
  });

  // Without recording progress the source never closes, and the same invoice
  // could be credited — or the same bill returned — over and over.
  const progressField = targetType === 'FULFILLMENT' ? 'qty_fulfilled'
    : targetType === 'ITEM_RECEIPT' ? 'qty_received'
    : ['INVOICE', 'VENDOR_BILL'].includes(targetType) ? 'qty_billed'
    : ['CREDIT_MEMO', 'RETURN_AUTH', 'VENDOR_RETURN'].includes(targetType) ? 'qty_returned'
    : targetType === 'PURCHASE_ORDER' ? 'qty_ordered' : null;

  if (progressField) {
    for (const cl of created.lines) {
      if (!cl.source_line_id) continue;
      const sl = src.lines.find((x) => x.id === cl.source_line_id);
      if (!sl) continue;
      repo.exec(`UPDATE txn_line SET ${progressField} = ${progressField} + ? WHERE tenant_id = :t AND id = ?`, [cl.quantity, sl.id]);
      // Shipping releases the reservation it was holding.
      if (targetType === 'FULFILLMENT' && sl.item_id) inv.release(repo, sl.item_id, sl.location_id || src.location_id, cl.quantity);
      if (targetType === 'ITEM_RECEIPT' && sl.item_id) inv.changeOnOrder(repo, sl.item_id, sl.location_id || src.location_id, -cl.quantity);
    }
    // Cascade billing progress from a receipt back onto its purchase order.
    if (targetType === 'VENDOR_BILL' && src.type === 'ITEM_RECEIPT' && src.source_txn_id) {
      for (const cl of created.lines) {
        const rl = src.lines.find((x) => x.id === cl.source_line_id);
        if (rl?.source_line_id) repo.exec('UPDATE txn_line SET qty_billed = qty_billed + ? WHERE tenant_id = :t AND id = ?', [cl.quantity, rl.source_line_id]);
      }
      refreshStatus(repo, src.source_txn_id);
    }
  }
  if (src.type === 'QUOTE' && targetType === 'SALES_ORDER') {
    repo.update('txn', src.id, { status: 'closed', updated_at: nowIso() });
  } else {
    refreshStatus(repo, src.id);
  }

  audit.record(repo, {
    recordType: PERM_FOR[src.type], recordId: src.id, action: 'transform',
    changes: { created: { from: null, to: `${created.txn_no} (${cfg.label})` } },
  });
  return created;
}

/** Recompute a document's lifecycle status from its line progress. */
export function refreshStatus(repo, id) {
  const t = repo.get('txn', id);
  if (!t || ['voided', 'cancelled', 'rejected'].includes(t.status)) return t;
  const lines = repo.query('SELECT * FROM txn_line WHERE tenant_id = :t AND txn_id = ?', [id]);
  if (!lines.length) return t;

  const stockLines = lines.filter((l) => { const it = l.item_id ? repo.get('item', l.item_id) : null; return it && inv.isStocked(it); });
  const fully = (arr, field) => arr.length > 0 && arr.every((l) => (l[field] || 0) >= l.quantity || l.is_closed);
  const partly = (arr, field) => arr.some((l) => (l[field] || 0) > 0);

  let status = t.status;
  if (t.type === 'SALES_ORDER') {
    const shipped = stockLines.length ? fully(stockLines, 'qty_fulfilled') : true;
    const billed = fully(lines, 'qty_billed');
    if (billed && shipped) status = 'closed';
    else if (billed) status = 'billed';
    else if (shipped && stockLines.length) status = 'fulfilled';
    else if (partly(stockLines, 'qty_fulfilled')) status = 'partially_fulfilled';
    else if (t.approval_status !== 'pending') status = 'open';
  } else if (t.type === 'PURCHASE_ORDER') {
    const received = stockLines.length ? fully(stockLines, 'qty_received') : true;
    const billed = fully(lines, 'qty_billed');
    if (billed && received) status = 'closed';
    else if (billed) status = 'billed';
    else if (received && stockLines.length) status = 'received';
    else if (partly(lines, 'qty_received')) status = 'partially_received';
    else if (t.approval_status !== 'pending') status = 'open';
  }
  if (status !== t.status) repo.update('txn', id, { status, updated_at: nowIso() });
  return repo.get('txn', id);
}

// ================================================================
// SETTLEMENT -- payments and their application to open documents
// ================================================================

/**
 * Record a payment and apply it. Applications are validated against each
 * target's remaining balance so a document can never be over-applied, and
 * everything happens in one transaction with the GL posting.
 */
export function createPayment(repo, type, input) {
  const cfg = TYPES[type];
  if (!cfg?.settlement) throw badRequest(`${type} is not a payment type`);

  const entity = cfg.entity === 'vendor' ? entities.getVendor(repo, input.entity_id) : entities.getCustomer(repo, input.entity_id);
  const txnDate = input.txn_date || today();
  if (!isValidDate(txnDate)) throw new ValidationError({ txn_date: 'Enter a valid date' });

  // Two lines against the same invoice are one application of their sum. Left
  // separate, each passes the remaining-balance check on its own and the
  // document ends up over-applied, with the receivables control account no
  // longer agreeing with the invoices behind it.
  const byTarget = new Map();
  for (const a of input.applications || []) {
    const amount = Money.parse(a.amount);
    if (amount <= 0) continue;
    byTarget.set(a.txn_id, (byTarget.get(a.txn_id) || 0) + amount);
  }
  let applications = [...byTarget].map(([txn_id, amount]) => ({ txn_id, amount }));
  let amount = input.amount !== undefined && input.amount !== null && input.amount !== ''
    ? Money.parse(input.amount)
    : sum(applications, (a) => a.amount);
  if (amount <= 0) throw new ValidationError({ amount: 'Enter a payment amount greater than zero' });

  // ---- auto-apply oldest first when the caller did not specify
  const targetType = cfg.entity === 'customer' ? 'INVOICE' : 'VENDOR_BILL';
  // A deposit is taken BEFORE there is anything to apply it to, so it stays
  // unapplied until somebody says which document it belongs to. Sweeping it
  // onto the oldest open invoice would be the one thing a deposit is not.
  if (!applications.length && !cfg.deposit && input.auto_apply !== false) {
    let left = amount;
    const open = repo.query(`SELECT * FROM txn WHERE tenant_id = :t AND type = ? AND entity_id = ? AND amount_remaining > 0
        AND status NOT IN ('voided','cancelled') ORDER BY due_date, txn_date`, [targetType, entity.id]);
    for (const o of open) {
      if (left <= 0) break;
      const applied = Math.min(left, o.amount_remaining);
      applications.push({ txn_id: o.id, amount: applied });
      left -= applied;
    }
  }

  // ---- validate each application
  const targets = [];
  for (const a of applications) {
    const target = repo.get('txn', a.txn_id);
    if (!target) throw new ValidationError({ applications: `Document ${a.txn_id} not found` });
    if (target.entity_id !== entity.id) throw new ValidationError({ applications: `${target.txn_no} belongs to a different ${cfg.entity}` });
    if (target.type !== targetType) throw new ValidationError({ applications: `${target.txn_no} is not a ${TYPES[targetType].label}` });
    if (target.currency !== (input.currency || entity.currency)) throw new ValidationError({ applications: `${target.txn_no} is in ${target.currency}; the payment is in ${input.currency || entity.currency}` });
    if (a.amount > target.amount_remaining) {
      throw new ValidationError({ applications: `${target.txn_no} has only ${Money.format(target.amount_remaining, target.currency)} outstanding` });
    }
    targets.push({ target, amount: a.amount });
  }
  const appliedTotal = sum(targets, (x) => x.amount);
  if (appliedTotal > amount) throw new ValidationError({ applications: `Applied ${Money.format(appliedTotal)} exceeds the payment of ${Money.format(amount)}` });

  const currency = input.currency || entity.currency;
  const subsidiaryId = input.subsidiary_id || entity.subsidiary_id;
  const baseCurrency = gl.subsidiaryCurrency(repo, subsidiaryId);
  const fxRate = currency === baseCurrency ? 1 : gl.exchangeRate(repo, currency, baseCurrency, txnDate);

  const now = nowIso();
  const id = ulid();
  const txnNo = input.txn_no || nextNumber(repo, cfg.sequence);
  repo.insert('txn', {
    id, type, txn_no: txnNo, txn_date: txnDate,
    entity_type: cfg.entity, entity_id: entity.id, subsidiary_id: subsidiaryId,
    currency, fx_rate: fxRate, memo: input.memo || '', reference: input.reference || '',
    status: appliedTotal < amount ? 'partially_applied' : 'closed',
    approval_status: 'not_required',
    subtotal: amount, discount_total: 0, tax_total: 0, shipping_total: 0,
    total: amount, base_total: Money.convert(amount, fxRate),
    amount_applied: appliedTotal, amount_remaining: amount - appliedTotal,
    terms: 'DUE_ON_RECEIPT', due_date: txnDate,
    custom: {
      ...(input.custom || {}),
      bank_account_id: input.bank_account_id ?? input.custom?.bank_account_id ?? null,
      undeposited: (input.undeposited ?? input.custom?.undeposited) ? 1 : 0,
      payment_method: input.payment_method || input.custom?.payment_method || 'transfer',
    },
    created_at: now, created_by: repo.ctx?.user?.id || null, updated_at: now,
    posted: 0, journal_entry_id: null, period_id: null, probability: 100,
  });

  for (const { target, amount: amt } of targets) {
    repo.insert('txn_link', { id: ulid(), from_txn_id: id, to_txn_id: target.id, link_type: 'applied', amount: amt, created_at: now });
    const newApplied = (target.amount_applied || 0) + amt;
    const newRemaining = target.total - newApplied;
    repo.update('txn', target.id, {
      amount_applied: newApplied, amount_remaining: newRemaining,
      status: newRemaining <= 0 ? 'paid' : 'partially_paid', updated_at: now,
    });
  }

  audit.record(repo, {
    recordType: PERM_FOR[type], recordId: id, action: 'create',
    changes: { txn_no: { from: null, to: txnNo }, amount: { from: null, to: Money.toNumber(amount) }, applied_to: { from: null, to: targets.map((x) => x.target.txn_no).join(', ') } },
  });
  reindexTxn(repo, id);
  postTxn(repo, id);
  return getTxn(repo, id);
}

/** Remove an application, restoring the target's outstanding balance. */
export function unapplyPayment(repo, paymentId, targetTxnId) {
  const link = repo.queryOne('SELECT * FROM txn_link WHERE tenant_id = :t AND from_txn_id = ? AND to_txn_id = ? AND link_type = \'applied\'', [paymentId, targetTxnId]);
  if (!link) throw notFound('That application does not exist.');
  const payment = requireTxn(repo, paymentId);
  const target = requireTxn(repo, targetTxnId);

  repo.remove('txn_link', link.id);
  const targetApplied = Math.max(0, (target.amount_applied || 0) - link.amount);
  repo.update('txn', targetTxnId, {
    amount_applied: targetApplied, amount_remaining: target.total - targetApplied,
    status: targetApplied <= 0 ? 'open' : 'partially_paid', updated_at: nowIso(),
  });
  const payApplied = Math.max(0, (payment.amount_applied || 0) - link.amount);
  repo.update('txn', paymentId, {
    amount_applied: payApplied, amount_remaining: payment.total - payApplied,
    status: payApplied <= 0 ? 'open' : 'partially_applied', updated_at: nowIso(),
  });
  audit.record(repo, { recordType: PERM_FOR[payment.type], recordId: paymentId, action: 'unapply', changes: { target: { from: target.txn_no, to: null }, amount: { from: Money.toNumber(link.amount), to: 0 } } });
  return getTxn(repo, paymentId);
}

/** Open documents a payment could be applied to. */
export const openDocumentsFor = (repo, entityType, entityId) =>
  repo.query(`SELECT id, txn_no, type, txn_date, due_date, currency, total, amount_applied, amount_remaining, status
      FROM txn WHERE tenant_id = :t AND entity_type = ? AND entity_id = ? AND amount_remaining > 0
      AND status NOT IN ('voided','cancelled') ORDER BY due_date, txn_date`, [entityType, entityId]);

// ================================================================
// LISTS
// ================================================================

/** Paged transaction list with the joins the grid needs. Row-filter aware. */
export function listTxns(repo, { type = null, types = null, status = null, entityId = null, from = null, to = null,
  search = null, subsidiaryId = null, locationId = null, overdueOnly = false, openOnly = false,
  limit = 100, offset = 0, order = 'txn_date DESC, txn_no DESC', rowFilterSql = '', rowFilterParams = [] } = {}) {
  const where = []; const params = [];
  if (type) { where.push('t.type = ?'); params.push(type); }
  if (types?.length) { where.push(`t.type IN (${types.map(() => '?').join(',')})`); params.push(...types); }
  if (status) { where.push(Array.isArray(status) ? `t.status IN (${status.map(() => '?').join(',')})` : 't.status = ?'); params.push(...(Array.isArray(status) ? status : [status])); }
  if (entityId) { where.push('t.entity_id = ?'); params.push(entityId); }
  if (from) { where.push('t.txn_date >= ?'); params.push(from); }
  if (to) { where.push('t.txn_date <= ?'); params.push(to); }
  if (subsidiaryId) { where.push('t.subsidiary_id = ?'); params.push(subsidiaryId); }
  if (locationId) { where.push('t.location_id = ?'); params.push(locationId); }
  if (overdueOnly) { where.push("t.amount_remaining > 0 AND t.due_date < date('now')"); }
  if (openOnly) { where.push(`t.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`); params.push(...OPEN_STATUSES); }
  if (search) { where.push('(t.txn_no LIKE ? OR t.memo LIKE ? OR t.reference LIKE ? OR c.name LIKE ? OR v.name LIKE ?)'); const s = `%${search}%`; params.push(s, s, s, s, s); }

  const ORDERS = {
    'txn_date DESC, txn_no DESC': 't.txn_date DESC, t.txn_no DESC',
    'txn_date ASC': 't.txn_date ASC', 'total DESC': 't.total DESC', 'total ASC': 't.total ASC',
    'due_date ASC': 't.due_date ASC', 'txn_no ASC': 't.txn_no ASC', 'status ASC': 't.status ASC',
  };
  const orderBy = ORDERS[order] || ORDERS['txn_date DESC, txn_no DESC'];
  const whereSql = where.length ? ' AND ' + where.join(' AND ') : '';

  const rows = repo.query(`SELECT t.*, COALESCE(c.name, v.name) entity_name, COALESCE(c.entity_no, v.entity_no) entity_no,
      s.name subsidiary_name, l.name location_name
      FROM txn t
      LEFT JOIN customer c ON c.tenant_id = t.tenant_id AND t.entity_type='customer' AND c.id = t.entity_id
      LEFT JOIN vendor v ON v.tenant_id = t.tenant_id AND t.entity_type='vendor' AND v.id = t.entity_id
      LEFT JOIN subsidiary s ON s.tenant_id = t.tenant_id AND s.id = t.subsidiary_id
      LEFT JOIN location l ON l.tenant_id = t.tenant_id AND l.id = t.location_id
      WHERE t.tenant_id = :t${whereSql}${rowFilterSql}
      ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [...params, ...rowFilterParams, Math.min(limit, 1000), offset]);

  const total = repo.scalar(`SELECT COUNT(*) c FROM txn t
      LEFT JOIN customer c ON c.tenant_id = t.tenant_id AND t.entity_type='customer' AND c.id = t.entity_id
      LEFT JOIN vendor v ON v.tenant_id = t.tenant_id AND t.entity_type='vendor' AND v.id = t.entity_id
      WHERE t.tenant_id = :t${whereSql}${rowFilterSql}`, [...params, ...rowFilterParams], 0);

  return { rows, total, limit, offset };
}
