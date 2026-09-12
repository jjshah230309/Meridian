// Meridian ERP :: modules/manufacturing
// Bills of material, routing, work orders and quality.
//
// A build is two stock movements and one cost reconciliation:
//   issue   -- components leave stock at their moving-average cost, into WIP;
//   receive -- the assembly enters stock at the cost that actually accrued;
//   variance -- anything left in WIP that the build did not absorb.
// Standard-cost shops want that variance visible rather than smeared into
// inventory, so it posts to its own account instead of adjusting the receipt.
import { ulid, Money, Qty, nowIso, today, isValidDate, sum, round } from '../core/util.mjs';
import { ValidationError, notFound, unprocessable } from '../core/http.mjs';
import { nextNumber } from '../core/seq.mjs';
import * as inv from './inventory.mjs';
import * as gl from './gl.mjs';
import { postingAccounts } from './setup.mjs';
import * as audit from '../core/audit.mjs';

export const WO_STATUSES = ['planned', 'released', 'in_progress', 'built', 'closed', 'cancelled'];
export const BOM_STATUSES = ['draft', 'released', 'obsolete'];

/**
 * The accounts a build posts through. The work order may name its own; a shop
 * that has not bothered gets the company defaults. Nothing here is allowed to
 * resolve to nothing quietly: stock leaves the warehouse during a build, and a
 * skipped journal would part the ledger from the stock ledger for good.
 */
function buildAccounts(repo, wo) {
  const acc = postingAccounts(repo);   // number -> account id
  const wip = wo.wip_account_id || acc.wip || gl.accountBySubtype(repo, 'WIP')?.id;
  const inventory = acc.inventory || gl.accountBySubtype(repo, 'INVENTORY')?.id;
  if (!wip || !inventory) {
    throw unprocessable(
      'This build cannot post: the chart of accounts has no work-in-progress or inventory account. '
      + 'Add one, or name the accounts on the work order.');
  }
  const variance = wo.variance_account_id || acc.mfg_variance || gl.accountBySubtype(repo, 'COGS')?.id || null;
  return {
    wip,
    inventory,
    variance,
    labour: acc.labour_absorbed || variance,
    overhead: acc.overhead_absorbed || variance,
  };
}

// ------------------------------------------------------------------- BOM
export const getBom = (repo, id) => {
  const b = repo.get('bom', id);
  if (!b) throw notFound(`Bill of material ${id} not found`);
  return b;
};
export const bomLines = (repo, bomId) =>
  repo.query(`SELECT bl.*, i.sku, i.name AS component_name, i.uom, i.type AS component_type
              FROM bom_line bl JOIN item i ON i.tenant_id = bl.tenant_id AND i.id = bl.component_id
              WHERE bl.tenant_id = :t AND bl.bom_id = ? ORDER BY bl.line_no`, [bomId]);
export const routingFor = (repo, bomId) =>
  repo.query('SELECT * FROM routing_step WHERE tenant_id = :t AND bom_id = ? ORDER BY operation_no', [bomId]);

