// Meridian ERP :: multi-book accounting
//
// Keeping more than one set of books over the same transactions.
//
// A company filing under IFRS in one place and local GAAP in another does not
// have two businesses. It has one business and two ways of measuring it: the
// same invoices, the same payments, the same machines, told twice because two
// sets of rules disagree about when revenue is earned and how long a thing
// lasts.
//
// Where the second telling lives is the whole design, and there is a tempting
// wrong answer: copy every entry into every book. That makes every query in
// the product responsible for knowing which book it means -- and there are
// more than fifty that add up amounts. Miss one and the profit and loss
// silently doubles, which in an accounting system is the worst kind of bug,
// because it still looks like an answer.
//
// So a secondary book holds only what DIFFERS from the primary, in its own
// tables. A report for that book is the primary plus those differences. The
// primary ledger is untouched by this feature and cannot be corrupted by it,
// and "the difference between the two bases" becomes a thing somebody can
// actually look at -- which is what gets asked for at audit anyway.
import { ulid, Money, nowIso, today, isValidDate, sum } from '../core/util.mjs';
import { ValidationError, notFound, unprocessable, conflict, requireDate, optionalDate } from '../core/http.mjs';
import { nextNumber } from '../core/seq.mjs';
import * as gl from './gl.mjs';
import * as assets from './assets.mjs';
import * as audit from '../core/audit.mjs';

export const BASES = ['accrual', 'cash'];
const CODE_RX = /^[A-Z][A-Z0-9_]{1,15}$/;

// --------------------------------------------------------------- the books
export const primaryBook = (repo) => repo.queryOne(
  'SELECT * FROM accounting_book WHERE tenant_id = :t AND is_primary = 1');

export const listBooks = (repo, { includeInactive = false } = {}) => repo.query(
  `SELECT * FROM accounting_book WHERE tenant_id = :t
   ${includeInactive ? '' : "AND status = 'active'"}
   ORDER BY is_primary DESC, name`);

export function getBook(repo, idOrCode) {
  return repo.get('accounting_book', idOrCode)
    || repo.queryOne('SELECT * FROM accounting_book WHERE tenant_id = :t AND code = ?', [String(idOrCode || '').toUpperCase()]);
}

export function requireBook(repo, idOrCode) {
  const b = getBook(repo, idOrCode);
  if (!b) throw notFound(`There is no accounting book called "${idOrCode}"`);
  return b;
}

/**
 * The book a request means.
 *
 * Everything defaults to the primary, which is what every screen that has
 * never heard of a second book is asking for.
 */
export function resolveBook(repo, idOrCode = null) {
  if (!idOrCode) {
    const p = primaryBook(repo);
    if (!p) throw unprocessable('This company has no primary accounting book, which should not be possible. Run the migrations.');
    return p;
  }
  return requireBook(repo, idOrCode);
}

export function createBook(repo, input = {}) {
  const errors = {};
  const code = String(input.code || '').trim().toUpperCase();
  if (!CODE_RX.test(code)) errors.code = 'Use capital letters, digits and underscores, starting with a letter (2 to 16 characters)';
  if (!input.name) errors.name = 'Give it a name people will read';
  if (input.basis && !BASES.includes(input.basis)) errors.basis = `Choose ${BASES.join(' or ')}`;
  if (Object.keys(errors).length) throw new ValidationError(errors);
  if (repo.queryOne('SELECT id FROM accounting_book WHERE tenant_id = :t AND code = ?', [code])) {
    throw new ValidationError({ code: `A book with the code "${code}" already exists` });
  }

  const now = nowIso();
  const id = repo.insert('accounting_book', {
    id: ulid(), name: input.name, code,
    // A second primary is refused by the database. Saying so here means the
    // person gets a sentence rather than a constraint violation.
    is_primary: 0,
    purpose: input.purpose || '', basis: input.basis || 'accrual',
    description: input.description || '', status: 'active',
    created_at: now, created_by: repo.ctx?.user?.id || null, updated_at: now,
  });
  audit.record(repo, { recordType: 'accounting_book', recordId: id, action: 'create', after: input });
  return repo.get('accounting_book', id);
}

