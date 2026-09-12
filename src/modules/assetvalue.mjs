// Meridian ERP :: asset revaluation, impairment and transfer
//
// Depreciation is a plan: spread what a thing cost over the years it is useful
// for. Reality interferes. A building is worth more than it cost. A machine is
// damaged, or the product it made is discontinued and it will never earn back
// what is still sitting on the balance sheet.
//
// Neither is a depreciation question and neither can be fixed by editing the
// schedule, which is why this is its own module.
//
// The rule that does the work, and the one people get wrong:
//
//   An upward revaluation goes to EQUITY, not to profit -- nothing has been
//   sold, so nothing has been earned -- except to the extent it reverses a
//   loss this same asset was charged with earlier, which does go back through
//   the income statement.
//
//   A downward revaluation first eats any reserve this asset previously built
//   up, and only what is left is a loss.
//
//   An impairment is always a loss. That is what the word means.
//
// Both change what is left to depreciate, so both rebuild the remaining
// schedule from the date they take effect. Depreciation already posted is
// never touched: it was right when it was charged.
import { ulid, Money, nowIso, today, isValidDate, addMonths, endOfMonth } from '../core/util.mjs';
import { ValidationError, notFound, unprocessable, conflict, optionalDate } from '../core/http.mjs';
import { nextNumber } from '../core/seq.mjs';
import * as gl from './gl.mjs';
import * as assets from './assets.mjs';
import * as audit from '../core/audit.mjs';

export const KINDS = ['revaluation', 'impairment'];

const RESERVE = '3850';
const LOSS = '7060';

function account(repo, number, what) {
  const a = repo.queryOne('SELECT * FROM account WHERE tenant_id = :t AND number = ? AND active = 1', [number]);
  if (!a) throw unprocessable(`Account ${number} ${what} is missing from the chart of accounts. Add it before revaluing an asset.`);
  return a;
}

/**
 * What the books say the asset is worth right now.
 *
 * Taken from depreciation actually posted rather than from the schedule,
 * because the schedule is a plan and the plan is not what the ledger holds.
 */
export function carryingAmount(repo, assetId) {
  const asset = assets.getAsset(repo, assetId);
  const posted = repo.scalar(
    'SELECT COALESCE(SUM(amount), 0) v FROM depreciation_line WHERE tenant_id = :t AND asset_id = ? AND posted = 1',
    [assetId], 0);
  return {
    asset,
    cost: asset.cost,
    depreciated: posted,
    carrying: asset.cost - posted,
    reserve: asset.revaluation_reserve || 0,
    impaired: asset.impairment_total || 0,
  };
}

/**
 * How an adjustment splits between equity and the income statement.
 *
 * This is the whole of the accounting judgement, in one place, so it can be
 * read and tested on its own.
 */
export function splitAdjustment({ adjustment, reserve = 0, impaired = 0, kind = 'revaluation' }) {
  // Writing down. Any reserve this asset built up by being written up before
  // has to go first -- it was never profit, and it cannot survive the value
  // it represented going away. Only what is left over is a loss.
  if (adjustment < 0) {
    const fromReserve = Math.min(Math.max(reserve, 0), -adjustment);
    // `|| 0` because negating zero gives -0, which is true but reads as a
    // mistake wherever it is stored or shown.
    return { to_reserve: -fromReserve || 0, to_income: (adjustment + fromReserve) || 0 };
  }

  // Writing up. Income only to the extent it reverses a loss this same asset
  // was charged with earlier -- that loss went through profit, so undoing it
  // goes back through profit. Anything beyond that has not been earned by
  // anybody and belongs in the reserve until the asset is sold.
  if (adjustment > 0) {
    if (kind === 'impairment') {
      throw unprocessable('An impairment writes an asset down. To write one back up, revalue it.');
    }
    const reversing = Math.min(Math.max(impaired, 0), adjustment);
    return { to_reserve: adjustment - reversing, to_income: reversing };
  }
  return { to_reserve: 0, to_income: 0 };
}

export const getRevaluation = (repo, id) => {
  const r = repo.get('asset_revaluation', id);
  if (!r) throw notFound('Revaluation not found');
  r.asset = repo.get('fixed_asset', r.asset_id);
  r.entry = r.journal_entry_id ? gl.getJournalEntry(repo, r.journal_entry_id) : null;
  return r;
};

