// Meridian ERP :: modules/workforce
// Performance reviews, shift scheduling, time and attendance, and the
// self-service requests employees raise about their own record.
//
// Attendance is deliberately separate from time_entry. A timesheet says what
// work was done and is what payroll and project billing read; attendance says
// when someone was physically present and is what scheduling and compliance
// read. Conflating them makes both wrong the first time somebody is on site
// for eight hours and books six to a project.
import { ulid, Qty, Money, nowIso, today, isValidDate, sum, round } from '../core/util.mjs';
import { ValidationError, notFound, unprocessable } from '../core/http.mjs';
import * as audit from '../core/audit.mjs';

export const REQUEST_TYPES = ['address_change', 'bank_change', 'time_off', 'shift_swap', 'equipment', 'training', 'document'];
export const REVIEW_STATUSES = ['not_started', 'self_review', 'manager_review', 'complete', 'acknowledged'];

// ------------------------------------------------------------- reviews
export function createCycle(repo, input) {
  const errors = {};
  if (!input.name) errors.name = 'Name is required';
  if (!isValidDate(input.period_start)) errors.period_start = 'A valid start date is required';
  if (!isValidDate(input.period_end)) errors.period_end = 'A valid end date is required';
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const id = ulid();
  repo.insert('review_cycle', {
    id, name: input.name, period_start: input.period_start, period_end: input.period_end,
    due_date: input.due_date || null, status: 'draft',
    template: Array.isArray(input.template) ? input.template : [],
    rating_scale: Number(input.rating_scale || 5), created_at: nowIso(),
  });
  return repo.get('review_cycle', id);
}

/** Open a cycle, creating one review per active employee with their manager. */
export function openCycle(repo, cycleId) {
  const cycle = repo.get('review_cycle', cycleId);
  if (!cycle) throw notFound(`Review cycle ${cycleId} not found`);
  if (cycle.status !== 'draft') throw unprocessable(`That cycle is already ${cycle.status}`);

  const employees = repo.query("SELECT * FROM employee WHERE tenant_id = :t AND status = 'active'");
  let created = 0;
  for (const e of employees) {
    if (repo.queryOne('SELECT id FROM performance_review WHERE tenant_id = :t AND cycle_id = ? AND employee_id = ?', [cycleId, e.id])) continue;
    const now = nowIso();
    repo.insert('performance_review', {
      id: ulid(), cycle_id: cycleId, employee_id: e.id, reviewer_id: e.manager_id || null,
      status: 'not_started', self_rating: null, manager_rating: null, overall_rating: null,
      ratings: [], strengths: '', development: '', goals: [],
      submitted_at: null, acknowledged_at: null, created_at: now, updated_at: now,
    });
    created++;
  }
  repo.update('review_cycle', cycleId, { status: 'open' });
  audit.record(repo, { recordType: 'review_cycle', recordId: cycleId, action: 'open' });
  return { cycle: repo.get('review_cycle', cycleId), reviews_created: created, employees: employees.length };
}

/**
 * Record a review. Overall rating is the weighted mean of the competency
 * ratings when the template carries weights, so a template can say that
 * "delivery" matters more than "paperwork" and have that actually count.
 */
export function submitReview(repo, id, { by = 'manager', ratings = [], strengths = '', development = '', goals = [] } = {}) {
  const review = repo.get('performance_review', id);
  if (!review) throw notFound(`Review ${id} not found`);
  const cycle = repo.get('review_cycle', review.cycle_id);
  if (cycle?.status === 'closed') throw unprocessable('That review cycle is closed');

  const template = Array.isArray(cycle?.template) ? cycle.template : [];
  const weightFor = (name) => Number(template.find((t) => t.competency === name)?.weight || 1);
  const scored = ratings.filter((r) => Number.isFinite(Number(r.rating)));
  const totalWeight = sum(scored, (r) => weightFor(r.competency));
  const mean = totalWeight
    ? Math.round((sum(scored, (r) => Number(r.rating) * weightFor(r.competency)) / totalWeight) * 100) / 100
    : null;

  const merged = [...(Array.isArray(review.ratings) ? review.ratings : [])];
  for (const r of ratings) {
    const existing = merged.find((m) => m.competency === r.competency);
    if (existing) existing[by] = Number(r.rating), existing.comment = r.comment ?? existing.comment;
    else merged.push({ competency: r.competency, [by]: Number(r.rating), comment: r.comment || '' });
  }

  const patch = {
    ratings: merged, strengths: strengths || review.strengths,
    development: development || review.development,
    goals: goals.length ? goals : review.goals,
    updated_at: nowIso(),
  };
  if (by === 'self') { patch.self_rating = mean; patch.status = 'manager_review'; }
  else { patch.manager_rating = mean; patch.overall_rating = mean; patch.status = 'complete'; patch.submitted_at = nowIso(); }
  repo.update('performance_review', id, patch);
  return repo.get('performance_review', id);
}

