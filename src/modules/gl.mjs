// Meridian ERP :: modules/gl
// The General Ledger. Every other module ultimately calls postJournal().
//
// Invariants this module guarantees:
//   1. A posted entry is balanced in the subsidiary's base currency.
//   2. A posted entry belongs to an OPEN accounting period.
//   3. A posted entry is immutable. Corrections happen by reversal, so the
//      audit trail shows what was believed and when it was corrected.
//   4. gl_balance is updated in the same transaction as journal_line, so the
//      rollup can never drift from the detail. /reports/integrity proves it.
import { ulid, nowIso, Money, isValidDate, round, sum } from '../core/util.mjs';
import { HttpError, badRequest, notFound, unprocessable, ValidationError } from '../core/http.mjs';
import { nextNumber } from '../core/seq.mjs';
import * as audit from '../core/audit.mjs';
import * as meta from './meta.mjs';
import { indexRecord } from '../core/search.mjs';

export const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];

/** +1 means debits increase the account; -1 means credits do. */
export const NORMAL_BALANCE = { ASSET: 1, EXPENSE: 1, LIABILITY: -1, EQUITY: -1, INCOME: -1 };
export const isDebitNormal = (type) => NORMAL_BALANCE[type] === 1;
export const STATEMENT = { ASSET: 'balance_sheet', LIABILITY: 'balance_sheet', EQUITY: 'balance_sheet', INCOME: 'income_statement', EXPENSE: 'income_statement' };

export const SUBTYPES = {
  ASSET: ['BANK', 'AR', 'INVENTORY', 'OTHER_CURRENT_ASSET', 'FIXED_ASSET', 'ACCUMULATED_DEPRECIATION', 'OTHER_ASSET'],
  LIABILITY: ['AP', 'CREDIT_CARD', 'OTHER_CURRENT_LIABILITY', 'LONG_TERM_LIABILITY', 'PAYROLL_LIABILITY', 'TAX_LIABILITY'],
  EQUITY: ['COMMON_STOCK', 'RETAINED_EARNINGS', 'OWNER_EQUITY'],
  INCOME: ['REVENUE', 'OTHER_INCOME'],
  EXPENSE: ['COGS', 'OPERATING_EXPENSE', 'PAYROLL_EXPENSE', 'OTHER_EXPENSE'],
};

// ------------------------------------------------------------- accounts
export function getAccount(repo, id) {
  const a = repo.get('account', id);
  if (!a) throw notFound(`Account ${id} not found`);
  return a;
}

/** Look an account up by its number. Used by seeds and by the posting rules. */
export const accountByNumber = (repo, number) =>
  repo.queryOne('SELECT * FROM account WHERE tenant_id = :t AND number = ?', [number]);

/**
 * First active, postable account of a subtype — the posting-rule fallback.
 * Subtypes are stored upper-case; callers write them either way, and a lookup
 * that silently missed would take a whole journal entry down with it.
 */
export const accountBySubtype = (repo, subtype) =>
  repo.queryOne(`SELECT * FROM account WHERE tenant_id = :t AND subtype = ? AND active = 1 AND is_summary = 0
                 ORDER BY number LIMIT 1`, [String(subtype || '').toUpperCase()]);

/** Columns createAccount decides for itself; the rest come from the caller. */
const KNOWN_ACCOUNT_FIELDS = ['number', 'name', 'type', 'subtype', 'parent_id', 'currency',
  'subsidiary_id', 'is_summary', 'cash_flow_category', 'description', 'active', 'custom'];

