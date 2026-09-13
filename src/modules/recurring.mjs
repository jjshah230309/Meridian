// Meridian ERP :: modules/recurring
// Recurring journals, and the accruals that unwind themselves.
//
// Two jobs that look different and are not. A standing entry — rent, a
// management charge, an amortisation outside the fixed-asset register — is a
// template and a calendar. A month-end accrual is the same template with one
// extra instruction: post it on the last day of the period, and unwind it on
// the first day of the next, so the invoice that eventually arrives is not
// counted twice.
//
// Occurrences are generated one at a time and the template only advances when
// its entry is actually on the books. A run that stops halfway — a closed
// period, an account somebody made inactive — leaves the template pointing at
// the occurrence it did not manage, so the next run picks up exactly there.
import { ulid, Money, nowIso, today, isValidDate, addDays, addMonths, endOfMonth, startOfMonth, sum } from '../core/util.mjs';
import { ValidationError, notFound, unprocessable, conflict } from '../core/http.mjs';
import * as gl from './gl.mjs';
import * as audit from '../core/audit.mjs';

export const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'annually'];
export const DAY_RULES = ['month_end', 'day_of_month'];
export const STATUSES = ['active', 'paused', 'ended'];

const STEP_MONTHS = { monthly: 1, quarterly: 3, annually: 12 };

export const getRecurring = (repo, id) => {
  const r = repo.get('recurring_journal', id);
  if (!r) throw notFound('Recurring journal not found');
  return { ...r, lines: linesFor(repo, id) };
};

export const linesFor = (repo, id) => repo.query(
  `SELECT rl.*, a.number AS account_number, a.name AS account_name
   FROM recurring_journal_line rl
   LEFT JOIN account a ON a.tenant_id = rl.tenant_id AND a.id = rl.account_id
   WHERE rl.tenant_id = :t AND rl.recurring_id = ? ORDER BY rl.line_no`, [id]);

/** The occurrence on or after `from`, following the template's calendar. */
export function occurrenceOn(template, from) {
  if (template.frequency === 'weekly') return from;
  if (template.day_rule === 'month_end') return endOfMonth(from);
  const day = Math.max(1, Math.min(28, Number(template.day_of_month) || 1));
  const candidate = `${from.slice(0, 8)}${String(day).padStart(2, '0')}`;
  return candidate >= from ? candidate : occurrenceOn(template, startOfMonth(addMonths(from, 1)));
}

/** The occurrence after the one on `date`. */
export function nextAfter(template, date) {
  if (template.frequency === 'weekly') return addDays(date, 7);
  const step = STEP_MONTHS[template.frequency] || 1;
  return template.day_rule === 'month_end'
    ? endOfMonth(addMonths(startOfMonth(date), step))
    : occurrenceOn(template, startOfMonth(addMonths(date, step)));
}

// ----------------------------------------------------------------- write
function validate(repo, input, { partial = false } = {}) {
  const errors = {};
  if (!partial || input.name !== undefined) { if (!input.name) errors.name = 'Name is required'; }
  if (!partial || input.subsidiary_id !== undefined) { if (!input.subsidiary_id) errors.subsidiary_id = 'Subsidiary is required'; }
  if (input.frequency && !FREQUENCIES.includes(input.frequency)) errors.frequency = `Frequency must be one of ${FREQUENCIES.join(', ')}`;
  if (input.day_rule && !DAY_RULES.includes(input.day_rule)) errors.day_rule = `Day rule must be one of ${DAY_RULES.join(', ')}`;
  if (input.status && !STATUSES.includes(input.status)) errors.status = `Status must be one of ${STATUSES.join(', ')}`;
  if ((!partial || input.start_date !== undefined) && !isValidDate(input.start_date)) errors.start_date = 'A valid start date is required';
  if (input.end_date && !isValidDate(input.end_date)) errors.end_date = 'Enter a valid end date';
  if (input.end_date && input.start_date && input.end_date < input.start_date) errors.end_date = 'The end date is before the start date';
  return errors;
}

/**
 * Lines are validated the way a real journal is: at least two, balanced, and
 * every account postable. Catching it here means a template can never sit in
 * the calendar waiting to fail every month at period end.
 */
