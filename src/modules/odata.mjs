// Meridian ERP :: modules/odata
// An OData v4 feed, which is what Power BI, Excel and Tableau all speak
// natively for "connect to a live source".
//
// This is deliberately a read model, not a mirror of the tables. Money comes
// out as decimals rather than minor units, references carry their label
// beside the id, and the derived analytics sets (P&L by period, AR ageing,
// pipeline) are exposed as first-class entity sets -- because the point of
// connecting a BI tool is to get the figures the business talks about, not
// to re-implement the ledger in DAX.
import { Money, Qty, nowIso, today } from '../core/util.mjs';
import { badRequest, notFound } from '../core/http.mjs';
import * as meta from './meta.mjs';
import * as rbac from '../core/rbac.mjs';
import * as reports from './reports.mjs';

const NS = 'Meridian';
const CONTAINER = 'Data';

/** EDM type for each of our field types. */
const EDM = {
  text: 'Edm.String', longtext: 'Edm.String', select: 'Edm.String', email: 'Edm.String',
  phone: 'Edm.String', url: 'Edm.String', json: 'Edm.String', reference: 'Edm.String',
  formula: 'Edm.String', multiselect: 'Edm.String',
  number: 'Edm.Double', percent: 'Edm.Double', qty: 'Edm.Decimal', money: 'Edm.Decimal',
  integer: 'Edm.Int64', checkbox: 'Edm.Boolean',
  date: 'Edm.Date', datetime: 'Edm.DateTimeOffset',
};

/**
 * Entity set name for a record type.
 *
 * Built from the curated plural label rather than by appending an "s" to the
 * type name, which produces "Activitys" and "AssetClasss". These names are
 * what a person picks from a list in Power BI, so they have to read properly.
 */
export const setNameFor = (recordType) => {
  const m = meta.getMeta(recordType);
  const source = m?.plural || recordType.replace(/_/g, ' ') + 's';
  const name = source.replace(/[^A-Za-z0-9 ]/g, ' ')
    .split(/\s+/).filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
  return /^[A-Za-z]/.test(name) ? name : `Set${name}`;
};

/**
 * Set name -> record type. Two record types can produce the same label
 * (Chart of Accounts and Accounts, say), so the first one registered keeps
 * the name and later collisions fall back to the type name.
 */
const RECORD_FOR_SET = () => {
  const map = new Map();
  const taken = new Set();
  for (const t of meta.listRecordTypes()) {
    let name = setNameFor(t);
    if (taken.has(name.toLowerCase())) {
      name = t.split('_').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
    }
    taken.add(name.toLowerCase());
    map.set(name.toLowerCase(), t);
  }
  return map;
};

/** The unique set name actually used for a record type. */
export function resolvedSetName(recordType) {
  for (const [name, type] of RECORD_FOR_SET()) if (type === recordType) return setNameFor(type) .toLowerCase() === name ? setNameFor(type) : name;
  return setNameFor(recordType);
}

