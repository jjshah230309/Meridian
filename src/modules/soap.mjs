// Meridian ERP :: modules/soap
// A SOAP 1.1 web service in the shape of NetSuite's SuiteTalk: get, getList,
// add, addList, update, upsert, delete, search and getDataCenterUrls, over a
// WSDL generated from the same metadata registry that drives the UI.
//
// Every operation goes through the identical Repo, RBAC and record dispatch as
// the REST API, so a SOAP client cannot reach anything a signed-in user could
// not, and cannot skip document numbering or the audit trail.
import { parseXml, rootOf, find, findAll, kids, textOf, el, raw, escapeXml, declaration, XmlError } from '../core/xml.mjs';
import { badRequest, HttpError, ValidationError } from '../core/http.mjs';
import { Money, Qty, nowIso } from '../core/util.mjs';
import * as rbac from '../core/rbac.mjs';
import * as meta from './meta.mjs';
import * as records from './records.mjs';
import * as platform from './platform.mjs';

const LEVEL = rbac.LEVEL;
export const NS = 'urn:platform.meridian.erp';
const SOAP_ENV = 'http://schemas.xmlsoap.org/soap/envelope/';
const XSD = 'http://www.w3.org/2001/XMLSchema';

// SOAP faults distinguish "you sent something wrong" from "we broke".
const CLIENT = 'soap:Client';
const SERVER = 'soap:Server';

/** An XSD type for each field type in the registry. */
const XSD_TYPE = {
  money: 'xsd:decimal', number: 'xsd:decimal', qty: 'xsd:decimal', percent: 'xsd:decimal',
  integer: 'xsd:int', checkbox: 'xsd:boolean', date: 'xsd:date', datetime: 'xsd:dateTime',
  json: 'xsd:string', reference: 'xsd:string',
};
const xsdTypeFor = (f) => XSD_TYPE[f.type] || 'xsd:string';

/** Record types a SOAP client may address, given its permissions. */
export function visibleTypes(access) {
  return meta.listRecordTypes().filter((t) => {
    const m = meta.getMeta(t);
    return m && rbac.levelFor(access, m.permission) >= LEVEL.VIEW;
  });
}

// PascalCase type name for the WSDL, from the record type key.
const typeName = (t) => t.split('_').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');

// ------------------------------------------------------------------- WSDL