export function createBom(repo, input) {
  const errors = {};
  if (!input.item_id) errors.item_id = 'The assembly item is required';
  if (!input.name) errors.name = 'Name is required';
  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (!lines.length) errors.lines = 'A bill of material needs at least one component';

  const assembly = input.item_id ? repo.get('item', input.item_id) : null;
  if (input.item_id && !assembly) errors.item_id = `Item ${input.item_id} not found`;
  lines.forEach((l, i) => {
    if (!l.component_id) { errors[`lines.${i}.component_id`] = 'Component is required'; return; }
    if (l.component_id === input.item_id) errors[`lines.${i}.component_id`] = 'An assembly cannot contain itself';
    if (!repo.get('item', l.component_id)) errors[`lines.${i}.component_id`] = `Item ${l.component_id} not found`;
    if (Qty.parse(l.quantity) <= 0) errors[`lines.${i}.quantity`] = 'Quantity must be greater than zero';
  });
  if (Object.keys(errors).length) throw new ValidationError(errors);

  const now = nowIso();
  const id = ulid();
  repo.insert('bom', {
    id, item_id: input.item_id, name: input.name,
    revision: input.revision || 'A', status: 'draft',
    effective_from: input.effective_from || null, effective_to: input.effective_to || null,
    yield_pct: Number(input.yield_pct ?? 100),
    is_default: input.is_default ? 1 : 0,
    notes: input.notes || '', custom: input.custom || {},
    created_at: now, updated_at: now,
  });
  lines.forEach((l, i) => repo.insert('bom_line', {
    id: ulid(), bom_id: id, line_no: i + 1,
    component_id: l.component_id, quantity: Qty.parse(l.quantity),
    scrap_pct: Number(l.scrap_pct || 0), operation_no: l.operation_no ?? null,
    is_optional: l.is_optional ? 1 : 0, notes: l.notes || '',
  }));
  for (const [i, st] of (input.routing || []).entries()) {
    repo.insert('routing_step', {
      id: ulid(), bom_id: id, operation_no: st.operation_no ?? (i + 1) * 10,
      name: st.name || `Operation ${i + 1}`, work_center_id: st.work_center_id || null,
      setup_hours: Qty.parse(st.setup_hours || 0), run_hours: Qty.parse(st.run_hours || 0),
      instructions: st.instructions || '',
    });
  }
  if (input.is_default) {
    repo.exec('UPDATE bom SET is_default = 0 WHERE tenant_id = :t AND item_id = ? AND id != ?', [input.item_id, id]);
  }
  audit.record(repo, { recordType: 'bom', recordId: id, action: 'create' });
  return getBom(repo, id);
}

export function releaseBom(repo, id) {
  const bom = getBom(repo, id);
  if (bom.status === 'released') return bom;
  if (!bomLines(repo, id).length) throw unprocessable('A bill of material cannot be released with no components');
  repo.update('bom', id, { status: 'released', updated_at: nowIso() });
  audit.record(repo, { recordType: 'bom', recordId: id, action: 'release' });
  return getBom(repo, id);
}

/**
 * Explode a BOM to its leaves, multiplying quantities down the tree.
 * `seen` breaks circular structures instead of recursing forever -- a
 * sub-assembly that (wrongly) contains its own parent should produce a
 * clear error, not a stack overflow.
 */
export function explode(repo, itemId, quantity = 1_000_000, depth = 0, seen = new Set()) {
  if (seen.has(itemId)) throw unprocessable(`Circular bill of material detected at item ${itemId}`);
  const bom = repo.queryOne(
    `SELECT * FROM bom WHERE tenant_id = :t AND item_id = ? AND status = 'released'
     ORDER BY is_default DESC, revision DESC LIMIT 1`, [itemId]);
  if (!bom || depth > 12) return [];

  const next = new Set(seen).add(itemId);
  const out = [];
  for (const l of bomLines(repo, bom.id)) {
    const scrapFactor = 1 + (l.scrap_pct || 0) / 100;
    const required = round((l.quantity * (quantity / 1_000_000)) * scrapFactor);
    out.push({
      depth, component_id: l.component_id, sku: l.sku, name: l.component_name,
      uom: l.uom, quantity: required, quantity_display: Qty.toNumber(required),
      operation_no: l.operation_no, scrap_pct: l.scrap_pct,
    });
    out.push(...explode(repo, l.component_id, required, depth + 1, next));
  }
  return out;
}