const EDITABLE = ['name', 'purpose', 'basis', 'description', 'status'];

export function updateBook(repo, id, patch = {}) {
  const before = requireBook(repo, id);
  if (patch.code !== undefined && patch.code !== before.code) {
    throw unprocessable(`A book's code cannot change once it exists — ${before.code} is what its adjustments are filed under.`);
  }
  if (patch.is_primary !== undefined && !!patch.is_primary !== !!before.is_primary) {
    throw unprocessable('Which book is primary cannot change. The primary book is the ledger itself; every other book is expressed as a difference from it, so swapping them would restate everything at once.');
  }
  if (before.is_primary && patch.status && patch.status !== 'active') {
    throw conflict('The primary book cannot be deactivated. It is the ledger.');
  }
  if (patch.basis !== undefined && !BASES.includes(patch.basis)) {
    throw new ValidationError({ basis: `Choose ${BASES.join(' or ')}` });
  }
  const values = { updated_at: nowIso() };
  for (const f of EDITABLE) if (patch[f] !== undefined) values[f] = patch[f];
  repo.update('accounting_book', before.id, values);
  audit.record(repo, { recordType: 'accounting_book', recordId: before.id, action: 'update', before, after: patch });
  return repo.get('accounting_book', before.id);
}

export function deleteBook(repo, id) {
  const b = requireBook(repo, id);
  if (b.is_primary) throw conflict('The primary book is the ledger and cannot be deleted.');
  const count = repo.scalar('SELECT COUNT(*) c FROM book_adjustment WHERE tenant_id = :t AND book_id = ?', [b.id], 0);
  if (count) {
    throw conflict(`${b.name} holds ${count} adjustment${count === 1 ? '' : 's'}. Make it inactive instead — deleting it would take the other basis of accounting with it.`);
  }
  repo.exec('DELETE FROM asset_book_rule WHERE tenant_id = :t AND book_id = ?', [b.id]);
  repo.exec('DELETE FROM accounting_book WHERE tenant_id = :t AND id = ?', [b.id]);
  audit.record(repo, { recordType: 'accounting_book', recordId: b.id, action: 'delete', before: b });
  return { deleted: true };
}

// -------------------------------------------------------- the adjustments
/**
 * Post a difference into one book.
 *
 * Shaped like a journal entry and validated like one -- it balances, its
 * accounts are real and postable, and it lands in an open period -- but it is
 * written to this book's own tables, where nothing that reads the ledger can
 * pick it up by accident.
 */