export function wsdl(access, endpoint) {
  const types = visibleTypes(access);

  const complexTypes = types.map((t) => {
    const m = meta.getMeta(t);
    const fields = m.fields.filter((f) => f.type !== 'formula');
    return raw('xsd:complexType', { name: typeName(t) }, raw('xsd:sequence', null,
      [el('xsd:element', { name: 'internalId', type: 'xsd:string', minOccurs: '0' }),
        ...fields.map((f) => el('xsd:element', {
          name: f.name, type: xsdTypeFor(f), minOccurs: '0', nillable: 'true',
        }))].join('')));
  }).join('');

  // The record wrapper is a choice so one message shape carries any type.
  const recordType = raw('xsd:complexType', { name: 'Record' }, [
    raw('xsd:choice', null, types.map((t) =>
      el('xsd:element', { name: t, type: `tns:${typeName(t)}`, minOccurs: '0' })).join('')),
    el('xsd:attribute', { name: 'type', type: 'xsd:string' }),
  ].join(''));

  const messages = [
    ['get', ['recordRef']], ['getList', ['recordRefList']],
    ['add', ['record']], ['addList', ['recordList']],
    ['update', ['record']], ['upsert', ['record']],
    ['delete', ['recordRef']], ['search', ['searchRecord']],
    ['getDataCenterUrls', []],
  ];

  const elements = messages.flatMap(([op, parts]) => [
    raw('xsd:element', { name: op }, raw('xsd:complexType', null,
      raw('xsd:sequence', null, parts.map((p) => el('xsd:element', { name: p, type: 'xsd:anyType', minOccurs: '0' })).join('')))),
    raw('xsd:element', { name: `${op}Response` }, raw('xsd:complexType', null,
      raw('xsd:sequence', null, el('xsd:element', { name: 'result', type: 'tns:Result' })))),
  ]).join('');

  const resultType = raw('xsd:complexType', { name: 'Result' }, raw('xsd:sequence', null, [
    el('xsd:element', { name: 'status', type: 'tns:Status' }),
    el('xsd:element', { name: 'totalRecords', type: 'xsd:int', minOccurs: '0' }),
    el('xsd:element', { name: 'recordList', type: 'xsd:anyType', minOccurs: '0' }),
  ].join('')));

  const statusType = raw('xsd:complexType', { name: 'Status' }, [
    raw('xsd:sequence', null, el('xsd:element', {
      name: 'statusDetail', type: 'tns:StatusDetail', minOccurs: '0', maxOccurs: 'unbounded',
    })),
    el('xsd:attribute', { name: 'isSuccess', type: 'xsd:boolean' }),
  ].join(''));

  const detailType = raw('xsd:complexType', { name: 'StatusDetail' }, [
    raw('xsd:sequence', null,
      [el('xsd:element', { name: 'code', type: 'xsd:string' }),
        el('xsd:element', { name: 'message', type: 'xsd:string' })].join('')),
    el('xsd:attribute', { name: 'type', type: 'xsd:string' }),
  ].join(''));

  const portOps = messages.map(([op]) => raw('wsdl:operation', { name: op }, [
    el('wsdl:input', { message: `tns:${op}Request` }),
    el('wsdl:output', { message: `tns:${op}Response` }),
  ].join(''))).join('');

  const bindingOps = messages.map(([op]) => raw('wsdl:operation', { name: op }, [
    el('soap:operation', { soapAction: `${NS}#${op}`, style: 'document' }),
    raw('wsdl:input', null, el('soap:body', { use: 'literal' })),
    raw('wsdl:output', null, el('soap:body', { use: 'literal' })),
  ].join(''))).join('');

  const messageDefs = messages.flatMap(([op]) => [
    raw('wsdl:message', { name: `${op}Request` }, el('wsdl:part', { name: 'parameters', element: `tns:${op}` })),
    raw('wsdl:message', { name: `${op}Response` }, el('wsdl:part', { name: 'parameters', element: `tns:${op}Response` })),
  ]).join('');

  return `${declaration}
<wsdl:definitions name="MeridianPlatform" targetNamespace="${NS}"
  xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
  xmlns:xsd="${XSD}"
  xmlns:tns="${NS}">
${raw('wsdl:types', null, `<xsd:schema targetNamespace="${NS}" xmlns:tns="${NS}" elementFormDefault="qualified">${statusType}${detailType}${resultType}${recordType}${complexTypes}${elements}</xsd:schema>`)}
${messageDefs}
${raw('wsdl:portType', { name: 'MeridianPort' }, portOps)}
${raw('wsdl:binding', { name: 'MeridianBinding', type: 'tns:MeridianPort' },
    el('soap:binding', { style: 'document', transport: 'http://schemas.xmlsoap.org/soap/http' }) + bindingOps)}
${raw('wsdl:service', { name: 'MeridianPlatformService' },
    raw('wsdl:port', { name: 'MeridianPort', binding: 'tns:MeridianBinding' },
      el('soap:address', { location: endpoint })))}
</wsdl:definitions>`;
}

// -------------------------------------------------------------- envelopes

const envelope = (body) => `${declaration}
<soap:Envelope xmlns:soap="${SOAP_ENV}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:tns="${NS}">
  <soap:Body>${body}</soap:Body>
</soap:Envelope>`;

export function fault(code, message, detail = null) {
  return envelope(raw('soap:Fault', null, [
    el('faultcode', null, code),
    el('faultstring', null, message),
    detail ? raw('detail', null, el('tns:message', null, detail)) : '',
  ].join('')));
}

const statusOk = () => el('status', { isSuccess: 'true' });
const statusFail = (code, message) => raw('status', { isSuccess: 'false' },
  raw('statusDetail', { type: 'ERROR' }, el('code', null, code) + el('message', null, message)));