/** Derived sets that are computed rather than stored. */
export const ANALYTIC_SETS = {
  ProfitAndLoss: {
    title: 'Profit and loss by account and period',
    columns: [
      { name: 'PeriodName', type: 'Edm.String' }, { name: 'PeriodStart', type: 'Edm.Date' },
      { name: 'PeriodEnd', type: 'Edm.Date' }, { name: 'FiscalYear', type: 'Edm.Int64' },
      { name: 'AccountNumber', type: 'Edm.String' }, { name: 'AccountName', type: 'Edm.String' },
      { name: 'AccountType', type: 'Edm.String' }, { name: 'Subtype', type: 'Edm.String' },
      { name: 'SubsidiaryName', type: 'Edm.String' }, { name: 'Amount', type: 'Edm.Decimal' },
    ],
    rows(repo) {
      return repo.query(`
        SELECT p.name AS PeriodName, p.start_date AS PeriodStart, p.end_date AS PeriodEnd, p.fiscal_year AS FiscalYear,
               a.number AS AccountNumber, a.name AS AccountName, a.type AS AccountType,
               COALESCE(a.subtype,'') AS Subtype, s.name AS SubsidiaryName,
               SUM(CASE WHEN a.type = 'INCOME' THEN b.base_credit - b.base_debit
                        ELSE b.base_debit - b.base_credit END) AS AmountMinor
        FROM gl_balance b
        JOIN account a ON a.tenant_id = b.tenant_id AND a.id = b.account_id
        JOIN accounting_period p ON p.tenant_id = b.tenant_id AND p.id = b.period_id
        JOIN subsidiary s ON s.tenant_id = b.tenant_id AND s.id = b.subsidiary_id
        WHERE b.tenant_id = :t AND a.type IN ('INCOME','EXPENSE')
        GROUP BY p.id, a.id, s.id
        ORDER BY p.start_date, a.number`)
        .map((r) => ({ ...r, Amount: Money.toNumber(r.AmountMinor), AmountMinor: undefined }));
    },
  },
  TrialBalance: {
    title: 'Trial balance by account and period',
    columns: [
      { name: 'PeriodName', type: 'Edm.String' }, { name: 'PeriodEnd', type: 'Edm.Date' },
      { name: 'AccountNumber', type: 'Edm.String' }, { name: 'AccountName', type: 'Edm.String' },
      { name: 'AccountType', type: 'Edm.String' }, { name: 'SubsidiaryName', type: 'Edm.String' },
      { name: 'Debit', type: 'Edm.Decimal' }, { name: 'Credit', type: 'Edm.Decimal' },
      { name: 'Balance', type: 'Edm.Decimal' },
    ],
    rows(repo) {
      return repo.query(`
        SELECT p.name AS PeriodName, p.end_date AS PeriodEnd,
               a.number AS AccountNumber, a.name AS AccountName, a.type AS AccountType, s.name AS SubsidiaryName,
               SUM(b.base_debit) AS D, SUM(b.base_credit) AS C
        FROM gl_balance b
        JOIN account a ON a.tenant_id = b.tenant_id AND a.id = b.account_id
        JOIN accounting_period p ON p.tenant_id = b.tenant_id AND p.id = b.period_id
        JOIN subsidiary s ON s.tenant_id = b.tenant_id AND s.id = b.subsidiary_id
        WHERE b.tenant_id = :t GROUP BY p.id, a.id, s.id ORDER BY p.start_date, a.number`)
        .map((r) => ({
          PeriodName: r.PeriodName, PeriodEnd: r.PeriodEnd, AccountNumber: r.AccountNumber,
          AccountName: r.AccountName, AccountType: r.AccountType, SubsidiaryName: r.SubsidiaryName,
          Debit: Money.toNumber(r.D), Credit: Money.toNumber(r.C), Balance: Money.toNumber(r.D - r.C),
        }));
    },
  },
  SalesFact: {
    title: 'Invoice lines: the grain a sales model actually wants',
    columns: [
      { name: 'InvoiceNo', type: 'Edm.String' }, { name: 'Date', type: 'Edm.Date' },
      { name: 'CustomerName', type: 'Edm.String' }, { name: 'CustomerNo', type: 'Edm.String' },
      { name: 'Sku', type: 'Edm.String' }, { name: 'ItemName', type: 'Edm.String' },
      { name: 'Description', type: 'Edm.String' }, { name: 'Quantity', type: 'Edm.Decimal' },
      { name: 'UnitPrice', type: 'Edm.Decimal' }, { name: 'LineAmount', type: 'Edm.Decimal' },
      { name: 'Cost', type: 'Edm.Decimal' }, { name: 'Margin', type: 'Edm.Decimal' },
      { name: 'SalesRep', type: 'Edm.String' }, { name: 'LocationName', type: 'Edm.String' },
      { name: 'SubsidiaryName', type: 'Edm.String' }, { name: 'Status', type: 'Edm.String' },
    ],
    rows(repo) {
      return repo.query(`
        SELECT t.txn_no AS InvoiceNo, t.txn_date AS Date, t.status AS Status,
               c.name AS CustomerName, COALESCE(c.entity_no,'') AS CustomerNo,
               COALESCE(i.sku,'') AS Sku, COALESCE(i.name,'') AS ItemName,
               COALESCE(tl.description,'') AS Description,
               tl.quantity AS Q, tl.unit_price AS R, tl.amount AS A,
               COALESCE(i.standard_cost,0) AS UC,
               COALESCE((e.first_name || ' ' || e.last_name),'') AS SalesRep, COALESCE(l.name,'') AS LocationName,
               s.name AS SubsidiaryName
        FROM txn_line tl
        JOIN txn t ON t.tenant_id = tl.tenant_id AND t.id = tl.txn_id
        LEFT JOIN customer c ON c.tenant_id = t.tenant_id AND c.id = t.entity_id
        LEFT JOIN item i ON i.tenant_id = tl.tenant_id AND i.id = tl.item_id
        LEFT JOIN employee e ON e.tenant_id = t.tenant_id AND e.id = t.sales_rep_id
        LEFT JOIN location l ON l.tenant_id = t.tenant_id AND l.id = t.location_id
        JOIN subsidiary s ON s.tenant_id = t.tenant_id AND s.id = t.subsidiary_id
        WHERE tl.tenant_id = :t AND t.type = 'INVOICE' AND t.status != 'voided'
        ORDER BY t.txn_date DESC`)
        .map((r) => {
          const qty = Qty.toNumber(r.Q);
          const cost = Qty.extend(r.Q, r.UC);
          return {
            InvoiceNo: r.InvoiceNo, Date: r.Date, CustomerName: r.CustomerName, CustomerNo: r.CustomerNo,
            Sku: r.Sku, ItemName: r.ItemName, Description: r.Description,
            Quantity: qty, UnitPrice: Money.toNumber(r.R), LineAmount: Money.toNumber(r.A),
            Cost: Money.toNumber(cost), Margin: Money.toNumber(r.A - cost),
            SalesRep: r.SalesRep, LocationName: r.LocationName, SubsidiaryName: r.SubsidiaryName, Status: r.Status,
          };
        });
    },
  },
  ReceivablesAgeing: {
    title: 'Open receivables with an ageing band',
    columns: [
      { name: 'InvoiceNo', type: 'Edm.String' }, { name: 'Date', type: 'Edm.Date' },
      { name: 'DueDate', type: 'Edm.Date' }, { name: 'CustomerName', type: 'Edm.String' },
      { name: 'Total', type: 'Edm.Decimal' }, { name: 'Outstanding', type: 'Edm.Decimal' },
      { name: 'DaysOverdue', type: 'Edm.Int64' }, { name: 'Band', type: 'Edm.String' },
    ],
    rows(repo) {
      const now = today();
      return repo.query(`
        SELECT t.txn_no AS InvoiceNo, t.txn_date AS Date, t.due_date AS DueDate,
               COALESCE(c.name,'') AS CustomerName, t.total AS T, t.amount_remaining AS O
        FROM txn t LEFT JOIN customer c ON c.tenant_id = t.tenant_id AND c.id = t.entity_id
        WHERE t.tenant_id = :t AND t.type = 'INVOICE' AND t.status != 'voided' AND t.amount_remaining > 0
        ORDER BY t.due_date`)
        .map((r) => {
          const days = r.DueDate ? Math.floor((Date.parse(now) - Date.parse(r.DueDate)) / 86400000) : 0;
          const band = days <= 0 ? 'Current' : days <= 30 ? '1-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+';
          return {
            InvoiceNo: r.InvoiceNo, Date: r.Date, DueDate: r.DueDate, CustomerName: r.CustomerName,
            Total: Money.toNumber(r.T), Outstanding: Money.toNumber(r.O),
            DaysOverdue: Math.max(0, days), Band: band,
          };
        });
    },
  },
  InventoryPosition: {
    title: 'Stock on hand and its value by item and location',
    columns: [
      { name: 'Sku', type: 'Edm.String' }, { name: 'ItemName', type: 'Edm.String' },
      { name: 'LocationName', type: 'Edm.String' }, { name: 'OnHand', type: 'Edm.Decimal' },
      { name: 'Committed', type: 'Edm.Decimal' }, { name: 'Available', type: 'Edm.Decimal' },
      { name: 'OnOrder', type: 'Edm.Decimal' }, { name: 'AverageCost', type: 'Edm.Decimal' },
      { name: 'TotalValue', type: 'Edm.Decimal' }, { name: 'ReorderPoint', type: 'Edm.Decimal' },
      { name: 'BelowReorder', type: 'Edm.Boolean' },
    ],
    rows(repo) {
      return repo.query(`
        SELECT i.sku AS Sku, i.name AS ItemName, l.name AS LocationName,
               il.qty_on_hand AS OH, il.qty_committed AS CM, il.qty_on_order AS OO,
               il.avg_cost AS AC, il.total_value AS TV, il.reorder_point AS RP
        FROM item_location il
        JOIN item i ON i.tenant_id = il.tenant_id AND i.id = il.item_id
        JOIN location l ON l.tenant_id = il.tenant_id AND l.id = il.location_id
        WHERE il.tenant_id = :t ORDER BY i.sku, l.name`)
        .map((r) => ({
          Sku: r.Sku, ItemName: r.ItemName, LocationName: r.LocationName,
          OnHand: Qty.toNumber(r.OH), Committed: Qty.toNumber(r.CM),
          Available: Qty.toNumber(r.OH - r.CM), OnOrder: Qty.toNumber(r.OO),
          AverageCost: Money.toNumber(r.AC), TotalValue: Money.toNumber(r.TV),
          ReorderPoint: Qty.toNumber(r.RP), BelowReorder: (r.OH - r.CM) < r.RP,
        }));
    },
  },
  Pipeline: {
    title: 'Open opportunities weighted by probability',
    columns: [
      { name: 'Name', type: 'Edm.String' }, { name: 'CustomerName', type: 'Edm.String' },
      { name: 'Stage', type: 'Edm.String' }, { name: 'ForecastCategory', type: 'Edm.String' },
      { name: 'Amount', type: 'Edm.Decimal' }, { name: 'Probability', type: 'Edm.Double' },
      { name: 'Weighted', type: 'Edm.Decimal' }, { name: 'ExpectedClose', type: 'Edm.Date' },
      { name: 'ActualClose', type: 'Edm.Date' }, { name: 'IsOpen', type: 'Edm.Boolean' },
      { name: 'Owner', type: 'Edm.String' },
    ],
    rows(repo) {
      return repo.query(`
        SELECT o.name AS Name, COALESCE(c.name,'') AS CustomerName, o.stage AS Stage,
               COALESCE(o.forecast_category,'') AS ForecastCategory,
               o.amount AS A, o.probability AS P, o.expected_close AS ExpectedClose,
               o.actual_close AS ActualClose,
               COALESCE((e.first_name || ' ' || e.last_name),'') AS Owner
        FROM opportunity o
        LEFT JOIN customer c ON c.tenant_id = o.tenant_id AND c.id = o.customer_id
        LEFT JOIN employee e ON e.tenant_id = o.tenant_id AND e.id = o.sales_rep_id
        WHERE o.tenant_id = :t ORDER BY o.expected_close`)
        .map((r) => ({
          Name: r.Name, CustomerName: r.CustomerName, Stage: r.Stage,
          ForecastCategory: r.ForecastCategory,
          Amount: Money.toNumber(r.A), Probability: r.P,
          Weighted: Money.toNumber(Math.round((r.A || 0) * (r.P || 0) / 100)),
          ExpectedClose: r.ExpectedClose, ActualClose: r.ActualClose,
          IsOpen: !r.ActualClose, Owner: r.Owner,
        }));
    },
  },
};

