// Meridian ERP :: api_ops
// REST routes for the operational modules -- assets, budgeting,
// consolidation, projects, manufacturing, warehousing, planning, service,
// commerce and workforce.
//
// Kept out of api.mjs so that file stays about the platform (auth, generic
// records, search, saved searches) rather than growing a section per domain.
// Registration is a single call from buildApi, and every route follows the
// same shape: check the permission, do the work in the module, return JSON.
import * as rbac from './core/rbac.mjs';
import { badRequest, rowList } from './core/http.mjs';
import { today, addDays } from './core/util.mjs';
import * as assets from './modules/assets.mjs';
import * as schedules from './modules/schedules.mjs';
import * as recurring from './modules/recurring.mjs';
import * as revaluation from './modules/revaluation.mjs';
import * as collections from './modules/collections.mjs';
import * as payruns from './modules/payruns.mjs';
import * as tax from './modules/tax.mjs';
import * as allocations from './modules/allocations.mjs';
import * as costing from './modules/costing.mjs';
import * as deposits from './modules/deposits.mjs';
import * as subs from './modules/subscriptions.mjs';
import * as budget from './modules/budget.mjs';
import * as consolidation from './modules/consolidation.mjs';
import * as intercompany from './modules/intercompany.mjs';
import * as customRecords from './modules/customrecords.mjs';
import * as assetValue from './modules/assetvalue.mjs';
import * as books from './modules/books.mjs';
import * as projects from './modules/projects.mjs';
import * as mfg from './modules/manufacturing.mjs';
import * as wh from './modules/warehouse.mjs';
import * as planning from './modules/planning.mjs';
import * as service from './modules/service.mjs';
import * as commerce from './modules/commerce.mjs';
import * as workforce from './modules/workforce.mjs';

const LEVEL = rbac.LEVEL;
const int = (v, d = 0) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const bool = (v, d = false) => (v === undefined ? d : v === true || v === 'true' || v === '1');

