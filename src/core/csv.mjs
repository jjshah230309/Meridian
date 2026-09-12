// Meridian ERP :: core/csv
// RFC 4180 CSV, both directions, with the deviations real files actually
// contain: a UTF-8 BOM, CRLF or LF, semicolon or tab delimiters, and quoted
// fields containing the delimiter, quotes or newlines.
//
// Parsing is a character-scanner rather than a split() because a naive split
// corrupts any address field with a comma in it -- which is most of them.

/** Guess the delimiter from the header line. */
export function sniffDelimiter(text) {
  const line = text.slice(0, 8192).split(/\r?\n/)[0] || '';
  const counts = [',', ';', '\t', '|'].map((d) => {
    // Count only delimiters outside quotes.
    let n = 0, inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') inQuotes = !inQuotes;
      else if (c === d && !inQuotes) n++;
    }
    return { d, n };
  });
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].d : ',';
}

/**
 * Parse CSV text into { headers, rows } where each row is an object.
 * `rows` preserves the source line number so an error can point at it.
 */
export function parseCsv(text, { delimiter = null, headers: suppliedHeaders = null, maxRows = 100_000 } = {}) {
  let src = String(text ?? '');
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);              // strip BOM
  const d = delimiter || sniffDelimiter(src);

  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  let i = 0;
  let line = 1;
  let recordStartLine = 1;

  const endField = () => { record.push(field); field = ''; };
  const endRecord = () => {
    endField();
    // Skip the blank line that trails most files.
    if (!(record.length === 1 && record[0] === '')) records.push({ line: recordStartLine, values: record });
    record = [];
    recordStartLine = line;
  };

  while (i < src.length) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      if (c === '\n') line++;
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { inQuotes = true; i++; continue; }
    if (c === d) { endField(); i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { line++; endRecord(); i++; continue; }
    field += c; i++;
  }
  if (field !== '' || record.length) endRecord();

  if (!records.length) return { headers: [], rows: [], delimiter: d };
  const headers = suppliedHeaders || records[0].values.map((h) => String(h).trim());
  const body = suppliedHeaders ? records : records.slice(1);

  const rows = [];
  for (const rec of body.slice(0, maxRows)) {
    const obj = { __line: rec.line };
    headers.forEach((h, idx) => { obj[h] = rec.values[idx] !== undefined ? rec.values[idx] : ''; });
    // Keep the raw array too, for files whose headers repeat or are blank.
    obj.__values = rec.values;
    rows.push(obj);
  }
  return { headers, rows, delimiter: d, truncated: body.length > maxRows };
}

const needsQuote = (s, d) => s.includes(d) || s.includes('"') || s.includes('\n') || s.includes('\r')
  // A leading =, +, - or @ is executed as a formula by Excel and Sheets.
  || /^[=+\-@\t\r]/.test(s);

/** Quote one value for output, defusing spreadsheet formula injection. */
export function csvValue(v, delimiter = ',') {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Excel and Sheets execute a cell that opens with =, +, - or @, and a
  // leading tab or carriage return is enough to smuggle one of those past a
  // naive check. A leading apostrophe forces the whole cell to be literal.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return needsQuote(s, delimiter) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialise rows (array of objects) with the given columns. */
export function toCsv(rows, columns, { delimiter = ',', bom = true, eol = '\r\n' } = {}) {
  const cols = columns.map((c) => (typeof c === 'string' ? { key: c, label: c } : c));
  const head = cols.map((c) => csvValue(c.label ?? c.key, delimiter)).join(delimiter);
  const body = rows.map((r) => cols.map((c) => csvValue(r[c.key], delimiter)).join(delimiter));
  return (bom ? '﻿' : '') + [head, ...body].join(eol) + eol;
}
