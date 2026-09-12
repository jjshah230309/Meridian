// Meridian ERP :: web/views/assets
// The fixed asset register, and the three things that happen to an asset
// besides being depreciated.
//
// Depreciation is a plan made once and then followed. The interesting screen
// is not that plan but its interruptions: an asset revalued, one written down
// because it will never earn back what is on the balance sheet, one moved to
// a different part of the business. Those lead.
import { h, mount } from '../dom.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import * as store from '../store.js';
import { empty, notifyError, notifyOk, statusTag, loading, modal, facts, confirm, fieldControl } from '../ui.js';

// `assets.register` hands back plain decimal numbers rather than minor units,
// which is the one place in the app that is true. Converted here so the money
// formatter gets what it expects everywhere else.
const asMinor = (n) => Math.round((Number(n) || 0) * 100);

const KIND_LABEL = { revaluation: 'Revaluation', impairment: 'Impairment' };

export async function assetsView(route, { go }) {
  if (!store.can('fixed_asset')) {
    return h('div.page', empty('Not permitted', 'Your role cannot see the asset register.'));
  }
  const canEdit = store.can('fixed_asset', store.LEVEL.EDIT);
  const openId = route.parts[1] || null;

  const host = h('div');
  const head = h('div');

  async function load() {
    mount(host, loading('Reading the register'));
    try {
      if (openId) { await renderOne(openId); return; }
      renderIndex(await API.assetRegister({}), await API.depreciationDue({}), await API.revaluations({}));
    } catch (e) { mount(host, empty('Could not open the register', e.message)); }
  }

  // ------------------------------------------------------------- index
  function renderIndex(reg, dueData, revals) {
    const due = dueData.due || [];
    mount(head,
      h('div.titles',
        h('h1', 'Fixed Assets'),
        h('div.page-sub', 'What the business owns, what it has been worn down to, and what has happened to it since')),
      h('div.page-actions',
        canEdit && due.length ? h('button.btn.primary', { onclick: () => depreciationDialog(due) }, `Depreciate ${due.length}`) : null,
        store.can('fixed_asset', store.LEVEL.CREATE)
          ? h('button.btn', { onclick: () => go('/new/fixed_asset') }, 'New asset') : null));

    const kpis = h('div.kpi-grid', { style: { marginBottom: 'var(--s5)' } },
      h('div.kpi',
        h('div.k-label', 'At cost'),
        h('div.k-value', fmt.moneyCompact(asMinor(reg.totals.cost))),
        h('div.k-meta', `${reg.totals.count} asset${reg.totals.count === 1 ? '' : 's'} on the register`)),
      h('div.kpi',
        h('div.k-label', 'Written down by'),
        h('div.k-value', fmt.moneyCompact(asMinor(reg.totals.accumulated))),
        h('div.k-meta', 'Depreciation charged to date')),
      h('div.kpi',
        h('div.k-label', 'Book value'),
        h('div.k-value', fmt.moneyCompact(asMinor(reg.totals.net_book_value))),
        h('div.k-meta', `As at ${fmt.date(reg.as_of)}`)),
      h('div.kpi',
        h('div.k-label', 'Due to depreciate'),
        h('div.k-value', { class: due.length ? 'num-neg' : '' }, String(due.length)),
        h('div.k-meta', due.length ? 'Periods waiting to be charged' : 'Everything is up to date')));

    mount(host, kpis,
      revals.rows.length
        ? h('div.card', { style: { marginBottom: 'var(--s5)' } },
          h('div.card-head', h('h2', 'Revaluations and impairments'),
            h('span.muted', { style: { fontSize: 'var(--t-sm)' } }, 'Where the plan met reality')),
          h('div.grid-wrap', { style: { maxHeight: '300px' } }, h('table.grid',
            h('thead', h('tr', h('th', 'Reference'), h('th', 'Asset'), h('th', 'Date'), h('th', 'Kind'),
              h('th.num', 'Was'), h('th.num', 'Now'), h('th.num', 'To equity'), h('th.num', 'To profit'), h('th', ''))),
            h('tbody', ...revals.rows.map((r) => h('tr.clickable', { onclick: () => go(`/assets/${r.asset_id}`) },
              h('td', h('strong', r.reference)),
              h('td', r.asset_no, h('div.muted', { style: { fontSize: 'var(--t-xs)' } }, r.asset_name)),
              h('td.muted', fmt.date(r.effective_date)),
              h('td', h('span.tag', { class: r.kind === 'impairment' ? 'amber' : '' }, KIND_LABEL[r.kind] || r.kind)),
              h('td.num.muted', fmt.money(r.carrying_before, r.currency)),
              h('td.num', fmt.money(r.carrying_after, r.currency)),
              h('td.num.muted', r.to_reserve ? fmt.money(r.to_reserve, r.currency) : h('span.faint', '—')),
              h('td.num', { class: r.to_income < 0 ? 'num-neg' : '' },
                r.to_income ? fmt.money(r.to_income, r.currency) : h('span.faint', '—')),
              h('td', statusTag(r.status))))))))
        : null,

      h('div.card',
        h('div.card-head', h('h2', 'The register'),
          h('span.muted', { style: { fontSize: 'var(--t-sm)' } }, `${reg.assets.length} on file`)),
        reg.assets.length
          ? h('div.grid-wrap', { style: { maxHeight: '460px' } }, h('table.grid',
            h('thead', h('tr', h('th', 'Asset'), h('th', 'Class'), h('th', 'In service'),
              h('th.num', 'Cost'), h('th.num', 'Depreciated'), h('th.num', 'Book value'), h('th', 'Status'))),
            h('tbody', ...reg.assets.map((a) => h('tr.clickable', { onclick: () => go(`/assets/${a.id}`) },
              h('td', h('strong', a.asset_no), h('div.muted', { style: { fontSize: 'var(--t-xs)' } }, a.name)),
              h('td.muted', a.class_name),
              h('td.muted', a.in_service_date ? fmt.date(a.in_service_date) : h('span.faint', 'Not yet')),
              h('td.num', fmt.money(asMinor(a.cost))),
              h('td.num.muted', fmt.money(asMinor(a.accumulated))),
              h('td.num', h('strong', fmt.money(asMinor(a.net_book_value)))),
              h('td', statusTag(a.status)))))))
          : h('div.card-body', h('div.muted', 'Nothing on the register yet.'))),

      reg.by_class.length > 1
        ? h('div.card', { style: { marginTop: 'var(--s5)' } },
          h('div.card-head', h('h2', 'By class')),
          h('div.grid-wrap', h('table.grid',
            h('thead', h('tr', h('th', 'Class'), h('th.num', 'Count'), h('th.num', 'Cost'),
              h('th.num', 'Depreciated'), h('th.num', 'Book value'))),
            h('tbody', ...reg.by_class.map((c) => h('tr',
              h('td', c.class_name),
              h('td.num.muted', String(c.count)),
              h('td.num', fmt.money(asMinor(c.cost))),
              h('td.num.muted', fmt.money(asMinor(c.accumulated))),
              h('td.num', fmt.money(asMinor(c.net_book_value)))))))))
        : null);
  }

  // ------------------------------------------------------------ detail
  async function renderOne(id) {
    const [value, sched] = await Promise.all([API.assetValue(id), API.assetSchedule(id)]);
    const a = value.asset;
    const live = a.status === 'active';

    mount(head,
      h('div.titles',
        h('div.breadcrumb', h('a', {
          href: '#/assets',
          onclick: (e) => { e.preventDefault(); go('/assets'); },
        }, 'Fixed Assets')),
        h('h1', a.asset_no, ' ', statusTag(a.status)),
        h('div.page-sub', a.name)),
      h('div.page-actions',
        h('button.btn', { onclick: () => go(`/record/fixed_asset/${a.id}`) }, 'Open record'),
        canEdit && live ? h('button.btn', { onclick: () => transferDialog(a) }, 'Transfer') : null,
        canEdit && live ? h('button.btn', { onclick: () => revalueDialog(a, value, 'impairment') }, 'Impair') : null,
        canEdit && live ? h('button.btn.primary', { onclick: () => revalueDialog(a, value, 'revaluation') }, 'Revalue') : null));

    const unposted = (sched.schedule || []).filter((l) => !l.posted);
    mount(host,
      h('div.card',
        h('div.card-head', h('h2', 'What it is worth')),
        h('div.card-body', facts([
          ['At cost', fmt.money(value.cost, a.currency)],
          ['Depreciated to date', fmt.money(value.depreciated, a.currency)],
          ['Book value', h('strong', fmt.money(value.carrying, a.currency))],
          ['Revaluation reserve', value.reserve
            ? fmt.money(value.reserve, a.currency)
            : h('span.faint', 'None — it has never been written up')],
          ['Impairment not yet reversed', value.impaired
            ? fmt.money(value.impaired, a.currency)
            : h('span.faint', 'None')],
          ['Periods left', unposted.length ? `${unposted.length}, at ${fmt.money(unposted[0].amount, a.currency)} a month` : 'Fully depreciated'],
          ['Last revalued', a.last_revalued_on ? fmt.date(a.last_revalued_on) : h('span.faint', 'Never')],
        ]))),

      value.revaluations.length
        ? h('div.card', { style: { marginTop: 'var(--s5)' } },
          h('div.card-head', h('h2', 'Revaluations and impairments')),
          h('div.grid-wrap', h('table.grid',
            h('thead', h('tr', h('th', 'Reference'), h('th', 'Date'), h('th', 'Kind'),
              h('th.num', 'Was'), h('th.num', 'Now'), h('th.num', 'To equity'), h('th.num', 'To profit'),
              h('th', 'Why'), h('th', ''))),
            h('tbody', ...value.revaluations.map((r) => h('tr',
              h('td', h('strong', r.reference)),
              h('td.muted', fmt.date(r.effective_date)),
              h('td', h('span.tag', { class: r.kind === 'impairment' ? 'amber' : '' }, KIND_LABEL[r.kind] || r.kind)),
              h('td.num.muted', fmt.money(r.carrying_before, a.currency)),
              h('td.num', fmt.money(r.carrying_after, a.currency)),
              h('td.num.muted', r.to_reserve ? fmt.money(r.to_reserve, a.currency) : h('span.faint', '—')),
              h('td.num', { class: r.to_income < 0 ? 'num-neg' : '' },
                r.to_income ? fmt.money(r.to_income, a.currency) : h('span.faint', '—')),
              h('td.muted', { style: { fontSize: 'var(--t-xs)' } }, r.reason || ''),
              h('td', r.status === 'posted' && canEdit
                ? h('button.btn.sm', { onclick: () => reverseReval(r) }, 'Reverse')
                : statusTag(r.status))))))))
        : null,

      value.transfers.length
        ? h('div.card', { style: { marginTop: 'var(--s5)' } },
          h('div.card-head', h('h2', 'Where it has been')),
          h('div.grid-wrap', h('table.grid',
            h('thead', h('tr', h('th', 'Date'), h('th', 'Moved'), h('th', 'Why'))),
            h('tbody', ...value.transfers.map((t) => h('tr',
              h('td.muted', fmt.date(t.transfer_date)),
              h('td', movedText(t)),
              h('td.muted', t.reason || '')))))))
        : null,

      h('div.card', { style: { marginTop: 'var(--s5)' } },
        h('div.card-head', h('h2', 'Depreciation schedule'),
          h('span.muted', { style: { fontSize: 'var(--t-sm)' } },
            'What has been charged, and what is planned')),
        h('div.grid-wrap', { style: { maxHeight: '320px' } }, h('table.grid',
          h('thead', h('tr', h('th', '#'), h('th', 'Date'), h('th.num', 'Charge'),
            h('th.num', 'Accumulated'), h('th.num', 'Book value'), h('th', ''))),
          h('tbody', ...(sched.schedule || []).map((l) => h('tr',
            h('td.muted', String(l.period_no)),
            h('td.muted', fmt.date(l.depr_date)),
            h('td.num', fmt.money(l.amount, a.currency)),
            h('td.num.muted', fmt.money(l.accumulated, a.currency)),
            h('td.num.muted', fmt.money(l.book_value, a.currency)),
            h('td', l.posted ? h('span.tag.green', 'Charged') : h('span.faint', 'Planned')))))))));
  }

  const movedText = (t) => {
    const parts = [];
    if (t.from_subsidiary_id !== t.to_subsidiary_id) parts.push('to another company');
    if (t.from_location_id !== t.to_location_id) parts.push('to another location');
    if (t.from_department_id !== t.to_department_id) parts.push('to another department');
    return parts.length ? parts.join(', ') : 'No change recorded';
  };

  // ------------------------------------------------------------ dialogs
  function revalueDialog(asset, value, kind) {
    const newValue = fieldControl({
      name: 'new_value', label: 'What it is now worth', type: 'money', required: true,
      help: kind === 'impairment'
        ? 'The recoverable amount — what it will actually earn or fetch.'
        : 'The new carrying amount.',
    }, '', null);
    const date = fieldControl({ name: 'effective_date', label: 'Effective', type: 'date' }, fmt.today(), null);
    const reason = fieldControl({ name: 'reason', label: 'Why', type: 'text', full: true }, '', null);
    const previewHost = h('div', { style: { marginTop: 'var(--s4)' } });

    let timer = null;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const v = newValue.get();
        if (v === '' || v === null || v === undefined) { mount(previewHost, h('div.muted', 'Enter a value to see what it would do.')); return; }
        try {
          const p = await API.previewRevaluation(asset.id, { new_value: v, effective_date: date.get(), kind });
          mount(previewHost,
            facts([
              ['Book value now', fmt.money(p.carrying_before, asset.currency)],
              ['After', fmt.money(p.carrying_after, asset.currency)],
              ['Adjustment', h('strong', { class: p.adjustment < 0 ? 'num-neg' : '' }, fmt.money(p.adjustment, asset.currency))],
              ['To the revaluation reserve', p.to_reserve ? fmt.money(p.to_reserve, asset.currency) : h('span.faint', 'Nothing')],
              ['Through profit and loss', p.to_income ? fmt.money(p.to_income, asset.currency) : h('span.faint', 'Nothing')],
              ['New monthly charge', p.remaining_life_months
                ? `${fmt.money(p.new_monthly_charge, asset.currency)} over ${p.remaining_life_months} months`
                : 'Nothing left to depreciate'],
            ]),
            p.to_reserve > 0
              ? h('div.callout', { style: { marginTop: 'var(--s3)' } },
                'Writing an asset up is not profit — nothing has been sold — so it goes to equity, and stays there until it is.')
              : null,
            p.to_income > 0
              ? h('div.callout', { style: { marginTop: 'var(--s3)' } },
                'Part of this reverses a loss this asset was charged with before, so that part goes back through profit and loss.')
              : null,
            p.to_reserve < 0
              ? h('div.callout', { style: { marginTop: 'var(--s3)' } },
                'This first cancels the reserve the asset built up when it was written up. Only what is left is a loss.')
              : null);
        } catch (e) { mount(previewHost, h('div.callout.warn', e.message)); }
      }, 250);
    };
    newValue.el.addEventListener('input', refresh);
    date.el.addEventListener('change', refresh);
    mount(previewHost, h('div.muted', 'Enter a value to see what it would do.'));

    return modal({
      title: kind === 'impairment' ? `Impair ${asset.asset_no}` : `Revalue ${asset.asset_no}`,
      size: 'wide',
      body: h('div',
        h('div.callout',
          kind === 'impairment'
            ? h('span', 'An impairment writes the asset down to what it is really worth. It is a loss, and it is recognised now.')
            : h('span', 'A revaluation restates the asset. Upwards it goes to equity rather than profit; downwards it first cancels any reserve this asset built up.')),
        h('div.form-grid', { style: { marginTop: 'var(--s4)' } }, newValue.el, date.el, reason.el),
        previewHost),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: kind === 'impairment' ? 'Impair it' : 'Revalue it', kind: 'primary',
          onClick: async (close) => {
            try {
              const made = await API.revalueAsset(asset.id, {
                kind, new_value: newValue.get(), effective_date: date.get(), reason: reason.get(),
              });
              notifyOk(`${made.reference} posted.`);
              close(true);
              load();
            } catch (e) { notifyError(e); return false; }
            return true;
          },
        },
      ],
    });
  }

  async function transferDialog(asset) {
    await store.ensureRefs(['subsidiary', 'location', 'department']);
    const opt = async (ref) => (await store.refOptions(ref));
    const [subs, locs, depts] = await Promise.all([opt('subsidiary'), opt('location'), opt('department')]);
    const pick = (label, options, current) => {
      const sel = h('select',
        h('option', { value: '' }, '— leave as it is —'),
        ...options.filter((o) => !o.row?.is_elimination)
          .map((o) => h('option', { value: o.value, selected: false }, o.label + (o.value === current ? ' (now)' : ''))));
      return { el: h('div.field', h('label', label), sel), get: () => sel.value || null };
    };
    const sub = pick('Company', subs, asset.subsidiary_id);
    const loc = pick('Location', locs, asset.location_id);
    const dept = pick('Department', depts, asset.department_id);
    const date = fieldControl({ name: 'transfer_date', label: 'Effective', type: 'date' }, fmt.today(), null);
    const reason = fieldControl({ name: 'reason', label: 'Why', type: 'text', full: true }, '', null);

    return modal({
      title: `Transfer ${asset.asset_no}`,
      body: h('div',
        h('div.form-grid', sub.el, loc.el, dept.el, date.el, reason.el),
        h('div.callout', { style: { marginTop: 'var(--s4)' } },
          'Between departments or locations this only changes whose depreciation charge it is from now on, and nothing posts. ',
          'Between companies it is a real transaction: the asset leaves one balance sheet and joins another, at its own age, through the affiliate accounts.')),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Move it', kind: 'primary',
          onClick: async (close) => {
            try {
              await API.transferAsset(asset.id, {
                transfer_date: date.get(), reason: reason.get(),
                to_subsidiary_id: sub.get(), to_location_id: loc.get(), to_department_id: dept.get(),
              });
              notifyOk(`${asset.asset_no} moved.`);
              close(true);
              load();
            } catch (e) { notifyError(e); return false; }
            return true;
          },
        },
      ],
    });
  }

  function depreciationDialog(due) {
    const through = fieldControl({ name: 'through', label: 'Charge everything due up to', type: 'date' }, fmt.today(), null);
    return modal({
      title: 'Run depreciation',
      body: h('div',
        h('div.form-grid', through.el),
        h('div.callout', { style: { marginTop: 'var(--s4)' } },
          `${due.length} period${due.length === 1 ? '' : 's'} waiting. A period already charged is never charged again, so running this twice costs nothing.`)),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Charge it', kind: 'primary',
          onClick: async (close) => {
            try {
              const out = await API.runDepreciation({ through: through.get() });
              notifyOk(`${out.posted ?? out.count ?? due.length} charged.`);
              close(true);
              load();
            } catch (e) { notifyError(e); return false; }
            return true;
          },
        },
      ],
    });
  }

  async function reverseReval(r) {
    const ok = await confirm({
      title: `Reverse ${r.reference}?`,
      message: 'The entry is reversed and the asset goes back to what it was carried at before.',
      detail: 'Depreciation already charged stays charged — it was right when it was charged.',
      confirmLabel: 'Reverse it',
      danger: true,
    });
    if (!ok) return;
    try {
      await API.reverseAssetRevaluation(r.id, { reason: 'Reversed from the asset screen' });
      notifyOk(`${r.reference} reversed.`);
      load();
    } catch (e) { notifyError(e); }
  }

  load();
  return h('div.page', h('div.page-head', head), host);
}
