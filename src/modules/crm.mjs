// Meridian ERP :: modules/crm
// Lead-to-cash: leads, opportunities, forecasting, activities and support.
import { ulid, nowIso, today, Money, addDays, daysBetween, sum, groupBy } from '../core/util.mjs';
import { notFound, unprocessable, ValidationError } from '../core/http.mjs';
import { nextNumber } from '../core/seq.mjs';
import * as audit from '../core/audit.mjs';
import { indexRecord } from '../core/search.mjs';
import * as entities from './entities.mjs';

export const LEAD_STATUSES = ['new', 'working', 'qualified', 'unqualified', 'converted'];
export const STAGES = ['prospecting', 'qualification', 'proposal', 'negotiation', 'closed_won', 'closed_lost'];
export const STAGE_LABELS = { prospecting: 'Prospecting', qualification: 'Qualification', proposal: 'Proposal', negotiation: 'Negotiation', closed_won: 'Closed Won', closed_lost: 'Closed Lost' };
/** Default win probability per stage; a rep may override it per deal. */
export const STAGE_PROBABILITY = { prospecting: 10, qualification: 25, proposal: 50, negotiation: 75, closed_won: 100, closed_lost: 0 };
export const FORECAST_CATEGORIES = ['pipeline', 'best_case', 'commit', 'closed', 'omitted'];
export const CASE_STATUSES = ['new', 'open', 'pending', 'escalated', 'resolved', 'closed'];
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

/** Hours to first response / resolution, by priority. Drives sla_due_at. */
export const SLA_HOURS = { urgent: 2, high: 8, medium: 24, low: 72 };

// ----------------------------------------------------------------- leads
export function createLead(repo, input) {
  if (!input.name) throw new ValidationError({ name: 'Lead name is required' });
  const now = nowIso();
  const id = repo.insert('lead', {
    id: ulid(), lead_no: input.lead_no || nextNumber(repo, 'lead'),
    name: input.name, company: input.company || '', email: input.email || '', phone: input.phone || '',
    title: input.title || '', source: input.source || '', status: input.status || 'new',
    rating: input.rating || 'warm', score: Number(input.score || 0), industry: input.industry || '',
    estimated_value: Money.parse(input.estimated_value ?? 0),
    owner_id: input.owner_id || repo.ctx?.user?.id || null, address: input.address || {},
    notes: input.notes || '', custom: input.custom || {}, created_at: now, updated_at: now,
  });
  audit.record(repo, { recordType: 'lead', recordId: id, action: 'create', after: input });
  reindexLead(repo, id);
  return repo.get('lead', id);
}

export function updateLead(repo, id, patch) {
  const before = repo.get('lead', id);
  if (!before) throw notFound('Lead not found');
  if (before.status === 'converted' && patch.status && patch.status !== 'converted') {
    throw unprocessable(`${before.name} has already been converted and cannot be reopened.`);
  }
  const allowed = ['name', 'company', 'email', 'phone', 'title', 'source', 'status', 'rating', 'score',
    'industry', 'estimated_value', 'owner_id', 'address', 'notes', 'custom'];
  const clean = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k)) continue;
    clean[k] = k === 'estimated_value' ? Money.parse(v) : v;
  }
  clean.updated_at = nowIso();
  repo.update('lead', id, clean);
  const after = repo.get('lead', id);
  audit.record(repo, { recordType: 'lead', recordId: id, action: 'update', before, after });
  reindexLead(repo, id);
  return after;
}

export function reindexLead(repo, id) {
  const l = repo.get('lead', id);
  if (!l) return;
  indexRecord(repo, 'lead', id, {
    title: l.name, subtitle: [l.company, l.status].filter(Boolean).join(' · '),
    body: [l.email, l.phone, l.title, l.industry, l.source, l.notes].filter(Boolean).join(' '),
  });
}

/**
 * Convert a lead into a customer, and optionally an opportunity.
 * The lead is retained (never deleted) so campaign attribution survives.
 */
