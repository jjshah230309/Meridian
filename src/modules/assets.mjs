// Meridian ERP :: modules/assets
// Fixed asset register, depreciation and disposal.
//
// The schedule is generated once, when an asset is placed in service, and
// stored row per period. Running depreciation for a period posts the rows
// that fall in it and marks them; re-running is a no-op rather than a
// double charge. Rounding is absorbed by the final period so the schedule
// always sums to exactly (cost - salvage).
import { ulid, Money, isValidDate, today, addMonths, endOfMonth } from '../core/util.mjs';
import { ValidationError, unprocessable, notFound } from '../core/http.mjs';
import { nextNumber } from '../core/seq.mjs';
import * as gl from './gl.mjs';
import { postingAccounts } from './setup.mjs';
import * as audit from '../core/audit.mjs';

export const METHODS = ['STRAIGHT_LINE', 'DECLINING_BALANCE', 'SUM_OF_YEARS', 'UNITS_OF_PRODUCTION'];
export const STATUSES = ['draft', 'active', 'fully_depreciated', 'disposed'];

export const getAsset = (repo, id) => {
  const a = repo.get('fixed_asset', id);
  if (!a) throw notFound(`Asset ${id} not found`);
  return a;
};

/**
 * Depreciation amounts per period for the whole life, in minor units.
 * Returns an array of length `life_months` summing exactly to depreciable base.
 */
export function scheduleAmounts(asset) {
  const base = Math.max(0, (asset.cost || 0) - (asset.salvage_value || 0));
  const n = Math.max(1, asset.life_months || 1);
  if (base === 0) return new Array(n).fill(0);

  let raw;
  switch (asset.method) {
    case 'DECLINING_BALANCE': {
      // Declining balance on net book value, switching to straight line for
      // the remaining life once that yields more -- the convention that keeps
      // an asset from never quite reaching salvage value.
      const rate = (asset.declining_rate || 2) / n;
      raw = [];
      let remaining = base;
      for (let i = 0; i < n; i++) {
        const db = remaining * rate;
        const sl = remaining / (n - i);
        const amt = Math.min(remaining, Math.max(db, sl));
        raw.push(amt);
        remaining -= amt;
      }
      break;
    }
    case 'SUM_OF_YEARS': {
      const years = Math.max(1, Math.ceil(n / 12));
      const denom = (years * (years + 1)) / 2;
      raw = [];
      for (let i = 0; i < n; i++) {
        const yearIndex = Math.floor(i / 12);
        const yearShare = (years - yearIndex) / denom;
        const monthsThisYear = Math.min(12, n - yearIndex * 12);
        raw.push((base * yearShare) / monthsThisYear);
      }
      break;
    }
    case 'UNITS_OF_PRODUCTION':
      // Without a usage reading the schedule is a straight-line estimate;
      // `recordUsage` replaces the open rows once actual units are known.
      raw = new Array(n).fill(base / n);
      break;
    case 'STRAIGHT_LINE':
    default:
      raw = new Array(n).fill(base / n);
  }

  // Distribute to whole minor units, giving the rounding remainder to the
  // last period so the schedule totals the depreciable base exactly.
  const out = raw.map((v) => Math.trunc(v));
  const drift = base - out.reduce((a, b) => a + b, 0);
  out[out.length - 1] += drift;
  return out;
}

