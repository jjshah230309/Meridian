// Meridian ERP :: web/views/crm
// Pipeline board (drag a deal between stages) and the sales forecast.
import { h, mount, clear } from '../dom.js';
import { icon } from '../icons.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import * as store from '../store.js';
import { empty, toast, notifyError, modal, statusTag, facts, loading } from '../ui.js';
import { barChart, donut, stackedBar, legend } from '../charts.js';

const STAGE_LABEL = { prospecting: 'Prospecting', qualification: 'Qualification', proposal: 'Proposal', negotiation: 'Negotiation' };

export async function pipelineView(_route, { go }) {
  const board = h('div.kanban');
  const summary = h('div.kpi-grid', { style: { marginBottom: '14px' } });

  async function load() {
    const { stages } = await API.pipeline(store.state.subsidiary ? { subsidiary_id: store.state.subsidiary } : {});
    const totalValue = stages.reduce((a, s) => a + s.value, 0);
    const totalWeighted = stages.reduce((a, s) => a + s.weighted, 0);
    const totalDeals = stages.reduce((a, s) => a + s.count, 0);

    mount(summary,
      h('div.kpi', h('div.k-label', 'Open pipeline'), h('div.k-value', fmt.moneyCompact(totalValue)), h('div.k-meta', `${totalDeals} deals`)),
      h('div.kpi', h('div.k-label', 'Weighted'), h('div.k-value', fmt.moneyCompact(totalWeighted)), h('div.k-meta', 'By stage probability')),
      h('div.kpi', h('div.k-label', 'Average deal'), h('div.k-value.sm', totalDeals ? fmt.moneyCompact(Math.round(totalValue / totalDeals)) : '—'), h('div.k-meta', 'Open opportunities')),
      h('div.kpi.linked', { onclick: () => go('/forecast') }, h('div.k-label', 'Forecast'), h('div.k-value.sm', 'Open ', icon('arrow-right', { size: 16 })), h('div.k-meta', 'Commit and best case')));

    clear(board);
    for (const stage of stages) {
      const body = h('div.kanban-body');
      for (const deal of stage.deals) {
        const card = h('div.deal', {
          draggable: true, dataset: { id: deal.id },
          onclick: () => go(`/record/opportunity/${deal.id}`),
        },
          h('div.n', deal.name),
          h('div.c', deal.customer_name || 'No customer'),
          h('div.r',
            h('strong', fmt.money(deal.amount, deal.currency)),
            h('span.muted', `${deal.probability}%`)),
          h('div.r', { style: { marginTop: '2px' } },
            h('span.muted', { style: { fontSize: '11px' } }, deal.expected_close ? fmt.date(deal.expected_close) : 'No close date'),
            overdueTag(deal)));
        card.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', deal.id); e.dataTransfer.effectAllowed = 'move'; });
        body.appendChild(card);
      }
      if (!stage.deals.length) body.appendChild(h('div.muted', { style: { padding: '10px', fontSize: '12px', textAlign: 'center' } }, 'No deals'));

      const col = h('div.kanban-col',
        h('div.kanban-head',
          h('div.t', STAGE_LABEL[stage.stage] || stage.label, h('span.tag', String(stage.count))),
          h('div.v', `${fmt.money(stage.value)} · ${fmt.money(stage.weighted)} weighted`)),
        body);

      col.addEventListener('dragover', (e) => { e.preventDefault(); col.style.outline = '2px solid var(--accent)'; });
      col.addEventListener('dragleave', () => { col.style.outline = ''; });
      col.addEventListener('drop', async (e) => {
        e.preventDefault();
        col.style.outline = '';
        const id = e.dataTransfer.getData('text/plain');
        if (!id) return;
        try {
          await API.update('opportunity', id, { stage: stage.stage });
          toast(`Moved to ${STAGE_LABEL[stage.stage] || stage.stage}`, { kind: 'success' });
          load();
        } catch (err) { notifyError(err); }
      });
      board.appendChild(col);
    }
  }

  const overdueTag = (deal) => {
    if (!deal.expected_close) return null;
    const days = Math.round((Date.parse(deal.expected_close) - Date.now()) / 86400000);
    if (days < 0) return h('span.tag.red', `${Math.abs(days)}d late`);
    if (days <= 7) return h('span.tag.amber', `${days}d`);
    return null;
  };

  await load();

  return h('div.page',
    h('div.page-head',
      h('div.titles', h('h1', 'Pipeline'),
        h('div.page-sub', 'Drag a deal between columns to move its stage. Probability follows the stage unless you override it.')),
      h('div.page-actions',
        h('button.btn', { onclick: () => go('/forecast') }, 'Forecast'),
        store.can('opportunity', store.LEVEL.CREATE) && h('button.btn.primary', { onclick: () => go('/new/opportunity') }, icon('plus', { size: 14 }), 'New opportunity'))),
    summary, board);
}

