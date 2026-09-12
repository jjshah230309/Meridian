// The data-interchange layer: CSV parsing, imports with a real rollback, XLSX
// and ZIP written by hand, bank statement formats, and the OData feeds that
// Power BI and Excel read. These are all places where a typo in a column name
// only shows up at runtime, so the sweeps below are deliberately exhaustive.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import zlib from 'node:zlib';
import { openDatabase, migrate, transaction } from '../src/core/db.mjs';
import { createServer } from '../src/server.mjs';
import { provisionTenant } from '../src/modules/setup.mjs';
import { loadServerSecret } from '../src/core/auth.mjs';
import { freshTenant } from './helpers.mjs';
import * as dataio from '../src/modules/dataio.mjs';
import { Money } from '../src/core/util.mjs';
import { parseCsv, toCsv, csvValue, sniffDelimiter } from '../src/core/csv.mjs';
import { zip } from '../src/core/zip.mjs';
import { parseStatement, sniffFormat } from '../src/modules/bankfiles.mjs';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
let server, base, db, dataDir;
const PASSWORD = 'Correct-Horse-9';

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-dataio-'));
  db = openDatabase(':memory:');
  migrate(db, path.join(ROOT, 'migrations'));
  transaction(db, () => provisionTenant(db, {
    name: 'Data IO Co', ownerEmail: 'owner@test.local', ownerPassword: PASSWORD, fiscalYear: 2026,
  }));
  const config = {
    version: 'test', dataDir, webDir: path.join(ROOT, 'src/web'),
    migrationsDir: path.join(ROOT, 'migrations'), dev: false, trustProxy: false,
    secret: loadServerSecret(dataDir),
  };
  server = createServer(config, db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  try { db.close(); } catch { /* already closed */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

function client() {
  let cookie = null; let csrf = null;
  return {
    async call(method, urlPath, body, extraHeaders = {}) {
      const headers = { Accept: 'application/json', ...extraHeaders };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
      const res = await fetch(base + urlPath, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const buf = Buffer.from(await res.arrayBuffer());
      let json = null;
      try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary or csv */ }
      return { status: res.status, body: json, buf, text: buf.toString('utf8'), headers: res.headers };
    },
    // A body that is already serialised (a SOAP envelope, a CSV upload).
    async callRaw(method, urlPath, rawBody, extraHeaders = {}) {
      const headers = { ...extraHeaders };
      if (cookie) headers.Cookie = cookie;
      if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
      const res = await fetch(base + urlPath, { method, headers, body: rawBody });
      const buf = Buffer.from(await res.arrayBuffer());
      return { status: res.status, buf, text: buf.toString('utf8'), headers: res.headers };
    },
    async login() {
      const r = await this.call('POST', '/api/v1/auth/login', { email: 'owner@test.local', password: PASSWORD });
      if (r.body?.csrf) csrf = r.body.csrf;
      return r;
    },
  };
}

// --- CSV -------------------------------------------------------------------

test('csv parser survives quotes, embedded newlines and a BOM', () => {
  const text = '﻿name,notes,amount\r\n"Acme, Inc.","line one\nline two",1200\r\n'
    + 'Plain,"He said ""hi""",-40\r\n';
  const { rows, headers } = parseCsv(text);
  assert.deepEqual(headers, ['name', 'notes', 'amount'], 'BOM must not stick to the first header');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Acme, Inc.');
  assert.equal(rows[0].notes, 'line one\nline two');
  assert.equal(rows[1].notes, 'He said "hi"');
  assert.equal(rows[1].__line, 4,
    'line numbers count physical lines: record one spans 2-3 because of its embedded newline');
});

test('csv delimiter sniffing handles semicolons and tabs', () => {
  assert.equal(sniffDelimiter('a;b;c\n1;2;3\n'), ';');
  assert.equal(sniffDelimiter('a\tb\tc\n1\t2\t3\n'), '\t');
  assert.equal(sniffDelimiter('a,b,c\n1,2,3\n'), ',');
});

test('csv export defuses spreadsheet formula injection', () => {
  for (const payload of ['=SUM(A1)', '+1+1', '-1+1', '@import', '\tcmd']) {
    const out = csvValue(payload);
    assert.match(out, /^"?'/, `${JSON.stringify(payload)} must be neutralised, got ${out}`);
  }
  assert.equal(csvValue('Acme'), 'Acme', 'ordinary text must not be mangled');
});

test('csv round-trips through toCsv and parseCsv', () => {
  const rows = [{ a: 'x,y', b: 'quote"d', c: '' }, { a: 'plain', b: 'multi\nline', c: '7' }];
  const { rows: back } = parseCsv(toCsv(rows, ['a', 'b', 'c']));
  assert.equal(back.length, 2);
  assert.equal(back[0].a, 'x,y');
  assert.equal(back[1].b, 'multi\nline');
});

// --- ZIP / XLSX ------------------------------------------------------------

test('zip archives are readable: signatures, CRC and inflated content match', () => {
  const payload = Buffer.from('hello '.repeat(500), 'utf8');
  const buf = zip([{ name: 'a.txt', data: payload }, { name: 'dir/b.txt', data: Buffer.from('b') }]);
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'must start with a local file header');
  const eocdAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocdAt > 0, 'end-of-central-directory record must exist');
  assert.equal(buf.readUInt16LE(eocdAt + 10), 2, 'central directory must list both entries');

  // Walk the first entry and inflate it back.
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const compSize = buf.readUInt32LE(18);
  const method = buf.readUInt16LE(8);
  const start = 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + compSize);
  const out = method === 8 ? zlib.inflateRawSync(raw) : raw;
  assert.equal(out.toString('utf8'), payload.toString('utf8'));
  assert.ok(compSize < payload.length, 'repetitive text must actually deflate');
});