export function createAsset(repo, input, actor) {
  const errors = {};
  if (!input.name) errors.name = 'Name is required';
  if (!input.subsidiary_id) errors.subsidiary_id = 'Subsidiary is required';
  if (!isValidDate(input.acquisition_date)) errors.acquisition_date = 'A valid acquisition date is required';
  if (input.method && !METHODS.includes(input.method)) errors.method = `Method must be one of ${METHODS.join(', ')}`;
  const cost = Money.parse(input.cost);
  if (cost <= 0) errors.cost = 'Cost must be greater than zero';
  const salvage = Money.parse(input.salvage_value);
  if (salvage < 0) errors.salvage_value = 'Salvage value cannot be negative';
  if (salvage >= cost) errors.salvage_value = 'Salvage value must be below cost';
  if (Object.keys(errors).length) throw new ValidationError(errors);

  const cls = input.class_id ? repo.get('asset_class', input.class_id) : null;
  const now = new Date().toISOString();
  const id = ulid();
  const row = {
    id,
    asset_no: input.asset_no || nextNumber(repo, 'fixed_asset'),
    name: input.name,
    description: input.description || '',
    class_id: input.class_id || null,
    subsidiary_id: input.subsidiary_id,
    location_id: input.location_id || null,
    department_id: input.department_id || null,
    serial_no: input.serial_no || '',
    supplier_id: input.supplier_id || null,
    source_txn_id: input.source_txn_id || null,
    currency: input.currency || gl.subsidiaryCurrency(repo, input.subsidiary_id),
    acquisition_date: input.acquisition_date,
    in_service_date: input.in_service_date || null,
    cost,
    salvage_value: salvage || (cls ? Money.pct(cost, cls.salvage_pct) : 0),
    method: input.method || cls?.method || 'STRAIGHT_LINE',
    life_months: Number(input.life_months || cls?.life_months || 60),
    declining_rate: Number(input.declining_rate || cls?.declining_rate || 2),
    total_units: Number(input.total_units || 0),
    units_used: 0,
    asset_account_id: input.asset_account_id || cls?.asset_account_id || null,
    accum_account_id: input.accum_account_id || cls?.accum_account_id || null,
    expense_account_id: input.expense_account_id || cls?.expense_account_id || null,
    accumulated_depreciation: 0,
    status: 'draft',
    disposal_date: null, disposal_proceeds: 0, disposal_entry_id: null,
    custom: input.custom || {},
    created_at: now, updated_at: now,
  };
  repo.insert('fixed_asset', row);
  audit.record(repo, { recordType: 'fixed_asset', recordId: id, action: 'create', after: row });
  return getAsset(repo, id);
}

/** Place an asset in service and lay down its full depreciation schedule. */
export function placeInService(repo, id, { in_service_date = null } = {}) {
  const asset = getAsset(repo, id);
  if (asset.status !== 'draft') throw unprocessable(`${asset.asset_no} is already ${asset.status}`);
  const start = in_service_date || asset.in_service_date || asset.acquisition_date;
  if (!isValidDate(start)) throw new ValidationError({ in_service_date: 'A valid in-service date is required' });
  for (const field of ['asset_account_id', 'accum_account_id', 'expense_account_id']) {
    if (!asset[field]) {
      throw new ValidationError({ [field]: 'Asset, accumulated depreciation and expense accounts are all required before an asset can be depreciated' });
    }
  }

  const amounts = scheduleAmounts({ ...asset, in_service_date: start });
  let accumulated = 0;
  repo.exec('DELETE FROM depreciation_line WHERE tenant_id = :t AND asset_id = ? AND posted = 0', [id]);
  amounts.forEach((amount, i) => {
    accumulated += amount;
    const when = endOfMonth(addMonths(start, i));
    const period = gl.periodForDate(repo, when);
    repo.insert('depreciation_line', {
      id: ulid(), asset_id: id, period_no: i + 1, depr_date: when,
      period_id: period?.id || null, amount, accumulated,
      book_value: asset.cost - accumulated, posted: 0, journal_entry_id: null,
    });
  });
  repo.update('fixed_asset', id, { in_service_date: start, status: 'active', updated_at: new Date().toISOString() });
  audit.record(repo, { recordType: 'fixed_asset', recordId: id, action: 'place_in_service', changes: { in_service_date: { from: asset.in_service_date, to: start } } });
  return { asset: getAsset(repo, id), periods: amounts.length, total: accumulated };
}

export const scheduleFor = (repo, assetId) =>
  repo.query('SELECT * FROM depreciation_line WHERE tenant_id = :t AND asset_id = ? ORDER BY period_no', [assetId]);

/** Everything not yet posted with a depreciation date on or before `through`. */
export const dueDepreciation = (repo, through = today()) =>
  repo.query(`SELECT d.*, a.asset_no, a.name AS asset_name, a.subsidiary_id, a.currency,
                     a.expense_account_id, a.accum_account_id, a.department_id, a.location_id
              FROM depreciation_line d JOIN fixed_asset a ON a.tenant_id = d.tenant_id AND a.id = d.asset_id
              WHERE d.tenant_id = :t AND d.posted = 0 AND d.depr_date <= ? AND a.status = 'active'
              ORDER BY d.depr_date, a.asset_no`, [through]);

/**
 * Post depreciation for everything due on or before `through`.
 * One journal entry per subsidiary per date keeps the GL readable instead of
 * producing an entry per asset.
 */
