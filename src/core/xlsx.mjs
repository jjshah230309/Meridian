// Meridian ERP :: core/xlsx
// A styled .xlsx writer built on core/zip. No dependencies.
//
// The point of this file is that an export should look like something a
// person made: a title, a banded header that stays put when you scroll,
// currency that reads as currency, dates Excel understands as dates, columns
// wide enough for their contents, and a filter row you can immediately use.
// A CSV of raw integers is not a deliverable, it is a chore handed to
// somebody else.
//
// Values are written as typed cells -- numbers as numbers, dates as Excel
// serials -- because that is what makes a pivot table or a Power BI import
// work without the recipient re-typing every column.
import { zip } from './zip.mjs';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  // Excel rejects most control characters outright.
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

/** Excel serial date: whole days since 1899-12-30 (its leap-year quirk included). */
function excelSerial(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return ms / 86400000 + 25569;
}

/** 0 -> A, 25 -> Z, 26 -> AA */
export function colName(index) {
  let n = index + 1, out = '';
  while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
  return out;
}

// Style indices, in the order they are written into styles.xml below.
const S = {
  DEFAULT: 0, TITLE: 1, SUBTITLE: 2, HEADER: 3,
  TEXT: 4, NUMBER: 5, MONEY: 6, PERCENT: 7, DATE: 8, DATETIME: 9, INTEGER: 10,
  TOTAL_TEXT: 11, TOTAL_NUMBER: 12, TOTAL_MONEY: 13,
  MONEY_NEG: 14, BOLD: 15,
};

const STYLE_FOR = {
  text: S.TEXT, longtext: S.TEXT, select: S.TEXT, email: S.TEXT, phone: S.TEXT, url: S.TEXT,
  reference: S.TEXT, json: S.TEXT, checkbox: S.TEXT,
  number: S.NUMBER, qty: S.NUMBER, money: S.MONEY, percent: S.PERCENT,
  date: S.DATE, datetime: S.DATETIME, integer: S.INTEGER,
};

