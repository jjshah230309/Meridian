// Meridian ERP :: intercompany
//
// Trading between companies you own.
//
// The rule that shapes every function here: an intercompany transaction is
// two entries, never one. One company gives value and the other receives it,
// and each keeps its own books in its own currency. Writing only one half is
// how a group ends up with a due-from of 40,000 facing a due-to of 38,500 and
// nobody able to say which is right.
//
// So both halves are written in the same database transaction, linked by a
// register row, and the register is what the reconciliation reads. If the two
// sides ever disagree, it is because somebody posted to a control account by
// hand -- and that is exactly what the reconciliation is looking for.
//
// Elimination is the other half of the story. The group did not sell anything
// to itself, so on consolidation the intercompany balances have to come back
// out. Meridian used to do that by hiding intercompany accounts at reporting
// time, which is quick, invisible and impossible to audit. It posts real
// journal entries instead, into the elimination subsidiary, where they can be
// read, questioned and reversed like anything else.
import { ulid, Money, nowIso, today, isValidDate, sum } from '../core/util.mjs';
import { ValidationError, notFound, unprocessable, conflict, requireDate, optionalDate } from '../core/http.mjs';
import { nextNumber } from '../core/seq.mjs';
import * as gl from './gl.mjs';
import * as T from './txn.mjs';
import * as entities from './entities.mjs';
import * as audit from '../core/audit.mjs';
import { translationRates } from './consolidation.mjs';

export const KINDS = ['journal', 'sale'];

const DUE_FROM = '1190';
const DUE_TO = '2190';
const CTA = '3800';

/** The control account by number, with a message that says how to fix it. */
function control(repo, number) {
  const a = repo.queryOne('SELECT * FROM account WHERE tenant_id = :t AND number = ? AND active = 1', [number]);
  if (!a) {
    throw unprocessable(`Account ${number} is missing from the chart of accounts. Intercompany postings need ${DUE_FROM} Due from Affiliates and ${DUE_TO} Due to Affiliates; add them under Chart of Accounts.`);
  }
  return a;
}

export const getSubsidiary = (repo, id) => {
  const s = repo.get('subsidiary', id);
  if (!s) throw notFound('Subsidiary not found');
  return s;
};

/**
 * The elimination subsidiary: where cancelling entries are posted.
 *
 * It is deliberately a real subsidiary rather than a magic flag, because the
 * entries have to live somewhere that balances and reports like anywhere else.
 * It files nothing and trades with nobody.
 */
export function eliminationSubsidiary(repo, { create = false } = {}) {
  const found = repo.queryOne('SELECT * FROM subsidiary WHERE tenant_id = :t AND is_elimination = 1 AND active = 1 ORDER BY created_at LIMIT 1');
  if (found) return found;
  if (!create) {
    throw unprocessable('There is no elimination subsidiary. Create one under Subsidiaries and tick "Elimination subsidiary" — it is where the cancelling entries are posted, so they can be reviewed rather than happening invisibly at reporting time.');
  }
  const parent = repo.queryOne('SELECT * FROM subsidiary WHERE tenant_id = :t AND parent_id IS NULL ORDER BY created_at LIMIT 1');
  if (!parent) throw unprocessable('No parent subsidiary to hang an elimination subsidiary from');
  const id = repo.insert('subsidiary', {
    id: ulid(), name: 'Eliminations', legal_name: '', parent_id: parent.id,
    currency: parent.currency, country: parent.country, tax_number: '', address: {},
    is_elimination: 1, active: 1, created_at: nowIso(),
  });
  return repo.get('subsidiary', id);
}

// ------------------------------------------------------------ the register
export function getIntercompany(repo, id) {
  const ic = repo.get('intercompany_txn', id);
  if (!ic) throw notFound('Intercompany transaction not found');
  ic.from_subsidiary = repo.get('subsidiary', ic.from_subsidiary_id);
  ic.to_subsidiary = repo.get('subsidiary', ic.to_subsidiary_id);
  ic.from_entry = ic.from_entry_id ? gl.getJournalEntry(repo, ic.from_entry_id) : null;
  ic.to_entry = ic.to_entry_id ? gl.getJournalEntry(repo, ic.to_entry_id) : null;
  ic.from_txn = ic.from_txn_id ? repo.get('txn', ic.from_txn_id) : null;
  ic.to_txn = ic.to_txn_id ? repo.get('txn', ic.to_txn_id) : null;
  return ic;
}