/** Rolled-up standard cost of building one of `itemId`. */
export function rollupCost(repo, itemId) {
  const components = explode(repo, itemId).filter((c) => c.depth === 0);
  let material = 0;
  const detail = [];
  for (const c of components) {
    const item = repo.get('item', c.component_id);
    const sub = repo.queryOne(
      "SELECT id FROM bom WHERE tenant_id = :t AND item_id = ? AND status = 'released' LIMIT 1", [c.component_id]);
    const unit = sub ? rollupCost(repo, c.component_id).unit_cost_minor : (item?.standard_cost || 0);
    const cost = Qty.extend(c.quantity, unit);
    material += cost;
    detail.push({ sku: c.sku, name: c.name, quantity: c.quantity_display, unit_cost: Money.toNumber(unit), cost: Money.toNumber(cost) });
  }
  const bom = repo.queryOne(
    "SELECT * FROM bom WHERE tenant_id = :t AND item_id = ? AND status = 'released' ORDER BY is_default DESC LIMIT 1", [itemId]);
  let labour = 0, overhead = 0;
  if (bom) {
    for (const st of routingFor(repo, bom.id)) {
      const wc = st.work_center_id ? repo.get('work_center', st.work_center_id) : null;
      if (!wc) continue;
      const hours = (st.setup_hours || 0) + (st.run_hours || 0);
      labour += Qty.extend(hours, wc.labour_rate || 0);
      overhead += Qty.extend(hours, wc.overhead_rate || 0);
    }
  }
  const total = material + labour + overhead;
  return {
    item_id: itemId, components: detail,
    material: Money.toNumber(material), labour: Money.toNumber(labour), overhead: Money.toNumber(overhead),
    unit_cost: Money.toNumber(total), unit_cost_minor: total,
  };
}

// ----------------------------------------------------------- work orders
export const getWorkOrder = (repo, id) => {
  const w = repo.get('work_order', id);
  if (!w) throw notFound(`Work order ${id} not found`);
  return w;
};
export const woLines = (repo, id) =>
  repo.query(`SELECT wl.*, i.sku, i.name AS component_name, i.uom
              FROM work_order_line wl JOIN item i ON i.tenant_id = wl.tenant_id AND i.id = wl.component_id
              WHERE wl.tenant_id = :t AND wl.work_order_id = ? ORDER BY wl.line_no`, [id]);
export const woOperations = (repo, id) =>
  repo.query('SELECT * FROM work_order_operation WHERE tenant_id = :t AND work_order_id = ? ORDER BY operation_no', [id]);

export function createWorkOrder(repo, input) {
  const errors = {};
  if (!input.item_id) errors.item_id = 'The assembly to build is required';
  if (!input.location_id) errors.location_id = 'Location is required';
  if (!input.subsidiary_id) errors.subsidiary_id = 'Subsidiary is required';
  const quantity = Qty.parse(input.quantity);
  if (quantity <= 0) errors.quantity = 'Quantity must be greater than zero';
  if (input.due_date && !isValidDate(input.due_date)) errors.due_date = 'Enter a valid due date';
  if (Object.keys(errors).length) throw new ValidationError(errors);

  const item = inv.getItem(repo, input.item_id);
  const bom = input.bom_id ? getBom(repo, input.bom_id) : repo.queryOne(
    `SELECT * FROM bom WHERE tenant_id = :t AND item_id = ? AND status = 'released'
     ORDER BY is_default DESC, revision DESC LIMIT 1`, [input.item_id]);
  if (!bom) throw unprocessable(`${item.sku} has no released bill of material, so there is nothing to build from`);

  // Resolve the posting accounts once, at creation, so the order carries a
  // visible answer to "where does this job's cost sit?" rather than deciding
  // it silently three screens later.
  const defaults = postingAccounts(repo);
  const now = nowIso();
  const id = ulid();
  repo.insert('work_order', {
    id, order_no: input.order_no || nextNumber(repo, 'WORK_ORDER'),
    item_id: input.item_id, bom_id: bom.id,
    subsidiary_id: input.subsidiary_id, location_id: input.location_id,
    quantity, quantity_built: 0, quantity_scrapped: 0,
    status: 'planned', priority: Number(input.priority || 5),
    start_date: input.start_date || null, due_date: input.due_date || null, completed_date: null,
    sales_order_id: input.sales_order_id || null, project_id: input.project_id || null,
    component_cost: 0, labour_cost: 0, overhead_cost: 0, built_value: 0, variance: 0,
    wip_account_id: input.wip_account_id || defaults.wip || null,
    variance_account_id: input.variance_account_id || defaults.mfg_variance || null,
    memo: input.memo || '', custom: input.custom || {},
    created_at: now, updated_at: now,
  });

  // Snapshot the BOM onto the order. A BOM revised tomorrow must not change
  // what a job started today was supposed to consume.
  const factor = quantity / 1_000_000;
  bomLines(repo, bom.id).forEach((l, i) => {
    const scrapFactor = 1 + (l.scrap_pct || 0) / 100;
    repo.insert('work_order_line', {
      id: ulid(), work_order_id: id, line_no: i + 1,
      component_id: l.component_id,
      quantity_required: round(l.quantity * factor * scrapFactor),
      quantity_issued: 0,
      unit_cost: repo.get('item', l.component_id)?.standard_cost || 0,
      location_id: input.location_id, operation_no: l.operation_no ?? null,
    });
  });
  for (const st of routingFor(repo, bom.id)) {
    repo.insert('work_order_operation', {
      id: ulid(), work_order_id: id, operation_no: st.operation_no,
      name: st.name, work_center_id: st.work_center_id,
      planned_hours: (st.setup_hours || 0) + round((st.run_hours || 0) * factor),
      actual_hours: 0, status: 'pending', started_at: null, completed_at: null,
    });
  }
  audit.record(repo, { recordType: 'work_order', recordId: id, action: 'create' });
  return { ...getWorkOrder(repo, id), lines: woLines(repo, id), operations: woOperations(repo, id) };
}