function prepareLines(repo, lines) {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new ValidationError({ lines: 'A recurring journal needs at least two lines' });
  }
  const errors = {};
  const out = [];
  lines.forEach((l, i) => {
    const debit = Math.max(0, Money.parse(l.debit || 0));
    const credit = Math.max(0, Money.parse(l.credit || 0));
    if (!l.account_id) { errors[`lines.${i}.account_id`] = 'Account is required'; return; }
    const account = repo.get('account', l.account_id);
    if (!account) { errors[`lines.${i}.account_id`] = 'That account does not exist'; return; }
    if (account.is_summary) { errors[`lines.${i}.account_id`] = `${account.number} is a summary account and cannot be posted to`; return; }
    if (!account.active) { errors[`lines.${i}.account_id`] = `${account.number} is inactive`; return; }
    if (debit && credit) { errors[`lines.${i}`] = 'A line carries a debit or a credit, not both'; return; }
    if (!debit && !credit) { errors[`lines.${i}`] = 'A line must carry a debit or a credit'; return; }
    out.push({
      line_no: i + 1, account_id: l.account_id, debit, credit,
      memo: l.memo || '', department_id: l.department_id || null, class_id: l.class_id || null,
      entity_type: l.entity_type || null, entity_id: l.entity_id || null,
    });
  });
  if (Object.keys(errors).length) throw new ValidationError(errors, 'Some journal lines are invalid');
  const d = sum(out, (l) => l.debit), c = sum(out, (l) => l.credit);
  if (d !== c) {
    throw new ValidationError({ lines: `Debits of ${Money.format(d)} do not equal credits of ${Money.format(c)}` });
  }
  return out;
}

export function createRecurring(repo, input) {
  const errors = validate(repo, input);
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const lines = prepareLines(repo, input.lines);

  const now = nowIso();
  const id = ulid();
  const draft = {
    frequency: input.frequency || 'monthly',
    day_rule: input.day_rule || 'month_end',
    day_of_month: Number(input.day_of_month) || 1,
  };
  return repo.tx(() => {
    repo.insert('recurring_journal', {
      id, name: String(input.name).trim(), subsidiary_id: input.subsidiary_id,
      currency: input.currency || gl.subsidiaryCurrency(repo, input.subsidiary_id) || 'USD',
      memo: input.memo || '',
      ...draft,
      start_date: input.start_date,
      end_date: input.end_date || null,
      next_date: occurrenceOn(draft, input.start_date),
      auto_reverse: input.auto_reverse ? 1 : 0,
      occurrences: 0, max_occurrences: Number(input.max_occurrences) || 0,
      last_run_date: null, status: input.status || 'active',
      created_at: now, updated_at: now,
    });
    for (const l of lines) repo.insert('recurring_journal_line', { id: ulid(), recurring_id: id, ...l });
    audit.record(repo, { recordType: 'recurring_journal', recordId: id, action: 'create', after: input });
    return getRecurring(repo, id);
  });
}

export function updateRecurring(repo, id, patch) {
  const before = getRecurring(repo, id);
  const merged = { ...before, ...patch };
  const errors = validate(repo, merged, { partial: true });
  if (Object.keys(errors).length) throw new ValidationError(errors);

  const changes = {
    name: merged.name, subsidiary_id: merged.subsidiary_id, currency: merged.currency,
    memo: merged.memo || '', frequency: merged.frequency, day_rule: merged.day_rule,
    day_of_month: Number(merged.day_of_month) || 1,
    start_date: merged.start_date, end_date: merged.end_date || null,
    auto_reverse: merged.auto_reverse ? 1 : 0,
    max_occurrences: Number(merged.max_occurrences) || 0,
    status: merged.status, updated_at: nowIso(),
  };
  // Moving the calendar moves the next occurrence, but only forward from what
  // has already run: rewinding it would post a month twice.
  if (patch.frequency !== undefined || patch.day_rule !== undefined || patch.day_of_month !== undefined || patch.start_date !== undefined) {
    const from = before.last_run_date ? nextAfter(changes, before.last_run_date) : changes.start_date;
    changes.next_date = occurrenceOn(changes, from);
  }
  return repo.tx(() => {
    repo.update('recurring_journal', id, changes);

    if (patch.lines !== undefined) {
      const lines = prepareLines(repo, patch.lines);
      repo.exec('DELETE FROM recurring_journal_line WHERE tenant_id = :t AND recurring_id = ?', [id]);
      for (const l of lines) repo.insert('recurring_journal_line', { id: ulid(), recurring_id: id, ...l });
    }
    audit.record(repo, { recordType: 'recurring_journal', recordId: id, action: 'update', before, after: merged });
    return getRecurring(repo, id);
  });
}

