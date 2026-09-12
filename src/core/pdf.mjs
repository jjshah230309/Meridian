// Meridian ERP :: core/pdf
// A minimal PDF 1.4 writer: enough to lay out a table-based report or a
// financial statement on paper, with no dependencies. We use the 14 standard
// Type1 fonts (Helvetica family), which every viewer has built in, so nothing
// has to be embedded and a statement pack stays a few kilobytes.
//
// The file is assembled as numbered objects followed by a cross-reference
// table; byte offsets must be exact, so the body is built into a buffer list
// and offsets are measured as it goes.
import zlib from 'node:zlib';

// Widths of the standard fonts, in 1/1000 em, for codes 32..126. Without
// these every column would have to be measured by guesswork and long text
// would run off the page.
const W_HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

export const PAGE = {
  A4: { w: 595.28, h: 841.89 },
  A4_LANDSCAPE: { w: 841.89, h: 595.28 },
  LETTER: { w: 612, h: 792 },
  LETTER_LANDSCAPE: { w: 792, h: 612 },
};

const FONTS = { regular: 'F1', bold: 'F2', oblique: 'F3' };

/**
 * WinAnsi characters outside ASCII whose width is nowhere near the average.
 * An em dash is four times a middle dot; measuring both at 556 either
 * overflows the column or leaves a hole in it.
 */
const W_EXTRA = {
  0x80: 556, 0x85: 1000, 0x86: 556, 0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333,
  0x95: 350, 0x96: 556, 0x97: 1000, 0xa0: 278, 0xa3: 556, 0xa9: 737, 0xae: 737,
  0xb0: 400, 0xb7: 278, 0xd7: 584, 0xf7: 584,
};

/** Width of `text` at `size` points, in points. */
export function textWidth(text, size, bold = false) {
  const table = bold ? W_BOLD : W_HELV;
  let total = 0;
  // Measure what will actually be written, not what was passed in: a
  // character that folds into two takes the width of both.
  for (const ch of String(text)) {
    for (const written of FOLD[ch] ?? ch) {
      const c = written.codePointAt(0);
      total += (c >= 32 && c <= 126) ? table[c - 32] : (W_EXTRA[c] ?? 556);
    }
  }
  return (total * size) / 1000;
}

/** Trim `text` to fit `maxWidth`, adding an ellipsis when it has to cut. */
export function ellipsize(text, maxWidth, size, bold = false) {
  const s = String(text ?? '');
  if (textWidth(s, size, bold) <= maxWidth) return s;
  const dots = textWidth('...', size, bold);
  let out = '';
  for (const ch of s) {
    if (textWidth(out + ch, size, bold) + dots > maxWidth) break;
    out += ch;
  }
  return `${out}...`;
}

/** Break `text` into lines that each fit `maxWidth`. */
export function wrap(text, maxWidth, size, bold = false) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = []; let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, size, bold) <= maxWidth) { line = candidate; continue; }
    if (line) lines.push(line);
    // A single word longer than the column has to be cut mid-word.
    line = textWidth(word, size, bold) <= maxWidth ? word : ellipsize(word, maxWidth, size, bold);
  }
  if (line) lines.push(line);
  return lines;
}

// PDF string literals escape backslash and both parens. The fonts are
// WinAnsi-encoded, which is Latin-1 plus a block of typographic characters at
// 0x80-0x9F: curly quotes, both dashes, the ellipsis, the bullet and the euro
// all have real glyphs there, so they are mapped to their code points rather
// than degraded to ASCII. The stream is written as latin1, so the character
// is the byte. Anything outside WinAnsi still falls back to something
// readable rather than a random glyph.
const FOLD = {
  '\u2018': '\u0091', '\u2019': '\u0092',        // single curly quotes
  '\u201c': '\u0093', '\u201d': '\u0094',        // double curly quotes
  '\u2013': '\u0096', '\u2014': '\u0097',        // en dash, em dash
  '\u2026': '\u0085', '\u20ac': '\u0080',        // ellipsis, euro
  '\u2022': '\u0095', '\u2020': '\u0086',        // bullet, dagger
  '\u00a0': ' ',                                  // non-breaking space
  '\u2192': '->', '\u2190': '<-',
};
function pdfString(s) {
  let out = '';
  for (const ch of String(s ?? '')) {
    const folded = FOLD[ch] ?? ch;
    for (const c of folded) {
      const code = c.codePointAt(0);
      if (c === '\\' || c === '(' || c === ')') out += `\\${c}`;
      else if (code < 32) out += ' ';
      else if (code <= 255) out += c;
      else out += '?';
    }
  }
  return out;
}