export function convertLead(repo, id, options = {}) {
  const lead = repo.get('lead', id);
  if (!lead) throw notFound('Lead not found');
  if (lead.status === 'converted') throw unprocessable(`${lead.name} was already converted.`);

  const customer = entities.createCustomer(repo, {
    name: options.customer_name || lead.company || lead.name,
    email: lead.email, phone: lead.phone, billing_address: lead.address,
    source: lead.source, owner_id: lead.owner_id,
    subsidiary_id: options.subsidiary_id, currency: options.currency,
    terms: options.terms, status: 'active',
  });

  let contact = null;
  if (options.create_contact !== false) {
    const parts = String(lead.name).trim().split(/\s+/);
    contact = entities.createContact(repo, {
      first_name: parts[0] || '', last_name: parts.slice(1).join(' ') || '',
      email: lead.email, phone: lead.phone, title: lead.title,
      company_type: 'customer', company_id: customer.id, is_primary: 1, owner_id: lead.owner_id,
    });
  }

  let opportunity = null;
  if (options.create_opportunity !== false) {
    opportunity = createOpportunity(repo, {
      name: options.opportunity_name || `${customer.name} — new business`,
      customer_id: customer.id, lead_id: lead.id,
      amount: options.amount ?? Money.toNumber(lead.estimated_value),
      currency: customer.currency, stage: options.stage || 'qualification',
      expected_close: options.expected_close || addDays(today(), 30),
      owner_id: lead.owner_id, source: lead.source, subsidiary_id: customer.subsidiary_id,
    });
  }

  repo.update('lead', id, {
    status: 'converted', converted_customer_id: customer.id,
    converted_opportunity_id: opportunity?.id || null, converted_at: nowIso(), updated_at: nowIso(),
  });
  audit.record(repo, { recordType: 'lead', recordId: id, action: 'convert', changes: { customer: { from: null, to: customer.name }, opportunity: { from: null, to: opportunity?.name || null } } });
  reindexLead(repo, id);
  return { lead: repo.get('lead', id), customer, contact, opportunity };
}

// --------------------------------------------------------- opportunities
export function createOpportunity(repo, input) {
  const fields = {};
  if (!input.name) fields.name = 'Opportunity name is required';
  if (input.stage && !STAGES.includes(input.stage)) fields.stage = `Stage must be one of ${STAGES.join(', ')}`;
  if (!input.customer_id && !input.lead_id) fields.customer_id = 'Link the opportunity to a customer or a lead';
  if (Object.keys(fields).length) throw new ValidationError(fields);

  const customer = input.customer_id ? entities.getCustomer(repo, input.customer_id) : null;
  const stage = input.stage || 'prospecting';
  const amount = Money.parse(input.amount ?? 0);
  const probability = input.probability ?? STAGE_PROBABILITY[stage];
  const now = nowIso();

  const id = repo.insert('opportunity', {
    id: ulid(), opp_no: input.opp_no || nextNumber(repo, 'opportunity'),
    name: input.name, customer_id: input.customer_id || null, lead_id: input.lead_id || null,
    stage, amount, currency: input.currency || customer?.currency || 'USD',
    probability, weighted_amount: Money.pct(amount, probability),
    forecast_category: input.forecast_category || forecastCategoryFor(stage, probability),
    expected_close: input.expected_close || addDays(today(), 30),
    // A deal created already closed still needs a close date, or it is
    // invisible to win-rate and cycle-length reporting.
    actual_close: input.actual_close || (stage.startsWith('closed') ? (input.expected_close || today()) : null),
    owner_id: input.owner_id || repo.ctx?.user?.id || null, sales_rep_id: input.sales_rep_id || null,
    subsidiary_id: input.subsidiary_id || customer?.subsidiary_id || null,
    source: input.source || '', competitor: input.competitor || '', lost_reason: '',
    next_step: input.next_step || '', notes: input.notes || '', custom: input.custom || {},
    created_at: now, updated_at: now,
  });
  audit.record(repo, { recordType: 'opportunity', recordId: id, action: 'create', after: input });
  reindexOpportunity(repo, id);
  return repo.get('opportunity', id);
}

