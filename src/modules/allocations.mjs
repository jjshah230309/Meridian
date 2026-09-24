// Meridian ERP :: modules/allocations
// Spreading shared cost across the parts of the business that caused it.
//
// Rent, IT, insurance and the finance department itself arrive as one invoice
// and belong to five departments. Doing that split by hand every month is the
// job nobody wants; doing it with a percentage somebody typed from memory is
// the one nobody can audit.
//
// A schedule says: take what landed on these accounts, move it to these ones,
// in these proportions. The proportions are either fixed, or read from
// statistical accounts -- headcount, floor area, machine hours -- so the
// split follows the business rather than a number that was right in 2019.
import { ulid, Money, nowIso, today, isValidDate, addMonths, startOfMonth, endOfMonth, sum, round } from '../core/util.mjs';
import { ValidationError, notFound, unprocessable, conflict } from '../core/http.mjs';
import { nextNumber } from '../core/seq.mjs';
import * as gl from './gl.mjs';
import * as audit from '../core/audit.mjs';

export const METHODS = ['fixed', 'statistical'];
export const FREQUENCIES = ['monthly', 'quarterly', 'annually'];
export const BASES = ['period', 'cumulative'];
const STEP = { monthly: 1, quarterly: 3, annually: 12 };

export function getSchedule(repo, id) {
  const s = repo.get('allocation_schedule', id);
  if (!s) throw notFound('Allocation schedule not found');
  return { ...s, sources: sourcesFor(repo, id), targets: targetsFor(repo, id) };
}

export const sourcesFor = (repo, id) => repo.query(
  `SELECT s.*, a.number AS account_number, a.name AS account_name
   FROM allocation_source s
   LEFT JOIN account a ON a.tenant_id = s.tenant_id AND a.id = s.account_id
   WHERE s.tenant_id = :t AND s.schedule_id = ? ORDER BY a.number`, [id]);

export const targetsFor = (repo, id) => repo.query(
  `SELECT t.*, a.number AS account_number, a.name AS account_name,
          d.name AS department_name, st.number AS stat_number, st.name AS stat_name,
          st.statistical_unit AS stat_unit
   FROM allocation_target t
   LEFT JOIN account a ON a.tenant_id = t.tenant_id AND a.id = t.account_id
   LEFT JOIN department d ON d.tenant_id = t.tenant_id AND d.id = t.department_id
   LEFT JOIN account st ON st.tenant_id = t.tenant_id AND st.id = t.statistical_account_id
   WHERE t.tenant_id = :t AND t.schedule_id = ? ORDER BY t.line_no`, [id]);

export const list = (repo, { status = null } = {}) => {
  const rows = repo.query(
    `SELECT s.*,
            (SELECT COUNT(*) FROM allocation_source x WHERE x.tenant_id = s.tenant_id AND x.schedule_id = s.id) AS source_count,
            (SELECT COUNT(*) FROM allocation_target x WHERE x.tenant_id = s.tenant_id AND x.schedule_id = s.id) AS target_count
     FROM allocation_schedule s
     WHERE s.tenant_id = :t${status && status !== 'all' ? ' AND s.status = ?' : ''}
     ORDER BY s.next_date, s.name`, status && status !== 'all' ? [status] : []);
  return { rows, total: rows.length };
};

// ----------------------------------------------------------------- write
function validate(repo, input, { partial = false } = {}) {
  const errors = {};
  if ((!partial || input.name !== undefined) && !input.name) errors.name = 'Name is required';
  if ((!partial || input.subsidiary_id !== undefined) && !input.subsidiary_id) errors.subsidiary_id = 'Subsidiary is required';
  if (input.method && !METHODS.includes(input.method)) errors.method = `Method must be ${METHODS.join(' or ')}`;
  if (input.frequency && !FREQUENCIES.includes(input.frequency)) errors.frequency = `Frequency must be one of ${FREQUENCIES.join(', ')}`;
  if (input.basis && !BASES.includes(input.basis)) errors.basis = `Basis must be ${BASES.join(' or ')}`;
  if ((!partial || input.start_date !== undefined) && !isValidDate(input.start_date || input.next_date)) {
    errors.start_date = 'A valid start date is required';
  }
  return errors;
}