export function acknowledgeReview(repo, id) {
  const review = repo.get('performance_review', id);
  if (!review) throw notFound(`Review ${id} not found`);
  if (review.status !== 'complete') throw unprocessable('A review can only be acknowledged once the manager has completed it');
  repo.update('performance_review', id, { status: 'acknowledged', acknowledged_at: nowIso(), updated_at: nowIso() });
  return repo.get('performance_review', id);
}

export function cycleProgress(repo, cycleId) {
  const rows = repo.query(
    `SELECT pr.*, (e.first_name || ' ' || e.last_name) AS employee_name, (m.first_name || ' ' || m.last_name) AS reviewer_name
     FROM performance_review pr
     JOIN employee e ON e.tenant_id = pr.tenant_id AND e.id = pr.employee_id
     LEFT JOIN employee m ON m.tenant_id = pr.tenant_id AND m.id = pr.reviewer_id
     WHERE pr.tenant_id = :t AND pr.cycle_id = ? ORDER BY e.last_name, e.first_name`, [cycleId]);
  const counts = {};
  for (const s of REVIEW_STATUSES) counts[s] = rows.filter((r) => r.status === s).length;
  const rated = rows.filter((r) => r.overall_rating !== null);
  return {
    cycle: repo.get('review_cycle', cycleId),
    reviews: rows.map((r) => ({
      id: r.id, employee: r.employee_name, reviewer: r.reviewer_name,
      status: r.status, overall_rating: r.overall_rating,
    })),
    counts,
    completion_pct: rows.length ? Math.round((counts.complete + counts.acknowledged) / rows.length * 1000) / 10 : 0,
    average_rating: rated.length ? Math.round((sum(rated, (r) => r.overall_rating) / rated.length) * 100) / 100 : null,
  };
}

// ------------------------------------------------------------ scheduling
export function createShift(repo, input) {
  const errors = {};
  if (!input.name) errors.name = 'Name is required';
  if (!/^\d{2}:\d{2}$/.test(input.starts_at || '')) errors.starts_at = 'Start time must be HH:MM';
  if (!/^\d{2}:\d{2}$/.test(input.ends_at || '')) errors.ends_at = 'End time must be HH:MM';
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const id = ulid();
  repo.insert('shift', {
    id, name: input.name, location_id: input.location_id || null,
    department_id: input.department_id || null,
    starts_at: input.starts_at, ends_at: input.ends_at,
    break_minutes: Number(input.break_minutes || 0),
    colour: input.colour || '', active: 1,
  });
  return repo.get('shift', id);
}

export function scheduleShift(repo, { employee_id, shift_id = null, work_date, starts_at = '', ends_at = '', location_id = null, notes = '' }) {
  if (!employee_id) throw new ValidationError({ employee_id: 'Employee is required' });
  if (!isValidDate(work_date)) throw new ValidationError({ work_date: 'A valid date is required' });
  const shift = shift_id ? repo.get('shift', shift_id) : null;
  const start = starts_at || shift?.starts_at || '';
  const end = ends_at || shift?.ends_at || '';

  const clash = repo.queryOne(
    `SELECT id FROM schedule_entry WHERE tenant_id = :t AND employee_id = ? AND work_date = ?
       AND status != 'swapped' AND starts_at < ? AND ends_at > ?`,
    [employee_id, work_date, end, start]);
  if (clash) throw unprocessable('That employee is already scheduled over those hours');

  const id = ulid();
  repo.insert('schedule_entry', {
    id, employee_id, shift_id, work_date, starts_at: start, ends_at: end,
    location_id: location_id || shift?.location_id || null,
    status: 'scheduled', notes, created_at: nowIso(),
  });
  return repo.get('schedule_entry', id);
}