const forecastCategoryFor = (stage, probability) =>
  stage === 'closed_won' ? 'closed' : stage === 'closed_lost' ? 'omitted'
    : probability >= 75 ? 'commit' : probability >= 50 ? 'best_case' : 'pipeline';

export function updateOpportunity(repo, id, patch) {
  const before = repo.get('opportunity', id);
  if (!before) throw notFound('Opportunity not found');
  if (patch.stage && !STAGES.includes(patch.stage)) throw new ValidationError({ stage: 'Unknown stage' });

  const allowed = ['name', 'customer_id', 'stage', 'amount', 'currency', 'probability', 'forecast_category',
    'expected_close', 'owner_id', 'sales_rep_id', 'subsidiary_id', 'source', 'competitor',
    'lost_reason', 'next_step', 'notes', 'custom'];
  const clean = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k)) continue;
    clean[k] = k === 'amount' ? Money.parse(v) : v;
  }
  // Moving stage resets probability unless the caller set one explicitly.
  if (clean.stage && clean.stage !== before.stage && patch.probability === undefined) {
    clean.probability = STAGE_PROBABILITY[clean.stage];
  }
  const stage = clean.stage || before.stage;
  const amount = clean.amount ?? before.amount;
  const probability = clean.probability ?? before.probability;
  clean.weighted_amount = Money.pct(amount, probability);
  if (patch.forecast_category === undefined) clean.forecast_category = forecastCategoryFor(stage, probability);
  if (['closed_won', 'closed_lost'].includes(stage) && !before.actual_close) clean.actual_close = today();
  if (stage === 'closed_lost' && !clean.lost_reason && !before.lost_reason) clean.lost_reason = patch.lost_reason || 'Not specified';
  clean.updated_at = nowIso();

  repo.update('opportunity', id, clean);
  const after = repo.get('opportunity', id);
  audit.record(repo, { recordType: 'opportunity', recordId: id, action: clean.stage && clean.stage !== before.stage ? 'stage_change' : 'update', before, after });
  reindexOpportunity(repo, id);
  return after;
}

export function reindexOpportunity(repo, id) {
  const o = repo.get('opportunity', id);
  if (!o) return;
  const cust = o.customer_id ? repo.get('customer', o.customer_id) : null;
  indexRecord(repo, 'opportunity', id, {
    title: o.name, subtitle: `${cust?.name || ''} · ${Money.format(o.amount, o.currency)} · ${STAGE_LABELS[o.stage] || o.stage}`,
    body: [o.notes, o.next_step, o.source, o.competitor, cust?.name].filter(Boolean).join(' '),
  });
}

/** Pipeline grouped by stage, for the kanban board. */
export function pipeline(repo, { ownerId = null, subsidiaryId = null } = {}) {
  const where = ["o.stage NOT IN ('closed_won','closed_lost')"]; const params = [];
  if (ownerId) { where.push('o.owner_id = ?'); params.push(ownerId); }
  if (subsidiaryId) { where.push('o.subsidiary_id = ?'); params.push(subsidiaryId); }
  const rows = repo.query(`SELECT o.*, c.name customer_name FROM opportunity o
      LEFT JOIN customer c ON c.tenant_id = o.tenant_id AND c.id = o.customer_id
      WHERE o.tenant_id = :t AND ${where.join(' AND ')} ORDER BY o.expected_close`, params);
  const byStage = groupBy(rows, (r) => r.stage);
  return STAGES.filter((s) => !s.startsWith('closed')).map((stage) => ({
    stage, label: STAGE_LABELS[stage],
    deals: byStage[stage] || [],
    count: (byStage[stage] || []).length,
    value: sum(byStage[stage] || [], (d) => d.amount),
    weighted: sum(byStage[stage] || [], (d) => d.weighted_amount),
  }));
}

