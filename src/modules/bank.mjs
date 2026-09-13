// Meridian ERP :: modules/bank
// Cash management: statement import, automatic matching, and reconciliation.
//
// Matching is deliberately conservative. A suggestion is only auto-applied
// when exactly one candidate matches on amount within a date window; anything
// ambiguous is surfaced for a human. Silently mis-matching cash is worse than
// leaving a line unreconciled.
import { ulid, nowIso, today, Money, addDays, daysBetween, sum } from '../core/util.mjs';
import { notFound, unprocessable, ValidationError, conflict } from '../core/http.mjs';
import * as audit from '../core/audit.mjs';
import * as gl from './gl.mjs';

const MATCH_WINDOW_DAYS = 7;

export function listBankAccounts(repo) {
  const rows = repo.query(`SELECT ba.*, a.number account_number, a.name account_name, s.name subsidiary_name
      FROM bank_account ba
      JOIN account a ON a.tenant_id = ba.tenant_id AND a.id = ba.account_id
      LEFT JOIN subsidiary s ON s.tenant_id = ba.tenant_id AND s.id = ba.subsidiary_id
      WHERE ba.tenant_id = :t ORDER BY ba.name`);
  const balances = gl.balanceMap(repo);

  const counts = repo.query(`SELECT bank_account_id, COUNT(*) c FROM bank_txn WHERE tenant_id = :t AND status IN ('unmatched','matched') GROUP BY bank_account_id`);
  const countMap = new Map(counts.map((r) => [r.bank_account_id, r.c]));

  const latest = repo.query(`SELECT r.bank_account_id, r.statement_date, r.statement_balance
      FROM reconciliation r JOIN (SELECT bank_account_id, MAX(statement_date) as max_date FROM reconciliation
          WHERE tenant_id = :t AND status = 'completed' GROUP BY bank_account_id) as m
          ON r.bank_account_id = m.bank_account_id AND r.statement_date = m.max_date
      WHERE r.tenant_id = :t`);
  const statementMap = new Map(latest.map((r) => [r.bank_account_id, { statement_date: r.statement_date, statement_balance: r.statement_balance }]));

  for (const r of rows) {
    r.gl_balance = balances[r.account_id] || 0;
    r.unreconciled_count = countMap.get(r.id) || 0;
    r.last_statement = statementMap.get(r.id) || null;
  }
  return rows;
}

/**
 * Import statement lines. `external_id` makes the import idempotent: the same
 * file can be uploaded twice without duplicating cash.
 */
export function importStatement(repo, bankAccountId, lines, { source = 'manual' } = {}) {
  const ba = repo.get('bank_account', bankAccountId);
  if (!ba) throw notFound('Bank account not found');
  if (!Array.isArray(lines) || !lines.length) throw new ValidationError({ lines: 'No statement lines supplied' });

  let imported = 0, skipped = 0;
  const now = nowIso();

  const linesWithIds = lines.map((l) => {
    const date = String(l.date || l.txn_date || '').slice(0, 10);
    const amount = Money.parse(l.amount);
    const externalId = l.external_id || l.id || `${date}|${amount}|${String(l.description || '').slice(0, 40)}`;
    return { l, date, amount, externalId };
  });

  const existingIds = new Set(repo.query(`SELECT external_id FROM bank_txn WHERE tenant_id = :t AND bank_account_id = ? AND external_id IN (${linesWithIds.map(() => '?').join(',')})`,
    [bankAccountId, ...linesWithIds.map((x) => x.externalId)]).map((r) => r.external_id));

  for (const { l, date, amount, externalId } of linesWithIds) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { skipped++; continue; }
    if (!amount) { skipped++; continue; }
    if (existingIds.has(externalId)) { skipped++; continue; }
    repo.insert('bank_txn', {
      id: ulid(), bank_account_id: bankAccountId, txn_date: date,
      description: String(l.description || '').slice(0, 400), reference: String(l.reference || '').slice(0, 100),
      amount, status: 'unmatched', external_id: externalId, imported_at: now,
    });
    imported++;
  }
  audit.record(repo, { recordType: 'bank_txn', recordId: bankAccountId, action: 'import', changes: { imported: { from: null, to: imported }, skipped: { from: null, to: skipped }, source: { from: null, to: source } } });
  return { imported, skipped, total: lines.length };
}

/** Date parsing helpers for bank statements. */
function isValidDate(y, m, d) {
  const date = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
  return date.getFullYear() === parseInt(y) &&
         date.getMonth() === parseInt(m) - 1 &&
         date.getDate() === parseInt(d);
}