function prepareSources(repo, sources) {
  if (!Array.isArray(sources) || !sources.length) {
    throw new ValidationError({ sources: 'Name at least one account to allocate from' });
  }
  const errors = {};
  const out = sources.map((s, i) => {
    if (!s.account_id) { errors[`sources.${i}.account_id`] = 'Account is required'; return null; }
    const account = repo.get('account', s.account_id);
    if (!account) { errors[`sources.${i}.account_id`] = 'That account does not exist'; return null; }
    if (account.is_statistical) { errors[`sources.${i}.account_id`] = `${account.number} is a statistical account; there is no money on it to allocate`; return null; }
    const percent = s.percent === undefined ? 100 : Number(s.percent);
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
      errors[`sources.${i}.percent`] = 'Allocate between 0 and 100 percent'; return null;
    }
    return {
      account_id: s.account_id, percent,
      department_id: s.department_id || null, class_id: s.class_id || null, location_id: s.location_id || null,
    };
  });
  if (Object.keys(errors).length) throw new ValidationError(errors, 'Some source accounts are invalid');
  return out;
}

function prepareTargets(repo, targets, method) {
  if (!Array.isArray(targets) || targets.length < 2) {
    throw new ValidationError({ targets: 'An allocation needs at least two destinations — one is not a split' });
  }
  const errors = {};
  const out = targets.map((t, i) => {
    if (t.account_id) {
      const account = repo.get('account', t.account_id);
      if (!account) { errors[`targets.${i}.account_id`] = 'That account does not exist'; return null; }
      if (account.is_summary) { errors[`targets.${i}.account_id`] = `${account.number} is a summary account and cannot be posted to`; return null; }
    }
    if (method === 'statistical') {
      if (!t.statistical_account_id) { errors[`targets.${i}.statistical_account_id`] = 'Choose the statistical account that measures this destination'; return null; }
      const stat = repo.get('account', t.statistical_account_id);
      if (!stat) { errors[`targets.${i}.statistical_account_id`] = 'That account does not exist'; return null; }
      if (!stat.is_statistical) { errors[`targets.${i}.statistical_account_id`] = `${stat.number} is not a statistical account`; return null; }
    } else {
      const weight = t.weight === undefined ? 1 : Number(t.weight);
      if (!Number.isFinite(weight) || weight < 0) { errors[`targets.${i}.weight`] = 'A weight cannot be negative'; return null; }
    }
    // A destination that is the same account, department and class as the
    // source is the whole allocation doing nothing.
    if (!t.account_id && !t.department_id && !t.class_id && !t.location_id) {
      errors[`targets.${i}`] = 'Give the destination an account, a department, a class or a location — otherwise nothing moves';
      return null;
    }
    return {
      line_no: i + 1,
      account_id: t.account_id || null,
      department_id: t.department_id || null, class_id: t.class_id || null, location_id: t.location_id || null,
      weight: t.weight === undefined ? 1 : Number(t.weight),
      statistical_account_id: t.statistical_account_id || null,
      memo: t.memo || '',
    };
  });
  if (Object.keys(errors).length) throw new ValidationError(errors, 'Some destinations are invalid');
  if (method === 'fixed' && !sum(out, (t) => t.weight)) {
    throw new ValidationError({ targets: 'Every weight is zero, so there is nothing to divide' });
  }
  return out;
}