/**
 * Sales forecast for a window, split by forecast category.
 * `closed` is actual won revenue; `commit` is what reps have committed to.
 */
export function forecast(repo, { from = null, to = null, ownerId = null, subsidiaryId = null } = {}) {
  const start = from || today().slice(0, 8) + '01';
  const end = to || addDays(start, 92);
  const where = ['o.expected_close >= ?', 'o.expected_close <= ?']; const params = [start, end];
  if (ownerId) { where.push('o.owner_id = ?'); params.push(ownerId); }
  if (subsidiaryId) { where.push('o.subsidiary_id = ?'); params.push(subsidiaryId); }

  const rows = repo.query(`SELECT o.*, c.name customer_name, u.name owner_name FROM opportunity o
      LEFT JOIN customer c ON c.tenant_id = o.tenant_id AND c.id = o.customer_id
      LEFT JOIN app_user u ON u.tenant_id = o.tenant_id AND u.id = o.owner_id
      WHERE o.tenant_id = :t AND ${where.join(' AND ')}`, params);

  const cat = {};
  for (const c of FORECAST_CATEGORIES) cat[c] = { category: c, count: 0, amount: 0, weighted: 0 };
  for (const r of rows) {
    const c = cat[r.forecast_category] || cat.pipeline;
    c.count++; c.amount += r.amount; c.weighted += r.weighted_amount;
  }
  const closedWon = sum(rows.filter((r) => r.stage === 'closed_won'), (r) => r.amount);
  const open = rows.filter((r) => !r.stage.startsWith('closed'));

  const byOwner = Object.entries(groupBy(rows, (r) => r.owner_name || 'Unassigned')).map(([name, deals]) => ({
    owner: name, count: deals.length,
    pipeline: sum(deals.filter((d) => !d.stage.startsWith('closed')), (d) => d.amount),
    weighted: sum(deals.filter((d) => !d.stage.startsWith('closed')), (d) => d.weighted_amount),
    won: sum(deals.filter((d) => d.stage === 'closed_won'), (d) => d.amount),
  })).sort((a, b) => b.weighted - a.weighted);

  return {
    period: { from: start, to: end },
    categories: Object.values(cat),
    closed_won: closedWon,
    open_pipeline: sum(open, (r) => r.amount),
    weighted_pipeline: sum(open, (r) => r.weighted_amount),
    // The number a sales leader actually reports: booked plus committed.
    forecast_total: closedWon + cat.commit.amount,
    best_case_total: closedWon + cat.commit.amount + cat.best_case.amount,
    deal_count: rows.length,
    by_owner: byOwner,
    deals: rows.sort((a, b) => b.weighted_amount - a.weighted_amount).slice(0, 50),
  };
}

/** Win rate, cycle length and average deal size over a lookback window. */
export function salesMetrics(repo, { days = 180 } = {}) {
  const since = addDays(today(), -days);
  const closed = repo.query(`SELECT * FROM opportunity WHERE tenant_id = :t AND actual_close >= ? AND stage IN ('closed_won','closed_lost')`, [since]);
  const won = closed.filter((o) => o.stage === 'closed_won');
  const cycles = won.filter((o) => o.created_at && o.actual_close).map((o) => daysBetween(o.created_at.slice(0, 10), o.actual_close)).filter((n) => n >= 0);
  return {
    window_days: days,
    closed_count: closed.length, won_count: won.length,
    win_rate: closed.length ? Math.round((won.length / closed.length) * 100) : 0,
    won_value: sum(won, (o) => o.amount),
    lost_value: sum(closed.filter((o) => o.stage === 'closed_lost'), (o) => o.amount),
    average_deal: won.length ? Math.round(sum(won, (o) => o.amount) / won.length) : 0,
    average_cycle_days: cycles.length ? Math.round(cycles.reduce((a, b) => a + b, 0) / cycles.length) : null,
  };
}