export function list(repo, { status = null, from = null, to = null, subsidiary_id = null, limit = 200 } = {}) {
  from = optionalDate(from, 'from');
  to = optionalDate(to, 'to');
  const where = ['ic.tenant_id = :t'];
  const params = [];
  if (status && status !== 'all') { where.push('ic.status = ?'); params.push(status); }
  if (from) { where.push('ic.txn_date >= ?'); params.push(from); }
  if (to) { where.push('ic.txn_date <= ?'); params.push(to); }
  if (subsidiary_id) {
    where.push('(ic.from_subsidiary_id = ? OR ic.to_subsidiary_id = ?)');
    params.push(subsidiary_id, subsidiary_id);
  }
  const rows = repo.query(
    `SELECT ic.*, f.name AS from_name, f.currency AS from_currency,
            t2.name AS to_name, t2.currency AS to_currency
     FROM intercompany_txn ic
     JOIN subsidiary f ON f.tenant_id = ic.tenant_id AND f.id = ic.from_subsidiary_id
     JOIN subsidiary t2 ON t2.tenant_id = ic.tenant_id AND t2.id = ic.to_subsidiary_id
     WHERE ${where.join(' AND ')}
     ORDER BY ic.txn_date DESC, ic.created_at DESC LIMIT ?`, [...params, Math.min(limit, 1000)]);
  return { rows, total: rows.length };
}

// ------------------------------------------------------- the paired journal
/**
 * A recharge: one company bears a cost that belongs to another.
 *
 * `lines` describe what the transaction IS, each naming the subsidiary it
 * belongs to. The due-to and due-from sides are not asked for and cannot be
 * supplied -- they are derived, because they are the half people get wrong.
 * Each subsidiary's entry is balanced with its own affiliate control account.
 *
 *   intercompanyJournal({ from: US, to: UK, lines: [
 *     { subsidiary_id: UK, account_id: rent,   debit: 500000 },   // UK bears it
 *     { subsidiary_id: US, account_id: recharge, credit: 500000 },// US recovers it
 *   ]})
 *
 * gives the UK a rent expense and a due-to, and the US a recharge credit and
 * a due-from, on one date, linked.
 */