export function runDepreciation(repo, { through = today(), dry_run = false } = {}) {
  const due = dueDepreciation(repo, through);
  if (!due.length) return { posted: 0, entries: [], total: 0, lines: [] };

  const groups = new Map();
  for (const d of due) {
    const key = `${d.subsidiary_id}|${d.depr_date}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  if (dry_run) {
    return {
      posted: 0, dry_run: true, entries: [],
      total: due.reduce((a, d) => a + d.amount, 0),
      lines: due.map((d) => ({ asset_no: d.asset_no, name: d.asset_name, date: d.depr_date, amount: Money.toNumber(d.amount) })),
    };
  }

  const entries = [];
  const deferred = [];
  let total = 0;
  for (const [key, rows] of groups) {
    const [subsidiary_id, depr_date] = key.split('|');
    const amount = rows.reduce((a, r) => a + r.amount, 0);
    if (amount === 0) continue;

    // An asset bought before the books were opened, or one whose period has
    // since been closed, has charges with nowhere to go. Set those aside and
    // say so rather than failing the whole run over one month.
    const period = gl.periodForDate(repo, depr_date);
    if (!period || period.status !== 'open') {
      deferred.push({
        date: depr_date, assets: rows.length, amount: Money.toNumber(amount),
        reason: period ? `${period.name} is ${period.status}` : 'no accounting period covers this date',
      });
      continue;
    }

    // Collapse to one debit per expense account and one credit per accumulated
    // account, so a hundred assets do not produce a two-hundred-line entry.
    const byExpense = new Map();
    const byAccum = new Map();
    for (const r of rows) {
      byExpense.set(r.expense_account_id, (byExpense.get(r.expense_account_id) || 0) + r.amount);
      byAccum.set(r.accum_account_id, (byAccum.get(r.accum_account_id) || 0) + r.amount);
    }
    const lines = [
      ...[...byExpense].map(([account_id, v]) => ({ account_id, debit: v, credit: 0, memo: 'Depreciation' })),
      ...[...byAccum].map(([account_id, v]) => ({ account_id, debit: 0, credit: v, memo: 'Accumulated depreciation' })),
    ];
    // Each subsidiary/date group is its own transaction, so one group failing
    // (an account made inactive since the schedule was set up, say) cannot
    // roll back groups this same run already posted.
    const entry = repo.tx(() => {
      const e = gl.postJournal(repo, {
        subsidiary_id, txn_date: depr_date,
        memo: `Depreciation — ${rows.length} asset${rows.length === 1 ? '' : 's'}`,
        source_type: 'depreciation', source_id: null, lines,
      });
      for (const r of rows) {
        repo.update('depreciation_line', r.id, { posted: 1, journal_entry_id: e.id });
        const asset = getAsset(repo, r.asset_id);
        const accum = asset.accumulated_depreciation + r.amount;
        const done = accum >= asset.cost - asset.salvage_value;
        repo.update('fixed_asset', r.asset_id, {
          accumulated_depreciation: accum,
          status: done ? 'fully_depreciated' : asset.status,
          updated_at: new Date().toISOString(),
        });
      }
      return e;
    });
    entries.push({ id: entry.id, entry_no: entry.entry_no, date: depr_date, subsidiary_id, amount: Money.toNumber(amount), assets: rows.length });
    total += amount;
  }
  return { posted: entries.length, entries, total: Money.toNumber(total), lines: [], deferred };
}

/**
 * Dispose of an asset: clear cost and accumulated depreciation, recognise
 * proceeds, and book the difference as a gain or loss.
 */
export function disposeAsset(repo, id, { disposal_date = today(), proceeds = 0, cash_account_id = null, gain_loss_account_id = null, memo = '' } = {}) {
  const asset = getAsset(repo, id);
  if (asset.status === 'disposed') throw unprocessable(`${asset.asset_no} is already disposed`);
  if (!isValidDate(disposal_date)) throw new ValidationError({ disposal_date: 'A valid disposal date is required' });
  const cash = Money.parse(proceeds);
  const acc = postingAccounts(repo);
  // The money lands in the operating bank account unless told otherwise --
  // the same default every other cash-touching posting uses. Refusing the
  // disposal because nobody named an account was friction, not safety.
  const cashAccount = cash_account_id || acc.bank || gl.accountBySubtype(repo, 'BANK')?.id;
  if (cash > 0 && !cashAccount) throw new ValidationError({ cash_account_id: 'An account is required to receive the proceeds' });

  const accum = asset.accumulated_depreciation;
  const bookValue = asset.cost - accum;
  const gain = cash - bookValue;                 // positive = gain, negative = loss
  // The class's own "gain / loss on disposal" account first -- it is on the
  // form and somebody filled it in. Falling through to the first OTHER_INCOME
  // account in the chart put the profit on selling a van into Shipping Income.
  const cls = asset.class_id ? repo.get('asset_class', asset.class_id) : null;
  const gainAccount = gain_loss_account_id
    || cls?.disposal_account_id
    || acc.asset_disposal
    || gl.accountBySubtype(repo, 'OTHER_EXPENSE')?.id;
  if (gain !== 0 && !gainAccount) {
    throw new ValidationError({ gain_loss_account_id: 'An account is required for the gain or loss on disposal' });
  }

  const lines = [
    { account_id: asset.accum_account_id, debit: accum, credit: 0, memo: 'Clear accumulated depreciation' },
    cash > 0 && { account_id: cashAccount, debit: cash, credit: 0, memo: 'Disposal proceeds' },
    { account_id: asset.asset_account_id, debit: 0, credit: asset.cost, memo: 'Remove asset at cost' },
    gain > 0 && { account_id: gainAccount, debit: 0, credit: gain, memo: 'Gain on disposal' },
    gain < 0 && { account_id: gainAccount, debit: -gain, credit: 0, memo: 'Loss on disposal' },
  ].filter(Boolean);

  const entry = gl.postJournal(repo, {
    subsidiary_id: asset.subsidiary_id, txn_date: disposal_date, currency: asset.currency,
    memo: memo || `Disposal of ${asset.asset_no} ${asset.name}`,
    source_type: 'asset_disposal', source_id: id, lines,
  });

  repo.exec('DELETE FROM depreciation_line WHERE tenant_id = :t AND asset_id = ? AND posted = 0', [id]);
  repo.update('fixed_asset', id, {
    status: 'disposed', disposal_date, disposal_proceeds: cash,
    disposal_entry_id: entry.id, updated_at: new Date().toISOString(),
  });
  audit.record(repo, { recordType: 'fixed_asset', recordId: id, action: 'dispose', changes: { status: { from: asset.status, to: 'disposed' }, proceeds: { from: 0, to: Money.toNumber(cash) } } });
  return { asset: getAsset(repo, id), entry_id: entry.id, entry_no: entry.entry_no, book_value: Money.toNumber(bookValue), gain: Money.toNumber(gain) };
}

/** The register: cost, accumulated depreciation and net book value by class. */
export function register(repo, { as_of = today(), subsidiary_id = null, include_disposed = false } = {}) {
  const params = [as_of];
  let where = "a.tenant_id = :t AND a.acquisition_date <= ?";
  if (!include_disposed) where += " AND a.status != 'disposed'";
  if (subsidiary_id) { where += ' AND a.subsidiary_id = ?'; params.push(subsidiary_id); }

  const rows = repo.query(`
    SELECT a.*, c.name AS class_name,
           (SELECT COALESCE(SUM(d.amount), 0) FROM depreciation_line d
             WHERE d.tenant_id = a.tenant_id AND d.asset_id = a.id AND d.posted = 1 AND d.depr_date <= ?) AS depr_to_date
    FROM fixed_asset a LEFT JOIN asset_class c ON c.tenant_id = a.tenant_id AND c.id = a.class_id
    WHERE ${where} ORDER BY c.name, a.asset_no`, [as_of, ...params]);

  const assets = rows.map((r) => ({
    id: r.id, asset_no: r.asset_no, name: r.name, class_name: r.class_name || 'Unclassified',
    status: r.status, in_service_date: r.in_service_date, method: r.method, life_months: r.life_months,
    cost: Money.toNumber(r.cost), accumulated: Money.toNumber(r.depr_to_date),
    net_book_value: Money.toNumber(r.cost - r.depr_to_date),
  }));
  const byClass = new Map();
  for (const a of assets) {
    const g = byClass.get(a.class_name) || { class_name: a.class_name, count: 0, cost: 0, accumulated: 0, net_book_value: 0 };
    g.count++; g.cost += a.cost; g.accumulated += a.accumulated; g.net_book_value += a.net_book_value;
    byClass.set(a.class_name, g);
  }
  return {
    as_of, assets, by_class: [...byClass.values()],
    totals: {
      count: assets.length,
      cost: assets.reduce((s, a) => s + a.cost, 0),
      accumulated: assets.reduce((s, a) => s + a.accumulated, 0),
      net_book_value: assets.reduce((s, a) => s + a.net_book_value, 0),
    },
  };
}
