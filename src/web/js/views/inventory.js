// Meridian ERP :: web/views/inventory
// Stock position, reorder analysis and one-click purchase order generation.
import { h, mount, clear } from '../dom.js';
import { icon } from '../icons.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import * as store from '../store.js';
import { empty, toast, notifyError, modal, confirm, statusTag, facts, loading } from '../ui.js';
import { donut } from '../charts.js';

const SEVERITY = {
  stockout: { label: 'Out of stock', tone: 'red', rank: 0 },
  critical: { label: 'Critical', tone: 'amber', rank: 1 },
  low: { label: 'Low', tone: '', rank: 2 },
};

export async function inventoryView(_route, { go }) {
  const locationSel = h('select', { style: { width: '180px' } },
    h('option', { value: '' }, 'All locations'),
    ...(store.state.meta.locations || []).map((l) => h('option', { value: l.id }, l.name)));
  const lookbackSel = h('select', { style: { width: '150px' } },
    ...[30, 60, 90, 180, 365].map((d) => h('option', { value: d, selected: d === 90 }, `${d}-day demand`)));

  const host = h('div');
  const selected = new Set();

  async function load() {
    mount(host, loading('Analysing stock'));
    const [reorder, valuation] = await Promise.all([
      API.reorder({ location_id: locationSel.value || undefined, lookback: lookbackSel.value }),
      API.valuation({ location_id: locationSel.value || undefined }),
    ]);
    selected.clear();
    render(reorder.suggestions, valuation);
  }

  function render(suggestions, valuation) {
    const bySeverity = { stockout: 0, critical: 0, low: 0 };
    for (const s of suggestions) bySeverity[s.severity]++;
    const orderValue = suggestions.reduce((a, s) => a + s.estimated_cost, 0);

    const summary = h('div.kpi-grid', { style: { marginBottom: '14px' } },
      h('div.kpi',
        h('div.k-label', 'Inventory value'),
        h('div.k-value', fmt.moneyCompact(valuation.total_value)),
        h('div.k-meta', `${valuation.rows.length} stocked positions`)),
      h('div.kpi',
        h('div.k-label', 'Needs reordering'),
        h('div.k-value', String(suggestions.length)),
        h('div.k-meta', `${bySeverity.stockout} out of stock`)),
      h('div.kpi',
        h('div.k-label', 'Suggested spend'),
        h('div.k-value', fmt.moneyCompact(orderValue)),
        h('div.k-meta', 'To reach target levels')),
      h('div.kpi',
        h('div.k-label', 'Units on hand'),
        h('div.k-value.sm', fmt.qty(valuation.total_qty, 0)),
        h('div.k-meta', 'Across all locations')));

    const rows = suggestions.map((s) => {
      const cb = h('input', {
        type: 'checkbox',
        onchange: (e) => { if (e.target.checked) selected.add(s); else selected.delete(s); updateBar(); },
      });
      const qtyInput = h('input', {
        type: 'number', step: 'any', class: 'num', style: { width: '92px' },
        value: fmt.qty(s.suggested_qty),
        oninput: (e) => { s.suggested_qty = Number(e.target.value || 0) * 1e6; updateBar(); },
      });
      const sev = SEVERITY[s.severity];
      return h('tr',
        h('td', cb),
        h('td', h('span.tag', { class: sev.tone }, sev.label)),
        h('td', h('a', {
          href: `#/record/item/${s.item_id}`,
          onclick: (e) => { e.preventDefault(); go(`/record/item/${s.item_id}`); },
        }, h('span.mono', s.sku))),
        h('td', h('span.cell-truncate', s.item_name)),
        h('td.muted', s.location_code),
        h('td.num', fmt.qty(s.qty_on_hand)),
        h('td.num.muted', fmt.qty(s.qty_committed)),
        h('td.num', { class: s.qty_available <= 0 ? 'num-neg' : '' }, fmt.qty(s.qty_available)),
        h('td.num.muted', fmt.qty(s.qty_on_order)),
        h('td.num', fmt.qty(s.reorder_point)),
        h('td.num.muted', `${s.lead_time_days}d`),
        h('td', qtyInput),
        h('td.num', fmt.money(s.estimated_cost)));
    });

    const bar = h('div.card-foot');
    function updateBar() {
      const picked = [...selected];
      const total = picked.reduce((a, s) => a + (s.suggested_qty / 1e6) * (s.estimated_cost / Math.max(1, s.suggested_qty / 1e6)), 0);
      clear(bar);
      bar.appendChild(h('div.row',
        h('span', `${picked.length} selected`),
        h('div.spacer', { style: { flex: 1 } }),
        picked.length ? h('button.btn.sm.primary', { onclick: () => createPos(picked) }, 'Create purchase orders') : null));
    }

    async function createPos(picked) {
      const byVendor = {};
      for (const s of picked) {
        const key = s.preferred_vendor_id || 'none';
        (byVendor[key] ||= []).push(s);
      }
      const missing = byVendor.none?.length || 0;
      if (missing) {
        toast(`${missing} item${missing === 1 ? ' has' : 's have'} no preferred vendor. Set one on the item first.`, { kind: 'warn', timeout: 7000 });
        return;
      }
      const ok = await confirm({
        title: 'Create purchase orders?',
        message: `${picked.length} line${picked.length === 1 ? '' : 's'} will be grouped into ${Object.keys(byVendor).length} purchase order${Object.keys(byVendor).length === 1 ? '' : 's'} by vendor and location.`,
        confirmLabel: 'Create',
      });
      if (!ok) return;
      try {
        const r = await API.createReorderPos(picked);
        toast(`${r.created.length} purchase order${r.created.length === 1 ? '' : 's'} created`, { kind: 'success' });
        if (r.created.length === 1) go(`/txn/${r.created[0].id}`);
        else go('/list/purchase_order');
      } catch (e) { notifyError(e); }
    }
    updateBar();

    const selectAll = h('input', {
      type: 'checkbox',
      onchange: (e) => {
        selected.clear();
        if (e.target.checked) suggestions.forEach((s) => selected.add(s));
        host.querySelectorAll('tbody input[type="checkbox"]').forEach((c) => { c.checked = e.target.checked; });
        updateBar();
      },
    });

    const table = h('div.card',
      h('div.card-head',
        h('h2', 'Reorder analysis'),
        h('span.muted', { style: { fontSize: '12px' } },
          'Reorder point is the greater of the configured value and demand × lead time + safety stock'),
        h('div.actions', h('div.row', { style: { gap: '4px' } },
          h('button.btn.sm', { onclick: () => API.exportCsv('item').catch(notifyError) }, icon('download', { size: 13 }), 'CSV'),
          h('button.btn.sm', { onclick: () => API.exportFile('item', 'pdf').catch(notifyError) }, 'PDF')))),
      suggestions.length
        ? h('div.grid-wrap', h('table.grid',
          h('thead', h('tr',
            h('th', selectAll), h('th', ''), h('th', 'SKU'), h('th', 'Item'), h('th', 'Loc'),
            h('th.num', 'On hand'), h('th.num', 'Committed'), h('th.num', 'Available'),
            h('th.num', 'On order'), h('th.num', 'Reorder pt'), h('th.num', 'Lead'),
            h('th.num', 'Order qty'), h('th.num', 'Est. cost'))),
          h('tbody', ...rows)))
        : empty('Everything is in stock', 'No item is at or below its reorder point.'),
      suggestions.length ? bar : null);

    const valuationTable = h('div.card', { style: { marginTop: '14px' } },
      h('div.card-head', h('h2', 'Stock on hand'), h('span.muted', { style: { fontSize: '12px' } }, `${valuation.rows.length} positions`)),
      h('div.grid-wrap', h('table.grid',
        h('thead', h('tr', h('th', 'SKU'), h('th', 'Item'), h('th', 'Location'), h('th.num', 'On hand'), h('th.num', 'Avg cost'), h('th.num', 'Value'))),
        h('tbody', ...valuation.rows.map((v) => h('tr.clickable', { onclick: () => go(`/record/item/${v.item_id}`) },
          h('td', h('span.mono', v.sku)),
          h('td', h('span.cell-truncate', v.item_name)),
          h('td.muted', v.location_name),
          h('td.num', fmt.qty(v.qty_on_hand)),
          h('td.num', fmt.money(v.avg_cost)),
          h('td.num', fmt.money(v.total_value))))),
        h('tfoot', h('tr', h('td', { colspan: 5 }, 'Total inventory value'), h('td.num', fmt.money(valuation.total_value)))))));

    mount(host, summary, table, valuationTable);
  }

  locationSel.addEventListener('change', load);
  lookbackSel.addEventListener('change', load);
  await load();

  return h('div.page',
    h('div.page-head',
      h('div.titles',
        h('h1', 'Stock & Reorder'),
        h('div.page-sub', 'Demand is measured from actual shipments, so a stale manual reorder point cannot hide a real stock-out risk.')),
      h('div.page-actions', locationSel, lookbackSel,
        h('button.btn', { onclick: () => go('/list/item') }, 'All items'))),
    host);
}
