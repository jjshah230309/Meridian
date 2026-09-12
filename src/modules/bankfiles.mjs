// Meridian ERP :: modules/bankfiles
// Parsers for the statement formats banks actually hand out.
//
//   OFX / QFX  -- SGML-ish tags, often without closing tags
//   BAI2       -- fixed record types, comma-delimited, amounts in cents
//   CAMT.053   -- ISO 20022 XML
//   CSV        -- whatever the bank felt like that day
//
// All four normalise to the same shape so bank.mjs only ever sees one kind
// of transaction. Amounts come back in minor units, signed positive for
// money in and negative for money out, because that is the one convention
// the reconciliation engine can rely on.
import { ulid, nowIso, Money } from '../core/util.mjs';
import { unprocessable, badRequest } from '../core/http.mjs';
import { parseCsv } from '../core/csv.mjs';

export const FORMATS = ['ofx', 'qfx', 'bai2', 'camt053', 'csv'];

/** Guess the format from the content rather than trusting the extension. */
export function sniffFormat(text) {
  const head = String(text).slice(0, 2000);
  if (/<OFX>/i.test(head) || /OFXHEADER/i.test(head)) return 'ofx';
  if (/<Document[\s>]/i.test(head) && /camt\.053/i.test(head)) return 'camt053';
  if (/<BkToCstmrStmt>/i.test(head)) return 'camt053';
  if (/^01,/m.test(head) && /^02,/m.test(head)) return 'bai2';
  return 'csv';
}

// ------------------------------------------------------------------ OFX
const ofxDate = (v) => {
  const s = String(v || '').trim();
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

/**
 * OFX and QFX are the same grammar; QFX just adds Intuit extensions we
 * ignore. Tags are frequently unclosed, so this scans tag-by-tag rather
 * than trying to parse it as XML.
 */
export function parseOfx(text) {
  const body = String(text);
  const start = body.search(/<OFX>/i);
  const src = start >= 0 ? body.slice(start) : body;

  const acctId = /<ACCTID>([^<\r\n]*)/i.exec(src)?.[1]?.trim() || '';
  const bankId = /<BANKID>([^<\r\n]*)/i.exec(src)?.[1]?.trim() || '';
  const currency = /<CURDEF>([^<\r\n]*)/i.exec(src)?.[1]?.trim() || 'USD';
  const ledgerBal = /<LEDGERBAL>[\s\S]*?<BALAMT>([^<\r\n]*)/i.exec(src)?.[1]?.trim();
  const balDate = /<LEDGERBAL>[\s\S]*?<DTASOF>([^<\r\n]*)/i.exec(src)?.[1]?.trim();

  const transactions = [];
  const blocks = src.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) || [];
  for (const b of blocks) {
    const tag = (name) => new RegExp(`<${name}>([^<\\r\\n]*)`, 'i').exec(b)?.[1]?.trim() || '';
    const amount = Money.parse(tag('TRNAMT'));
    const date = ofxDate(tag('DTPOSTED'));
    if (!date) continue;
    transactions.push({
      date,
      amount,                                          // sign as the bank stated it
      description: tag('NAME') || tag('MEMO') || tag('TRNTYPE'),
      memo: tag('MEMO'),
      reference: tag('FITID'),
      check_no: tag('CHECKNUM'),
      type: tag('TRNTYPE'),
      counterparty: tag('NAME'),
    });
  }
  if (!blocks.length) throw unprocessable('No <STMTTRN> transactions found in that OFX file');

  return {
    format: 'ofx', account_number: acctId, routing_number: bankId, currency,
    closing_balance: ledgerBal !== undefined ? Money.parse(ledgerBal) : null,
    balance_date: balDate ? ofxDate(balDate) : null,
    transactions,
  };
}

// ----------------------------------------------------------------- BAI2
const BAI2_CREDIT = new Set(['108', '115', '116', '118', '121', '122', '123', '135', '136', '142', '143', '145', '147', '155', '164', '165', '166', '168', '169', '171', '172', '173', '174', '175', '178', '182', '187', '191', '195', '301']);