export function postAdjustment(repo, input = {}) {
  const {
    book_id, subsidiary_id, txn_date = today(), memo = '',
    source_type = 'manual', source_id = null, source_key = null,
    lines = [], entry_no = null,
  } = input;

  const book = resolveBook(repo, book_id);
  if (book.is_primary) {
    throw unprocessable('The primary book is the ledger: post an ordinary journal entry to it. Adjustments record how another book differs from this one.');
  }
  const errors = {};
  if (!subsidiary_id) errors.subsidiary_id = 'Subsidiary is required';
  if (!isValidDate(txn_date)) errors.txn_date = 'Enter a valid date';
  if (!Array.isArray(lines) || lines.length < 2) errors.lines = 'An adjustment needs at least two lines';
  if (Object.keys(errors).length) throw new ValidationError(errors);

  const period = gl.periodForDate(repo, txn_date);
  if (!period) throw unprocessable(`No accounting period covers ${txn_date}.`);
  if (period.status !== 'open') throw conflict(`${period.name} is ${period.status}.`);

  const prepared = [];
  const lineErrors = {};
  lines.forEach((l, i) => {
    const debit = Math.max(0, Math.trunc(l.base_debit ?? l.debit ?? 0));
    const credit = Math.max(0, Math.trunc(l.base_credit ?? l.credit ?? 0));
    if (debit && credit) { lineErrors[`lines.${i}`] = 'A line may carry a debit or a credit, not both'; return; }
    if (!debit && !credit) { lineErrors[`lines.${i}`] = 'A line must carry a debit or a credit'; return; }
    if (!l.account_id) { lineErrors[`lines.${i}.account_id`] = 'Account is required'; return; }
    const acct = repo.get('account', l.account_id);
    if (!acct) { lineErrors[`lines.${i}.account_id`] = 'Account not found'; return; }
    if (acct.is_summary) { lineErrors[`lines.${i}.account_id`] = `${acct.number} ${acct.name} is a summary account and cannot be posted to`; return; }
    if (!acct.active) { lineErrors[`lines.${i}.account_id`] = `${acct.number} ${acct.name} is inactive`; return; }
    prepared.push({ ...l, account: acct, base_debit: debit, base_credit: credit });
  });
  if (Object.keys(lineErrors).length) throw new ValidationError(lineErrors);

  const totalDebit = sum(prepared, (l) => l.base_debit);
  const totalCredit = sum(prepared, (l) => l.base_credit);
  if (totalDebit !== totalCredit) {
    throw unprocessable(
      `The adjustment does not balance: debits ${Money.format(totalDebit)} against credits ${Money.format(totalCredit)}, out by ${Money.format(Math.abs(totalDebit - totalCredit))}.`);
  }

  // A rule-driven adjustment happens once per thing per period. The database
  // enforces it too; this is so the caller gets a sentence rather than a
  // constraint violation.
  if (source_key) {
    const already = repo.queryOne(
      "SELECT entry_no FROM book_adjustment WHERE tenant_id = :t AND book_id = ? AND source_key = ? AND status = 'posted'",
      [book.id, source_key]);
    if (already) throw conflict(`${book.name} already has ${already.entry_no} for that, so there is nothing to post.`);
  }

  const now = nowIso();
  const id = repo.tx(() => {
    const adjId = repo.insert('book_adjustment', {
      id: ulid(), book_id: book.id, entry_no: entry_no || nextNumber(repo, 'book_adjustment'),
      subsidiary_id, period_id: period.id, txn_date, memo: memo || '',
      source_type, source_id, source_key,
      total_debit: totalDebit, total_credit: totalCredit,
      status: 'posted', is_reversal: 0, reverses_id: null, reversed_by_id: null,
      created_at: now, created_by: repo.ctx?.user?.id || null,
    });

    prepared.forEach((l, i) => {
      repo.insert('book_adjustment_line', {
        id: ulid(), adjustment_id: adjId, line_no: i + 1,
        account_id: l.account_id, base_debit: l.base_debit, base_credit: l.base_credit,
        memo: l.memo || '',
        department_id: l.department_id || null, location_id: l.location_id || null, class_id: l.class_id || null,
      });
      repo.exec(
        `INSERT INTO book_balance (tenant_id, book_id, subsidiary_id, period_id, account_id, base_debit, base_credit)
         VALUES (:t,?,?,?,?,?,?)
         ON CONFLICT (tenant_id, book_id, subsidiary_id, period_id, account_id)
         DO UPDATE SET base_debit = base_debit + excluded.base_debit,
                       base_credit = base_credit + excluded.base_credit`,
        [book.id, subsidiary_id, period.id, l.account_id, l.base_debit, l.base_credit]);
    });

    audit.record(repo, {
      recordType: 'accounting_book', recordId: book.id, action: 'adjust',
      changes: { book: { from: null, to: book.code }, amount: { from: null, to: Money.toNumber(totalDebit) } },
    });
    return adjId;
  });
  return getAdjustment(repo, id);
}

export function getAdjustment(repo, id) {
  const a = repo.get('book_adjustment', id);
  if (!a) throw notFound('Adjustment not found');
  a.book = repo.get('accounting_book', a.book_id);
  a.period = repo.get('accounting_period', a.period_id);
  a.lines = repo.query(
    `SELECT l.*, acc.number AS account_number, acc.name AS account_name, acc.type AS account_type
     FROM book_adjustment_line l
     JOIN account acc ON acc.tenant_id = l.tenant_id AND acc.id = l.account_id
     WHERE l.tenant_id = :t AND l.adjustment_id = ? ORDER BY l.line_no`, [id]);
  return a;
}

