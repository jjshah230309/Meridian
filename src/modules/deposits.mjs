// Meridian ERP :: modules/deposits
// Money that moved before there was a document to put it against.
//
// A customer pays half up front. A supplier wants payment before they ship.
// Neither event has an invoice or a bill behind it yet, so neither belongs in
// receivables or payables -- and neither is revenue or cost. A deposit is a
// liability until the goods go out; a prepayment is an asset until they
// arrive. Booking either through the ordinary settlement path overstates the
// period the cash landed in and understates the one the work happened in.
//
// Applying one later is the second half: the held balance is released and the
// real document is settled, on one dated entry that can be pointed at.
import { ulid, Money, nowIso, today, isValidDate, sum } from '../core/util.mjs';
import { ValidationError, notFound, unprocessable, conflict } from '../core/http.mjs';
import * as gl from './gl.mjs';
import * as T from './txn.mjs';
import { postingAccounts } from './setup.mjs';
import * as audit from '../core/audit.mjs';

const SIDE = {
  CUSTOMER_DEPOSIT: {
    entity: 'customer', target: 'INVOICE', held: 'customer_deposits', control: 'ar',
    noun: 'deposit', verb: 'held', against: 'invoice',
  },
  VENDOR_PREPAYMENT: {
    entity: 'vendor', target: 'VENDOR_BILL', held: 'supplier_prepayments', control: 'ap',
    noun: 'prepayment', verb: 'paid', against: 'bill',
  },
};

export const TYPES = Object.keys(SIDE);

export function createDeposit(repo, type, input = {}) {
  const side = SIDE[type];
  if (!side) throw new ValidationError({ type: `Type must be ${TYPES.join(' or ')}` });
  const acc = postingAccounts(repo);
  if (!acc[side.held]) {
    throw unprocessable(`No ${side.noun === 'deposit' ? 'Customer Deposits' : 'Supplier Prepayments'} account is configured. Add it to the chart of accounts first.`);
  }
  // createPayment already knows how to number, convert and post a settlement
  // document; a deposit is one that has not been applied to anything yet.
  return T.createPayment(repo, type, { ...input, auto_apply: false, applications: [] });
}

export function getDeposit(repo, id) {
  const d = repo.get('txn', id);
  if (!d || !SIDE[d.type]) throw notFound('Deposit not found');
  return {
    ...d,
    entity: repo.get(SIDE[d.type].entity, d.entity_id),
    applications: applicationsFor(repo, id),
  };
}

export const applicationsFor = (repo, id) => repo.query(
  `SELECT tl.id AS link_id, tl.amount, tl.created_at, t.id AS txn_id, t.txn_no, t.type,
          t.txn_date, t.total, t.amount_remaining, t.currency
   FROM txn_link tl JOIN txn t ON t.tenant_id = tl.tenant_id AND t.id = tl.to_txn_id
   WHERE tl.tenant_id = :t AND tl.from_txn_id = ? AND tl.link_type = 'applied'
   ORDER BY tl.created_at`, [id]);

/** Everything still held for an entity, oldest first. */
export const open = (repo, { type = 'CUSTOMER_DEPOSIT', entity_id = null, subsidiary_id = null } = {}) => {
  const where = ['t.tenant_id = :t', 't.type = ?', "t.status NOT IN ('voided','cancelled')", 't.posted = 1', 't.amount_remaining > 0'];
  const params = [type];
  if (entity_id) { where.push('t.entity_id = ?'); params.push(entity_id); }
  if (subsidiary_id) { where.push('t.subsidiary_id = ?'); params.push(subsidiary_id); }
  return repo.query(
    `SELECT t.*, COALESCE(c.name, v.name, '') AS entity_name, COALESCE(c.entity_no, v.entity_no, '') AS entity_no
     FROM txn t
     LEFT JOIN customer c ON c.tenant_id = t.tenant_id AND c.id = t.entity_id
     LEFT JOIN vendor v ON v.tenant_id = t.tenant_id AND v.id = t.entity_id
     WHERE ${where.join(' AND ')} ORDER BY t.txn_date, t.txn_no`, params);
};

/**
 * Put a deposit against the document it was taken for.
 *
 * The held balance comes down and the real document is settled, in one entry.
 * No cash moves: the money arrived when the deposit did, which is the whole
 * reason the deposit exists.
 */