/**
 * BAI2: `16` is a detail record, `03` opens an account, `02` a group.
 * Amounts are unsigned integers in the account currency's minor units, and
 * the type code says which direction -- which is why the credit-code set
 * above exists rather than reading a sign that is not there.
 */
export function parseBai2(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw unprocessable('That BAI2 file is empty');

  let account = '', currency = 'USD', openingBalance = null, closingBalance = null, asOf = null;
  const transactions = [];
  let pending = null;

  const flush = () => { if (pending) { transactions.push(pending); pending = null; } };

  for (const raw of lines) {
    // Continuation records (88) append to the previous record's text.
    const parts = raw.replace(/\/$/, '').split(',');
    const code = parts[0];

    if (code === '02') { asOf = bai2Date(parts[4]); continue; }
    if (code === '03') {
      flush();
      account = parts[1] || account;
      currency = parts[2] || currency;
      // Balance type 010 is opening ledger, 015 closing ledger.
      for (let i = 3; i + 1 < parts.length; i += 4) {
        const type = parts[i], amount = parts[i + 1];
        if (type === '010') openingBalance = Number(amount || 0);
        if (type === '015') closingBalance = Number(amount || 0);
      }
      continue;
    }
    if (code === '16') {
      flush();
      // 16,type-code,amount,funds-type,bank-ref,customer-ref,text
      const typeCode = parts[1] || '';
      const magnitude = Number(parts[2] || 0);
      const isCredit = BAI2_CREDIT.has(typeCode);
      const text = (parts.slice(6).join(',') || '').trim();
      pending = {
        date: asOf,
        amount: isCredit ? magnitude : -magnitude,
        description: text || `BAI2 ${typeCode}`,
        memo: text,
        reference: (parts[4] || parts[5] || '').trim(),
        type: typeCode,
        counterparty: '',
      };
      continue;
    }
    if (code === '88' && pending) {
      const extra = parts.slice(1).join(',').trim();
      if (extra) {
        pending.memo = `${pending.memo} ${extra}`.trim();
        // A continuation only becomes the description when the detail record
        // had no text of its own.
        if (/^BAI2 /.test(pending.description)) pending.description = pending.memo;
      }
      continue;
    }
    if (code === '49' || code === '98' || code === '99') { flush(); continue; }
  }
  flush();
  if (!transactions.length) throw unprocessable('No type-16 detail records found in that BAI2 file');

  return {
    format: 'bai2', account_number: account, routing_number: '', currency,
    opening_balance: openingBalance, closing_balance: closingBalance,
    balance_date: asOf, transactions,
  };
}

const bai2Date = (v) => {
  const s = String(v || '').trim();
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const yy = Number(m[1]);
  return `${yy < 70 ? 2000 + yy : 1900 + yy}-${m[2]}-${m[3]}`;
};

// -------------------------------------------------------------- CAMT.053
/**
 * ISO 20022 CAMT.053. Parsed with targeted regexes rather than a DOM: the
 * only nesting that matters is Ntry -> NtryDtls -> TxDtls, and a full XML
 * parser is a lot of code to add for one shape of document.
 */