/** Which entity sets this user may read. */
export function visibleSets(access) {
  const sets = [];
  for (const type of meta.listRecordTypes()) {
    const m = meta.getMeta(type);
    if (rbac.levelFor(access, m.permission) < rbac.LEVEL.VIEW) continue;
    sets.push({ name: resolvedSetName(type), recordType: type, kind: 'record', title: m.plural });
  }
  for (const [name, def] of Object.entries(ANALYTIC_SETS)) {
    if (rbac.levelFor(access, 'account') < rbac.LEVEL.VIEW) continue;
    sets.push({ name, kind: 'analytic', title: def.title });
  }
  return sets.sort((a, b) => a.name.localeCompare(b.name));
}

const xmlEsc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The $metadata document Power BI reads to learn the shape of the feed. */
export function metadataXml(access) {
  const sets = visibleSets(access);
  const types = [];
  const entitySets = [];

  for (const s of sets) {
    if (s.kind === 'record') {
      const m = meta.getMeta(s.recordType);
      const props = [
        '<Key><PropertyRef Name="Id"/></Key>',
        '<Property Name="Id" Type="Edm.String" Nullable="false"/>',
        ...m.fields
          .filter((f) => f.type !== 'formula')
          .map((f) => `<Property Name="${xmlEsc(pascal(f.name))}" Type="${EDM[f.type] || 'Edm.String'}"/>`),
        // References also expose their human label, so a report does not have
        // to join back just to show a customer's name.
        ...m.fields.filter((f) => f.type === 'reference')
          .map((f) => `<Property Name="${xmlEsc(pascal(f.name))}Label" Type="Edm.String"/>`),
      ];
      types.push(`<EntityType Name="${s.name}Type">${props.join('')}</EntityType>`);
    } else {
      const def = ANALYTIC_SETS[s.name];
      types.push(`<EntityType Name="${s.name}Type"><Key><PropertyRef Name="RowId"/></Key><Property Name="RowId" Type="Edm.Int64" Nullable="false"/>${
        def.columns.map((c) => `<Property Name="${xmlEsc(c.name)}" Type="${c.type}"/>`).join('')}</EntityType>`);
    }
    entitySets.push(`<EntitySet Name="${s.name}" EntityType="${NS}.${s.name}Type"/>`);
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
 <edmx:DataServices>
  <Schema Namespace="${NS}" xmlns="http://docs.oasis-open.org/odata/ns/edm">
   ${types.join('\n   ')}
   <EntityContainer Name="${CONTAINER}">
    ${entitySets.join('\n    ')}
   </EntityContainer>
  </Schema>
 </edmx:DataServices>
</edmx:Edmx>`;
}

const pascal = (s) => String(s).split(/[_.]/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');

/** The service document: the list of feeds Power BI offers to tick. */
export function serviceDocument(access, baseUrl) {
  return {
    '@odata.context': `${baseUrl}/$metadata`,
    value: visibleSets(access).map((s) => ({ name: s.name, kind: 'EntitySet', url: s.name, title: s.title })),
  };
}

/**
 * Parse the slice of $filter that BI tools actually emit into a small tree.
 *
 * A tree rather than a SQL string, because two consumers need it: stored
 * sets compile it to parameterised SQL, and computed sets evaluate it in
 * memory. Producing SQL text and then reverse-engineering a predicate out of
 * it -- or worse, building a function from a string -- would turn a query
 * parameter into executable code. Every literal here stays data.
 */
export function parseFilter(expr, columnFor) {
  const tokens = String(expr).match(/'(?:[^']|'')*'|[(),]|[A-Za-z_][A-Za-z0-9_/]*|-?[0-9][0-9.]*|\S/g) || [];
  let i = 0;
  const peek = () => tokens[i];
  const take = () => tokens[i++];
  const expect = (t) => { if (take() !== t) throw badRequest(`Expected "${t}" in $filter`); };

  const OPS = new Set(['eq', 'ne', 'gt', 'ge', 'lt', 'le']);
  const literal = (tok) => {
    if (tok === undefined) throw badRequest('$filter ended unexpectedly');
    if (tok.startsWith("'")) return tok.slice(1, -1).replace(/''/g, "'");
    if (/^-?[0-9][0-9.]*$/.test(tok)) return Number(tok);
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    throw badRequest(`Expected a value in $filter but found "${tok}"`);
  };
  const column = (tok) => {
    const col = columnFor(tok);
    if (!col) throw badRequest(`Unknown field "${tok}" in $filter`);
    return col;
  };

  const comparison = () => {
    if (peek() === '(') { take(); const inner = orExpr(); expect(')'); return inner; }
    if (/^(contains|startswith|endswith)$/i.test(peek() || '')) {
      const fn = take().toLowerCase();
      expect('(');
      const col = column(take());
      expect(',');
      const value = literal(take());
      expect(')');
      return { kind: 'like', col, fn, value: String(value) };
    }
    const col = column(take());
    const op = String(take() || '').toLowerCase();
    if (!OPS.has(op)) throw badRequest(`Unsupported operator "${op}" in $filter`);
    return { kind: 'cmp', col, op, value: literal(take()) };
  };
  const andExpr = () => {
    let node = comparison();
    while (String(peek() || '').toLowerCase() === 'and') { take(); node = { kind: 'and', left: node, right: comparison() }; }
    return node;
  };
  const orExpr = () => {
    let node = andExpr();
    while (String(peek() || '').toLowerCase() === 'or') { take(); node = { kind: 'or', left: node, right: andExpr() }; }
    return node;
  };

  const ast = orExpr();
  if (i < tokens.length) throw badRequest(`Could not parse the whole of $filter near "${tokens[i]}"`);
  return ast;
}

const SQL_OP = { eq: '=', ne: '!=', gt: '>', ge: '>=', lt: '<', le: '<=' };

/** Compile a filter tree to parameterised SQL. */
export function filterToSql(ast, params = []) {
  switch (ast.kind) {
    case 'and': return `(${filterToSql(ast.left, params)} AND ${filterToSql(ast.right, params)})`;
    case 'or': return `(${filterToSql(ast.left, params)} OR ${filterToSql(ast.right, params)})`;
    case 'like':
      params.push(ast.fn === 'contains' ? `%${ast.value}%` : ast.fn === 'startswith' ? `${ast.value}%` : `%${ast.value}`);
      return `${ast.col} LIKE ?`;
    case 'cmp': {
      if (ast.value === null) return `${ast.col} IS ${ast.op === 'eq' ? '' : 'NOT '}NULL`;
      params.push(typeof ast.value === 'boolean' ? (ast.value ? 1 : 0) : ast.value);
      return `${ast.col} ${SQL_OP[ast.op]} ?`;
    }
    default: throw badRequest('Unsupported $filter');
  }
}

/** Evaluate a filter tree against a plain object. */
export function filterMatches(ast, row) {
  switch (ast.kind) {
    case 'and': return filterMatches(ast.left, row) && filterMatches(ast.right, row);
    case 'or': return filterMatches(ast.left, row) || filterMatches(ast.right, row);
    case 'like': {
      const hay = String(row[ast.col] ?? '').toLowerCase();
      const needle = ast.value.toLowerCase();
      return ast.fn === 'contains' ? hay.includes(needle)
        : ast.fn === 'startswith' ? hay.startsWith(needle) : hay.endsWith(needle);
    }
    case 'cmp': {
      const a = row[ast.col];
      const b = ast.value;
      switch (ast.op) {
        case 'eq': return b === null ? a === null || a === undefined : a === b;
        case 'ne': return b === null ? !(a === null || a === undefined) : a !== b;
        case 'gt': return a > b;
        case 'ge': return a >= b;
        case 'lt': return a < b;
        case 'le': return a <= b;
        default: return false;
      }
    }
    default: return false;
  }
}

/** Read one entity set, applying the OData query options Power BI sends. */
export function readSet(repo, access, setName, query = {}, baseUrl = '') {
  const analytic = ANALYTIC_SETS[setName];
  const recordType = RECORD_FOR_SET().get(String(setName).toLowerCase());
  if (!analytic && !recordType) throw notFound(`No entity set named "${setName}"`);

  const top = Math.min(Number(query.$top) || 100_000, 250_000);
  const skip = Number(query.$skip) || 0;
  const wantCount = query.$count === 'true';

  if (analytic) {
    if (rbac.levelFor(access, 'account') < rbac.LEVEL.VIEW) throw badRequest('Not permitted to read this feed');
    let rows = analytic.rows(repo).map((r, idx) => ({ RowId: idx + 1, ...r }));
    if (query.$filter) {
      const cols = new Map(analytic.columns.map((c) => [c.name.toLowerCase(), c.name]));
      cols.set('rowid', 'RowId');
      const ast = parseFilter(query.$filter, (f) => cols.get(String(f).toLowerCase()));
      rows = rows.filter((r) => filterMatches(ast, r));
    }
    if (query.$orderby) rows = orderInMemory(rows, query.$orderby);
    const total = rows.length;
    const page = rows.slice(skip, skip + top);
    return {
      '@odata.context': `${baseUrl}/$metadata#${setName}`,
      ...(wantCount ? { '@odata.count': total } : {}),
      value: query.$select ? project(page, String(query.$select).split(',').map((s) => s.trim())) : page,
    };
  }

  const m = meta.getMeta(recordType);
  rbac.require$(access, m.permission, rbac.LEVEL.VIEW);

  const fields = m.fields.filter((f) => f.type !== 'formula');
  const byPascal = new Map(fields.map((f) => [pascal(f.name).toLowerCase(), f]));
  byPascal.set('id', { name: 'id', type: 'text' });

  const where = ['r.tenant_id = :t'];
  const params = [];
  if (m.txnType) { where.push('r.type = ?'); params.push(m.txnType); }
  if (query.$filter) {
    const ast = parseFilter(query.$filter, (f) => {
      const hit = byPascal.get(String(f).toLowerCase());
      return hit ? `r.${hit.name}` : null;
    });
    const p = [];
    where.push(filterToSql(ast, p));
    params.push(...p);
  }
  const rowFilter = rbac.rowFilter(access, m.table, { alias: 'r' });
  if (rowFilter?.sql) { where.push(rowFilter.sql); params.push(...(rowFilter.params || [])); }

  let orderBy = m.defaultSort ? `r.${m.defaultSort}` : 'r.id';
  if (query.$orderby) {
    const parts = String(query.$orderby).split(',').map((p) => {
      const [name, dir] = p.trim().split(/\s+/);
      const hit = byPascal.get(String(name).toLowerCase());
      if (!hit) throw badRequest(`Cannot order by unknown field "${name}"`);
      return `r.${hit.name} ${String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC'}`;
    });
    orderBy = parts.join(', ');
  }

  const sqlWhere = where.join(' AND ');
  const total = wantCount
    ? repo.queryOne(`SELECT COUNT(*) AS c FROM ${m.table} r WHERE ${sqlWhere}`, params).c
    : undefined;
  const rows = repo.query(
    `SELECT r.* FROM ${m.table} r WHERE ${sqlWhere} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    [...params, top, skip]);

  const refFields = fields.filter((f) => f.type === 'reference');
  const value = rows.map((row) => {
    const out = { Id: row.id };
    for (const f of fields) {
      const key = pascal(f.name);
      const raw = row[f.name];
      out[key] = f.type === 'money' ? Money.toNumber(raw)
        : f.type === 'qty' ? Qty.toNumber(raw)
          : f.type === 'checkbox' ? !!raw
            : f.type === 'json' ? (raw ? JSON.stringify(raw) : null)
              : raw ?? null;
    }
    for (const f of refFields) {
      out[`${pascal(f.name)}Label`] = row[f.name] ? refLabel(repo, f.ref, row[f.name]) : null;
    }
    return out;
  });

  return {
    '@odata.context': `${baseUrl}/$metadata#${setName}`,
    ...(total === undefined ? {} : { '@odata.count': total }),
    value: query.$select ? project(value, String(query.$select).split(',').map((s) => s.trim())) : value,
  };
}

