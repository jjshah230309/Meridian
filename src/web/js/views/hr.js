// Meridian ERP :: web/views/hr
// Employee directory, org chart, timesheets and payroll.
import { h, mount, clear, debounce } from '../dom.js';
import { icon } from '../icons.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import * as store from '../store.js';
import { empty, toast, notifyError, modal, confirm, formModal, statusTag, facts, loading } from '../ui.js';
import { donut } from '../charts.js';

export async function hrView(route, { go }) {
  const section = route.parts[1] || 'directory';
  if (section === 'directory') return directoryView(go);
  if (section === 'orgchart') return orgChartView(go);
  if (section === 'timesheet') return timesheetView(route, go);
  if (section === 'payroll') return route.parts[2] ? payrollRunView(route.parts[2], go) : payrollListView(go);
  return h('div.page', empty('Unknown page', section));
}

// ------------------------------------------------------------ directory
async function directoryView(go) {
  const search = h('input', { type: 'search', placeholder: 'Search people…', style: { width: '230px' } });
  const deptSel = h('select', { style: { width: '180px' } },
    h('option', { value: '' }, 'All departments'),
    ...(store.state.meta.departments || []).map((d) => h('option', { value: d.id }, d.name)));
  const statusSel = h('select', { style: { width: '140px' } },
    h('option', { value: 'active' }, 'Active'),
    h('option', { value: 'all' }, 'Everyone'),
    h('option', { value: 'terminated' }, 'Terminated'));

  const host = h('div');

  async function load() {
    mount(host, loading());
    const r = await API.directory({
      q: search.value.trim() || undefined,
      department_id: deptSel.value || undefined,
      status: statusSel.value,
    });
    const m = r.metrics;

    const metrics = h('div.kpi-grid', { style: { marginBottom: '14px' } },
      h('div.kpi', h('div.k-label', 'Headcount'), h('div.k-value', String(m.headcount)), h('div.k-meta', `${m.hires_90d} hired in 90 days`)),
      h('div.kpi', h('div.k-label', 'Departments'), h('div.k-value', String(m.by_department.length)), h('div.k-meta', `${m.on_leave} on leave`)),
      h('div.kpi', h('div.k-label', 'Annualised payroll'), h('div.k-value', fmt.moneyCompact(m.annualised_salary_cost)), h('div.k-meta', 'Base pay, active staff')),
      h('div.kpi.linked', { onclick: () => go('/hr/payroll') }, h('div.k-label', 'Payroll'), h('div.k-value.sm', 'Open ', icon('arrow-right', { size: 16 })), h('div.k-meta', 'Runs and posting')));

    const cards = r.employees.map((e) => {
      const name = `${e.preferred_name || e.first_name} ${e.last_name}`;
      return h('div.kpi.linked', { onclick: () => go(`/record/employee/${e.id}`) },
        h('div.row', { style: { gap: '9px', alignItems: 'flex-start' } },
          h('div.avatar', { style: { flex: 'none' } }, fmt.initials(name)),
          h('div', { style: { minWidth: 0 } },
            h('div', { style: { fontWeight: 600 } }, name),
            h('div.muted', { style: { fontSize: '12px' } }, e.title || '—'),
            h('div.faint', { style: { fontSize: '11.5px', marginTop: '2px' } }, e.department_name || 'No department'),
            e.email ? h('div.faint', { style: { fontSize: '11.5px' } }, e.email) : null,
            e.status !== 'active' ? statusTag(e.status) : null)));
    });

    mount(host, metrics,
      r.employees.length
        ? h('div.kpi-grid', ...cards)
        : empty('Nobody matches', 'Try a different search or department.'));
  }

  search.addEventListener('input', debounce(load, 250));
  deptSel.addEventListener('change', load);
  statusSel.addEventListener('change', load);
  await load();

  return h('div.page',
    h('div.page-head',
      h('div.titles', h('h1', 'People'), h('div.page-sub', 'Company directory')),
      h('div.page-actions', search, deptSel, statusSel,
        h('button.btn', { onclick: () => go('/hr/orgchart') }, 'Org chart'),
        store.can('employee', store.LEVEL.CREATE) && h('button.btn.primary', { onclick: () => go('/new/employee') }, icon('plus', { size: 14 }), 'New employee'))),
    host);
}