export function createSchedule(repo, input) {
  const errors = validate(repo, input);
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const method = input.method || 'fixed';
  const sources = prepareSources(repo, input.sources);
  const targets = prepareTargets(repo, input.targets, method);

  const now = nowIso();
  const id = ulid();
  const start = input.start_date || input.next_date;
  repo.insert('allocation_schedule', {
    id, name: String(input.name).trim(), description: input.description || '',
    subsidiary_id: input.subsidiary_id, method,
    frequency: input.frequency || 'monthly', basis: input.basis || 'period',
    clearing_account_id: input.clearing_account_id || null,
    next_date: endOfMonth(start), last_run_date: null, occurrences: 0,
    status: input.status || 'active', created_at: now, updated_at: now,
  });
  for (const s of sources) repo.insert('allocation_source', { id: ulid(), schedule_id: id, ...s });
  for (const t of targets) repo.insert('allocation_target', { id: ulid(), schedule_id: id, ...t });
  audit.record(repo, { recordType: 'allocation_schedule', recordId: id, action: 'create', after: input });
  return getSchedule(repo, id);
}

export function updateSchedule(repo, id, patch) {
  const before = getSchedule(repo, id);
  const merged = { ...before, ...patch };
  const errors = validate(repo, merged, { partial: true });
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const method = merged.method || 'fixed';

  const changes = {
    name: merged.name, description: merged.description || '', subsidiary_id: merged.subsidiary_id,
    method, frequency: merged.frequency, basis: merged.basis,
    clearing_account_id: merged.clearing_account_id || null,
    status: merged.status, updated_at: nowIso(),
  };
  if (patch.next_date || patch.start_date) changes.next_date = endOfMonth(patch.next_date || patch.start_date);
  repo.update('allocation_schedule', id, changes);

  if (patch.sources !== undefined) {
    const sources = prepareSources(repo, patch.sources);
    repo.exec('DELETE FROM allocation_source WHERE tenant_id = :t AND schedule_id = ?', [id]);
    for (const s of sources) repo.insert('allocation_source', { id: ulid(), schedule_id: id, ...s });
  }
  if (patch.targets !== undefined) {
    const targets = prepareTargets(repo, patch.targets, method);
    repo.exec('DELETE FROM allocation_target WHERE tenant_id = :t AND schedule_id = ?', [id]);
    for (const t of targets) repo.insert('allocation_target', { id: ulid(), schedule_id: id, ...t });
  }
  audit.record(repo, { recordType: 'allocation_schedule', recordId: id, action: 'update', before, after: merged });
  return getSchedule(repo, id);
}

export function setStatus(repo, id, status) {
  if (!['active', 'paused', 'ended'].includes(status)) throw new ValidationError({ status: 'Status must be active, paused or ended' });
  const before = getSchedule(repo, id);
  repo.update('allocation_schedule', id, { status, updated_at: nowIso() });
  audit.record(repo, { recordType: 'allocation_schedule', recordId: id, action: status, before, after: { ...before, status } });
  return getSchedule(repo, id);
}

export function deleteSchedule(repo, id) {
  const before = getSchedule(repo, id);
  const runs = repo.scalar('SELECT COUNT(*) c FROM allocation_run WHERE tenant_id = :t AND schedule_id = ?', [id], 0);
  if (runs > 0) throw conflict(`${before.name} has allocated ${runs} period${runs === 1 ? '' : 's'}. End it instead, so the entries it produced keep their source.`);
  repo.exec('DELETE FROM allocation_source WHERE tenant_id = :t AND schedule_id = ?', [id]);
  repo.exec('DELETE FROM allocation_target WHERE tenant_id = :t AND schedule_id = ?', [id]);
  repo.remove('allocation_schedule', id);
  audit.record(repo, { recordType: 'allocation_schedule', recordId: id, action: 'delete', before });
  return { ok: true, deleted: id };
}

// ------------------------------------------------------------------- run
/**
 * Where a cumulative schedule starts counting: the day after it last ran.
 *
 * Cumulative means "everything not yet allocated", and the honest way to know
 * what that is, is to remember when the last one finished. Tagging the source
 * entries instead would mark ordinary cost as belonging to an allocation,
 * which it does not.
 */