test('xlsx export is a valid workbook package with the expected parts', async () => {
  const c = client();
  await c.login();
  const res = await c.call('GET', '/api/v1/export/customer?format=xlsx');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /spreadsheetml/);
  const buf = res.buf;
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  // The OOXML minimum: content types, the relationship graph, workbook and one sheet.
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
    'xl/worksheets/sheet1.xml', 'xl/styles.xml']) {
    assert.ok(buf.includes(Buffer.from(part, 'utf8')), `missing part ${part}`);
  }
});

// --- bank statement formats ------------------------------------------------

const OFX = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD</CURDEF>
<BANKACCTFROM><ACCTID>123456789</ACCTID></BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260115120000</DTPOSTED><TRNAMT>-250.75</TRNAMT><FITID>T1</FITID><NAME>Office Depot</NAME></STMTTRN>
<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20260116</DTPOSTED><TRNAMT>1800.00</TRNAMT><FITID>T2</FITID><NAME>Client payment</NAME></STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

const BAI2 = `01,BANKID,CUSTID,260115,0900,1,,,2/
02,CUSTID,BANKID,1,260115,,,/
03,123456789,USD,010,50000,,/
16,175,180000,,REF1,CUST1,Client payment/
16,451,25075,,REF2,CUST2,Office Depot/
49,225075,4/
98,225075,1,6/
99,225075,1,8/`;