export function adjustments(repo, { book_id = null, from = null, to = null, source_type = null, limit = 200 } = {}) {
  from = optionalDate(from, 'from');
  to = optionalDate(to, 'to');
  const where = ['a.tenant_id = :t'];
  const params = [];
  if (book_id) { where.push('a.book_id = ?'); params.push(book_id); }
  if (from) { where.push('a.txn_date >= ?'); params.push(from); }
  if (to) { where.push('a.txn_date <= ?'); params.push(to); }
  if (source_type && source_type !== 'all') { where.push('a.source_type = ?'); params.push(source_type); }
  const rows = repo.query(
    `SELECT a.*, b.name AS book_name, b.code AS book_code, p.name AS period_name
     FROM book_adjustment a
     JOIN accounting_book b ON b.tenant_id = a.tenant_id AND b.id = a.book_id
     LEFT JOIN accounting_period p ON p.tenant_id = a.tenant_id AND p.id = a.period_id
     WHERE ${where.join(' AND ')}
     ORDER BY a.txn_date DESC, a.created_at DESC LIMIT ?`, [...params, Math.min(limit, 1000)]);
  return { rows, total: rows.length };
}

export function reverseAdjustment(repo, id, { memo = null } = {}) {
  const a = getAdjustment(repo, id);
  if (a.status === 'reversed') throw conflict(`${a.entry_no} has already been reversed.`);
  const reversal = postAdjustment(repo, {
    book_id: a.book_id, subsidiary_id: a.subsidiary_id, txn_date: a.txn_date,
    memo: memo || `Reversal of ${a.entry_no}`,
    source_type: a.source_type, source_id: a.source_id,
    // The reversal carries no source key: it is undoing the thing, not being
    // the thing, and the original has to be re-postable afterwards.
    source_key: null,
    lines: a.lines.map((l) => ({
      account_id: l.account_id, base_debit: l.base_credit, base_credit: l.base_debit, memo: l.memo,
      department_id: l.department_id, location_id: l.location_id, class_id: l.class_id,
    })),
  });
  repo.update('book_adjustment', id, { status: 'reversed', reversed_by_id: reversal.id });
  repo.update('book_adjustment', reversal.id, { is_reversal: 1, reverses_id: id });
  return getAdjustment(repo, reversal.id);
}

// --------------------------------------------------------------- balances
/**
 * What one book's adjustments come to, by account.
 *
 * Returned in the shape the reports already use so they can be laid straight
 * on top of the primary balances without either side knowing about the other.
 */
export function adjustmentBalances(repo, { book_id, from = null, to = today(), subsidiaryId = null } = {}) {
  from = optionalDate(from, 'from');
  to = requireDate(to, 'to');
  const book = resolveBook(repo, book_id);
  if (book.is_primary) return {};

  const where = ['ba.tenant_id = :t', 'ba.book_id = ?', 'p.end_date >= ?', 'p.start_date <= ?'];
  const params = [book.id, from || '0000-01-01', to];
  if (subsidiaryId) { where.push('ba.subsidiary_id = ?'); params.push(subsidiaryId); }

  const rows = repo.query(
    `SELECT ba.account_id, SUM(ba.base_debit) AS debit, SUM(ba.base_credit) AS credit
     FROM book_balance ba
     JOIN accounting_period p ON p.tenant_id = ba.tenant_id AND p.id = ba.period_id
     WHERE ${where.join(' AND ')}
     GROUP BY ba.account_id`, params);

  const out = {};
  for (const r of rows) out[r.account_id] = { debit: r.debit || 0, credit: r.credit || 0, net: (r.debit || 0) - (r.credit || 0) };
  return out;
}