export function createAccount(repo, input) {
  const fields = {};
  if (!input.number) fields.number = 'Account number is required';
  if (!input.name) fields.name = 'Account name is required';
  if (!ACCOUNT_TYPES.includes(input.type)) fields.type = `Type must be one of ${ACCOUNT_TYPES.join(', ')}`;
  if (Object.keys(fields).length) throw new ValidationError(fields);
  if (accountByNumber(repo, input.number)) throw new ValidationError({ number: `Account ${input.number} already exists` });

  const now = nowIso();
  const id = repo.insert('account', {
    id: ulid(), number: String(input.number), name: input.name, type: input.type,
    subtype: input.subtype || (SUBTYPES[input.type]?.[0] ?? ''),
    parent_id: input.parent_id || null, currency: input.currency || null,
    subsidiary_id: input.subsidiary_id || null,
    is_summary: input.is_summary ? 1 : 0,
    cash_flow_category: input.cash_flow_category || '',
    description: input.description || '', active: input.active === 0 ? 0 : 1,
    custom: input.custom || {}, created_at: now, updated_at: now,
    // Whatever else the registry says is writable — statistical accounts and
    // their unit, and anything added later — rather than a second list here
    // that has to be remembered every time a field is added.
    ...meta.cleanPatch('account', input, { skip: KNOWN_ACCOUNT_FIELDS }),
  });
  audit.record(repo, { recordType: 'account', recordId: id, action: 'create', after: { ...input, id } });
  indexRecord(repo, 'account', id, { title: `${input.number} ${input.name}`, subtitle: input.type, body: input.description || '' });
  return getAccount(repo, id);
}

export function updateAccount(repo, id, patch) {
  const before = getAccount(repo, id);
  if (patch.type && !ACCOUNT_TYPES.includes(patch.type)) throw new ValidationError({ type: 'Invalid account type' });
  // Changing the type of an account that already carries a balance would
  // silently restate prior periods. Blocked outright.
  if (patch.type && patch.type !== before.type) {
    const used = repo.scalar('SELECT COUNT(*) c FROM journal_line WHERE tenant_id = :t AND account_id = ?', [id], 0);
    if (used > 0) throw unprocessable(`Account ${before.number} has ${used} posted lines; its type cannot be changed. Create a new account and reclassify instead.`);
  }
  const clean = meta.cleanPatch('account', patch);
  if (patch.custom !== undefined) clean.custom = patch.custom;
  clean.updated_at = nowIso();
  repo.update('account', id, clean);
  const after = getAccount(repo, id);
  audit.record(repo, { recordType: 'account', recordId: id, action: 'update', before, after });
  indexRecord(repo, 'account', id, { title: `${after.number} ${after.name}`, subtitle: after.type, body: after.description });
  return after;
}

/** Chart of accounts as a tree, with balances if a period is supplied. */
export function chartOfAccounts(repo, { includeInactive = false, periodId = null, subsidiaryId = null, includeStatistical = true } = {}) {
  const rows = repo.query(`SELECT * FROM account WHERE tenant_id = :t ${includeInactive ? '' : 'AND active = 1'}${includeStatistical ? '' : ' AND is_statistical = 0'} ORDER BY number`, []);
  let balances = {};
  if (periodId) balances = balanceMap(repo, { throughPeriodId: periodId, subsidiaryId });
  const byId = new Map(rows.map((r) => [r.id, { ...r, children: [], balance: balances[r.id] || 0 }]));
  const roots = [];
  for (const a of byId.values()) {
    if (a.parent_id && byId.has(a.parent_id)) byId.get(a.parent_id).children.push(a);
    else roots.push(a);
  }
  // Roll child balances into summary parents.
  const roll = (n) => { n.rollup = n.balance + sum(n.children, roll); return n.rollup; };
  roots.forEach(roll);
  return roots;
}

// -------------------------------------------------------------- periods
export function periodForDate(repo, date) {
  if (!isValidDate(date)) throw badRequest(`Invalid date "${date}" — expected YYYY-MM-DD`);
  return repo.queryOne(`SELECT * FROM accounting_period WHERE tenant_id = :t AND start_date <= ? AND end_date >= ?
                        ORDER BY is_adjustment LIMIT 1`, [date, date]);
}

export function requireOpenPeriod(repo, date) {
  const p = periodForDate(repo, date);
  if (!p) throw unprocessable(`No accounting period covers ${date}. Create the period under Setup → Accounting Periods before posting.`);
  if (p.status !== 'open') throw unprocessable(`Accounting period ${p.name} is ${p.status}. Reopen it or post to an open period.`);
  return p;
}