export const revaluationsFor = (repo, assetId) => repo.query(
  `SELECT * FROM asset_revaluation WHERE tenant_id = :t AND asset_id = ?
   ORDER BY effective_date DESC, created_at DESC`, [assetId]);

export const list = (repo, { kind = null, from = null, to = null, limit = 200 } = {}) => {
  from = optionalDate(from, 'from');
  to = optionalDate(to, 'to');
  const where = ['r.tenant_id = :t'];
  const params = [];
  if (kind && kind !== 'all') { where.push('r.kind = ?'); params.push(kind); }
  if (from) { where.push('r.effective_date >= ?'); params.push(from); }
  if (to) { where.push('r.effective_date <= ?'); params.push(to); }
  const rows = repo.query(
    `SELECT r.*, a.asset_no, a.name AS asset_name, a.currency
     FROM asset_revaluation r
     JOIN fixed_asset a ON a.tenant_id = r.tenant_id AND a.id = r.asset_id
     WHERE ${where.join(' AND ')}
     ORDER BY r.effective_date DESC, r.created_at DESC LIMIT ?`, [...params, Math.min(limit, 1000)]);
  return { rows, total: rows.length };
};

/** What revaluing to `new_value` would do, without doing it. */
export function preview(repo, assetId, { new_value, effective_date = today(), kind = 'revaluation', remaining_life_months = null } = {}) {
  const state = carryingAmount(repo, assetId);
  const target = Money.parse(new_value);
  const adjustment = target - state.carrying;
  const split = splitAdjustment({ adjustment, reserve: state.reserve, impaired: state.impaired, kind });

  const remaining = remaining_life_months !== null && remaining_life_months !== undefined
    ? Number(remaining_life_months)
    : repo.scalar(
      'SELECT COUNT(*) c FROM depreciation_line WHERE tenant_id = :t AND asset_id = ? AND posted = 0 AND depr_date >= ?',
      [assetId, effective_date], 0);

  return {
    asset: { id: state.asset.id, asset_no: state.asset.asset_no, name: state.asset.name, currency: state.asset.currency },
    kind, effective_date,
    cost: state.cost,
    depreciated: state.depreciated,
    carrying_before: state.carrying,
    carrying_after: target,
    adjustment,
    ...split,
    reserve_before: state.reserve,
    reserve_after: state.reserve + split.to_reserve,
    impaired_before: state.impaired,
    impaired_after: Math.max(0, state.impaired - split.to_income),
    remaining_life_months: remaining,
    // What the charge becomes once the new value is spread over what is left.
    new_monthly_charge: remaining > 0 ? Math.round(Math.max(0, target - (state.asset.salvage_value || 0)) / remaining) : 0,
  };
}

/**
 * Restate an asset, and rebuild what is left of its schedule.
 *
 * The entry adjusts the asset account itself rather than accumulated
 * depreciation. Both treatments exist in practice; this one is chosen because
 * it leaves the accumulated depreciation column meaning exactly one thing --
 * depreciation charged -- which is what every report reading it assumes.
 */
