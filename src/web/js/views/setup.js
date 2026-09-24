// Meridian ERP :: web/views/setup
// Administration: company, users, roles and permissions, the customisation
// engine (custom fields, workflows, pricing and approval rules), currencies
// and the integration outbox.
import { h, mount, clear } from '../dom.js';
import { icon } from '../icons.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import * as store from '../store.js';
import { empty, toast, notifyError, modal, confirm, formModal, statusTag, facts, loading, fieldControl } from '../ui.js';

const TABS = [
  { id: 'company', label: 'Company', perm: 'setup' },
  { id: 'users', label: 'Users', perm: 'app_user' },
  { id: 'roles', label: 'Roles & permissions', perm: 'role' },
  { id: 'fields', label: 'Custom fields', perm: 'custom_field' },
  { id: 'workflows', label: 'Workflows', perm: 'workflow' },
  { id: 'rules', label: 'Pricing & approvals', perm: 'pricing_rule' },
  { id: 'currencies', label: 'Currencies & rates', perm: 'exchange_rate' },
  { id: 'integrations', label: 'Integrations', perm: 'setup' },
];

export async function setupView(route, { go }) {
  const active = route.parts[1] || 'company';
  const visible = TABS.filter((t) => store.can(t.perm));
  const host = h('div');

  const tabs = h('div.tabs', ...visible.map((t) => h('button.tab', {
    class: t.id === active ? 'active' : '',
    onclick: () => go(`/setup/${t.id}`),
  }, t.label)));

  const renderers = { company: companyTab, users: usersTab, roles: rolesTab, fields: fieldsTab, workflows: workflowsTab, rules: rulesTab, currencies: currenciesTab, integrations: integrationsTab };
  const render = renderers[active] || companyTab;
  mount(host, loading());
  render(go).then((el) => mount(host, el)).catch((e) => mount(host, empty('Could not load', e.message)));

  return h('div.page',
    h('div.page-head', h('div.titles', h('h1', 'Setup'), h('div.page-sub', 'Configuration, security and the customisation engine'))),
    tabs, host);
}

// ------------------------------------------------------------- company
async function companyTab() {
  const c = await API.company();
  const counts = Object.entries(c.counts).map(([k, v]) => h('div.kpi',
    h('div.k-label', fmt.titleCase(k)),
    h('div.k-value.sm', fmt.num(v))));

  const subs = h('div.card',
    h('div.card-head', h('h2', 'Subsidiaries'), h('span.muted', { style: { fontSize: '12px' } }, `${c.subsidiaries.length}`)),
    h('div.grid-wrap', h('table.grid',
      h('thead', h('tr', h('th', 'Name'), h('th', 'Currency'), h('th', 'Country'), h('th', 'Parent'), h('th', 'Status'))),
      h('tbody', ...c.subsidiaries.map((s) => h('tr.clickable', { onclick: () => window.__meridianGo(`/record/subsidiary/${s.id}`) },
        h('td', h('strong', s.name)),
        h('td', s.currency),
        h('td.muted', s.country),
        h('td.muted', s.parent_id ? c.subsidiaries.find((x) => x.id === s.parent_id)?.name || '—' : '—'),
        h('td', s.active ? h('span.tag.green', 'Active') : h('span.tag', 'Inactive'))))))));

  const periods = h('div.card', { style: { marginTop: '14px' } },
    h('div.card-head', h('h2', 'Accounting periods'),
      h('div.actions', h('button.btn.sm', { onclick: () => window.__meridianGo('/periods') }, 'Manage'))),
    h('div.card-body',
      h('div.row.wrap', { style: { gap: '6px' } },
        ...c.periods.slice(0, 24).map((p) => h('span.tag', {
          class: p.status === 'open' ? 'green' : p.status === 'closed' ? '' : 'red',
        }, p.name)))));

  return h('div',
    h('div.card', { style: { marginBottom: '14px' } },
      h('div.card-head', h('h2', c.tenant.name)),
      h('div.card-body', facts([
        ['Company', c.tenant.name],
        ['Address', `${c.tenant.slug}`],
        ['Base currency', c.tenant.base_currency],
        ['Plan', fmt.titleCase(c.tenant.plan)],
        ['Data region', c.tenant.data_region],
        ['Created', fmt.date(c.tenant.created_at)],
      ]))),
    h('div.kpi-grid', { style: { marginBottom: '14px' } }, ...counts),
    subs, periods);
}