// ------------------------------------------------------------ org chart
async function orgChartView(go) {
  const { roots } = await API.orgChart();
  const host = h('div.card-body');

  const node = (e, depth) => {
    const name = `${e.preferred_name || e.first_name} ${e.last_name}`;
    const row = h('div', { style: { marginLeft: `${depth * 26}px`, marginBottom: '5px' } },
      h('div.row', {
        style: {
          gap: '9px', padding: '7px 10px', background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)', cursor: 'pointer', maxWidth: '540px',
        },
        onclick: () => go(`/record/employee/${e.id}`),
      },
        h('div.avatar', { style: { flex: 'none', width: '24px', height: '24px', fontSize: '10px' } }, fmt.initials(name)),
        h('div', { style: { minWidth: 0, flex: 1 } },
          h('div', { style: { fontWeight: 500, fontSize: '12.5px' } }, name),
          h('div.muted', { style: { fontSize: '11.5px' } }, [e.title, e.department_name].filter(Boolean).join(' · '))),
        e.total_reports ? h('span.tag', `${e.total_reports} report${e.total_reports === 1 ? '' : 's'}`) : null));
    const kids = e.reports.map((c) => node(c, depth + 1));
    return h('div', row, ...kids);
  };

  mount(host, ...roots.map((r) => node(r, 0)));
  if (!roots.length) mount(host, empty('No org chart yet', 'Set a manager on each employee to build the reporting tree.'));

  return h('div.page',
    h('div.page-head',
      h('div.titles',
        h('div.breadcrumb', h('a', { href: '#/hr/directory', onclick: (e) => { e.preventDefault(); go('/hr/directory'); } }, 'People')),
        h('h1', 'Org Chart'),
        h('div.page-sub', 'Reporting lines are validated — a cycle cannot be saved.')),
      h('div.page-actions', h('button.btn.no-print', { onclick: () => window.print() }, icon('printer', { size: 13 }), 'Print'))),
    h('div.card', host));
}

// ------------------------------------------------------------ timesheet
async function timesheetView(route, go) {
  const employees = await store.refOptions('employee');
  const meId = store.state.user.employee_id;
  let employeeId = route.query.employee || meId || employees[0]?.value;
  let weekStart = route.query.week || mondayOf(fmt.today());

  const empSel = h('select', { style: { width: '210px' } },
    ...employees.map((e) => h('option', { value: e.value, selected: e.value === employeeId }, e.label)));
  const host = h('div');

  function mondayOf(d) {
    const dt = new Date(d + 'T00:00:00Z');
    const day = (dt.getUTCDay() + 6) % 7;
    return fmt.addDays(d, -day);
  }

  async function load() {
    mount(host, loading());
    const t = await API.timesheet(employeeId, weekStart);
    const canApprove = store.can('time_entry', store.LEVEL.FULL);
    const pending = t.entries.filter((e) => e.status === 'submitted');

    const dayCols = t.days.map((d) => {
      const hours = t.by_day[d] || 0;
      return h('div', {
        style: {
          flex: 1, padding: '9px', textAlign: 'center', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)', background: hours ? 'var(--accent-soft)' : 'var(--surface-2)',
        },
      },
        h('div.muted', { style: { fontSize: '11px' } }, new Date(d + 'T00:00:00Z').toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' })),
        h('div', { style: { fontSize: '15px', fontWeight: 600 } }, hours ? fmt.num(hours, 1) : '—'),
        h('div.faint', { style: { fontSize: '10.5px' } }, fmt.dateShort(d)));
    });

    mount(host,
      h('div.card',
        h('div.card-head',
          h('h2', `${t.employee.first_name} ${t.employee.last_name}`),
          h('span.muted', { style: { fontSize: '12px' } }, `${fmt.date(t.week_start)} – ${fmt.date(t.week_end)}`),
          h('div.actions',
            h('span.tag', `${fmt.num(t.total_hours, 1)} h total`),
            h('span.tag.green', `${fmt.num(t.billable_hours, 1)} h billable`))),
        h('div.card-body',
          h('div.row', { style: { gap: '6px', marginBottom: '14px' } }, ...dayCols),
          t.entries.length
            ? h('table.grid.compact',
              h('thead', h('tr', h('th', 'Date'), h('th.num', 'Hours'), h('th', 'Customer'), h('th', 'Project'), h('th', 'Notes'), h('th', 'Billable'), h('th', 'Status'))),
              h('tbody', ...t.entries.map((e) => h('tr',
                h('td.nowrap', fmt.date(e.entry_date)),
                h('td.num', fmt.num(e.hours, 1)),
                h('td.muted', e.customer_name || '—'),
                h('td.muted', e.project || '—'),
                h('td', h('span.cell-truncate', e.memo || '')),
                h('td', e.billable ? h('span.tag.green', 'Yes') : h('span.faint', 'No')),
                h('td', statusTag(e.status))))))
            : empty('No time logged this week', 'Add an entry to get started.')),
        canApprove && pending.length
          ? h('div.card-foot',
            h('div.row',
              h('span', `${pending.length} entr${pending.length === 1 ? 'y' : 'ies'} awaiting approval`),
              h('div', { style: { flex: 1 } }),
              h('button.btn.sm', {
                onclick: async () => {
                  try { await API.approveTime(pending.map((p) => p.id), false); toast('Rejected', { kind: 'success' }); load(); }
                  catch (e) { notifyError(e); }
                },
              }, 'Reject all'),
              h('button.btn.sm.primary', {
                onclick: async () => {
                  try { await API.approveTime(pending.map((p) => p.id), true); toast('Approved', { kind: 'success' }); load(); }
                  catch (e) { notifyError(e); }
                },
              }, 'Approve all')))
          : null));
  }

  empSel.addEventListener('change', () => { employeeId = empSel.value; load(); });
  await load();

  return h('div.page',
    h('div.page-head',
      h('div.titles',
        h('div.breadcrumb', h('a', { href: '#/hr/directory', onclick: (e) => { e.preventDefault(); go('/hr/directory'); } }, 'People')),
        h('h1', 'Timesheet')),
      h('div.page-actions', empSel,
        h('button.btn', { onclick: () => { weekStart = fmt.addDays(weekStart, -7); load(); } }, '‹ Previous'),
        h('button.btn', { onclick: () => { weekStart = mondayOf(fmt.today()); load(); } }, 'This week'),
        h('button.btn', { onclick: () => { weekStart = fmt.addDays(weekStart, 7); load(); } }, 'Next ›'),
        store.can('time_entry', store.LEVEL.CREATE) && h('button.btn.primary', {
          onclick: () => logTimeModal(employeeId, load),
        }, icon('plus', { size: 13 }), 'Log time'))),
    host);
}