/** Every book's bottom line for a period range, so they can be compared. */
export function comparison(repo, { from = null, to = today(), subsidiaryId = null } = {}) {
  from = optionalDate(from, 'from');
  to = requireDate(to, 'to');
  const books = listBooks(repo);
  const out = [];
  for (const b of books) {
    const adj = b.is_primary ? {} : adjustmentBalances(repo, { book_id: b.id, from, to, subsidiaryId });
    const accounts = Object.keys(adj);
    let income = 0;
    let expense = 0;
    for (const id of accounts) {
      const a = repo.get('account', id);
      if (!a) continue;
      if (a.type === 'INCOME') income -= adj[id].net;
      else if (a.type === 'EXPENSE') expense += adj[id].net;
    }
    out.push({
      book_id: b.id, name: b.name, code: b.code, purpose: b.purpose,
      is_primary: !!b.is_primary, basis: b.basis,
      adjustment_count: b.is_primary ? 0 : repo.scalar(
        "SELECT COUNT(*) c FROM book_adjustment WHERE tenant_id = :t AND book_id = ? AND status = 'posted'", [b.id], 0),
      // How this book's profit differs from the primary's. Zero means the two
      // bases agree so far, which is worth being able to see at a glance.
      profit_difference: income - expense,
      accounts_affected: accounts.length,
    });
  }
  return { from, to, books: out };
}

// ------------------------------------------------- book-specific assets
export const assetRules = (repo, bookId) => repo.query(
  `SELECT r.*, a.asset_no, a.name AS asset_name, a.cost, a.method AS primary_method,
          a.life_months AS primary_life, a.in_service_date, a.status
   FROM asset_book_rule r
   JOIN fixed_asset a ON a.tenant_id = r.tenant_id AND a.id = r.asset_id
   WHERE r.tenant_id = :t AND r.book_id = ? ORDER BY a.asset_no`, [bookId]);

export const ruleFor = (repo, bookId, assetId) => repo.queryOne(
  'SELECT * FROM asset_book_rule WHERE tenant_id = :t AND book_id = ? AND asset_id = ?', [bookId, assetId]);

export function setAssetRule(repo, input = {}) {
  const { book_id, asset_id, method = 'STRAIGHT_LINE', life_months = 60, salvage_value = 0, declining_rate = 2.0, note = '' } = input;
  const book = requireBook(repo, book_id);
  if (book.is_primary) {
    throw unprocessable('The primary book already has the asset\'s own method and life. A rule records how another book differs from it.');
  }
  const asset = assets.getAsset(repo, asset_id);
  if (!assets.METHODS.includes(method)) throw new ValidationError({ method: `Choose one of ${assets.METHODS.join(', ')}` });
  if (!Number(life_months) || Number(life_months) < 1) throw new ValidationError({ life_months: 'A life of at least one month is required' });

  const now = nowIso();
  const existing = ruleFor(repo, book.id, asset.id);
  if (existing) {
    repo.update('asset_book_rule', existing.id, {
      method, life_months: Number(life_months), salvage_value: Money.parse(salvage_value),
      declining_rate: Number(declining_rate) || 2.0, note: note || '', updated_at: now,
    });
    return repo.get('asset_book_rule', existing.id);
  }
  const id = repo.insert('asset_book_rule', {
    id: ulid(), book_id: book.id, asset_id: asset.id,
    method, life_months: Number(life_months), salvage_value: Money.parse(salvage_value),
    declining_rate: Number(declining_rate) || 2.0, note: note || '',
    created_at: now, updated_at: now,
  });
  audit.record(repo, {
    recordType: 'accounting_book', recordId: book.id, action: 'asset_rule',
    changes: { asset: { from: null, to: asset.asset_no }, life: { from: asset.life_months, to: Number(life_months) } },
  });
  return repo.get('asset_book_rule', id);
}

export function removeAssetRule(repo, id) {
  const r = repo.get('asset_book_rule', id);
  if (!r) throw notFound('Rule not found');
  repo.exec('DELETE FROM asset_book_rule WHERE tenant_id = :t AND id = ?', [id]);
  return { deleted: true };
}

/**
 * What this book would have charged for an asset, period by period.
 *
 * The primary schedule is generated by the same function, so the two are
 * computed the same way and the only thing that differs is the rule.
 */
export function bookSchedule(repo, rule, asset) {
  return assets.scheduleAmounts({
    ...asset,
    method: rule.method,
    life_months: rule.life_months,
    salvage_value: rule.salvage_value,
    declining_rate: rule.declining_rate,
  });
}

/**
 * Depreciate, in a book that disagrees about how.
 *
 * Only the DIFFERENCE is posted: the primary ledger has already charged its
 * own figure, and this book's report is the primary plus what is here. Posting
 * the whole charge would count it twice.
 */
