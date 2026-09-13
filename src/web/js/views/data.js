// Meridian ERP :: web/views/data
// Bringing data in and getting it out: CSV/spreadsheet import with a mapping
// step and a reversible commit, bank statement files, exports in every
// supported format, and the connection details BI tools need.
import { h, mount, clear } from '../dom.js';
import { icon } from '../icons.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import * as store from '../store.js';
import { empty, toast, notifyError, notifyOk, modal, confirm, statusTag, facts, loading, displayValue } from '../ui.js';

const TABS = [
  { id: 'import', label: 'Import', perm: 'data_import' },
  { id: 'export', label: 'Export', perm: 'customer' },
  { id: 'bank', label: 'Bank files', perm: 'bank_txn' },
  { id: 'connect', label: 'Power BI & connections', perm: 'account' },
  { id: 'history', label: 'History', perm: 'data_import' },
];

export async function dataView(route, { go }) {
  const active = route.parts[1] || 'import';
  const visible = TABS.filter((t) => store.can(t.perm));
  const host = h('div');

  const tabs = h('div.tabs', ...visible.map((t) => h('button.tab', {
    class: t.id === active ? 'active' : '',
    onclick: () => go(`/data/${t.id}`),
  }, t.label)));

  const renderers = { import: importTab, export: exportTab, bank: bankTab, connect: connectTab, history: historyTab };
  const render = renderers[active] || importTab;
  mount(host, loading());
  render(go).then((el) => mount(host, el)).catch((e) => mount(host, empty('Could not load', e.message)));

  return h('div.page',
    h('div.page-head', h('div.titles',
      h('h1', 'Import & Export'),
      h('div.page-sub', 'Move data in and out, and connect the reporting tools you already use'))),
    tabs, host);
}

// Business order, not alphabetical: a picker that opens on "Carts" because C
// sorts first is a picker nobody trusts.
const GROUP_ORDER = ['Sales', 'Purchasing', 'Inventory', 'Financial', 'CRM', 'People',
  'Projects', 'Manufacturing', 'Commerce', 'Service', 'Platform'];
const orderGroups = (names) => [...names].sort((a, b) => {
  const ia = GROUP_ORDER.indexOf(a); const ib = GROUP_ORDER.indexOf(b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
});

// Read a file the user picked. A .xlsx is read as base64 -- the server owns
// the actual parsing, in core/xlsx.mjs -- everything else as text, which
// covers CSV, TSV and plain-text exports.
const isSpreadsheet = (file) => /\.xlsx?$/i.test(file.name);

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsText(file);
  });
}
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',', 2)[1] || '');
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}
/** A file's contents in the shape every import route already accepts. */
async function readFileBody(file) {
  return isSpreadsheet(file) ? { data: await readFileAsBase64(file) } : { text: await readFileAsText(file) };
}

const filePicker = (accept, onPick, { multiple = false } = {}) => {
  const input = h('input', {
    type: 'file', accept, multiple, style: { display: 'none' },
    onchange: async () => {
      const files = [...(input.files || [])];
      if (!files.length) return;
      try { await onPick(files); }
      catch (e) { notifyError(e); }
      finally { input.value = ''; }     // let the same file(s) be picked twice
    },
  });
  return input;
};

// ------------------------------------------------------------------ import
//
// Two ways in, sharing everything except how a person starts: one file into
// one screen for topping up a list, several files (or one workbook with
// several tabs) for bringing a whole system's worth of spreadsheets over at
// once. Both end up calling the same four import routes; the bulk screen
// additionally orders what it sends through IMPORT_ORDER on the server, so
// customers land before the invoices that reference them.

/** The column-mapping table, shared by the single-file and bulk screens. */
function mappingTable(suggestion) {
  const fieldOptions = [{ name: '', label: '— skip this column —' }, ...suggestion.fields];
  const selects = new Map();
  const rows = Object.keys(suggestion.mapping).concat(suggestion.unmatched || [])
    .filter((v, i, a) => a.indexOf(v) === i)
    .map((header) => {
      const sel = h('select', { style: { width: '100%' } },
        ...fieldOptions.map((f) => h('option', {
          value: f.name, selected: f.name === (suggestion.mapping[header] || ''),
        }, f.required ? `${f.label} *` : f.label)));
      selects.set(header, sel);
      const matched = !!suggestion.mapping[header];
      return h('tr',
        h('td', h('strong', header)),
        h('td', sel),
        h('td', matched ? h('span.tag.green', 'Matched') : h('span.tag.amber', 'Unmatched')));
    });
  const required = suggestion.fields.filter((f) => f.required).map((f) => f.label);
  const currentMapping = () => {
    const out = {};
    for (const [header, sel] of selects) if (sel.value) out[header] = sel.value;
    return out;
  };
  const el = h('div.grid-wrap', h('table.grid',
    h('thead', h('tr', h('th', 'Column in your file'), h('th', 'Goes to'), h('th', { style: { width: '110px' } }, ''))),
    h('tbody', ...rows)));
  return { el, required, currentMapping };
}