export function intercompanyJournal(repo, input = {}) {
  const {
    from_subsidiary_id, to_subsidiary_id, txn_date = today(),
    currency = null, memo = '', lines = [], reference = null,
  } = input;

  const errors = {};
  if (!from_subsidiary_id) errors.from_subsidiary_id = 'Choose the company giving value';
  if (!to_subsidiary_id) errors.to_subsidiary_id = 'Choose the company receiving it';
  if (from_subsidiary_id && from_subsidiary_id === to_subsidiary_id) {
    errors.to_subsidiary_id = 'A company cannot trade with itself; use an ordinary journal entry';
  }
  if (!isValidDate(txn_date)) errors.txn_date = 'Enter a valid date';
  if (!Array.isArray(lines) || !lines.length) errors.lines = 'Add at least one line';
  if (Object.keys(errors).length) throw new ValidationError(errors);

  const fromSub = getSubsidiary(repo, from_subsidiary_id);
  const toSub = getSubsidiary(repo, to_subsidiary_id);
  const txnCurrency = currency || fromSub.currency;

  // Sort each line into the company whose books it belongs in.
  const bySub = new Map([[fromSub.id, []], [toSub.id, []]]);
  const lineErrors = {};
  lines.forEach((l, i) => {
    const sid = l.subsidiary_id || fromSub.id;
    if (!bySub.has(sid)) {
      lineErrors[`lines.${i}.subsidiary_id`] = 'A line must belong to one of the two companies on this transaction';
      return;
    }
    const debit = Math.max(0, Math.trunc(l.debit || 0));
    const credit = Math.max(0, Math.trunc(l.credit || 0));
    if (!debit && !credit) { lineErrors[`lines.${i}`] = 'A line must carry a debit or a credit'; return; }
    if (debit && credit) { lineErrors[`lines.${i}`] = 'A line may carry a debit or a credit, not both'; return; }
    if (!l.account_id) { lineErrors[`lines.${i}.account_id`] = 'Account is required'; return; }
    const account = repo.get('account', l.account_id);
    if (!account) { lineErrors[`lines.${i}.account_id`] = 'Account not found'; return; }
    if (account.is_intercompany) {
      lineErrors[`lines.${i}.account_id`] = `${account.number} ${account.name} is an affiliate control account. Meridian posts both sides of that itself — enter what the transaction is for instead.`;
      return;
    }
    bySub.get(sid).push({ ...l, debit, credit });
  });
  if (Object.keys(lineErrors).length) throw new ValidationError(lineErrors);

  for (const [sid, ls] of bySub) {
    if (!ls.length) {
      const which = sid === fromSub.id ? fromSub.name : toSub.name;
      throw unprocessable(`Nothing was posted to ${which}. An intercompany transaction has two sides; if only one company is affected it is an ordinary journal entry.`);
    }
  }

  // What each company owes the other is whatever its own lines fail to
  // balance by. That is the definition, and deriving it means it can never
  // disagree with the entry it belongs to.
  const dueFromAcct = control(repo, DUE_FROM);
  const dueToAcct = control(repo, DUE_TO);
  const settlement = new Map();
  for (const [sid, ls] of bySub) {
    settlement.set(sid, sum(ls, (l) => l.debit) - sum(ls, (l) => l.credit));
  }
  const net = settlement.get(fromSub.id) + settlement.get(toSub.id);
  if (net !== 0) {
    throw unprocessable(
      `The two sides do not balance against each other: out by ${Money.format(Math.abs(net), txnCurrency)}. Every debit on one company has to face a credit on the other, or the group's books do not add up.`);
  }
  if (settlement.get(fromSub.id) === 0) {
    throw unprocessable('Nothing crosses between the two companies on this transaction, so there is no intercompany balance to record.');
  }

  const now = nowIso();
  const icId = ulid();
  const ref = reference || nextNumber(repo, 'intercompany_txn');
  const entries = {};

  for (const [sid, ls] of bySub) {
    const owing = settlement.get(sid);          // > 0 means this company owes
    const affiliate = sid === fromSub.id ? toSub : fromSub;
    const balancer = owing > 0
      ? { account_id: dueToAcct.id, credit: owing, debit: 0 }
      : { account_id: dueFromAcct.id, debit: -owing, credit: 0 };
    const entry = gl.postJournal(repo, {
      subsidiary_id: sid, txn_date, currency: txnCurrency,
      memo: memo || `Intercompany with ${affiliate.name}`,
      source_type: 'intercompany', source_id: icId,
      lines: [
        ...ls.map((l) => ({ ...l, memo: l.memo || memo || '' })),
        { ...balancer, memo: `${ref} · ${affiliate.name}` },
      ],
    });
    repo.update('journal_entry', entry.id, { intercompany_id: icId });
    entries[sid] = entry.id;
  }

  repo.insert('intercompany_txn', {
    id: icId, reference: ref, kind: 'journal', txn_date, currency: txnCurrency,
    from_subsidiary_id: fromSub.id, to_subsidiary_id: toSub.id,
    amount: Math.abs(settlement.get(fromSub.id)),
    from_entry_id: entries[fromSub.id], to_entry_id: entries[toSub.id],
    from_txn_id: null, to_txn_id: null,
    status: 'posted', elimination_run_id: null, memo: memo || '',
    created_at: now, created_by: repo.ctx?.user?.id || null,
  });

  audit.record(repo, {
    recordType: 'intercompany_txn', recordId: icId, action: 'create',
    changes: {
      reference: { from: null, to: ref },
      between: { from: null, to: `${fromSub.name} → ${toSub.name}` },
      amount: { from: null, to: Money.toNumber(Math.abs(settlement.get(fromSub.id))) },
    },
  });
  return getIntercompany(repo, icId);
}

// ---------------------------------------------------------- the paired sale
/**
 * The customer and vendor records that stand for a subsidiary.
 *
 * An intercompany sale is an ordinary invoice and an ordinary bill; what makes
 * it intercompany is that the customer on one is a company in the group and
 * the vendor on the other is the company selling. Those records are created
 * once and reused, because everything downstream -- ageing, statements,
 * payment runs -- expects a real entity to point at.
 */
export function affiliateCustomer(repo, { seller, buyer }) {
  const found = repo.queryOne(
    'SELECT * FROM customer WHERE tenant_id = :t AND represents_subsidiary_id = ? AND subsidiary_id = ? LIMIT 1',
    [buyer.id, seller.id]);
  if (found) return found;
  // Created through the ordinary path, so it gets the same numbering,
  // validation and search indexing as a customer somebody typed in. The only
  // thing that marks it out is what it represents. No tax code: trade inside
  // a group is not a supply to a third party.
  const created = entities.createCustomer(repo, {
    name: buyer.name, legal_name: buyer.legal_name || '',
    subsidiary_id: seller.id, currency: seller.currency,
    category: 'Intercompany', terms: 'NET30', tax_code: 'EXEMPT',
    status: 'active',
  });
  repo.update('customer', created.id, { represents_subsidiary_id: buyer.id });
  return repo.get('customer', created.id);
}

export function affiliateVendor(repo, { seller, buyer }) {
  const found = repo.queryOne(
    'SELECT * FROM vendor WHERE tenant_id = :t AND represents_subsidiary_id = ? AND subsidiary_id = ? LIMIT 1',
    [seller.id, buyer.id]);
  if (found) return found;
  const created = entities.createVendor(repo, {
    name: seller.name, legal_name: seller.legal_name || '',
    subsidiary_id: buyer.id, currency: seller.currency,
    category: 'Intercompany', terms: 'NET30',
    status: 'active',
  });
  repo.update('vendor', created.id, { represents_subsidiary_id: seller.id });
  return repo.get('vendor', created.id);
}