/** A page being written to: holds the content stream operators. */
class Page {
  constructor(size) { this.size = size; this.ops = []; }
  text(x, y, s, { size = 9, bold = false, oblique = false, color = null, align = 'left', width = 0 } = {}) {
    const str = String(s ?? '');
    if (!str) return this;
    let tx = x;
    if (align !== 'left' && width) {
      const w = textWidth(str, size, bold);
      tx = align === 'right' ? x + width - w : x + (width - w) / 2;
    }
    const font = bold ? FONTS.bold : oblique ? FONTS.oblique : FONTS.regular;
    if (color) this.ops.push(`${color.join(' ')} rg`);
    this.ops.push(`BT /${font} ${size} Tf 1 0 0 1 ${tx.toFixed(2)} ${y.toFixed(2)} Tm (${pdfString(str)}) Tj ET`);
    if (color) this.ops.push('0 0 0 rg');
    return this;
  }
  rect(x, y, w, h, fill) {
    this.ops.push(`${fill.join(' ')} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f 0 0 0 rg`);
    return this;
  }
  line(x1, y1, x2, y2, { width = 0.5, color = [0.8, 0.8, 0.8] } = {}) {
    this.ops.push(`${color.join(' ')} RG ${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S 0 0 0 RG`);
    return this;
  }
  get stream() { return this.ops.join('\n'); }
}

/** Assemble pages into a PDF file. */
export function buildPdf(pages, { title = 'Report', author = 'Meridian ERP', compress = true } = {}) {
  const objects = [];                       // 1-based; objects[0] is object 1
  const add = (body) => { objects.push(body); return objects.length; };

  const fontRegular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const fontOblique = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>');
  const resources = `<< /Font << /${FONTS.regular} ${fontRegular} 0 R /${FONTS.bold} ${fontBold} 0 R /${FONTS.oblique} ${fontOblique} 0 R >> >>`;

  const pagesObjNo = objects.length + 1;
  add('');                                  // placeholder, filled in below

  const kids = [];
  for (const p of pages) {
    const raw = Buffer.from(p.stream, 'latin1');
    const data = compress ? zlib.deflateSync(raw) : raw;
    const filter = compress ? ' /Filter /FlateDecode' : '';
    const contentNo = add({ dict: `<< /Length ${data.length}${filter} >>`, stream: data });
    const pageNo = add(`<< /Type /Page /Parent ${pagesObjNo} 0 R /MediaBox [0 0 ${p.size.w.toFixed(2)} ${p.size.h.toFixed(2)}] `
      + `/Resources ${resources} /Contents ${contentNo} 0 R >>`);
    kids.push(pageNo);
  }
  objects[pagesObjNo - 1] = `<< /Type /Pages /Count ${kids.length} /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] >>`;

  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '');
  const infoNo = add(`<< /Title (${pdfString(title)}) /Author (${pdfString(author)}) /Producer (${pdfString(author)}) `
    + `/CreationDate (D:${stamp}Z) >>`);
  const catalogNo = add(`<< /Type /Catalog /Pages ${pagesObjNo} 0 R >>`);

  // Serialise, recording the byte offset of every object for the xref table.
  const chunks = [];
  let offset = 0;
  const push = (buf) => { const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'latin1'); chunks.push(b); offset += b.length; };
  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');    // binary comment marks the file as non-ASCII

  const offsets = [];
  objects.forEach((obj, i) => {
    offsets[i] = offset;
    if (typeof obj === 'string') { push(`${i + 1} 0 obj\n${obj}\nendobj\n`); return; }
    push(`${i + 1} 0 obj\n${obj.dict}\nstream\n`);
    push(obj.stream);
    push('\nendstream\nendobj\n');
  });

  const xrefAt = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogNo} 0 R /Info ${infoNo} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

// ------------------------------------------------------------------ layout

const GREY = [0.42, 0.42, 0.45];
const RULE = [0.85, 0.85, 0.87];
const BAND = [0.96, 0.96, 0.97];
const HEAD = [0.13, 0.16, 0.22];
const RED = [0.72, 0.13, 0.13];

/**
 * Lay out one or more tabular sections as a paginated report.
 *
 * `sections` are `{ title, subtitle, columns, rows, totals, note }`, where a
 * column is `{ key, label, type, width }`. Numeric and money columns are
 * right-aligned and negatives print in red, the way an accountant expects.
 */