/** The KPI/warnings/errors/preview for one validation report. No commit button -- callers wire that themselves, since a single file and a batch item confirm differently. */
function validationSummary(report, fields) {
  const fieldsByName = new Map((fields || []).map((f) => [f.name, f]));
  const summary = h('div.kpi-grid', { style: { marginBottom: '12px' } },
    h('div.kpi', h('div.k-label', 'Rows in file'), h('div.k-value.sm', fmt.num(report.total_rows))),
    h('div.kpi', h('div.k-label', 'Ready to import'), h('div.k-value.sm', fmt.num(report.valid_rows))),
    h('div.kpi', h('div.k-label', 'With problems'),
      h('div.k-value.sm', { class: report.error_count ? 'num-neg' : '' }, fmt.num(report.error_count))),
    h('div.kpi', h('div.k-label', 'Will update'), h('div.k-value.sm', fmt.num(report.match_count || 0))));

  // Ambiguous dates are the classic silent import corruption: 03/04/2026 is
  // two different days depending on where the file came from.
  const dateWarning = report.ambiguous_dates?.length
    ? h('div.callout.warn',
      h('strong', 'Check the date format. '),
      `${report.ambiguous_dates.length} date${report.ambiguous_dates.length === 1 ? '' : 's'} could be read either day-first or month-first `
      + `(for example ${report.ambiguous_dates[0].value} on line ${report.ambiguous_dates[0].line}). `
      + 'They were read as day/month. Use YYYY-MM-DD in the file to be certain.')
    : null;

  const errorTable = report.errors?.length
    ? h('div.card', { style: { marginTop: '12px' } },
      h('div.card-head', h('h2', 'Rows that will not import'),
        h('span.muted', { style: { fontSize: '12px' } }, `${report.errors.length} shown`)),
      h('div.grid-wrap', h('table.grid',
        h('thead', h('tr', h('th', { style: { width: '70px' } }, 'Line'), h('th', 'Column'), h('th', 'Problem'))),
        h('tbody', ...report.errors.slice(0, 200).map((e) => h('tr',
          h('td.muted', String(e.line)),
          h('td', e.field || '—'),
          h('td', e.message)))))))
    : null;

  // The preview is the prepared values, so it shows what will actually be
  // stored -- not the raw text of the file. But "stored" here means what
  // dataio.mjs's coerce() hands back, which is deliberately face value for
  // money and quantity columns (its own comment: returning minor units there
  // would scale everything a second time, since the row is handed to the
  // same create/update path the REST API uses, and that path does the actual
  // scaling). displayValue() and fmt.money()/fmt.qty() are written for
  // already-scaled storage values -- correct everywhere else in the app,
  // since a list or a record view reads straight from the database -- so
  // calling them directly here would silently divide a preview price or
  // quantity by 100 or a million. Scaling back up right at this one boundary
  // is what keeps that contract honest without changing it anywhere else.
  const SCALE = { money: 100, qty: 1_000_000 };
  const shownFields = report.preview?.length
    ? [...new Set(report.preview.flatMap((p) => Object.keys(p.values)))].slice(0, 8)
    : [];
  const preview = report.preview?.length
    ? h('div.card', { style: { marginTop: '12px' } },
      h('div.card-head', h('h2', 'Preview'),
        h('span.muted', { style: { fontSize: '12px' } }, 'The first rows exactly as they will be saved')),
      h('div.grid-wrap', h('table.grid',
        h('thead', h('tr', h('th', { style: { width: '60px' } }, 'Line'), h('th', { style: { width: '80px' } }, 'Action'),
          ...shownFields.map((k) => h('th', fieldsByName.get(k)?.label || fmt.titleCase(k))))),
        h('tbody', ...report.preview.slice(0, 8).map((p) => h('tr',
          h('td.muted', String(p.line)),
          h('td', p.action === 'update' ? h('span.tag.amber', 'Update') : h('span.tag.green', 'Create')),
          ...shownFields.map((k) => {
            const f = fieldsByName.get(k);
            const raw = p.values[k];
            if (raw === null || raw === undefined || raw === '') return h('td.muted', '—');
            const scale = f && SCALE[f.type];
            const v = scale ? Math.round(raw * scale) : raw;
            return h('td', f ? displayValue(f, v, p.values) : String(raw));
          })))))))
    : null;

  return [summary, dateWarning, errorTable, preview].filter(Boolean);
}

async function importTab(go) {
  const { record_types: types } = await API.importTypes();
  const byGroup = {};
  for (const t of types) (byGroup[t.group] = byGroup[t.group] || []).push(t);
  const ordered = orderGroups(Object.keys(byGroup));

  const typeOptions = (selectedType) => ordered.map((g) => h('optgroup', { label: g },
    ...byGroup[g].map((t) => h('option', { value: t.type, selected: t.type === selectedType }, t.label))));

  return h('div',
    singleFileCard(go, types, typeOptions),
    bulkImportCard(go, types, typeOptions));
}

// -------------------------------------------------------- one file at a time