export function applyDeposit(repo, id, { applications = [], txn_date = null, memo = '' } = {}) {
  const deposit = repo.get('txn', id);
  if (!deposit) throw notFound('Deposit not found');
  const side = SIDE[deposit.type];
  if (!side) throw unprocessable(`${deposit.txn_no} is not a deposit or a prepayment.`);
  if (deposit.status === 'voided' || deposit.status === 'cancelled') throw unprocessable(`${deposit.txn_no} is ${deposit.status}.`);
  if (deposit.amount_remaining <= 0) throw unprocessable(`${deposit.txn_no} has already been applied in full.`);

  const date = txn_date || today();
  if (!isValidDate(date)) throw new ValidationError({ txn_date: 'Enter a valid date' });
  gl.requireOpenPeriod(repo, date);

  // Two lines against the same document are one application of their sum;
  // left separate each passes the remaining-balance check on its own and the
  // document ends up over-applied.
  const byTarget = new Map();
  for (const a of applications) {
    const amount = Money.parse(a.amount);
    if (amount <= 0) continue;
    byTarget.set(a.txn_id, (byTarget.get(a.txn_id) || 0) + amount);
  }
  if (!byTarget.size) throw new ValidationError({ applications: `Choose which ${side.against} this ${side.noun} settles` });

  const errors = {};
  const targets = [];
  let applied = 0;
  [...byTarget].forEach(([txnId, amount], i) => {
    const target = repo.get('txn', txnId);
    if (!target) { errors[`applications.${i}.txn_id`] = 'That document does not exist'; return; }
    if (target.type !== side.target) { errors[`applications.${i}.txn_id`] = `${target.txn_no} is not a ${T.TYPES[side.target].label.toLowerCase()}`; return; }
    if (target.entity_id !== deposit.entity_id) { errors[`applications.${i}.txn_id`] = `${target.txn_no} belongs to somebody else`; return; }
    if (target.currency !== deposit.currency) { errors[`applications.${i}.txn_id`] = `${target.txn_no} is in ${target.currency}; the ${side.noun} is in ${deposit.currency}`; return; }
    if (amount > target.amount_remaining) {
      errors[`applications.${i}.amount`] = `${target.txn_no} has only ${Money.format(target.amount_remaining, target.currency)} outstanding`;
      return;
    }
    targets.push({ target, amount });
    applied += amount;
  });
  if (Object.keys(errors).length) throw new ValidationError(errors, `This ${side.noun} could not be applied`);
  if (applied > deposit.amount_remaining) {
    throw new ValidationError({ applications: `${deposit.txn_no} has only ${Money.format(deposit.amount_remaining, deposit.currency)} left to apply` });
  }

  const acc = postingAccounts(repo);
  const held = acc[side.held];
  const control = acc[side.control];
  if (!held || !control) throw unprocessable('The deposit or control account is not configured.');

  // Relieve each document at the rate it went on the books at, the way a
  // payment does, so the control account clears exactly.
  const lines = [];
  for (const { target, amount } of targets) {
    const rate = target.fx_rate || 1;
    const after = target.amount_remaining - amount;
    const relief = Money.convert(target.amount_remaining, rate) - Money.convert(after, rate);
    if (side.entity === 'customer') {
      lines.push({ account_id: control, debit: 0, credit: amount, base_debit: 0, base_credit: relief, entity_type: 'customer', entity_id: deposit.entity_id, memo: `Settled by ${deposit.txn_no}` });
    } else {
      lines.push({ account_id: control, debit: amount, credit: 0, base_debit: relief, base_credit: 0, entity_type: 'vendor', entity_id: deposit.entity_id, memo: `Settled by ${deposit.txn_no}` });
    }
  }
  const heldRate = deposit.fx_rate || 1;
  const heldBase = Money.convert(applied, heldRate);
  if (side.entity === 'customer') {
    lines.push({ account_id: held, debit: applied, credit: 0, base_debit: heldBase, base_credit: 0, entity_type: 'customer', entity_id: deposit.entity_id, memo: `${deposit.txn_no} applied` });
  } else {
    lines.push({ account_id: held, debit: 0, credit: applied, base_debit: 0, base_credit: heldBase, entity_type: 'vendor', entity_id: deposit.entity_id, memo: `${deposit.txn_no} applied` });
  }

  const entry = gl.postJournal(repo, {
    subsidiary_id: deposit.subsidiary_id, txn_date: date, currency: deposit.currency, fx_rate: heldRate,
    memo: memo || `${deposit.txn_no} applied to ${targets.map((t) => t.target.txn_no).join(', ')}`,
    source_type: 'deposit_application', source_id: deposit.id, lines,
  });

  const now = nowIso();
  for (const { target, amount } of targets) {
    repo.insert('txn_link', {
      id: ulid(), from_txn_id: deposit.id, to_txn_id: target.id,
      link_type: 'applied', amount, created_at: now,
    });
    const newApplied = (target.amount_applied || 0) + amount;
    const remaining = target.total - newApplied;
    repo.update('txn', target.id, {
      amount_applied: newApplied, amount_remaining: remaining,
      applied_deposit: (target.applied_deposit || 0) + amount,
      status: remaining <= 0 ? 'paid' : 'partially_paid', updated_at: now,
    });
  }
  repo.update('txn', deposit.id, {
    amount_applied: (deposit.amount_applied || 0) + applied,
    amount_remaining: deposit.amount_remaining - applied,
    status: deposit.amount_remaining - applied <= 0 ? 'closed' : 'partially_applied',
    updated_at: now,
  });

  audit.record(repo, {
    recordType: T.PERM_FOR[deposit.type], recordId: deposit.id, action: 'apply',
    changes: {
      applied: { from: null, to: Money.toNumber(applied) },
      to: { from: null, to: targets.map((t) => t.target.txn_no).join(', ') },
      entry: { from: null, to: entry.entry_no },
    },
  });
  return { deposit: getDeposit(repo, deposit.id), entry, applied };
}