/** Serialise a stored row as a `<record>` element. */
function recordXml(type, row) {
  const m = meta.getMeta(type);
  const parts = [el('internalId', null, row.id)];
  for (const f of m.fields) {
    if (f.type === 'formula') continue;
    const v = row[f.name];
    if (v === undefined || v === null || v === '') continue;
    let out;
    if (f.type === 'money') out = Money.toNumber(v);
    else if (f.type === 'qty') out = Qty.toNumber(v);
    else if (f.type === 'checkbox') out = v ? 'true' : 'false';
    else if (f.type === 'json' || typeof v === 'object') out = JSON.stringify(v);
    else out = v;
    parts.push(el(f.name, null, String(out)));
  }
  return raw('record', { type, internalId: row.id, 'xsi:type': `tns:${typeName(type)}` }, parts.join(''));
}

/** Read a `<record>` element into the plain object the create path expects. */
function recordValues(node, type) {
  const m = meta.getMeta(type);
  const byName = new Map(m.fields.map((f) => [f.name, f]));
  const values = {};
  for (const child of node.children) {
    const f = byName.get(child.local);
    if (!f || f.readOnly) continue;
    const text = textOf(child);
    if (child.attrs['xsi:nil'] === 'true') { values[f.name] = null; continue; }
    if (f.type === 'checkbox') values[f.name] = text === 'true' || text === '1';
    else if (f.type === 'json') { try { values[f.name] = JSON.parse(text); } catch { values[f.name] = {}; } }
    else values[f.name] = text;
  }
  // Sublists: <lineList><line>...</line></lineList> for transactions.
  const lineList = find(node, 'lineList') || find(node, 'itemList');
  if (lineList) {
    const lines = [...kids(lineList, 'line'), ...kids(lineList, 'item')];
    if (lines.length) {
      values.lines = lines.map((ln) => {
        const line = {};
        for (const c of ln.children) line[c.local] = textOf(c);
        return line;
      });
    }
  }
  return values;
}

/** The record type named by an operation's argument, validated. */
function typeOf(node, { required = true } = {}) {
  const t = node?.attrs?.type || textOf(find(node, 'type')) || textOf(find(node, 'recordType'));
  if (!t) {
    if (!required) return null;
    throw new HttpError(400, 'The record element needs a type attribute, e.g. <record type="customer">');
  }
  if (!meta.getMeta(t)) throw new HttpError(400, `Unknown record type "${t}"`);
  return t;
}

const internalIdOf = (node) =>
  node?.attrs?.internalId || textOf(find(node, 'internalId')) || textOf(find(node, 'id')) || '';

// ------------------------------------------------------------- operations