const CAMT = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
<Id>STMT-1</Id><Acct><Id><IBAN>DE89370400440532013000</IBAN></Id><Ccy>EUR</Ccy></Acct>
<Ntry><Amt Ccy="EUR">250.75</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-01-15</Dt></BookgDt>
<NtryDtls><TxDtls><RmtInf><Ustrd>Office Depot</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
<Ntry><Amt Ccy="EUR">1800.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-01-16</Dt></BookgDt>
<NtryDtls><TxDtls><RmtInf><Ustrd>Client payment</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
</Stmt></BkToCstmrStmt></Document>`;

const BANK_CSV = 'Date,Description,Debit,Credit\n2026-01-15,Office Depot,250.75,\n2026-01-16,Client payment,,1800.00\n';

test('every bank statement format parses to the same two transactions', () => {
  // BAI2 detail records carry no date of their own: they inherit the as-of
  // date of the 03 account group, so both land on the 15th. Every other
  // format dates each transaction individually.
  const cases = [
    ['ofx', OFX, '2026-01-15', '2026-01-16'],
    ['bai2', BAI2, '2026-01-15', '2026-01-15'],
    ['camt053', CAMT, '2026-01-15', '2026-01-16'],
    ['csv', BANK_CSV, '2026-01-15', '2026-01-16'],
  ];
  for (const [expectFormat, text, debitDate, creditDate] of cases) {
    assert.equal(sniffFormat(text), expectFormat, `sniffFormat mis-detected ${expectFormat}`);
    const st = parseStatement(text);
    assert.equal(st.format, expectFormat);
    assert.equal(st.transactions.length, 2, `${expectFormat}: expected 2 transactions`);
    const debit = st.transactions.find((t) => t.amount < 0);
    const credit = st.transactions.find((t) => t.amount > 0);
    assert.ok(debit && credit, `${expectFormat}: needs one debit and one credit`);
    // Amounts are minor units: 250.75 out, 1800.00 in.
    assert.equal(debit.amount, -25075, `${expectFormat}: debit amount`);
    assert.equal(credit.amount, 180000, `${expectFormat}: credit amount`);
    assert.equal(debit.date, debitDate, `${expectFormat}: debit date`);
    assert.equal(credit.date, creditDate, `${expectFormat}: credit date`);
    assert.match(debit.description, /Office Depot/, `${expectFormat}: debit description`);
    assert.match(credit.description, /Client payment/, `${expectFormat}: credit description`);
  }
});

test('a re-imported statement does not duplicate rows', async () => {
  const c = client();
  await c.login();
  const accounts = (await c.call('GET', '/api/v1/bank/accounts')).body;
  const accountId = (accounts.accounts || accounts.rows || accounts)[0]?.id;
  assert.ok(accountId, 'the demo tenant must provision at least one bank account');

  const first = await c.call('POST', '/api/v1/bank/statements/import', { bank_account_id: accountId, text: OFX });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.body.imported, 2);
  const again = await c.call('POST', '/api/v1/bank/statements/import', { bank_account_id: accountId, text: OFX });
  assert.equal(again.status, 200);
  assert.equal(again.body.imported, 0, 'the second pass must be entirely duplicates');
  assert.equal(again.body.duplicates, 2);
});

// --- import pipeline -------------------------------------------------------

test('a CSV import validates, commits and reverses cleanly', async () => {
  const c = client();
  await c.login();
  const csv = 'Name,Email,Phone\nImported One,one@import.test,555-0001\n'
    + 'Imported Two,two@import.test,555-0002\n';

  const suggest = await c.call('POST', '/api/v1/import/customer/suggest', { text: csv });
  assert.equal(suggest.status, 200, suggest.text);
  assert.equal(suggest.body.mapping.Name, 'name', 'header mapping must find the obvious columns');
  assert.equal(suggest.body.mapping.Email, 'email');

  const check = await c.call('POST', '/api/v1/import/customer/validate',
    { text: csv, mapping: suggest.body.mapping });
  assert.equal(check.status, 200, check.text);
  assert.deepEqual(check.body.errors, [], 'clean input must validate without errors');
  assert.equal(check.body.valid_rows, 2);

  const before = (await c.call('GET', '/api/v1/records/customer?limit=200')).body.total;
  const commit = await c.call('POST', '/api/v1/import/customer/commit',
    { text: csv, mapping: suggest.body.mapping, filename: 'customers.csv' });
  assert.equal(commit.status, 200, commit.text);
  assert.equal(commit.body.created, 2);
  const jobId = commit.body.job_id;
  assert.ok(jobId, 'a commit must record a reversible job');
  assert.equal((await c.call('GET', '/api/v1/records/customer?limit=200')).body.total, before + 2);

  const undo = await c.call('POST', `/api/v1/import/jobs/${jobId}/reverse`);
  assert.equal(undo.status, 200, undo.text);
  assert.equal(undo.body.removed, 2);
  assert.deepEqual(undo.body.blocked, [], 'nothing should have blocked the rollback');
  assert.equal((await c.call('GET', '/api/v1/records/customer?limit=200')).body.total, before,
    'reversing must leave the table exactly as it was');
});

test('reversing an import leaves behind anything that has since been used', async () => {
  const c = client();
  await c.login();
  const csv = 'Name,Email\nKeeps Trading Ltd,keeps@import.test\nNever Used Ltd,never@import.test\n';
  const suggest = await c.call('POST', '/api/v1/import/customer/suggest', { text: csv });
  const commit = await c.call('POST', '/api/v1/import/customer/commit',
    { text: csv, mapping: suggest.body.mapping, filename: 'customers.csv' });
  assert.equal(commit.body.created, 2);

  // One of them starts trading, so it can no longer simply vanish.
  const trading = (await c.call('GET', '/api/v1/records/customer?limit=200')).body.rows
    .find((r) => r.email === 'keeps@import.test');
  const revenue = (await c.call('GET', '/api/v1/records/account?limit=200')).body.rows
    .find((a) => a.number === '4020');
  const invoice = await c.call('POST', '/api/v1/records/invoice', {
    entity_id: trading.id, txn_date: '2026-06-15',
    lines: [{ description: 'Consultancy', quantity: 1, unit_price: 500, account_id: revenue.id }],
  });
  assert.equal(invoice.status, 200, invoice.text);

  const undo = await c.call('POST', `/api/v1/import/jobs/${commit.body.job_id}/reverse`);
  assert.equal(undo.status, 200, undo.text);
  assert.equal(undo.body.removed, 1, 'the unused one goes');
  assert.equal(undo.body.blocked.length, 1, 'the trading one stays, and is reported');
  assert.equal(undo.body.blocked[0].id, trading.id);
  assert.ok((await c.call('GET', `/api/v1/records/customer/${trading.id}`)).status === 200,
    'the customer its invoice points at is still there');
});

test('an invalid import row is reported by line and nothing is written', async () => {
  const c = client();
  await c.login();
  const csv = 'Name,Email\nGood Row,good@import.test\n,missing-name@import.test\n';
  const check = await c.call('POST', '/api/v1/import/customer/validate',
    { text: csv, mapping: { Name: 'name', Email: 'email' } });
  assert.equal(check.status, 200, check.text);
  assert.equal(check.body.errors.length, 1, 'the blank name must be rejected');
  assert.equal(check.body.errors[0].line, 3, 'errors must point at the physical CSV line');
  assert.equal(check.body.valid_rows, 1);
});

test('import templates download for every importable record type', async () => {
  const c = client();
  await c.login();
  const list = (await c.call('GET', '/api/v1/import/record-types')).body.record_types;
  assert.ok(Array.isArray(list) && list.length >= 20, `expected many importable types, saw ${list?.length}`);
  const failures = [];
  for (const entry of list) {
    const type = entry.type;
    for (const fmt of ['csv', 'xlsx']) {
      const res = await c.call('GET', `/api/v1/import/${type}/template?format=${fmt}`);
      if (res.status !== 200 || res.buf.length === 0) failures.push(`${type} ${fmt} → ${res.status}`);
    }
  }
  assert.deepEqual(failures, [], `import templates failed:\n  ${failures.join('\n  ')}`);
});

// --- exports ---------------------------------------------------------------

test('every record type exports in every supported format', async () => {
  const c = client();
  await c.login();
  const meta = (await c.call('GET', '/api/v1/meta')).body;
  const failures = [];
  for (const type of Object.keys(meta.records)) {
    for (const format of ['csv', 'json', 'xlsx', 'pdf']) {
      const res = await c.call('GET', `/api/v1/export/${type}?format=${format}`);
      if (res.status !== 200) failures.push(`${type} ${format} → ${res.status} ${res.body?.error?.message || ''}`);
      else if (res.buf.length === 0) failures.push(`${type} ${format} → empty body`);
    }
  }
  assert.deepEqual(failures, [], `exports failed:\n  ${failures.join('\n  ')}`);
});

test('pdf exports are well-formed and paginate', async () => {
  const c = client();
  await c.login();
  const res = await c.call('GET', '/api/v1/export/customer?format=pdf');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/pdf/);
  assert.match(res.headers.get('content-disposition'), /\.pdf/);
  const text = res.buf.toString('latin1');
  assert.match(text, /^%PDF-1\.4/);
  assert.match(text, /%%EOF\s*$/);
  // A reader needs the catalogue, a page tree and a byte-accurate xref table.
  assert.match(text, /\/Type \/Catalog/);
  assert.match(text, /\/Type \/Pages \/Count \d+/);
  const startxref = Number(/startxref\s+(\d+)/.exec(text)?.[1]);
  assert.ok(Number.isFinite(startxref), 'startxref must be present');
  assert.equal(text.slice(startxref, startxref + 4), 'xref', 'startxref must point at the xref table');

  const pack = await c.call('GET', '/api/v1/export/reports/pack?format=pdf');
  assert.equal(pack.status, 200);
  assert.match(pack.headers.get('content-type'), /application\/pdf/);
  assert.match(pack.buf.toString('latin1'), /^%PDF-1\.4/);
});

test('pdf layout measures text rather than guessing', async () => {
  const { textWidth, ellipsize, wrap } = await import('../src/core/pdf.mjs');
  assert.ok(textWidth('IIII', 10) < textWidth('WWWW', 10), 'the font is proportional, not fixed-width');
  assert.ok(textWidth('', 10) === 0);
  const cut = ellipsize('a very long customer trading name indeed', 60, 9);
  assert.ok(cut.endsWith('...') && textWidth(cut, 9) <= 60, `"${cut}" must fit in 60pt`);
  assert.equal(ellipsize('short', 200, 9), 'short', 'text that fits is left alone');
  for (const line of wrap('the quick brown fox jumps over the lazy dog', 80, 9)) {
    assert.ok(textWidth(line, 9) <= 80, `wrapped line "${line}" overflows`);
  }
  // A single unbreakable word longer than the column still has to fit.
  assert.ok(wrap('Supercalifragilisticexpialidocious', 40, 9).every((l) => textWidth(l, 9) <= 40));
});

// --- OData / Power BI ------------------------------------------------------

test('the OData service document and $metadata describe the same feeds', async () => {
  const c = client();
  await c.login();
  const svc = await c.call('GET', '/odata/v1');
  assert.equal(svc.status, 200, svc.text);
  const names = svc.body.value.map((s) => s.name);
  assert.ok(names.length >= 60, `expected the full feed catalogue, saw ${names.length}`);
  assert.equal(new Set(names).size, names.length, 'entity set names must be unique');
  for (const n of names) assert.match(n, /^[A-Za-z][A-Za-z0-9_]*$/, `${n} is not a legal EDM name`);

  const meta = await c.call('GET', '/odata/v1/$metadata');
  assert.equal(meta.status, 200);
  assert.match(meta.headers.get('content-type'), /xml/);
  assert.match(meta.text, /<edmx:Edmx/);
  // Every advertised set must be declared in the container, or Power BI's
  // navigator shows a table that errors the moment you click it.
  for (const n of names) {
    assert.ok(meta.text.includes(`<EntitySet Name="${n}"`), `${n} missing from $metadata`);
  }
});

test('every OData feed actually returns rows', async () => {
  // The sweep that catches a column renamed in a migration but not in the feed
  // SQL -- the failure mode is a 500 deep inside Power BI's refresh, where
  // nobody can see it.
  const c = client();
  await c.login();
  const names = (await c.call('GET', '/odata/v1')).body.value.map((s) => s.name);
  const failures = [];
  for (const name of names) {
    const res = await c.call('GET', `/odata/v1/${name}?$top=1&$count=true`);
    if (res.status !== 200) { failures.push(`${name} → ${res.status} ${res.body?.error?.message || res.text.slice(0, 120)}`); continue; }
    if (!Array.isArray(res.body?.value)) { failures.push(`${name} → no value array`); continue; }
    if (typeof res.body['@odata.count'] !== 'number') failures.push(`${name} → $count not honoured`);
  }
  assert.deepEqual(failures, [], `OData feeds failed:\n  ${failures.join('\n  ')}`);
});

test('OData query options filter, project, order and page', async () => {
  const c = client();
  await c.login();
  const all = await c.call('GET', '/odata/v1/Customers?$count=true&$top=3');
  assert.equal(all.status, 200, all.text);
  assert.ok(all.body.value.length <= 3, '$top must cap the page');

  const projected = await c.call('GET', '/odata/v1/Customers?$select=Name&$top=1');
  assert.equal(projected.status, 200);
  if (projected.body.value.length) {
    assert.deepEqual(Object.keys(projected.body.value[0]), ['Name'], '$select must project');
  }

  const ordered = await c.call('GET', '/odata/v1/Customers?$orderby=Name desc&$top=5');
  assert.equal(ordered.status, 200);
  const names = ordered.body.value.map((r) => r.Name);
  assert.deepEqual(names, [...names].sort().reverse(), '$orderby desc must sort');

  const filtered = await c.call('GET', "/odata/v1/Customers?$filter=Name ne 'nothing matches this'&$count=true");
  assert.equal(filtered.status, 200, filtered.text);
  assert.equal(filtered.body['@odata.count'], all.body['@odata.count'], 'a tautological filter keeps every row');

  const skipped = await c.call('GET', '/odata/v1/Customers?$skip=1&$top=1');
  assert.equal(skipped.status, 200);
  if (all.body.value.length > 1) {
    assert.notEqual(skipped.body.value[0]?.Name, all.body.value[0]?.Name, '$skip must move the window');
  }
});

test('a malformed $filter is refused, not executed', async () => {
  const c = client();
  await c.login();
  for (const bad of ["Name eq 'x' and", 'Name ~~ 1', "Name eq 'x') or (1 eq 1"]) {
    const res = await c.call('GET', `/odata/v1/Customers?$filter=${encodeURIComponent(bad)}`);
    assert.equal(res.status, 400, `${bad} should be a 400, got ${res.status}`);
  }
});

test('OData refuses an unauthenticated read and accepts a Basic-auth API token', async () => {
  const anon = await fetch(`${base}/odata/v1/Customers`);
  assert.equal(anon.status, 401, 'BI tools must not read a tenant without credentials');

  const c = client();
  await c.login();
  const made = await c.call('POST', '/api/v1/setup/api-tokens', { name: 'Power BI test' });
  assert.equal(made.status, 200, made.text);
  const token = made.body.token;
  assert.ok(token, 'creating a token must return the secret exactly once');

  const auth = 'Basic ' + Buffer.from(`owner@test.local:${token}`).toString('base64');
  const res = await fetch(`${base}/odata/v1/Customers?$top=1`, { headers: { Authorization: auth } });
  assert.equal(res.status, 200, 'Basic auth with an API token is how Power BI connects');
  const body = await res.json();
  assert.ok(Array.isArray(body.value));

  const wrong = await fetch(`${base}/odata/v1/Customers`, {
    headers: { Authorization: 'Basic ' + Buffer.from('owner@test.local:not-a-token').toString('base64') },
  });
  assert.equal(wrong.status, 401, 'a bad token must not fall through to a session');
});

// --- XML and SOAP ----------------------------------------------------------

test('the xml parser refuses the constructs that carry XXE', async () => {
  const { parseXml, XmlError } = await import('../src/core/xml.mjs');
  const hostile = [
    '<!DOCTYPE r [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><r>&xxe;</r>',
    '<!ENTITY lol "lol"><r/>',
  ];
  for (const doc of hostile) {
    assert.throws(() => parseXml(doc), XmlError, `must reject: ${doc.slice(0, 40)}`);
  }
  // An undeclared entity stays literal rather than resolving to anything.
  const { rootOf, find, textOf } = await import('../src/core/xml.mjs');
  assert.equal(textOf(find(rootOf(parseXml('<a><b>&lol;</b></a>')), 'b')), '&lol;');
  // Structural errors are errors, not silently repaired trees.
  for (const bad of ['<a><b></a></b>', '<a><b>', '<a']) {
    assert.throws(() => parseXml(bad), XmlError, `must reject: ${bad}`);
  }
  // Depth and node ceilings bound a hostile document.
  assert.throws(() => parseXml('<a>'.repeat(200) + '</a>'.repeat(200), { maxDepth: 20 }), XmlError);
});

test('the xml parser reads what a SOAP client actually sends', async () => {
  const { parseXml, rootOf, find, textOf } = await import('../src/core/xml.mjs');
  const root = rootOf(parseXml(`<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
    <soap:Body><add><record type="customer" note="a &gt; b">
      <name>Acme &amp; Sons</name>
      <raw><![CDATA[<not> markup & co]]></raw>
      <num>&#65;&#x42;</num>
      <blank/>
    </record></add></soap:Body></soap:Envelope>`));
  assert.equal(root.local, 'Envelope');
  assert.equal(root.prefix, 'soap');
  const rec = find(root, 'record');
  assert.equal(rec.attrs.type, 'customer');
  assert.equal(rec.attrs.note, 'a > b', 'entities in attributes must decode');
  assert.equal(textOf(find(rec, 'name')), 'Acme & Sons');
  assert.equal(textOf(find(rec, 'raw')), '<not> markup & co', 'CDATA is literal');
  assert.equal(textOf(find(rec, 'num')), 'AB', 'numeric character references decode');
  assert.equal(textOf(find(rec, 'blank')), '');
});

test('the WSDL is well-formed and internally consistent', async () => {
  const c = client();
  await c.login();
  const res = await c.call('GET', '/soap/v1');
  assert.equal(res.status, 200, res.text);
  assert.match(res.headers.get('content-type'), /xml/);

  const { parseXml, rootOf, findAll, find } = await import('../src/core/xml.mjs');
  const root = rootOf(parseXml(res.text));       // throws if malformed
  assert.equal(root.local, 'definitions');

  const ops = findAll(find(root, 'portType'), 'operation').map((o) => o.attrs.name);
  for (const expected of ['get', 'add', 'update', 'delete', 'search', 'upsert', 'addList', 'getList']) {
    assert.ok(ops.includes(expected), `WSDL is missing the ${expected} operation`);
  }
  // Every operation needs both messages, and every message part a schema element.
  const messages = new Set(findAll(root, 'message').map((m) => m.attrs.name));
  for (const op of ops) {
    assert.ok(messages.has(`${op}Request`), `${op} has no request message`);
    assert.ok(messages.has(`${op}Response`), `${op} has no response message`);
  }
  const schema = find(root, 'schema');
  const declared = new Set(schema.children.filter((e) => e.local === 'element').map((e) => e.attrs.name));
  for (const m of findAll(root, 'message')) {
    for (const part of findAll(m, 'part')) {
      const local = String(part.attrs.element || '').split(':').pop();
      assert.ok(declared.has(local), `message ${m.attrs.name} references undeclared element ${local}`);
    }
  }
  const complex = schema.children.filter((e) => e.local === 'complexType').map((e) => e.attrs.name);
  assert.ok(complex.includes('Customer'), 'record types must appear as complex types');
  assert.ok(complex.length >= 50, `expected the full registry in the schema, saw ${complex.length}`);
  assert.match(find(root, 'address').attrs.location, /\/soap\/v1$/);
});

// Post a SOAP envelope the way a real toolkit would.
async function soapCall(c, op, inner) {
  const envelope = `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">`
    + `<soap:Body><${op} xmlns="urn:platform.meridian.erp">${inner}</${op}></soap:Body></soap:Envelope>`;
  return c.callRaw('POST', '/soap/v1', envelope, {
    'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `urn:platform.meridian.erp#${op}`,
  });
}