/** Generate a fiscal year of monthly periods. Idempotent. */
export function generatePeriods(repo, fiscalYear, startMonth = 1) {
  const created = [];
  for (let i = 0; i < 12; i++) {
    const m = ((startMonth - 1 + i) % 12) + 1;
    const y = fiscalYear + Math.floor((startMonth - 1 + i) / 12);
    const start = `${y}-${String(m).padStart(2, '0')}-01`;
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    if (repo.queryOne('SELECT id FROM accounting_period WHERE tenant_id = :t AND start_date = ?', [start])) continue;
    const name = new Date(start + 'T00:00:00Z').toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    const id = repo.insert('accounting_period', {
      id: ulid(), name, start_date: start, end_date: end, fiscal_year: fiscalYear,
      quarter: Math.floor(i / 3) + 1, period_no: i + 1, status: 'open', is_adjustment: 0,
    });
    created.push(id);
  }
  return created;
}

export function closePeriod(repo, periodId, { force = false } = {}) {
  const p = repo.get('accounting_period', periodId);
  if (!p) throw notFound('Accounting period not found');
  if (p.status === 'locked') throw unprocessable(`${p.name} is locked and cannot be modified.`);

  // A period may not close over unposted work or an out-of-balance ledger.
  if (!force) {
    const drafts = repo.scalar(`SELECT COUNT(*) c FROM journal_entry WHERE tenant_id = :t AND period_id = ? AND status = 'draft'`, [periodId], 0);
    if (drafts > 0) throw unprocessable(`${p.name} has ${drafts} unposted draft journal ${drafts === 1 ? 'entry' : 'entries'}. Post or delete them first.`);
    const bal = repo.queryOne(`SELECT COALESCE(SUM(base_debit),0) d, COALESCE(SUM(base_credit),0) c
                               FROM gl_balance WHERE tenant_id = :t AND period_id = ?`, [periodId]);
    if (bal && bal.d !== bal.c) throw unprocessable(`${p.name} is out of balance by ${Money.format(Math.abs(bal.d - bal.c))}. Investigate before closing.`);
  }
  repo.update('accounting_period', periodId, { status: 'closed', closed_at: nowIso(), closed_by: repo.ctx?.user?.id || null });
  audit.record(repo, { recordType: 'accounting_period', recordId: periodId, action: 'close', before: p, after: { ...p, status: 'closed' } });
  return repo.get('accounting_period', periodId);
}

export function reopenPeriod(repo, periodId) {
  const p = repo.get('accounting_period', periodId);
  if (!p) throw notFound('Accounting period not found');
  if (p.status === 'locked') throw unprocessable(`${p.name} is locked. A locked period cannot be reopened.`);
  repo.update('accounting_period', periodId, { status: 'open', closed_at: null, closed_by: null });
  audit.record(repo, { recordType: 'accounting_period', recordId: periodId, action: 'reopen', before: p, after: { ...p, status: 'open' } });
  return repo.get('accounting_period', periodId);
}

// ------------------------------------------------------------ currency
/** Rate to convert `from` into `to` on or before `date`. */
export function exchangeRate(repo, from, to, date) {
  if (!from || !to || from === to) return 1;
  const direct = repo.queryOne(`SELECT rate FROM exchange_rate WHERE tenant_id = :t AND from_currency = ? AND to_currency = ?
                                AND rate_date <= ? ORDER BY rate_date DESC LIMIT 1`, [from, to, date]);
  if (direct) return direct.rate;
  const inverse = repo.queryOne(`SELECT rate FROM exchange_rate WHERE tenant_id = :t AND from_currency = ? AND to_currency = ?
                                 AND rate_date <= ? ORDER BY rate_date DESC LIMIT 1`, [to, from, date]);
  if (inverse && inverse.rate) return 1 / inverse.rate;
  throw unprocessable(`No exchange rate from ${from} to ${to} on or before ${date}. Add one under Setup → Exchange Rates.`);
}

export const subsidiaryCurrency = (repo, subsidiaryId) => {
  const s = repo.get('subsidiary', subsidiaryId);
  if (!s) throw notFound(`Subsidiary ${subsidiaryId} not found`);
  return s.currency;
};

// ------------------------------------------------------------- posting
const TOLERANCE_PER_LINE = 1;    // cents of FX rounding we will absorb per line

/**
 * Post a balanced journal entry. This is the single write path into the GL.
 *
 * lines: [{ account_id, debit?, credit?, memo?, entity_type?, entity_id?,
 *           department_id?, location_id?, class_id?, item_id? }]
 * Amounts are minor units in `currency`; base amounts are derived here.
 */