const OPS = {
  getDataCenterUrls(ctx) {
    return raw('getDataCenterUrlsResponse', { xmlns: NS }, raw('result', null, [
      statusOk(),
      raw('dataCenterUrls', null, [
        el('webservicesDomain', null, ctx.baseUrl),
        el('restDomain', null, `${ctx.baseUrl}/api/v1`),
        el('odataDomain', null, `${ctx.baseUrl}/odata/v1`),
        el('systemDomain', null, ctx.baseUrl),
      ].join('')),
    ].join('')));
  },

  get(ctx, args) {
    const ref = find(args, 'recordRef') || find(args, 'baseRef') || args;
    const type = typeOf(ref);
    const m = meta.getMeta(type);
    rbac.require$(ctx.access, m.permission, LEVEL.VIEW);
    const id = internalIdOf(ref);
    if (!id) throw new HttpError(400, 'recordRef needs an internalId');
    const row = ctx.repo.get(m.table, id);
    if (!row) return response('get', statusFail('RCRD_DSNT_EXIST', `${m.label} ${id} was not found`));
    return response('get', statusOk() + recordXml(type, row));
  },

  getList(ctx, args) {
    const refs = findAll(args, 'recordRef').concat(findAll(args, 'baseRef'));
    if (!refs.length) throw new HttpError(400, 'getList needs at least one recordRef');
    if (refs.length > 200) throw new HttpError(400, 'getList accepts at most 200 references at a time');

    const byType = new Map();
    for (const ref of refs) {
      const type = typeOf(ref);
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push(internalIdOf(ref));
    }

    const rowsMap = new Map();
    for (const [type, ids] of byType) {
      const m = meta.getMeta(type);
      rbac.require$(ctx.access, m.permission, LEVEL.VIEW);
      const rows = ctx.repo.query(`SELECT * FROM ${m.table} WHERE tenant_id = :t AND id IN (${ids.map(() => '?').join(',')})`, ids);
      for (const row of rows) {
        rowsMap.set(`${type}:${row.id}`, row);
      }
    }

    const out = refs.map((ref) => {
      const type = typeOf(ref);
      const m = meta.getMeta(type);
      const id = internalIdOf(ref);
      const row = rowsMap.get(`${type}:${id}`);
      return row
        ? raw('readResponse', null, statusOk() + recordXml(type, row))
        : raw('readResponse', null, statusFail('RCRD_DSNT_EXIST', `${m.label} ${id} was not found`));
    });

    return response('getList', statusOk() + el('totalRecords', null, String(out.length)) + raw('recordList', null, out.join('')));
  },

  add(ctx, args) {
    const node = find(args, 'record');
    if (!node) throw new HttpError(400, 'add needs a record element');
    const type = typeOf(node);
    const m = meta.getMeta(type);
    rbac.require$(ctx.access, m.permission, LEVEL.CREATE);
    const created = ctx.tx(() => records.createRecord(ctx.repo, type, recordValues(node, type)));
    const row = ctx.repo.get(m.table, created.id) || created;
    return response('add', statusOk() + recordXml(type, row));
  },

  addList(ctx, args) {
    const nodes = findAll(args, 'record');
    if (!nodes.length) throw new HttpError(400, 'addList needs at least one record');
    if (nodes.length > 200) throw new HttpError(400, 'addList accepts at most 200 records at a time');
    // One transaction for the batch: a partial import is worse than none.
    const results = ctx.tx(() => nodes.map((node) => {
      const type = typeOf(node);
      const m = meta.getMeta(type);
      rbac.require$(ctx.access, m.permission, LEVEL.CREATE);
      const created = records.createRecord(ctx.repo, type, recordValues(node, type));
      return { type, id: created.id };
    }));
    const body = results.map((r) => raw('writeResponse', null,
      statusOk() + el('baseRef', { type: r.type, internalId: r.id }))).join('');
    return response('addList', statusOk() + el('totalRecords', null, String(results.length)) + raw('writeResponseList', null, body));
  },

  update(ctx, args) {
    const node = find(args, 'record');
    if (!node) throw new HttpError(400, 'update needs a record element');
    const type = typeOf(node);
    const m = meta.getMeta(type);
    rbac.require$(ctx.access, m.permission, LEVEL.EDIT);
    const id = internalIdOf(node);
    if (!id) throw new HttpError(400, 'update needs an internalId');
    if (!ctx.repo.get(m.table, id)) return response('update', statusFail('RCRD_DSNT_EXIST', `${m.label} ${id} was not found`));
    ctx.tx(() => records.updateRecord(ctx.repo, type, id, recordValues(node, type)));
    return response('update', statusOk() + recordXml(type, ctx.repo.get(m.table, id)));
  },

  upsert(ctx, args) {
    const node = find(args, 'record');
    if (!node) throw new HttpError(400, 'upsert needs a record element');
    const type = typeOf(node);
    const m = meta.getMeta(type);
    const values = recordValues(node, type);
    const externalId = node.attrs.externalId || textOf(find(node, 'externalId'));
    const id = internalIdOf(node);

    // Match on internalId, then externalId, then the record's natural key.
    let existing = id ? ctx.repo.get(m.table, id) : null;
    if (!existing && externalId && ctx.repo.db.$columns(m.table).has('external_id')) {
      existing = ctx.repo.queryOne(`SELECT * FROM ${m.table} WHERE tenant_id = :t AND external_id = ?`, [externalId]);
    }
    if (!existing && m.title && values[m.title]) {
      existing = ctx.repo.queryOne(`SELECT * FROM ${m.table} WHERE tenant_id = :t AND ${m.title} = ?`, [values[m.title]]);
    }

    rbac.require$(ctx.access, m.permission, existing ? LEVEL.EDIT : LEVEL.CREATE);
    const saved = ctx.tx(() => (existing
      ? records.updateRecord(ctx.repo, type, existing.id, values)
      : records.createRecord(ctx.repo, type, externalId ? { ...values, external_id: externalId } : values)));
    return response('upsert', statusOk() + recordXml(type, ctx.repo.get(m.table, saved.id) || saved));
  },

  delete(ctx, args) {
    const ref = find(args, 'recordRef') || find(args, 'baseRef') || args;
    const type = typeOf(ref);
    const m = meta.getMeta(type);
    rbac.require$(ctx.access, m.permission, LEVEL.FULL);
    const id = internalIdOf(ref);
    if (!id) throw new HttpError(400, 'delete needs an internalId');
    if (!ctx.repo.get(m.table, id)) return response('delete', statusFail('RCRD_DSNT_EXIST', `${m.label} ${id} was not found`));
    ctx.tx(() => ctx.repo.remove(m.table, id));
    return response('delete', statusOk() + el('baseRef', { type, internalId: id }));
  },

  search(ctx, args) {
    const node = find(args, 'searchRecord') || args;
    const type = typeOf(node);
    const m = meta.getMeta(type);
    rbac.require$(ctx.access, m.permission, LEVEL.VIEW);

    // <basic><field operator="contains">value</field></basic>, plus paging.
    const filters = [];
    const basic = find(node, 'basic') || node;
    for (const c of basic.children) {
      if (['type', 'recordType', 'pageSize', 'pageIndex', 'basic'].includes(c.local)) continue;
      const field = m.fields.find((f) => f.name === c.local);
      if (!field) continue;
      filters.push({ field: c.local, op: c.attrs.operator || 'is', value: textOf(c) });
    }
    const pageSize = Math.min(Number(textOf(find(node, 'pageSize'))) || 100, 1000);
    const pageIndex = Math.max(Number(textOf(find(node, 'pageIndex'))) || 1, 1);

    const result = platform.runSearch(ctx.repo, type, { filters }, {
      access: ctx.access, limit: pageSize, offset: (pageIndex - 1) * pageSize,
    });
    const body = result.rows.map((row) => recordXml(type, row)).join('');
    return response('search', [
      statusOk(),
      el('totalRecords', null, String(result.total ?? result.rows.length)),
      el('pageSize', null, String(pageSize)),
      el('totalPages', null, String(Math.max(1, Math.ceil((result.total ?? result.rows.length) / pageSize)))),
      el('pageIndex', null, String(pageIndex)),
      raw('recordList', null, body),
    ].join(''));
  },
};

