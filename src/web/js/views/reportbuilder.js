// Meridian ERP :: web/views/reportbuilder
// A pivot builder over src/modules/pivot.mjs: drag a field from the dataset
// onto Rows, Columns or Values and the table (and, optionally, a chart)
// updates live. Filters are not built here yet -- the definition already
// carries a `filters` array (the same shape platform.mjs's saved searches
// use), left for a future pass; row/column/value building is the part that
// did not exist anywhere in the app at all.
import { h, mount, clear } from '../dom.js';
import { icon } from '../icons.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import { empty, toast, notifyError, loading, modal } from '../ui.js';
import { barChart, lineChart, groupedBar, donut } from '../charts.js';

const AGG_LABEL = { count: 'Count', sum: 'Sum', avg: 'Average', min: 'Min', max: 'Max' };
const BUCKET_LABEL = { none: 'exact', day: 'by day', month: 'by month', quarter: 'by quarter', year: 'by year' };
const isDateField = (f) => f?.type === 'date' || /_date$|^date$/.test(f?.name || '');

function downloadCsv(filename, rows) {
  const csv = rows.map((row) => row.map((c) => {
    const s = String(c ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function reportBuilderView(reportId, { go }) {
  const [datasetsRes, existing] = await Promise.all([
    API.reportDatasets(),
    reportId ? API.customReport(reportId).catch(() => null) : null,
  ]);
  const datasets = datasetsRes.datasets;
  if (!datasets.length) return h('div.page', empty('No datasets available', 'Your role cannot view any record type or analytic feed.'));

  const def = existing?.definition || {};
  const state = {
    reportId: existing?.id || null,
    name: existing?.name || '',
    isPublic: existing ? !!existing.is_public : true,
    chart: existing?.chart || 'none',
    datasetKey: def.source ? `${def.source.kind}:${def.source.name}` : `${datasets[0].kind}:${datasets[0].name}`,
    row: def.row || null,
    col: def.col || null,
    values: def.values || [],
    result: null,
  };

  const findDataset = () => datasets.find((d) => `${d.kind}:${d.name}` === state.datasetKey);

  const datasetSel = h('select', { style: { width: '220px' } },
    ...datasets.map((d) => h('option', { value: `${d.kind}:${d.name}`, selected: `${d.kind}:${d.name}` === state.datasetKey }, d.title)));

  const wellsHost = h('div.row', { style: { gap: '14px', alignItems: 'flex-start', flexWrap: 'wrap' } });
  const fieldsHost = h('div.row', { style: { gap: '6px', flexWrap: 'wrap', marginBottom: '14px' } });
  const resultHost = h('div');
  const nameInput = h('input', { type: 'text', placeholder: 'Report name', value: state.name, style: { width: '220px' } });
  const chartSel = h('select', { style: { width: '140px' } },
    h('option', { value: 'none', selected: state.chart === 'none' }, 'Table only'),
    h('option', { value: 'bar', selected: state.chart === 'bar' }, 'Bar chart'),
    h('option', { value: 'line', selected: state.chart === 'line' }, 'Line chart'),
    h('option', { value: 'donut', selected: state.chart === 'donut' }, 'Donut'));

  function fieldChip(f) {
    const chip = h('span.tag.mono', { draggable: true, style: { cursor: 'grab' } }, f.label || f.name);
    chip.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', f.name); e.dataTransfer.effectAllowed = 'copy'; });
    return chip;
  }

  function well(title, hint, onDrop, content) {
    const box = h('div.card', { style: { flex: '1 1 220px', minHeight: '92px' } },
      h('div.card-head', h('h2', { style: { fontSize: '13px' } }, title)),
      h('div.card-body', hint && !content.length ? h('div.muted', { style: { fontSize: '12px' } }, hint) : null, ...content));
    box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('drop-target'); });
    box.addEventListener('dragleave', () => box.classList.remove('drop-target'));
    box.addEventListener('drop', (e) => {
      e.preventDefault(); box.classList.remove('drop-target');
      const name = e.dataTransfer.getData('text/plain');
      if (name) onDrop(name);
    });
    return box;
  }

  function fieldRemove(onClick) {
    return h('button.btn.sm.icon-only', { type: 'button', onclick: onClick }, icon('x'));
  }

  async function run() {
    const ds = findDataset();
    if (!state.row) { mount(resultHost, empty('Drag a field onto Rows', 'Choose what each row of the table should represent.')); return; }
    if (!state.values.length) { mount(resultHost, empty('Drag a field onto Values', 'Choose what to count, sum or average.')); return; }
    mount(resultHost, loading('Running'));
    try {
      state.result = await API.runPivot({
        source: { kind: ds.kind, name: ds.name }, row: state.row, col: state.col, values: state.values,
      });
      renderResult();
    } catch (e) { mount(resultHost, empty('Could not run this report', e.message || String(e))); }
  }

  function renderResult() {
    const r = state.result;
    if (!r || !r.rows.length) { mount(resultHost, empty('No rows', 'Nothing matches this shape yet.')); return; }
    const valLabel = (v) => `${AGG_LABEL[v.fn]} of ${v.label || v.field}`;
    const fmtVal = (n) => fmt.moneyCompact(n);

    const table = h('table.grid.compact',
      h('thead', h('tr',
        h('th', ''),
        ...(r.columns.length > 1 ? r.columns.flatMap((c) => state.values.map((v) => h('th.num', `${c.label} · ${valLabel(v)}`))) : state.values.map((v) => h('th.num', valLabel(v)))),
        r.columns.length > 1 ? h('th.num', 'Total') : null)),
      h('tbody', ...r.rows.map((row) => h('tr',
        h('td', row.label),
        ...(r.columns.length > 1 ? row.cells.flat().map((c) => h('td.num', fmtVal(c))) : row.total.map((c) => h('td.num', fmtVal(c)))),
        r.columns.length > 1 ? h('td.num', h('strong', fmtVal(row.total[0]))) : null))),
      h('tfoot', h('tr',
        h('td', h('strong', 'Total')),
        ...(r.columns.length > 1 ? r.column_totals.flat().map((c) => h('td.num', h('strong', fmtVal(c)))) : r.grand_total.map((c) => h('td.num', h('strong', fmtVal(c))))),
        r.columns.length > 1 ? h('td.num', h('strong', fmtVal(r.grand_total[0]))) : null)));

    let chartEl = null;
    if (chartSel.value === 'bar') chartEl = barChart(r.rows.map((row) => ({ label: row.label, value: row.total[0] })), { format: fmtVal });
    else if (chartSel.value === 'line') chartEl = lineChart(r.rows.map((row) => ({ label: row.label, value: row.total[0] })), { format: fmtVal });
    else if (chartSel.value === 'donut') chartEl = donut(r.rows.slice(0, 8).map((row) => ({ label: row.label, value: row.total[0] })), {});
    if (chartEl && r.columns.length > 1 && chartSel.value === 'bar') {
      chartEl = groupedBar(r.rows.map((row) => ({ label: row.label, values: row.cells.map((c) => c[0]) })), r.columns.map((c) => c.label));
    }

    const exportBtn = h('button.btn.sm', {
      onclick: () => {
        const header = ['', ...(r.columns.length > 1 ? r.columns.map((c) => c.label) : state.values.map((v) => valLabel(v))), r.columns.length > 1 ? 'Total' : null].filter(Boolean);
        const body = r.rows.map((row) => [row.label, ...(r.columns.length > 1 ? row.cells.map((c) => c[0]) : row.total), r.columns.length > 1 ? row.total[0] : null].filter((x) => x !== null || true));
        downloadCsv(`${state.name || 'report'}.csv`, [header, ...body]);
      },
    }, icon('download', { size: 13 }), 'Export CSV');

    mount(resultHost,
      h('div.card', { style: { marginBottom: '14px' } }, h('div.card-body', h('div.grid-wrap', table)), h('div.card-foot', h('div.row', h('span.muted', { style: { fontSize: '12px' } }, `${r.row_count} row${r.row_count === 1 ? '' : 's'} matched${r.truncated ? ' (capped)' : ''}`), h('div.spacer', { style: { flex: 1 } }), exportBtn))),
      chartEl ? h('div.card', h('div.card-body', chartEl)) : null);
  }

  function drawFields() {
    const ds = findDataset();
    clear(fieldsHost);
    mount(fieldsHost, ...ds.fields.map((f) => fieldChip(f)));
  }

  function drawWells() {
    clear(wellsHost);
    const rowContent = state.row ? [h('div.row', { style: { gap: '6px', alignItems: 'center' } },
      h('span.tag', state.row.field),
      isDateField(findDataset().fields.find((f) => f.name === state.row.field)) ? bucketSel(state.row, redraw) : null,
      fieldRemove(() => { state.row = null; redraw(); }))] : [];
    const colContent = state.col ? [h('div.row', { style: { gap: '6px', alignItems: 'center' } },
      h('span.tag', state.col.field),
      isDateField(findDataset().fields.find((f) => f.name === state.col.field)) ? bucketSel(state.col, redraw) : null,
      fieldRemove(() => { state.col = null; redraw(); }))] : [];
    const valuesContent = state.values.map((v, i) => h('div.row', { style: { gap: '6px', alignItems: 'center', marginBottom: '4px' } },
      h('span.tag', v.field),
      h('select', {
        onchange: (e) => { v.fn = e.target.value; redraw(); },
      }, ...Object.keys(AGG_LABEL).map((fn) => h('option', { value: fn, selected: fn === v.fn }, AGG_LABEL[fn]))),
      fieldRemove(() => { state.values.splice(i, 1); redraw(); })));

    mount(wellsHost,
      well('Rows', 'Drop one field here', (name) => { state.row = { field: name, bucket: 'none' }; redraw(); }, rowContent),
      well('Columns', 'Optional — splits each row across columns', (name) => { state.col = { field: name, bucket: 'none' }; redraw(); }, colContent),
      well('Values', 'Drop one or more fields to aggregate', (name) => { state.values.push({ field: name, fn: 'sum', label: name }); redraw(); }, valuesContent));
  }

  function bucketSel(dim, onChange) {
    const sel = h('select', { onchange: (e) => { dim.bucket = e.target.value; onChange(); } },
      ...Object.keys(BUCKET_LABEL).map((b) => h('option', { value: b, selected: b === dim.bucket }, BUCKET_LABEL[b])));
    return sel;
  }

  let debounceTimer = null;
  function redraw() {
    drawWells();
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(run, 150);
  }

  async function save() {
    if (!nameInput.value.trim()) { toast('Enter a name for this report', { kind: 'warn' }); return; }
    const ds = findDataset();
    const definition = { source: { kind: ds.kind, name: ds.name }, row: state.row, col: state.col, values: state.values };
    try {
      const body = { name: nameInput.value.trim(), definition, chart: chartSel.value, is_public: state.isPublic };
      const saved = state.reportId ? await API.updateCustomReport(state.reportId, body) : await API.createCustomReport(body);
      state.reportId = saved.id;
      toast('Report saved', { kind: 'success' });
      go(`/reports/builder/${saved.id}`);
    } catch (e) { notifyError(e); }
  }

  datasetSel.addEventListener('change', () => {
    state.datasetKey = datasetSel.value; state.row = null; state.col = null; state.values = [];
    drawFields(); redraw();
  });
  chartSel.addEventListener('change', () => renderResult());

  drawFields(); drawWells();
  if (state.row && state.values.length) run(); else mount(resultHost, empty('Build a report', 'Drag fields from the list above onto Rows and Values to get started.'));

  return h('div.page',
    h('div.page-head',
      h('div.titles', h('h1', existing ? existing.name : 'New report'), h('div.page-sub', 'Drag a field onto Rows, Columns or Values. The table updates as you go.')),
      h('div.page-actions', nameInput, chartSel,
        h('button.btn.sm.primary', { onclick: save }, 'Save'),
        h('button.btn.sm', { onclick: () => go('/reports') }, 'Close'))),
    h('div.card', { style: { marginBottom: '14px' } },
      h('div.card-head', h('h2', { style: { fontSize: '13px' } }, 'Dataset'), h('div.actions', datasetSel)),
      h('div.card-body', fieldsHost)),
    wellsHost,
    h('div', { style: { marginTop: '14px' } }, resultHost));
}