function singleFileCard(go, types, typeOptions) {
  const typeSel = h('select', { style: { width: '260px' } }, ...typeOptions('customer'));

  const modeSel = h('select', { style: { width: '200px' } },
    h('option', { value: 'add' }, 'Add new records only'),
    h('option', { value: 'upsert' }, 'Add or update matching records'),
    h('option', { value: 'update' }, 'Update existing records only'));

  const keyField = h('input', { type: 'text', placeholder: 'name', style: { width: '160px' } });
  const keyRow = h('div.field', { style: { display: 'none' } },
    h('label', 'Match existing records on'), keyField,
    h('div.help', 'The column that identifies a record you already have — its number, name or email.'));
  modeSel.addEventListener('change', () => {
    keyRow.style.display = modeSel.value === 'add' ? 'none' : '';
  });

  const stage = h('div');
  let picked = null;                    // { name, body: {text} | {data}, sheet }

  const picker = filePicker('.csv,.txt,.tsv,.xlsx,.xls,text/csv', async ([file]) => {
    const body = await readFileBody(file);
    picked = { name: file.name, body, sheet: null };
    if (body.data) {
      mount(stage, loading('Reading the workbook'));
      let workbook;
      try { workbook = await API.importWorkbook({ data: body.data, filename: file.name }); }
      catch (e) { mount(stage, empty('Could not read that file', e.message, null, 'upload')); return; }
      const readable = workbook.sheets.filter((s) => !s.unreadable);
      if (!readable.length) { mount(stage, empty('No usable sheets', 'Every sheet in that workbook was empty or unreadable.', null, 'upload')); return; }
      if (readable.length === 1) { picked.sheet = readable[0].name; await showMapping(); return; }
      renderSheetPicker(readable);
      return;
    }
    await showMapping();
  }, { multiple: false });

  function renderSheetPicker(sheets) {
    const sheetBtn = (s) => h('button.track', {
      onclick: () => { picked.sheet = s.name; showMapping(); },
    },
      h('div.track-body',
        h('div.track-title', s.name),
        h('div.track-sub',
          `${fmt.num(s.row_count)} rows`,
          s.guesses[0] ? ` · looks like ${s.guesses[0].label}` : '')));

    mount(stage, h('div.card',
      h('div.card-head',
        h('h2', 'Which sheet?'),
        h('span.muted', { style: { fontSize: '12px' } }, `${picked.name} has ${sheets.length} sheets`)),
      h('div.card-body',
        h('div.stack', ...sheets.map(sheetBtn)))));
  }

  async function showMapping() {
    mount(stage, loading('Reading the file'));
    try {
      const suggestion = await API.importSuggest(typeSel.value, { ...picked.body, sheet: picked.sheet });
      renderMapping(suggestion);
    } catch (e) { mount(stage, empty('Could not read that file', e.message)); }
  }

  function renderMapping(suggestion) {
    const { el: tableEl, required, currentMapping } = mappingTable(suggestion);
    const results = h('div');
    const validateBtn = h('button.btn', {
      onclick: async () => {
        mount(results, loading('Checking every row'));
        try {
          const report = await API.importValidate(typeSel.value, {
            ...picked.body, sheet: picked.sheet, mapping: currentMapping(), mode: modeSel.value,
            key_field: modeSel.value === 'add' ? '' : keyField.value,
          });
          renderValidation(report, currentMapping(), suggestion.fields);
        } catch (e) { mount(results, empty('Could not check the file', e.message)); }
      },
    }, 'Check the file');

    function renderValidation(report, mapping, fields) {
      const clean = report.error_count === 0;
      const commit = h('button.btn.primary', {
        disabled: report.valid_rows === 0,
        onclick: async () => {
          const label = store.metaFor(typeSel.value)?.plural || 'records';
          const ok = await confirm({
            title: `Import ${fmt.num(report.valid_rows)} ${label.toLowerCase()}?`,
            message: clean
              ? 'Every row checked out. This can be undone from the History tab.'
              : `${report.error_count} row(s) will be skipped. This can be undone from the History tab.`,
            confirmLabel: 'Import',
          });
          if (!ok) return;
          commit.disabled = true;
          try {
            const res = await API.importCommit(typeSel.value, {
              ...picked.body, sheet: picked.sheet, mapping, mode: modeSel.value,
              key_field: modeSel.value === 'add' ? '' : keyField.value,
              filename: picked.name, stop_on_error: false,
            });
            notifyOk(`Imported ${fmt.num(res.created)} new and updated ${fmt.num(res.updated)} ${label.toLowerCase()}.`, 'Import finished');
            go('/data/history');
          } catch (e) { notifyError(e); commit.disabled = false; }
        },
      }, clean ? `Import ${fmt.num(report.valid_rows)} rows` : `Import the ${fmt.num(report.valid_rows)} good rows`);

      mount(results, ...validationSummary(report, fields),
        h('div.row', { style: { marginTop: '12px', gap: '8px' } }, commit,
          h('span.muted', { style: { fontSize: '12px', alignSelf: 'center' } }, 'Nothing has been written yet.')));
    }

    mount(stage,
      h('div.card',
        h('div.card-head', h('h2', `Match the columns in ${picked.name}${picked.sheet ? ` — ${picked.sheet}` : ''}`),
          h('span.muted', { style: { fontSize: '12px' } }, `Required: ${required.join(', ') || 'none'}`)),
        tableEl,
        h('div.row', { style: { padding: '10px 12px', gap: '8px' } }, validateBtn,
          h('button.btn', { onclick: () => { picked = null; mount(stage, h('div')); } }, 'Choose a different file'))),
      results);
  }

  const templateBtns = h('div.row', { style: { gap: '8px' } },
    h('button.btn', { onclick: () => API.importTemplate(typeSel.value, 'csv').catch(notifyError) }, 'CSV template'),
    h('button.btn', { onclick: () => API.importTemplate(typeSel.value, 'xlsx').catch(notifyError) }, 'Spreadsheet template'));

  return h('div.card',
    h('div.card-head', h('h2', icon('file-text', { size: 15 }), 'Import a file'),
      h('span.muted', { style: { fontSize: '12px' } }, 'One list at a time')),
    h('div.form-grid', { style: { padding: '12px' } },
      h('div.field', h('label', 'What are you importing?'), typeSel,
        h('div.help', 'Download a template first if you are not sure what the columns should be.')),
      h('div.field', h('label', 'How should existing records be treated?'), modeSel),
      keyRow,
      h('div.field', h('label', 'Templates'), templateBtns)),
    h('div.row', { style: { padding: '0 12px 12px', gap: '8px' } },
      picker,
      h('button.btn.primary', { onclick: () => picker.click() }, icon('upload', { size: 14 }), 'Choose a file'),
      h('span.muted', { style: { fontSize: '12px', alignSelf: 'center' } },
        'CSV or Excel (.xlsx). Nothing is saved until you review what the file contains.')),
    stage);
}

