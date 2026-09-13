// Meridian ERP :: api_data
// Routes for getting data in and out: CSV/XLSX import, exports in four
// formats, bank statement files, and the live OData feed that Power BI,
// Excel and Tableau connect to.
import * as rbac from './core/rbac.mjs';
import { badRequest, notFound, unprocessable } from './core/http.mjs';
import { today, nowIso, safeJson } from './core/util.mjs';
import * as meta from './modules/meta.mjs';
import * as dataio from './modules/dataio.mjs';
import * as bankfiles from './modules/bankfiles.mjs';
import * as odata from './modules/odata.mjs';
import * as soap from './modules/soap.mjs';
import * as reports from './modules/reports.mjs';
import * as platform from './modules/platform.mjs';

const LEVEL = rbac.LEVEL;
const int = (v, d = 0) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : d; };

// A spreadsheet arrives base64-encoded inside the JSON body, which costs
// about a third more bytes than the file itself -- so years of invoices as
// one workbook needs real headroom, not the 8 MB every other route is
// rightly capped at.
const IMPORT_BODY_LIMIT = 60 * 1024 * 1024;

/** Absolute base URL of this server, as the client reached it. */
const baseUrlOf = (ctx) => {
  const proto = ctx.req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${ctx.req.headers.host}`;
};

/**
 * One file's contents, whichever shape the client sent: raw CSV/TSV text,
 * or a base64-encoded spreadsheet plus which sheet of it to read. Every
 * import route accepts either, so a single-file screen and the bulk-import
 * screen can hand the server the same body shape.
 */
function resolveInput(repo, b) {
  if (typeof b.text === 'string') return { text: b.text };
  if (typeof b.data === 'string') {
    let buf;
    try { buf = Buffer.from(b.data, 'base64'); }
    catch { throw badRequest('`data` must be base64-encoded file contents'); }
    // readWorkbookSheet, not readWorkbook: this needs the one sheet's actual
    // rows to import, not the whole workbook's list of sheet names.
    const sheet = dataio.readWorkbookSheet(buf, b.sheet, { headerRow: b.header_row ? { [b.sheet]: b.header_row } : {} });
    return { parsed: { headers: sheet.headers, rows: sheet.rows } };
  }
  throw badRequest('Provide either `text` (CSV) or `data` (a base64-encoded spreadsheet)');
}

/** Wrap a dataio result as a downloadable response. */
const asDownload = (built, { inline = false } = {}) => ({
  __body: built.buffer ?? built.text,
  __contentType: built.contentType,
  __filename: built.filename,
  __inline: inline,
});

export function registerDataRoutes(r, P) {
  // ===================================================== import
  r.get(`${P}/import/record-types`, async (ctx) => {
    const types = meta.listRecordTypes()
      .filter((t) => rbac.levelFor(ctx.access, meta.getMeta(t).permission) >= LEVEL.CREATE)
      .map((t) => {
        const m = meta.getMeta(t);
        return { type: t, label: m.plural, group: m.group, is_transaction: !!m.isTransaction };
      })
      .sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
    return { record_types: types };
  });

  r.get(`${P}/import/:type/template`, async (ctx) => {
    const m = meta.getMeta(ctx.params.type, ctx.repo);
    if (!m) throw notFound(`Unknown record type "${ctx.params.type}"`);
    rbac.require$(ctx.access, m.permission, LEVEL.CREATE);
    return asDownload(dataio.importTemplate(ctx.repo, ctx.params.type, { format: ctx.query.format === 'xlsx' ? 'xlsx' : 'csv' }));
  });

  r.post(`${P}/import/:type/suggest`, async (ctx) => {
    const m = meta.getMeta(ctx.params.type, ctx.repo);
    if (!m) throw notFound(`Unknown record type "${ctx.params.type}"`);
    rbac.require$(ctx.access, m.permission, LEVEL.CREATE);
    const headers = ctx.body?.headers;
    if (Array.isArray(headers)) return dataio.suggestMapping(ctx.params.type, headers);
    const input = resolveInput(ctx.repo, ctx.body || {});
    const validated = dataio.validateImport(ctx.repo, { record_type: ctx.params.type, ...input });
    return { ...dataio.suggestMapping(ctx.params.type, validated.headers), sample: validated.preview.slice(0, 5) };
  }, { bodyLimit: IMPORT_BODY_LIMIT });

  r.post(`${P}/import/:type/validate`, async (ctx) => {
    const m = meta.getMeta(ctx.params.type, ctx.repo);
    if (!m) throw notFound(`Unknown record type "${ctx.params.type}"`);
    rbac.require$(ctx.access, m.permission, LEVEL.CREATE);
    const b = ctx.body || {};
    const input = resolveInput(ctx.repo, b);
    const out = dataio.validateImport(ctx.repo, {
      record_type: ctx.params.type, ...input, mapping: b.mapping || null,
      defaults: b.defaults || {}, mode: b.mode || 'add', key_field: b.key_field || '',
      delimiter: b.delimiter || null,
    });
    delete out._prepared;                          // internal, and large
    return out;
  }, { bodyLimit: IMPORT_BODY_LIMIT });

  r.post(`${P}/import/:type/commit`, async (ctx) => {
    const m = meta.getMeta(ctx.params.type, ctx.repo);
    if (!m) throw notFound(`Unknown record type "${ctx.params.type}"`);
    rbac.require$(ctx.access, m.permission, LEVEL.CREATE);
    const b = ctx.body || {};
    const input = resolveInput(ctx.repo, b);
    return dataio.commitImport(ctx.repo, {
      record_type: ctx.params.type, ...input, mapping: b.mapping || null,
      defaults: b.defaults || {}, mode: b.mode || 'add', key_field: b.key_field || '',
      delimiter: b.delimiter || null, filename: b.filename || '',
      format: input.parsed ? 'xlsx' : 'csv',
      stop_on_error: b.stop_on_error !== false,
      actor: ctx.user?.id || null,
    });
  }, { bodyLimit: IMPORT_BODY_LIMIT });

  // ============================================== bulk / spreadsheet import
  // "I have a workbook (or a folder of them) from the old system, import all
  // of it" is a different shape of problem from one file into one screen:
  // several sheets, several record types, and an order that matters because
  // an invoice's customer has to exist before the invoice does. These three
  // routes are additive -- every one of them is built from the exact same
  // dataio functions the single-file routes above already use.
  r.post(`${P}/import/workbook`, async (ctx) => {
    rbac.require$(ctx.access, 'data_import', LEVEL.VIEW);
    const b = ctx.body || {};
    const permit = (t) => {
      const info = meta.getMeta(t, ctx.repo);
      return !!info && rbac.levelFor(ctx.access, info.permission) >= LEVEL.CREATE;
    };
    // A bare CSV/TSV is treated as a one-sheet workbook, so the bulk-import
    // screen can enumerate any file the same way regardless of its format --
    // and the file's own name is the hint a workbook sheet would otherwise
    // supply, so "customers.csv" gets the same benefit a tab named
    // "Customers" does.
    if (typeof b.text === 'string') {
      const hintName = String(b.filename || '').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ');
      return dataio.describeText(ctx.repo, b.text, { delimiter: b.delimiter || null, permit, hintName });
    }
    if (typeof b.data !== 'string') throw badRequest('Provide either `text` (CSV) or `data` (base64-encoded spreadsheet contents)');
    let buf;
    try { buf = Buffer.from(b.data, 'base64'); }
    catch { throw badRequest('`data` must be base64-encoded'); }
    return dataio.readWorkbook(ctx.repo, buf, { headerRow: b.header_row || {}, permit });
  }, { bodyLimit: IMPORT_BODY_LIMIT });

  /**
   * Shared prep for both batch routes: turn the client's item list into
   * dataio-ready items, checking every item's own permission -- a batch can
   * span several record types, so one CREATE check up front is not enough --
   * without letting one item outside somebody's role abort the whole batch.
   * An unpermitted item comes back as a normal-looking failed result instead
   * of a thrown error, which is what lets nine good sheets still import
   * alongside the one nobody here is allowed to touch.
   */
  function prepareBatchItems(ctx, rawItems) {
    if (!Array.isArray(rawItems) || !rawItems.length) throw badRequest('`items` must be a non-empty array');
    const items = [];
    const forbidden = [];
    for (const raw of rawItems) {
      // dataio's batch runners spread `tag` onto the top level of each result
      // (`{...item.tag, record_type, ok, ...}`), which is what lets a caller
      // hand back its own identifier -- a sheet key, a row index -- and get
      // it echoed on the matching result. A caller that does not bother
      // supplying one still gets something identifiable, from sheet/filename.
      const tag = raw.tag && typeof raw.tag === 'object' && !Array.isArray(raw.tag)
        ? raw.tag
        : { sheet: raw.sheet ?? null, filename: raw.filename ?? null };
      const type = raw.record_type;
      const m = type && meta.getMeta(type, ctx.repo);
      if (!m) { forbidden.push({ ...tag, record_type: type || null, ok: false, error: `Unknown record type "${type}"` }); continue; }
      if (rbac.levelFor(ctx.access, m.permission) < LEVEL.CREATE) {
        forbidden.push({ ...tag, record_type: type, ok: false, error: `Not permitted to create ${m.plural}` });
        continue;
      }
      let input;
      try { input = resolveInput(ctx.repo, raw); }
      catch (e) { forbidden.push({ ...tag, record_type: type, ok: false, error: e.message }); continue; }
      items.push({
        tag, record_type: type, ...input,
        mapping: raw.mapping || null, defaults: raw.defaults || {},
        mode: raw.mode || 'add', key_field: raw.key_field || '', delimiter: raw.delimiter || null,
        filename: raw.filename || raw.sheet || '', format: input.parsed ? 'xlsx' : 'csv',
        // Matching the single-file screen's own commit button: import the
        // rows that are good and report the rest as skipped, rather than
        // refusing a whole sheet over one bad row -- across a real batch of
        // several years of files, one imperfect row somewhere is the rule,
        // not the exception.
        stop_on_error: raw.stop_on_error === true,
      });
    }
    return { items, forbidden };
  }

  r.post(`${P}/import/batch/validate`, async (ctx) => {
    rbac.require$(ctx.access, 'data_import', LEVEL.CREATE);
    const { items, forbidden } = prepareBatchItems(ctx, (ctx.body || {}).items);
    const results = items.length ? dataio.runBatchValidate(ctx.repo, items) : [];
    return { results: [...forbidden, ...results] };
  }, { bodyLimit: IMPORT_BODY_LIMIT });

  r.post(`${P}/import/batch/commit`, async (ctx) => {
    rbac.require$(ctx.access, 'data_import', LEVEL.CREATE);
    const { items, forbidden } = prepareBatchItems(ctx, (ctx.body || {}).items);
    const out = items.length
      ? dataio.runBatchCommit(ctx.repo, items, { actor: ctx.user?.id || null })
      : { results: [], created: 0, updated: 0, failed: 0 };
    return {
      ...out,
      results: [...forbidden, ...out.results],
      failed: out.failed + forbidden.length,
    };
  }, { bodyLimit: IMPORT_BODY_LIMIT });

  r.get(`${P}/import/jobs`, async (ctx) => {
    rbac.require$(ctx.access, 'data_import', LEVEL.VIEW);
    return {
      jobs: ctx.repo.query(
        'SELECT * FROM import_job WHERE tenant_id = :t ORDER BY created_at DESC LIMIT ?', [int(ctx.query.limit, 50)]),
    };
  });
  r.get(`${P}/import/jobs/:id`, async (ctx) => {
    rbac.require$(ctx.access, 'data_import', LEVEL.VIEW);
    const job = ctx.repo.get('import_job', ctx.params.id);
    if (!job) throw notFound(`Import ${ctx.params.id} not found`);
    return job;
  });
  r.post(`${P}/import/jobs/:id/reverse`, async (ctx) => {
    rbac.require$(ctx.access, 'data_import', LEVEL.FULL);
    return dataio.reverseImport(ctx.repo, ctx.params.id);
  });

  // ===================================================== export
  r.get(`${P}/export/:type`, async (ctx) => {
    const m = meta.getMeta(ctx.params.type, ctx.repo);
    if (!m) throw notFound(`Unknown record type "${ctx.params.type}"`);
    rbac.require$(ctx.access, m.permission, LEVEL.VIEW);
    // CSV stays the default so a bare /export/:type keeps its contract;
    // ?format=xlsx asks for the styled workbook, ?format=json for raw data.
    const format = String(ctx.query.format || 'csv').toLowerCase();
    const limit = Math.min(int(ctx.query.limit, 50_000), 200_000);

    // A saved search (or an ad-hoc definition) exports exactly what the user
    // is looking at, filters and chosen columns included. Without one we fall
    // back to the whole table in its default column order.
    let rows; let columns;
    if (ctx.query.definition) {
      const result = platform.runSearch(ctx.repo, ctx.params.type, safeJson(ctx.query.definition, {}),
        { access: ctx.access, limit });
      rows = result.rows;
      columns = ctx.query.columns ? String(ctx.query.columns).split(',') : result.columns;
    } else {
      columns = ctx.query.columns ? String(ctx.query.columns).split(',') : m.listColumns;
      const where = ['r.tenant_id = :t'];
      const params = [];
      if (m.txnType) { where.push('r.type = ?'); params.push(m.txnType); }
      const rowFilter = rbac.rowFilter(ctx.access, m.table, { alias: 'r' });
      if (rowFilter?.sql) { where.push(rowFilter.sql); params.push(...(rowFilter.params || [])); }
      rows = ctx.repo.query(
        `SELECT r.* FROM ${m.table} r WHERE ${where.join(' AND ')} ORDER BY r.${m.defaultSort || 'id'} LIMIT ?`,
        [...params, limit]);
    }

    // Resolve reference columns to their labels so the file reads as prose.
    const fm = meta.fieldMap(ctx.params.type);
    for (const row of rows) {
      for (const c of columns) {
        const f = fm[c];
        if (f?.type === 'reference' && row[c]) {
          const def = meta.REF_LABEL[f.ref];
          if (!def) continue;
          const hit = ctx.repo.queryOne(`SELECT ${def.cols.join(', ')} FROM ${def.table} WHERE tenant_id = :t AND id = ?`, [row[c]]);
          if (hit) row[`${c}_label`] = def.label(hit);
        }
      }
    }
    return asDownload(dataio.buildExport({
      format, recordType: ctx.params.type, columns, rows,
      title: m.plural, subtitle: `${rows.length} record${rows.length === 1 ? '' : 's'} · exported ${today()} · ${ctx.tenant?.name || ''}`.trim(),
      currency: ctx.tenant?.base_currency || 'USD',
    }));
  });

  // A financial statement pack: several sheets, ready to send on.
  r.get(`${P}/export/reports/pack`, async (ctx) => {
    rbac.require$(ctx.access, 'account', LEVEL.VIEW);
    const to = ctx.query.to || today();
    // Default to the company's own fiscal year, which is not always January.
    const from = ctx.query.from || reports.fiscalYearStart(ctx.repo, to);
    const subsidiaryId = ctx.query.subsidiary_id || null;

    const pl = reports.incomeStatement(ctx.repo, { from, to, subsidiaryId });
    const bs = reports.balanceSheet(ctx.repo, { asOf: to, subsidiaryId });
    const tb = reports.trialBalance(ctx.repo, { from, to, subsidiaryId });
    const ar = reports.arAging(ctx.repo, { asOf: to });

    const lineCols = [
      { key: 'number', label: 'Account', type: 'text' },
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'amount', label: 'Amount', type: 'money' },
    ];
    const flatten = (groups) => (groups || []).flatMap((g) => [
      { number: '', name: g.label || g.name || '', amount: null },
      ...(g.accounts || g.lines || []).map((a) => ({ number: a.number, name: a.name, amount: a.amount ?? a.balance })),
    ]);

    const built = dataio.buildExport({
      // The pack is a workbook by default; ?format=pdf sends the same four
      // statements as a paginated document instead.
      format: ctx.query.format === 'pdf' ? 'pdf' : 'xlsx', columns: lineCols, rows: [],
      currency: ctx.tenant?.base_currency || 'USD',
      title: 'Financial statements',
      sheets: [
        {
          name: 'Profit & Loss', title: 'Profit and Loss',
          subtitle: `${from} to ${to} · ${ctx.tenant?.name || ''}`,
          columns: lineCols,
          rows: flatten(pl.sections || pl.groups || []),
          totals: { number: 'Net income', amount: pl.net_income },
        },
        {
          name: 'Balance Sheet', title: 'Balance Sheet',
          subtitle: `As at ${to} · ${ctx.tenant?.name || ''}`,
          columns: lineCols,
          rows: flatten(bs.sections || bs.groups || []),
          totals: { number: 'Total assets', amount: bs.total_assets },
        },
        {
          name: 'Trial Balance', title: 'Trial Balance',
          subtitle: `${from} to ${to}`,
          columns: [
            { key: 'number', label: 'Account', type: 'text' },
            { key: 'name', label: 'Name', type: 'text' },
            { key: 'debit', label: 'Debit', type: 'money' },
            { key: 'credit', label: 'Credit', type: 'money' },
          ],
          rows: tb.rows || tb.lines || [],
          totals: { number: 'Total', debit: tb.total_debit, credit: tb.total_credit },
        },
        {
          name: 'AR Ageing', title: 'Receivables Ageing',
          subtitle: `As at ${to}`,
          columns: [
            { key: 'entity_name', label: 'Customer', type: 'text' },
            { key: 'txn_no', label: 'Invoice', type: 'text' },
            { key: 'due_date', label: 'Due', type: 'date' },
            { key: 'days_overdue', label: 'Days overdue', type: 'integer' },
            { key: 'band', label: 'Band', type: 'text' },
            { key: 'outstanding', label: 'Outstanding', type: 'money' },
          ],
          rows: ar.rows || ar.invoices || [],
          totals: { entity_name: 'Total', outstanding: ar.total },
        },
      ],
    });
    built.filename = `financial-statements-${to}.${ctx.query.format === 'pdf' ? 'pdf' : 'xlsx'}`;
    return asDownload(built);
  });

  // ============================================ bank statement files
  r.get(`${P}/bank/statement-formats`, async (ctx) => ({
    formats: [
      { id: 'auto', label: 'Detect automatically' },
      { id: 'ofx', label: 'OFX (Open Financial Exchange)' },
      { id: 'qfx', label: 'QFX (Quicken)' },
      { id: 'bai2', label: 'BAI2 (bank administration institute)' },
      { id: 'camt053', label: 'CAMT.053 (ISO 20022 XML)' },
      { id: 'csv', label: 'CSV' },
    ],
  }));

  r.post(`${P}/bank/statements/preview`, async (ctx) => {
    rbac.require$(ctx.access, 'bank_txn', LEVEL.VIEW);
    const text = ctx.body?.text;
    if (!text) throw badRequest('`text` (the file contents) is required');
    const parsed = bankfiles.parseStatement(text, { format: ctx.body?.format || null });
    return {
      ...parsed,
      transactions: parsed.transactions.slice(0, 100),
      transaction_count: parsed.transactions.length,
    };
  });

  r.post(`${P}/bank/statements/import`, async (ctx) => {
    rbac.require$(ctx.access, 'bank_txn', LEVEL.CREATE);
    const b = ctx.body || {};
    if (!b.bank_account_id) throw badRequest('`bank_account_id` is required');
    if (!b.text) throw badRequest('`text` (the file contents) is required');
    return bankfiles.importStatement(ctx.repo, {
      bank_account_id: b.bank_account_id, text: b.text,
      format: b.format || null, filename: b.filename || '',
    });
  });

  // ============================================= Power BI / OData
  r.get(`${P}/powerbi/connection`, async (ctx) => {
    rbac.require$(ctx.access, 'account', LEVEL.VIEW);
    const base = baseUrlOf(ctx);
    return {
      odata_url: `${base}/odata/v1`,
      metadata_url: `${base}/odata/v1/$metadata`,
      pbids_url: `${base}/api/v1/powerbi/meridian.pbids`,
      authentication: 'Basic — use any username and an API token as the password',
      create_token_at: '/data/connect',
      feeds: odata.visibleSets(ctx.access).map((s) => ({ name: s.name, title: s.title, url: `${base}/odata/v1/${s.name}` })),
      instructions: [
        'Create an API token below, and copy it — it is shown only once.',
        'In Power BI Desktop choose Get Data → OData feed.',
        `Paste ${base}/odata/v1 and choose Basic authentication.`,
        'Sign in with your email address as the username and the token as the password.',
        'Pick the tables you want and load. Refresh re-reads live data.',
      ],
    };
  });

  // A .pbids opens Power BI Desktop straight at the connection dialog.
  r.get(`${P}/powerbi/meridian.pbids`, async (ctx) => {
    rbac.require$(ctx.access, 'account', LEVEL.VIEW);
    return {
      __body: odata.pbids(`${baseUrlOf(ctx)}/odata/v1`),
      __contentType: 'application/json',
      __filename: 'meridian.pbids',
    };
  });

  // Power BI's own CSV exports come back through the normal importer; this
  // route just confirms the shape before someone maps it.
  r.post(`${P}/powerbi/inspect`, async (ctx) => {
    const text = ctx.body?.text;
    if (!text) throw badRequest('`text` (the file contents) is required');
    const type = ctx.body?.record_type;
    if (type && !meta.getMeta(type)) throw notFound(`Unknown record type "${type}"`);
    // Inspecting a file matches its rows against records that already exist,
    // so it needs the same sight of them the importer does.
    rbac.require$(ctx.access, meta.getMeta(type || 'customer').permission, LEVEL.VIEW);
    const validated = dataio.validateImport(ctx.repo, { record_type: type || 'customer', text });
    return {
      headers: validated.headers, rows: validated.total_rows,
      delimiter: validated.delimiter,
      suggested_mapping: type ? validated.mapping : null,
      sample: validated.preview.slice(0, 5),
    };
  });

  return r;
}

/** OData lives outside /api/v1 because BI tools expect a service root. */
/**
 * SuiteTalk-style SOAP service. The WSDL is generated from the same metadata
 * registry as everything else, so a record type added there is immediately
 * addressable over SOAP.
 */
export function registerSoapRoutes(r) {
  const S = '/soap/v1';

  // Most SOAP toolkits fetch the contract from ?wsdl on the endpoint itself.
  r.get(S, async (ctx) => ({
    __body: soap.wsdl(ctx.access, `${baseUrlOf(ctx)}${S}`),
    __contentType: 'text/xml;charset=utf-8',
    __filename: 'meridian.wsdl',
    __inline: true,
  }));
  r.get(`${S}/wsdl`, async (ctx) => ({
    __body: soap.wsdl(ctx.access, `${baseUrlOf(ctx)}${S}`),
    __contentType: 'text/xml;charset=utf-8',
    __filename: 'meridian.wsdl',
    __inline: true,
  }));

  r.post(S, async (ctx) => {
    const body = typeof ctx.body === 'string' ? ctx.body : '';
    if (!body.trim()) {
      return { __status: 400, __body: soap.fault('soap:Client', 'The request had no XML body'),
        __contentType: 'text/xml;charset=utf-8' };
    }
    const result = soap.handle({
      repo: ctx.repo, access: ctx.access, user: ctx.user, tenant: ctx.tenant,
      tx: ctx.tx, baseUrl: baseUrlOf(ctx),
    }, body);
    return { __status: result.status, __body: result.xml, __contentType: 'text/xml;charset=utf-8' };
  });

  return r;
}

export function registerODataRoutes(r) {
  const O = '/odata/v1';

  r.get(O, async (ctx) => ({
    __body: JSON.stringify(odata.serviceDocument(ctx.access, `${baseUrlOf(ctx)}${O}`)),
    __contentType: 'application/json;odata.metadata=minimal;charset=utf-8',
    __headers: { 'OData-Version': '4.0' },
  }));

  r.get(`${O}/$metadata`, async (ctx) => ({
    __body: odata.metadataXml(ctx.access),
    __contentType: 'application/xml;charset=utf-8',
    __headers: { 'OData-Version': '4.0' },
  }));

  r.get(`${O}/:set`, async (ctx) => {
    const base = `${baseUrlOf(ctx)}${O}`;
    const payload = odata.readSet(ctx.repo, ctx.access, ctx.params.set, ctx.query, base);
    return {
      __body: JSON.stringify(payload),
      __contentType: 'application/json;odata.metadata=minimal;charset=utf-8',
      __headers: { 'OData-Version': '4.0' },
    };
  });

  r.get(`${O}/:set/$count`, async (ctx) => {
    const payload = odata.readSet(ctx.repo, ctx.access, ctx.params.set, { ...ctx.query, $count: 'true', $top: '1' }, '');
    return { __body: String(payload['@odata.count'] ?? 0), __contentType: 'text/plain;charset=utf-8' };
  });

  return r;
}