function normalizeDate(raw, dateFormat) {
  if (!raw) return null;
  const trimmed = raw.trim();
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    if (isValidDate(y, m, d)) return `${y}-${m}-${d}`;
  }
  const ymdSepMatch = trimmed.match(/^(\d{4})([/.-])(\d{1,2})\2(\d{1,2})$/);
  if (ymdSepMatch && dateFormat === 'YMD') {
    const [, y, , m, d] = ymdSepMatch;
    const paddedM = m.padStart(2, '0');
    const paddedD = d.padStart(2, '0');
    if (isValidDate(y, paddedM, paddedD)) return `${y}-${paddedM}-${paddedD}`;
  }
  const sepMatch = trimmed.match(/^(\d{1,2})([/.-])(\d{1,2})\2(\d{2,4})$/);
  if (sepMatch) {
    let [, a, sep, b, y] = sepMatch;
    if (y.length === 2) {
      const century = parseInt(y) > 50 ? '19' : '20';
      y = century + y;
    }
    const [dd, mm] = dateFormat === 'MDY' ? [b, a] : [a, b];
    const paddedM = mm.padStart(2, '0');
    const paddedD = dd.padStart(2, '0');
    if (isValidDate(y, paddedM, paddedD)) {
      return `${y}-${paddedM}-${paddedD}`;
    }
  }
  return null;
}

function inferDateFormat(text, split) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return null;
  const header = split(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z]/g, ''));
  const iDate = header.findIndex((h) => ['date', 'transactiondate', 'postingdate', 'valuedate'].includes(h));
  if (iDate === -1) return null;

  let canBeDMY = true, canBeMDY = true;
  for (const line of lines.slice(1)) {
    const c = split(line);
    const raw = c[iDate];
    if (!raw) continue;
    const trimmed = raw.trim();
    const sepMatch = trimmed.match(/^(\d{1,2})([/.-])(\d{1,2})\2(\d{2,4})$/);
    if (!sepMatch) continue;
    let [, a, sep, b, y] = sepMatch;
    if (y.length === 2) {
      const century = parseInt(y) > 50 ? '19' : '20';
      y = century + y;
    }
    if (!isValidDate(y, b, a)) canBeDMY = false;
    if (!isValidDate(y, a, b)) canBeMDY = false;
  }
  if (canBeDMY && !canBeMDY) return 'DMY';
  if (!canBeDMY && canBeMDY) return 'MDY';
  if (!canBeDMY && !canBeMDY) return null;
  return 'ambiguous';
}

/** Parse a CSV statement. Header row required; column names are flexible. */
export function parseStatementCsv(text, { dateFormat = 'auto' } = {}) {
  const rows = [];
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return rows;
  const split = (line) => {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const header = split(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z]/g, ''));
  const find = (...names) => header.findIndex((h) => names.includes(h));
  const iDate = find('date', 'transactiondate', 'postingdate', 'valuedate');
  const iDesc = find('description', 'details', 'narrative', 'memo', 'payee');
  const iAmount = find('amount', 'value');
  const iDebit = find('debit', 'withdrawal', 'paidout');
  const iCredit = find('credit', 'deposit', 'paidin');
  const iRef = find('reference', 'ref', 'chequenumber');

  let activeFormat = dateFormat;
  if (dateFormat === 'auto') {
    activeFormat = inferDateFormat(text, split);
    if (!activeFormat || activeFormat === 'ambiguous') {
      throw new ValidationError({}, `Could not determine date format from CSV. It is either ambiguous or invalid. Please specify DMY, MDY or YMD on the bank account.`);
    }
  }

  for (const line of lines.slice(1)) {
    const c = split(line);
    if (!c.length || !c[iDate]) continue;
    const date = normalizeDate(c[iDate], activeFormat);
    if (!date) continue;
    let amount;
    if (iAmount >= 0 && c[iAmount]) amount = c[iAmount];
    else {
      const d = iDebit >= 0 ? Money.parse(c[iDebit]) : 0;
      const cr = iCredit >= 0 ? Money.parse(c[iCredit]) : 0;
      amount = Money.toNumber(cr - d);
    }
    rows.push({ date: date.slice(0, 10), description: iDesc >= 0 ? c[iDesc] : '', reference: iRef >= 0 ? c[iRef] : '', amount });
  }
  return rows;
}

/**
 * Suggest ledger matches for unreconciled statement lines.
 * Confidence: exact amount + same day = high; amount within the window = medium.
 */