const windowStart = (schedule) => (schedule.last_run_date ? nextDay(schedule.last_run_date) : null);
const nextDay = (d) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
};

/** What sits on the source accounts for the period being allocated. */
function sourceBalance(repo, schedule, { from, to }) {
  const sources = sourcesFor(repo, schedule.id);
  const out = [];
  for (const s of sources) {
    const where = ['jl.account_id = ?', 'je.status = \'posted\'', 'je.subsidiary_id = ?', 'je.txn_date <= ?'];
    const params = [s.account_id, schedule.subsidiary_id, to];
    const since = sinceFor(schedule, from);
    if (since) { where.push('je.txn_date >= ?'); params.push(since); }
    if (s.department_id) { where.push('jl.department_id = ?'); params.push(s.department_id); }
    if (s.class_id) { where.push('jl.class_id = ?'); params.push(s.class_id); }
    if (s.location_id) { where.push('jl.location_id = ?'); params.push(s.location_id); }
    // Anything an earlier run already moved is excluded, or a cumulative
    // basis would allocate the same cost again every month.
    where.push('je.allocation_run_id IS NULL');
    const balance = repo.scalar(
      `SELECT COALESCE(SUM(jl.base_debit - jl.base_credit), 0) v
       FROM journal_line jl JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
       WHERE jl.tenant_id = :t AND ${where.join(' AND ')}`, params, 0);
    const share = Math.round((balance * s.percent) / 100);
    if (share) out.push({ ...s, balance, amount: share });
  }
  return out;
}

/** The window a schedule measures over: the period itself, or everything
 * since it last ran. Shared by sourceBalance and weightsFor so the pool
 * being divided and the weights it is divided by are always read over the
 * same window. */
const sinceFor = (schedule, from) => (schedule.basis === 'period' ? from : windowStart(schedule));

/** The weights to divide by, and where they came from. */
function weightsFor(repo, schedule, targets, { from, to }) {
  if (schedule.method === 'fixed') {
    return targets.map((t) => ({ target: t, weight: t.weight, label: `weight ${t.weight}` }));
  }
  const since = sinceFor(schedule, from);
  return targets.map((t) => {
    // A statistical balance is a count, posted as a debit. Its sign is
    // meaningless as an amount and its magnitude is the whole point.
    //
    // Bounded to this schedule's own window, the same as sourceBalance --
    // postStatistic posts a reading ("this month's headcount"), not a delta,
    // so summing every reading ever posted (with no lower bound) would keep
    // adding this month's count onto every month that came before it.
    const where = ['jl.account_id = ?', "je.status = 'posted'", 'je.subsidiary_id = ?', 'je.txn_date <= ?'];
    const params = [t.statistical_account_id, schedule.subsidiary_id, to];
    if (since) { where.push('je.txn_date >= ?'); params.push(since); }
    if (t.department_id) { where.push('jl.department_id = ?'); params.push(t.department_id); }
    const measured = repo.scalar(
      `SELECT COALESCE(SUM(jl.base_debit - jl.base_credit), 0) v
       FROM journal_line jl JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
       WHERE jl.tenant_id = :t AND ${where.join(' AND ')}`, params, 0);
    return {
      target: t,
      weight: Math.abs(Money.toNumber(measured)),
      label: `${Money.toNumber(Math.abs(measured))} ${t.stat_unit || t.stat_name || 'units'}`,
    };
  });
}

/**
 * Work out the split without writing anything.
 *
 * The screen shows this before anybody posts, and the run itself calls the
 * same function, so what is previewed is what is posted.
 */