export function postJournal(repo, input) {
  const {
    subsidiary_id, txn_date, currency, memo = '', source_type = 'manual', source_id = null,
    lines = [], status = 'posted', is_reversal = 0, reverses_id = null, entry_no = null,
    custom = {}, fx_rate: suppliedRate = null,
  } = input;

  if (!subsidiary_id) throw new ValidationError({ subsidiary_id: 'Subsidiary is required' });
  if (!isValidDate(txn_date)) throw new ValidationError({ txn_date: 'A valid date (YYYY-MM-DD) is required' });
  if (!Array.isArray(lines) || lines.length < 2) throw new ValidationError({ lines: 'A journal entry needs at least two lines' });

  const baseCurrency = subsidiaryCurrency(repo, subsidiary_id);
  const txnCurrency = currency || baseCurrency;
  const rate = suppliedRate ?? exchangeRate(repo, txnCurrency, baseCurrency, txn_date);
  const period = status === 'posted' ? requireOpenPeriod(repo, txn_date) : (periodForDate(repo, txn_date) || requireOpenPeriod(repo, txn_date));

  // ---- validate and normalise lines
  const prepared = [];
  const fieldErrors = {};
  lines.forEach((l, i) => {
    const debit = Math.max(0, Math.trunc(l.debit || 0));
    const credit = Math.max(0, Math.trunc(l.credit || 0));
    // A line may state its own base amounts. Settlement needs that: relieving
    // a receivable booked at last month's rate has to leave the ledger at the
    // figure that went in, not at today's, or the control account never
    // clears. Such a line may also be base-only — an exchange difference has
    // no amount in the currency the payment was made in.
    const explicitBase = l.base_debit !== undefined || l.base_credit !== undefined;
    const baseDebitIn = Math.max(0, Math.trunc(l.base_debit || 0));
    const baseCreditIn = Math.max(0, Math.trunc(l.base_credit || 0));
    if (debit && credit) fieldErrors[`lines.${i}`] = 'A line may carry a debit or a credit, not both';
    if (!debit && !credit && !(explicitBase && (baseDebitIn || baseCreditIn))) {
      fieldErrors[`lines.${i}`] = 'A line must carry a debit or a credit';
    }
    if (!l.account_id) { fieldErrors[`lines.${i}.account_id`] = 'Account is required'; return; }
    const acct = repo.get('account', l.account_id);
    if (!acct) { fieldErrors[`lines.${i}.account_id`] = `Account ${l.account_id} not found`; return; }
    if (acct.is_summary) { fieldErrors[`lines.${i}.account_id`] = `${acct.number} ${acct.name} is a summary account and cannot be posted to`; return; }
    if (!acct.active) { fieldErrors[`lines.${i}.account_id`] = `${acct.number} ${acct.name} is inactive`; return; }
    if (acct.subsidiary_id && acct.subsidiary_id !== subsidiary_id) {
      fieldErrors[`lines.${i}.account_id`] = `${acct.number} ${acct.name} belongs to a different subsidiary`; return;
    }
    prepared.push({
      ...l, account: acct, debit, credit,
      base_debit: explicitBase ? baseDebitIn : Money.convert(debit, rate),
      base_credit: explicitBase ? baseCreditIn : Money.convert(credit, rate),
    });
  });
  if (Object.keys(fieldErrors).length) throw new ValidationError(fieldErrors);

  // ---- balance check, in transaction currency and in base currency
  const txnDiff = sum(prepared, (l) => l.debit) - sum(prepared, (l) => l.credit);
  if (txnDiff !== 0) {
    throw unprocessable(
      `Journal entry does not balance: debits ${Money.format(sum(prepared, (l) => l.debit), txnCurrency)} vs credits ${Money.format(sum(prepared, (l) => l.credit), txnCurrency)} (out by ${Money.format(Math.abs(txnDiff), txnCurrency)}).`);
  }

  let baseDiff = sum(prepared, (l) => l.base_debit) - sum(prepared, (l) => l.base_credit);
  if (baseDiff !== 0) {
    // Per-line FX rounding can leave a cent or two. Absorb it into the
    // realised FX account rather than refusing an otherwise valid entry.
    const tolerance = Math.max(TOLERANCE_PER_LINE, prepared.length * TOLERANCE_PER_LINE);
    if (Math.abs(baseDiff) > tolerance) {
      throw unprocessable(`Currency conversion left the entry out of balance by ${Money.format(Math.abs(baseDiff), baseCurrency)}, which exceeds the rounding tolerance. Check the exchange rate for ${txnCurrency}→${baseCurrency} on ${txn_date}.`);
    }
    const fxAccount = accountBySubtype(repo, 'OTHER_EXPENSE') || accountBySubtype(repo, 'OTHER_INCOME') || prepared[0].account;
    prepared.push({
      account: fxAccount, account_id: fxAccount.id, memo: 'FX rounding',
      debit: 0, credit: 0,
      base_debit: baseDiff < 0 ? -baseDiff : 0,
      base_credit: baseDiff > 0 ? baseDiff : 0,
    });
    baseDiff = 0;
  }

  const totalBaseDebit = sum(prepared, (l) => l.base_debit);
  const totalBaseCredit = sum(prepared, (l) => l.base_credit);

  // ---- write
  const now = nowIso();
  const entryId = ulid();
  const number = entry_no || nextNumber(repo, 'journal_entry');

  repo.insert('journal_entry', {
    id: entryId, entry_no: number, subsidiary_id, period_id: period.id, txn_date,
    currency: txnCurrency, fx_rate: rate, memo, source_type, source_id, status,
    is_reversal: is_reversal ? 1 : 0, reverses_id,
    total_debit: totalBaseDebit, total_credit: totalBaseCredit,
    posted_at: status === 'posted' ? now : null,
    posted_by: status === 'posted' ? (repo.ctx?.user?.id || null) : null,
    approval_status: 'approved', custom, created_at: now, created_by: repo.ctx?.user?.id || null,
  });

  prepared.forEach((l, i) => {
    repo.insert('journal_line', {
      id: ulid(), entry_id: entryId, line_no: i + 1, account_id: l.account_id || l.account.id,
      memo: l.memo || '', debit: l.debit, credit: l.credit, currency: txnCurrency, fx_rate: rate,
      base_debit: l.base_debit, base_credit: l.base_credit,
      entity_type: l.entity_type || null, entity_id: l.entity_id || null,
      department_id: l.department_id || null, location_id: l.location_id || null,
      class_id: l.class_id || null, item_id: l.item_id || null,
    });
    if (status === 'posted') {
      repo.exec(`INSERT INTO gl_balance (tenant_id, subsidiary_id, period_id, account_id, base_debit, base_credit)
                 VALUES (:t,?,?,?,?,?)
                 ON CONFLICT (tenant_id, subsidiary_id, period_id, account_id)
                 DO UPDATE SET base_debit = base_debit + excluded.base_debit,
                               base_credit = base_credit + excluded.base_credit`,
        [subsidiary_id, period.id, l.account_id || l.account.id, l.base_debit, l.base_credit]);
    }
  });

  audit.record(repo, {
    recordType: 'journal_entry', recordId: entryId, action: status === 'posted' ? 'post' : 'create',
    changes: {
      entry_no: { from: null, to: number },
      total: { from: null, to: Money.toNumber(totalBaseDebit) },
      source: { from: null, to: `${source_type}${source_id ? ':' + source_id : ''}` },
      lines: { from: null, to: prepared.length },
    },
  });
  indexRecord(repo, 'journal_entry', entryId, {
    title: `${number} · ${Money.format(totalBaseDebit, baseCurrency)}`,
    subtitle: `${txn_date} · ${source_type}`,
    body: [memo, ...prepared.map((l) => `${l.account.number} ${l.account.name} ${l.memo || ''}`)].join(' '),
  });

  return getJournalEntry(repo, entryId);
}