function stylesXml(currencyFormat) {
  // Custom number formats start at 164 by convention; 0-163 are built in.
  const money = esc(currencyFormat);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="4">
  <numFmt numFmtId="164" formatCode="${money}"/>
  <numFmt numFmtId="165" formatCode="0.0%"/>
  <numFmt numFmtId="166" formatCode="yyyy\\-mm\\-dd"/>
  <numFmt numFmtId="167" formatCode="yyyy\\-mm\\-dd\\ hh:mm"/>
</numFmts>
<fonts count="6">
  <font><sz val="11"/><color theme="1"/><name val="Calibri"/></font>
  <font><b/><sz val="16"/><color rgb="FF1A2233"/><name val="Calibri"/></font>
  <font><sz val="10"/><color rgb="FF6B7280"/><name val="Calibri"/></font>
  <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
  <font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/></font>
  <font><sz val="11"/><color rgb="FFB42318"/><name val="Calibri"/></font>
</fonts>
<fills count="4">
  <fill><patternFill patternType="none"/></fill>
  <fill><patternFill patternType="gray125"/></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FF1F3A5F"/><bgColor indexed="64"/></patternFill></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FFEEF2F7"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="3">
  <border><left/><right/><top/><bottom/><diagonal/></border>
  <border><left/><right/><top/><bottom style="thin"><color rgb="FFD8DEE7"/></bottom><diagonal/></border>
  <border><left/><right/><top style="thin"><color rgb="FF1F3A5F"/></top><bottom style="double"><color rgb="FF1F3A5F"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="16">
  <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
  <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  <xf numFmtId="0" fontId="3" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
  <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
  <xf numFmtId="2" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
  <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
  <xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
  <xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
  <xf numFmtId="167" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
  <xf numFmtId="1" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
  <xf numFmtId="0" fontId="4" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
  <xf numFmtId="2" fontId="4" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
  <xf numFmtId="164" fontId="4" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
  <xf numFmtId="164" fontId="5" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
  <xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function cell(ref, value, style, type) {
  if (value === null || value === undefined || value === '') return `<c r="${ref}" s="${style}"/>`;
  if (type === 'number') return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  if (type === 'bool') return `<c r="${ref}" s="${style}" t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

/**
 * One sheet.
 *   name    -- tab name
 *   title   -- optional heading rendered above the table
 *   subtitle-- optional line under the title
 *   columns -- [{ key, label, type, width }]
 *   rows    -- array of objects keyed by column.key
 *   totals  -- optional object keyed by column.key, rendered as a totals row
 */
function sheetXml(sheet) {
  const { columns = [], rows = [], title = null, subtitle = null, totals = null, freeze = true, autofilter = true } = sheet;
  const lines = [];
  let r = 0;

  const rowXml = (cells) => `<row r="${++r}"${cells.height ? ` ht="${cells.height}" customHeight="1"` : ''}>${cells.body}</row>`;

  if (title) lines.push(rowXml({ body: cell('A1', title, S.TITLE), height: 22 }));
  if (subtitle) lines.push(rowXml({ body: cell(`A${r + 1}`, subtitle, S.SUBTITLE) }));
  if (title || subtitle) lines.push(`<row r="${++r}"/>`);            // spacer

  const headerRow = r + 1;
  lines.push(rowXml({
    body: columns.map((c, i) => cell(`${colName(i)}${headerRow}`, c.label ?? c.key, S.HEADER)).join(''),
    height: 20,
  }));

  for (const row of rows) {
    const n = r + 1;
    const cells = columns.map((c, i) => {
      const ref = `${colName(i)}${n}`;
      const raw = row[c.key];
      const type = c.type || 'text';
      const style = STYLE_FOR[type] ?? S.TEXT;
      if (raw === null || raw === undefined || raw === '') return cell(ref, null, style);
      if (type === 'date' || type === 'datetime') {
        const serial = excelSerial(raw);
        return serial === null ? cell(ref, raw, S.TEXT) : cell(ref, serial, style, 'number');
      }
      if (type === 'money' || type === 'number' || type === 'qty' || type === 'integer') {
        const n2 = Number(raw);
        if (!Number.isFinite(n2)) return cell(ref, raw, S.TEXT);
        // Negative money in red, which is the one bit of conditional
        // formatting every finance reader expects to be there.
        return cell(ref, n2, type === 'money' && n2 < 0 ? S.MONEY_NEG : style, 'number');
      }
      if (type === 'percent') {
        const n2 = Number(raw);
        return Number.isFinite(n2) ? cell(ref, n2 / 100, style, 'number') : cell(ref, raw, S.TEXT);
      }
      if (type === 'checkbox') return cell(ref, raw ? 'Yes' : 'No', style);
      return cell(ref, typeof raw === 'object' ? JSON.stringify(raw) : raw, style);
    }).join('');
    lines.push(rowXml({ body: cells }));
  }

  if (totals) {
    const n = r + 1;
    lines.push(rowXml({
      body: columns.map((c, i) => {
        const ref = `${colName(i)}${n}`;
        const v = totals[c.key];
        if (v === undefined || v === null) return cell(ref, i === 0 ? 'Total' : null, S.TOTAL_TEXT);
        const num = Number(v);
        if (!Number.isFinite(num)) return cell(ref, v, S.TOTAL_TEXT);
        return cell(ref, num, c.type === 'money' ? S.TOTAL_MONEY : S.TOTAL_NUMBER, 'number');
      }).join(''),
    }));
  }

  const lastCol = colName(Math.max(0, columns.length - 1));
  const cols = columns.map((c, i) => {
    // Width from the widest of the header and a sample of the data, so a
    // column of long descriptions is readable without being absurd.
    const sample = rows.slice(0, 200).reduce((w, row) => Math.max(w, String(row[c.key] ?? '').length), 0);
    const width = c.width || Math.min(52, Math.max(10, (c.label || c.key).length + 3, sample + 2));
    return `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`;
  }).join('');

  const paneRow = headerRow;
  const pane = freeze
    ? `<sheetView showGridLines="0" workbookViewId="0"><pane ySplit="${paneRow}" topLeftCell="A${paneRow + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${paneRow + 1}" sqref="A${paneRow + 1}"/></sheetView>`
    : '<sheetView showGridLines="0" workbookViewId="0"/>';
  const filter = autofilter && rows.length
    ? `<autoFilter ref="A${headerRow}:${lastCol}${headerRow + rows.length}"/>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews>${pane}</sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols}</cols>
<sheetData>${lines.join('')}</sheetData>
${filter}
<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>
<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>
</worksheet>`;
}

const safeName = (n, i) => {
  // Excel tab names: 31 chars, no : \ / ? * [ ]
  const cleaned = String(n || `Sheet${i + 1}`).replace(/[:\\/?*[\]]/g, ' ').slice(0, 31).trim();
  return cleaned || `Sheet${i + 1}`;
};

/**
 * Build a workbook.
 * `sheets` is an array of sheet descriptors (see sheetXml).
 */
export function buildXlsx(sheets, { currencyFormat = '#,##0.00', creator = 'Meridian ERP', title = 'Export' } = {}) {
  const list = (Array.isArray(sheets) ? sheets : [sheets]).filter(Boolean);
  if (!list.length) throw new Error('An xlsx needs at least one sheet');
  const names = [];
  for (const [i, s] of list.entries()) {
    let n = safeName(s.name, i);
    let suffix = 1;
    while (names.includes(n)) n = `${safeName(s.name, i).slice(0, 28)}_${++suffix}`;
    names.push(n);
  }

  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const files = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
${list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
    },
    {
      name: 'docProps/core.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${esc(title)}</dc:title><dc:creator>${esc(creator)}</dc:creator><cp:lastModifiedBy>${esc(creator)}</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`,
    },
    {
      name: 'docProps/app.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>${esc(creator)}</Application><Company>${esc(creator)}</Company>
</Properties>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<workbookPr/><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="14000"/></bookViews>
<sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    { name: 'xl/styles.xml', data: stylesXml(currencyFormat) },
    ...list.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ];

  return zip(files);
}

/** Excel number format for an ISO currency code. */
export const currencyFormatFor = (code) => {
  const symbols = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', AUD: '$', CAD: '$', CHF: 'CHF ', INR: '₹', AED: 'AED ' };
  const sym = symbols[code] || `${code} `;
  const dp = code === 'JPY' ? 0 : 2;
  const num = dp ? '#,##0.00' : '#,##0';
  return `"${sym}"${num};[Red]-"${sym}"${num}`;
};