/**
 * Give it back. A deposit that is refunded rather than earned goes out the
 * way it came in: the held balance is released to the bank, not to revenue.
 */
export function refundDeposit(repo, id, { amount = null, txn_date = null, bank_account_id = null, memo = '' } = {}) {
  const deposit = repo.get('txn', id);
  if (!deposit || !SIDE[deposit.type]) throw notFound('Deposit not found');
  const side = SIDE[deposit.type];
  if (deposit.amount_remaining <= 0) throw unprocessable(`${deposit.txn_no} has nothing left to refund.`);

  const value = amount === null || amount === '' ? deposit.amount_remaining : Money.parse(amount);
  if (value <= 0) throw new ValidationError({ amount: 'Enter an amount greater than zero' });
  if (value > deposit.amount_remaining) {
    throw new ValidationError({ amount: `${deposit.txn_no} has only ${Money.format(deposit.amount_remaining, deposit.currency)} left` });
  }
  const date = txn_date || today();
  if (!isValidDate(date)) throw new ValidationError({ txn_date: 'Enter a valid date' });
  gl.requireOpenPeriod(repo, date);

  const acc = postingAccounts(repo);
  const bank = bank_account_id ? repo.get('bank_account', bank_account_id)?.account_id : acc.bank;
  const held = acc[side.held];
  const outward = side.entity === 'customer';

  const entry = gl.postJournal(repo, {
    subsidiary_id: deposit.subsidiary_id, txn_date: date, currency: deposit.currency,
    fx_rate: deposit.fx_rate || 1,
    memo: memo || `Refund of ${deposit.txn_no}`,
    source_type: 'deposit_refund', source_id: deposit.id,
    lines: outward
      ? [
        { account_id: held, debit: value, credit: 0, entity_type: 'customer', entity_id: deposit.entity_id, memo: `Refund of ${deposit.txn_no}` },
        { account_id: bank || acc.bank, debit: 0, credit: value, memo: `Refund of ${deposit.txn_no}` },
      ]
      : [
        { account_id: bank || acc.bank, debit: value, credit: 0, memo: `Recovered from ${deposit.txn_no}` },
        { account_id: held, debit: 0, credit: value, entity_type: 'vendor', entity_id: deposit.entity_id, memo: `Recovered from ${deposit.txn_no}` },
      ],
  });

  const remaining = deposit.amount_remaining - value;
  repo.update('txn', deposit.id, {
    amount_remaining: remaining,
    amount_applied: (deposit.amount_applied || 0) + value,
    status: remaining <= 0 ? 'closed' : 'partially_applied',
    updated_at: nowIso(),
  });
  audit.record(repo, {
    recordType: T.PERM_FOR[deposit.type], recordId: deposit.id, action: 'refund',
    changes: { amount: { from: null, to: Money.toNumber(value) }, entry: { from: null, to: entry.entry_no } },
  });
  return { deposit: getDeposit(repo, deposit.id), entry, refunded: value };
}

/** What is being held, by entity — the balance the account should agree with. */
export function heldSummary(repo, { type = 'CUSTOMER_DEPOSIT', subsidiary_id = null } = {}) {
  const side = SIDE[type];
  if (!side) throw new ValidationError({ type: `Type must be ${TYPES.join(' or ')}` });
  const rows = open(repo, { type, subsidiary_id });
  const byEntity = new Map();
  for (const r of rows) {
    if (!byEntity.has(r.entity_id)) {
      byEntity.set(r.entity_id, { entity_id: r.entity_id, entity_no: r.entity_no, name: r.entity_name, count: 0, held: 0, currency: r.currency });
    }
    const g = byEntity.get(r.entity_id);
    g.count++;
    g.held += Money.convert(r.amount_remaining, r.fx_rate || 1);
  }
  const acc = postingAccounts(repo);
  const carried = acc[side.held]
    ? repo.scalar(
      `SELECT COALESCE(SUM(jl.base_debit - jl.base_credit), 0) v FROM journal_line jl
       JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
       WHERE jl.tenant_id = :t AND jl.account_id = ? AND je.status = 'posted'`, [acc[side.held]], 0)
    : 0;
  const held = sum([...byEntity.values()], (g) => g.held);
  return {
    type, rows: [...byEntity.values()].sort((a, b) => b.held - a.held),
    documents: rows, held,
    // Positive is what the account carries in its natural direction: a
    // liability for a customer deposit, an asset for a prepayment.
    control: side.entity === 'customer' ? -carried : carried,
    difference: (side.entity === 'customer' ? -carried : carried) - held,
  };
}
