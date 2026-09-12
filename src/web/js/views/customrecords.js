// Meridian ERP :: web/views/customrecords
// Records the product does not know about.
//
// This screen defines the types. The records themselves are then listed,
// edited, searched, imported and exported by exactly the same screens that
// handle customers and invoices — which is the whole point, and the reason
// there is nothing here for viewing the data itself.
import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { API } from '../api.js';
import * as store from '../store.js';
import { empty, notifyError, notifyOk, loading, modal, facts, confirm, fieldControl } from '../ui.js';

const FIELD_TYPES = [
  ['text', 'Text'],
  ['longtext', 'Long text'],
  ['number', 'Number'],
  ['money', 'Money'],
  ['date', 'Date'],
  ['checkbox', 'Yes / no'],
  ['select', 'Choice from a list'],
  ['reference', 'A link to another record'],
  ['formula', 'Worked out from other fields'],
];
const TYPE_LABEL = Object.fromEntries(FIELD_TYPES);

export async function customRecordsView(route, { go }) {
  if (!store.can('custom_record_type')) {
    return h('div.page', empty('Not permitted', 'Your role cannot define record types.'));
  }
  const canEdit = store.can('custom_record_type', store.LEVEL.EDIT);
  const canCreate = store.can('custom_record_type', store.LEVEL.CREATE);
  const canDelete = store.can('custom_record_type', store.LEVEL.FULL);
  const openName = route.parts[1] || null;

  const host = h('div');
  const head = h('div');

  async function load() {
    mount(host, loading('Reading the record types'));
    try {
      if (openName) { renderOne(await API.customRecordType(openName)); return; }
      renderIndex(await API.customRecordTypes());
    } catch (e) { mount(host, empty('Could not open record types', e.message)); }
  }

  // ------------------------------------------------------------- index
  function renderIndex(data) {
    mount(head,
      h('div.titles',
        h('h1', 'Custom Records'),
        h('div.page-sub', 'Registers this company keeps that an ERP has never heard of — and which behave like everything else once defined')),
      h('div.page-actions',
        canCreate ? h('button.btn.primary', { onclick: () => typeDialog(null) }, 'New record type') : null));

    mount(host,
      h('div.callout', { style: { marginBottom: 'var(--s5)' } },
        'A type defined here gets its own list, its own record screen, its own place in the navigation, '
        + 'and works with search, saved searches, CSV import and export, permissions and the audit trail — '
        + 'because it is described to the rest of Meridian in exactly the same terms a built-in record is.'),

      h('div.card',
        h('div.card-head', h('h2', 'Record types'),
          h('span.muted', { style: { fontSize: 'var(--t-sm)' } }, `${data.total} defined`)),
        data.rows.length
          ? h('div.grid-wrap', h('table.grid',
            h('thead', h('tr', h('th', 'Name'), h('th', 'Machine name'), h('th', 'Appears under'),
              h('th.num', 'Fields'), h('th.num', 'Records'), h('th', 'Status'), h('th', ''))),
            h('tbody', ...data.rows.map((t) => h('tr.clickable', { onclick: () => go(`/custom-records/${t.name}`) },
              h('td', h('strong', t.icon || icon('puzzle', { size: 15 })), ' ', h('strong', t.label),
                t.description ? h('div.muted', { style: { fontSize: 'var(--t-xs)' } }, t.description) : null),
              h('td', h('span.mono', t.record_type)),
              h('td.muted', t.nav_group),
              h('td.num.muted', String(t.field_count)),
              h('td.num', String(t.record_count)),
              h('td', t.active ? h('span.tag.green', 'Active') : h('span.tag', 'Inactive')),
              h('td', t.active && t.record_count
                ? h('button.btn.sm', {
                  onclick: (e) => { e.stopPropagation(); go(`/list/${t.record_type}`); },
                }, 'Open list')
                : h('span.faint', '—')))))))
          : h('div.card-body', h('div.muted',
            'Nothing defined yet. A calibration register, a list of approved subcontractors, the site inspections that have to pass before work starts — anything you would otherwise keep in a spreadsheet.'))));
  }

  // ------------------------------------------------------------ detail
  function renderOne(data) {
    const t = data.type;
    mount(head,
      h('div.titles',
        h('div.breadcrumb', h('a', {
          href: '#/custom-records',
          onclick: (e) => { e.preventDefault(); go('/custom-records'); },
        }, 'Custom Records')),
        h('h1', t.icon || icon('puzzle', { size: 15 }), ' ', t.label),
        h('div.page-sub', t.description || `Addressed as ${data.record_type}`)),
      h('div.page-actions',
        data.record_count
          ? h('button.btn', { onclick: () => go(`/list/${data.record_type}`) }, `Open the ${(t.plural || t.label).toLowerCase()}`)
          : null,
        canCreate ? h('button.btn', { onclick: () => fieldDialog(t, null) }, 'Add field') : null,
        canEdit ? h('button.btn.primary', { onclick: () => typeDialog(t) }, 'Edit type') : null,
        canDelete && !data.record_count
          ? h('button.btn.danger', { onclick: () => removeType(t) }, 'Delete') : null));

    mount(host,
      h('div.card',
        h('div.card-head', h('h2', 'The type')),
        h('div.card-body', facts([
          ['Name', t.label],
          ['Plural', t.plural || `${t.label}s`],
          ['Machine name', h('span.mono', data.record_type)],
          ['Appears under', t.nav_group],
          ['Numbered', t.numbered ? `Yes, as ${t.number_prefix || ''}00001` : 'No — records are known by their name'],
          ['Records', String(data.record_count)],
          ['Status', t.active ? h('span.tag.green', 'Active') : h('span.tag', 'Inactive')],
        ]))),

      h('div.card', { style: { marginTop: 'var(--s5)' } },
        h('div.card-head', h('h2', 'Fields'),
          h('span.muted', { style: { fontSize: 'var(--t-sm)' } },
            'Every record of this type has a name; these are what it carries besides')),
        data.fields.length
          ? h('div.grid-wrap', h('table.grid',
            h('thead', h('tr', h('th', 'Label'), h('th', 'Machine name'), h('th', 'Type'),
              h('th', 'Required'), h('th', 'In lists'), h('th', ''))),
            h('tbody', ...data.fields.map((fd) => h('tr',
              h('td', h('strong', fd.label),
                fd.help_text ? h('div.muted', { style: { fontSize: 'var(--t-xs)' } }, fd.help_text) : null),
              h('td', h('span.mono', fd.name)),
              h('td.muted', TYPE_LABEL[fd.type] || fd.type,
                fd.type === 'reference' && fd.ref_type ? h('span.faint', ` → ${fd.ref_type}`) : null),
              h('td', fd.required ? h('span.tag.amber', 'Required') : h('span.faint', '—')),
              h('td', fd.show_in_list ? h('span.tag', 'Shown') : h('span.faint', '—')),
              h('td', canEdit
                ? h('button.btn.sm', { onclick: () => fieldDialog(t, fd) }, 'Edit')
                : h('span.faint', '—')))))))
          : h('div.card-body', h('div.muted', 'No fields yet. A record of this type would carry only its name.'))),

      data.record_count
        ? null
        : h('div.callout', { style: { marginTop: 'var(--s5)' } },
          'Nothing has been filed under this type yet. While that is true the type can still be deleted; '
          + 'once it holds records it can only be deactivated, because they are somebody’s data.'));
  }

  // ------------------------------------------------------------ dialogs
  function typeDialog(existing) {
    const isNew = !existing;
    const fields = [
      { name: 'label', label: 'Name', type: 'text', required: true, help: 'What people will call one of these.' },
      { name: 'plural', label: 'Plural', type: 'text', help: 'Used as the list heading and in the navigation.' },
      {
        name: 'name', label: 'Machine name', type: 'text', required: true,
        help: 'Lowercase letters, digits and underscores. It is the address the type is filed under and cannot change afterwards.',
      },
      { name: 'description', label: 'What it is for', type: 'longtext', full: true },
      { name: 'icon', label: 'Icon', type: 'text', help: 'A single character shown beside it.' },
      {
        name: 'nav_group', label: 'Appears under', type: 'select',
        options: ['Financial', 'Sales', 'CRM', 'Purchasing', 'Inventory', 'Projects',
          'Manufacturing', 'Commerce', 'Service', 'People', 'Platform'],
      },
      { name: 'numbered', label: 'Give records a document number', type: 'checkbox' },
      { name: 'number_prefix', label: 'Number prefix', type: 'text', help: 'For example CAL- gives CAL-00001.' },
      { name: 'show_in_nav', label: 'Show in the sidebar', type: 'checkbox' },
    ];
    if (!isNew) fields.push({ name: 'active', label: 'Active', type: 'checkbox' });

    const controls = {};
    const formHost = h('div.form-grid');
    const defaults = { icon: icon('puzzle', { size: 15 }), nav_group: 'Platform', show_in_nav: 1, numbered: 0 };
    for (const fd of fields) {
      const value = existing ? existing[fd.name] : (defaults[fd.name] ?? '');
      const ctl = fieldControl(fd, value, null);
      // The machine name is the address; once records point at it, it is
      // fixed. Saying so on the disabled control beats a refusal later.
      if (fd.name === 'name' && !isNew) {
        ctl.el.querySelectorAll('input').forEach((i) => { i.disabled = true; });
      }
      controls[fd.name] = ctl;
      formHost.appendChild(ctl.el);
    }

    return modal({
      title: isNew ? 'New record type' : `Edit ${existing.label}`,
      size: 'wide',
      body: h('div', formHost,
        h('div.callout', { style: { marginTop: 'var(--s4)' } },
          'Once saved, this appears in the sidebar under the group you chose and behaves like any other record: '
          + 'it lists, searches, imports, exports, permissions and audits the same way.')),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: isNew ? 'Create it' : 'Save', kind: 'primary',
          onClick: async (close) => {
            const payload = Object.fromEntries(fields.map((fd) => [fd.name, controls[fd.name].get()]));
            payload.numbered = !!payload.numbered;
            payload.show_in_nav = !!payload.show_in_nav;
            if (!isNew) { payload.active = !!payload.active; delete payload.name; }
            try {
              if (isNew) {
                const made = await API.createCustomRecordType(payload);
                notifyOk(`${made.label} created.`);
                close(true);
                await store.loadMeta();
                go(`/custom-records/${made.name}`);
              } else {
                await API.updateCustomRecordType(existing.name, payload);
                notifyOk(`${payload.label} saved.`);
                close(true);
                await store.loadMeta();
                load();
              }
            } catch (e) { notifyError(e); return false; }
            return true;
          },
        },
      ],
    });
  }

  async function fieldDialog(type, existing) {
    const isNew = !existing;
    await store.ensureRefs(['subsidiary']);
    const refTypes = Object.keys(store.state.meta.records || {}).sort();

    const fields = [
      { name: 'label', label: 'Label', type: 'text', required: true },
      {
        name: 'name', label: 'Machine name', type: 'text', required: true,
        help: 'Lowercase letters, digits and underscores. Used in imports, exports and searches.',
      },
      { name: 'type', label: 'Type', type: 'select', options: FIELD_TYPES.map(([v]) => v), required: true },
      { name: 'ref_type', label: 'Links to', type: 'select', options: ['', ...refTypes], help: 'Only for a link field.' },
      { name: 'options', label: 'Choices', type: 'longtext', full: true, help: 'One per line. Only for a choice field.' },
      { name: 'formula', label: 'Formula', type: 'text', full: true, help: 'Only for a worked-out field.' },
      { name: 'help_text', label: 'Help text', type: 'text', full: true, help: 'Shown under the field on the form.' },
      { name: 'required', label: 'Required', type: 'checkbox' },
      { name: 'show_in_list', label: 'Show as a list column', type: 'checkbox' },
      { name: 'display_order', label: 'Order', type: 'number' },
    ];

    const controls = {};
    const formHost = h('div.form-grid');
    for (const fd of fields) {
      let value = existing ? existing[fd.name] : '';
      if (fd.name === 'options' && Array.isArray(value)) value = value.join('\n');
      const ctl = fieldControl(fd, value ?? '', null);
      if (fd.name === 'name' && !isNew) {
        ctl.el.querySelectorAll('input').forEach((i) => { i.disabled = true; });
      }
      controls[fd.name] = ctl;
      formHost.appendChild(ctl.el);
    }

    return modal({
      title: isNew ? `New field on ${type.label}` : `Edit ${existing.label}`,
      size: 'wide',
      body: h('div', formHost),
      actions: [
        { label: 'Cancel', value: null },
        {
          label: isNew ? 'Add it' : 'Save', kind: 'primary',
          onClick: async (close) => {
            const payload = Object.fromEntries(fields.map((fd) => [fd.name, controls[fd.name].get()]));
            payload.required = !!payload.required;
            payload.show_in_list = !!payload.show_in_list;
            payload.display_order = Number(payload.display_order) || 0;
            payload.options = String(payload.options || '').split('\n').map((x) => x.trim()).filter(Boolean);
            payload.record_type = `c_${type.name}`;
            if (!payload.ref_type) delete payload.ref_type;
            if (!payload.formula) delete payload.formula;
            try {
              if (isNew) await API.create('custom_field', payload);
              else await API.update('custom_field', existing.id, payload);
              notifyOk(isNew ? `${payload.label} added.` : `${payload.label} saved.`);
              close(true);
              await store.loadMeta();
              load();
            } catch (e) { notifyError(e); return false; }
            return true;
          },
        },
      ],
    });
  }

  async function removeType(t) {
    const ok = await confirm({
      title: `Delete ${t.label}?`,
      message: 'The type and its field definitions go. Nothing has been filed under it, so nothing is lost.',
      confirmLabel: 'Delete it',
      danger: true,
    });
    if (!ok) return;
    try {
      await API.deleteCustomRecordType(t.name);
      notifyOk(`${t.label} deleted.`);
      await store.loadMeta();
      go('/custom-records');
    } catch (e) { notifyError(e); }
  }

  load();
  return h('div.page', h('div.page-head', head), host);
}