export function setStatus(repo, id, status) {
  if (!STATUSES.includes(status)) throw new ValidationError({ status: `Status must be one of ${STATUSES.join(', ')}` });
  const before = getRecurring(repo, id);
  repo.update('recurring_journal', id, { status, updated_at: nowIso() });
  audit.record(repo, { recordType: 'recurring_journal', recordId: id, action: status, before, after: { ...before, status } });
  return getRecurring(repo, id);
}

/**
 * Destroy a template that never ran. One that did is kept: its entries name
 * it as their source, and a ledger that points at nothing is worse than a
 * template nobody uses. Ending it is the answer there.
 */
export function deleteRecurring(repo, id) {
  const before = getRecurring(repo, id);
  const posted = repo.scalar(
    'SELECT COUNT(*) c FROM journal_entry WHERE tenant_id = :t AND recurring_id = ?', [id], 0);
  if (posted > 0 || before.occurrences > 0) {
    throw conflict(`${before.name} has posted ${posted || before.occurrences} journal ${posted === 1 ? 'entry' : 'entries'}. End it instead, so its history keeps its source.`);
  }
  return repo.tx(() => {
    repo.exec('DELETE FROM recurring_journal_line WHERE tenant_id = :t AND recurring_id = ?', [id]);
    repo.remove('recurring_journal', id);
    audit.record(repo, { recordType: 'recurring_journal', recordId: id, action: 'delete', before });
    return { ok: true, deleted: id };
  });
}

// ------------------------------------------------------------------ read
/** Templates with an occurrence on or before `through`, oldest first. */
export function due(repo, { through = today() } = {}) {
  if (!isValidDate(through)) throw new ValidationError({ through: 'Enter a valid date' });
  return repo.query(
    `SELECT r.*,
            (SELECT COALESCE(SUM(debit), 0) FROM recurring_journal_line l
              WHERE l.tenant_id = r.tenant_id AND l.recurring_id = r.id) AS amount
     FROM recurring_journal r
     WHERE r.tenant_id = :t AND r.status = 'active' AND r.next_date <= ?
       AND (r.end_date IS NULL OR r.next_date <= r.end_date)
       AND (r.max_occurrences = 0 OR r.occurrences < r.max_occurrences)
     ORDER BY r.next_date, r.name`, [through]);
}

export function list(repo, { status = null } = {}) {
  const where = ['r.tenant_id = :t'];
  const params = [];
  if (status && status !== 'all') { where.push('r.status = ?'); params.push(status); }
  const rows = repo.query(
    `SELECT r.*,
            (SELECT COALESCE(SUM(debit), 0) FROM recurring_journal_line l
              WHERE l.tenant_id = r.tenant_id AND l.recurring_id = r.id) AS amount,
            (SELECT COUNT(*) FROM recurring_journal_line l
              WHERE l.tenant_id = r.tenant_id AND l.recurring_id = r.id) AS line_count
     FROM recurring_journal r WHERE ${where.join(' AND ')} ORDER BY r.next_date, r.name`, params);
  return { rows, total: rows.length };
}

export const historyFor = (repo, id, limit = 50) => repo.query(
  `SELECT id, entry_no, txn_date, memo, status, is_reversal, total_debit
   FROM journal_entry WHERE tenant_id = :t AND recurring_id = ?
   ORDER BY txn_date DESC, entry_no DESC LIMIT ?`, [id, Number(limit) || 50]);

// ------------------------------------------------------------------- run
/**
 * Post every occurrence due on or before `through`.
 *
 * A template can be behind by several periods — nobody ran it in December —
 * so each one catches up occurrence by occurrence rather than posting one
 * lump on today's date. Each occurrence lands on its own date, in its own
 * period, which is the only version a comparative report can use.
 */