export function getJournalEntry(repo, id) {
  const e = repo.get('journal_entry', id);
  if (!e) return null;
  e.lines = repo.query(`SELECT jl.*, a.number account_number, a.name account_name, a.type account_type
                        FROM journal_line jl JOIN account a ON a.tenant_id = jl.tenant_id AND a.id = jl.account_id
                        WHERE jl.tenant_id = :t AND jl.entry_id = ? ORDER BY jl.line_no`, [id]);
  e.period = repo.get('accounting_period', e.period_id);
  e.subsidiary = repo.get('subsidiary', e.subsidiary_id);
  return e;
}

/** Reverse a posted entry. The only sanctioned way to undo the ledger. */
export function reverseJournal(repo, id, { date = null, memo = null } = {}) {
  const original = getJournalEntry(repo, id);
  if (!original) throw notFound('Journal entry not found');
  if (original.status !== 'posted') throw unprocessable('Only a posted entry can be reversed.');
  if (original.reversed_by_id) throw unprocessable(`This entry was already reversed by ${repo.get('journal_entry', original.reversed_by_id)?.entry_no || 'another entry'}.`);

  const reversal = postJournal(repo, {
    subsidiary_id: original.subsidiary_id,
    txn_date: date || original.txn_date,
    currency: original.currency,
    fx_rate: original.fx_rate,
    memo: memo || `Reversal of ${original.entry_no}${original.memo ? ' — ' + original.memo : ''}`,
    source_type: original.source_type, source_id: original.source_id,
    is_reversal: 1, reverses_id: original.id,
    // Base amounts are carried across, not recomputed: an entry that used more
    // than one rate — a settlement, say — would otherwise reverse at a single
    // rate and leave a residue behind that nothing accounts for.
    lines: original.lines.map((l) => ({
      account_id: l.account_id, memo: l.memo,
      debit: l.credit, credit: l.debit,               // swapped
      base_debit: l.base_credit, base_credit: l.base_debit,
      entity_type: l.entity_type, entity_id: l.entity_id,
      department_id: l.department_id, location_id: l.location_id,
      class_id: l.class_id, item_id: l.item_id,
    })),
  });
  repo.update('journal_entry', id, { reversed_by_id: reversal.id });
  audit.record(repo, { recordType: 'journal_entry', recordId: id, action: 'reverse', changes: { reversed_by: { from: null, to: reversal.entry_no } } });
  return reversal;
}