/** Do we have the components to start? Answered before anyone walks to the floor. */
export function componentAvailability(repo, id) {
  const wo = getWorkOrder(repo, id);
  const rows = woLines(repo, id).map((l) => {
    const pos = inv.position(repo, l.component_id, l.location_id || wo.location_id);
    const need = Math.max(0, l.quantity_required - l.quantity_issued);
    const free = inv.available(pos);
    return {
      component_id: l.component_id, sku: l.sku, name: l.component_name,
      required: Qty.toNumber(l.quantity_required), issued: Qty.toNumber(l.quantity_issued),
      outstanding: Qty.toNumber(need), available: Qty.toNumber(free),
      short: Qty.toNumber(Math.max(0, need - free)), sufficient: free >= need,
    };
  });
  return { work_order: wo.order_no, can_start: rows.every((r) => r.sufficient), components: rows };
}

export function releaseWorkOrder(repo, id) {
  const wo = getWorkOrder(repo, id);
  if (wo.status !== 'planned') throw unprocessable(`${wo.order_no} is already ${wo.status}`);
  repo.update('work_order', id, { status: 'released', updated_at: nowIso() });
  for (const l of woLines(repo, id)) {
    inv.commit(repo, l.component_id, l.location_id || wo.location_id, l.quantity_required - l.quantity_issued);
  }
  audit.record(repo, { recordType: 'work_order', recordId: id, action: 'release' });
  return getWorkOrder(repo, id);
}

/**
 * Issue components into WIP. Partial issues are normal on a long job, so
 * this is callable repeatedly and only ever moves what is still outstanding.
 */