function logTimeModal(employeeId, onDone) {
  formModal({
    title: 'Log time',
    fields: [
      { name: 'entry_date', label: 'Date', type: 'date' },
      { name: 'hours', label: 'Hours', type: 'number' },
      { name: 'customer_id', label: 'Customer', type: 'reference', ref: 'customer' },
      { name: 'project', label: 'Project', type: 'text' },
      { name: 'billable', label: 'Billable', type: 'checkbox' },
      { name: 'memo', label: 'Notes', type: 'text', full: true },
    ],
    values: { entry_date: fmt.today(), hours: 8 },
    submitLabel: 'Log time',
    onSubmit: async (m) => {
      await API.create('time_entry', { ...m, employee_id: employeeId, status: 'submitted' });
      toast('Time logged', { kind: 'success' });
      onDone();
    },
  });
}

// -------------------------------------------------------------- payroll
async function payrollListView(go) {
  const res = await API.list('payroll_run', { limit: 50, sort: 'pay_date DESC' });
  const rows = res.rows || [];

  const table = rows.length
    ? h('div.grid-wrap', h('table.grid',
      h('thead', h('tr', h('th', 'Run'), h('th', 'Period'), h('th', 'Pay date'), h('th.num', 'Employees'), h('th.num', 'Gross'), h('th.num', 'Net'), h('th', 'Status'))),
      h('tbody', ...rows.map((r) => h('tr.clickable', { onclick: () => go(`/hr/payroll/${r.id}`) },
        h('td', h('span.mono', r.run_no)),
        h('td', `${fmt.date(r.period_start)} – ${fmt.date(r.period_end)}`),
        h('td', fmt.date(r.pay_date)),
        h('td.num', String(r.employee_count)),
        h('td.num', fmt.money(r.total_gross)),
        h('td.num', fmt.money(r.total_net)),
        h('td', statusTag(r.status)))))))
    : empty('No payroll runs yet', 'Calculate a run to see gross-to-net and post it to the ledger.');

  return h('div.page',
    h('div.page-head',
      h('div.titles',
        h('div.breadcrumb', h('a', { href: '#/hr/directory', onclick: (e) => { e.preventDefault(); go('/hr/directory'); } }, 'People')),
        h('h1', 'Payroll'),
        h('div.page-sub', 'Meridian calculates gross-to-net and posts the journal. Funding and statutory filing go to your payroll provider.')),
      h('div.page-actions',
        store.can('payroll_run', store.LEVEL.CREATE) && h('button.btn.primary', { onclick: () => newRunModal(go) }, icon('plus', { size: 13 }), 'Calculate run'))),
    h('div.card', table));
}

function newRunModal(go) {
  const lastMonthStart = fmt.startOfMonth(fmt.addMonths(fmt.today(), -1));
  formModal({
    title: 'Calculate payroll run',
    fields: [
      { name: 'period_start', label: 'Period start', type: 'date' },
      { name: 'period_end', label: 'Period end', type: 'date' },
      { name: 'pay_date', label: 'Pay date', type: 'date' },
    ],
    values: {
      period_start: lastMonthStart,
      period_end: fmt.endOfMonth(lastMonthStart),
      pay_date: fmt.endOfMonth(lastMonthStart),
    },
    submitLabel: 'Calculate',
    onSubmit: async (m) => {
      const run = await API.calcPayroll(m);
      toast(`${run.run_no} calculated — ${run.employee_count} employees`, { kind: 'success' });
      go(`/hr/payroll/${run.id}`);
    },
  });
}