// ----------------------------------------------------- everything at once
//
// The point of this section: somebody migrating off an old system has one
// workbook per year, or one workbook with a tab per list -- customers,
// items, invoices, all of it. Drop all of it in, get one guess per sheet,
// fix the guesses that are wrong, check everything, commit everything that
// checked out. Reference data is sent to the server ahead of transactions
// (IMPORT_ORDER, on the server) so a customer exists before an invoice
// asks for one; nothing here decides that order itself.

const CONFIDENCE = (score) => (score >= 0.5 ? { label: 'likely', tone: 'green' } : score >= 0.22 ? { label: 'possible', tone: 'amber' } : { label: 'unsure', tone: '' });

function bulkImportCard(go, types, typeOptions) {
  let items = [];                       // pending items, one per sheet/file
  let seq = 0;
  const listHost = h('div.stack');
  const summaryHost = h('div');
  const actionsHost = h('div.row', { style: { gap: '8px', marginTop: '10px' } });

  const picker = filePicker('.csv,.txt,.tsv,.xlsx,.xls', async (files) => {
    const added = [];
    for (const file of files) {
      const body = await readFileBody(file);
      let sheets;
      try {
        const res = await API.importWorkbook({ ...body, filename: file.name });
        sheets = res.sheets;
      } catch (e) { notifyError(new Error(`${file.name}: ${e.message}`)); continue; }
      for (const sheet of sheets) {
        const top = sheet.guesses?.[0];
        added.push({
          key: `f${++seq}`, fileName: file.name, sheetName: sheet.name, body,
          headers: sheet.headers, rowCount: sheet.row_count, unreadable: !!sheet.unreadable,
          guesses: sheet.guesses || [], recordType: !sheet.unreadable && top && top.score >= 0.22 ? top.record_type : '',
          mode: 'add', keyField: '', mapping: null, report: null, expanded: false,
          status: sheet.unreadable ? 'error' : 'pending',
          errorMsg: sheet.unreadable ? 'This sheet could not be read.' : null,
        });
      }
    }
    items = [...items, ...added];
    draw();
  }, { multiple: true });

  const label = (t) => types.find((x) => x.type === t)?.label;

  function itemBody(item) {
    return { ...item.body, sheet: item.sheetName, mapping: item.mapping, mode: item.mode, key_field: item.keyField, filename: item.fileName };
  }

  function draw() {
    clear(listHost);
    if (!items.length) {
      mount(listHost, empty('No files added yet', 'Drop in every spreadsheet from your old system — customers, items, invoices, whatever you have. Each tab in a workbook counts as one file here.', null, 'upload'));
    } else {
      for (const item of items) listHost.appendChild(itemRow(item));
    }
    drawSummary();
    drawActions();
  }

  function drawSummary() {
    const usable = items.filter((i) => !i.unreadable);
    const checked = usable.filter((i) => i.report);
    const totalRows = usable.reduce((a, i) => a + (i.report?.total_rows ?? i.rowCount), 0);
    const ready = checked.reduce((a, i) => a + i.report.valid_rows, 0);
    const problems = checked.reduce((a, i) => a + i.report.error_rows, 0);
    clear(summaryHost);
    if (!usable.length) return;
    mount(summaryHost, h('div.kpi-grid', { style: { marginBottom: '10px' } },
      h('div.kpi', h('div.k-label', 'Sheets added'), h('div.k-value.sm', fmt.num(usable.length))),
      h('div.kpi', h('div.k-label', 'Rows in total'), h('div.k-value.sm', fmt.num(totalRows))),
      h('div.kpi', h('div.k-label', 'Checked'), h('div.k-value.sm', fmt.num(checked.length), h('span.muted', ` / ${usable.length}`))),
      h('div.kpi', h('div.k-label', 'Ready right now'), h('div.k-value.sm', fmt.num(ready))),
      problems > 0 && h('div.kpi', h('div.k-label', 'Rows with problems'), h('div.k-value.sm.num-neg', fmt.num(problems)))));
  }

  function drawActions() {
    const included = items.filter((i) => !i.unreadable && i.recordType);
    const checkable = included.length > 0;
    const committable = items.some((i) => i.report && i.report.valid_rows > 0);
    clear(actionsHost);
    mount(actionsHost,
      h('button.btn.primary', { disabled: !checkable, onclick: checkAll },
        icon('check', { size: 14 }), `Check ${included.length || ''} sheet${included.length === 1 ? '' : 's'}`.replace('  ', ' ')),
      h('button.btn', { disabled: !committable, onclick: commitAll }, icon('upload', { size: 14 }), 'Import everything that is ready'),
      items.length > 0 && h('button.btn.ghost', { onclick: () => { items = []; draw(); } }, 'Clear all'));
  }

  async function checkAll() {
    const targets = items.filter((i) => !i.unreadable && i.recordType);
    if (!targets.length) return;
    for (const i of targets) { i.status = 'checking'; }
    draw();
    try {
      const { results } = await API.importBatchValidate(targets.map((i) => ({ tag: { key: i.key }, record_type: i.recordType, ...itemBody(i) })));
      for (const r of results) {
        const item = items.find((i) => i.key === r.key);
        if (!item) continue;
        if (r.ok) { item.report = r.report; item.mapping = r.report.mapping; item.status = r.report.error_count ? 'checked-warn' : 'checked-ok'; item.errorMsg = null; }
        else { item.status = 'error'; item.errorMsg = r.error; }
      }
    } catch (e) { notifyError(e); for (const i of targets) i.status = 'pending'; }
    draw();
  }

  async function commitAll() {
    const targets = items.filter((i) => i.report && i.report.valid_rows > 0);
    if (!targets.length) return;
    const totalRows = targets.reduce((a, i) => a + i.report.valid_rows, 0);
    const ok = await confirm({
      title: `Import ${fmt.num(totalRows)} rows across ${targets.length} sheet${targets.length === 1 ? '' : 's'}?`,
      message: 'Reference data (accounts, customers, items…) is imported before the transactions that refer to it. Every sheet is undoable on its own from the History tab afterwards.',
      confirmLabel: 'Import everything',
    });
    if (!ok) return;
    for (const i of targets) i.status = 'committing';
    draw();
    try {
      const res = await API.importBatchCommit(targets.map((i) => ({ tag: { key: i.key }, record_type: i.recordType, ...itemBody(i) })));
      for (const r of res.results) {
        const item = items.find((i) => i.key === r.key);
        if (!item) continue;
        if (r.ok) { item.status = 'committed'; item.jobId = r.job_id; item.created = r.created; item.updated = r.updated; }
        else { item.status = 'checked-warn'; item.errorMsg = r.error; }
      }
      notifyOk(`Imported ${fmt.num(res.created)} new and updated ${fmt.num(res.updated)} records across ${targets.length} sheets.`, 'Bulk import finished');
    } catch (e) { notifyError(e); for (const i of targets) i.status = 'checked-ok'; }
    draw();
  }

  function itemRow(item) {
    const guessTag = () => {
      if (item.unreadable) return h('span.tag.red', 'Unreadable');
      const top = item.guesses?.[0];
      if (!item.recordType || !top) return null;
      const c = CONFIDENCE(top.score);
      return h('span.tag', { class: c.tone }, `Guessed: ${c.label}`);
    };

    const typeSel = h('select', { style: { width: '220px' }, disabled: item.unreadable }, ...typeOptions(item.recordType));
    typeSel.addEventListener('change', () => {
      item.recordType = typeSel.value; item.mapping = null; item.report = null; item.status = item.recordType ? 'pending' : 'pending';
      draw();
    });

    const modeSel = h('select', { style: { width: '190px' }, disabled: item.unreadable },
      h('option', { value: 'add', selected: item.mode === 'add' }, 'Add new only'),
      h('option', { value: 'upsert', selected: item.mode === 'upsert' }, 'Add or update'),
      h('option', { value: 'update', selected: item.mode === 'update' }, 'Update only'));
    modeSel.addEventListener('change', () => { item.mode = modeSel.value; item.report = null; });

    const keyInput = h('input', {
      type: 'text', placeholder: 'match on…', style: { width: '120px', display: item.mode === 'add' ? 'none' : '' },
      value: item.keyField, disabled: item.unreadable,
    });
    keyInput.addEventListener('input', () => { item.keyField = keyInput.value; item.report = null; });
    modeSel.addEventListener('change', () => { keyInput.style.display = modeSel.value === 'add' ? 'none' : ''; });

    const statusBadge = () => {
      if (item.status === 'checking') return h('span.tag', h('span.spinner'), ' Checking…');
      if (item.status === 'committing') return h('span.tag', h('span.spinner'), ' Importing…');
      if (item.status === 'committed') return h('span.tag.green', `Imported ${fmt.num(item.created)} · updated ${fmt.num(item.updated)}`);
      if (item.status === 'error') return h('span.tag.red', item.errorMsg || 'Problem reading this sheet');
      if (item.report) {
        return item.report.error_rows
          ? h('span.tag.amber', `${fmt.num(item.report.valid_rows)} ready, ${fmt.num(item.report.error_rows)} need attention`)
          : h('span.tag.green', `${fmt.num(item.report.valid_rows)} rows ready`);
      }
      return h('span.muted', { style: { fontSize: '12px' } }, `${fmt.num(item.rowCount)} rows · not checked yet`);
    };

    const detail = h('div', { class: item.expanded ? '' : 'hidden' });
    if (item.expanded) drawDetail(item, detail);

    return h('div.card', { style: { marginBottom: '0' } },
      h('div.card-head',
        h('div', { style: { minWidth: 0 } },
          h('div', { style: { fontWeight: 600, display: 'flex', gap: '6px', alignItems: 'center' } },
            item.sheetName ? `${item.fileName} — ${item.sheetName}` : item.fileName, guessTag()),
          h('div.muted', { style: { fontSize: '12px', marginTop: '2px' } }, item.headers.slice(0, 6).join(', ') + (item.headers.length > 6 ? '…' : ''))),
        h('div.actions',
          !item.unreadable && typeSel,
          !item.unreadable && modeSel,
          !item.unreadable && keyInput,
          h('button.icon-btn', {
            title: 'Remove', onclick: () => { items = items.filter((i) => i.key !== item.key); draw(); },
          }, icon('x', { size: 15 })))),
      h('div.card-foot',
        statusBadge(),
        !item.unreadable && item.recordType && h('button.btn.sm.ghost', {
          style: { marginLeft: 'auto' },
          onclick: () => { item.expanded = !item.expanded; draw(); },
        }, item.expanded ? 'Hide columns' : 'Review columns')),
      detail);
  }

  async function drawDetail(item, host) {
    mount(host, loading('Reading the columns'));
    let suggestion;
    try { suggestion = await API.importSuggest(item.recordType, itemBody(item)); }
    catch (e) { mount(host, empty('Could not read the columns', e.message)); return; }
    const { el: tableEl, currentMapping } = mappingTable(item.mapping ? { ...suggestion, mapping: item.mapping } : suggestion);
    const results = h('div');
    if (item.report) mount(results, ...validationSummary(item.report, suggestion.fields));
    mount(host, h('div.card-body.tight',
      tableEl,
      h('div.row', { style: { marginTop: '10px' } },
        h('button.btn.sm', {
          onclick: async () => {
            item.mapping = currentMapping();
            mount(results, loading('Checking'));
            try {
              item.report = await API.importValidate(item.recordType, { ...itemBody(item), mapping: item.mapping });
              item.status = item.report.error_count ? 'checked-warn' : 'checked-ok';
              mount(results, ...validationSummary(item.report, suggestion.fields));
              drawSummary();
            } catch (e) { mount(results, empty('Could not check the file', e.message)); }
          },
        }, 'Use this mapping and check')),
      results));
  }

  draw();

  return h('div.card', { style: { marginTop: '16px' } },
    h('div.card-head', h('h2', icon('layers', { size: 15 }), 'Bring everything over at once'),
      h('span.muted', { style: { fontSize: '12px' } }, 'Several files, or one workbook with several tabs')),
    h('div.card-body',
      h('div.tip', { style: { marginBottom: '12px' } },
        icon('lightbulb', { size: 14 }),
        h('div', 'Add every export from your old system. Each sheet gets its own guess at what it is — check it, fix it if it is wrong, then import everything at once. ',
          h('strong', 'Reference data first, transactions after'), ' is handled for you.')),
      h('div.row', { style: { marginBottom: '12px' } },
        picker,
        h('button.btn.primary', { onclick: () => picker.click() }, icon('upload', { size: 14 }), 'Add files or a workbook')),
      summaryHost, listHost, actionsHost));
}

