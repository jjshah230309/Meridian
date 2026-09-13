// Meridian ERP :: modules/revaluation
// Period-end restatement of open foreign-currency balances.
//
// A sterling invoice raised in January at 1.25 is still carried at 1.25 in
// March, when the rate is 1.40. The company is owed the same £2,000, but that
// is now worth $2,800 rather than $2,500, and until somebody says so the
// balance sheet is understated by $300 that nothing in the ledger explains.
//
// Three exposures move: what customers owe, what is owed to suppliers, and
// cash sitting in a foreign account. Each is measured the same way -- take the
// balance in its own currency, value it at the closing rate, and compare that
// with what the ledger is carrying.
//
// The adjustment is *unrealised*: no money has moved and the rate may go back.
// So it posts on the closing date and reverses on the first day of the next
// period. The documents themselves keep the rate they were booked at, which
// is exactly what settlement needs in order to work out the realised
// difference when the cash finally arrives.
import { ulid, Money, nowIso, today, isValidDate, addDays, sum } from '../core/util.mjs';
import { ValidationError, notFound, unprocessable, conflict } from '../core/http.mjs';
import { nextNumber } from '../core/seq.mjs';
import * as gl from './gl.mjs';
import { postingAccounts } from './setup.mjs';
import * as audit from '../core/audit.mjs';

export const SCOPES = ['receivable', 'payable', 'bank'];

const SCOPE_LABEL = { receivable: 'Receivables', payable: 'Payables', bank: 'Bank accounts' };

/** Open settlement documents, by side. Same definition the AR/AP tie-out uses. */
const OPEN_DOCS = {
  receivable: { account: 'ar', types: ['INVOICE', 'CREDIT_MEMO', 'CUSTOMER_PAYMENT'], negated: ['CREDIT_MEMO', 'CUSTOMER_PAYMENT'], entity: 'customer' },
  payable: { account: 'ap', types: ['VENDOR_BILL', 'VENDOR_RETURN', 'VENDOR_PAYMENT'], negated: ['VENDOR_RETURN', 'VENDOR_PAYMENT'], entity: 'vendor' },
};

/**
 * What each exposure is worth today against what the ledger says.
 *
 * Nothing is written. The screen shows this before anybody posts, and the run
 * itself calls the same function, so what is previewed is what is posted.
 */