async function payrollRunView(id, go) {
  const run = await API.payrollRun(id);
  const canPost = store.can('payroll_run', store.LEVEL.FULL);

  const actions = [];
  if (run.status === 'calculated' && canPost) {
    actions.push(h('button.btn.primary', {
      onclick: async () => {
        const ok = await confirm({
          title: `Post ${run.run_no}?`,
          message: `A journal entry will be posted for ${fmt.money(run.total_gross)} gross and ${fmt.money(run.total_net)} net pay.`,
          detail: 'Posted payroll cannot be edited — it would have to be reversed.',
          confirmLabel: 'Post to ledger',
        });
        if (!ok) return;
        try { await API.approvePayroll(id); toast('Payroll posted', { kind: 'success' }); go(`/hr/payroll/${id}`); location.reload(); }
        catch (e) { notifyError(e); }
      },
    }, 'Post to ledger'));
  }
  if (run.status === 'posted' && canPost) {
    actions.push(h('button.btn', {
      onclick: async () => {
        try {
          const r = await API.exportPayroll(id, { provider: 'generic' });
          toast('Queued for the payroll provider', { kind: 'success', title: `Event ${r.event_id.slice(-8)}` });
        } catch (e) { notifyError(e); }
      },
    }, 'Send to provider'));
  }
  if (run.journal_entry_id) {
    actions.push(h('button.btn', { onclick: () => go(`/journal/${run.journal_entry_id}`) }, 'View journal'));
  }

  const lines = h('div.grid-wrap', h('table.grid',
    h('thead', h('tr', h('th', 'Employee'), h('th', 'Department'), h('th.num', 'Gross'), h('th.num', 'Employee tax'), h('th.num', 'Deductions'), h('th.num', 'Net'), h('th.num', 'Employer tax'))),
    h('tbody', ...run.lines.map((l) => h('tr',
      h('td', `${l.first_name} ${l.last_name}`, ' ', h('span.faint', l.employee_no)),
      h('td.muted', l.department_name || '—'),
      h('td.num', fmt.money(l.gross, run.currency)),
      h('td.num', fmt.money(l.employee_tax, run.currency)),
      h('td.num', fmt.money(l.deductions, run.currency)),
      h('td.num', h('strong', fmt.money(l.net, run.currency))),
      h('td.num.muted', fmt.money(l.employer_tax, run.currency))))),
    h('tfoot', h('tr',
      h('td', { colspan: 2 }, `${run.employee_count} employees`),
      h('td.num', fmt.money(run.total_gross, run.currency)),
      h('td.num', fmt.money(run.total_employee_tax, run.currency)),
      h('td.num', fmt.money(run.total_deductions, run.currency)),
      h('td.num', fmt.money(run.total_net, run.currency)),
      h('td.num', fmt.money(run.total_employer_tax, run.currency))))));

  const side = h('div.stack',
    h('div.card',
      h('div.card-head', h('h2', 'Run')),
      h('div.card-body', facts([
        ['Run number', h('span.mono', run.run_no)],
        ['Period', `${fmt.date(run.period_start)} – ${fmt.date(run.period_end)}`],
        ['Pay date', fmt.date(run.pay_date)],
        ['Status', statusTag(run.status)],
        ['Employees', String(run.employee_count)],
        ['Total cost', fmt.money(run.total_gross + run.total_employer_tax, run.currency)],
        ['Provider', run.provider === 'none' ? 'Not sent' : `${run.provider} (${run.provider_status || 'queued'})`],
      ]))),
    h('div.card',
      h('div.card-head', h('h2', 'How this posts')),
      h('div.card-body',
        h('div.muted', { style: { fontSize: '12px', lineHeight: 1.6 } },
          'Dr Salaries & Wages (gross), Dr Employer Payroll Tax; Cr Employee Tax Withheld, Cr Employer Tax Payable, Cr Payroll Liabilities (net pay). ',
          'The net-pay liability clears when your provider confirms funding.'),
        h('div.tag.amber', { style: { marginTop: '10px' } }, 'Tax rates are configuration, not a statutory engine'))));

  return h('div.page',
    h('div.page-head',
      h('div.titles',
        h('div.breadcrumb', h('a', { href: '#/hr/payroll', onclick: (e) => { e.preventDefault(); go('/hr/payroll'); } }, 'Payroll')),
        h('h1', `Payroll ${run.run_no}`, statusTag(run.status)),
        h('div.page-sub', `${fmt.date(run.period_start)} – ${fmt.date(run.period_end)} · paid ${fmt.date(run.pay_date)}`)),
      h('div.page-actions', ...actions)),
    h('div.split', h('div.card', h('div.card-head', h('h2', 'Gross to net')), lines), side));
}