test('SOAP round-trips a record through add, get, update, search and delete', async () => {
  const c = client();
  await c.login();

  const added = await soapCall(c, 'add',
    '<record type="customer"><name>SOAP Trading &amp; Co</name><email>soap@x.test</email><credit_limit>25000.00</credit_limit></record>');
  assert.equal(added.status, 200, added.text);
  assert.match(added.text, /isSuccess="true"/);
  const id = /internalId="([^"]+)"/.exec(added.text)?.[1];
  assert.ok(id, 'add must return the new internalId');
  // Going through the shared create path means the sequence numbered it.
  assert.match(added.text, /<entity_no>C\d+<\/entity_no>/, 'SOAP creates must be numbered like any other');
  assert.match(added.text, /Acme|SOAP Trading &amp; Co/, 'the name must round-trip with its entity escaped');

  const got = await soapCall(c, 'get', `<recordRef type="customer" internalId="${id}"/>`);
  assert.equal(got.status, 200);
  assert.match(got.text, /<email>soap@x\.test<\/email>/);

  const updated = await soapCall(c, 'update', `<record type="customer" internalId="${id}"><phone>555-9000</phone></record>`);
  assert.equal(updated.status, 200);
  assert.match(updated.text, /<phone>555-9000<\/phone>/);
  assert.match(updated.text, /SOAP Trading/, 'a partial update must not blank the other fields');

  const found = await soapCall(c, 'search',
    '<searchRecord type="customer"><basic><name operator="contains">SOAP Trading</name></basic><pageSize>10</pageSize></searchRecord>');
  assert.equal(found.status, 200);
  assert.match(found.text, /<totalRecords>1<\/totalRecords>/);

  const gone = await soapCall(c, 'delete', `<recordRef type="customer" internalId="${id}"/>`);
  assert.equal(gone.status, 200);
  assert.match(gone.text, /isSuccess="true"/);
  const missing = await soapCall(c, 'get', `<recordRef type="customer" internalId="${id}"/>`);
  assert.match(missing.text, /RCRD_DSNT_EXIST/);
});