// --------------------------------------------------------------- users
async function usersTab(go) {
  const { users } = await API.users();
  const { roles } = await API.roles();

  const rows = users.map((u) => h('tr',
    h('td', h('div.row', { style: { gap: '8px' } },
      h('div.avatar', { style: { width: '24px', height: '24px', fontSize: '10px' } }, fmt.initials(u.name)),
      h('div', h('div', { style: { fontWeight: 500 } }, u.name), h('div.faint', { style: { fontSize: '11.5px' } }, u.email)))),
    h('td', u.is_owner ? h('span.tag.blue', 'Owner') : ''),
    h('td', h('div.row.wrap', { style: { gap: '4px' } }, ...u.roles.map((r) => h('span.tag', r.name)))),
    h('td', statusTag(u.status)),
    h('td.muted.nowrap', u.last_login_at ? fmt.relative(u.last_login_at) : 'Never'),
    h('td', { style: { textAlign: 'right' } },
      store.can('app_user', store.LEVEL.FULL) && !u.is_owner
        ? h('button.btn.sm', { onclick: () => editRoles(u, roles) }, 'Roles')
        : '')));

  function editRoles(user, allRoles) {
    const boxes = allRoles.map((r) => {
      const cb = h('input', { type: 'checkbox', checked: user.roles.some((x) => x.id === r.id) });
      return { id: r.id, cb, el: h('label', cb, h('span', r.name), h('span.faint', { style: { fontSize: '11px' } }, ` — ${r.description}`)) };
    });
    modal({
      title: `Roles for ${user.name}`,
      body: h('div', h('div.muted', { style: { marginBottom: '10px' } }, 'A user gets the union of their roles: the widest permission wins, and row-level restrictions relax accordingly.'),
        h('div', { style: { display: 'grid', gap: '4px' } }, ...boxes.map((b) => b.el))),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Save roles', kind: 'primary',
          onClick: async () => {
            await API.setUserRoles(user.id, boxes.filter((b) => b.cb.checked).map((b) => b.id));
            toast('Roles updated', { kind: 'success' });
            window.location.reload();
          },
        },
      ],
    });
  }

  function newUser() {
    const roleBoxes = roles.map((r) => {
      const cb = h('input', { type: 'checkbox' });
      return { id: r.id, cb, el: h('label', cb, h('span', r.name)) };
    });
    const name = h('input', { type: 'text' });
    const email = h('input', { type: 'email' });
    const password = h('input', { type: 'text', placeholder: 'At least 10 characters' });
    modal({
      title: 'Invite a user',
      body: h('div',
        h('div.form-grid',
          h('div.field', h('label', 'Full name'), name),
          h('div.field', h('label', 'Email'), email),
          h('div.field.full', h('label', 'Initial password'), password,
            h('div.help', 'The user should change this after their first sign-in.'))),
        h('div.form-section', h('h3', 'Roles'), h('div', { style: { display: 'grid', gap: '4px' } }, ...roleBoxes.map((b) => b.el)))),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Create user', kind: 'primary',
          onClick: async () => {
            await API.createUser({
              name: name.value, email: email.value, password: password.value,
              role_ids: roleBoxes.filter((b) => b.cb.checked).map((b) => b.id),
            });
            toast('User created', { kind: 'success' });
            window.location.reload();
          },
        },
      ],
    });
  }

  return h('div.card',
    h('div.card-head', h('h2', 'Users'), h('span.muted', { style: { fontSize: '12px' } }, `${users.length}`),
      h('div.actions', store.can('app_user', store.LEVEL.CREATE) && h('button.btn.sm.primary', { onclick: newUser }, icon('plus', { size: 14 }), 'Invite user'))),
    h('div.grid-wrap', h('table.grid',
      h('thead', h('tr', h('th', 'User'), h('th', ''), h('th', 'Roles'), h('th', 'Status'), h('th', 'Last seen'), h('th', ''))),
      h('tbody', ...rows))));
}