export function parseCamt053(text) {
  const src = String(text);
  // The tag name must end at `>` or whitespace: `<Cd>` must not also match
  // `<CdtDbtInd>`, which sits beside it in every balance and entry block.
  const tagRe = (tag, flags) => new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, flags);
  const pick = (xml, tag) => tagRe(tag, 'i').exec(xml || '')?.[1]?.trim();
  const pickAll = (xml, tag) => [...(xml || '').matchAll(tagRe(tag, 'gi'))].map((m) => m[1]);
  // Dates arrive as <Dt>2026-08-31</Dt>, <DtTm>...</DtTm>, or nested
  // <Dt><Dt>...</Dt></Dt>. Pulling the first ISO date out of the block
  // handles all three without caring which one this bank chose.
  const pickDate = (xml) => /(\d{4}-\d{2}-\d{2})/.exec(xml || '')?.[1] || null;

  const stmt = pick(src, 'Stmt') || src;
  const acctBlock = pick(stmt, 'Acct') || '';
  const account = pick(acctBlock, 'IBAN') || pick(acctBlock, 'Othr') && pick(pick(acctBlock, 'Othr'), 'Id') || '';
  const currency = pick(acctBlock, 'Ccy') || 'EUR';

  let closingBalance = null, balanceDate = null;
  for (const bal of pickAll(stmt, 'Bal')) {
    const code = pick(bal, 'Cd') || '';
    if (code !== 'CLBD' && code !== 'CLAV') continue;
    const amt = pick(bal, 'Amt');
    const sign = (pick(bal, 'CdtDbtInd') || 'CRDT') === 'DBIT' ? -1 : 1;
    closingBalance = sign * Money.parse(amt);
    balanceDate = pickDate(pick(bal, 'Dt'));
  }

  const transactions = [];
  for (const entry of pickAll(stmt, 'Ntry')) {
    const amtRaw = pick(entry, 'Amt');
    const sign = (pick(entry, 'CdtDbtInd') || 'CRDT') === 'DBIT' ? -1 : 1;
    const date = pickDate(pick(entry, 'BookgDt')) || pickDate(pick(entry, 'ValDt'));
    if (!date) continue;
    const details = pick(entry, 'TxDtls') || entry;
    const rmt = pick(details, 'Ustrd') || pick(pick(details, 'RmtInf') || '', 'Ustrd') || '';
    const partyBlock = sign > 0 ? (pick(details, 'Dbtr') || '') : (pick(details, 'Cdtr') || '');
    const counterparty = pick(partyBlock, 'Nm') || '';
    transactions.push({
      date,
      amount: sign * Money.parse(amtRaw),
      description: rmt || counterparty || pick(entry, 'AddtlNtryInf') || 'Bank entry',
      memo: pick(entry, 'AddtlNtryInf') || rmt,
      reference: pick(entry, 'AcctSvcrRef') || pick(details, 'EndToEndId') || '',
      type: pick(pick(entry, 'BkTxCd') || '', 'Cd') || '',
      counterparty,
    });
  }
  if (!transactions.length) throw unprocessable('No <Ntry> entries found in that CAMT.053 file');

  return {
    format: 'camt053', account_number: account, routing_number: '', currency,
    closing_balance: closingBalance, balance_date: balanceDate, transactions,
  };
}

// ------------------------------------------------------------------ CSV
const CSV_ALIASES = {
  date: ['date', 'transactiondate', 'posteddate', 'valuedate', 'bookingdate'],
  amount: ['amount', 'value', 'transactionamount'],
  debit: ['debit', 'paidout', 'withdrawal', 'money out', 'moneyout', 'dr'],
  credit: ['credit', 'paidin', 'deposit', 'money in', 'moneyin', 'cr'],
  description: ['description', 'details', 'narrative', 'memo', 'reference', 'payee', 'name'],
  balance: ['balance', 'runningbalance'],
  reference: ['reference', 'ref', 'transactionid', 'fitid'],
};
const normh = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Bank CSV. Handles both shapes: a single signed amount column, or separate
 * debit and credit columns (where a value in the debit column is money out
 * regardless of how the bank signed it).
 */