// ============================================================= forecast
export async function forecastView(_route, { go }) {
  const from = h('input', { type: 'date', value: fmt.startOfMonth() });
  const to = h('input', { type: 'date', value: fmt.addDays(fmt.addMonths(fmt.startOfMonth(), 3), -1) });
  const host = h('div');

  async function load() {
    mount(host, loading());
    const r = await API.forecast({ from: from.value, to: to.value });
    const cats = Object.fromEntries(r.categories.map((c) => [c.category, c]));

    mount(host,
      h('div.kpi-grid', { style: { marginBottom: '14px' } },
        h('div.kpi', h('div.k-label', 'Closed won'), h('div.k-value', fmt.moneyCompact(r.closed_won)), h('div.k-meta', 'Booked in range')),
        h('div.kpi', h('div.k-label', 'Forecast'), h('div.k-value', fmt.moneyCompact(r.forecast_total)), h('div.k-meta', 'Closed + commit')),
        h('div.kpi', h('div.k-label', 'Best case'), h('div.k-value', fmt.moneyCompact(r.best_case_total)), h('div.k-meta', '+ best case deals')),
        h('div.kpi', h('div.k-label', 'Weighted pipeline'), h('div.k-value', fmt.moneyCompact(r.weighted_pipeline)), h('div.k-meta', `${r.deal_count} deals in range`))),

      h('div.split',
        h('div.stack',
          h('div.card',
            h('div.card-head', h('h2', 'By forecast category')),
            h('div.card-body',
              stackedBar(['closed', 'commit', 'best_case', 'pipeline', 'omitted'].map((k) => ({ label: fmt.titleCase(k), value: cats[k]?.amount || 0 }))),
              legend(['closed', 'commit', 'best_case', 'pipeline', 'omitted'].map((k) => ({ label: fmt.titleCase(k), value: cats[k]?.amount || 0 }))),
              h('table.grid.compact', { style: { marginTop: '12px' } },
                h('thead', h('tr', h('th', 'Category'), h('th.num', 'Deals'), h('th.num', 'Amount'), h('th.num', 'Weighted'))),
                h('tbody', ...r.categories.map((c) => h('tr',
                  h('td', fmt.titleCase(c.category)),
                  h('td.num.muted', String(c.count)),
                  h('td.num', fmt.money(c.amount)),
                  h('td.num', fmt.money(c.weighted)))))))),

          h('div.card',
            h('div.card-head', h('h2', 'Deals in range'), h('span.muted', { style: { fontSize: '12px' } }, `${r.deals.length} shown`)),
            h('div.grid-wrap', h('table.grid',
              h('thead', h('tr', h('th', 'Opportunity'), h('th', 'Customer'), h('th', 'Stage'), h('th', 'Category'), h('th.num', 'Amount'), h('th.num', '%'), h('th.num', 'Weighted'), h('th', 'Close'))),
              h('tbody', ...r.deals.map((d) => h('tr.clickable', { onclick: () => go(`/record/opportunity/${d.id}`) },
                h('td', h('span.cell-truncate', d.name)),
                h('td.muted', d.customer_name || '—'),
                h('td', statusTag(d.stage)),
                h('td.muted', fmt.titleCase(d.forecast_category)),
                h('td.num', fmt.money(d.amount, d.currency)),
                h('td.num.muted', `${d.probability}%`),
                h('td.num', fmt.money(d.weighted_amount, d.currency)),
                h('td.nowrap', fmt.date(d.expected_close))))))))),

        h('div.stack',
          h('div.card',
            h('div.card-head', h('h2', 'Performance')),
            h('div.card-body', facts([
              ['Win rate', fmt.pct(r.metrics.win_rate, 0)],
              ['Deals won', String(r.metrics.won_count)],
              ['Deals closed', String(r.metrics.closed_count)],
              ['Won value', fmt.money(r.metrics.won_value)],
              ['Lost value', fmt.money(r.metrics.lost_value)],
              ['Average deal', fmt.money(r.metrics.average_deal)],
              ['Average cycle', r.metrics.average_cycle_days ? `${r.metrics.average_cycle_days} days` : '—'],
            ]),
              h('div.muted', { style: { marginTop: '10px', fontSize: '11.5px' } }, `Based on deals closed in the last ${r.metrics.window_days} days.`))),

          r.by_owner.length ? h('div.card',
            h('div.card-head', h('h2', 'By owner')),
            h('div.grid-wrap', h('table.grid.compact',
              h('thead', h('tr', h('th', 'Owner'), h('th.num', 'Deals'), h('th.num', 'Weighted'), h('th.num', 'Won'))),
              h('tbody', ...r.by_owner.map((o) => h('tr',
                h('td', o.owner),
                h('td.num.muted', String(o.count)),
                h('td.num', fmt.money(o.weighted)),
                h('td.num.num-pos', fmt.money(o.won)))))))) : null)));
  }

  from.addEventListener('change', load);
  to.addEventListener('change', load);
  await load();

  return h('div.page',
    h('div.page-head',
      h('div.titles', h('h1', 'Sales Forecast'),
        h('div.page-sub', 'Forecast is closed-won plus commit. Best case adds the deals reps flagged as upside.')),
      h('div.page-actions',
        h('span.muted', { style: { fontSize: '12px' } }, 'From'), from,
        h('span.muted', { style: { fontSize: '12px' } }, 'to'), to,
        h('button.btn', { onclick: () => go('/pipeline') }, 'Pipeline board'))),
    host);
}