// ------------------------------------------------------------------ export

async function exportTab() {
  const meta = store.state.meta.records || {};
  const types = Object.keys(meta).filter((t) => store.can(t)).sort((a, b) =>
    (meta[a].group || '').localeCompare(meta[b].group || '') || meta[a].plural.localeCompare(meta[b].plural));

  const byGroup = {};
  for (const t of types) (byGroup[meta[t].group] = byGroup[meta[t].group] || []).push(t);

  const typeSel = h('select', { style: { width: '260px' } },
    ...orderGroups(Object.keys(byGroup)).map((g) => h('optgroup', { label: g },
      ...byGroup[g].map((t) => h('option', { value: t, selected: t === 'customer' }, meta[t].plural)))));

  const FORMATS = [
    ['xlsx', 'Spreadsheet (.xlsx)', 'Styled, with frozen headers, filters and currency formatting'],
    ['csv', 'CSV (.csv)', 'Plain text, for loading into another system'],
    ['pdf', 'PDF (.pdf)', 'Paginated and ready to send on'],
    ['json', 'JSON (.json)', 'For a script or an integration'],
  ];
  const formatSel = h('select', { style: { width: '220px' } },
    ...FORMATS.map(([v, label]) => h('option', { value: v }, label)));
  const hint = h('div.help', FORMATS[0][2]);
  formatSel.addEventListener('change', () => {
    hint.textContent = FORMATS.find((f) => f[0] === formatSel.value)?.[2] || '';
  });

  const go = h('button.btn.primary', {
    onclick: async () => {
      go.disabled = true;
      try { await API.exportFile(typeSel.value, formatSel.value); }
      catch (e) { notifyError(e); }
      finally { go.disabled = false; }
    },
  }, 'Download');

  const packBtns = h('div.row', { style: { gap: '8px' } },
    h('button.btn', { onclick: () => API.exportPack('xlsx').catch(notifyError) }, 'Spreadsheet'),
    h('button.btn', { onclick: () => API.exportPack('pdf').catch(notifyError) }, 'PDF'));

  return h('div',
    h('div.card',
      h('div.card-head', h('h2', 'Export records')),
      h('div.form-grid', { style: { padding: '12px' } },
        h('div.field', h('label', 'What do you want to export?'), typeSel),
        h('div.field', h('label', 'Format'), formatSel, hint)),
      h('div.row', { style: { padding: '0 12px 12px' } }, go)),
    h('div.card', { style: { marginTop: '14px' } },
      h('div.card-head', h('h2', 'Financial statement pack')),
      h('div', { style: { padding: '12px' } },
        h('p.muted', { style: { marginTop: 0 } },
          'Profit and loss, balance sheet, trial balance and receivables ageing, for the year to date.'),
        packBtns)),
    h('div.card', { style: { marginTop: '14px' } },
      h('div.card-head', h('h2', 'Exporting a saved search')),
      h('div', { style: { padding: '12px' } },
        h('p.muted', { style: { marginTop: 0 } },
          'Any list or saved search exports exactly what is on screen — filters, columns and sort — '
          + 'from the Export button on that list.'))));
}