export function exposures(repo, { as_of = today(), subsidiary_id = null, scopes = SCOPES } = {}) {
  if (!isValidDate(as_of)) throw new ValidationError({ as_of: 'Enter a valid date' });
  const wanted = (Array.isArray(scopes) ? scopes : [scopes]).filter((s) => SCOPES.includes(s));
  if (!wanted.length) throw new ValidationError({ scopes: `Choose at least one of ${SCOPES.join(', ')}` });

  const sub = subsidiary_id || repo.queryOne('SELECT id FROM subsidiary WHERE tenant_id = :t ORDER BY created_at LIMIT 1')?.id;
  if (!sub) throw unprocessable('No subsidiary is set up to revalue.');
  const base = gl.subsidiaryCurrency(repo, sub) || 'USD';
  const acc = postingAccounts(repo);

  const rates = new Map();
  const rateFor = (ccy) => {
    if (!rates.has(ccy)) rates.set(ccy, gl.exchangeRate(repo, ccy, base, as_of));
    return rates.get(ccy);
  };

  const lines = [];
  for (const scope of wanted) {
    if (scope === 'bank') { lines.push(...bankExposures(repo, { sub, base, as_of, rateFor })); continue; }
    const cfg = OPEN_DOCS[scope];
    const accountId = acc[cfg.account];
    if (!accountId) continue;
    const ph = cfg.types.map(() => '?').join(',');
    const rows = repo.query(
      `SELECT t.id, t.type, t.txn_no, t.currency, t.fx_rate, t.amount_remaining,
              t.entity_type, t.entity_id, t.txn_date,
              COALESCE(c.name, v.name, '') AS entity_name
       FROM txn t
       LEFT JOIN customer c ON c.tenant_id = t.tenant_id AND c.id = t.entity_id
       LEFT JOIN vendor   v ON v.tenant_id = t.tenant_id AND v.id = t.entity_id
       WHERE t.tenant_id = :t AND t.subsidiary_id = ? AND t.type IN (${ph})
         AND t.status NOT IN ('voided', 'cancelled') AND t.posted = 1
         AND t.currency <> ? AND t.amount_remaining <> 0 AND t.txn_date <= ?
       ORDER BY t.currency, t.txn_date, t.txn_no`,
      [sub, ...cfg.types, base, as_of]);

    for (const r of rows) {
      const sign = cfg.negated.includes(r.type) ? -1 : 1;
      const foreign = r.amount_remaining * sign;
      const rate = rateFor(r.currency);
      const booked = Money.convert(foreign, r.fx_rate);
      const revalued = Money.convert(foreign, rate);
      if (revalued === booked) continue;
      lines.push({
        scope, account_id: accountId, currency: r.currency,
        entity_type: r.entity_type, entity_id: r.entity_id, txn_id: r.id, bank_account_id: null,
        label: `${r.txn_no}${r.entity_name ? ` · ${r.entity_name}` : ''}`,
        foreign_amount: foreign, rate_booked: r.fx_rate, rate_used: rate,
        booked_base: booked, revalued_base: revalued, adjustment: revalued - booked,
      });
    }
  }

  // The exposure is measured off the documents, which a revaluation never
  // touches -- so the same gap is still visible after the entry is posted.
  // Say which run covered this date, or the screen invites a second one.
  const already = repo.queryOne(
    `SELECT id, run_no, net, entry_id, reverse_on, created_at FROM revaluation_run
     WHERE tenant_id = :t AND subsidiary_id = ? AND as_of = ? AND status = 'posted'`, [sub, as_of]) || null;

  const gain = sum(lines.filter((l) => l.adjustment > 0), (l) => l.adjustment);
  const loss = sum(lines.filter((l) => l.adjustment < 0), (l) => -l.adjustment);
  return {
    as_of, subsidiary_id: sub, base_currency: base, scopes: wanted,
    unrealised_account: acc.unrealised_fx || acc.fx || null,
    lines, gain, loss, net: gain - loss, already,
    by_scope: wanted.map((scope) => {
      const own = lines.filter((l) => l.scope === scope);
      return {
        scope, label: SCOPE_LABEL[scope], lines: own.length,
        adjustment: sum(own, (l) => l.adjustment),
        currencies: [...new Set(own.map((l) => l.currency))].sort(),
      };
    }).filter((s) => s.lines),
  };
}

/**
 * A bank account is measured off the ledger rather than off documents: its
 * balance is the sum of everything that ever moved through it, and there is
 * no open-item list to walk.
 */
function bankExposures(repo, { sub, base, as_of, rateFor }) {
  const accounts = repo.query(
    `SELECT b.id, b.name, b.currency, b.account_id, a.number AS account_number
     FROM bank_account b JOIN account a ON a.tenant_id = b.tenant_id AND a.id = b.account_id
     WHERE b.tenant_id = :t AND b.subsidiary_id = ? AND b.active = 1 AND b.currency <> ?
     ORDER BY b.name`, [sub, base]);

  const out = [];
  for (const b of accounts) {
    const bal = repo.queryOne(
      `SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS fx,
              COALESCE(SUM(jl.base_debit - jl.base_credit), 0) AS base
       FROM journal_line jl
       JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
       WHERE jl.tenant_id = :t AND jl.account_id = ? AND jl.currency = ?
         AND je.status = 'posted' AND je.txn_date <= ?`, [b.account_id, b.currency, as_of]);
    const foreign = bal?.fx || 0;
    if (!foreign) continue;
    const rate = rateFor(b.currency);
    const revalued = Money.convert(foreign, rate);
    const booked = bal.base || 0;
    if (revalued === booked) continue;
    out.push({
      scope: 'bank', account_id: b.account_id, currency: b.currency,
      entity_type: null, entity_id: null, txn_id: null, bank_account_id: b.id,
      label: `${b.account_number} · ${b.name}`,
      foreign_amount: foreign,
      rate_booked: foreign ? booked / foreign : 1,
      rate_used: rate,
      booked_base: booked, revalued_base: revalued, adjustment: revalued - booked,
    });
  }
  return out;
}