// ------------------------------------------------------------- balances
/** accountId -> signed base-currency balance (debit-positive). */
export function balanceMap(repo, { throughPeriodId = null, periodId = null, subsidiaryId = null, fromPeriodId = null } = {}) {
  const params = []; let where = '';
  if (periodId) { where += ' AND gb.period_id = ?'; params.push(periodId); }
  if (throughPeriodId) {
    const p = repo.get('accounting_period', throughPeriodId);
    if (p) { where += ' AND ap.end_date <= ?'; params.push(p.end_date); }
  }
  if (fromPeriodId) {
    const p = repo.get('accounting_period', fromPeriodId);
    if (p) { where += ' AND ap.start_date >= ?'; params.push(p.start_date); }
  }
  if (subsidiaryId) { where += ' AND gb.subsidiary_id = ?'; params.push(subsidiaryId); }
  const rows = repo.query(`SELECT gb.account_id, SUM(gb.base_debit) d, SUM(gb.base_credit) c
      FROM gl_balance gb JOIN accounting_period ap ON ap.tenant_id = gb.tenant_id AND ap.id = gb.period_id
      WHERE gb.tenant_id = :t${where} GROUP BY gb.account_id`, params);
  const out = {};
  for (const r of rows) out[r.account_id] = (r.d || 0) - (r.c || 0);
  return out;
}

/** Ledger detail for one account: opening balance plus movements. */
export function accountLedger(repo, accountId, { from, to, subsidiaryId = null, limit = 500 } = {}) {
  const acct = getAccount(repo, accountId);
  const params = [accountId];
  let where = '';
  if (from) { where += ' AND je.txn_date >= ?'; params.push(from); }
  if (to) { where += ' AND je.txn_date <= ?'; params.push(to); }
  if (subsidiaryId) { where += ' AND je.subsidiary_id = ?'; params.push(subsidiaryId); }

  const openingParams = [accountId];
  let openingWhere = '';
  if (from) { openingWhere += ' AND je.txn_date < ?'; openingParams.push(from); }
  if (subsidiaryId) { openingWhere += ' AND je.subsidiary_id = ?'; openingParams.push(subsidiaryId); }
  const op = repo.queryOne(`SELECT COALESCE(SUM(jl.base_debit),0) d, COALESCE(SUM(jl.base_credit),0) c
      FROM journal_line jl JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
      WHERE jl.tenant_id = :t AND jl.account_id = ? AND je.status = 'posted'${openingWhere}`, openingParams);
  const opening = (op?.d || 0) - (op?.c || 0);

  const lines = repo.query(`SELECT jl.*, je.entry_no, je.txn_date, je.memo entry_memo, je.source_type, je.source_id, je.subsidiary_id
      FROM journal_line jl JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
      WHERE jl.tenant_id = :t AND jl.account_id = ? AND je.status = 'posted'${where}
      ORDER BY je.txn_date, je.entry_no, jl.line_no LIMIT ?`, [...params, limit]);

  let running = opening;
  for (const l of lines) { running += (l.base_debit || 0) - (l.base_credit || 0); l.running_balance = running; }
  return { account: acct, opening, closing: running, lines };
}