export function preview(repo, id, { txn_date = null } = {}) {
  const schedule = getSchedule(repo, id);
  const date = txn_date || schedule.next_date;
  if (!isValidDate(date)) throw new ValidationError({ txn_date: 'Enter a valid date' });
  const from = startOfMonth(schedule.frequency === 'monthly' ? date
    : addMonths(date, -(STEP[schedule.frequency] - 1)));
  const to = date;

  const sources = sourceBalance(repo, schedule, { from, to });
  const pool = sum(sources, (s) => s.amount);
  const targets = targetsFor(repo, id);
  const weights = weightsFor(repo, schedule, targets, { from, to });
  const totalWeight = sum(weights, (w) => w.weight);

  // Allocate to the penny: the last destination absorbs the remainder rather
  // than every line being rounded independently and the entry not balancing.
  const shares = totalWeight > 0
    ? Money.allocate(pool, weights.map((w) => w.weight))
    : weights.map(() => 0);

  return {
    schedule, txn_date: date, from, to,
    sources, pool, total_weight: totalWeight,
    lines: weights.map((w, i) => ({
      target: w.target, weight: w.weight, basis_label: w.label,
      share: totalWeight > 0 ? round((w.weight / totalWeight) * 1000) / 10 : 0,
      amount: shares[i],
    })),
    ready: pool !== 0 && totalWeight > 0,
    reason: pool === 0 ? 'Nothing has landed on the source accounts for this period'
      : totalWeight === 0 ? 'Every destination measures zero, so there is nothing to divide by'
        : null,
  };
}

export function nextAfter(schedule, date) {
  return endOfMonth(addMonths(startOfMonth(date), STEP[schedule.frequency] || 1));
}

/** Post the split. One journal, one run record, one advance of the calendar. */
export function run(repo, id, { txn_date = null, dry_run = false, memo = '' } = {}) {
  const view = preview(repo, id, { txn_date });
  if (dry_run) return { ...view, dry_run: true, posted: false };
  if (!view.ready) throw unprocessable(`${view.schedule.name} cannot be allocated for ${view.txn_date}: ${view.reason}.`);
  if (view.schedule.status !== 'active') throw unprocessable(`${view.schedule.name} is ${view.schedule.status}.`);

  const period = gl.requireOpenPeriod(repo, view.txn_date);
  const already = repo.queryOne(
    'SELECT run_no FROM allocation_run WHERE tenant_id = :t AND schedule_id = ? AND txn_date = ?',
    [id, view.txn_date]);
  if (already) throw conflict(`${already.run_no} already allocated ${view.schedule.name} on ${view.txn_date}.`);

  const runId = ulid();
  const runNo = nextNumber(repo, 'allocation_run');
  const description = memo || `${view.schedule.name} — ${view.txn_date}`;

  // Relieve the source, then load the destinations. Where a clearing account
  // is named the original cost stays visible where it was booked, which is
  // what a departmental manager wants to see when they query their charge.
  const lines = [];
  for (const s of view.sources) {
    const relief = view.schedule.clearing_account_id || s.account_id;
    lines.push({
      account_id: relief,
      debit: s.amount < 0 ? -s.amount : 0, credit: s.amount > 0 ? s.amount : 0,
      department_id: s.department_id, class_id: s.class_id, location_id: s.location_id,
      memo: `Allocated out — ${s.account_number} ${s.account_name}`,
    });
  }
  for (const l of view.lines) {
    if (!l.amount) continue;
    lines.push({
      account_id: l.target.account_id || view.sources[0].account_id,
      debit: l.amount > 0 ? l.amount : 0, credit: l.amount < 0 ? -l.amount : 0,
      department_id: l.target.department_id, class_id: l.target.class_id, location_id: l.target.location_id,
      memo: l.target.memo || `${l.share}% — ${l.basis_label}`,
    });
  }

  const entry = gl.postJournal(repo, {
    subsidiary_id: view.schedule.subsidiary_id, txn_date: view.txn_date,
    memo: `${runNo} — ${description}`, source_type: 'allocation', source_id: runId, lines,
  });
  repo.update('journal_entry', entry.id, { allocation_run_id: runId });

  repo.insert('allocation_run', {
    id: runId, run_no: runNo, schedule_id: id, period_id: period.id, txn_date: view.txn_date,
    amount: view.pool, entry_id: entry.id,
    weights: view.lines.map((l) => ({
      account: l.target.account_number || null, department: l.target.department_name || null,
      weight: l.weight, share: l.share, amount: l.amount, measured: l.basis_label,
    })),
    created_at: nowIso(), created_by: repo.ctx?.user?.id || null,
  });

  const advanced = nextAfter(view.schedule, view.txn_date);
  repo.update('allocation_schedule', id, {
    next_date: advanced, last_run_date: view.txn_date,
    occurrences: (view.schedule.occurrences || 0) + 1, updated_at: nowIso(),
  });

  audit.record(repo, {
    recordType: 'allocation_schedule', recordId: id, action: 'allocate',
    changes: { run_no: { from: null, to: runNo }, amount: { from: null, to: Money.toNumber(view.pool) }, entry: { from: null, to: entry.entry_no } },
  });
  return { ...view, dry_run: false, posted: true, run: getRun(repo, runId) };
}