// ------------------------------------------------------------------- run
/**
 * Post the adjustment, and schedule its own undoing.
 *
 * One journal entry, in base currency, with a line per control or bank
 * account and the balance to Unrealised FX Gain/Loss. Posting in base means
 * the documents' own currency balances are untouched -- only the base
 * carrying value moves, which is the whole point.
 */
export function run(repo, { as_of = today(), subsidiary_id = null, scopes = SCOPES, memo = '', dry_run = false } = {}) {
  const view = exposures(repo, { as_of, subsidiary_id, scopes });
  if (dry_run) return { ...view, dry_run: true, posted: false };

  if (!view.lines.length) throw unprocessable(`Nothing to revalue at ${as_of}: every foreign-currency balance is already carried at the rate on that date.`);
  if (!view.unrealised_account) {
    throw unprocessable('No Unrealised FX Gain/Loss account is configured. Add account 7035 to the chart, or name one in company settings.');
  }
  const period = gl.requireOpenPeriod(repo, as_of);
  const reverseOn = addDays(period.end_date, 1);
  const nextPeriod = gl.periodForDate(repo, reverseOn);
  if (!nextPeriod) throw unprocessable(`The revaluation has to reverse on ${reverseOn}, and no accounting period covers that date. Generate the next fiscal year first.`);
  if (nextPeriod.status !== 'open') throw unprocessable(`The revaluation has to reverse on ${reverseOn}, but ${nextPeriod.name} is ${nextPeriod.status}. Reopen it first.`);

  const existing = repo.queryOne(
    `SELECT run_no FROM revaluation_run WHERE tenant_id = :t AND subsidiary_id = ?
       AND as_of = ? AND status = 'posted'`, [view.subsidiary_id, as_of]);
  if (existing) {
    throw conflict(`${existing.run_no} already revalued ${as_of}. Reverse it before running again, or the same movement is counted twice.`);
  }

  // One posting line per account, because a hundred sterling invoices are one
  // movement on the receivables control account, not a hundred.
  const byAccount = new Map();
  for (const l of view.lines) {
    byAccount.set(l.account_id, (byAccount.get(l.account_id) || 0) + l.adjustment);
  }
  const journalLines = [];
  for (const [accountId, amount] of byAccount) {
    if (!amount) continue;
    journalLines.push({
      account_id: accountId, memo: `Revaluation at ${as_of}`,
      debit: amount > 0 ? amount : 0, credit: amount < 0 ? -amount : 0,
    });
  }
  const net = sum(journalLines, (l) => l.debit) - sum(journalLines, (l) => l.credit);
  if (!net && !journalLines.length) throw unprocessable(`Nothing to revalue at ${as_of}.`);
  journalLines.push({
    account_id: view.unrealised_account,
    memo: net > 0 ? 'Unrealised exchange gain' : 'Unrealised exchange loss',
    debit: net < 0 ? -net : 0, credit: net > 0 ? net : 0,
  });

  return repo.tx(() => {
    const runId = ulid();
    const runNo = nextNumber(repo, 'revaluation_run');
    const description = memo || `Foreign currency revaluation at ${as_of}`;
    const entry = gl.postJournal(repo, {
      subsidiary_id: view.subsidiary_id, txn_date: as_of, currency: view.base_currency,
      fx_rate: 1, memo: `${runNo} — ${description}`,
      source_type: 'revaluation', source_id: runId, lines: journalLines,
    });

    // The reversal goes in with the run, not left for somebody to remember. An
    // unreversed revaluation double-counts the moment the next one posts.
    const reversal = gl.reverseJournal(repo, entry.id, {
      date: reverseOn, memo: `Reversal of ${runNo} — unrealised revaluation`,
    });

    repo.insert('revaluation_run', {
      id: runId, run_no: runNo, subsidiary_id: view.subsidiary_id, base_currency: view.base_currency,
      as_of, period_id: period.id, reverse_on: reverseOn, scopes: view.scopes,
      gain: view.gain, loss: view.loss, net: view.net,
      entry_id: entry.id, reversal_entry_id: reversal.id, status: 'posted',
      memo: description, created_at: nowIso(), created_by: repo.ctx?.user?.id || null,
    });
    for (const l of view.lines) repo.insert('revaluation_line', { id: ulid(), run_id: runId, ...l });

    audit.record(repo, {
      recordType: 'revaluation_run', recordId: runId, action: 'post',
      changes: {
        run_no: { from: null, to: runNo },
        as_of: { from: null, to: as_of },
        net: { from: null, to: Money.toNumber(view.net) },
        entry: { from: null, to: entry.entry_no },
      },
    });
    return { ...view, dry_run: false, posted: true, run: getRun(repo, runId) };
  });
}

