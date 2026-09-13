// Meridian ERP :: web/views/list
// The generic high-density list. Every record type gets this screen for free
// from its metadata: sortable columns, a filter builder, saved searches,
// column selection, CSV export and paging.
import { h, mount, clear, debounce } from '../dom.js';
import { icon } from '../icons.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import * as store from '../store.js';
import { displayValue, empty, loading, toast, notifyError, modal, statusTag } from '../ui.js';

const PAGE_SIZES = [50, 100, 250, 500];

export async function listView(route, { go }) {
  const type = route.parts[1];
  const meta = store.metaFor(type);
  if (!meta) return h('div.page', empty('Unknown record type', `Meridian has no record type called “${type}”.`));
  if (!store.can(type)) return h('div.page', empty('Not permitted', `Your role cannot view ${meta.plural.toLowerCase()}.`));

  const prefKey = `list.${type}`;
  const saved = store.getPref(prefKey, {});
  const state = {
    q: route.query.q || '',
    columns: saved.columns || meta.listColumns,
    filters: route.query.filters ? JSON.parse(route.query.filters) : (saved.filters || []),
    sort: route.query.sort || saved.sort || meta.defaultSort,
    limit: saved.limit || 100,
    offset: 0,
    savedSearchId: route.query.search || '',
  };

  // Warm the reference caches this list needs so ids render as names.
  const fm = store.fieldMap(type);
  await store.ensureRefs(state.columns.map((c) => fm[c]?.ref).filter(Boolean));

  const countEl = h('span.result-count');
  const body = h('div.grid-wrap', loading());
  const searchInput = h('input', { type: 'search', placeholder: `Search ${meta.plural.toLowerCase()}…`, value: state.q, style: { width: '210px' } });
  const pager = h('div.row', { style: { gap: '4px' } });

  const persist = () => store.setPref(prefKey, { columns: state.columns, filters: state.filters, sort: state.sort, limit: state.limit });

  async function load() {
    mount(body, loading());
    try {
      const res = state.q
        ? await API.list(type, { q: state.q, limit: state.limit, offset: state.offset, sort: state.sort })
        : await API.search(type, { columns: state.columns, filters: state.filters, sort: state.sort }, state.limit, state.offset);
      renderGrid(res);
    } catch (e) { mount(body, empty('Could not load records', e.message)); }
  }

  function renderGrid(res) {
    const rows = res.rows || [];
    const cols = (state.q ? meta.listColumns : (res.columns || state.columns)).filter((c) => fm[c]);
    countEl.textContent = `${fmt.num(res.total)} ${res.total === 1 ? meta.label.toLowerCase() : meta.plural.toLowerCase()}`;

    if (!rows.length) {
      mount(body, empty(`No ${meta.plural.toLowerCase()} found`,
        state.q || state.filters.length ? 'Try widening the search or clearing filters.' : `Nothing here yet.`,
        store.can(type, store.LEVEL.CREATE) ? h('button.btn.primary', { onclick: newRecord }, `New ${meta.label.toLowerCase()}`) : null));
      renderPager(res);
      return;
    }

    const sortCol = String(state.sort || '').split(/\s+/)[0];
    const sortDir = /desc/i.test(state.sort || '') ? 'desc' : 'asc';

    const table = h('table.grid',
      h('thead', h('tr', ...cols.map((c) => {
        const f = fm[c];
        const isNum = ['money', 'number', 'percent', 'qty'].includes(f.type);
        return h('th', {
          class: `${isNum ? 'num' : ''} sortable`,
          style: f.width ? { minWidth: `${f.width}px` } : null,
          onclick: () => { state.sort = `${c} ${sortCol === c && sortDir === 'asc' ? 'DESC' : 'ASC'}`; state.offset = 0; persist(); load(); },
        }, f.label, sortCol === c && h('span.sort', icon(sortDir === 'asc' ? 'chevron-up' : 'chevron-down', { size: 11 })));
      }))),
      h('tbody', ...rows.map((row) => h('tr.clickable', {
        onclick: (e) => { if (!e.target.closest('a')) openRecord(row); },
      }, ...cols.map((c) => {
        const f = fm[c];
        const value = c.startsWith('custom.') ? row.custom?.[c.slice(7)] : row[c];
        const isNum = ['money', 'number', 'percent', 'qty'].includes(f.type);
        return h('td', { class: isNum ? 'num' : '' },
          c === meta.title || c === 'name' || c === 'txn_no'
            ? h('span', { style: { fontWeight: 550 } }, displayValue(f, value, row))
            : displayValue(f, value, row));
      })))));

    mount(body, table);
    renderPager(res);
  }

  function renderPager(res) {
    clear(pager);
    const from = res.total ? res.offset + 1 : 0;
    const to = Math.min(res.offset + (res.rows?.length || 0), res.total);
    pager.appendChild(h('span.muted', { style: { fontSize: '12px', marginRight: '6px' } }, `${fmt.num(from)}–${fmt.num(to)} of ${fmt.num(res.total)}`));
    pager.appendChild(h('button.btn.sm', {
      disabled: state.offset === 0,
      onclick: () => { state.offset = Math.max(0, state.offset - state.limit); load(); },
    }, '‹ Prev'));
    pager.appendChild(h('button.btn.sm', {
      disabled: to >= res.total,
      onclick: () => { state.offset += state.limit; load(); },
    }, 'Next ›'));
  }

  const openRecord = (row) => go(meta.isTransaction ? `/txn/${row.id}` : type === 'journal_entry' ? `/journal/${row.id}` : `/record/${type}/${row.id}`);

  function newRecord() {
    if (meta.isTransaction) go(`/txn-new/${type}`);
    else if (type === 'journal_entry') go('/journal-new');
    else if (type === 'recurring_journal') go('/recurring/new');
    else go(`/new/${type}`);
  }

  searchInput.addEventListener('input', debounce(() => { state.q = searchInput.value.trim(); state.offset = 0; load(); }, 260));

  // ------------------------------------------------------ saved searches
  const mine = store.state.savedSearches.filter((s) => s.record_type === type);
  const savedSel = h('select', { style: { maxWidth: '190px' }, onchange: (e) => applySaved(e.target.value) },
    h('option', { value: '' }, 'All records'),
    ...mine.map((s) => h('option', { value: s.id, selected: s.id === state.savedSearchId }, s.name)));

  function applySaved(id) {
    const s = mine.find((x) => x.id === id);
    if (!s) { state.filters = []; state.columns = meta.listColumns; state.sort = meta.defaultSort; }
    else {
      const d = s.definition || {};
      state.filters = d.filters || [];
      state.columns = d.columns?.length ? d.columns : meta.listColumns;
      state.sort = d.sort || meta.defaultSort;
    }
    state.q = ''; searchInput.value = ''; state.offset = 0;
    load();
  }

  // -------------------------------------------------------------- filters
  function openFilters() {
    const rowsHost = h('div');
    const draft = state.filters.map((f) => ({ ...f }));
    const fields = Object.values(fm).filter((f) => f.type !== 'json');

    const addRow = (f = { field: fields[0]?.name, op: 'eq', value: '' }) => {
      draft.push(f);
      drawRows();
    };
    function drawRows() {
      clear(rowsHost);
      draft.forEach((f, i) => {
        const fieldSel = h('select', { onchange: (e) => { f.field = e.target.value; } },
          ...fields.map((x) => h('option', { value: x.name, selected: x.name === f.field }, x.label)));
        const opSel = h('select', { onchange: (e) => { f.op = e.target.value; } },
          ...Object.entries(store.state.meta.operators).map(([k, o]) => h('option', { value: k, selected: k === f.op }, o.label)));
        const valInput = h('input', { type: 'text', value: Array.isArray(f.value) ? f.value.join(',') : (f.value ?? ''), placeholder: 'value', oninput: (e) => { f.value = e.target.value; } });
        rowsHost.appendChild(h('div.filter-row', fieldSel, opSel, valInput,
          h('button.btn.sm.ghost', { onclick: () => { draft.splice(i, 1); drawRows(); } }, icon('x', { size: 13 }))));
      });
      if (!draft.length) rowsHost.appendChild(h('div.muted', { style: { padding: '8px 0' } }, 'No filters — every record is shown.'));
    }
    drawRows();

    modal({
      title: `Filter ${meta.plural.toLowerCase()}`,
      body: h('div', rowsHost, h('button.btn.sm', { style: { marginTop: '8px' }, onclick: () => addRow() }, icon('plus', { size: 13 }), 'Add filter')),
      actions: [
        { label: 'Clear all', onClick: () => { state.filters = []; state.offset = 0; persist(); load(); } },
        { label: 'Apply', kind: 'primary', onClick: () => { state.filters = draft.filter((f) => f.field); state.offset = 0; persist(); load(); } },
      ],
    });
  }

  // -------------------------------------------------------------- columns
  function openColumns() {
    const all = Object.values(fm);
    const boxes = all.map((f) => {
      const cb = h('input', { type: 'checkbox', checked: state.columns.includes(f.name) });
      return { name: f.name, cb, el: h('label', cb, h('span', f.label), f.custom && h('span.tag', { style: { fontSize: '9.5px' } }, 'custom')) };
    });
    modal({
      title: 'Choose columns',
      body: h('div.col-picker', ...boxes.map((b) => b.el)),
      actions: [
        { label: 'Reset', onClick: () => { state.columns = meta.listColumns; persist(); load(); } },
        {
          label: 'Apply', kind: 'primary',
          onClick: async () => {
            const chosen = boxes.filter((b) => b.cb.checked).map((b) => b.name);
            state.columns = chosen.length ? chosen : meta.listColumns;
            await store.ensureRefs(state.columns.map((c) => fm[c]?.ref).filter(Boolean));
            persist(); load();
          },
        },
      ],
    });
  }

  function saveCurrentSearch() {
    modal({
      title: 'Save this view',
      body: h('div.form-grid',
        h('div.field.full', h('label', 'Name'), h('input', { id: 'ss-name', placeholder: `e.g. Overdue ${meta.plural.toLowerCase()}` })),
        h('div.field.checkbox', h('input', { type: 'checkbox', id: 'ss-public', checked: true }), h('label', { for: 'ss-public' }, 'Share with everyone in the company'))),
      actions: [{
        label: 'Save', kind: 'primary',
        onClick: async (close) => {
          const name = document.getElementById('ss-name').value.trim();
          if (!name) { toast('Give the view a name', { kind: 'warn' }); return false; }
          await API.create('saved_search', {
            name, record_type: type,
            is_public: document.getElementById('ss-public').checked,
            definition: { columns: state.columns, filters: state.filters, sort: state.sort },
          });
          await store.loadSavedSearches();
          toast('View saved', { kind: 'success' });
          close();
          go(`/list/${type}`);
        },
      }],
    });
  }

  const toolbar = h('div.toolbar',
    searchInput,
    mine.length ? savedSel : null,
    h('button.btn.sm', { onclick: openFilters }, '⚟ Filters', state.filters.length ? h('span.tag.blue', String(state.filters.length)) : null),
    h('button.btn.sm', { onclick: openColumns }, icon('table', { size: 13 }), 'Columns'),
    h('div.spacer'),
    countEl,
    h('select', {
      style: { width: '76px' }, title: 'Rows per page',
      onchange: (e) => { state.limit = Number(e.target.value); state.offset = 0; persist(); load(); },
    }, ...PAGE_SIZES.map((n) => h('option', { value: n, selected: n === state.limit }, String(n)))),
    h('button.btn.sm', { onclick: saveCurrentSearch, title: 'Save this filter and column set' }, '☆ Save view'),
    h('div.row', { style: { gap: '4px' } },
      h('button.btn.sm', { onclick: () => API.exportCsv(type, { columns: state.columns, filters: state.filters, sort: state.sort }).catch(notifyError) }, icon('download', { size: 13 }), 'CSV'),
      h('button.btn.sm', { onclick: () => API.exportFile(type, 'pdf', { columns: state.columns, filters: state.filters, sort: state.sort }).catch(notifyError) }, 'PDF')),

  const el = h('div.page.flush',
    h('div', { style: { padding: '16px 20px 0' } },
      h('div.page-head',
        h('div.titles', h('h1', meta.plural), h('div.page-sub', describeFilters(state, fm))),
        h('div.page-actions',
          extraActions(type, go),
          store.can(type, store.LEVEL.CREATE) && h('button.btn.primary', { onclick: newRecord }, icon('plus', { size: 14 }), `New ${meta.label.toLowerCase()}`)))),
    h('div.card', { style: { margin: '0 20px 24px' } },
      toolbar, body,
      h('div.card-foot', pager)));

  load();
  return el;
}

function describeFilters(state, fm) {
  const bits = [];
  if (state.q) bits.push(`matching “${state.q}”`);
  for (const f of state.filters) {
    const label = fm[f.field]?.label || f.field;
    const op = store.state.meta.operators[f.op]?.label || f.op;
    bits.push(`${label} ${op}${store.state.meta.operators[f.op]?.noValue ? '' : ` ${Array.isArray(f.value) ? f.value.join(', ') : f.value}`}`);
  }
  return bits.length ? bits.join(' · ') : 'All records';
}

/** Type-specific shortcuts that belong on the list header. */
function extraActions(type, go) {
  if (type === 'invoice') return h('button.btn', { onclick: () => go('/reports/ar-aging') }, 'AR aging');
  if (type === 'vendor_bill') return h('button.btn', { onclick: () => go('/reports/ap-aging') }, 'AP aging');
  if (type === 'item') return h('button.btn', { onclick: () => go('/inventory') }, 'Stock levels');
  if (type === 'opportunity') return h('button.btn', { onclick: () => go('/pipeline') }, 'Pipeline');
  if (type === 'employee') return h('button.btn', { onclick: () => go('/hr/directory') }, 'Directory');
  return null;
}