// --------------------------------------------------------------- bank files

async function bankTab() {
  const [{ accounts }, { formats }] = await Promise.all([API.bankAccounts(), API.statementFormats()]);
  if (!accounts.length) return empty('No bank accounts yet', 'Add a bank account before importing statements.');

  const accountSel = h('select', { style: { width: '260px' } },
    ...accounts.map((a) => h('option', { value: a.id }, `${a.name} · ${a.account_number || a.account_name}`)));

  const stage = h('div');
  let picked = null;

  const picker = filePicker('.csv,.ofx,.qfx,.qbo,.bai,.bai2,.txt,.xml', async (file, text) => {
    picked = { name: file.name, text };
    mount(stage, loading('Reading the statement'));
    try {
      const preview = await API.previewStatement(text);
      renderPreview(preview);
    } catch (e) { mount(stage, empty('Could not read that statement', e.message)); }
  });

  function renderPreview(p) {
    const rows = p.transactions.slice(0, 100).map((t) => h('tr',
      h('td.muted', fmt.dateShort(t.date)),
      h('td', t.description || '—'),
      h('td.muted', t.reference || '—'),
      h('td.num', { class: t.amount < 0 ? 'num-neg' : 'num-pos' }, fmt.money(t.amount))));

    const importBtn = h('button.btn.primary', {
      onclick: async () => {
        importBtn.disabled = true;
        try {
          const res = await API.importStatementFile({
            bank_account_id: accountSel.value, text: picked.text, filename: picked.name,
          });
          notifyOk(`${fmt.num(res.imported)} new transaction(s) imported, ${fmt.num(res.duplicates)} already present.`,
            'Statement imported');
          mount(stage, h('div'));
          picked = null;
        } catch (e) { notifyError(e); importBtn.disabled = false; }
      },
    }, `Import ${fmt.num(p.transactions.length)} transactions`);

    mount(stage, h('div.card',
      h('div.card-head', h('h2', `${picked.name} · ${String(p.format).toUpperCase()}`),
        h('span.muted', { style: { fontSize: '12px' } },
          p.account_number ? `Statement account ${p.account_number}` : 'No account number in the file')),
      facts([
        ['Transactions', fmt.num(p.transactions.length)],
        ['Currency', p.currency || '—'],
        ['Closing balance', p.closing_balance === null || p.closing_balance === undefined ? '—' : fmt.money(p.closing_balance)],
        ['Statement date', p.balance_date ? fmt.date(p.balance_date) : '—'],
      ]),
      h('div.grid-wrap', h('table.grid',
        h('thead', h('tr', h('th', 'Date'), h('th', 'Description'), h('th', 'Reference'), h('th.num', 'Amount'))),
        h('tbody', ...rows))),
      h('div.row', { style: { padding: '10px 12px', gap: '8px' } }, importBtn,
        h('span.muted', { style: { fontSize: '12px', alignSelf: 'center' } },
          'Transactions already on the account are skipped automatically.'))));
  }

  return h('div',
    h('div.card',
      h('div.card-head', h('h2', 'Import a bank statement')),
      h('div.form-grid', { style: { padding: '12px' } },
        h('div.field', h('label', 'Into which account?'), accountSel),
        h('div.field', h('label', 'Supported formats'),
          h('div.row', { style: { gap: '6px', flexWrap: 'wrap' } },
            ...formats.map((f) => h('span.tag', f.label || f.name || f))),
          h('div.help', 'The format is detected from the file — you do not have to say which it is.'))),
      h('div.row', { style: { padding: '0 12px 12px', gap: '8px' } },
        picker,
        h('button.btn.primary', { onclick: () => picker.click() }, 'Choose a statement file'))),
    stage);
}