/**
 * A sale from one company in the group to another.
 *
 * Produces an invoice in the seller and a vendor bill in the buyer, for the
 * same lines. They are raised in the seller's currency: the buyer's books
 * convert at its own rate, which is exactly where a group's intercompany
 * balances drift apart, and why the reconciliation reports both figures.
 */
export function intercompanySale(repo, input = {}) {
  const {
    from_subsidiary_id, to_subsidiary_id, txn_date = today(),
    lines = [], memo = '', reference = null,
  } = input;

  const errors = {};
  if (!from_subsidiary_id) errors.from_subsidiary_id = 'Choose the selling company';
  if (!to_subsidiary_id) errors.to_subsidiary_id = 'Choose the buying company';
  if (from_subsidiary_id && from_subsidiary_id === to_subsidiary_id) {
    errors.to_subsidiary_id = 'A company cannot sell to itself';
  }
  if (!isValidDate(txn_date)) errors.txn_date = 'Enter a valid date';
  if (!Array.isArray(lines) || !lines.length) errors.lines = 'Add at least one line';
  if (Object.keys(errors).length) throw new ValidationError(errors);

  const seller = getSubsidiary(repo, from_subsidiary_id);
  const buyer = getSubsidiary(repo, to_subsidiary_id);
  const customer = affiliateCustomer(repo, { seller, buyer });
  const vendor = affiliateVendor(repo, { seller, buyer });

  const icId = ulid();
  const ref = reference || nextNumber(repo, 'intercompany_txn');
  const note = memo || `Intercompany: ${seller.name} → ${buyer.name}`;

  // Intercompany trade is not a taxable supply to a third party, so no tax
  // code is applied. A group that does owe tax between its own entities
  // enters it as an ordinary sale instead.
  const clean = lines.map((l) => ({ ...l, tax_code: '' }));

  const invoice = T.createTxn(repo, 'INVOICE', {
    entity_id: customer.id, subsidiary_id: seller.id, txn_date,
    currency: seller.currency, memo: note, reference: ref, lines: clean,
  });
  const bill = T.createTxn(repo, 'VENDOR_BILL', {
    entity_id: vendor.id, subsidiary_id: buyer.id, txn_date,
    currency: seller.currency, memo: note, reference: ref, lines: clean,
  });

  repo.update('txn', invoice.id, { intercompany_id: icId });
  repo.update('txn', bill.id, { intercompany_id: icId });

  repo.insert('intercompany_txn', {
    id: icId, reference: ref, kind: 'sale', txn_date, currency: seller.currency,
    from_subsidiary_id: seller.id, to_subsidiary_id: buyer.id,
    amount: invoice.total,
    from_entry_id: null, to_entry_id: null,
    from_txn_id: invoice.id, to_txn_id: bill.id,
    status: 'posted', elimination_run_id: null, memo: note,
    created_at: nowIso(), created_by: repo.ctx?.user?.id || null,
  });

  audit.record(repo, {
    recordType: 'intercompany_txn', recordId: icId, action: 'create',
    changes: {
      reference: { from: null, to: ref },
      between: { from: null, to: `${seller.name} → ${buyer.name}` },
      documents: { from: null, to: `${invoice.txn_no} / ${bill.txn_no}` },
    },
  });
  return getIntercompany(repo, icId);
}

// ------------------------------------------------------------ reconciliation
/**
 * Do the two sides agree?
 *
 * The obvious test -- "does due-from across the group equal due-to" -- is the
 * wrong one the moment two companies keep their books in different
 * currencies. A dollar recharge booked by a sterling company is held in
 * sterling, and translating the two halves back at any single rate leaves a
 * difference that is pure translation and nobody's mistake. A report that
 * called that an error would cry wolf on every group it was pointed at.
 *
 * So three questions are asked instead, and only the first two can fail:
 *
 *   1. Does each transaction's own pair agree, in the currency it was struck
 *      in? That is exact, and a difference means one half was tampered with.
 *   2. Does each company's ledger hold what the register says it should, in
 *      that company's own currency? That is exact too, and a difference means
 *      somebody posted at a control account by hand.
 *   3. What is left over once both of those are clean is translation, and it
 *      is reported as translation rather than as a problem.
 *
 * Intercompany balances live in two places: the affiliate control accounts,
 * where recharges go, and ordinary receivables and payables against the
 * customer and vendor records that stand for a group company, where sales go.
 * Both are counted, because a group that only looked at one would be missing
 * half of what it owes itself.
 */