export function suggestMatches(repo, bankAccountId, { autoApply = false } = {}) {
  const ba = repo.get('bank_account', bankAccountId);
  if (!ba) throw notFound('Bank account not found');
  const unmatched = repo.query(`SELECT * FROM bank_txn WHERE tenant_id = :t AND bank_account_id = ? AND status = 'unmatched'
      ORDER BY txn_date`, [bankAccountId]);

  const suggestions = [];
  let applied = 0;
  for (const bt of unmatched) {
    const from = addDays(bt.txn_date, -MATCH_WINDOW_DAYS);
    const to = addDays(bt.txn_date, MATCH_WINDOW_DAYS);
    // Candidate journal lines that hit this bank's GL account for this amount.
    const target = Math.abs(bt.amount);
    const candidates = repo.query(`SELECT jl.id line_id, je.id entry_id, je.entry_no, je.txn_date, je.memo,
        je.source_type, je.source_id, jl.base_debit, jl.base_credit
        FROM journal_line jl JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
        WHERE jl.tenant_id = :t AND jl.account_id = ? AND je.status = 'posted'
          AND je.txn_date BETWEEN ? AND ?
          AND ((? > 0 AND jl.base_debit = ?) OR (? < 0 AND jl.base_credit = ?))
          AND NOT EXISTS (SELECT 1 FROM bank_txn b2 WHERE b2.tenant_id = jl.tenant_id AND b2.matched_journal_id = je.id AND b2.id != ?)
        ORDER BY ABS(julianday(je.txn_date) - julianday(?))`,
      [ba.account_id, from, to, bt.amount, target, bt.amount, target, bt.id, bt.txn_date]);

    const scored = candidates.map((c) => ({
      ...c,
      day_gap: Math.abs(daysBetween(c.txn_date, bt.txn_date)),
      confidence: c.txn_date === bt.txn_date ? 'high' : Math.abs(daysBetween(c.txn_date, bt.txn_date)) <= 3 ? 'medium' : 'low',
    }));
    const suggestion = { bank_txn: bt, candidates: scored.slice(0, 5) };
    suggestions.push(suggestion);

    // Auto-apply only when there is exactly one candidate and it is confident.
    if (autoApply && scored.length === 1 && scored[0].confidence !== 'low') {
      applyMatch(repo, bt.id, scored[0].entry_id);
      applied++;
      suggestion.auto_applied = true;
    }
  }
  return { suggestions, unmatched_count: unmatched.length, auto_applied: applied };
}

export function applyMatch(repo, bankTxnId, journalEntryId) {
  const bt = repo.get('bank_txn', bankTxnId);
  if (!bt) throw notFound('Statement line not found');
  if (bt.status === 'reconciled') throw conflict('That line is already reconciled.');
  const je = repo.get('journal_entry', journalEntryId);
  if (!je) throw notFound('Journal entry not found');
  repo.update('bank_txn', bankTxnId, { status: 'matched', matched_journal_id: journalEntryId });
  audit.record(repo, { recordType: 'bank_txn', recordId: bankTxnId, action: 'match', changes: { journal_entry: { from: null, to: je.entry_no } } });
  return repo.get('bank_txn', bankTxnId);
}

export function unmatch(repo, bankTxnId) {
  const bt = repo.get('bank_txn', bankTxnId);
  if (!bt) throw notFound('Statement line not found');
  if (bt.status === 'reconciled') throw unprocessable('Reopen the reconciliation before unmatching this line.');
  repo.update('bank_txn', bankTxnId, { status: 'unmatched', matched_journal_id: null, matched_txn_id: null });
  return repo.get('bank_txn', bankTxnId);
}

/** Start a reconciliation against a statement balance. */
export function startReconciliation(repo, { bank_account_id, statement_date, statement_balance }) {
  const ba = repo.get('bank_account', bank_account_id);
  if (!ba) throw notFound('Bank account not found');
  const open = repo.queryOne(`SELECT * FROM reconciliation WHERE tenant_id = :t AND bank_account_id = ? AND status = 'in_progress'`, [bank_account_id]);
  if (open) throw conflict(`A reconciliation for ${ba.name} dated ${open.statement_date} is already in progress.`);

  const id = repo.insert('reconciliation', {
    id: ulid(), bank_account_id, statement_date, statement_balance: Money.parse(statement_balance),
    cleared_balance: 0, difference: 0, status: 'in_progress', created_at: nowIso(),
  });
  return reconciliationState(repo, id);
}