export function issueComponents(repo, id, { lines = null, txn_date = today() } = {}) {
  const wo = getWorkOrder(repo, id);
  if (!['released', 'in_progress'].includes(wo.status)) {
    throw unprocessable(`${wo.order_no} must be released before components can be issued`);
  }
  if (lines !== null && lines !== undefined && !Array.isArray(lines)) {
    throw new ValidationError({ lines: 'Components to issue must be a list' });
  }
  const wanted = new Map((lines || []).map((l) => [l.line_id || l.component_id, Qty.parse(l.quantity)]));

  return repo.tx(() => {
    let issuedValue = 0;
    const moved = [];
    for (const l of woLines(repo, id)) {
      const outstanding = Math.max(0, l.quantity_required - l.quantity_issued);
      const qty = lines ? Math.min(outstanding, wanted.get(l.id) ?? wanted.get(l.component_id) ?? 0) : outstanding;
      if (qty <= 0) continue;
      const res = inv.moveStock(repo, {
        item_id: l.component_id, location_id: l.location_id || wo.location_id,
        qty_delta: -qty, type: 'build_issue',
        source_type: 'work_order', source_id: id, txn_date,
        memo: `Issued to ${wo.order_no}`,
      });
      inv.release(repo, l.component_id, l.location_id || wo.location_id, qty);
      repo.update('work_order_line', l.id, { quantity_issued: l.quantity_issued + qty, unit_cost: res.unit_cost_used });
      issuedValue += -res.value_delta;
      moved.push({ sku: l.sku, quantity: Qty.toNumber(qty), value: Money.toNumber(-res.value_delta) });
    }
    if (!moved.length) throw unprocessable('Nothing left to issue on this work order');

    repo.update('work_order', id, {
      component_cost: wo.component_cost + issuedValue,
      status: 'in_progress', updated_at: nowIso(),
    });
    // Components have left inventory but no finished good exists yet, so the
    // value sits in WIP until the build is received.
    if (issuedValue !== 0) {
      const acct = buildAccounts(repo, wo);
      gl.postJournal(repo, {
        subsidiary_id: wo.subsidiary_id, txn_date,
        memo: `${wo.order_no} components issued to WIP`,
        source_type: 'work_order', source_id: id,
        lines: [
          { account_id: acct.wip, debit: issuedValue, credit: 0, memo: 'WIP' },
          { account_id: acct.inventory, debit: 0, credit: issuedValue, memo: 'Components issued' },
        ],
      });
    }
    return { work_order: getWorkOrder(repo, id), issued: moved, value: Money.toNumber(issuedValue) };
  });
}

/** Log labour against an operation, accruing labour and overhead into the job. */
export function logOperation(repo, id, operationId, { hours, complete = false }) {
  const wo = getWorkOrder(repo, id);
  const op = repo.get('work_order_operation', operationId);
  if (!op || op.work_order_id !== id) throw notFound(`Operation ${operationId} is not on ${wo.order_no}`);
  const h = Qty.parse(hours);
  if (h <= 0) throw new ValidationError({ hours: 'Hours must be greater than zero' });

  const wc = op.work_center_id ? repo.get('work_center', op.work_center_id) : null;
  const labour = wc ? Qty.extend(h, wc.labour_rate || 0) : 0;
  const overhead = wc ? Qty.extend(h, wc.overhead_rate || 0) : 0;

  repo.update('work_order_operation', operationId, {
    actual_hours: op.actual_hours + h,
    status: complete ? 'complete' : 'running',
    started_at: op.started_at || nowIso(),
    completed_at: complete ? nowIso() : null,
  });
  repo.update('work_order', id, {
    labour_cost: wo.labour_cost + labour, overhead_cost: wo.overhead_cost + overhead,
    status: 'in_progress', updated_at: nowIso(),
  });

  // Labour and overhead are absorbed into the job the moment they are worked,
  // not conjured at receipt: without this the assembly would enter stock
  // carrying a cost no account ever gave up.
  if (labour || overhead) {
    const acct = buildAccounts(repo, wo);
    const lines = [];
    if (labour) {
      lines.push({ account_id: acct.wip, debit: labour, credit: 0, memo: 'Direct labour to WIP' });
      lines.push({ account_id: acct.labour || acct.variance, debit: 0, credit: labour, memo: 'Labour absorbed' });
    }
    if (overhead) {
      lines.push({ account_id: acct.wip, debit: overhead, credit: 0, memo: 'Overhead to WIP' });
      lines.push({ account_id: acct.overhead || acct.variance, debit: 0, credit: overhead, memo: 'Overhead absorbed' });
    }
    if (lines.every((l) => l.account_id)) {
      gl.postJournal(repo, {
        subsidiary_id: wo.subsidiary_id, txn_date: today(),
        memo: `${wo.order_no} ${op.name || 'operation'} logged`,
        source_type: 'work_order', source_id: id, lines,
      });
    }
  }

  return {
    operation: repo.get('work_order_operation', operationId),
    labour: Money.toNumber(labour), overhead: Money.toNumber(overhead),
  };
}