export function reconciliation(repo, { as_of = today() } = {}) {
  requireDate(as_of, 'as_of');
  const group = repo.queryOne('SELECT base_currency FROM tenant WHERE id = :t')?.base_currency
    || repo.queryOne('SELECT currency FROM subsidiary WHERE tenant_id = :t ORDER BY created_at LIMIT 1')?.currency
    || 'USD';

  const rates = new Map([[group, 1]]);
  const missing = new Set();
  const rateFor = (ccy) => {
    if (!rates.has(ccy)) {
      try { rates.set(ccy, gl.exchangeRate(repo, ccy, group, as_of)); } catch { rates.set(ccy, null); missing.add(ccy); }
    }
    return rates.get(ccy);
  };
  const toGroup = (amount, ccy) => {
    const rate = rateFor(ccy);
    return rate === null ? 0 : Math.round(amount * rate);
  };

  const rows = repo.query(
    `SELECT ic.*, f.name AS from_name, f.currency AS from_currency,
            t2.name AS to_name, t2.currency AS to_currency
     FROM intercompany_txn ic
     JOIN subsidiary f ON f.tenant_id = ic.tenant_id AND f.id = ic.from_subsidiary_id
     JOIN subsidiary t2 ON t2.tenant_id = ic.tenant_id AND t2.id = ic.to_subsidiary_id
     WHERE ic.tenant_id = :t AND ic.status IN ('posted', 'eliminated') AND ic.txn_date <= ?
     ORDER BY ic.txn_date`, [as_of]);

  // ---- 1. each pair, in the currency it was struck in
  const unmatched = [];
  const sideOf = (entryId) => repo.scalar(
    `SELECT COALESCE(SUM(jl.debit - jl.credit), 0) v FROM journal_line jl
     JOIN account a ON a.tenant_id = jl.tenant_id AND a.id = jl.account_id
     WHERE jl.tenant_id = :t AND jl.entry_id = ? AND a.is_intercompany = 1`, [entryId], 0);

  for (const r of rows) {
    let from = null;
    let to = null;
    if (r.from_entry_id && r.to_entry_id) {
      from = sideOf(r.from_entry_id);
      to = -sideOf(r.to_entry_id);
    } else if (r.from_txn_id && r.to_txn_id) {
      from = repo.get('txn', r.from_txn_id)?.total ?? 0;
      to = repo.get('txn', r.to_txn_id)?.total ?? 0;
    } else {
      unmatched.push({
        id: r.id, reference: r.reference, txn_date: r.txn_date, currency: r.currency,
        from: r.from_name, to: r.to_name, difference: r.amount,
        note: 'Only one half of this transaction is in the books',
      });
      continue;
    }
    if (from !== to) {
      unmatched.push({
        id: r.id, reference: r.reference, txn_date: r.txn_date, currency: r.currency,
        from: r.from_name, to: r.to_name, from_amount: from, to_amount: to,
        difference: from - to,
        note: 'The two halves were struck in one currency and no longer agree in it',
      });
    }
  }

  // ---- 2. what each company's ledger holds, against what it should
  const subs = repo.query('SELECT * FROM subsidiary WHERE tenant_id = :t AND is_elimination = 0 AND active = 1');
  const controlLedger = repo.query(
    `SELECT je.subsidiary_id, a.number, SUM(jl.base_debit - jl.base_credit) AS balance
     FROM journal_line jl
     JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
     JOIN account a ON a.tenant_id = jl.tenant_id AND a.id = jl.account_id
     WHERE jl.tenant_id = :t AND je.status = 'posted' AND je.txn_date <= ?
       AND a.is_intercompany = 1
     GROUP BY je.subsidiary_id, a.number`, [as_of]);

  // What the register says those control accounts ought to hold, taken from
  // the entries this module wrote and no others.
  const controlExpected = repo.query(
    `SELECT je.subsidiary_id, a.number, SUM(jl.base_debit - jl.base_credit) AS balance
     FROM journal_line jl
     JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
     JOIN account a ON a.tenant_id = jl.tenant_id AND a.id = jl.account_id
     WHERE jl.tenant_id = :t AND je.status = 'posted' AND je.txn_date <= ?
       AND a.is_intercompany = 1 AND je.intercompany_id IS NOT NULL
     GROUP BY je.subsidiary_id, a.number`, [as_of]);

  // Sales sit in ordinary receivables and payables, against the customer and
  // vendor records that stand for a group company.
  const affiliateAr = repo.query(
    `SELECT t.subsidiary_id, SUM(t.total - t.amount_applied) AS balance
     FROM txn t JOIN customer c ON c.tenant_id = t.tenant_id AND c.id = t.entity_id
     WHERE t.tenant_id = :t AND t.type = 'INVOICE' AND t.status NOT IN ('voided', 'draft', 'cancelled', 'rejected')
       AND t.txn_date <= ? AND c.represents_subsidiary_id IS NOT NULL
     GROUP BY t.subsidiary_id`, [as_of]);
  const affiliateAp = repo.query(
    `SELECT t.subsidiary_id, SUM(t.total - t.amount_applied) AS balance
     FROM txn t JOIN vendor v ON v.tenant_id = t.tenant_id AND v.id = t.entity_id
     WHERE t.tenant_id = :t AND t.type = 'VENDOR_BILL' AND t.status NOT IN ('voided', 'draft', 'cancelled', 'rejected')
       AND t.txn_date <= ? AND v.represents_subsidiary_id IS NOT NULL
     GROUP BY t.subsidiary_id`, [as_of]);

  const pick = (list, sid, number = null) => list
    .filter((l) => l.subsidiary_id === sid && (number === null || l.number === number))
    .reduce((s, l) => s + l.balance, 0);

  const bySubsidiary = subs.map((s) => {
    const dueFromControl = pick(controlLedger, s.id, DUE_FROM);
    const dueToControl = -pick(controlLedger, s.id, DUE_TO);
    const expectFrom = pick(controlExpected, s.id, DUE_FROM);
    const expectTo = -pick(controlExpected, s.id, DUE_TO);
    const ar = pick(affiliateAr, s.id);
    const ap = pick(affiliateAp, s.id);
    // Exact, because both figures are in this company's own currency.
    const drift = (dueFromControl - expectFrom) - (dueToControl - expectTo);
    return {
      subsidiary_id: s.id, name: s.name, currency: s.currency,
      due_from: dueFromControl, due_to: dueToControl,
      receivable: ar, payable: ap,
      total_due_from: dueFromControl + ar,
      total_due_to: dueToControl + ap,
      drift,
      due_from_group: toGroup(dueFromControl + ar, s.currency),
      due_to_group: toGroup(dueToControl + ap, s.currency),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const totalDueFrom = sum(bySubsidiary, (b) => b.due_from_group);
  const totalDueTo = sum(bySubsidiary, (b) => b.due_to_group);
  const drifting = bySubsidiary.filter((b) => b.drift !== 0);

  // ---- 3. pairs, for the picture of who owes whom
  const pairs = new Map();
  for (const r of rows) {
    const key = [r.from_subsidiary_id, r.to_subsidiary_id].sort().join('|');
    const p = pairs.get(key) || {
      key,
      a: { id: r.from_subsidiary_id, name: r.from_name, currency: r.from_currency },
      b: { id: r.to_subsidiary_id, name: r.to_name, currency: r.to_currency },
      count: 0, gross: 0, net: 0,
    };
    const inGroup = toGroup(r.amount, r.currency);
    const forward = r.from_subsidiary_id === p.a.id;
    p.count += 1;
    p.gross += inGroup;
    p.net += forward ? inGroup : -inGroup;
    pairs.set(key, p);
  }

  return {
    as_of, currency: group,
    missing_rates: [...missing],
    // The two findable errors. Anything here is somebody's mistake.
    unmatched,
    drifting,
    // Clean means every pair agrees and every ledger matches its register.
    // It deliberately does not mean the translated totals are equal.
    clean: unmatched.length === 0 && drifting.length === 0,
    total_due_from: totalDueFrom,
    total_due_to: totalDueTo,
    // Named for what it is. In a single-currency group it is zero; in any
    // other it is the cost of holding a balance in a currency that is not
    // yours, and it belongs in the revaluation, not in an error report.
    translation_difference: totalDueFrom - totalDueTo,
    by_subsidiary: bySubsidiary,
    pairs: [...pairs.values()].map((p) => ({
      from: p.a, to: p.b, count: p.count, gross: p.gross, net: p.net,
    })).sort((a, b) => b.gross - a.gross),
    transactions: rows.length,
  };
}

// -------------------------------------------------------------- elimination
/**
 * What a period's elimination entry would contain.
 *
 * Every intercompany account balance in every real subsidiary, reversed. The
 * entry is posted in the elimination subsidiary, so the group's consolidated
 * position nets to nothing while each company's own books stay untouched --
 * which is the point: a subsidiary files its own accounts and must not have
 * the group's consolidation adjustments in them.
 */
export function previewElimination(repo, { period_id } = {}) {
  const period = repo.get('accounting_period', period_id);
  if (!period) throw notFound('Accounting period not found');
  const elimSub = eliminationSubsidiary(repo);
  // The entry is posted in one company's books, so every figure in it has to
  // be in that company's currency. A sterling balance and a dollar balance
  // added together is not a number.
  const groupCurrency = elimSub.currency;

  const rows = repo.query(
    `SELECT b.subsidiary_id, b.account_id,
            SUM(b.base_debit) AS debit, SUM(b.base_credit) AS credit
     FROM gl_balance b
     JOIN account a ON a.tenant_id = b.tenant_id AND a.id = b.account_id
     JOIN subsidiary s ON s.tenant_id = b.tenant_id AND s.id = b.subsidiary_id
     WHERE b.tenant_id = :t AND b.period_id = ? AND a.is_intercompany = 1
       AND s.is_elimination = 0
     GROUP BY b.subsidiary_id, b.account_id`, [period_id]);

  const lines = [];
  const missing = new Set();
  for (const r of rows) {
    const balance = r.debit - r.credit;
    if (!balance) continue;
    const account = repo.get('account', r.account_id);
    const sub = repo.get('subsidiary', r.subsidiary_id);
    if (!account || !sub) continue;

    // Translated at the period's closing rate, the same rate consolidation
    // uses for a balance sheet account, so the elimination agrees with the
    // statements it is there to make possible.
    let rate = 1;
    if (sub.currency !== groupCurrency) {
      try { rate = translationRates(repo, period_id, sub.currency, groupCurrency).closing; }
      catch { missing.add(sub.currency); continue; }
    }
    const translated = Math.round(balance * rate);
    if (!translated) continue;
    lines.push({
      account_id: r.account_id, number: account.number, name: account.name,
      subsidiary_id: r.subsidiary_id, subsidiary_name: sub.name,
      local_balance: balance, local_currency: sub.currency, rate,
      // Reversed: a debit balance is eliminated with a credit.
      base_debit: translated < 0 ? -translated : 0,
      base_credit: translated > 0 ? translated : 0,
      note: sub.currency === groupCurrency
        ? `${sub.name} ${account.number}`
        : `${sub.name} ${account.number} at ${rate.toFixed(6)}`,
    });
  }

  const debit = sum(lines, (l) => l.base_debit);
  const credit = sum(lines, (l) => l.base_credit);
  return {
    period: { id: period.id, name: period.name, status: period.status },
    currency: groupCurrency,
    missing_rates: [...missing],
    lines,
    totals: {
      debit, credit,
      // In a group that keeps one currency this is zero. In any other it is
      // the translation difference: the balances cancel exactly in the
      // currencies they are held in, and what is left is the cost of stating
      // them in the parent's. It is equity, not an error, and it is what the
      // cumulative translation adjustment account is for.
      translation: debit - credit,
      single_currency: !lines.some((l) => l.local_currency !== groupCurrency),
    },
  };
}

export function runElimination(repo, { period_id, memo = '', dry_run = false } = {}) {
  const period = repo.get('accounting_period', period_id);
  if (!period) throw notFound('Accounting period not found');
  const plan = previewElimination(repo, { period_id });
  if (dry_run) return { ...plan, dry_run: true, posted: false };
  if (!plan.lines.length) {
    throw unprocessable(`Nothing to eliminate in ${period.name}: no intercompany balances were posted in it.`);
  }
  if (period.status !== 'open') {
    throw conflict(`${period.name} is ${period.status}, so an elimination entry cannot be posted into it.`);
  }

  const elimSub = eliminationSubsidiary(repo);
  // Re-running supersedes: the old entry is reversed first, so a period is
  // never eliminated twice over.
  const prior = repo.query(
    "SELECT * FROM elimination_run WHERE tenant_id = :t AND period_id = ? AND status = 'posted'", [period_id]);
  for (const p of prior) reverseElimination(repo, p.id, { reason: 'Superseded by a later run' });

  const now = nowIso();
  const runId = ulid();
  const runNo = nextNumber(repo, 'elimination_run');

  const journalLines = plan.lines.map((l) => ({
    account_id: l.account_id,
    base_debit: l.base_debit, base_credit: l.base_credit,
    debit: l.base_debit, credit: l.base_credit,
    memo: l.note,
  }));

  // The balances cancel exactly in the currencies they are held in. Stated in
  // the parent's currency they do not, and the remainder is translation, not
  // a mistake: it goes to the cumulative translation adjustment, which is
  // where a consolidated balance sheet expects to find it.
  if (plan.totals.translation !== 0) {
    const cta = repo.queryOne(
      "SELECT * FROM account WHERE tenant_id = :t AND number = ? AND active = 1", [CTA])
      || repo.queryOne("SELECT * FROM account WHERE tenant_id = :t AND type = 'EQUITY' AND is_summary = 0 AND active = 1 ORDER BY number LIMIT 1");
    if (!cta) {
      throw unprocessable(`The elimination has a translation difference of ${Money.format(Math.abs(plan.totals.translation), plan.currency)} and there is no ${CTA} Cumulative Translation Adjustment account to put it in. Add one under Chart of Accounts.`);
    }
    const d = plan.totals.translation;
    journalLines.push({
      account_id: cta.id,
      base_debit: d < 0 ? -d : 0, base_credit: d > 0 ? d : 0,
      debit: d < 0 ? -d : 0, credit: d > 0 ? d : 0,
      memo: plan.totals.single_currency
        ? 'Rounding on elimination'
        : 'Translating intercompany balances into the group currency',
    });
  }

  const entry = gl.postJournal(repo, {
    subsidiary_id: elimSub.id, txn_date: period.end_date,
    currency: elimSub.currency,
    memo: memo || `Intercompany elimination — ${period.name}`,
    source_type: 'elimination', source_id: runId,
    lines: journalLines,
  });
  repo.update('journal_entry', entry.id, { elimination_run_id: runId });

  repo.insert('elimination_run', {
    id: runId, run_no: runNo, period_id, subsidiary_id: elimSub.id,
    status: 'posted', entry_count: 1,
    total_eliminated: sum(plan.lines, (l) => Math.max(l.base_debit, l.base_credit)),
    memo: memo || '', reversed_at: null,
    created_at: now, created_by: repo.ctx?.user?.id || null,
  });
  for (const l of plan.lines) {
    repo.insert('elimination_line', {
      id: ulid(), run_id: runId, account_id: l.account_id, subsidiary_id: l.subsidiary_id,
      base_debit: l.base_debit, base_credit: l.base_credit, note: l.note, created_at: now,
    });
  }

  repo.exec(
    `UPDATE intercompany_txn SET status = 'eliminated', elimination_run_id = ?
     WHERE tenant_id = :t AND status = 'posted' AND txn_date <= ?`, [runId, period.end_date]);

  audit.record(repo, {
    recordType: 'elimination_run', recordId: runId, action: 'post',
    changes: {
      run_no: { from: null, to: runNo },
      period: { from: null, to: period.name },
      eliminated: { from: null, to: Money.toNumber(sum(plan.lines, (l) => Math.max(l.base_debit, l.base_credit))) },
    },
  });
  return getRun(repo, runId);
}

export function getRun(repo, id) {
  const run = repo.get('elimination_run', id);
  if (!run) throw notFound('Elimination run not found');
  run.period = repo.get('accounting_period', run.period_id);
  run.subsidiary = repo.get('subsidiary', run.subsidiary_id);
  run.lines = repo.query(
    `SELECT el.*, a.number, a.name AS account_name, s.name AS subsidiary_name
     FROM elimination_line el
     JOIN account a ON a.tenant_id = el.tenant_id AND a.id = el.account_id
     JOIN subsidiary s ON s.tenant_id = el.tenant_id AND s.id = el.subsidiary_id
     WHERE el.tenant_id = :t AND el.run_id = ? ORDER BY s.name, a.number`, [id]);
  run.entries = repo.query(
    'SELECT id, entry_no, txn_date, total_debit, status FROM journal_entry WHERE tenant_id = :t AND elimination_run_id = ?', [id]);
  return run;
}

export const runs = (repo, { limit = 100 } = {}) => repo.query(
  `SELECT r.*, p.name AS period_name FROM elimination_run r
   JOIN accounting_period p ON p.tenant_id = r.tenant_id AND p.id = r.period_id
   WHERE r.tenant_id = :t ORDER BY r.created_at DESC LIMIT ?`, [Math.min(limit, 500)]);

/** Undo a run: reverse its entry, put the transactions back. */
export function reverseElimination(repo, id, { reason = '' } = {}) {
  const run = repo.get('elimination_run', id);
  if (!run) throw notFound('Elimination run not found');
  if (run.status === 'reversed') throw conflict(`${run.run_no} has already been reversed.`);

  for (const e of repo.query('SELECT id FROM journal_entry WHERE tenant_id = :t AND elimination_run_id = ?', [id])) {
    gl.reverseJournal(repo, e.id, { memo: `Reversal of ${run.run_no}${reason ? ` — ${reason}` : ''}` });
  }
  repo.update('elimination_run', id, { status: 'reversed', reversed_at: nowIso() });
  repo.exec(
    "UPDATE intercompany_txn SET status = 'posted', elimination_run_id = NULL WHERE tenant_id = :t AND elimination_run_id = ?", [id]);
  audit.record(repo, {
    recordType: 'elimination_run', recordId: id, action: 'reverse',
    changes: { reason: { from: null, to: reason } },
  });
  return getRun(repo, id);
}