export function revalue(repo, assetId, input = {}) {
  const {
    new_value, effective_date = today(), kind = 'revaluation',
    reason = '', memo = '', remaining_life_months = null,
  } = input;

  const errors = {};
  if (!KINDS.includes(kind)) errors.kind = `Choose ${KINDS.join(' or ')}`;
  if (!isValidDate(effective_date)) errors.effective_date = 'Enter a valid date';
  if (new_value === undefined || new_value === null || new_value === '') errors.new_value = 'Enter what it is now worth';
  if (Object.keys(errors).length) throw new ValidationError(errors);

  const asset = assets.getAsset(repo, assetId);
  if (asset.status === 'disposed') throw conflict(`${asset.asset_no} has been disposed of.`);
  if (asset.status === 'draft') {
    throw unprocessable(`${asset.asset_no} is not in service yet, so there is nothing to revalue — change its cost instead.`);
  }

  const plan = preview(repo, assetId, { new_value, effective_date, kind, remaining_life_months });
  if (plan.carrying_after < 0) {
    throw unprocessable('An asset cannot be worth less than nothing. To take it off the books entirely, dispose of it.');
  }
  if (plan.adjustment === 0) {
    throw unprocessable(`${asset.asset_no} is already carried at ${Money.format(plan.carrying_before, asset.currency)}, so there is nothing to change.`);
  }
  // Revaluing into a closed period would restate accounts already reported.
  const period = gl.periodForDate(repo, effective_date);
  if (!period || period.status !== 'open') {
    throw conflict(period ? `${period.name} is ${period.status}.` : `No accounting period covers ${effective_date}.`);
  }

  const assetAccount = repo.get('account', asset.asset_account_id);
  if (!assetAccount) throw unprocessable(`${asset.asset_no} has no asset account, so there is nothing to adjust.`);
  const reserveAccount = account(repo, RESERVE, 'Revaluation Reserve');
  const lossAccount = account(repo, LOSS, 'Impairment and Revaluation Loss');

  const id = ulid();
  const ref = nextNumber(repo, 'asset_revaluation');
  const up = plan.adjustment > 0;
  const lines = [
    {
      account_id: assetAccount.id,
      debit: up ? plan.adjustment : 0,
      credit: up ? 0 : -plan.adjustment,
      memo: `${kind === 'impairment' ? 'Impairment' : 'Revaluation'} of ${asset.asset_no}`,
    },
  ];
  if (plan.to_reserve !== 0) {
    lines.push({
      account_id: reserveAccount.id,
      debit: plan.to_reserve < 0 ? -plan.to_reserve : 0,
      credit: plan.to_reserve > 0 ? plan.to_reserve : 0,
      memo: plan.to_reserve > 0 ? 'Unrealised gain on revaluation' : 'Reversing the reserve this asset built up',
    });
  }
  if (plan.to_income !== 0) {
    lines.push({
      account_id: lossAccount.id,
      debit: plan.to_income < 0 ? -plan.to_income : 0,
      credit: plan.to_income > 0 ? plan.to_income : 0,
      memo: kind === 'impairment' ? 'Impairment loss' : 'Revaluation loss',
    });
  }

  const entry = gl.postJournal(repo, {
    subsidiary_id: asset.subsidiary_id,
    txn_date: effective_date,
    currency: asset.currency,
    memo: memo || `${asset.asset_no} ${asset.name} — ${kind}`,
    source_type: 'asset_revaluation', source_id: id,
    lines,
  });

  repo.insert('asset_revaluation', {
    id, reference: ref, asset_id: assetId, kind, effective_date,
    carrying_before: plan.carrying_before, carrying_after: plan.carrying_after,
    adjustment: plan.adjustment,
    to_reserve: plan.to_reserve, to_income: plan.to_income,
    remaining_life_months: plan.remaining_life_months,
    // An empty field in a form arrives as null, not as the default the
    // signature declares, and these columns are NOT NULL.
    reason: reason || '', memo: memo || '',
    journal_entry_id: entry.id, status: 'posted', reversed_at: null,
    created_at: nowIso(), created_by: repo.ctx?.user?.id || null,
  });

  repo.update('fixed_asset', assetId, {
    cost: asset.cost + plan.adjustment,
    revaluation_reserve: plan.reserve_after,
    // What this asset has been charged with and not yet had reversed. A loss
    // increases it; writing the value back up reduces it, which is what stops
    // the same loss being reversed through profit twice.
    impairment_total: Math.max(0, (asset.impairment_total || 0) - plan.to_income),
    last_revalued_on: effective_date,
    updated_at: nowIso(),
  });

  rebuildSchedule(repo, assetId, { from: effective_date, remaining: plan.remaining_life_months });

  audit.record(repo, {
    recordType: 'fixed_asset', recordId: assetId, action: kind,
    changes: {
      carrying: { from: Money.toNumber(plan.carrying_before), to: Money.toNumber(plan.carrying_after) },
      reference: { from: null, to: ref },
    },
  });
  return getRevaluation(repo, id);
}

/**
 * Rebuild what has not yet been charged.
 *
 * Posted lines are history and stay exactly as they are; only the future is
 * rewritten, spreading the new carrying amount over the life that is left.
 */
