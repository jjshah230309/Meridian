// Meridian ERP :: web/views/flowdesigner
// A visual editor for both kinds of automation setup.js used to build
// through a single cramped modal: workflows (trigger -> condition -> yes/no
// action branches) and approval chains (condition -> a sequence of steps,
// each optionally naming who has to clear it). Drawn as a vertical flow --
// one card per stage, connected by a line -- rather than a form.
import { h, mount, clear } from '../dom.js';
import { icon } from '../icons.js';
import { svgEl } from '../charts.js';
import { API } from '../api.js';
import * as fmt from '../format.js';
import * as store from '../store.js';
import { toast, notifyError, modal } from '../ui.js';

const connector = () => svgEl('svg', { class: 'flow-connector', viewBox: '0 0 24 28', width: 24, height: 28 },
  svgEl('line', { x1: 12, y1: 0, x2: 12, y2: 22, stroke: 'var(--border-strong)', 'stroke-width': 2 }),
  svgEl('path', { d: 'M6 16 L12 24 L18 16', fill: 'none', stroke: 'var(--border-strong)', 'stroke-width': 2 }));

function stage(label, ...content) {
  return h('div',
    h('div.card', h('div.card-head', h('h2', { style: { fontSize: '13px' } }, label)), h('div.card-body', ...content)),
    h('div', { style: { display: 'flex', justifyContent: 'center' } }, connector()));
}

function conditionField(value, onChange, { placeholder = 'e.g. total > 50000', onValidate = null } = {}) {
  const input = h('textarea', { rows: 2, class: 'mono', placeholder, style: { width: '100%' }, value }, );
  input.value = value || '';
  const note = h('div.help', 'Leave blank to always match.');
  input.addEventListener('input', () => onChange(input.value));
  input.addEventListener('blur', async () => {
    onChange(input.value);
    if (!input.value.trim()) { note.textContent = 'Leave blank to always match.'; note.className = 'help'; return; }
    try {
      const v = await API.validateExpression(input.value);
      note.textContent = v.ok ? 'Valid.' : v.error;
      note.className = v.ok ? 'help' : 'err';
    } catch { /* advisory only */ }
    onValidate?.();
  });
  return h('div', input, note);
}

function actionParamInputs(action, actionTypes) {
  const spec = actionTypes[action.type];
  if (!spec) return [];
  const labels = {
    field: 'Field name', value: 'Value (prefix = for an expression)', message: 'Message',
    subject: 'Subject', due_in_days: 'Due in (days)', assign_to: 'Assign to (user id, or "owner")',
    title: 'Title', body: 'Body', user: 'Notify (user id, or "owner")', severity: 'Severity',
    url: 'Webhook URL', event_type: 'Event type',
  };
  return spec.params.map((p) => h('input', {
    placeholder: labels[p] || p, value: action[p] || '',
    oninput: (e) => { action[p] = e.target.value; },
  }));
}

function actionRow(action, actionTypes, onRemove, onType) {
  const typeSel = h('select', { onchange: (e) => { action.type = e.target.value; onType(); } },
    ...Object.entries(actionTypes).map(([k, v]) => h('option', { value: k, selected: k === action.type }, v.label)));
  const row = h('div.filter-row', typeSel, ...actionParamInputs(action, actionTypes),
    h('button.btn.sm.icon-only', { onclick: onRemove }, icon('x', { size: 13 })));
  return row;
}

function actionsEditor(list, actionTypes, redraw) {
  const host = h('div');
  function draw() {
    clear(host);
    mount(host, ...list.map((a, i) => actionRow(a, actionTypes, () => { list.splice(i, 1); draw(); redraw(); }, () => { draw(); redraw(); })));
    if (!list.length) host.appendChild(h('div.muted', { style: { padding: '4px 0', fontSize: '12px' } }, 'No actions.'));
  }
  draw();
  return {
    el: h('div', host, h('button.btn.sm', { style: { marginTop: '6px' }, onclick: () => { list.push({ type: Object.keys(actionTypes)[0] }); draw(); redraw(); } }, icon('plus', { size: 13 }), 'Add action')),
  };
}