export const rota = (repo, { from, to, location_id = null } = {}) =>
  repo.query(`SELECT se.*, (e.first_name || ' ' || e.last_name) AS employee_name, s.name AS shift_name, s.colour
              FROM schedule_entry se
              JOIN employee e ON e.tenant_id = se.tenant_id AND e.id = se.employee_id
              LEFT JOIN shift s ON s.tenant_id = se.tenant_id AND s.id = se.shift_id
              WHERE se.tenant_id = :t AND se.work_date BETWEEN ? AND ?
                ${location_id ? 'AND se.location_id = ?' : ''}
              ORDER BY se.work_date, se.starts_at, e.last_name`,
    location_id ? [from, to, location_id] : [from, to]);

// ------------------------------------------------------------ attendance
const HHMM_TO_MIN = (s) => {
  const m = /^(\d{2}):(\d{2})/.exec(s || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * Clock in or out. Worked hours and any exception are derived here rather
 * than reported by the employee, so "late" is a fact about the schedule and
 * not an opinion.
 */
export function clock(repo, { employee_id, work_date = today(), direction = 'in', at = null, source = 'manual', break_minutes = null }) {
  if (!employee_id) throw new ValidationError({ employee_id: 'Employee is required' });
  const stamp = at || nowIso().slice(11, 16);
  const existing = repo.queryOne(
    'SELECT * FROM attendance WHERE tenant_id = :t AND employee_id = ? AND work_date = ?', [employee_id, work_date]);
  const scheduled = repo.queryOne(
    "SELECT * FROM schedule_entry WHERE tenant_id = :t AND employee_id = ? AND work_date = ? AND status != 'swapped' LIMIT 1",
    [employee_id, work_date]);

  if (direction === 'in') {
    if (existing?.clock_in) throw unprocessable('That employee is already clocked in for the day');
    const late = scheduled && HHMM_TO_MIN(stamp) > HHMM_TO_MIN(scheduled.starts_at) + 5;
    const row = {
      employee_id, work_date, clock_in: stamp, clock_out: null,
      break_minutes: break_minutes ?? scheduled?.break_minutes ?? 0,
      worked_hours: 0, overtime_hours: 0,
      scheduled_id: scheduled?.id || null, status: 'open',
      exception: late ? 'late' : '', source, approved_by: null, created_at: nowIso(),
    };
    if (existing) { repo.update('attendance', existing.id, row); return repo.get('attendance', existing.id); }
    const id = ulid();
    repo.insert('attendance', { id, ...row });
    return repo.get('attendance', id);
  }

  if (!existing?.clock_in) throw unprocessable('That employee has not clocked in today');
  const inMin = HHMM_TO_MIN(existing.clock_in);
  const outMin = HHMM_TO_MIN(stamp);
  if (outMin === null || outMin <= inMin) throw unprocessable('Clock-out must be later than clock-in');
  const minutes = outMin - inMin - (break_minutes ?? existing.break_minutes ?? 0);
  const worked = Qty.parse(Math.max(0, minutes) / 60);
  const standard = Qty.parse(8);
  const early = scheduled && outMin < HHMM_TO_MIN(scheduled.ends_at) - 5;

  repo.update('attendance', existing.id, {
    clock_out: stamp,
    break_minutes: break_minutes ?? existing.break_minutes,
    worked_hours: worked,
    overtime_hours: Math.max(0, worked - standard),
    status: 'closed',
    exception: existing.exception || (early ? 'early_leave' : ''),
  });
  return repo.get('attendance', existing.id);
}

/** Attendance against the rota for a range: who was missing, who ran over. */
export function attendanceSummary(repo, { from, to, employee_id = null } = {}) {
  const rows = repo.query(
    `SELECT a.*, (e.first_name || ' ' || e.last_name) AS employee_name FROM attendance a
     JOIN employee e ON e.tenant_id = a.tenant_id AND e.id = a.employee_id
     WHERE a.tenant_id = :t AND a.work_date BETWEEN ? AND ?
       ${employee_id ? 'AND a.employee_id = ?' : ''}
     ORDER BY a.work_date, e.last_name`,
    employee_id ? [from, to, employee_id] : [from, to]);
  const scheduled = repo.query(
    `SELECT se.*, (e.first_name || ' ' || e.last_name) AS employee_name FROM schedule_entry se
     JOIN employee e ON e.tenant_id = se.tenant_id AND e.id = se.employee_id
     WHERE se.tenant_id = :t AND se.work_date BETWEEN ? AND ?
       ${employee_id ? 'AND se.employee_id = ?' : ''}`,
    employee_id ? [from, to, employee_id] : [from, to]);

  const attended = new Set(rows.map((r) => `${r.employee_id}|${r.work_date}`));
  const noShows = scheduled.filter((s) => !attended.has(`${s.employee_id}|${s.work_date}`));

  return {
    range: { from, to },
    days_recorded: rows.length,
    worked_hours: Qty.toNumber(sum(rows, (r) => r.worked_hours)),
    overtime_hours: Qty.toNumber(sum(rows, (r) => r.overtime_hours)),
    exceptions: rows.filter((r) => r.exception).map((r) => ({
      employee: r.employee_name, date: r.work_date, exception: r.exception,
      clock_in: r.clock_in, clock_out: r.clock_out,
    })),
    no_shows: noShows.map((s) => ({ employee: s.employee_name, date: s.work_date, shift: s.starts_at + '–' + s.ends_at })),
  };
}

// --------------------------------------------------------- self-service
export function raiseRequest(repo, input) {
  const errors = {};
  if (!input.employee_id) errors.employee_id = 'Employee is required';
  if (!REQUEST_TYPES.includes(input.request_type)) errors.request_type = `Type must be one of ${REQUEST_TYPES.join(', ')}`;
  if (Object.keys(errors).length) throw new ValidationError(errors);

  const employee = repo.get('employee', input.employee_id);
  if (!employee) throw notFound(`Employee ${input.employee_id} not found`);

  const id = ulid();
  repo.insert('employee_request', {
    id, employee_id: input.employee_id, request_type: input.request_type,
    title: input.title || input.request_type.replace(/_/g, ' '),
    payload: input.payload || {}, status: 'submitted',
    approver_id: employee.manager_id || null,
    decided_at: null, decision_note: '', created_at: nowIso(),
  });
  audit.record(repo, { recordType: 'employee_request', recordId: id, action: 'create' });
  return repo.get('employee_request', id);
}

/**
 * Approve a request and, where it is a change to the employee's own record,
 * apply it. Applying is deliberately restricted to a small whitelist: a
 * self-service form must never be able to write salary or manager.
 */
const SELF_SERVICE_FIELDS = {
  address_change: ['address', 'phone', 'personal_email'],
  bank_change: ['bank_account_name', 'bank_account_number', 'bank_sort_code'],
};

export function decideRequest(repo, id, { approve, note = '', approver_id = null } = {}) {
  const request = repo.get('employee_request', id);
  if (!request) throw notFound(`Request ${id} not found`);
  if (request.status !== 'submitted') throw unprocessable(`That request is already ${request.status}`);

  if (!approve) {
    repo.update('employee_request', id, { status: 'rejected', decided_at: nowIso(), decision_note: note, approver_id });
    return repo.get('employee_request', id);
  }

  const allowed = SELF_SERVICE_FIELDS[request.request_type];
  let applied = null;
  if (allowed) {
    const payload = request.payload || {};
    const columns = repo.db.$columns('employee');
    const patch = {};
    for (const field of allowed) {
      if (payload[field] !== undefined && columns.has(field)) patch[field] = payload[field];
    }
    if (Object.keys(patch).length) {
      const before = repo.get('employee', request.employee_id);
      repo.update('employee', request.employee_id, patch);
      audit.record(repo, { recordType: 'employee', recordId: request.employee_id, action: 'self_service_update', before, after: repo.get('employee', request.employee_id) });
      applied = Object.keys(patch);
    }
  }
  repo.update('employee_request', id, {
    status: applied ? 'applied' : 'approved',
    decided_at: nowIso(), decision_note: note, approver_id,
  });
  return { request: repo.get('employee_request', id), applied_fields: applied };
}

export const pendingRequests = (repo, { approver_id = null } = {}) =>
  repo.query(`SELECT er.*, (e.first_name || ' ' || e.last_name) AS employee_name FROM employee_request er
              JOIN employee e ON e.tenant_id = er.tenant_id AND e.id = er.employee_id
              WHERE er.tenant_id = :t AND er.status = 'submitted'
                ${approver_id ? 'AND er.approver_id = ?' : ''}
              ORDER BY er.created_at`, approver_id ? [approver_id] : []);