export function rebuildSchedule(repo, assetId, { from = today(), remaining = null } = {}) {
  const asset = assets.getAsset(repo, assetId);
  const posted = repo.scalar(
    'SELECT COALESCE(SUM(amount), 0) v FROM depreciation_line WHERE tenant_id = :t AND asset_id = ? AND posted = 1',
    [assetId], 0);
  const lastPostedNo = repo.scalar(
    'SELECT COALESCE(MAX(period_no), 0) v FROM depreciation_line WHERE tenant_id = :t AND asset_id = ? AND posted = 1',
    [assetId], 0);

  const months = remaining !== null && remaining !== undefined
    ? Number(remaining)
    : repo.scalar(
      'SELECT COUNT(*) c FROM depreciation_line WHERE tenant_id = :t AND asset_id = ? AND posted = 0',
      [assetId], 0);

  repo.exec('DELETE FROM depreciation_line WHERE tenant_id = :t AND asset_id = ? AND posted = 0', [assetId]);
  if (months <= 0) {
    repo.update('fixed_asset', assetId, { accumulated_depreciation: posted, updated_at: nowIso() });
    return { periods: 0, remaining_value: asset.cost - posted };
  }

  // Straight line over what is left, whatever the original method was: once a
  // value has been restated by judgement rather than by formula, carrying on
  // with a declining balance computed from the original cost would be
  // arithmetic pretending to be meaning.
  const base = Math.max(0, (asset.cost - posted) - (asset.salvage_value || 0));
  const each = Math.floor(base / months);
  const amounts = Array.from({ length: months }, (_, i) => (i === months - 1 ? base - each * (months - 1) : each));

  let accumulated = posted;
  amounts.forEach((amount, i) => {
    accumulated += amount;
    const when = endOfMonth(addMonths(from, i));
    const period = gl.periodForDate(repo, when);
    repo.insert('depreciation_line', {
      id: ulid(), asset_id: assetId, period_no: lastPostedNo + i + 1, depr_date: when,
      period_id: period?.id || null, amount, accumulated,
      book_value: asset.cost - accumulated, posted: 0, journal_entry_id: null,
    });
  });
  repo.update('fixed_asset', assetId, { accumulated_depreciation: posted, updated_at: nowIso() });
  return { periods: months, remaining_value: asset.cost - posted, monthly: each };
}

/** Undo one: reverse its entry and put the asset back where it was. */
export function reverseRevaluation(repo, id, { reason = '' } = {}) {
  const r = repo.get('asset_revaluation', id);
  if (!r) throw notFound('Revaluation not found');
  if (r.status === 'reversed') throw conflict(`${r.reference} has already been reversed.`);
  const later = repo.scalar(
    `SELECT COUNT(*) c FROM asset_revaluation WHERE tenant_id = :t AND asset_id = ?
     AND status = 'posted' AND created_at > ?`, [r.asset_id, r.created_at], 0);
  if (later) {
    throw conflict(`${r.reference} has been superseded by a later revaluation. Reverse that one first, or the asset would end up carried at a figure neither of them intended.`);
  }

  const asset = assets.getAsset(repo, r.asset_id);
  if (r.journal_entry_id) gl.reverseJournal(repo, r.journal_entry_id, { memo: `Reversal of ${r.reference}${reason ? ` — ${reason}` : ''}` });

  repo.update('fixed_asset', r.asset_id, {
    cost: asset.cost - r.adjustment,
    revaluation_reserve: (asset.revaluation_reserve || 0) - r.to_reserve,
    impairment_total: Math.max(0, (asset.impairment_total || 0) + r.to_income),
    updated_at: nowIso(),
  });
  repo.update('asset_revaluation', id, { status: 'reversed', reversed_at: nowIso() });
  rebuildSchedule(repo, r.asset_id, { from: r.effective_date, remaining: r.remaining_life_months });

  audit.record(repo, {
    recordType: 'fixed_asset', recordId: r.asset_id, action: 'reverse_revaluation',
    changes: { reference: { from: null, to: r.reference }, reason: { from: null, to: reason } },
  });
  return getRevaluation(repo, id);
}

// ------------------------------------------------------------- transfer
/**
 * Move an asset between the parts of the business that carry it.
 *
 * Between departments or locations this only changes whose charge it is from
 * now on. Between subsidiaries it is a real transaction -- one company's
 * balance sheet loses an asset and another's gains one -- so the value moves
 * with it, through the intercompany control accounts.
 */