// ============================================================== workflow
async function workflowDesigner(id, { go }) {
  const meta = store.state.meta;
  const recordTypes = Object.keys(meta.records).sort();
  const existing = id ? (await API.record('workflow', id)).record : null;

  const state = {
    name: existing?.name || '', description: existing?.description || '',
    record_type: existing?.record_type || recordTypes[0],
    trigger: existing?.trigger || meta.workflow_triggers[0],
    condition: existing?.condition || '',
    status: existing?.status || 'draft',
    actions: existing?.actions ? existing.actions.map((a) => ({ ...a })) : [],
    else_actions: existing?.else_actions ? existing.else_actions.map((a) => ({ ...a })) : [],
  };

  const nameInput = h('input', { value: state.name, oninput: (e) => { state.name = e.target.value; } });
  const recordSel = h('select', { onchange: (e) => { state.record_type = e.target.value; } },
    ...recordTypes.map((t) => h('option', { value: t, selected: t === state.record_type }, store.metaFor(t).label)));
  const triggerSel = h('select', { onchange: (e) => { state.trigger = e.target.value; } },
    ...meta.workflow_triggers.map((t) => h('option', { value: t, selected: t === state.trigger }, fmt.titleCase(t))));
  const statusSel = h('select', { onchange: (e) => { state.status = e.target.value; } },
    ...['draft', 'released', 'paused'].map((s) => h('option', { value: s, selected: s === state.status }, fmt.titleCase(s))));

  const yesHost = h('div');
  const noHost = h('div');
  function drawBranches() {
    clear(yesHost); clear(noHost);
    mount(yesHost, actionsEditor(state.actions, meta.action_types, () => {}).el);
    mount(noHost, actionsEditor(state.else_actions, meta.action_types, () => {}).el);
  }
  drawBranches();

  async function save() {
    if (!state.name.trim()) { toast('Enter a name', { kind: 'warn' }); return; }
    if (!state.actions.length && !state.else_actions.length) { toast('Add at least one action on the Yes or No branch', { kind: 'warn' }); return; }
    try {
      const body = { ...state };
      const saved = id ? await API.update('workflow', id, body) : await API.create('workflow', body);
      toast('Workflow saved', { kind: 'success' });
      go(`/flow/workflow/${saved.id}`);
    } catch (e) { notifyError(e); }
  }

  const testHost = h('div');
  async function runTest() {
    if (!id) { toast('Save the workflow first', { kind: 'warn' }); return; }
    const recId = testIdInput.value.trim();
    if (!recId) return;
    try {
      const r = await API.testWorkflow(id, recId);
      mount(testHost,
        h('div.tag', { class: r.matched ? 'green' : '' }, r.matched ? 'Condition matched' : 'Condition did not match'),
        r.error && h('div.err', r.error),
        r.would_run.length ? h('ul', ...r.would_run.map((a) => h('li', a.label))) : h('div.muted', 'No actions would run.'));
    } catch (e) { mount(testHost, h('div.err', e.message)); }
  }
  const testIdInput = h('input', { placeholder: `${store.metaFor(state.record_type).label} id` });

  return h('div.page',
    h('div.page-head',
      h('div.titles', h('h1', existing ? existing.name : 'New workflow'), h('div.page-sub', 'Trigger → condition → what happens, drawn as a flow.')),
      h('div.page-actions', h('button.btn.sm.primary', { onclick: save }, 'Save'), h('button.btn.sm', { onclick: () => go('/setup/workflows') }, 'Close'))),
    h('div', { style: { maxWidth: '620px' } },
      stage('Trigger',
        h('div.form-grid',
          h('div.field', h('label', 'Name'), nameInput),
          h('div.field', h('label', 'Status'), statusSel),
          h('div.field', h('label', 'Record type'), recordSel),
          h('div.field', h('label', 'Event'), triggerSel))),
      stage('Condition', conditionField(state.condition, (v) => { state.condition = v; })),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' } },
        h('div.card', h('div.card-head', h('h2', { style: { fontSize: '13px' } }, '✓ Yes')), h('div.card-body', yesHost)),
        h('div.card', h('div.card-head', h('h2', { style: { fontSize: '13px' } }, '✕ No')), h('div.card-body', noHost))),
      existing && h('div.card', { style: { marginTop: '14px' } },
        h('div.card-head', h('h2', { style: { fontSize: '13px' } }, 'Test against a record')),
        h('div.card-body', h('div.row', { style: { gap: '6px' } }, testIdInput, h('button.btn.sm', { onclick: runTest }, 'Run')), testHost))));
}

// ============================================================== approval
function approverPicker(step, roles, users, redraw) {
  const kind = step.approver_user_id ? 'user' : step.approver_role_id ? 'role' : 'anyone';
  const kindSel = h('select', {
    onchange: (e) => {
      step.approver_role_id = null; step.approver_user_id = null;
      if (e.target.value === 'role') step.approver_role_id = roles[0]?.id || null;
      if (e.target.value === 'user') step.approver_user_id = users[0]?.id || null;
      redraw();
    },
  },
    h('option', { value: 'anyone', selected: kind === 'anyone' }, 'Anyone with full access'),
    h('option', { value: 'role', selected: kind === 'role' }, 'Someone in a role'),
    h('option', { value: 'user', selected: kind === 'user' }, 'A specific person'));
  const detail = kind === 'role'
    ? h('select', { onchange: (e) => { step.approver_role_id = e.target.value; } }, ...roles.map((r) => h('option', { value: r.id, selected: r.id === step.approver_role_id }, r.name)))
    : kind === 'user'
      ? h('select', { onchange: (e) => { step.approver_user_id = e.target.value; } }, ...users.map((u) => h('option', { value: u.id, selected: u.id === step.approver_user_id }, `${u.name} (${u.email})`)))
      : null;
  return h('div.row', { style: { gap: '6px' } }, kindSel, detail);
}