export function buildReportPdf({
  title, subtitle = '', sections = [], size = PAGE.A4, footer = '', currency = '',
} = {}) {
  const M = 40;                              // page margin
  const contentW = size.w - M * 2;
  const pages = [];
  let page = null; let y = 0; let pageNo = 0;

  const startPage = () => {
    page = new Page(size); pages.push(page); pageNo++;
    y = size.h - M;
    page.text(M, y, title, { size: 16, bold: true });
    y -= 15;
    if (subtitle) { page.text(M, y, subtitle, { size: 8.5, color: GREY }); y -= 12; }
    page.line(M, y, size.w - M, y, { color: RULE, width: 1 });
    y -= 18;
  };
  const finishPages = () => {
    pages.forEach((p, i) => {
      const label = `Page ${i + 1} of ${pages.length}`;
      p.text(M, M - 14, footer || '', { size: 7.5, color: GREY });
      p.text(size.w - M - 120, M - 14, label, { size: 7.5, color: GREY, align: 'right', width: 120 });
    });
  };
  const need = (h) => { if (!page || y - h < M + 8) startPage(); };

  const fmt = (v, type, decimals) => {
    if (v === null || v === undefined || v === '') return '';
    if (type === 'money') {
      const n = Number(v);
      if (!Number.isFinite(n)) return String(v);
      const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return n < 0 ? `(${s})` : s;
    }
    if (type === 'number' || type === 'qty') {
      const n = Number(v);
      return Number.isFinite(n)
        ? n.toLocaleString('en-US', decimals === undefined
          ? { maximumFractionDigits: 4 }
          : { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
        : String(v);
    }
    if (type === 'percent') { const n = Number(v); return Number.isFinite(n) ? `${n.toFixed(decimals ?? 1)}%` : String(v); }
    if (type === 'checkbox') return v ? 'Yes' : 'No';
    return String(v);
  };
  const isNumeric = (t) => t === 'money' || t === 'number' || t === 'qty' || t === 'percent';

  for (const section of sections) {
    const cols = resolveWidths(section.columns || [], contentW);
    const rows = section.rows || [];

    need(52);
    if (section.title) { page.text(M, y, section.title, { size: 11, bold: true }); y -= 13; }
    // The header band is drawn from y-4 upward, so leave it room or it clips
    // the descenders of the line above.
    if (section.subtitle) { page.text(M, y, section.subtitle, { size: 8, color: GREY }); y -= 16; }
    else if (section.title) { y -= 3; }

    // Prose. A statement or a chasing letter is mostly sentences with a table
    // in the middle of it, and a report writer that can only draw tables has
    // to have the sentences pasted into a one-column grid.
    for (const para of section.paragraphs || []) {
      if (!String(para).trim()) { y -= 7; continue; }
      for (const line of wrap(String(para), contentW, 9)) {
        need(13);
        page.text(M, y, line, { size: 9 });
        y -= 12;
      }
      y -= 7;
    }
    if (!cols.length) { y -= 6; continue; }

    const header = () => {
      page.rect(M, y - 4, contentW, 15, BAND);
      let x = M;
      for (const c of cols) {
        page.text(x + 3, y, ellipsize(c.label, c.width - 6, 8, true),
          { size: 8, bold: true, color: HEAD, align: isNumeric(c.type) ? 'right' : 'left', width: c.width - 6 });
        x += c.width;
      }
      y -= 17;
      page.line(M, y + 4, size.w - M, y + 4, { color: RULE });
    };
    header();

    for (const row of rows) {
      if (y - 14 < M + 8) { startPage(); header(); }
      let x = M;
      for (const c of cols) {
        const raw = c.key.startsWith('custom.') ? row.custom?.[c.key.slice(7)] : row[c.key];
        const text = fmt(raw, c.type, c.decimals);
        const negative = c.type === 'money' && Number(raw) < 0;
        page.text(x + 3, y, ellipsize(text, c.width - 6, 8.5),
          { size: 8.5, align: isNumeric(c.type) ? 'right' : 'left', width: c.width - 6, color: negative ? RED : null });
        x += c.width;
      }
      y -= 13;
    }

    if (section.totals) {
      page.line(M, y + 6, size.w - M, y + 6, { color: HEAD, width: 0.8 });
      y -= 3;
      let x = M;
      for (const c of cols) {
        const v = section.totals[c.key];
        const text = v === undefined ? (x === M ? 'Total' : '') : fmt(v, c.type, c.decimals);
        page.text(x + 3, y, text, { size: 8.5, bold: true, align: isNumeric(c.type) ? 'right' : 'left', width: c.width - 6 });
        x += c.width;
      }
      y -= 15;
    }
    if (section.note) { y -= 2; page.text(M, y, section.note, { size: 7.5, oblique: true, color: GREY }); y -= 12; }
    y -= 12;
  }

  if (!pages.length) { startPage(); page.text(M, y, 'No data for this selection.', { size: 9, color: GREY }); }
  finishPages();
  return buildPdf(pages, { title: currency ? `${title} (${currency})` : title });
}

/**
 * Share the page width between columns: honour explicit widths, size the rest
 * from their type, then scale everything to fit exactly.
 */
function resolveWidths(columns, total) {
  const cols = columns.map((c) => {
    const key = typeof c === 'string' ? c : c.key;
    const type = (typeof c === 'object' && c.type) || 'text';
    const label = (typeof c === 'object' && c.label) || key;
    const hint = (typeof c === 'object' && c.width) || null;
    const decimals = typeof c === 'object' ? c.decimals : undefined;
    const natural = hint || (type === 'money' || type === 'number' || type === 'qty' ? 80
      : type === 'date' ? 68 : type === 'percent' || type === 'checkbox' ? 52 : 110);
    return { key, label, type, decimals, width: natural };
  });
  const sum = cols.reduce((a, c) => a + c.width, 0) || 1;
  const scale = total / sum;
  for (const c of cols) c.width *= scale;
  return cols;
}