/**
 * Integrity check: does the materialised rollup still equal the detail, and
 * is the ledger balanced? Exposed at /api/v1/reports/integrity and run by
 * the test suite. A financial system should be able to prove this on demand.
 */
export function integrityCheck(repo) {
  const drift = repo.query(`
    SELECT gb.account_id, gb.period_id, gb.subsidiary_id,
           gb.base_debit rollup_debit, gb.base_credit rollup_credit,
           COALESCE(d.debit,0) detail_debit, COALESCE(d.credit,0) detail_credit
    FROM gl_balance gb
    LEFT JOIN (
      SELECT je.subsidiary_id, je.period_id, jl.account_id,
             SUM(jl.base_debit) debit, SUM(jl.base_credit) credit
      FROM journal_line jl JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
      WHERE jl.tenant_id = :t AND je.status = 'posted'
      GROUP BY je.subsidiary_id, je.period_id, jl.account_id
    ) d ON d.subsidiary_id = gb.subsidiary_id AND d.period_id = gb.period_id AND d.account_id = gb.account_id
    WHERE gb.tenant_id = :t
      AND (gb.base_debit != COALESCE(d.debit,0) OR gb.base_credit != COALESCE(d.credit,0))`, []);

  const unbalanced = repo.query(`SELECT je.id, je.entry_no, je.txn_date,
      SUM(jl.base_debit) d, SUM(jl.base_credit) c
      FROM journal_entry je JOIN journal_line jl ON jl.tenant_id = je.tenant_id AND jl.entry_id = je.id
      WHERE je.tenant_id = :t AND je.status = 'posted'
      GROUP BY je.id HAVING SUM(jl.base_debit) != SUM(jl.base_credit)`, []);

  const totals = repo.queryOne(`SELECT COALESCE(SUM(base_debit),0) d, COALESCE(SUM(base_credit),0) c
                                FROM gl_balance WHERE tenant_id = :t`);
  const orphanLines = repo.scalar(`SELECT COUNT(*) c FROM journal_line jl
      LEFT JOIN account a ON a.tenant_id = jl.tenant_id AND a.id = jl.account_id
      WHERE jl.tenant_id = :t AND a.id IS NULL`, [], 0);

  const subledgers = tieOuts(repo);
  const tied = subledgers.every((s) => s.difference === 0);

  return {
    ok: drift.length === 0 && unbalanced.length === 0 && (totals.d === totals.c)
        && orphanLines === 0 && tied,
    rollup_drift: drift,
    unbalanced_entries: unbalanced,
    orphan_lines: orphanLines,
    ledger_total_debits: totals.d,
    ledger_total_credits: totals.c,
    ledger_balanced: totals.d === totals.c,
    subledgers,
    subledgers_tied: tied,
    checked_at: nowIso(),
  };
}

/**
 * Control accounts against the subledgers that are supposed to explain them.
 *
 * A ledger can balance perfectly and still be wrong: every entry has equal
 * debits and credits while the receivables account no longer equals the
 * invoices behind it, or the inventory account no longer equals the stock on
 * the shelf. Those two numbers parting company is the classic way an ERP goes
 * quietly wrong, so the check that catches it belongs here rather than in
 * somebody's spreadsheet at year end.
 */
