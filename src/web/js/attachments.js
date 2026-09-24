// Meridian ERP :: web/attachments
// A self-contained "Attachments" card: fetches its own list, uploads and
// deletes on its own, and re-renders itself. Dropped into record.js and
// txn.js the same way, since neither of those pages' own data includes
// attachments -- this card asks for them itself, once, after the page it
// lives on has already loaded.
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { API } from './api.js';
import * as fmt from './format.js';
import { notifyError, confirm, readFileAsBase64, filePicker } from './ui.js';

const MAX_SIZE = 20 * 1024 * 1024;

export function attachmentsCard(recordType, recordId, { canEdit = true } = {}) {
  const list = h('div.stack', { style: { gap: '2px' } });
  const input = filePicker('*/*', async (files) => {
    for (const file of files) {
      if (file.size > MAX_SIZE) { notifyError(new Error(`${file.name} is larger than ${fmt.fileSize(MAX_SIZE)}`)); continue; }
      const data = await readFileAsBase64(file);
      await API.uploadAttachment(recordType, recordId, file.name, file.type || 'application/octet-stream', data);
    }
    await refresh();
  }, { multiple: true });

  const uploadBtn = h('button.btn.sm', { onclick: () => input.click() }, icon('upload', { size: 13 }), ' Upload');
  const card = h('div.card',
    h('div.card-head', h('h2', 'Attachments'), canEdit ? h('div.actions', uploadBtn) : null),
    h('div.card-body', list), input);

  async function refresh() {
    clear(list);
    let rows;
    try { ({ rows } = await API.listAttachments(recordType, recordId)); }
    catch (e) { notifyError(e); return; }
    if (!rows.length) {
      list.appendChild(h('div.muted', { style: { fontSize: '12.5px' } }, 'Nothing attached yet.'));
      return;
    }
    for (const a of rows) {
      list.appendChild(h('div.row', { style: { justifyContent: 'space-between', padding: '4px 0' } },
        h('a', {
          href: '#', title: 'Download',
          onclick: (e) => { e.preventDefault(); API.downloadAttachment(a.id).catch(notifyError); },
        }, a.filename),
        h('span.row', { style: { gap: '8px', flex: 'none' } },
          h('span.muted', { style: { fontSize: '11.5px' } }, fmt.fileSize(a.size)),
          canEdit ? h('button.icon-btn.sm', {
            title: 'Remove', 'aria-label': `Remove ${a.filename}`,
            onclick: async () => {
              const ok = await confirm({ title: 'Remove this attachment?', message: `"${a.filename}" will be deleted. This cannot be undone.`, danger: true, confirmLabel: 'Remove' });
              if (!ok) return;
              try { await API.deleteAttachment(a.id); await refresh(); }
              catch (e) { notifyError(e); }
            },
          }, icon('trash', { size: 13 })) : null)));
    }
  }
  refresh();
  return card;
}