async function approvalDesigner(id, { go }) {
  const meta = store.state.meta;
  const txnTypes = Object.keys(meta.txn_types || {});
  const [existing, roles, users] = await Promise.all([
    id ? API.record('approval_rule', id).then((r) => r.record) : null,
    API.roles().then((r) => r.roles), API.users().then((r) => r.users || r.rows || r),
  ]);

  const state = {
    name: existing?.name || '', txn_type: existing?.txn_type || txnTypes[0],
    condition: existing?.condition || '', sequence: existing?.sequence || 1,
    active: existing ? !!existing.active : true,
    steps: existing?.steps?.length ? existing.steps.map((s) => ({ ...s })) : [{ approver_role_id: null, approver_user_id: null, condition: '' }],
  };

  const nameInput = h('input', { value: state.name, oninput: (e) => { state.name = e.target.value; } });
  const typeSel = h('select', { onchange: (e) => { state.txn_type = e.target.value; } },
    ...txnTypes.map((t) => h('option', { value: t, selected: t === state.txn_type }, meta.txn_types[t].label)));
  const activeCheck = h('input', { type: 'checkbox', checked: state.active, onchange: (e) => { state.active = e.target.checked; } });

  const stepsHost = h('div');
  function drawSteps() {
    clear(stepsHost);
    const cards = state.steps.map((step, i) => h('div',
      i > 0 ? h('div', { style: { display: 'flex', justifyContent: 'center' } }, connector()) : null,
      h('div.card',
        h('div.card-head', h('h2', { style: { fontSize: '13px' } }, `Step ${i + 1}`),
          h('div.actions', state.steps.length > 1 && h('button.btn.sm.icon-only', { onclick: () => { state.steps.splice(i, 1); drawSteps(); } }, icon('x', { size: 13 })))),
        h('div.card-body',
          approverPicker(step, roles, users, drawSteps),
          h('div', { style: { marginTop: '8px' } },
            h('div.help', { style: { marginBottom: '4px' } }, 'Only required when true (e.g. total > 50000). Leave blank to always require this step.'),
            conditionField(step.condition, (v) => { step.condition = v; }, { placeholder: 'Optional step condition' }))))));
    mount(stepsHost, ...cards,
      h('div', { style: { display: 'flex', justifyContent: 'center' } }, connector()),
      h('div', { style: { display: 'flex', justifyContent: 'center' } },
        h('button.btn.sm', { onclick: () => { state.steps.push({ approver_role_id: null, approver_user_id: null, condition: '' }); drawSteps(); } }, icon('plus', { size: 13 }), 'Add step')));
  }
  drawSteps();

  async function save() {
    if (!state.name.trim()) { toast('Enter a name', { kind: 'warn' }); return; }
    try {
      const body = { name: state.name, txn_type: state.txn_type, condition: state.condition, sequence: state.sequence, active: state.active, steps: state.steps };
      const saved = id ? await API.update('approval_rule', id, body) : await API.create('approval_rule', body);
      toast('Approval rule saved', { kind: 'success' });
      go(`/flow/approval/${saved.id}`);
    } catch (e) { notifyError(e); }
  }

  return h('div.page',
    h('div.page-head',
      h('div.titles', h('h1', existing ? existing.name : 'New approval rule'), h('div.page-sub', 'The first matching rule (by sequence) routes a document through its chain of steps in order.')),
      h('div.page-actions', h('button.btn.sm.primary', { onclick: save }, 'Save'), h('button.btn.sm', { onclick: () => go('/setup/rules') }, 'Close'))),
    h('div', { style: { maxWidth: '620px' } },
      stage('When',
        h('div.form-grid',
          h('div.field', h('label', 'Name'), nameInput),
          h('div.field', h('label', 'Applies to'), typeSel),
          h('div.field', h('label', 'Sequence'), h('input', { type: 'number', value: state.sequence, oninput: (e) => { state.sequence = Number(e.target.value) || 1; } })),
          h('div.field', h('label', 'Active'), activeCheck),
          h('div.field.full', h('label', 'Condition'), conditionField(state.condition, (v) => { state.condition = v; }))),
      ),
      h('div.card', h('div.card-head', h('h2', { style: { fontSize: '13px' } }, 'Then, in order')), h('div.card-body', stepsHost))));
}

export async function flowDesignerView(route, { go }) {
  const kind = route.parts[1]; // workflow | approval
  const id = route.parts[2] === 'new' ? null : route.parts[2];
  if (kind === 'workflow') return workflowDesigner(id, { go });
  if (kind === 'approval') return approvalDesigner(id, { go });
  return h('div.page', h('div.card', h('div.card-body', 'Unknown flow type.')));
}