export function getRun(repo, id) {
  const r = repo.get('allocation_run', id);
  if (!r) throw notFound('Allocation run not found');
  return { ...r, entry: r.entry_id ? repo.get('journal_entry', r.entry_id) : null, schedule: repo.get('allocation_schedule', r.schedule_id) };
}

export const runsFor = (repo, id, limit = 24) => repo.query(
  `SELECT r.*, j.entry_no FROM allocation_run r
   LEFT JOIN journal_entry j ON j.tenant_id = r.tenant_id AND j.id = r.entry_id
   WHERE r.tenant_id = :t AND r.schedule_id = ? ORDER BY r.txn_date DESC LIMIT ?`, [id, Number(limit) || 24]);

export const due = (repo, { through = today() } = {}) => repo.query(
  `SELECT * FROM allocation_schedule
   WHERE tenant_id = :t AND status = 'active' AND next_date <= ?
   ORDER BY next_date, name`, [through]);

/**
 * Post a statistical figure — this month's headcount, this month's floor area.
 *
 * Statistical accounts are still double entry: the count is debited to the
 * account and credited to itself under a different department, which keeps
 * the trial balance whole while letting each department carry its own number.
 */
export function postStatistic(repo, { account_id, subsidiary_id, txn_date = today(), entries = [], memo = '' }) {
  const account = repo.get('account', account_id);
  if (!account) throw notFound('Account not found');
  if (!account.is_statistical) throw unprocessable(`${account.number} ${account.name} is not a statistical account.`);
  if (!Array.isArray(entries) || !entries.length) throw new ValidationError({ entries: 'Give at least one department and a quantity' });

  const lines = [];
  let total = 0;
  entries.forEach((e, i) => {
    const qty = Money.parse(e.quantity ?? e.amount ?? 0);
    if (!qty) return;
    if (!e.department_id) throw new ValidationError({ [`entries.${i}.department_id`]: 'Which department is this measuring?' });
    lines.push({ account_id, debit: qty, credit: 0, department_id: e.department_id, memo: e.memo || '' });
    total += qty;
  });
  if (!lines.length) throw new ValidationError({ entries: 'Every quantity is zero' });
  // The balancing credit carries no department, so each department's own
  // balance is the figure that was entered for it.
  lines.push({ account_id, debit: 0, credit: total, memo: 'Statistical balance' });

  const entry = gl.postJournal(repo, {
    subsidiary_id, txn_date, source_type: 'statistical',
    memo: memo || `${account.number} ${account.name} — ${txn_date}`, lines,
  });
  audit.record(repo, {
    recordType: 'journal_entry', recordId: entry.id, action: 'statistic',
    changes: { account: { from: null, to: account.number }, total: { from: null, to: Money.toNumber(total) } },
  });
  return entry;
}