export function transfer(repo, assetId, input = {}) {
  const {
    transfer_date = today(), to_subsidiary_id = null,
    to_location_id = null, to_department_id = null, reason = '',
  } = input;
  if (!isValidDate(transfer_date)) throw new ValidationError({ transfer_date: 'Enter a valid date' });

  const asset = assets.getAsset(repo, assetId);
  if (asset.status === 'disposed') throw conflict(`${asset.asset_no} has been disposed of.`);
  if (!to_subsidiary_id && !to_location_id && !to_department_id) {
    throw new ValidationError({ to_location_id: 'Choose somewhere to move it to' });
  }
  const changesSubsidiary = to_subsidiary_id && to_subsidiary_id !== asset.subsidiary_id;

  const id = ulid();
  let entryId = null;

  if (changesSubsidiary) {
    const state = carryingAmount(repo, assetId);
    const from = repo.get('subsidiary', asset.subsidiary_id);
    const to = repo.get('subsidiary', to_subsidiary_id);
    if (!to) throw notFound('Subsidiary not found');
    if (from.currency !== to.currency) {
      throw unprocessable(`${from.name} keeps its books in ${from.currency} and ${to.name} in ${to.currency}. Moving an asset between them has to be priced, so dispose of it in one and acquire it in the other.`);
    }
    const dueFrom = repo.queryOne("SELECT * FROM account WHERE tenant_id = :t AND number = '1190' AND active = 1");
    const dueTo = repo.queryOne("SELECT * FROM account WHERE tenant_id = :t AND number = '2190' AND active = 1");
    if (!dueFrom || !dueTo) throw unprocessable('Moving an asset between companies needs the affiliate control accounts 1190 and 2190.');

    const assetAccount = repo.get('account', asset.asset_account_id);
    const accumAccount = repo.get('account', asset.accum_account_id);
    if (!assetAccount || !accumAccount) throw unprocessable(`${asset.asset_no} has no asset or accumulated depreciation account.`);

    // Out of the old company at cost less what it has been depreciated by...
    const out = gl.postJournal(repo, {
      subsidiary_id: asset.subsidiary_id, txn_date: transfer_date, currency: asset.currency,
      memo: `${asset.asset_no} transferred to ${to.name}`,
      source_type: 'asset_transfer', source_id: id,
      lines: [
        { account_id: accumAccount.id, debit: state.depreciated, credit: 0, memo: 'Accumulated depreciation out' },
        { account_id: dueFrom.id, debit: state.carrying, credit: 0, memo: `Owed by ${to.name}` },
        { account_id: assetAccount.id, debit: 0, credit: asset.cost, memo: 'Asset out at cost' },
      ],
    });
    // ...and into the new one, carrying its history with it, because the
    // asset is the same age wherever it sits.
    gl.postJournal(repo, {
      subsidiary_id: to_subsidiary_id, txn_date: transfer_date, currency: asset.currency,
      memo: `${asset.asset_no} transferred from ${from.name}`,
      source_type: 'asset_transfer', source_id: id,
      lines: [
        { account_id: assetAccount.id, debit: asset.cost, credit: 0, memo: 'Asset in at cost' },
        { account_id: accumAccount.id, debit: 0, credit: state.depreciated, memo: 'Accumulated depreciation in' },
        { account_id: dueTo.id, debit: 0, credit: state.carrying, memo: `Owed to ${from.name}` },
      ],
    });
    entryId = out.id;
  }

  repo.insert('asset_transfer', {
    id, asset_id: assetId, transfer_date,
    from_subsidiary_id: asset.subsidiary_id, to_subsidiary_id: to_subsidiary_id || asset.subsidiary_id,
    from_location_id: asset.location_id, to_location_id: to_location_id || asset.location_id,
    from_department_id: asset.department_id, to_department_id: to_department_id || asset.department_id,
    reason: reason || '', journal_entry_id: entryId,
    created_at: nowIso(), created_by: repo.ctx?.user?.id || null,
  });

  repo.update('fixed_asset', assetId, {
    subsidiary_id: to_subsidiary_id || asset.subsidiary_id,
    location_id: to_location_id || asset.location_id,
    department_id: to_department_id || asset.department_id,
    updated_at: nowIso(),
  });

  audit.record(repo, {
    recordType: 'fixed_asset', recordId: assetId, action: 'transfer',
    changes: { subsidiary: { from: asset.subsidiary_id, to: to_subsidiary_id || asset.subsidiary_id } },
  });
  return { transfer: repo.get('asset_transfer', id), asset: assets.getAsset(repo, assetId) };
}

export const transfersFor = (repo, assetId) => repo.query(
  'SELECT * FROM asset_transfer WHERE tenant_id = :t AND asset_id = ? ORDER BY transfer_date DESC', [assetId]);