/**
 * Undo a run -- a rate was wrong, a document was missed.
 *
 * Both halves of the pair are already on the books and a posted entry is
 * never deleted here, so undoing means posting the mirror of each: four
 * entries that net to nothing, and a trail that says why. Both dates have to
 * be in open periods, or the cancellation would restate a closed month.
 */
export function reverseRun(repo, id, { reason = '' } = {}) {
  const r = repo.get('revaluation_run', id);
  if (!r) throw notFound('Revaluation run not found');
  if (r.status !== 'posted') throw unprocessable(`${r.run_no} has already been undone.`);

  const entries = [r.entry_id, r.reversal_entry_id].map((eid) => eid && gl.getJournalEntry(repo, eid)).filter(Boolean);
  for (const e of entries) {
    const period = gl.periodForDate(repo, e.txn_date);
    if (!period || period.status !== 'open') {
      throw unprocessable(`${r.run_no} cannot be undone: ${e.entry_no} is dated ${e.txn_date}, and ${period ? `${period.name} is ${period.status}` : 'no accounting period covers it'}.`);
    }
  }

  return repo.tx(() => {
    const why = reason ? ` — ${reason}` : '';
    const cancellations = entries.map((e) => gl.postJournal(repo, {
      subsidiary_id: e.subsidiary_id, txn_date: e.txn_date, currency: e.currency, fx_rate: e.fx_rate,
      memo: `Cancellation of ${e.entry_no} (${r.run_no})${why}`,
      source_type: 'revaluation', source_id: id,
      lines: e.lines.map((l) => ({
        account_id: l.account_id, memo: l.memo,
        debit: l.credit, credit: l.debit,
        base_debit: l.base_credit, base_credit: l.base_debit,
      })),
    }));

    repo.update('revaluation_run', id, { status: 'reversed' });
    audit.record(repo, {
      recordType: 'revaluation_run', recordId: id, action: 'reverse',
      changes: {
        status: { from: 'posted', to: 'reversed' },
        cancelled_by: { from: null, to: cancellations.map((c) => c.entry_no).join(', ') },
        reason: { from: null, to: reason || 'Undone by user' },
      },
    });
    return getRun(repo, id);
  });
}

// ------------------------------------------------------------------ read
export function getRun(repo, id) {
  const r = repo.get('revaluation_run', id);
  if (!r) throw notFound('Revaluation run not found');
  return {
    ...r,
    entry: r.entry_id ? repo.get('journal_entry', r.entry_id) : null,
    reversal: r.reversal_entry_id ? repo.get('journal_entry', r.reversal_entry_id) : null,
    lines: linesFor(repo, id),
  };
}

export const linesFor = (repo, id) => repo.query(
  `SELECT rl.*, a.number AS account_number, a.name AS account_name
   FROM revaluation_line rl
   LEFT JOIN account a ON a.tenant_id = rl.tenant_id AND a.id = rl.account_id
   WHERE rl.tenant_id = :t AND rl.run_id = ? ORDER BY rl.scope, rl.currency, rl.label`, [id]);

export function history(repo, { subsidiary_id = null, limit = 24 } = {}) {
  const where = ['tenant_id = :t'];
  const params = [];
  if (subsidiary_id) { where.push('subsidiary_id = ?'); params.push(subsidiary_id); }
  params.push(Number(limit) || 24);
  return repo.query(
    `SELECT * FROM revaluation_run WHERE ${where.join(' AND ')} ORDER BY as_of DESC, created_at DESC LIMIT ?`, params);
}