export function tieOuts(repo) {
  const posted = (accountId, sign) => repo.scalar(
    `SELECT COALESCE(SUM(${sign === -1 ? 'jl.base_credit - jl.base_debit' : 'jl.base_debit - jl.base_credit'}), 0) v
     FROM journal_line jl JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
     WHERE jl.tenant_id = :t AND je.status = 'posted' AND jl.account_id = ?`, [accountId], 0);

  const out = [];
  const add = (name, account, control, subledger, explain) => {
    if (!account) return;
    out.push({
      name, account: `${account.number} ${account.name}`,
      control, subledger, difference: control - subledger, explain,
    });
  };

  // `amount_remaining` is a magnitude in the document's own currency, and each
  // balance is valued at the rate it went on the books at -- which is what the
  // control account is actually holding. Direction is per type: an invoice is
  // owed to us, a credit memo is owed back, and the unapplied part of a
  // payment is money the customer has already handed over with nothing to
  // settle it against. That last one is why overpaying, or unapplying a
  // receipt, has to count: the cash credited the control account in full, and
  // a subledger that only knows about invoices would look short by the change.
  const openBalance = (types, negated) => repo.scalar(
    `SELECT COALESCE(SUM(CAST(ROUND(amount_remaining * fx_rate) AS INTEGER)
                         * CASE WHEN type IN (${negated.map(() => '?').join(',')}) THEN -1 ELSE 1 END), 0) v
     FROM txn WHERE tenant_id = :t AND type IN (${types.map(() => '?').join(',')})
       AND status NOT IN ('voided','cancelled')`, [...negated, ...types], 0);

  const ar = accountBySubtype(repo, 'AR');
  if (ar) {
    add('Receivables', ar, posted(ar.id, 1),
      openBalance(['INVOICE', 'CREDIT_MEMO', 'CUSTOMER_PAYMENT'], ['CREDIT_MEMO', 'CUSTOMER_PAYMENT']),
      'open customer invoices, less unapplied credit memos and receipts on account');
  }
  const ap = accountBySubtype(repo, 'AP');
  if (ap) {
    add('Payables', ap, posted(ap.id, -1),
      openBalance(['VENDOR_BILL', 'VENDOR_RETURN', 'VENDOR_PAYMENT'], ['VENDOR_RETURN', 'VENDOR_PAYMENT']),
      'unpaid vendor bills, less open vendor returns and payments on account');
  }
  const inventory = accountBySubtype(repo, 'INVENTORY');
  if (inventory) {
    add('Inventory', inventory, posted(inventory.id, 1),
      repo.scalar('SELECT COALESCE(SUM(total_value),0) v FROM item_location WHERE tenant_id = :t', [], 0),
      'stock valuation across all locations');
  }
  return out;
}

/**
 * Delete a journal entry. Only a draft may go: a posted entry is part of the
 * record, and destroying it leaves the materialised balances describing money
 * that is no longer in the journal. Reverse it instead — that is what a
 * correction looks like in a ledger, and it leaves both halves visible.
 */
export function deleteJournalEntry(repo, id) {
  const entry = getJournalEntry(repo, id);
  if (!entry) throw notFound('Journal entry not found');
  if (entry.status === 'posted') {
    throw unprocessable(
      `${entry.entry_no} is posted and cannot be deleted. Reverse it instead: `
      + 'the reversal and the original both stay on the record, which is what an audit expects to find.');
  }
  if (repo.scalar('SELECT COUNT(*) c FROM txn WHERE tenant_id = :t AND journal_entry_id = ?', [id], 0) > 0) {
    throw unprocessable(`${entry.entry_no} belongs to a transaction. Void the transaction instead.`);
  }
  repo.exec('DELETE FROM journal_line WHERE tenant_id = :t AND entry_id = ?', [id]);
  repo.remove('journal_entry', id);
  return { ok: true, deleted: id };
}

/** Rebuild gl_balance from journal detail. Recovery tool, not a hot path. */
export function rebuildBalances(repo) {
  repo.exec('DELETE FROM gl_balance WHERE tenant_id = :t');
  const n = repo.exec(`INSERT INTO gl_balance (tenant_id, subsidiary_id, period_id, account_id, base_debit, base_credit)
    SELECT :t, je.subsidiary_id, je.period_id, jl.account_id, SUM(jl.base_debit), SUM(jl.base_credit)
    FROM journal_line jl JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
    WHERE jl.tenant_id = :t AND je.status = 'posted'
    GROUP BY je.subsidiary_id, je.period_id, jl.account_id`, []);
  return Number(n.changes);
}