export function registerOpsRoutes(r, P) {
  // ==================================================== fixed assets
  r.get(`${P}/assets/register`, async (ctx) => {
    rbac.require$(ctx.access, 'fixed_asset', LEVEL.VIEW);
    return assets.register(ctx.repo, {
      as_of: ctx.query.as_of || today(),
      subsidiary_id: ctx.query.subsidiary_id || null,
      include_disposed: bool(ctx.query.include_disposed),
    });
  });
  r.post(`${P}/assets`, async (ctx) => {
    rbac.require$(ctx.access, 'fixed_asset', LEVEL.CREATE);
    return ctx.tx(() => assets.createAsset(ctx.repo, ctx.body || {}));
  });
  r.get(`${P}/assets/:id/schedule`, async (ctx) => {
    rbac.require$(ctx.access, 'fixed_asset', LEVEL.VIEW);
    return { asset: assets.getAsset(ctx.repo, ctx.params.id), schedule: assets.scheduleFor(ctx.repo, ctx.params.id) };
  });
  r.post(`${P}/assets/:id/place-in-service`, async (ctx) => {
    rbac.require$(ctx.access, 'fixed_asset', LEVEL.EDIT);
    return ctx.tx(() => assets.placeInService(ctx.repo, ctx.params.id, ctx.body || {}));
  });
  r.post(`${P}/assets/:id/dispose`, async (ctx) => {
    rbac.require$(ctx.access, 'fixed_asset', LEVEL.EDIT);
    return ctx.tx(() => assets.disposeAsset(ctx.repo, ctx.params.id, ctx.body || {}));
  });
  r.get(`${P}/assets/depreciation/due`, async (ctx) => {
    rbac.require$(ctx.access, 'fixed_asset', LEVEL.VIEW);
    return { due: assets.dueDepreciation(ctx.repo, ctx.query.through || today()) };
  });
  r.post(`${P}/assets/depreciation/run`, async (ctx) => {
    rbac.require$(ctx.access, 'fixed_asset', LEVEL.EDIT);
    const body = ctx.body || {};
    if (body.dry_run) return assets.runDepreciation(ctx.repo, { through: body.through || today(), dry_run: true });
    return ctx.tx(() => assets.runDepreciation(ctx.repo, { through: body.through || today() }));
  });

  // ---------------------------------------- revenue recognition & amortisation
  r.get(`${P}/schedules`, async (ctx) => {
    rbac.require$(ctx.access, 'schedule', LEVEL.VIEW);
    return schedules.list(ctx.repo, {
      kind: ctx.query.kind || null, status: ctx.query.status || 'active',
      limit: Number(ctx.query.limit) || 200, offset: Number(ctx.query.offset) || 0,
    });
  });
  r.get(`${P}/schedules/waterfall`, async (ctx) => {
    rbac.require$(ctx.access, 'schedule', LEVEL.VIEW);
    return schedules.waterfall(ctx.repo, {
      kind: ctx.query.kind || 'revenue', from: ctx.query.from || null,
      months: Number(ctx.query.months) || 12, subsidiary_id: ctx.query.subsidiary_id || null,
    });
  });
  r.get(`${P}/schedules/due`, async (ctx) => {
    rbac.require$(ctx.access, 'schedule', LEVEL.VIEW);
    return { rows: schedules.due(ctx.repo, { kind: ctx.query.kind || null, through: ctx.query.through || today() }) };
  });
  r.get(`${P}/schedules/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'schedule', LEVEL.VIEW);
    return schedules.getSchedule(ctx.repo, ctx.params.id);
  });
  r.post(`${P}/schedules/run`, async (ctx) => {
    rbac.require$(ctx.access, 'schedule', LEVEL.EDIT);
    const body = ctx.body || {};
    const opts = { kind: body.kind || 'revenue', through: body.through || today(), memo: body.memo || '' };
    if (body.dry_run) return schedules.runRecognition(ctx.repo, { ...opts, dry_run: true });
    return ctx.tx(() => schedules.runRecognition(ctx.repo, opts));
  });
  r.post(`${P}/schedules/:id/release`, async (ctx) => {
    rbac.require$(ctx.access, 'schedule', LEVEL.EDIT);
    return ctx.tx(() => schedules.releaseHeld(ctx.repo, ctx.params.id, {
      plan_date: ctx.body?.plan_date || today(), line_id: ctx.body?.line_id || null,
    }));
  });

  // ------------------------------------------- recurring journals & accruals
  r.get(`${P}/recurring`, async (ctx) => {
    rbac.require$(ctx.access, 'recurring_journal', LEVEL.VIEW);
    return recurring.list(ctx.repo, { status: ctx.query.status || null });
  });
  r.get(`${P}/recurring/due`, async (ctx) => {
    rbac.require$(ctx.access, 'recurring_journal', LEVEL.VIEW);
    const through = ctx.query.through || today();
    return { through, rows: recurring.due(ctx.repo, { through }) };
  });
  r.get(`${P}/recurring/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'recurring_journal', LEVEL.VIEW);
    return {
      recurring: recurring.getRecurring(ctx.repo, ctx.params.id),
      history: recurring.historyFor(ctx.repo, ctx.params.id),
    };
  });
  r.post(`${P}/recurring`, async (ctx) => {
    rbac.require$(ctx.access, 'recurring_journal', LEVEL.CREATE);
    return ctx.tx(() => recurring.createRecurring(ctx.repo, ctx.body || {}));
  });
  r.put(`${P}/recurring/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'recurring_journal', LEVEL.EDIT);
    return ctx.tx(() => recurring.updateRecurring(ctx.repo, ctx.params.id, ctx.body || {}));
  });
  r.post(`${P}/recurring/:id/status`, async (ctx) => {
    rbac.require$(ctx.access, 'recurring_journal', LEVEL.EDIT);
    return ctx.tx(() => recurring.setStatus(ctx.repo, ctx.params.id, ctx.body?.status));
  });
  r.post(`${P}/recurring/run`, async (ctx) => {
    rbac.require$(ctx.access, 'recurring_journal', LEVEL.EDIT);
    const body = ctx.body || {};
    const opts = { through: body.through || today(), id: body.id || null };
    if (body.dry_run) return recurring.generate(ctx.repo, { ...opts, dry_run: true });
    return ctx.tx(() => recurring.generate(ctx.repo, opts));
  });

  // ------------------------------------------ foreign currency revaluation
  r.get(`${P}/revaluation/exposures`, async (ctx) => {
    rbac.require$(ctx.access, 'revaluation_run', LEVEL.VIEW);
    return revaluation.exposures(ctx.repo, {
      as_of: ctx.query.as_of || today(),
      subsidiary_id: ctx.query.subsidiary_id || null,
      scopes: ctx.query.scopes ? String(ctx.query.scopes).split(',') : revaluation.SCOPES,
    });
  });
  r.get(`${P}/revaluation/runs`, async (ctx) => {
    rbac.require$(ctx.access, 'revaluation_run', LEVEL.VIEW);
    return { rows: revaluation.history(ctx.repo, { subsidiary_id: ctx.query.subsidiary_id || null, limit: int(ctx.query.limit, 24) }) };
  });
  r.get(`${P}/revaluation/runs/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'revaluation_run', LEVEL.VIEW);
    return revaluation.getRun(ctx.repo, ctx.params.id);
  });
  r.post(`${P}/revaluation/run`, async (ctx) => {
    rbac.require$(ctx.access, 'revaluation_run', LEVEL.EDIT);
    const body = ctx.body || {};
    const opts = {
      as_of: body.as_of || today(), subsidiary_id: body.subsidiary_id || null,
      scopes: Array.isArray(body.scopes) && body.scopes.length ? body.scopes : revaluation.SCOPES,
      memo: body.memo || '',
    };
    if (body.dry_run) return revaluation.run(ctx.repo, { ...opts, dry_run: true });
    return ctx.tx(() => revaluation.run(ctx.repo, opts));
  });
  r.post(`${P}/revaluation/runs/:id/reverse`, async (ctx) => {
    rbac.require$(ctx.access, 'revaluation_run', LEVEL.EDIT);
    return ctx.tx(() => revaluation.reverseRun(ctx.repo, ctx.params.id, { reason: ctx.body?.reason || '' }));
  });

  // ============================================== accounts receivable collections
  r.get(`${P}/collections/worklist`, async (ctx) => {
    rbac.require$(ctx.access, 'collections', LEVEL.VIEW);
    return collections.worklist(ctx.repo, {
      as_of: ctx.query.as_of || today(),
      collector_id: ctx.query.collector_id || null,
      subsidiary_id: ctx.query.subsidiary_id || null,
      min_days: int(ctx.query.min_days, 1),
      include_current: bool(ctx.query.include_current),
    });
  });
  r.get(`${P}/collections/statement/:customerId`, async (ctx) => {
    rbac.require$(ctx.access, 'collections', LEVEL.VIEW);
    return collections.statement(ctx.repo, ctx.params.customerId, {
      as_of: ctx.query.as_of || today(),
      from: ctx.query.from || null,
      kind: ctx.query.kind === 'activity' ? 'activity' : 'open_item',
    });
  });
  r.get(`${P}/collections/statement/:customerId/pdf`, async (ctx) => {
    rbac.require$(ctx.access, 'collections', LEVEL.VIEW);
    const opts = {
      as_of: ctx.query.as_of || today(),
      from: ctx.query.from || null,
      kind: ctx.query.kind === 'activity' ? 'activity' : 'open_item',
    };
    const customer = ctx.repo.get('customer', ctx.params.customerId);
    return {
      __body: collections.statementPdf(ctx.repo, ctx.params.customerId, opts),
      __contentType: 'application/pdf',
      __filename: `statement-${(customer?.entity_no || 'customer').toLowerCase()}-${opts.as_of}.pdf`,
    };
  });
  r.post(`${P}/collections/customers/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'collections', LEVEL.EDIT);
    return ctx.tx(() => collections.updateCollectionState(ctx.repo, ctx.params.id, ctx.body || {}));
  });

  r.get(`${P}/collections/policies`, async (ctx) => {
    rbac.require$(ctx.access, 'dunning_policy', LEVEL.VIEW);
    return { rows: collections.policies(ctx.repo) };
  });
  r.get(`${P}/collections/policies/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'dunning_policy', LEVEL.VIEW);
    return collections.getPolicy(ctx.repo, ctx.params.id);
  });
  r.post(`${P}/collections/policies`, async (ctx) => {
    rbac.require$(ctx.access, 'dunning_policy', LEVEL.CREATE);
    return ctx.tx(() => collections.createPolicy(ctx.repo, ctx.body || {}));
  });
  r.put(`${P}/collections/policies/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'dunning_policy', LEVEL.EDIT);
    return ctx.tx(() => collections.updatePolicy(ctx.repo, ctx.params.id, ctx.body || {}));
  });

  r.get(`${P}/collections/dunning/candidates`, async (ctx) => {
    rbac.require$(ctx.access, 'dunning_notice', LEVEL.VIEW);
    return collections.dunningCandidates(ctx.repo, {
      as_of: ctx.query.as_of || today(),
      policy_id: ctx.query.policy_id || null,
      subsidiary_id: ctx.query.subsidiary_id || null,
    });
  });
  r.post(`${P}/collections/dunning/run`, async (ctx) => {
    rbac.require$(ctx.access, 'dunning_notice', LEVEL.CREATE);
    const body = ctx.body || {};
    const opts = {
      as_of: body.as_of || today(), policy_id: body.policy_id || null,
      customer_ids: Array.isArray(body.customer_ids) && body.customer_ids.length ? body.customer_ids : null,
      subsidiary_id: body.subsidiary_id || null,
    };
    if (body.dry_run) return collections.runDunning(ctx.repo, { ...opts, dry_run: true });
    return ctx.tx(() => collections.runDunning(ctx.repo, opts));
  });
  r.get(`${P}/collections/notices`, async (ctx) => {
    rbac.require$(ctx.access, 'dunning_notice', LEVEL.VIEW);
    return { rows: collections.noticeHistory(ctx.repo, { customer_id: ctx.query.customer_id || null, limit: int(ctx.query.limit, 50) }) };
  });
  r.get(`${P}/collections/notices/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'dunning_notice', LEVEL.VIEW);
    return collections.getNotice(ctx.repo, ctx.params.id);
  });
  r.get(`${P}/collections/notices/:id/pdf`, async (ctx) => {
    rbac.require$(ctx.access, 'dunning_notice', LEVEL.VIEW);
    const notice = collections.getNotice(ctx.repo, ctx.params.id);
    return {
      __body: collections.noticePdf(ctx.repo, ctx.params.id),
      __contentType: 'application/pdf',
      __filename: `${notice.notice_no.toLowerCase()}.pdf`,
    };
  });
  r.post(`${P}/collections/notices/:id/cancel`, async (ctx) => {
    rbac.require$(ctx.access, 'dunning_notice', LEVEL.EDIT);
    return ctx.tx(() => collections.cancelNotice(ctx.repo, ctx.params.id, { reason: ctx.body?.reason || '' }));
  });

  r.post(`${P}/collections/write-off/:txnId`, async (ctx) => {
    rbac.require$(ctx.access, 'collections', LEVEL.EDIT);
    const body = ctx.body || {};
    return ctx.tx(() => collections.writeOff(ctx.repo, ctx.params.txnId, {
      amount: body.amount ?? null, as_of: body.as_of || today(),
      reason: body.reason || '', use_allowance: bool(body.use_allowance),
    }));
  });
  r.post(`${P}/collections/allowance`, async (ctx) => {
    const body = ctx.body || {};
    rbac.require$(ctx.access, 'collections', body.dry_run ? LEVEL.VIEW : LEVEL.EDIT);
    const opts = {
      as_of: body.as_of || today(),
      matrix: Array.isArray(body.matrix) && body.matrix.length ? body.matrix : collections.DEFAULT_MATRIX,
      subsidiary_id: body.subsidiary_id || null, memo: body.memo || '',
    };
    if (body.dry_run) return collections.allowance(ctx.repo, { ...opts, dry_run: true });
    return ctx.tx(() => collections.allowance(ctx.repo, opts));
  });

  // ================================================= paying the suppliers
  r.get(`${P}/payment-runs`, async (ctx) => {
    rbac.require$(ctx.access, 'payment_run', LEVEL.VIEW);
    return {
      rows: payruns.history(ctx.repo, { status: ctx.query.status || null, limit: int(ctx.query.limit, 30) }),
      due: payruns.dueSummary(ctx.repo, {
        pay_through: ctx.query.pay_through || today(),
        subsidiary_id: ctx.query.subsidiary_id || null,
      }),
    };
  });
  r.get(`${P}/payment-runs/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'payment_run', LEVEL.VIEW);
    return payruns.getRun(ctx.repo, ctx.params.id);
  });
  r.post(`${P}/payment-runs`, async (ctx) => {
    rbac.require$(ctx.access, 'payment_run', LEVEL.CREATE);
    return ctx.tx(() => payruns.proposeRun(ctx.repo, ctx.body || {}));
  });
  r.put(`${P}/payment-runs/:id/lines`, async (ctx) => {
    rbac.require$(ctx.access, 'payment_run', LEVEL.EDIT);
    return ctx.tx(() => payruns.updateLines(ctx.repo, ctx.params.id, rowList(ctx.body?.lines, 'lines')));
  });
  r.post(`${P}/payment-runs/:id/pay`, async (ctx) => {
    rbac.require$(ctx.access, 'payment_run', LEVEL.EDIT);
    rbac.require$(ctx.access, 'vendor_payment', LEVEL.CREATE);
    return ctx.tx(() => payruns.commitRun(ctx.repo, ctx.params.id, { payment_date: ctx.body?.payment_date || null }));
  });
  r.post(`${P}/payment-runs/:id/cancel`, async (ctx) => {
    rbac.require$(ctx.access, 'payment_run', LEVEL.EDIT);
    return ctx.tx(() => payruns.cancelRun(ctx.repo, ctx.params.id, { reason: ctx.body?.reason || '' }));
  });
  r.get(`${P}/payment-runs/:id/remittance/:vendorId`, async (ctx) => {
    rbac.require$(ctx.access, 'payment_run', LEVEL.VIEW);
    const vendor = ctx.repo.get('vendor', ctx.params.vendorId);
    return {
      __body: payruns.remittancePdf(ctx.repo, ctx.params.id, ctx.params.vendorId),
      __contentType: 'application/pdf',
      __filename: `remittance-${(vendor?.entity_no || 'supplier').toLowerCase()}.pdf`,
    };
  });
  r.get(`${P}/payment-runs/:id/file`, async (ctx) => {
    rbac.require$(ctx.access, 'payment_run', LEVEL.VIEW);
    const file = payruns.paymentFile(ctx.repo, ctx.params.id);
    return { __body: file.text, __contentType: file.contentType, __filename: file.filename };
  });

  // ============================================ sales tax returns and 1099s
  r.get(`${P}/tax/returns`, async (ctx) => {
    rbac.require$(ctx.access, 'tax_return', LEVEL.VIEW);
    return { rows: tax.history(ctx.repo, { limit: int(ctx.query.limit, 24) }) };
  });
  r.get(`${P}/tax/returns/preview`, async (ctx) => {
    rbac.require$(ctx.access, 'tax_return', LEVEL.VIEW);
    return tax.computeReturn(ctx.repo, {
      period_from: ctx.query.period_from, period_to: ctx.query.period_to,
      subsidiary_id: ctx.query.subsidiary_id || null, country: ctx.query.country || null,
    });
  });
  r.get(`${P}/tax/returns/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'tax_return', LEVEL.VIEW);
    return tax.getReturn(ctx.repo, ctx.params.id);
  });
  r.get(`${P}/tax/returns/:id/pdf`, async (ctx) => {
    rbac.require$(ctx.access, 'tax_return', LEVEL.VIEW);
    const ret = tax.getReturn(ctx.repo, ctx.params.id);
    return {
      __body: tax.returnPdf(ctx.repo, ctx.params.id),
      __contentType: 'application/pdf',
      __filename: `${ret.return_no.toLowerCase()}.pdf`,
    };
  });
  r.post(`${P}/tax/returns`, async (ctx) => {
    rbac.require$(ctx.access, 'tax_return', LEVEL.CREATE);
    return ctx.tx(() => tax.fileReturn(ctx.repo, ctx.body || {}));
  });
  r.post(`${P}/tax/returns/:id/unfile`, async (ctx) => {
    rbac.require$(ctx.access, 'tax_return', LEVEL.FULL);
    return ctx.tx(() => tax.unfileReturn(ctx.repo, ctx.params.id, { reason: ctx.body?.reason || '' }));
  });

  r.get(`${P}/tax/1099`, async (ctx) => {
    rbac.require$(ctx.access, 'tax_return', LEVEL.VIEW);
    return tax.report1099(ctx.repo, {
      year: ctx.query.year || new Date().getUTCFullYear(),
      subsidiary_id: ctx.query.subsidiary_id || null,
      threshold: ctx.query.threshold === undefined ? tax.REPORTING_THRESHOLD : Number(ctx.query.threshold),
      include_below: bool(ctx.query.include_below),
    });
  });
  r.get(`${P}/tax/1099/export`, async (ctx) => {
    rbac.require$(ctx.access, 'tax_return', LEVEL.VIEW);
    const opts = { year: ctx.query.year || new Date().getUTCFullYear(), subsidiary_id: ctx.query.subsidiary_id || null };
    if (ctx.query.format === 'pdf') {
      return {
        __body: tax.pdf1099(ctx.repo, opts),
        __contentType: 'application/pdf',
        __filename: `1099-${opts.year}.pdf`,
      };
    }
    const file = tax.csv1099(ctx.repo, opts);
    return { __body: file.text, __contentType: file.contentType, __filename: file.filename };
  });

  // ======================================== cost allocation across the business
  r.get(`${P}/allocations`, async (ctx) => {
    rbac.require$(ctx.access, 'allocation_schedule', LEVEL.VIEW);
    return {
      ...allocations.list(ctx.repo, { status: ctx.query.status || null }),
      due: allocations.due(ctx.repo, { through: ctx.query.through || today() }),
    };
  });
  r.get(`${P}/allocations/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'allocation_schedule', LEVEL.VIEW);
    return {
      schedule: allocations.getSchedule(ctx.repo, ctx.params.id),
      runs: allocations.runsFor(ctx.repo, ctx.params.id),
    };
  });
  r.get(`${P}/allocations/:id/preview`, async (ctx) => {
    rbac.require$(ctx.access, 'allocation_schedule', LEVEL.VIEW);
    return allocations.preview(ctx.repo, ctx.params.id, { txn_date: ctx.query.txn_date || null });
  });
  r.post(`${P}/allocations`, async (ctx) => {
    rbac.require$(ctx.access, 'allocation_schedule', LEVEL.CREATE);
    return ctx.tx(() => allocations.createSchedule(ctx.repo, ctx.body || {}));
  });
  r.put(`${P}/allocations/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'allocation_schedule', LEVEL.EDIT);
    return ctx.tx(() => allocations.updateSchedule(ctx.repo, ctx.params.id, ctx.body || {}));
  });
  r.post(`${P}/allocations/:id/status`, async (ctx) => {
    rbac.require$(ctx.access, 'allocation_schedule', LEVEL.EDIT);
    return ctx.tx(() => allocations.setStatus(ctx.repo, ctx.params.id, ctx.body?.status));
  });
  r.delete(`${P}/allocations/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'allocation_schedule', LEVEL.FULL);
    return ctx.tx(() => allocations.deleteSchedule(ctx.repo, ctx.params.id));
  });
  r.post(`${P}/allocations/:id/run`, async (ctx) => {
    rbac.require$(ctx.access, 'allocation_schedule', LEVEL.EDIT);
    const body = ctx.body || {};
    const opts = { txn_date: body.txn_date || null, memo: body.memo || '' };
    if (body.dry_run) return allocations.run(ctx.repo, ctx.params.id, { ...opts, dry_run: true });
    return ctx.tx(() => allocations.run(ctx.repo, ctx.params.id, opts));
  });
  r.post(`${P}/allocations/statistics`, async (ctx) => {
    rbac.require$(ctx.access, 'allocation_schedule', LEVEL.EDIT);
    return ctx.tx(() => allocations.postStatistic(ctx.repo, {
      account_id: ctx.body?.account_id, subsidiary_id: ctx.body?.subsidiary_id,
      txn_date: ctx.body?.txn_date || today(), entries: rowList(ctx.body?.entries, 'entries'),
      memo: ctx.body?.memo || '',
    }));
  });

  // ========================== landed cost, and the count that checks it
  r.get(`${P}/landed-costs/categories`, async (ctx) => {
    rbac.require$(ctx.access, 'landed_cost', LEVEL.VIEW);
    return { rows: costing.categories(ctx.repo) };
  });
  r.post(`${P}/landed-costs/categories`, async (ctx) => {
    rbac.require$(ctx.access, 'landed_cost', LEVEL.CREATE);
    return ctx.tx(() => costing.createCategory(ctx.repo, ctx.body || {}));
  });
  r.get(`${P}/landed-costs/:txnId`, async (ctx) => {
    rbac.require$(ctx.access, 'landed_cost', LEVEL.VIEW);
    return costing.landedSummary(ctx.repo, ctx.params.txnId);
  });
  r.post(`${P}/landed-costs/:txnId`, async (ctx) => {
    rbac.require$(ctx.access, 'landed_cost', LEVEL.CREATE);
    return ctx.tx(() => costing.addLandedCost(ctx.repo, ctx.params.txnId, ctx.body || {}));
  });

  r.get(`${P}/stock-counts`, async (ctx) => {
    rbac.require$(ctx.access, 'inventory_count', LEVEL.VIEW);
    return { rows: costing.countHistory(ctx.repo, { status: ctx.query.status || null, limit: int(ctx.query.limit, 30) }) };
  });
  r.get(`${P}/stock-counts/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'inventory_count', LEVEL.VIEW);
    return costing.getCount(ctx.repo, ctx.params.id);
  });
  r.post(`${P}/stock-counts`, async (ctx) => {
    rbac.require$(ctx.access, 'inventory_count', LEVEL.CREATE);
    return ctx.tx(() => costing.openCount(ctx.repo, ctx.body || {}));
  });
  r.put(`${P}/stock-counts/:id/lines`, async (ctx) => {
    rbac.require$(ctx.access, 'inventory_count', LEVEL.EDIT);
    return ctx.tx(() => costing.enterCounts(ctx.repo, ctx.params.id, rowList(ctx.body?.lines, 'lines')));
  });
  r.post(`${P}/stock-counts/:id/post`, async (ctx) => {
    rbac.require$(ctx.access, 'inventory_count', LEVEL.EDIT);
    rbac.require$(ctx.access, 'inventory_adjustment', LEVEL.CREATE);
    return ctx.tx(() => costing.postCount(ctx.repo, ctx.params.id, {
      txn_date: ctx.body?.txn_date || null, memo: ctx.body?.memo || '',
    }));
  });
  r.post(`${P}/stock-counts/:id/cancel`, async (ctx) => {
    rbac.require$(ctx.access, 'inventory_count', LEVEL.EDIT);
    return ctx.tx(() => costing.cancelCount(ctx.repo, ctx.params.id, { reason: ctx.body?.reason || '' }));
  });

  // ================================ deposits taken and prepayments made
  r.get(`${P}/deposits`, async (ctx) => {
    const type = ctx.query.type === 'VENDOR_PREPAYMENT' ? 'VENDOR_PREPAYMENT' : 'CUSTOMER_DEPOSIT';
    rbac.require$(ctx.access, type === 'CUSTOMER_DEPOSIT' ? 'customer_deposit' : 'vendor_prepayment', LEVEL.VIEW);
    return deposits.heldSummary(ctx.repo, { type, subsidiary_id: ctx.query.subsidiary_id || null });
  });
  r.get(`${P}/deposits/open`, async (ctx) => {
    const type = ctx.query.type === 'VENDOR_PREPAYMENT' ? 'VENDOR_PREPAYMENT' : 'CUSTOMER_DEPOSIT';
    rbac.require$(ctx.access, type === 'CUSTOMER_DEPOSIT' ? 'customer_deposit' : 'vendor_prepayment', LEVEL.VIEW);
    return { rows: deposits.open(ctx.repo, { type, entity_id: ctx.query.entity_id || null }) };
  });
  r.get(`${P}/deposits/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'customer_deposit', LEVEL.VIEW);
    return deposits.getDeposit(ctx.repo, ctx.params.id);
  });
  r.post(`${P}/deposits`, async (ctx) => {
    const type = ctx.body?.type === 'VENDOR_PREPAYMENT' ? 'VENDOR_PREPAYMENT' : 'CUSTOMER_DEPOSIT';
    rbac.require$(ctx.access, type === 'CUSTOMER_DEPOSIT' ? 'customer_deposit' : 'vendor_prepayment', LEVEL.CREATE);
    return ctx.tx(() => deposits.createDeposit(ctx.repo, type, ctx.body || {}));
  });
  r.post(`${P}/deposits/:id/apply`, async (ctx) => {
    rbac.require$(ctx.access, 'customer_deposit', LEVEL.EDIT);
    return ctx.tx(() => deposits.applyDeposit(ctx.repo, ctx.params.id, {
      applications: rowList(ctx.body?.applications, 'applications'),
      txn_date: ctx.body?.txn_date || null, memo: ctx.body?.memo || '',
    }));
  });
  r.post(`${P}/deposits/:id/refund`, async (ctx) => {
    rbac.require$(ctx.access, 'customer_deposit', LEVEL.EDIT);
    return ctx.tx(() => deposits.refundDeposit(ctx.repo, ctx.params.id, {
      amount: ctx.body?.amount ?? null, txn_date: ctx.body?.txn_date || null,
      bank_account_id: ctx.body?.bank_account_id || null, memo: ctx.body?.memo || '',
    }));
  });

  // ============================================== subscriptions and billing
  r.get(`${P}/subscriptions`, async (ctx) => {
    rbac.require$(ctx.access, 'subscription', LEVEL.VIEW);
    return {
      ...subs.list(ctx.repo, {
        status: ctx.query.status || null, customer_id: ctx.query.customer_id || null,
        limit: int(ctx.query.limit, 200),
      }),
      due: subs.due(ctx.repo, { through: ctx.query.through || today() }),
      revenue: subs.recurringRevenue(ctx.repo, { as_of: ctx.query.as_of || today() }),
    };
  });
  r.get(`${P}/subscriptions/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'subscription', LEVEL.VIEW);
    return {
      subscription: subs.getSubscription(ctx.repo, ctx.params.id),
      billing: subs.billingHistory(ctx.repo, ctx.params.id),
      usage: subs.usageFor(ctx.repo, ctx.params.id),
    };
  });
  r.get(`${P}/subscriptions/:id/preview`, async (ctx) => {
    rbac.require$(ctx.access, 'subscription', LEVEL.VIEW);
    return subs.previewNext(ctx.repo, ctx.params.id, { through: ctx.query.through || today() });
  });
  r.post(`${P}/subscriptions`, async (ctx) => {
    rbac.require$(ctx.access, 'subscription', LEVEL.CREATE);
    return ctx.tx(() => subs.createSubscription(ctx.repo, ctx.body || {}));
  });
  r.put(`${P}/subscriptions/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'subscription', LEVEL.EDIT);
    return ctx.tx(() => subs.updateSubscription(ctx.repo, ctx.params.id, ctx.body || {}));
  });
  r.post(`${P}/subscriptions/:id/activate`, async (ctx) => {
    rbac.require$(ctx.access, 'subscription', LEVEL.EDIT);
    return ctx.tx(() => subs.activate(ctx.repo, ctx.params.id));
  });
  r.post(`${P}/subscriptions/:id/suspend`, async (ctx) => {
    rbac.require$(ctx.access, 'subscription', LEVEL.EDIT);
    return ctx.tx(() => subs.suspend(ctx.repo, ctx.params.id, { reason: ctx.body?.reason || '' }));
  });
  r.post(`${P}/subscriptions/:id/resume`, async (ctx) => {
    rbac.require$(ctx.access, 'subscription', LEVEL.EDIT);
    return ctx.tx(() => subs.resume(ctx.repo, ctx.params.id));
  });
  r.post(`${P}/subscriptions/:id/cancel`, async (ctx) => {
    rbac.require$(ctx.access, 'subscription', LEVEL.EDIT);
    return ctx.tx(() => subs.cancel(ctx.repo, ctx.params.id, {
      effective_date: ctx.body?.effective_date || null, reason: ctx.body?.reason || '',
    }));
  });
  r.post(`${P}/subscriptions/:id/amend`, async (ctx) => {
    rbac.require$(ctx.access, 'subscription', LEVEL.EDIT);
    return ctx.tx(() => subs.amend(ctx.repo, ctx.params.id, ctx.body || {}));
  });
  r.post(`${P}/subscriptions/:id/usage`, async (ctx) => {
    rbac.require$(ctx.access, 'subscription', LEVEL.EDIT);
    return ctx.tx(() => subs.recordUsage(ctx.repo, ctx.params.id, ctx.body || {}));
  });
  r.post(`${P}/subscriptions/bill`, async (ctx) => {
    rbac.require$(ctx.access, 'subscription', LEVEL.EDIT);
    rbac.require$(ctx.access, 'invoice', LEVEL.CREATE);
    const body = ctx.body || {};
    const opts = { through: body.through || today(), id: body.id || null, txn_date: body.txn_date || null };
    if (body.dry_run) return subs.runBilling(ctx.repo, { ...opts, dry_run: true });
    return ctx.tx(() => subs.runBilling(ctx.repo, opts));
  });

  // ---- intercompany
  r.get(`${P}/intercompany`, async (ctx) => {
    rbac.require$(ctx.access, 'intercompany_txn', LEVEL.VIEW);
    return {
      ...intercompany.list(ctx.repo, {
        status: ctx.query.status || null,
        from: ctx.query.from || null, to: ctx.query.to || null,
        subsidiary_id: ctx.query.subsidiary_id || null,
      }),
      reconciliation: intercompany.reconciliation(ctx.repo, { as_of: ctx.query.as_of || today() }),
      runs: intercompany.runs(ctx.repo, {}),
    };
  });
  r.get(`${P}/intercompany/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'intercompany_txn', LEVEL.VIEW);
    return intercompany.getIntercompany(ctx.repo, ctx.params.id);
  });
  r.post(`${P}/intercompany/journal`, async (ctx) => {
    rbac.require$(ctx.access, 'intercompany_txn', LEVEL.CREATE);
    rbac.require$(ctx.access, 'journal_entry', LEVEL.CREATE);
    return ctx.tx(() => intercompany.intercompanyJournal(ctx.repo, ctx.body || {}));
  });
  r.post(`${P}/intercompany/sale`, async (ctx) => {
    rbac.require$(ctx.access, 'intercompany_txn', LEVEL.CREATE);
    rbac.require$(ctx.access, 'invoice', LEVEL.CREATE);
    rbac.require$(ctx.access, 'vendor_bill', LEVEL.CREATE);
    return ctx.tx(() => intercompany.intercompanySale(ctx.repo, ctx.body || {}));
  });
  r.get(`${P}/intercompany/eliminations/preview`, async (ctx) => {
    rbac.require$(ctx.access, 'elimination_run', LEVEL.VIEW);
    return intercompany.previewElimination(ctx.repo, { period_id: ctx.query.period_id });
  });
  r.get(`${P}/intercompany/eliminations/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'elimination_run', LEVEL.VIEW);
    return intercompany.getRun(ctx.repo, ctx.params.id);
  });
  r.post(`${P}/intercompany/eliminations`, async (ctx) => {
    rbac.require$(ctx.access, 'elimination_run', LEVEL.CREATE);
    rbac.require$(ctx.access, 'journal_entry', LEVEL.CREATE);
    const body = ctx.body || {};
    if (body.dry_run) return intercompany.runElimination(ctx.repo, { period_id: body.period_id, dry_run: true });
    return ctx.tx(() => intercompany.runElimination(ctx.repo, { period_id: body.period_id, memo: body.memo || '' }));
  });
  r.post(`${P}/intercompany/eliminations/:id/reverse`, async (ctx) => {
    rbac.require$(ctx.access, 'elimination_run', LEVEL.EDIT);
    return ctx.tx(() => intercompany.reverseElimination(ctx.repo, ctx.params.id, { reason: ctx.body?.reason || '' }));
  });
  r.post(`${P}/intercompany/elimination-subsidiary`, async (ctx) => {
    rbac.require$(ctx.access, 'subsidiary', LEVEL.CREATE);
    return ctx.tx(() => intercompany.eliminationSubsidiary(ctx.repo, { create: true }));
  });

  // ---- custom record types
  // Defining a type is an administrative act; the records of that type go
  // through the ordinary /records routes like everything else.
  r.get(`${P}/custom-records`, async (ctx) => {
    rbac.require$(ctx.access, 'custom_record_type', LEVEL.VIEW);
    const types = customRecords.listTypes(ctx.repo, { includeInactive: true });
    return {
      rows: types.map((t) => ({
        ...t,
        field_count: customRecords.fieldsOfType(ctx.repo, t.name).length,
        record_count: ctx.repo.scalar('SELECT COUNT(*) c FROM custom_record WHERE tenant_id = :t AND type_name = ?', [t.name], 0),
        record_type: customRecords.qualified(t.name),
      })),
      total: types.length,
      nav_groups: customRecords.NAV_GROUPS,
    };
  });
  r.get(`${P}/custom-records/:name`, async (ctx) => {
    rbac.require$(ctx.access, 'custom_record_type', LEVEL.VIEW);
    const t = customRecords.requireType(ctx.repo, ctx.params.name);
    return {
      type: t,
      record_type: customRecords.qualified(t.name),
      fields: customRecords.fieldsOfType(ctx.repo, t.name),
      meta: customRecords.describeType(ctx.repo, t.name),
      record_count: ctx.repo.scalar('SELECT COUNT(*) c FROM custom_record WHERE tenant_id = :t AND type_name = ?', [t.name], 0),
    };
  });
  r.post(`${P}/custom-records`, async (ctx) => {
    rbac.require$(ctx.access, 'custom_record_type', LEVEL.CREATE);
    return ctx.tx(() => customRecords.createType(ctx.repo, ctx.body || {}));
  });
  r.put(`${P}/custom-records/:name`, async (ctx) => {
    rbac.require$(ctx.access, 'custom_record_type', LEVEL.EDIT);
    return ctx.tx(() => customRecords.updateType(ctx.repo, ctx.params.name, ctx.body || {}));
  });
  r.delete(`${P}/custom-records/:name`, async (ctx) => {
    rbac.require$(ctx.access, 'custom_record_type', LEVEL.FULL);
    return ctx.tx(() => customRecords.deleteType(ctx.repo, ctx.params.name));
  });

  // ---- asset revaluation, impairment and transfer
  r.get(`${P}/assets/:id/value`, async (ctx) => {
    rbac.require$(ctx.access, 'fixed_asset', LEVEL.VIEW);
    return {
      ...assetValue.carryingAmount(ctx.repo, ctx.params.id),
      revaluations: assetValue.revaluationsFor(ctx.repo, ctx.params.id),
      transfers: assetValue.transfersFor(ctx.repo, ctx.params.id),
    };
  });
  r.get(`${P}/assets/:id/revalue/preview`, async (ctx) => {
    rbac.require$(ctx.access, 'fixed_asset', LEVEL.VIEW);
    return assetValue.preview(ctx.repo, ctx.params.id, {
      new_value: ctx.query.new_value,
      effective_date: ctx.query.effective_date || today(),
      kind: ctx.query.kind || 'revaluation',
      remaining_life_months: ctx.query.remaining_life_months ?? null,
    });
  });
  r.post(`${P}/assets/:id/revalue`, async (ctx) => {
    rbac.require$(ctx.access, 'fixed_asset', LEVEL.EDIT);
    rbac.require$(ctx.access, 'journal_entry', LEVEL.CREATE);
    return ctx.tx(() => assetValue.revalue(ctx.repo, ctx.params.id, ctx.body || {}));
  });
  r.post(`${P}/assets/:id/transfer`, async (ctx) => {
    rbac.require$(ctx.access, 'fixed_asset', LEVEL.EDIT);
    return ctx.tx(() => assetValue.transfer(ctx.repo, ctx.params.id, ctx.body || {}));
  });
  r.get(`${P}/revaluations`, async (ctx) => {
    rbac.require$(ctx.access, 'fixed_asset', LEVEL.VIEW);
    return assetValue.list(ctx.repo, {
      kind: ctx.query.kind || null, from: ctx.query.from || null, to: ctx.query.to || null,
    });
  });
  r.post(`${P}/revaluations/:id/reverse`, async (ctx) => {
    rbac.require$(ctx.access, 'fixed_asset', LEVEL.EDIT);
    return ctx.tx(() => assetValue.reverseRevaluation(ctx.repo, ctx.params.id, { reason: ctx.body?.reason || '' }));
  });

  // ---- accounting books
  r.get(`${P}/books`, async (ctx) => {
    rbac.require$(ctx.access, 'accounting_book', LEVEL.VIEW);
    return {
      rows: books.listBooks(ctx.repo, { includeInactive: true }),
      comparison: books.comparison(ctx.repo, {
        from: ctx.query.from || null, to: ctx.query.to || today(),
        subsidiaryId: ctx.query.subsidiary_id || null,
      }),
    };
  });
  r.get(`${P}/books/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'accounting_book', LEVEL.VIEW);
    const book = books.requireBook(ctx.repo, ctx.params.id);
    return {
      book,
      adjustments: books.adjustments(ctx.repo, { book_id: book.id }),
      asset_rules: book.is_primary ? [] : books.assetRules(ctx.repo, book.id),
    };
  });
  r.post(`${P}/books`, async (ctx) => {
    rbac.require$(ctx.access, 'accounting_book', LEVEL.CREATE);
    return ctx.tx(() => books.createBook(ctx.repo, ctx.body || {}));
  });
  r.put(`${P}/books/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'accounting_book', LEVEL.EDIT);
    return ctx.tx(() => books.updateBook(ctx.repo, ctx.params.id, ctx.body || {}));
  });
  r.delete(`${P}/books/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'accounting_book', LEVEL.FULL);
    return ctx.tx(() => books.deleteBook(ctx.repo, ctx.params.id));
  });
  r.get(`${P}/books/:id/adjustments/:adjustmentId`, async (ctx) => {
    rbac.require$(ctx.access, 'accounting_book', LEVEL.VIEW);
    return books.getAdjustment(ctx.repo, ctx.params.adjustmentId);
  });
  r.post(`${P}/books/:id/adjustments`, async (ctx) => {
    rbac.require$(ctx.access, 'accounting_book', LEVEL.EDIT);
    rbac.require$(ctx.access, 'journal_entry', LEVEL.CREATE);
    return ctx.tx(() => books.postAdjustment(ctx.repo, { ...(ctx.body || {}), book_id: ctx.params.id }));
  });
  r.post(`${P}/books/:id/adjustments/:adjustmentId/reverse`, async (ctx) => {
    rbac.require$(ctx.access, 'accounting_book', LEVEL.EDIT);
    return ctx.tx(() => books.reverseAdjustment(ctx.repo, ctx.params.adjustmentId, { memo: ctx.body?.memo || null }));
  });
  r.post(`${P}/books/:id/asset-rules`, async (ctx) => {
    rbac.require$(ctx.access, 'accounting_book', LEVEL.EDIT);
    return ctx.tx(() => books.setAssetRule(ctx.repo, { ...(ctx.body || {}), book_id: ctx.params.id }));
  });
  r.delete(`${P}/books/:id/asset-rules/:ruleId`, async (ctx) => {
    rbac.require$(ctx.access, 'accounting_book', LEVEL.EDIT);
    return ctx.tx(() => books.removeAssetRule(ctx.repo, ctx.params.ruleId));
  });
  r.post(`${P}/books/:id/depreciation`, async (ctx) => {
    rbac.require$(ctx.access, 'accounting_book', LEVEL.EDIT);
    const body = ctx.body || {};
    const opts = { book_id: ctx.params.id, through: body.through || today() };
    if (body.dry_run) return books.runBookDepreciation(ctx.repo, { ...opts, dry_run: true });
    return ctx.tx(() => books.runBookDepreciation(ctx.repo, opts));
  });

  // ======================================================== budgeting
  r.post(`${P}/budgets`, async (ctx) => {
    rbac.require$(ctx.access, 'budget', LEVEL.CREATE);
    return ctx.tx(() => budget.createBudget(ctx.repo, ctx.body || {}));
  });
  r.get(`${P}/budgets/:id/lines`, async (ctx) => {
    rbac.require$(ctx.access, 'budget', LEVEL.VIEW);
    return { budget: budget.getBudget(ctx.repo, ctx.params.id), lines: budget.linesFor(ctx.repo, ctx.params.id) };
  });
  r.put(`${P}/budgets/:id/lines`, async (ctx) => {
    rbac.require$(ctx.access, 'budget', LEVEL.EDIT);
    return ctx.tx(() => budget.setLines(ctx.repo, ctx.params.id, ctx.body?.lines || []));
  });
  r.post(`${P}/budgets/:id/seed`, async (ctx) => {
    rbac.require$(ctx.access, 'budget', LEVEL.EDIT);
    return ctx.tx(() => budget.seedFromActuals(ctx.repo, ctx.params.id, ctx.body || {}));
  });
  r.post(`${P}/budgets/:id/status`, async (ctx) => {
    rbac.require$(ctx.access, 'budget', LEVEL.EDIT);
    return ctx.tx(() => budget.setStatus(ctx.repo, ctx.params.id, ctx.body?.status));
  });
  r.get(`${P}/budgets/:id/variance`, async (ctx) => {
    rbac.require$(ctx.access, 'budget', LEVEL.VIEW);
    return budget.varianceReport(ctx.repo, { budget_id: ctx.params.id, from: ctx.query.from || null, to: ctx.query.to || null });
  });
  r.get(`${P}/budgets/:id/forecast`, async (ctx) => {
    rbac.require$(ctx.access, 'budget', LEVEL.VIEW);
    return budget.fullYearForecast(ctx.repo, { budget_id: ctx.params.id });
  });

  // ==================================================== consolidation
  r.get(`${P}/consolidation/statements`, async (ctx) => {
    rbac.require$(ctx.access, 'consolidation', LEVEL.VIEW);
    return consolidation.consolidatedStatements(ctx.repo, {
      fiscalYear: ctx.query.fiscal_year ? int(ctx.query.fiscal_year) : null,
      from: ctx.query.from || null, to: ctx.query.to || null,
      parentSubsidiaryId: ctx.query.subsidiary_id || null,
      eliminate: bool(ctx.query.eliminate, true),
    });
  });
  r.get(`${P}/consolidation/trial-balance`, async (ctx) => {
    rbac.require$(ctx.access, 'consolidation', LEVEL.VIEW);
    const ids = String(ctx.query.period_ids || '').split(',').filter(Boolean);
    if (!ids.length) throw badRequest('period_ids is required (comma-separated accounting period ids)');
    return consolidation.consolidatedTrialBalance(ctx.repo, {
      periodIds: ids, parentSubsidiaryId: ctx.query.subsidiary_id || null, eliminate: bool(ctx.query.eliminate, true),
    });
  });
  r.get(`${P}/consolidation/tree`, async (ctx) => {
    rbac.require$(ctx.access, 'consolidation', LEVEL.VIEW);
    return { subsidiaries: consolidation.subsidiaryTree(ctx.repo, ctx.query.root || null) };
  });
  r.post(`${P}/consolidation/rates`, async (ctx) => {
    rbac.require$(ctx.access, 'consolidation', LEVEL.EDIT);
    return ctx.tx(() => consolidation.setRate(ctx.repo, ctx.body || {}));
  });

  // ========================================================= projects
  r.post(`${P}/projects`, async (ctx) => {
    rbac.require$(ctx.access, 'project', LEVEL.CREATE);
    return ctx.tx(() => projects.createProject(ctx.repo, ctx.body || {}));
  });
  r.get(`${P}/projects/portfolio`, async (ctx) => {
    rbac.require$(ctx.access, 'project', LEVEL.VIEW);
    return projects.portfolio(ctx.repo, { status: ctx.query.status || null });
  });
  r.get(`${P}/projects/utilisation`, async (ctx) => {
    rbac.require$(ctx.access, 'project', LEVEL.VIEW);
    return {
      rows: projects.utilisation(ctx.repo, {
        from: ctx.query.from || today(), to: ctx.query.to || addDays(today(), 30),
        capacity_hours_per_week: int(ctx.query.capacity, 40),
      }),
    };
  });
  r.get(`${P}/projects/:id/tasks`, async (ctx) => {
    rbac.require$(ctx.access, 'project', LEVEL.VIEW);
    return { tasks: projects.tasksFor(ctx.repo, ctx.params.id) };
  });
  r.post(`${P}/projects/:id/tasks`, async (ctx) => {
    rbac.require$(ctx.access, 'project', LEVEL.EDIT);
    return ctx.tx(() => projects.addTask(ctx.repo, ctx.params.id, ctx.body || {}));
  });
  r.post(`${P}/projects/:id/recalc`, async (ctx) => {
    rbac.require$(ctx.access, 'project', LEVEL.EDIT);
    return ctx.tx(() => projects.recalcProgress(ctx.repo, ctx.params.id));
  });
  r.post(`${P}/projects/allocations`, async (ctx) => {
    rbac.require$(ctx.access, 'project', LEVEL.EDIT);
    return ctx.tx(() => projects.allocate(ctx.repo, ctx.body || {}));
  });
  r.get(`${P}/projects/:id/unbilled`, async (ctx) => {
    rbac.require$(ctx.access, 'project', LEVEL.VIEW);
    return projects.unbilled(ctx.repo, ctx.params.id);
  });
  r.post(`${P}/projects/:id/bill`, async (ctx) => {
    rbac.require$(ctx.access, 'project', LEVEL.EDIT);
    rbac.require$(ctx.access, 'invoice', LEVEL.CREATE);
    return ctx.tx(() => projects.billProject(ctx.repo, ctx.params.id, ctx.body || {}));
  });
  r.get(`${P}/projects/:id/profitability`, async (ctx) => {
    rbac.require$(ctx.access, 'project', LEVEL.VIEW);
    return projects.profitability(ctx.repo, ctx.params.id);
  });
  r.post(`${P}/expense-reports`, async (ctx) => {
    rbac.require$(ctx.access, 'expense_report', LEVEL.CREATE);
    return ctx.tx(() => projects.createExpenseReport(ctx.repo, ctx.body || {}));
  });
  r.get(`${P}/expense-reports/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'expense_report', LEVEL.VIEW);
    return { ...projects.getReport(ctx.repo, ctx.params.id), lines: projects.expenseLines(ctx.repo, ctx.params.id) };
  });
  r.post(`${P}/expense-reports/:id/submit`, async (ctx) => {
    rbac.require$(ctx.access, 'expense_report', LEVEL.EDIT);
    return ctx.tx(() => projects.submitExpenseReport(ctx.repo, ctx.params.id));
  });
  // Approving a claim writes to the ledger, so it needs more than edit rights.
  r.post(`${P}/expense-reports/:id/approve`, async (ctx) => {
    rbac.require$(ctx.access, 'expense_report', LEVEL.FULL);
    return ctx.tx(() => projects.decideExpenseReport(ctx.repo, ctx.params.id, { approve: true }));
  });
  r.post(`${P}/expense-reports/:id/reject`, async (ctx) => {
    rbac.require$(ctx.access, 'expense_report', LEVEL.FULL);
    return ctx.tx(() => projects.decideExpenseReport(ctx.repo, ctx.params.id, { approve: false, note: (ctx.body || {}).note || '' }));
  });
  r.post(`${P}/expense-reports/:id/reimburse`, async (ctx) => {
    rbac.require$(ctx.access, 'expense_report', LEVEL.FULL);
    return ctx.tx(() => projects.reimburseExpenseReport(ctx.repo, ctx.params.id, ctx.body || {}));
  });

  // ==================================================== manufacturing
  r.post(`${P}/boms`, async (ctx) => {
    rbac.require$(ctx.access, 'bom', LEVEL.CREATE);
    return ctx.tx(() => mfg.createBom(ctx.repo, ctx.body || {}));
  });
  r.get(`${P}/boms/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'bom', LEVEL.VIEW);
    return { ...mfg.getBom(ctx.repo, ctx.params.id), lines: mfg.bomLines(ctx.repo, ctx.params.id), routing: mfg.routingFor(ctx.repo, ctx.params.id) };
  });
  r.post(`${P}/boms/:id/release`, async (ctx) => {
    rbac.require$(ctx.access, 'bom', LEVEL.EDIT);
    return ctx.tx(() => mfg.releaseBom(ctx.repo, ctx.params.id));
  });
  r.get(`${P}/items/:id/explode`, async (ctx) => {
    rbac.require$(ctx.access, 'bom', LEVEL.VIEW);
    return { components: mfg.explode(ctx.repo, ctx.params.id, int(ctx.query.quantity, 1) * 1_000_000) };
  });
  r.get(`${P}/items/:id/cost-rollup`, async (ctx) => {
    rbac.require$(ctx.access, 'bom', LEVEL.VIEW);
    return mfg.rollupCost(ctx.repo, ctx.params.id);
  });
  r.post(`${P}/work-orders`, async (ctx) => {
    rbac.require$(ctx.access, 'work_order', LEVEL.CREATE);
    return ctx.tx(() => mfg.createWorkOrder(ctx.repo, ctx.body || {}));
  });
  r.get(`${P}/work-orders/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'work_order', LEVEL.VIEW);
    return {
      ...mfg.getWorkOrder(ctx.repo, ctx.params.id),
      lines: mfg.woLines(ctx.repo, ctx.params.id),
      operations: mfg.woOperations(ctx.repo, ctx.params.id),
      availability: mfg.componentAvailability(ctx.repo, ctx.params.id),
    };
  });
  r.post(`${P}/work-orders/:id/release`, async (ctx) => {
    rbac.require$(ctx.access, 'work_order', LEVEL.EDIT);
    return ctx.tx(() => mfg.releaseWorkOrder(ctx.repo, ctx.params.id));
  });
  r.post(`${P}/work-orders/:id/issue`, async (ctx) => {
    rbac.require$(ctx.access, 'work_order', LEVEL.EDIT);
    return ctx.tx(() => mfg.issueComponents(ctx.repo, ctx.params.id, ctx.body || {}));
  });
  r.post(`${P}/work-orders/:id/operations/:opId`, async (ctx) => {
    rbac.require$(ctx.access, 'work_order', LEVEL.EDIT);
    return ctx.tx(() => mfg.logOperation(ctx.repo, ctx.params.id, ctx.params.opId, ctx.body || {}));
  });
  r.post(`${P}/work-orders/:id/build`, async (ctx) => {
    rbac.require$(ctx.access, 'work_order', LEVEL.EDIT);
    return ctx.tx(() => mfg.buildWorkOrder(ctx.repo, ctx.params.id, ctx.body || {}));
  });
  r.post(`${P}/quality/inspections`, async (ctx) => {
    rbac.require$(ctx.access, 'quality_inspection', LEVEL.CREATE);
    return ctx.tx(() => mfg.recordInspection(ctx.repo, ctx.body || {}));
  });
  r.get(`${P}/quality/summary`, async (ctx) => {
    rbac.require$(ctx.access, 'quality_inspection', LEVEL.VIEW);
    return mfg.qualitySummary(ctx.repo, { from: ctx.query.from || null, to: ctx.query.to || null });
  });

  // ======================================================= warehouse
  r.get(`${P}/warehouse/bins`, async (ctx) => {
    rbac.require$(ctx.access, 'bin', LEVEL.VIEW);
    if (!ctx.query.location_id) throw badRequest('location_id is required');
    return { bins: wh.binsFor(ctx.repo, ctx.query.location_id) };
  });
  r.post(`${P}/warehouse/bins`, async (ctx) => {
    rbac.require$(ctx.access, 'bin', LEVEL.CREATE);
    return ctx.tx(() => wh.createBin(ctx.repo, ctx.body || {}));
  });
  r.get(`${P}/warehouse/bins/:id/contents`, async (ctx) => {
    rbac.require$(ctx.access, 'bin', LEVEL.VIEW);
    return { contents: wh.binContents(ctx.repo, ctx.params.id) };
  });
  r.post(`${P}/warehouse/bins/move`, async (ctx) => {
    rbac.require$(ctx.access, 'bin', LEVEL.EDIT);
    return ctx.tx(() => wh.moveBin(ctx.repo, ctx.body || {}));
  });
  r.get(`${P}/warehouse/reconcile`, async (ctx) => {
    rbac.require$(ctx.access, 'bin', LEVEL.VIEW);
    if (!ctx.query.location_id) throw badRequest('location_id is required');
    return wh.reconcileBins(ctx.repo, ctx.query.location_id);
  });
  r.post(`${P}/warehouse/putaway/generate`, async (ctx) => {
    rbac.require$(ctx.access, 'bin', LEVEL.EDIT);
    return ctx.tx(() => wh.generatePutaway(ctx.repo, ctx.body?.receipt_txn_id));
  });
  r.post(`${P}/warehouse/putaway/:id/complete`, async (ctx) => {
    rbac.require$(ctx.access, 'bin', LEVEL.EDIT);
    return ctx.tx(() => wh.completePutaway(ctx.repo, ctx.params.id, ctx.body || {}));
  });
  r.get(`${P}/warehouse/workload`, async (ctx) => {
    rbac.require$(ctx.access, 'pick_wave', LEVEL.VIEW);
    return wh.workloadSummary(ctx.repo, { location_id: ctx.query.location_id || null });
  });
  r.post(`${P}/waves`, async (ctx) => {
    rbac.require$(ctx.access, 'pick_wave', LEVEL.CREATE);
    return ctx.tx(() => wh.createWave(ctx.repo, ctx.body || {}));
  });
  r.get(`${P}/waves/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'pick_wave', LEVEL.VIEW);
    return { ...wh.getWave(ctx.repo, ctx.params.id), tasks: wh.waveTasks(ctx.repo, ctx.params.id) };
  });
  r.post(`${P}/waves/:id/release`, async (ctx) => {
    rbac.require$(ctx.access, 'pick_wave', LEVEL.EDIT);
    return ctx.tx(() => wh.releaseWave(ctx.repo, ctx.params.id));
  });
  r.post(`${P}/waves/picks/:taskId`, async (ctx) => {
    rbac.require$(ctx.access, 'pick_wave', LEVEL.EDIT);
    return ctx.tx(() => wh.confirmPick(ctx.repo, ctx.params.taskId, ctx.body || {}));
  });
  r.post(`${P}/waves/:id/pack`, async (ctx) => {
    rbac.require$(ctx.access, 'pick_wave', LEVEL.EDIT);
    return ctx.tx(() => wh.packWave(ctx.repo, ctx.params.id, ctx.body || {}));
  });
  r.post(`${P}/waves/:id/ship`, async (ctx) => {
    rbac.require$(ctx.access, 'pick_wave', LEVEL.EDIT);
    rbac.require$(ctx.access, 'fulfillment', LEVEL.CREATE);
    return ctx.tx(() => wh.shipWave(ctx.repo, ctx.params.id, ctx.body || {}));
  });

  // ======================================================== planning
  r.post(`${P}/planning/demand-plans`, async (ctx) => {
    rbac.require$(ctx.access, 'demand_plan', LEVEL.CREATE);
    return ctx.tx(() => planning.createPlan(ctx.repo, ctx.body || {}));
  });
  r.post(`${P}/planning/demand-plans/:id/run`, async (ctx) => {
    rbac.require$(ctx.access, 'demand_plan', LEVEL.EDIT);
    return ctx.tx(() => planning.runForecast(ctx.repo, ctx.params.id));
  });
  r.get(`${P}/planning/demand-plans/:id/lines`, async (ctx) => {
    rbac.require$(ctx.access, 'demand_plan', LEVEL.VIEW);
    return { lines: planning.planLines(ctx.repo, ctx.params.id, { itemId: ctx.query.item_id || null }) };
  });
  r.put(`${P}/planning/lines/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'demand_plan', LEVEL.EDIT);
    return ctx.tx(() => planning.overrideLine(ctx.repo, ctx.params.id, ctx.body?.quantity ?? null));
  });
  r.post(`${P}/planning/supply/run`, async (ctx) => {
    rbac.require$(ctx.access, 'demand_plan', LEVEL.EDIT);
    return ctx.tx(() => planning.runSupplyPlan(ctx.repo, ctx.body || {}));
  });
  r.get(`${P}/planning/suggestions`, async (ctx) => {
    rbac.require$(ctx.access, 'demand_plan', LEVEL.VIEW);
    return { suggestions: planning.suggestionsFor(ctx.repo, { run_id: ctx.query.run_id || null, status: ctx.query.status || 'open' }) };
  });
  r.post(`${P}/planning/suggestions/action`, async (ctx) => {
    rbac.require$(ctx.access, 'purchase_order', LEVEL.CREATE);
    return ctx.tx(() => planning.actionSuggestions(ctx.repo, ctx.body?.ids || [], ctx.body || {}));
  });
  r.post(`${P}/planning/suggestions/dismiss`, async (ctx) => {
    rbac.require$(ctx.access, 'demand_plan', LEVEL.EDIT);
    return ctx.tx(() => planning.dismissSuggestions(ctx.repo, ctx.body?.ids || []));
  });

  // =================================================== field service
  r.post(`${P}/service/orders`, async (ctx) => {
    rbac.require$(ctx.access, 'service_order', LEVEL.CREATE);
    return ctx.tx(() => service.createOrder(ctx.repo, ctx.body || {}));
  });
  r.get(`${P}/service/orders/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'service_order', LEVEL.VIEW);
    return { ...service.getOrder(ctx.repo, ctx.params.id), lines: service.serviceLines(ctx.repo, ctx.params.id) };
  });
  r.get(`${P}/service/technicians/available`, async (ctx) => {
    rbac.require$(ctx.access, 'service_order', LEVEL.VIEW);
    return {
      technicians: service.availableTechnicians(ctx.repo, {
        start: ctx.query.start, end: ctx.query.end,
        skills: String(ctx.query.skills || '').split(',').filter(Boolean),
      }),
    };
  });
  r.post(`${P}/service/orders/:id/schedule`, async (ctx) => {
    rbac.require$(ctx.access, 'service_order', LEVEL.EDIT);
    return ctx.tx(() => service.schedule(ctx.repo, ctx.params.id, ctx.body || {}));
  });
  r.post(`${P}/service/orders/:id/status`, async (ctx) => {
    rbac.require$(ctx.access, 'service_order', LEVEL.EDIT);
    return ctx.tx(() => service.setStatus(ctx.repo, ctx.params.id, ctx.body?.status, ctx.body || {}));
  });
  r.post(`${P}/service/orders/:id/lines`, async (ctx) => {
    rbac.require$(ctx.access, 'service_order', LEVEL.EDIT);
    return ctx.tx(() => service.addLines(ctx.repo, ctx.params.id, ctx.body?.lines || []));
  });
  r.post(`${P}/service/orders/:id/invoice`, async (ctx) => {
    rbac.require$(ctx.access, 'service_order', LEVEL.EDIT);
    rbac.require$(ctx.access, 'invoice', LEVEL.CREATE);
    return ctx.tx(() => service.invoiceOrder(ctx.repo, ctx.params.id, ctx.body || {}));
  });
  r.get(`${P}/service/dispatch`, async (ctx) => {
    rbac.require$(ctx.access, 'service_order', LEVEL.VIEW);
    return service.dispatchBoard(ctx.repo, { date: ctx.query.date || today() });
  });
  r.get(`${P}/service/renewals`, async (ctx) => {
    rbac.require$(ctx.access, 'service_contract', LEVEL.VIEW);
    return { contracts: service.contractRenewals(ctx.repo, { within_days: int(ctx.query.within_days, 90) }) };
  });

  // ============================================ marketing & commerce
  r.post(`${P}/campaigns`, async (ctx) => {
    rbac.require$(ctx.access, 'campaign', LEVEL.CREATE);
    return ctx.tx(() => commerce.createCampaign(ctx.repo, ctx.body || {}));
  });
  r.get(`${P}/campaigns/performance`, async (ctx) => {
    rbac.require$(ctx.access, 'campaign', LEVEL.VIEW);
    return ctx.tx(() => ({ campaigns: commerce.campaignPerformance(ctx.repo) }));
  });
  r.get(`${P}/campaigns/:id/performance`, async (ctx) => {
    rbac.require$(ctx.access, 'campaign', LEVEL.VIEW);
    return ctx.tx(() => commerce.recalcCampaign(ctx.repo, ctx.params.id));
  });
  r.post(`${P}/partners`, async (ctx) => {
    rbac.require$(ctx.access, 'partner', LEVEL.CREATE);
    return ctx.tx(() => commerce.createPartner(ctx.repo, ctx.body || {}));
  });
  r.post(`${P}/commissions/accrue`, async (ctx) => {
    rbac.require$(ctx.access, 'commission', LEVEL.CREATE);
    return ctx.tx(() => commerce.accrueCommission(ctx.repo, ctx.body?.txn_id));
  });
  r.get(`${P}/commissions/statement`, async (ctx) => {
    rbac.require$(ctx.access, 'commission', LEVEL.VIEW);
    return commerce.commissionStatement(ctx.repo, {
      partner_id: ctx.query.partner_id || null, employee_id: ctx.query.employee_id || null, status: ctx.query.status || null,
    });
  });
  r.post(`${P}/channels`, async (ctx) => {
    rbac.require$(ctx.access, 'sales_channel', LEVEL.CREATE);
    return ctx.tx(() => commerce.createChannel(ctx.repo, ctx.body || {}));
  });
  r.post(`${P}/channels/:id/listings`, async (ctx) => {
    rbac.require$(ctx.access, 'sales_channel', LEVEL.EDIT);
    return ctx.tx(() => commerce.publishListings(ctx.repo, ctx.params.id, ctx.body?.item_ids || []));
  });
  r.post(`${P}/carts/:id/convert`, async (ctx) => {
    rbac.require$(ctx.access, 'sales_order', LEVEL.CREATE);
    return ctx.tx(() => commerce.convertCart(ctx.repo, ctx.params.id, ctx.body || {}));
  });
  r.get(`${P}/channels/summary`, async (ctx) => {
    rbac.require$(ctx.access, 'sales_channel', LEVEL.VIEW);
    return { channels: commerce.channelSummary(ctx.repo, { days: int(ctx.query.days, 30) }) };
  });

  // ======================================================= workforce
  r.post(`${P}/hr/review-cycles`, async (ctx) => {
    rbac.require$(ctx.access, 'performance_review', LEVEL.CREATE);
    return ctx.tx(() => workforce.createCycle(ctx.repo, ctx.body || {}));
  });
  r.post(`${P}/hr/review-cycles/:id/open`, async (ctx) => {
    rbac.require$(ctx.access, 'performance_review', LEVEL.EDIT);
    return ctx.tx(() => workforce.openCycle(ctx.repo, ctx.params.id));
  });
  r.get(`${P}/hr/review-cycles/:id/progress`, async (ctx) => {
    rbac.require$(ctx.access, 'performance_review', LEVEL.VIEW);
    return workforce.cycleProgress(ctx.repo, ctx.params.id);
  });
  r.post(`${P}/hr/reviews/:id/submit`, async (ctx) => {
    rbac.require$(ctx.access, 'performance_review', LEVEL.EDIT);
    return ctx.tx(() => workforce.submitReview(ctx.repo, ctx.params.id, ctx.body || {}));
  });
  r.post(`${P}/hr/reviews/:id/acknowledge`, async (ctx) => {
    rbac.require$(ctx.access, 'performance_review', LEVEL.EDIT);
    return ctx.tx(() => workforce.acknowledgeReview(ctx.repo, ctx.params.id));
  });
  r.post(`${P}/hr/shifts`, async (ctx) => {
    rbac.require$(ctx.access, 'schedule_entry', LEVEL.CREATE);
    return ctx.tx(() => workforce.createShift(ctx.repo, ctx.body || {}));
  });
  r.post(`${P}/hr/schedule`, async (ctx) => {
    rbac.require$(ctx.access, 'schedule_entry', LEVEL.CREATE);
    return ctx.tx(() => workforce.scheduleShift(ctx.repo, ctx.body || {}));
  });
  r.get(`${P}/hr/rota`, async (ctx) => {
    rbac.require$(ctx.access, 'schedule_entry', LEVEL.VIEW);
    return {
      entries: workforce.rota(ctx.repo, {
        from: ctx.query.from || today(), to: ctx.query.to || addDays(today(), 7),
        location_id: ctx.query.location_id || null,
      }),
    };
  });
  r.post(`${P}/hr/attendance/clock`, async (ctx) => {
    rbac.require$(ctx.access, 'attendance', LEVEL.CREATE);
    return ctx.tx(() => workforce.clock(ctx.repo, ctx.body || {}));
  });
  r.get(`${P}/hr/attendance/summary`, async (ctx) => {
    rbac.require$(ctx.access, 'attendance', LEVEL.VIEW);
    return workforce.attendanceSummary(ctx.repo, {
      from: ctx.query.from || addDays(today(), -30), to: ctx.query.to || today(),
      employee_id: ctx.query.employee_id || null,
    });
  });
  r.post(`${P}/hr/requests`, async (ctx) => {
    rbac.require$(ctx.access, 'employee_request', LEVEL.CREATE);
    return ctx.tx(() => workforce.raiseRequest(ctx.repo, ctx.body || {}));
  });
  r.get(`${P}/hr/requests/pending`, async (ctx) => {
    rbac.require$(ctx.access, 'employee_request', LEVEL.VIEW);
    return { requests: workforce.pendingRequests(ctx.repo, { approver_id: ctx.query.approver_id || null }) };
  });
  r.post(`${P}/hr/requests/:id/decide`, async (ctx) => {
    rbac.require$(ctx.access, 'employee_request', LEVEL.EDIT);
    return ctx.tx(() => workforce.decideRequest(ctx.repo, ctx.params.id, ctx.body || {}));
  });

  return r;
}