// ------------------------------------------------------------ activities
export function createActivity(repo, input) {
  if (!input.subject) throw new ValidationError({ subject: 'Subject is required' });
  const now = nowIso();
  const id = repo.insert('activity', {
    id: ulid(), type: input.type || 'task', subject: input.subject, notes: input.notes || '',
    related_type: input.related_type || null, related_id: input.related_id || null,
    owner_id: input.owner_id || repo.ctx?.user?.id || null,
    assigned_to: input.assigned_to || repo.ctx?.user?.id || null,
    priority: input.priority || 'normal', due_date: input.due_date || null,
    start_at: input.start_at || null, completed_at: null, status: 'open',
    custom: input.custom || {}, created_at: now, updated_at: now,
  });
  audit.record(repo, { recordType: 'activity', recordId: id, action: 'create', after: input });
  return repo.get('activity', id);
}

export function updateActivity(repo, id, patch) {
  const before = repo.get('activity', id);
  if (!before) throw notFound('Activity not found');
  const allowed = ['type', 'subject', 'notes', 'related_type', 'related_id', 'owner_id', 'assigned_to',
    'priority', 'due_date', 'start_at', 'status', 'custom'];
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  if (clean.status === 'completed' && !before.completed_at) clean.completed_at = nowIso();
  if (clean.status === 'open') clean.completed_at = null;
  clean.updated_at = nowIso();
  repo.update('activity', id, clean);
  const after = repo.get('activity', id);
  audit.record(repo, { recordType: 'activity', recordId: id, action: 'update', before, after });
  return after;
}

/** Everything that has happened against a record, newest first. */
export function timelineFor(repo, relatedType, relatedId, limit = 50) {
  const acts = repo.query(`SELECT a.*, u.name owner_name FROM activity a
      LEFT JOIN app_user u ON u.tenant_id = a.tenant_id AND u.id = a.owner_id
      WHERE a.tenant_id = :t AND a.related_type = ? AND a.related_id = ?
      ORDER BY COALESCE(a.completed_at, a.due_date, a.created_at) DESC LIMIT ?`, [relatedType, relatedId, limit]);
  return acts;
}

// ------------------------------------------------------------- support
export function createCase(repo, input) {
  if (!input.subject) throw new ValidationError({ subject: 'Subject is required' });
  const priority = PRIORITIES.includes(input.priority) ? input.priority : 'medium';
  const now = nowIso();
  const id = repo.insert('support_case', {
    id: ulid(), case_no: input.case_no || nextNumber(repo, 'support_case'),
    subject: input.subject, description: input.description || '',
    customer_id: input.customer_id || null, contact_id: input.contact_id || null,
    origin: input.origin || 'email', category: input.category || 'general',
    priority, severity: input.severity || 'minor', status: 'new',
    assigned_to: input.assigned_to || null,
    sla_due_at: new Date(Date.now() + SLA_HOURS[priority] * 3600000).toISOString(),
    custom: input.custom || {}, created_at: now, updated_at: now,
  });
  if (input.description) {
    repo.insert('case_message', {
      id: ulid(), case_id: id, author_type: 'customer', author_id: input.contact_id || null,
      author_name: input.reporter_name || 'Customer', body: input.description, internal: 0, created_at: now,
    });
  }
  audit.record(repo, { recordType: 'support_case', recordId: id, action: 'create', after: input });
  reindexCase(repo, id);
  return repo.get('support_case', id);
}