test('a SOAP batch is all-or-nothing', async () => {
  const c = client();
  await c.login();
  const before = (await c.call('GET', '/api/v1/records/customer?limit=500')).body.total;

  const ok = await soapCall(c, 'addList',
    '<record type="customer"><name>Batch One</name></record><record type="customer"><name>Batch Two</name></record>');
  assert.equal(ok.status, 200, ok.text);
  assert.match(ok.text, /<totalRecords>2<\/totalRecords>/);
  assert.equal((await c.call('GET', '/api/v1/records/customer?limit=500')).body.total, before + 2);

  // The second record has no name, which is required: neither may survive.
  const bad = await soapCall(c, 'addList',
    '<record type="customer"><name>Would Be Three</name></record><record type="customer"><email>no-name@x.test</email></record>');
  assert.equal(bad.status, 400);
  assert.match(bad.text, /<faultcode>soap:Client<\/faultcode>/);
  assert.match(bad.text, /name/, 'the fault should name the offending field');
  assert.equal((await c.call('GET', '/api/v1/records/customer?limit=500')).body.total, before + 2,
    'the failed batch must have rolled back completely');
});

test('SOAP refuses hostile and malformed requests', async () => {
  const c = client();
  await c.login();

  const xxe = await c.callRaw('POST', '/soap/v1',
    '<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"/>',
    { 'Content-Type': 'text/xml' });
  assert.equal(xxe.status, 400);
  assert.match(xxe.text, /DOCTYPE is not accepted/);

  for (const [body, expect] of [
    ['<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body/></soap:Envelope>', /carries no operation/],
    ['<notAnEnvelope/>', /Expected a SOAP Envelope/],
    ['<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"/>', /no Body/],
    ['not xml at all', /Expected a SOAP Envelope|Malformed XML/],
  ]) {
    const res = await c.callRaw('POST', '/soap/v1', body, { 'Content-Type': 'text/xml' });
    assert.equal(res.status, 400, `expected 400 for ${body.slice(0, 30)}`);
    assert.match(res.text, expect);
  }

  const unknownOp = await soapCall(c, 'frobnicate', '<x/>');
  assert.equal(unknownOp.status, 400);
  assert.match(unknownOp.text, /Unknown operation/);

  const unknownType = await soapCall(c, 'get', '<recordRef type="not_a_record" internalId="x"/>');
  assert.equal(unknownType.status, 400);
  assert.match(unknownType.text, /Unknown record type/);
});