// --------------------------------------------------------------- roles
async function rolesTab() {
  const { roles, record_types, levels } = await API.roles();
  let current = roles[0];
  const detail = h('div');

  const list = h('div.card', { style: { maxWidth: '280px' } },
    h('div.card-head', h('h2', 'Roles')),
    h('div', ...roles.map((r) => h('div.nav-item', {
      onclick: () => { current = r; drawDetail(); },
      style: { padding: '9px 13px', borderLeft: '2px solid transparent' },
    },
      h('div', { style: { minWidth: 0 } },
        h('div', { style: { fontWeight: 500, color: 'var(--text)' } }, r.name),
        h('div.faint', { style: { fontSize: '11.5px', whiteSpace: 'normal' } }, r.description)),
      h('span.count', String(r.user_count))))));

  function drawDetail() {
    const selects = {};
    const groups = Object.entries(record_types).map(([group, types]) => {
      const rows = types.map((t) => {
        const sel = h('select', { disabled: current.name === 'Administrator' },
          ...levels.map((l, i) => h('option', { value: i, selected: (current.permissions[t] || 0) === i }, l)));
        selects[t] = sel;
        return h('tr', h('td', fmt.titleCase(t)), h('td', { style: { width: '130px' } }, sel));
      });
      return h('div', { style: { marginBottom: '14px' } },
        h('h3', { style: { fontSize: '11.5px', textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text-faint)', marginBottom: '5px' } }, group),
        h('table.perm-grid', h('tbody', ...rows)));
    });

    const restrictionNotes = current.restrictions.map((r) => h('div.tag.amber', { style: { marginRight: '5px' } },
      r.own_only ? 'Own records only' : `${r.dimension}: ${(r.allowed || []).length || 'all'}`));

    mount(detail, h('div.card',
      h('div.card-head', h('h2', current.name),
        current.is_system ? h('span.tag', 'Built-in') : null,
        h('div.actions',
          store.can('role', store.LEVEL.FULL) && current.name !== 'Administrator'
            ? h('button.btn.sm.primary', {
              onclick: async (e) => {
                e.currentTarget.disabled = true;
                const permissions = Object.fromEntries(Object.entries(selects).map(([t, s]) => [t, Number(s.value)]));
                try {
                  await API.saveRolePermissions(current.id, permissions);
                  toast(`${current.name} permissions saved`, { kind: 'success' });
                } catch (err) { notifyError(err); }
                e.currentTarget.disabled = false;
              },
            }, 'Save permissions')
            : null)),
      h('div.card-body',
        h('div.muted', { style: { marginBottom: '12px' } }, current.description),
        restrictionNotes.length ? h('div.row.wrap', { style: { marginBottom: '14px' } }, h('span.muted', { style: { fontSize: '12px', marginRight: '6px' } }, 'Row-level:'), ...restrictionNotes) : null,
        current.name === 'Administrator'
          ? h('div.tag.blue', 'The Administrator role always has full access and cannot be narrowed.')
          : null,
        h('div', { style: { columnCount: 2, columnGap: '24px' } }, ...groups))));
  }

  drawDetail();
  return h('div', { style: { display: 'grid', gridTemplateColumns: '280px 1fr', gap: '14px', alignItems: 'start' } }, list, detail);
}

// -------------------------------------------------------- custom fields
async function fieldsTab() {
  const res = await API.list('custom_field', { limit: 300, sort: 'record_type ASC' });
  const rows = res.rows || [];
  const recordTypes = Object.keys(store.state.meta.records).sort();

  const table = rows.length
    ? h('div.grid-wrap', h('table.grid',
      h('thead', h('tr', h('th', 'Record'), h('th', 'Label'), h('th', 'Name'), h('th', 'Type'), h('th', 'Formula'), h('th', 'Required'), h('th', 'In lists'), h('th', 'Status'))),
      h('tbody', ...rows.map((f) => h('tr.clickable', { onclick: () => window.__meridianGo(`/record/custom_field/${f.id}`) },
        h('td.muted', fmt.titleCase(f.record_type)),
        h('td', h('strong', f.label)),
        h('td', h('span.mono', f.name)),
        h('td', h('span.tag', fmt.titleCase(f.type))),
        h('td', f.formula ? h('span.mono', { style: { fontSize: '11px' } }, f.formula) : h('span.faint', '—')),
        h('td', f.required ? h('span.tag.amber', 'Yes') : h('span.faint', 'No')),
        h('td', f.show_in_list ? 'Yes' : h('span.faint', 'No')),
        h('td', f.active ? h('span.tag.green', 'Active') : h('span.tag', 'Inactive')))))))
    : empty('No custom fields yet', 'Add a field to any record type — it appears on the form, in list columns, in saved searches and in the API.');

  function newField() {
    formModal({
      title: 'New custom field',
      fields: [
        { name: 'record_type', label: 'Applies to', type: 'select', required: true, options: recordTypes.map((t) => ({ value: t, label: store.metaFor(t).label })) },
        { name: 'label', label: 'Label', type: 'text', required: true },
        { name: 'name', label: 'Field name', type: 'text', required: true, help: 'Lowercase letters, digits and underscores. Cannot be changed later.' },
        { name: 'type', label: 'Type', type: 'select', required: true, options: ['text', 'longtext', 'number', 'money', 'date', 'checkbox', 'select', 'multiselect', 'formula'] },
        { name: 'options_csv', label: 'Options', type: 'text', help: 'Comma-separated, for select fields.' },
        { name: 'formula', label: 'Formula', type: 'formula', full: true, help: 'For formula fields, e.g. IF(probability >= 70, "Strong", "At risk")' },
        { name: 'help_text', label: 'Help text', type: 'text', full: true },
        { name: 'required', label: 'Required', type: 'checkbox' },
        { name: 'show_in_list', label: 'Available as a list column', type: 'checkbox' },
      ],
      submitLabel: 'Create field',
      onSubmit: async (m) => {
        await API.create('custom_field', {
          ...m,
          options: m.options_csv ? String(m.options_csv).split(',').map((s) => s.trim()).filter(Boolean) : [],
        });
        toast('Custom field created', { kind: 'success' });
        window.location.reload();
      },
    });
  }

  return h('div.card',
    h('div.card-head',
      h('h2', 'Custom fields'),
      h('span.muted', { style: { fontSize: '12px' } }, 'Extend any record without a schema change'),
      h('div.actions', store.can('custom_field', store.LEVEL.CREATE) && h('button.btn.sm.primary', { onclick: newField }, icon('plus', { size: 13 }), 'New field'))),
    table);
}

// ----------------------------------------------------------- workflows
async function workflowsTab() {
  const res = await API.list('workflow', { limit: 200 });
  const rows = res.rows || [];
  const recordTypes = Object.keys(store.state.meta.records).sort();

  const table = rows.length
    ? h('div.grid-wrap', h('table.grid',
      h('thead', h('tr', h('th', 'Name'), h('th', 'Record'), h('th', 'Trigger'), h('th', 'Condition'), h('th', 'Status'), h('th.num', 'Runs'))),
      h('tbody', ...rows.map((w) => h('tr.clickable', { onclick: () => window.__meridianGo(`/record/workflow/${w.id}`) },
        h('td', h('strong', w.name)),
        h('td.muted', fmt.titleCase(w.record_type)),
        h('td', h('span.tag', fmt.titleCase(w.trigger))),
        h('td', h('span.mono', { style: { fontSize: '11px' } }, w.condition || 'always')),
        h('td', statusTag(w.status)),
        h('td.num.muted', String(w.run_count)))))))
    : empty('No workflows yet', 'Automate approvals, notifications and field updates without writing code.');

  function newWorkflow() {
    const actionsHost = h('div');
    const actionList = [];
    const drawActions = () => {
      clear(actionsHost);
      actionList.forEach((a, i) => {
        const typeSel = h('select', { onchange: (e) => { a.type = e.target.value; } },
          ...Object.entries(store.state.meta.action_types).map(([k, v]) => h('option', { value: k, selected: k === a.type }, v.label)));
        const p1 = h('input', { placeholder: 'Title / field / message', value: a.p1 || '', oninput: (e) => { a.p1 = e.target.value; } });
        const p2 = h('input', { placeholder: 'Value (prefix with = for an expression)', value: a.p2 || '', oninput: (e) => { a.p2 = e.target.value; } });
        actionsHost.appendChild(h('div.filter-row', typeSel, p1, p2,
          h('button.btn.sm.ghost', { onclick: () => { actionList.splice(i, 1); drawActions(); } }, icon('x', { size: 13 }))));
      });
      if (!actionList.length) actionsHost.appendChild(h('div.muted', { style: { padding: '6px 0' } }, 'Add at least one action.'));
    };
    drawActions();

    const name = h('input', { type: 'text' });
    const recordSel = h('select', ...recordTypes.map((t) => h('option', { value: t }, store.metaFor(t).label)));
    const triggerSel = h('select', ...store.state.meta.workflow_triggers.map((t) => h('option', { value: t }, fmt.titleCase(t))));
    const condition = h('input', { type: 'text', class: 'mono', placeholder: 'e.g. total > 50000 && status == "open"' });
    const conditionNote = h('div.help', 'Leave blank to run on every save.');
    const statusSel = h('select', h('option', { value: 'released' }, 'Released'), h('option', { value: 'draft' }, 'Draft'));

    condition.addEventListener('blur', async () => {
      if (!condition.value.trim()) { conditionNote.textContent = 'Leave blank to run on every save.'; conditionNote.className = 'help'; return; }
      try {
        const v = await API.validateExpression(condition.value);
        conditionNote.textContent = v.ok ? 'Valid expression.' : v.error;
        conditionNote.className = v.ok ? 'help' : 'err';
      } catch { /* validation is advisory */ }
    });

    modal({
      title: 'New workflow', size: 'wide',
      body: h('div',
        h('div.form-grid',
          h('div.field', h('label', 'Name'), name),
          h('div.field', h('label', 'Record type'), recordSel),
          h('div.field', h('label', 'Trigger'), triggerSel),
          h('div.field', h('label', 'Status'), statusSel),
          h('div.field.full', h('label', 'Condition'), condition, conditionNote)),
        h('div.form-section',
          h('h3', 'Actions'),
          actionsHost,
          h('button.btn.sm', { style: { marginTop: '8px' }, onclick: () => { actionList.push({ type: 'notify' }); drawActions(); } }, icon('plus', { size: 13 }), 'Add action'))),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Create workflow', kind: 'primary',
          onClick: async () => {
            const actions = actionList.map((a) => {
              const base = { type: a.type };
              if (a.type === 'set_field') return { ...base, field: a.p1, value: a.p2 };
              if (a.type === 'block') return { ...base, message: a.p1 };
              if (a.type === 'create_task') return { ...base, subject: a.p1, due_in_days: Number(a.p2) || 3 };
              if (a.type === 'notify') return { ...base, title: a.p1, body: a.p2 };
              if (a.type === 'webhook') return { ...base, url: a.p1, event_type: a.p2 };
              return { ...base, message: a.p1 };
            });
            await API.create('workflow', {
              name: name.value, record_type: recordSel.value, trigger: triggerSel.value,
              condition: condition.value, status: statusSel.value, actions,
            });
            toast('Workflow created', { kind: 'success' });
            window.location.reload();
          },
        },
      ],
    });
  }

  const explainer = h('div.card', { style: { marginBottom: '14px' } },
    h('div.card-body',
      h('div.muted', { style: { fontSize: '12.5px', lineHeight: 1.6, maxWidth: '760px' } },
        'Workflows are declarative: a trigger, a condition written in Meridian’s expression language, and a list of actions. ',
        'They run inside the same database transaction as the record that fired them, so a workflow that blocks a save really does prevent it. ',
        'Conditions are evaluated by a sandboxed interpreter — no tenant-authored JavaScript runs on the server.')));

  return h('div',
    explainer,
    h('div.card',
      h('div.card-head', h('h2', 'Workflows'), h('span.muted', { style: { fontSize: '12px' } }, `${rows.length}`),
        h('div.actions', store.can('workflow', store.LEVEL.CREATE) && h('button.btn.sm.primary', { onclick: newWorkflow }, icon('plus', { size: 14 }), 'New workflow'))),
      table));
}