export function runBookDepreciation(repo, { book_id, through = today(), dry_run = false } = {}) {
  requireDate(through, 'through');
  const book = requireBook(repo, book_id);
  if (book.is_primary) {
    throw unprocessable('The primary book depreciates through the ordinary depreciation run.');
  }
  const rules = assetRules(repo, book.id);
  const planned = [];
  const skipped = [];

  for (const rule of rules) {
    const asset = repo.get('fixed_asset', rule.asset_id);
    if (!asset || asset.status === 'draft' || !asset.in_service_date) {
      skipped.push({ asset_no: rule.asset_no, reason: 'it is not in service' });
      continue;
    }
    const bookAmounts = bookSchedule(repo, rule, asset);

    // Every period the primary book has actually charged, and what it charged.
    const primaryPosted = repo.query(
      `SELECT period_no, period_id, depr_date, amount FROM depreciation_line
       WHERE tenant_id = :t AND asset_id = ? AND posted = 1 AND depr_date <= ?
       ORDER BY period_no`, [asset.id, through]);

    for (const line of primaryPosted) {
      const bookAmount = bookAmounts[line.period_no - 1] ?? 0;
      const difference = bookAmount - line.amount;
      const key = `depr:${asset.id}:${line.period_no}`;
      if (!difference) continue;
      const already = repo.queryOne(
        "SELECT id FROM book_adjustment WHERE tenant_id = :t AND book_id = ? AND source_key = ? AND status = 'posted'",
        [book.id, key]);
      if (already) continue;
      planned.push({
        asset_id: asset.id, asset_no: rule.asset_no, asset_name: rule.asset_name,
        period_no: line.period_no, period_id: line.period_id, depr_date: line.depr_date,
        primary_amount: line.amount, book_amount: bookAmount, difference, source_key: key,
        expense_account_id: asset.expense_account_id, accum_account_id: asset.accum_account_id,
        subsidiary_id: asset.subsidiary_id,
      });
    }
  }

  if (dry_run) {
    return {
      book: { id: book.id, name: book.name, code: book.code },
      through, dry_run: true, posted: 0,
      planned, skipped,
      total_difference: sum(planned, (p) => p.difference),
    };
  }

  const made = [];
  for (const p of planned) {
    if (!p.expense_account_id || !p.accum_account_id) {
      skipped.push({ asset_no: p.asset_no, reason: 'it has no depreciation accounts' });
      continue;
    }
    const period = repo.get('accounting_period', p.period_id);
    if (!period || period.status !== 'open') {
      skipped.push({ asset_no: p.asset_no, reason: `${period?.name || 'that period'} is ${period?.status || 'missing'}` });
      continue;
    }
    // A bigger charge in this book is more expense and more accumulated
    // depreciation; a smaller one is the reverse.
    const d = p.difference;
    // postAdjustment wraps its own writes in repo.tx(), so each asset's
    // adjustment is atomic on its own, and one asset failing (an inactive
    // account, say) cannot roll back adjustments this same run already
    // posted for another asset.
    const adj = postAdjustment(repo, {
      book_id: book.id, subsidiary_id: p.subsidiary_id, txn_date: p.depr_date,
      memo: `${p.asset_no} depreciation under ${book.name} — period ${p.period_no}`,
      source_type: 'depreciation', source_id: p.asset_id, source_key: p.source_key,
      lines: [
        { account_id: p.expense_account_id, base_debit: d > 0 ? d : 0, base_credit: d < 0 ? -d : 0, memo: 'Difference in charge' },
        { account_id: p.accum_account_id, base_debit: d < 0 ? -d : 0, base_credit: d > 0 ? d : 0, memo: 'Difference in accumulated depreciation' },
      ],
    });
    made.push({ ...p, entry_no: adj.entry_no, adjustment_id: adj.id });
  }

  return {
    book: { id: book.id, name: book.name, code: book.code },
    through, dry_run: false, posted: made.length,
    planned: made, skipped,
    total_difference: sum(made, (p) => p.difference),
  };
}