test('SOAP requires authentication and accepts an API token', async () => {
  const anon = await fetch(`${base}/soap/v1`, {
    method: 'POST', headers: { 'Content-Type': 'text/xml' },
    body: '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><get/></soap:Body></soap:Envelope>',
  });
  assert.equal(anon.status, 401, 'an unauthenticated SOAP call must not reach the data');

  const c = client();
  await c.login();
  const token = (await c.call('POST', '/api/v1/setup/api-tokens', { name: 'SOAP integrator' })).body.token;
  const res = await fetch(`${base}/soap/v1`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml',
      Authorization: 'Basic ' + Buffer.from(`owner@test.local:${token}`).toString('base64'),
    },
    body: '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
      + '<soap:Body><getDataCenterUrls xmlns="urn:platform.meridian.erp"/></soap:Body></soap:Envelope>',
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /<odataDomain>/, 'the service should advertise its sibling endpoints');
});

test('the Power BI connection file points at this server', async () => {
  const c = client();
  await c.login();
  const info = await c.call('GET', '/api/v1/powerbi/connection');
  assert.equal(info.status, 200, info.text);
  assert.match(info.body.odata_url, /\/odata\/v1$/);
  assert.ok(info.body.feeds.length >= 60);

  const pbids = await c.call('GET', '/api/v1/powerbi/meridian.pbids');
  assert.equal(pbids.status, 200);
  const parsed = JSON.parse(pbids.text);
  assert.equal(parsed.connections[0].details.protocol, 'odata');
  assert.match(parsed.connections[0].details.address.url, /\/odata\/v1/);
  assert.equal(parsed.connections[0].mode, 'Import');
});

test('an imported amount is stored at its face value, not a hundred times it', () => {
  const f = freshTenant();
  const csv = 'SKU,Name,Type,Price,Cost\nIMP-1,Imported Widget,inventory,49.99,20\n';
  const validation = dataio.validateImport(f.repo, { record_type: 'item', text: csv });
  assert.equal(validation.error_count, 0);
  assert.equal(validation.preview[0].values.base_price, 49.99);
  f.tx(() => dataio.commitImport(f.repo, { record_type: 'item', text: csv }));
  const item = f.repo.queryOne("SELECT base_price, standard_cost FROM item WHERE tenant_id = :t AND sku = 'IMP-1'");
  assert.equal(item.base_price, Money.parse(49.99));
  assert.equal(item.standard_cost, Money.parse(20));
});

test('a price column finds the item field it belongs to', () => {
  const map = dataio.suggestMapping('item', ['SKU', 'Name', 'Price', 'Unit Cost']);
  assert.equal(map.mapping.Price, 'base_price');
  assert.equal(map.mapping['Unit Cost'], 'standard_cost');
  assert.deepEqual(map.unmatched, []);
});