/** Current state of a reconciliation: cleared items and the remaining gap. */
export function reconciliationState(repo, id) {
  const rec = repo.get('reconciliation', id);
  if (!rec) throw notFound('Reconciliation not found');
  const ba = repo.get('bank_account', rec.bank_account_id);

  const priorCleared = repo.scalar(`SELECT COALESCE(SUM(bt.amount),0) v FROM bank_txn bt
      JOIN reconciliation r ON r.tenant_id = bt.tenant_id AND r.id = bt.reconciliation_id
      WHERE bt.tenant_id = :t AND bt.bank_account_id = ? AND r.status = 'completed'`, [rec.bank_account_id], 0);

  const lines = repo.query(`SELECT bt.*, je.entry_no, je.memo entry_memo FROM bank_txn bt
      LEFT JOIN journal_entry je ON je.tenant_id = bt.tenant_id AND je.id = bt.matched_journal_id
      WHERE bt.tenant_id = :t AND bt.bank_account_id = ? AND bt.txn_date <= ?
        AND (bt.reconciliation_id = ? OR bt.reconciliation_id IS NULL)
        AND bt.status != 'ignored'
      ORDER BY bt.txn_date`, [rec.bank_account_id, rec.statement_date, id]);

  const selected = lines.filter((l) => l.reconciliation_id === id || l.status === 'matched');
  const cleared = priorCleared + sum(selected, (l) => l.amount);
  const difference = rec.statement_balance - cleared;
  const glBalance = gl.balanceMap(repo)[ba.account_id] || 0;

  return {
    reconciliation: rec, bank_account: ba, lines,
    selected_ids: selected.map((l) => l.id),
    cleared_balance: cleared, statement_balance: rec.statement_balance,
    difference, gl_balance: glBalance,
    unmatched_count: lines.filter((l) => l.status === 'unmatched').length,
    can_complete: difference === 0,
  };
}

export function setReconciled(repo, id, bankTxnIds) {
  const rec = repo.get('reconciliation', id);
  if (!rec) throw notFound('Reconciliation not found');
  if (rec.status !== 'in_progress') throw unprocessable('That reconciliation is already complete.');
  repo.exec('UPDATE bank_txn SET reconciliation_id = NULL WHERE tenant_id = :t AND reconciliation_id = ?', [id]);
  for (const btId of bankTxnIds || []) {
    repo.exec('UPDATE bank_txn SET reconciliation_id = ? WHERE tenant_id = :t AND id = ? AND bank_account_id = ?', [id, btId, rec.bank_account_id]);
  }
  return reconciliationState(repo, id);
}

export function completeReconciliation(repo, id, { force = false } = {}) {
  const state = reconciliationState(repo, id);
  if (!force && state.difference !== 0) {
    throw unprocessable(`The statement is out by ${Money.format(Math.abs(state.difference), state.bank_account.currency)}. Match the remaining lines, or record an adjustment, before completing.`);
  }
  repo.update('reconciliation', id, {
    cleared_balance: state.cleared_balance, difference: state.difference,
    status: 'completed', completed_at: nowIso(), completed_by: repo.ctx?.user?.id || null,
  });
  repo.exec("UPDATE bank_txn SET status = 'reconciled' WHERE tenant_id = :t AND reconciliation_id = ?", [id]);
  audit.record(repo, {
    recordType: 'reconciliation', recordId: id, action: 'complete',
    changes: { cleared: { from: null, to: Money.toNumber(state.cleared_balance) }, difference: { from: null, to: Money.toNumber(state.difference) } },
  });
  return repo.get('reconciliation', id);
}

/** Rolling cash position across every bank account. */
export function cashPosition(repo, { days = 30 } = {}) {
  const accounts = listBankAccounts(repo);
  const totalCash = sum(accounts, (a) => a.gl_balance);
  const horizon = addDays(today(), days);
  const inflow = repo.scalar(`SELECT COALESCE(SUM(amount_remaining),0) v FROM txn WHERE tenant_id = :t
      AND type='INVOICE' AND amount_remaining > 0 AND status NOT IN ('voided','cancelled') AND due_date <= ?`, [horizon], 0);
  const outflow = repo.scalar(`SELECT COALESCE(SUM(amount_remaining),0) v FROM txn WHERE tenant_id = :t
      AND type='VENDOR_BILL' AND amount_remaining > 0 AND status NOT IN ('voided','cancelled') AND due_date <= ?`, [horizon], 0);
  const overdueIn = repo.scalar(`SELECT COALESCE(SUM(amount_remaining),0) v FROM txn WHERE tenant_id = :t
      AND type='INVOICE' AND amount_remaining > 0 AND due_date < date('now')`, [], 0);
  return {
    accounts, total_cash: totalCash, horizon_days: days,
    expected_inflow: inflow, expected_outflow: outflow,
    overdue_receivable: overdueIn,
    projected_cash: totalCash + inflow - outflow,
    net_position: inflow - outflow,
  };
}