// ------------------------------------------------------ pricing/approval
async function rulesTab() {
  const [pricing, approvals] = await Promise.all([
    API.list('pricing_rule', { limit: 200, sort: 'priority ASC' }),
    API.list('approval_rule', { limit: 200, sort: 'sequence ASC' }),
  ]);

  const pricingTable = h('div.card', { style: { marginBottom: '14px' } },
    h('div.card-head', h('h2', 'Pricing rules'),
      h('span.muted', { style: { fontSize: '12px' } }, 'Evaluated in priority order; a non-stackable match wins outright'),
      h('div.actions', store.can('pricing_rule', store.LEVEL.CREATE) && h('button.btn.sm', { onclick: () => window.__meridianGo('/new/pricing_rule') }, icon('plus', { size: 13 }), 'New rule'))),
    pricing.rows.length
      ? h('div.grid-wrap', h('table.grid',
        h('thead', h('tr', h('th.num', 'Priority'), h('th', 'Name'), h('th', 'Condition'), h('th', 'Action'), h('th.num', 'Value'), h('th', 'Stackable'), h('th', 'Status'))),
        h('tbody', ...pricing.rows.map((r) => h('tr.clickable', { onclick: () => window.__meridianGo(`/record/pricing_rule/${r.id}`) },
          h('td.num.muted', String(r.priority)),
          h('td', h('strong', r.name)),
          h('td', h('span.mono', { style: { fontSize: '11px' } }, r.condition || 'always')),
          h('td.muted', fmt.titleCase(r.action)),
          h('td.num', r.action === 'fixed_price' ? fmt.money(r.value * 100) : `${r.value}%`),
          h('td', r.stackable ? 'Yes' : h('span.faint', 'No')),
          h('td', r.active ? h('span.tag.green', 'Active') : h('span.tag', 'Off')))))))
      : empty('No pricing rules', 'Volume breaks and segment discounts go here.'));

  const approvalTable = h('div.card',
    h('div.card-head', h('h2', 'Approval rules'),
      h('span.muted', { style: { fontSize: '12px' } }, 'The first matching rule routes the document for approval'),
      h('div.actions', store.can('setup', store.LEVEL.CREATE) && h('button.btn.sm', { onclick: () => window.__meridianGo('/new/approval_rule') }, icon('plus', { size: 13 }), 'New rule'))),
    approvals.rows.length
      ? h('div.grid-wrap', h('table.grid',
        h('thead', h('tr', h('th.num', 'Seq'), h('th', 'Name'), h('th', 'Applies to'), h('th', 'Condition'), h('th', 'Status'))),
        h('tbody', ...approvals.rows.map((r) => h('tr.clickable', { onclick: () => window.__meridianGo(`/record/approval_rule/${r.id}`) },
          h('td.num.muted', String(r.sequence)),
          h('td', h('strong', r.name)),
          h('td.muted', fmt.titleCase(r.txn_type.replace(/_/g, ' ').toLowerCase())),
          h('td', h('span.mono', { style: { fontSize: '11px' } }, r.condition || 'always')),
          h('td', r.active ? h('span.tag.green', 'Active') : h('span.tag', 'Off')))))))
      : empty('No approval rules', 'Without a rule, documents post straight through.'));

  return h('div', pricingTable, approvalTable);
}