export function parseBankCsv(text, { delimiter = null } = {}) {
  const parsed = parseCsv(text, { delimiter });
  if (!parsed.rows.length) throw unprocessable('That statement file has no data rows');

  const find = (key) => parsed.headers.find((h) => CSV_ALIASES[key].some((a) => normh(a) === normh(h)));
  const cDate = find('date'), cAmount = find('amount'), cDebit = find('debit'), cCredit = find('credit');
  const cDesc = find('description'), cRef = find('reference'), cBal = find('balance');
  if (!cDate) throw unprocessable(`No date column found. Headers were: ${parsed.headers.join(', ')}`);
  if (!cAmount && !cDebit && !cCredit) {
    throw unprocessable(`No amount column found. Headers were: ${parsed.headers.join(', ')}`);
  }

  const transactions = [];
  for (const row of parsed.rows) {
    const dateRaw = row[cDate];
    const date = normaliseDate(dateRaw);
    if (!date) continue;
    let amount;
    if (cAmount && String(row[cAmount] ?? '').trim() !== '') {
      amount = Money.parse(row[cAmount]);
    } else {
      const debit = cDebit ? Math.abs(Money.parse(row[cDebit])) : 0;
      const credit = cCredit ? Math.abs(Money.parse(row[cCredit])) : 0;
      amount = credit - debit;
    }
    if (!amount) continue;
    transactions.push({
      date, amount,
      description: (cDesc ? row[cDesc] : '') || 'Bank transaction',
      memo: cDesc ? row[cDesc] : '',
      reference: cRef ? row[cRef] : '',
      type: '', counterparty: '',
      balance: cBal ? Money.parse(row[cBal]) : null,
    });
  }
  if (!transactions.length) throw unprocessable('No usable rows found in that statement');
  const last = transactions[transactions.length - 1];
  return {
    format: 'csv', account_number: '', routing_number: '', currency: 'USD',
    closing_balance: last.balance ?? null, balance_date: last.date, transactions,
  };
}

function normaliseDate(v) {
  const s = String(v ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
  if (m) {
    let a = Number(m[1]), b = Number(m[2]), y = Number(m[3]);
    if (y < 100) y += y < 70 ? 2000 : 1900;
    const day = a > 12 ? a : b > 12 ? b : a;
    const month = a > 12 ? b : b > 12 ? a : b;
    const d = new Date(Date.UTC(y, month - 1, day));
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Parse any supported statement, detecting the format when not told. */
export function parseStatement(text, { format = null } = {}) {
  const fmt = format && format !== 'auto' ? format : sniffFormat(text);
  switch (fmt) {
    case 'ofx': case 'qfx': return { ...parseOfx(text), format: fmt };
    case 'bai2': return parseBai2(text);
    case 'camt053': return parseCamt053(text);
    case 'csv': return parseBankCsv(text);
    default: throw badRequest(`Unsupported statement format "${fmt}"`);
  }
}

/**
 * Load a parsed statement into bank_txn, skipping anything already there.
 * De-duplication is by bank reference where the file supplies one, and
 * otherwise by the date/amount/description triple -- imperfect, but it stops
 * the common case of importing January twice.
 */
export function importStatement(repo, { bank_account_id, text, format = null, filename = '' }) {
  const account = repo.get('bank_account', bank_account_id);
  if (!account) throw unprocessable(`Bank account ${bank_account_id} not found`);
  const parsed = parseStatement(text, { format });

  return repo.tx(() => {
    let imported = 0, duplicates = 0;
    for (const t of parsed.transactions) {
      // The bank's own id is the reliable key. Without one, fall back to the
      // date/amount/description triple, which catches the common mistake of
      // importing the same month twice.
      const existing = t.reference
        ? repo.queryOne('SELECT id FROM bank_txn WHERE tenant_id = :t AND bank_account_id = ? AND external_id = ? LIMIT 1', [bank_account_id, t.reference])
        : repo.queryOne(
          'SELECT id FROM bank_txn WHERE tenant_id = :t AND bank_account_id = ? AND txn_date = ? AND amount = ? AND description = ? LIMIT 1',
          [bank_account_id, t.date, t.amount, String(t.description || '').slice(0, 400)]);
      if (existing) { duplicates++; continue; }
      repo.insert('bank_txn', {
        id: ulid(), bank_account_id,
        txn_date: t.date, amount: t.amount,
        description: String(t.description || '').slice(0, 400),
        reference: String(t.reference || t.check_no || '').slice(0, 100),
        external_id: t.reference || null,
        status: 'unmatched', matched_txn_id: null, matched_journal_id: null,
        reconciliation_id: null,
        imported_at: nowIso(),
      });
      imported++;
    }
    return {
      account: account.name, format: parsed.format, filename,
      statement_currency: parsed.currency,
      closing_balance: parsed.closing_balance === null ? null : Money.toNumber(parsed.closing_balance),
      balance_date: parsed.balance_date,
      found: parsed.transactions.length, imported, duplicates,
    };
  });
}