/**
 * Receive finished goods. The assembly enters stock at accrued cost per unit;
 * whatever remains in WIP after the last unit is variance.
 */
export function buildWorkOrder(repo, id, { quantity = null, scrapped = 0, txn_date = today(), close = false } = {}) {
  const wo = getWorkOrder(repo, id);
  if (!['released', 'in_progress'].includes(wo.status)) {
    throw unprocessable(`${wo.order_no} cannot be built while it is ${wo.status}`);
  }
  const remaining = wo.quantity - wo.quantity_built - wo.quantity_scrapped;
  const qty = quantity === null ? remaining : Qty.parse(quantity);
  const scrap = Qty.parse(scrapped);
  if (qty <= 0) throw new ValidationError({ quantity: 'Quantity must be greater than zero' });
  if (qty + scrap > remaining) {
    throw unprocessable(`Only ${Qty.format(remaining)} remain to build on ${wo.order_no}`);
  }

  return repo.tx(() => {
    const accrued = wo.component_cost + wo.labour_cost + wo.overhead_cost - wo.built_value;
    const proportion = (qty + scrap) / Math.max(1, remaining);
    const absorb = round(accrued * proportion);
    // Scrap consumed cost but produced nothing, so only good units carry value.
    const unitCost = qty > 0 ? round(absorb / (qty / 1_000_000)) : 0;

    const res = inv.moveStock(repo, {
      item_id: wo.item_id, location_id: wo.location_id, qty_delta: qty,
      unit_cost: unitCost, type: 'build_receive',
      source_type: 'work_order', source_id: id, txn_date,
      memo: `Built on ${wo.order_no}`,
    });

    const builtTotal = wo.quantity_built + qty;
    const scrapTotal = wo.quantity_scrapped + scrap;
    const done = close || builtTotal + scrapTotal >= wo.quantity;
    const builtValue = wo.built_value + res.value_delta;
    const variance = done ? (wo.component_cost + wo.labour_cost + wo.overhead_cost) - builtValue : 0;

    repo.update('work_order', id, {
      quantity_built: builtTotal, quantity_scrapped: scrapTotal,
      built_value: builtValue, variance,
      status: done ? 'built' : 'in_progress',
      completed_date: done ? txn_date : null,
      updated_at: nowIso(),
    });

    // Move value out of WIP into inventory, and land any leftover in variance.
    if (res.value_delta !== 0 || (done && variance !== 0)) {
      const acct = buildAccounts(repo, wo);
      const lines = [];
      if (res.value_delta !== 0) {
        lines.push({ account_id: acct.inventory, debit: res.value_delta, credit: 0, memo: 'Finished goods received' });
        lines.push({ account_id: acct.wip, debit: 0, credit: res.value_delta, memo: 'WIP relieved' });
      }
      // On the last unit, whatever WIP still holds is the job's variance. It
      // has to go somewhere or WIP carries a balance for a job that is over.
      if (done && variance !== 0 && acct.variance) {
        lines.push(variance > 0
          ? { account_id: acct.variance, debit: variance, credit: 0, memo: 'Unfavourable build variance' }
          : { account_id: acct.variance, debit: 0, credit: -variance, memo: 'Favourable build variance' });
        lines.push(variance > 0
          ? { account_id: acct.wip, debit: 0, credit: variance, memo: 'WIP cleared to variance' }
          : { account_id: acct.wip, debit: -variance, credit: 0, memo: 'WIP cleared to variance' });
      }
      if (lines.length) {
        gl.postJournal(repo, {
          subsidiary_id: wo.subsidiary_id, txn_date,
          memo: `${wo.order_no} build received`,
          source_type: 'work_order', source_id: id, lines,
        });
      }
    }
    audit.record(repo, { recordType: 'work_order', recordId: id, action: 'build', changes: { quantity_built: { from: Qty.toNumber(wo.quantity_built), to: Qty.toNumber(builtTotal) } } });
    return {
      work_order: getWorkOrder(repo, id),
      built: Qty.toNumber(qty), scrapped: Qty.toNumber(scrap),
      unit_cost: Money.toNumber(unitCost), value: Money.toNumber(res.value_delta),
      variance: Money.toNumber(variance), complete: done,
    };
  });
}