// ----------------------------------------------------------- currencies
async function currenciesTab() {
  const [company, rates] = await Promise.all([API.company(), API.rates()]);

  const currencyTable = h('div.card', { style: { marginBottom: '14px' } },
    h('div.card-head', h('h2', 'Currencies')),
    h('div.grid-wrap', h('table.grid',
      h('thead', h('tr', h('th', 'Code'), h('th', 'Name'), h('th', 'Symbol'), h('th.num', 'Precision'), h('th', 'Status'))),
      h('tbody', ...company.currencies.map((c) => h('tr',
        h('td', h('strong.mono', c.code), c.code === company.tenant.base_currency ? h('span.tag.blue', { style: { marginLeft: '6px' } }, 'Base') : null),
        h('td', c.name),
        h('td', c.symbol),
        h('td.num.muted', String(c.precision)),
        h('td', c.active ? h('span.tag.green', 'Active') : h('span.tag', 'Off'))))))));

  const rateRows = rates.map((r) => h('tr',
    h('td', h('span.mono', `${r.from_currency} → ${r.to_currency}`)),
    h('td', fmt.date(r.rate_date)),
    h('td.num.mono', r.rate.toFixed(6)),
    h('td.muted', r.source)));

  function addRate() {
    formModal({
      title: 'Add an exchange rate',
      fields: [
        { name: 'from_currency', label: 'From', type: 'select', required: true, options: company.currencies.map((c) => c.code) },
        { name: 'to_currency', label: 'To', type: 'select', required: true, options: company.currencies.map((c) => c.code) },
        { name: 'rate_date', label: 'Effective date', type: 'date', required: true },
        { name: 'rate', label: 'Rate', type: 'number', required: true },
      ],
      values: { to_currency: company.tenant.base_currency, rate_date: fmt.today() },
      submitLabel: 'Add rate',
      onSubmit: async (m) => {
        await API.addRate(m);
        toast('Rate added', { kind: 'success' });
        window.location.reload();
      },
    });
  }

  const rateTable = h('div.card',
    h('div.card-head', h('h2', 'Exchange rates'),
      h('span.muted', { style: { fontSize: '12px' } }, 'A posting uses the most recent rate on or before its date'),
      h('div.actions', store.can('exchange_rate', store.LEVEL.CREATE) && h('button.btn.sm.primary', { onclick: addRate }, icon('plus', { size: 13 }), 'Add rate'))),
    rates.length
      ? h('div.grid-wrap', h('table.grid',
        h('thead', h('tr', h('th', 'Pair'), h('th', 'Date'), h('th.num', 'Rate'), h('th', 'Source'))),
        h('tbody', ...rateRows)))
      : empty('No exchange rates', 'Add one before posting in a foreign currency.'));

  return h('div', currencyTable, rateTable);
}