export function generate(repo, { through = today(), id = null, dry_run = false } = {}) {
  if (!isValidDate(through)) throw new ValidationError({ through: 'Enter a valid date' });
  const templates = id ? [repo.get('recurring_journal', id)].filter(Boolean) : due(repo, { through });
  if (id && !templates.length) throw notFound('Recurring journal not found');

  return repo.tx(() => {
    const posted = [];
    const skipped = [];
    let count = 0;

    for (const t of templates) {
      if (t.status !== 'active') { skipped.push({ name: t.name, date: t.next_date, reason: `it is ${t.status}` }); continue; }
      const lines = linesFor(repo, t.id);
      if (lines.length < 2) { skipped.push({ name: t.name, date: t.next_date, reason: 'it has no balanced lines' }); continue; }

      let cursor = t.next_date;
      let occurrences = t.occurrences;
      let lastRun = t.last_run_date;

      // Guarded rather than open-ended: a template misconfigured to a daily
      // cadence should not be able to write ten thousand entries in one run.
      for (let guard = 0; guard < 240 && cursor <= through; guard++) {
        if (t.end_date && cursor > t.end_date) break;
        if (t.max_occurrences && occurrences >= t.max_occurrences) break;

        const period = gl.periodForDate(repo, cursor);
        if (!period || period.status !== 'open') {
          skipped.push({
            name: t.name, date: cursor,
            reason: period ? `${period.name} is ${period.status}` : `no accounting period covers ${cursor}`,
          });
          break;                    // stop this template here; the rest waits
        }

        if (dry_run) {
          posted.push({ name: t.name, date: cursor, amount: Money.toNumber(sum(lines, (l) => l.debit)), auto_reverse: !!t.auto_reverse });
        } else {
          const entry = gl.postJournal(repo, {
            subsidiary_id: t.subsidiary_id, txn_date: cursor, currency: t.currency,
            memo: t.memo ? `${t.name} — ${t.memo}` : t.name,
            source_type: t.auto_reverse ? 'accrual' : 'recurring', source_id: t.id,
            lines: lines.map((l) => ({
              account_id: l.account_id, debit: l.debit, credit: l.credit, memo: l.memo,
              department_id: l.department_id, class_id: l.class_id,
              entity_type: l.entity_type, entity_id: l.entity_id,
            })),
          });
          repo.update('journal_entry', entry.id, { recurring_id: t.id });

          // An accrual unwinds on the first day of the next period, which is
          // the whole point of marking it as one.
          let reversal = null;
          const reverseOn = addDays(cursor, 1);
          if (t.auto_reverse) {
            const rp = gl.periodForDate(repo, reverseOn);
            if (rp && rp.status === 'open') {
              reversal = gl.reverseJournal(repo, entry.id, { date: reverseOn, memo: `Reversal of accrual ${t.name}` });
              repo.update('journal_entry', reversal.id, { recurring_id: t.id });
            } else {
              skipped.push({
                name: t.name, date: reverseOn,
                reason: `the accrual posted, but its reversal cannot: ${rp ? `${rp.name} is ${rp.status}` : `no period covers ${reverseOn}`}`,
              });
            }
          }
          posted.push({
            name: t.name, date: cursor, entry_no: entry.entry_no, entry_id: entry.id,
            amount: Money.toNumber(sum(lines, (l) => l.debit)),
            reversal_no: reversal?.entry_no || null,
          });
        }

        count++;
        occurrences++;
        lastRun = cursor;
        cursor = nextAfter(t, cursor);
      }

      if (!dry_run && lastRun !== t.last_run_date) {
        const ended = (t.end_date && cursor > t.end_date) || (t.max_occurrences && occurrences >= t.max_occurrences);
        repo.update('recurring_journal', t.id, {
          next_date: cursor, occurrences, last_run_date: lastRun,
          status: ended ? 'ended' : t.status, updated_at: nowIso(),
        });
      }
    }

    if (!dry_run && posted.length) {
      audit.record(repo, {
        recordType: 'recurring_journal', recordId: id, action: 'generate',
        changes: { through: { from: null, to: through }, entries: { from: 0, to: posted.length } },
      });
    }
    return {
      through, dry_run: !!dry_run, generated: count,
      amount: posted.reduce((a, p) => a + p.amount, 0),
      posted, skipped,
    };
  });
}