// ------------------------------------------------------- connections / BI

async function connectTab() {
  const info = await API.powerBiConnection();
  const tokens = store.can('app_user') ? (await API.apiTokens()).tokens : [];

  const copyBtn = (text, label = 'Copy') => h('button.btn.sm', {
    onclick: async () => {
      try { await navigator.clipboard.writeText(text); toast('Copied to the clipboard'); }
      catch { toast('Select the text and copy it manually', { kind: 'error' }); }
    },
  }, label);

  const endpoint = (label, url, note) => h('div.field',
    h('label', label),
    h('div.row', { style: { gap: '6px' } },
      h('input', { type: 'text', readonly: true, value: url, style: { flex: '1', fontFamily: 'var(--mono)' } }),
      copyBtn(url)),
    note ? h('div.help', note) : null);

  const tokenRows = tokens.map((t) => h('tr',
    h('td', h('strong', t.name)),
    h('td.muted', { style: { fontFamily: 'var(--mono)' } }, `${t.prefix}…`),
    h('td.muted', t.user_name),
    h('td.muted', fmt.dateShort(t.created_at)),
    h('td.muted', t.last_used_at ? fmt.relative(t.last_used_at) : 'never used'),
    h('td', t.revoked_at ? h('span.tag', 'Revoked') : h('span.tag.green', 'Active')),
    h('td', t.revoked_at ? '' : h('button.btn.sm.danger', {
      onclick: async () => {
        const ok = await confirm({
          title: `Revoke "${t.name}"?`, danger: true, confirmLabel: 'Revoke',
          message: 'Any report or integration using this token stops working immediately.',
        });
        if (!ok) return;
        try { await API.revokeApiToken(t.id); notifyOk('Token revoked'); window.__meridianGo('/data/connect'); }
        catch (e) { notifyError(e); }
      },
    }, 'Revoke'))));

  const newToken = h('button.btn.primary', {
    onclick: () => {
      const nameInput = h('input', { type: 'text', placeholder: 'Power BI — finance dashboard', style: { width: '100%' } });
      const dlg = modal({
        title: 'New API token',
        body: h('div',
          h('p.muted', { style: { marginTop: 0 } },
            'The token can see exactly what you can see, and nothing more. It is shown once.'),
          h('div.field', h('label', 'What is it for?'), nameInput)),
        actions: [
          h('button.btn', { onclick: () => dlg.close(null) }, 'Cancel'),
          h('button.btn.primary', {
            onclick: async () => {
              if (!nameInput.value.trim()) { toast('Give the token a name', { kind: 'error' }); return; }
              try {
                const made = await API.createApiToken(nameInput.value.trim());
                dlg.close(null);
                showToken(made);
              } catch (e) { notifyError(e); }
            },
          }, 'Create token'),
        ],
      });
      setTimeout(() => nameInput.focus(), 30);
    },
  }, 'New token');

  function showToken(made) {
    modal({
      title: 'Copy this token now',
      body: h('div',
        h('div.callout.warn', 'This is the only time the token is shown. It is not stored anywhere you can read it back.'),
        h('div.field', h('label', made.name),
          h('div.row', { style: { gap: '6px' } },
            h('input', { type: 'text', readonly: true, value: made.token, style: { flex: '1', fontFamily: 'var(--mono)' } }),
            copyBtn(made.token))),
        h('div.help', 'In Power BI or Excel choose Basic authentication, put your email in the user box and this token in the password box.')),
      actions: [{ label: 'Done', kind: 'primary' }],
      // Refresh the list so the new token appears once the dialog is dismissed.
      onClose: () => window.__meridianGo('/data/connect'),
    });
  }

  const steps = (info.instructions || []).map((line, i) =>
    h('li', typeof line === 'string' ? line : `${line.step || i + 1}. ${line.text || ''}`));

  return h('div',
    h('div.card',
      h('div.card-head', h('h2', 'Power BI'),
        h('button.btn', { onclick: () => API.powerBiFile().catch(notifyError) }, 'Download .pbids')),
      h('div', { style: { padding: '12px' } },
        h('p.muted', { style: { marginTop: 0 } },
          'Open the .pbids file and Power BI connects straight to this server. '
          + `Every table and report is offered as a feed — ${info.feeds.length} in total — and refreshes on demand.`),
        h('ol.steps', ...steps))),

    h('div.card', { style: { marginTop: '14px' } },
      h('div.card-head', h('h2', 'Connection addresses')),
      h('div.form-grid', { style: { padding: '12px' } },
        endpoint('OData feed (Power BI, Excel, Tableau)', info.odata_url,
          'In Excel: Data → Get Data → From Other Sources → From OData Feed.'),
        endpoint('OData metadata', info.metadata_url, 'The list of tables and their columns.'),
        endpoint('REST API', info.odata_url.replace('/odata/v1', '/api/v1'), 'JSON over HTTP, for scripts and integrations.'),
        endpoint('SOAP service (WSDL)', info.odata_url.replace('/odata/v1', '/soap/v1'),
          'For toolkits that expect a WSDL — get, add, update, upsert, delete and search.'))),

    h('div.card', { style: { marginTop: '14px' } },
      h('div.card-head', h('h2', 'ODBC, JDBC and ADO.NET'),
        h('span.muted', { style: { fontSize: '12px' } }, 'Through the OData feed')),
      h('div', { style: { padding: '12px' } },
        h('p.muted', { style: { marginTop: 0 } },
          'Tools that speak ODBC, JDBC or ADO.NET reach Meridian through the OData address above, '
          + 'using a generic OData driver. Point the driver at the feed, choose Basic authentication '
          + 'and sign in with an API token.'))),

    store.can('app_user') ? h('div.card', { style: { marginTop: '14px' } },
      h('div.card-head', h('h2', 'API tokens'), newToken),
      tokens.length
        ? h('div.grid-wrap', h('table.grid',
          h('thead', h('tr', h('th', 'Name'), h('th', 'Token'), h('th', 'Created by'),
            h('th', 'Created'), h('th', 'Last used'), h('th', 'Status'), h('th', ''))),
          h('tbody', ...tokenRows)))
        : h('div', { style: { padding: '12px' } },
          h('p.muted', { style: { margin: 0 } },
            'No tokens yet. A BI tool needs one to refresh without a person signing in.'))) : null,

    h('div.card', { style: { marginTop: '14px' } },
      h('div.card-head', h('h2', 'Available feeds'),
        h('span.muted', { style: { fontSize: '12px' } }, `${info.feeds.length}`)),
      h('div.grid-wrap', h('table.grid',
        h('thead', h('tr', h('th', 'Feed'), h('th', 'Contains'))),
        h('tbody', ...info.feeds.map((f) => h('tr',
          h('td', h('strong', f.name)),
          h('td.muted', f.title))))))));
}