const response = (op, inner) => raw(`${op}Response`, { xmlns: NS }, raw('result', null, inner));

/**
 * Handle one SOAP request. `ctx` carries the authenticated repo, access and a
 * `tx` helper; the transport layer supplies them exactly as REST routes get
 * them, so there is no second authentication path to keep in step.
 */
export function handle(ctx, body) {
  let doc;
  try {
    doc = parseXml(body, { maxDepth: 60, maxNodes: 50_000 });
  } catch (e) {
    if (e instanceof XmlError) return { status: 400, xml: fault(CLIENT, `Malformed XML: ${e.message}`) };
    throw e;
  }

  const root = rootOf(doc);
  if (!root || root.local !== 'Envelope') return { status: 400, xml: fault(CLIENT, 'Expected a SOAP Envelope') };
  const soapBody = find(root, 'Body');
  if (!soapBody) return { status: 400, xml: fault(CLIENT, 'The envelope has no Body') };

  const call = soapBody.children.find((c) => c.local !== '#text');
  if (!call) return { status: 400, xml: fault(CLIENT, 'The Body carries no operation') };

  const op = OPS[call.local];
  if (!op) {
    return { status: 400, xml: fault(CLIENT, `Unknown operation "${call.local}". Supported: ${Object.keys(OPS).join(', ')}`) };
  }

  try {
    return { status: 200, xml: envelope(op(ctx, call)) };
  } catch (e) {
    if (e instanceof ValidationError) {
      const detail = Object.entries(e.fields || {}).map(([k, v]) => `${k}: ${v}`).join('; ');
      return { status: 400, xml: fault(CLIENT, 'The record failed validation', detail) };
    }
    if (e instanceof HttpError) {
      // 4xx is the caller's fault, 5xx ours; SOAP encodes that in the code.
      return { status: e.status, xml: fault(e.status >= 500 ? SERVER : CLIENT, e.message, e.code || null) };
    }
    throw e;
  }
}

export const OPERATIONS = Object.keys(OPS);
