/**
 * Documents for Citrus (/library), for lecturers and administrators.
 *
 * Drop in files as they are: PDFs, scans, photos of notices or the board, Word, PowerPoint, Excel, text. Citrus reads
 * every page (pictures and scanned pages with the AI) and files them in the knowledge library, so the assistant can
 * find and cite them. Each document, or all of them at once, downloads as one plain-text file in the library format.
 * Reading happens a few pages per request while this page is open; leaving pauses it and coming back resumes it.
 */
import { html, $, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { session, assistantName } from '../core/store.js';
import { pageHead, empty } from '../core/components.js';
import { ago, bytes, plural } from '../core/format.js';
import { toast, toastError, confirm } from '../core/ui.js';

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.gif,.docx,.pptx,.xlsx,.txt,.md,.csv,.json,.jsonl,.html,image/*,application/pdf';
const KIND_ICON = { picture: 'image', scan: 'camera', 'pdf-ai': 'file', pdf: 'file', slides: 'presentation', spreadsheet: 'grid', word: 'file', text: 'file', library: 'library' };
const UNIT = { page: ['page', 'pages'], slide: ['slide', 'slides'], sheet: ['sheet', 'sheets'], part: ['part', 'parts'] };

const unitCount = (n, unit) => `${n} ${n === 1 ? (UNIT[unit] || UNIT.page)[0] : (UNIT[unit] || UNIT.page)[1]}`;

function statusLine(d) {
  if (d.status === 'reading') {
    const done = Math.max(0, d.pages - d.pending);
    return html`<span class="chip accent"><span class="dot live"></span>Reading</span> <span class="small muted">${d.pending ? `${done} of ${unitCount(d.pages, d.unit)} read` : 'Filing it…'}</span>`;
  }
  if (d.status === 'failed') return html`<span class="chip danger">Couldn’t read it</span> <span class="small">${d.error}</span>`;
  return html`<span class="chip success">Ready</span> <span class="small muted">${d.kind === 'library' ? `${plural(d.entries, 'entry', 'entries')}` : unitCount(d.pages, d.unit)}${d.unreadable ? ` · ${d.unreadable} unreadable` : ''} · ${bytes(d.bytes)} · ${ago(d.created)}${d.uploader && d.uploader !== session.user.name ? ` · ${d.uploader}` : ''}</span>`;
}

function docRow(d) {
  const progress = d.status === 'reading' && d.pages ? Math.round((100 * (d.pages - d.pending)) / d.pages) : 0;
  return html`<div class="list-row doc-row" data-doc="${d.id}">
    <span class="tile ${d.status === 'failed' ? 'danger' : d.status === 'reading' ? 'info' : 'success'}">${icon(KIND_ICON[d.kind] || 'file', 18)}</span>
    <span class="body">
      <span class="title">${d.title || d.name}</span>
      ${d.title && d.title !== d.name ? html`<span class="sub">${d.name}</span>` : ''}
      <span class="sub doc-status">${statusLine(d)}</span>
      ${d.status === 'reading' ? html`<span class="doc-progress"><span style="width:${progress}%"></span></span>` : ''}
      ${d.summary && d.status === 'ready' ? html`<span class="sub doc-summary">${d.summary}</span>` : ''}
    </span>
    <span class="trail">
      ${d.status === 'ready' ? html`<a class="btn btn-sm btn-ghost btn-icon" href="/api/library/documents/${d.id}/text" title="Download as .txt" aria-label="Download ${d.name} as text">${icon('download', 16)}</a>` : ''}
      <button class="btn btn-sm btn-ghost btn-icon" data-delete="${d.id}" title="Remove" aria-label="Remove ${d.name}">${icon('trash', 16)}</button>
    </span>
  </div>`;
}

export default {
  title: 'Documents for Citrus',
  roles: ['lecturer', 'admin'],
  async load() {
    return api.get('/library/documents');
  },
  render(d) {
    const name = assistantName();
    const ready = d.documents.some((x) => x.status === 'ready');
    return html`${pageHead({
      title: 'Documents for Citrus',
      subtitle: `Upload timetables, regulations, slides, scans or photos as they are. ${name} reads every page, pictures too, and files it so it can find and cite it later.`,
      actions: ready ? html`<a class="btn" href="/api/library/export.txt">${icon('download', 17)} Download all as .txt</a>` : '',
    })}
      <div class="stack stagger">
        <label class="card drop-zone" data-drop>
          <input type="file" multiple accept="${ACCEPT}" data-files hidden>
          <span class="tile lg accent">${icon('upload', 26)}</span>
          <strong>Drop files here, or choose files</strong>
          <span class="small muted">PDF (also scanned), photos and screenshots, Word, PowerPoint, Excel, text. Up to 10 MB each. No need to convert or tidy anything first.</span>
        </label>
        ${d.aiEnabled ? '' : html`<div class="notice warning">${icon('info', 18)}<span>The AI is not connected. Files with text are filed straight away; pictures and scanned pages need the AI to be read.</span></div>`}
        <div class="notice">${icon('globe', 18)}<span>Everyone at your university can get answers from these documents through ${name}. Don’t upload anything private, such as grades or personal data.</span></div>
        <section class="card flush"><div class="card-head"><h2>Uploaded</h2><span class="chip" data-count>${d.documents.length}</span></div>
          <div class="list" data-docs style="padding-bottom:8px">${d.documents.length ? d.documents.map(docRow)
            : html`<div style="padding:0 20px 12px">${empty({ icon: 'library', title: 'Nothing uploaded yet', body: `Start with what students ask about most: the timetable, the exam plan, the study regulations.` })}</div>`}</div>
        </section>
        <p class="small muted">Each download is plain text with reading instructions at the top, one block per file and one per page, marked where the AI read a picture. ${name} uses the same text, and any other AI can read it as well.</p>
      </div>`;
  },
  mount(root, d) {
    const list = $('[data-docs]', root);
    const input = $('[data-files]', root);
    const zone = $('[data-drop]', root);
    const docs = new Map(d.documents.map((x) => [x.id, x]));
    let alive = true;

    const show = (doc) => {
      docs.set(doc.id, doc);
      const row = list.querySelector(`[data-doc="${doc.id}"]`);
      const markup = docRow(doc).value;
      if (row) row.outerHTML = markup;
      else {
        if (!list.querySelector('[data-doc]')) list.textContent = '';
        list.insertAdjacentHTML('afterbegin', markup);
      }
      $('[data-count]', root).textContent = docs.size;
    };

    /** Keep reading a document until it is ready (or failed), a few pages per request. */
    async function read(doc) {
      let current = doc;
      while (alive && current.status === 'reading') {
        let r;
        try {
          r = await api.post(`/library/documents/${current.id}/read`);
        } catch (error) {
          toastError(error);
          return;
        }
        current = r.document;
        show(current);
        if (r.retryIn) await new Promise((resolve) => setTimeout(resolve, r.retryIn * 1000));
      }
      if (current.status === 'ready') toast(`${current.title || current.name} is ready. ${assistantName()} can use it now.`, 'success', { duration: 3200 });
    }

    const asBase64 = (file) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
      reader.onerror = () => reject(new Error(`Could not open ${file.name}`));
      reader.readAsDataURL(file);
    });

    /**
     * Phone photos are often 4–12 MB: scale them to at most 2400 px on the long side as JPEG, still sharp enough to
     * read, and small enough for hosts that limit request size. Other files go as they are.
     */
    async function prepared(file) {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 1_500_000 || !window.createImageBitmap) return { name: file.name, type: file.type, data: await asBase64(file) };
      try {
        const bitmap = await createImageBitmap(file);
        const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
        const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close?.();
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
        if (!blob) throw new Error('no blob');
        return { name: file.name.replace(/\.(png|webp|jpe?g)$/i, '') + '.jpg', type: 'image/jpeg', data: await asBase64(blob) };
      } catch {
        return { name: file.name, type: file.type, data: await asBase64(file) };
      }
    }

    async function upload(files) {
      for (const file of files) {
        if (!alive) return;
        if (file.size > MAX_BYTES) {
          toast(`${file.name} is larger than 10 MB. Split it, or upload the pages as pictures.`, 'error', { duration: 6000 });
          continue;
        }
        const placeholder = { id: `up-${Math.random().toString(36).slice(2)}`, name: file.name, title: '', status: 'reading', pages: 0, pending: 0, unit: 'page', bytes: file.size, kind: '' };
        list.querySelector('.empty')?.parentElement?.remove();
        list.insertAdjacentHTML('afterbegin', docRow(placeholder).value.replace('Filing it…', 'Uploading…'));
        try {
          const ready = await prepared(file);
          const r = await api.post('/library/documents', { name: ready.name, mime: ready.type, data: ready.data });
          list.querySelector(`[data-doc="${placeholder.id}"]`)?.remove();
          show(r.document);
          if (r.document.status === 'failed') toast(`${file.name}: ${r.document.error}`, 'error', { duration: 7000 });
          else if (r.document.status === 'ready') toast(`${file.name} is ready.`, 'success', { duration: 2400 });
          else await read(r.document);
        } catch (error) {
          list.querySelector(`[data-doc="${placeholder.id}"]`)?.remove();
          toastError(error);
        }
      }
    }

    input.addEventListener('change', () => {
      const files = [...input.files];
      input.value = '';
      upload(files);
    });
    const over = (e) => {
      e.preventDefault();
      zone.classList.add('is-over');
    };
    const leave = () => zone.classList.remove('is-over');
    const drop = (e) => {
      e.preventDefault();
      leave();
      upload([...(e.dataTransfer?.files || [])]);
    };
    zone.addEventListener('dragover', over);
    zone.addEventListener('dragleave', leave);
    zone.addEventListener('drop', drop);

    const offDelete = on(root, 'click', '[data-delete]', async (e, button) => {
      const doc = docs.get(Number(button.dataset.delete));
      if (!doc || !(await confirm({ title: `Remove ${doc.title || doc.name}?`, message: `${assistantName()} stops using it. You can upload it again any time.`, confirmLabel: 'Remove', danger: true }))) return;
      try {
        await api.del(`/library/documents/${doc.id}`);
        docs.delete(doc.id);
        list.querySelector(`[data-doc="${doc.id}"]`)?.remove();
        $('[data-count]', root).textContent = docs.size;
      } catch (error) {
        toastError(error);
      }
    });

    // Documents still being read when the page opened: carry on, one after the other.
    (async () => {
      for (const doc of d.documents.filter((x) => x.status === 'reading')) await read(doc);
    })();

    return () => {
      alive = false;
      offDelete();
      zone.removeEventListener('dragover', over);
      zone.removeEventListener('dragleave', leave);
      zone.removeEventListener('drop', drop);
    };
  },
};