// ----------------------------------------------------------------- history

async function historyTab(go) {
  const { jobs } = await API.importJobs();
  if (!jobs.length) return empty('No imports yet', 'Files you import will be listed here, and can be undone.');

  const rows = jobs.map((j) => {
    const label = store.metaFor(j.record_type)?.plural || fmt.titleCase(j.record_type);
    const undo = j.status === 'committed' && j.created_count > 0
      ? h('button.btn.sm.danger', {
        onclick: async () => {
          const ok = await confirm({
            title: `Undo this import?`, danger: true, confirmLabel: 'Undo import',
            message: `The ${fmt.num(j.created_count)} record(s) this import created will be deleted. `
              + 'Records it only updated keep their new values, and anything already posted to the ledger is left alone.',
          });
          if (!ok) return;
          try {
            const res = await API.reverseImport(j.id);
            notifyOk(`${fmt.num(res.removed)} record(s) removed.`
              + (res.blocked?.length ? ` ${res.blocked.length} could not be removed.` : ''), 'Import undone');
            go('/data/history');
          } catch (e) { notifyError(e); }
        },
      }, 'Undo')
      : null;

    return h('tr',
      h('td', h('strong', j.job_no)),
      h('td', label),
      h('td.muted', j.filename || '—'),
      h('td.muted', fmt.titleCase(j.mode)),
      h('td.num', fmt.num(j.created_count)),
      h('td.num', fmt.num(j.updated_count)),
      h('td.num', { class: j.error_rows ? 'num-neg' : '' }, fmt.num(j.error_rows)),
      h('td', statusTag(j.status)),
      h('td.muted', fmt.relative(j.created_at)),
      h('td', undo));
  });

  return h('div.card',
    h('div.card-head', h('h2', 'Import history'),
      h('span.muted', { style: { fontSize: '12px' } }, `${jobs.length} import${jobs.length === 1 ? '' : 's'}`)),
    h('div.grid-wrap', h('table.grid',
      h('thead', h('tr', h('th', 'Job'), h('th', 'Records'), h('th', 'File'), h('th', 'Mode'),
        h('th.num', 'Created'), h('th.num', 'Updated'), h('th.num', 'Errors'),
        h('th', 'Status'), h('th', 'When'), h('th', ''))),
      h('tbody', ...rows))));
}