// --------------------------------------------------------------- quality
export function recordInspection(repo, input) {
  const errors = {};
  if (!input.reference_type) errors.reference_type = 'Reference type is required';
  if (!input.reference_id) errors.reference_id = 'Reference is required';
  const inspected = Qty.parse(input.quantity_inspected);
  const passed = Qty.parse(input.quantity_passed);
  const failed = Qty.parse(input.quantity_failed);
  if (inspected <= 0) errors.quantity_inspected = 'Inspected quantity must be greater than zero';
  if (passed + failed !== inspected) errors.quantity_passed = 'Passed plus failed must equal the quantity inspected';
  if (Object.keys(errors).length) throw new ValidationError(errors);

  const id = ulid();
  const checks = Array.isArray(input.checks) ? input.checks : [];
  const result = input.result || (failed === 0 ? 'pass' : passed === 0 ? 'fail' : 'conditional');
  repo.insert('quality_inspection', {
    id, reference_type: input.reference_type, reference_id: input.reference_id,
    item_id: input.item_id || null, inspector_id: input.inspector_id || null,
    inspected_at: input.inspected_at || nowIso(),
    quantity_inspected: inspected, quantity_passed: passed, quantity_failed: failed,
    result, disposition: input.disposition || (failed ? 'rework' : 'accept'),
    checks, notes: input.notes || '', created_at: nowIso(),
  });
  audit.record(repo, { recordType: 'quality_inspection', recordId: id, action: 'create' });
  return repo.get('quality_inspection', id);
}

/** First-pass yield and the failures behind it. */
export function qualitySummary(repo, { from = null, to = null } = {}) {
  const rows = repo.query(
    `SELECT * FROM quality_inspection WHERE tenant_id = :t
     ${from ? 'AND inspected_at >= ?' : ''} ${to ? 'AND inspected_at <= ?' : ''}
     ORDER BY inspected_at DESC`,
    [...(from ? [from] : []), ...(to ? [to + 'T23:59:59Z'] : [])]);
  const inspected = sum(rows, (r) => r.quantity_inspected);
  const passed = sum(rows, (r) => r.quantity_passed);
  const byItem = new Map();
  for (const r of rows) {
    if (!r.item_id) continue;
    const g = byItem.get(r.item_id) || { item_id: r.item_id, inspected: 0, failed: 0 };
    g.inspected += r.quantity_inspected; g.failed += r.quantity_failed;
    byItem.set(r.item_id, g);
  }
  return {
    inspections: rows.length,
    quantity_inspected: Qty.toNumber(inspected),
    first_pass_yield_pct: inspected ? Math.round((passed / inspected) * 1000) / 10 : null,
    failures: rows.filter((r) => r.result === 'fail').length,
    // Carry the SKU and name: a table of item ids tells nobody which part is
    // failing.
    worst_items: [...byItem.values()]
      .map((g) => {
        const item = repo.get('item', g.item_id);
        return {
          ...g, sku: item?.sku || '', name: item?.name || g.item_id,
          inspected: Qty.toNumber(g.inspected), failed: Qty.toNumber(g.failed),
          fail_pct: g.inspected ? Math.round((g.failed / g.inspected) * 1000) / 10 : 0,
        };
      })
      .sort((a, b) => b.fail_pct - a.fail_pct).slice(0, 10),
  };
}