// --------------------------------------------------------- integrations
async function integrationsTab() {
  const { rows } = await API.integrationEvents();

  const table = rows.length
    ? h('div.grid-wrap', h('table.grid',
      h('thead', h('tr', h('th', 'Created'), h('th', 'Channel'), h('th', 'Event'), h('th', 'Record'), h('th', 'Status'), h('th.num', 'Attempts'), h('th', 'Target'))),
      h('tbody', ...rows.map((e) => h('tr',
        h('td.nowrap', fmt.dateTime(e.created_at)),
        h('td', h('span.tag', fmt.titleCase(e.channel))),
        h('td', h('span.mono', { style: { fontSize: '11.5px' } }, e.event_type)),
        h('td.muted', fmt.titleCase(e.record_type || '—')),
        h('td', statusTag(e.status)),
        h('td.num.muted', String(e.attempts)),
        h('td.faint', { style: { fontSize: '11.5px' } }, e.target_url || '—')))))) 
    : empty('Nothing queued', 'Payroll exports and workflow webhooks appear here before they are delivered.');

  const explainer = h('div.card', { style: { marginBottom: '14px' } },
    h('div.card-body',
      h('h3', { style: { marginBottom: '6px' } }, 'Outbound integration queue'),
      h('div.muted', { style: { fontSize: '12.5px', lineHeight: 1.6, maxWidth: '760px' } },
        'Meridian never calls a third party from inside a ledger transaction — a slow or unreachable provider must not be able to hold a posting open or roll one back. ',
        'Payroll submissions and workflow webhooks are written to this outbox in the same transaction as the business record, then delivered separately. ',
        'That makes retries idempotent and gives you an audit trail of what was sent and when.'),
      h('div.tag.blue', { style: { marginTop: '10px' } }, `Server scripts: ${store.state.meta.scripts_enabled ? 'enabled' : 'disabled (recommended)'}`)));

  return h('div', explainer, h('div.card', h('div.card-head', h('h2', 'Delivery log')), table));
}