export function updateCase(repo, id, patch) {
  const before = repo.get('support_case', id);
  if (!before) throw notFound('Case not found');
  if (patch.status && !CASE_STATUSES.includes(patch.status)) throw new ValidationError({ status: 'Unknown case status' });
  const allowed = ['subject', 'description', 'customer_id', 'contact_id', 'origin', 'category',
    'priority', 'severity', 'status', 'assigned_to', 'resolution', 'satisfaction', 'custom'];
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  if (clean.priority && clean.priority !== before.priority && !before.first_response_at) {
    clean.sla_due_at = new Date(Date.parse(before.created_at) + SLA_HOURS[clean.priority] * 3600000).toISOString();
  }
  if (['resolved', 'closed'].includes(clean.status) && !before.resolved_at) clean.resolved_at = nowIso();
  if (clean.status && !['resolved', 'closed'].includes(clean.status)) clean.resolved_at = null;
  clean.updated_at = nowIso();
  repo.update('support_case', id, clean);
  const after = repo.get('support_case', id);
  audit.record(repo, { recordType: 'support_case', recordId: id, action: 'update', before, after });
  reindexCase(repo, id);
  return after;
}

export function addCaseMessage(repo, caseId, { body, internal = false, authorType = 'agent', authorName = null }) {
  const c = repo.get('support_case', caseId);
  if (!c) throw notFound('Case not found');
  if (!body?.trim()) throw new ValidationError({ body: 'Message cannot be empty' });
  const now = nowIso();
  repo.insert('case_message', {
    id: ulid(), case_id: caseId, author_type: authorType,
    author_id: repo.ctx?.user?.id || null,
    author_name: authorName || repo.ctx?.user?.name || 'Agent',
    body: body.trim(), internal: internal ? 1 : 0, created_at: now,
  });
  const patch = { updated_at: now };
  if (authorType === 'agent' && !internal && !c.first_response_at) patch.first_response_at = now;
  if (authorType === 'agent' && c.status === 'new') patch.status = 'open';
  if (authorType === 'customer' && ['resolved', 'pending'].includes(c.status)) patch.status = 'open';
  repo.update('support_case', caseId, patch);
  return repo.query('SELECT * FROM case_message WHERE tenant_id = :t AND case_id = ? ORDER BY created_at', [caseId]);
}

export function reindexCase(repo, id) {
  const c = repo.get('support_case', id);
  if (!c) return;
  const cust = c.customer_id ? repo.get('customer', c.customer_id) : null;
  indexRecord(repo, 'support_case', id, {
    title: `${c.case_no} · ${c.subject}`,
    subtitle: `${cust?.name || 'No customer'} · ${c.status} · ${c.priority}`,
    body: [c.description, c.resolution, c.category].filter(Boolean).join(' '),
  });
}

/** Support desk health: volume, breaches, backlog age. */
export function supportMetrics(repo) {
  const open = repo.query(`SELECT * FROM support_case WHERE tenant_id = :t AND status NOT IN ('resolved','closed')`);
  const nowMs = Date.now();
  const breached = open.filter((c) => c.sla_due_at && Date.parse(c.sla_due_at) < nowMs && !c.first_response_at);
  const resolved30 = repo.query(`SELECT * FROM support_case WHERE tenant_id = :t AND resolved_at >= ?`, [addDays(today(), -30)]);
  const resolutionHours = resolved30
    .filter((c) => c.resolved_at && c.created_at)
    .map((c) => (Date.parse(c.resolved_at) - Date.parse(c.created_at)) / 3600000);
  return {
    open_count: open.length,
    by_priority: Object.fromEntries(PRIORITIES.map((p) => [p, open.filter((c) => c.priority === p).length])),
    by_status: Object.fromEntries(CASE_STATUSES.map((s) => [s, open.filter((c) => c.status === s).length])),
    sla_breached: breached.length,
    unassigned: open.filter((c) => !c.assigned_to).length,
    resolved_last_30: resolved30.length,
    avg_resolution_hours: resolutionHours.length ? Math.round(resolutionHours.reduce((a, b) => a + b, 0) / resolutionHours.length * 10) / 10 : null,
    oldest_open_days: open.length ? Math.max(...open.map((c) => daysBetween(c.created_at.slice(0, 10), today()))) : 0,
  };
}