const labelCache = new WeakMap();
function refLabel(repo, refType, id) {
  const def = meta.REF_LABEL[refType];
  if (!def) return null;
  let perRepo = labelCache.get(repo);
  if (!perRepo) { perRepo = new Map(); labelCache.set(repo, perRepo); }
  const key = `${refType}:${id}`;
  if (perRepo.has(key)) return perRepo.get(key);
  const row = repo.queryOne(`SELECT ${def.cols.join(', ')} FROM ${def.table} WHERE tenant_id = :t AND id = ?`, [id]);
  const label = row ? def.label(row) : null;
  perRepo.set(key, label);
  return label;
}

const project = (rows, keys) => rows.map((r) => Object.fromEntries(keys.filter((k) => k in r).map((k) => [k, r[k]])));

function orderInMemory(rows, orderby) {
  const specs = String(orderby).split(',').map((p) => {
    const [name, dir] = p.trim().split(/\s+/);
    return { name, desc: String(dir).toLowerCase() === 'desc' };
  });
  return [...rows].sort((a, b) => {
    for (const s of specs) {
      const av = a[s.name], bv = b[s.name];
      if (av === bv) continue;
      const cmp = av === null || av === undefined ? -1 : bv === null || bv === undefined ? 1
        : typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return s.desc ? -cmp : cmp;
    }
    return 0;
  });
}

/**
 * A .pbids file: Power BI Desktop opens it and goes straight to the
 * connection dialog for this feed, so nobody has to paste a URL.
 */
export function pbids(baseUrl) {
  return JSON.stringify({
    version: '0.1',
    connections: [{
      details: { protocol: 'odata', address: { url: baseUrl } },
      options: {},
      mode: 'Import',
    }],
  }, null, 2);
}
